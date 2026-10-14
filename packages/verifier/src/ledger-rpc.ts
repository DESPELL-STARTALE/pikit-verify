import { createPublicClient, decodeAbiParameters, http, parseEventLogs, type Hex, type Log, type PublicClient, type Transport } from "viem";
import { LedgerRootRecord, pikitLedgerAbi } from "@pikit/protocol";
import { agree, errorText, isRangeError } from "./agree.js";
import type { AnnouncerChange, LedgerBlocks, LedgerChainSource, LedgerWorldFacts } from "./ledger-chain.js";
import { limitedTransport } from "./rpc-limit.js";


/** 곳마다 초당 RPC 요청 수 기본값. */
export const DEFAULT_MAX_RPS = 20;
/** 검증기 RPC 재시도 기본값 (D182): 공개 RPC 의 속도 제한 창을 넘길 만큼(≈ 1분) 물러난다. game-server 블록 시계는 자기 값(6번 · 10초)을 쓴다. */
export const VERIFIER_RETRY = { maxRetries: 20, backoffBaseMs: 500, backoffMaxMs: 15_000, retryBudgetMs: 60_000 } as const;

// ──────────────────────────────────────────────────────────────────────────
// 개정 7 체인 값을 RPC에서 바로 읽는 LedgerChainSource (운영자 파일을 하나도 믿지 않는다). RPC를 2곳 주면 **모든 값을 두 곳에서 따로 읽어
// 대조**하고(agree), 하나라도 다르면 ChainDisagreement(검증 실패, 종료 1). 곳마다 초당 maxRps(기본 20), 재시도 예산은 개정 6과 같다(D182).
//   1) 곳마다 eth_chainId · 확정 머리 · PikitLedger 불변값(seedRoot·genesisBlock·rulesHash·ledgerHash·roomIds·EPOCH_BLOCKS·ANNOUNCER_DELAY).
//      기준 블록 pin = 확정 머리들 중 가장 작은 것, 그 블록 해시도 대조. 상태(rootCount·announcer·announcerFromWindow·rootAt)는 pin에서 읽는다
//   2) 루트 k = rootAt(k)(postedBlock·throughWindow·epoch·ledgerRoot) + 그 블록 하나의 로그에서 `RootPosted(k, Root)` — 저장 칸과 사건 칸이 같아야 한다.
//      로그를 처음부터 훑지 않는다(루트마다 eth_call 1번 + eth_getLogs 1번)
//   3) ANNOUNCE 교체 = PikitLedger 로그(드물다 — 루트·시드 공개뿐)를 logChunk블록씩(기본 100, 범위 오류면 반으로 줄이고 기억)
//   4) 블록: 윈도 [from, to]의 해시는 블록 k를 읽으면 k와 parentHash(= k − 1)가 함께 나온다. timestamp가 필요한 윈도(명단 창)는 그 블록을
//      직접 읽는다 — 뒤에서부터 "아직 해시가 없거나 timestamp가 필요한 윈도"만 읽어 요청 수를 줄인다(명단이 없으면 윈도 2개에 1번)
//   5) ERC-1271: 지갑의 `isValidSignature(hash, sig)`를 erc1271Block에서 eth_call — 0x1626ba7e면 유효, 되돌림·코드 없음은 무효.
//      ERC-6492로 감싼 서명은 안쪽 서명으로 부른다(그 블록에 지갑이 배포돼 있어야 한다 — 배포 전 지갑의 서명은 무효로 나온다)
// 값은 모두 소문자. 오류 글에 URL을 넣지 않는다 — 곳은 rpc#1·rpc#2.
// ──────────────────────────────────────────────────────────────────────────

export interface RpcLedgerSourceOptions {
  rpcUrls: readonly string[];         // 1곳 또는 2곳(교차 확인)
  ledger: string;                     // PikitLedger 주소 (검증하는 사람이 고정한 값)
  maxRps?: number;
  maxRetries?: number;
  backoffBaseMs?: number;
  backoffMaxMs?: number;
  retryBudgetMs?: number;
  logChunk?: number;                  // eth_getLogs 한 번의 블록 수, 기본 100
  concurrency?: number;               // 곳마다 동시에 읽는 블록 수, 기본 16
  transport?: (url: string) => Transport;
}

/** ERC-1271 매직 값 (`isValidSignature`가 유효할 때 돌려주는 bytes4). */
export const ERC1271_MAGIC = "0x1626ba7e";
/** ERC-6492로 감싼 서명의 끝 32바이트. */
export const ERC6492_SUFFIX = "6492649264926492649264926492649264926492649264926492649264926492";

const erc1271Abi = [{
  type: "function", name: "isValidSignature", stateMutability: "view",
  inputs: [{ name: "hash", type: "bytes32" }, { name: "signature", type: "bytes" }], outputs: [{ name: "", type: "bytes4" }],
}] as const;

const lower = (s: string) => s.toLowerCase();

/** ERC-6492 서명이면 안쪽 서명, 아니면 그대로. */
export function unwrapErc6492(signature: string): Hex {
  const s = lower(signature);
  if (!s.endsWith(ERC6492_SUFFIX)) return s as Hex;
  const [, , inner] = decodeAbiParameters([{ type: "address" }, { type: "bytes" }, { type: "bytes" }], s.slice(0, -ERC6492_SUFFIX.length) as Hex);
  return lower(inner) as Hex;
}

/** eth_call이 되돌림(또는 코드 없는 주소라 빈 답)으로 끝났나 — 전송 오류와 가른다. */
function isCallFailure(e: unknown): boolean {
  for (let cur: unknown = e, i = 0; cur && typeof cur === "object" && i < 10; cur = (cur as { cause?: unknown }).cause, i++) {
    const name = (cur as { name?: string }).name;
    if (name === "HttpRequestError" || name === "TimeoutError" || name === "RpcRequestError" && /limit/i.test(errorText(cur))) return false;
  }
  return /revert|returned no data|ZeroData/i.test(errorText(e));
}

class Endpoint {
  readonly client: PublicClient;
  chunk: number;

  constructor(url: string, private readonly o: RpcLedgerSourceOptions) {
    const base = o.transport ?? ((u: string) => http(u, { retryCount: 0 }));
    const transport = limitedTransport(base(url), {
      maxRps: o.maxRps ?? DEFAULT_MAX_RPS, maxRetries: o.maxRetries ?? VERIFIER_RETRY.maxRetries, backoffBaseMs: o.backoffBaseMs ?? VERIFIER_RETRY.backoffBaseMs,
      backoffMaxMs: o.backoffMaxMs ?? VERIFIER_RETRY.backoffMaxMs, retryBudgetMs: o.retryBudgetMs ?? VERIFIER_RETRY.retryBudgetMs,
    });
    this.client = createPublicClient({ transport }) as PublicClient;
    this.chunk = Math.max(1, o.logChunk ?? 100);
  }

  private view<T>(ledger: Hex, functionName: string, blockNumber?: number): Promise<T> {
    return this.client.readContract({
      address: ledger, abi: pikitLedgerAbi, functionName: functionName as never, ...(blockNumber !== undefined ? { blockNumber: BigInt(blockNumber) } : {}),
    } as never) as Promise<T>;
  }

  async open(ledger: Hex) {
    const [chainId, head, seedRoot, genesisBlock, rulesHash, ledgerHash, roomIds, epochBlocks, announcerDelay] = await Promise.all([
      this.client.getChainId(),
      this.client.getBlock({ blockTag: "finalized" }),
      this.view<string>(ledger, "seedRoot"), this.view<bigint>(ledger, "genesisBlock"), this.view<string>(ledger, "rulesHash"),
      this.view<string>(ledger, "ledgerHash"), this.view<readonly number[]>(ledger, "roomIds"), this.view<number>(ledger, "EPOCH_BLOCKS"),
      this.view<bigint>(ledger, "ANNOUNCER_DELAY"),
    ]);
    return {
      immutables: {
        chainId, seedRoot: lower(seedRoot), genesisBlock: Number(genesisBlock), rulesHash: lower(rulesHash), ledgerHash: lower(ledgerHash),
        roomIds: roomIds.map(Number), epochBlocks: Number(epochBlocks), announcerDelay: Number(announcerDelay),
      },
      head: Number(head.number),
    };
  }

  async state(ledger: Hex, pin: number) {
    const [rootCount, announcer, announcerFromWindow] = await Promise.all([
      this.view<bigint>(ledger, "rootCount", pin), this.view<string>(ledger, "announcer", pin), this.view<bigint>(ledger, "announcerFromWindow", pin),
    ]);
    return { rootCount: Number(rootCount), announcer: lower(announcer), announcerFromWindow: Number(announcerFromWindow) };
  }

  async block(n: number): Promise<{ hash: string; parentHash: string; timestamp: number }> {
    const b = await this.client.getBlock({ blockNumber: BigInt(n) });
    if (Number(b.number) !== n || !b.hash) throw new Error(`RpcLedgerSource: asked block ${n}, got ${b.number}`);
    return { hash: lower(b.hash), parentHash: lower(b.parentHash), timestamp: Number(b.timestamp) };
  }

  /** [from, to]의 주소 로그 (블록·로그 순서). logChunk블록씩, 범위 오류면 구간을 반으로 줄여 다시(줄인 크기는 기억). */
  async logs(address: Hex, from: number, to: number): Promise<Log[]> {
    const out: Log[] = [];
    let at = from;
    while (at <= to) {
      const end = Math.min(to, at + this.chunk - 1);
      try {
        for (const l of await this.client.getLogs({ address, fromBlock: BigInt(at), toBlock: BigInt(end) })) out.push(l);
        at = end + 1;
      } catch (e) {
        if (!isRangeError(e) || this.chunk === 1) throw e;
        this.chunk = Math.max(1, Math.floor(this.chunk / 2));
      }
    }
    return out.sort((a, b) => Number(a.blockNumber) - Number(b.blockNumber) || Number(a.logIndex) - Number(b.logIndex));
  }

  /** 블록들을 동시에(concurrency) 읽는다. */
  async readBlocks(ns: readonly number[]): Promise<Map<number, { hash: string; parentHash: string; timestamp: number }>> {
    const out = new Map<number, { hash: string; parentHash: string; timestamp: number }>();
    let next = 0;
    let failed = false;
    const worker = async () => {
      while (!failed && next < ns.length) {
        const n = ns[next++]!;
        try {
          out.set(n, await this.block(n));
        } catch (e) {
          failed = true;
          throw e;
        }
      }
    };
    await Promise.all(Array.from({ length: Math.min(Math.max(1, this.o.concurrency ?? 16), ns.length) }, worker));
    return out;
  }
}

export class RpcLedgerSource implements LedgerChainSource {
  private readonly endpoints: Endpoint[];
  private readonly ledger: Hex;
  private opened: Promise<LedgerWorldFacts> | null = null;

  constructor(private readonly o: RpcLedgerSourceOptions) {
    if (o.rpcUrls.length < 1 || o.rpcUrls.length > 2) throw new Error(`RpcLedgerSource: give 1 or 2 RPC URLs (got ${o.rpcUrls.length})`);
    this.endpoints = o.rpcUrls.map((url) => new Endpoint(url, o));
    this.ledger = lower(o.ledger) as Hex;
  }

  /** 지금 eth_getLogs 구간 크기 (곳들 중 가장 작은 것). */
  get logChunk(): number {
    return Math.min(...this.endpoints.map((e) => e.chunk));
  }

  private async all<T>(what: string, read: (e: Endpoint) => Promise<T>): Promise<T> {
    return agree(what, await Promise.all(this.endpoints.map(read)));
  }

  world(): Promise<LedgerWorldFacts> {
    this.opened ??= (async () => {
      const got = await Promise.all(this.endpoints.map((e) => e.open(this.ledger)));
      const im = agree("chainId / PikitLedger immutables (seedRoot, genesisBlock, rulesHash, ledgerHash, roomIds)", got.map((g) => g.immutables));
      const pin = Math.min(...got.map((g) => g.head));
      await this.all(`block hash of the common finalized block ${pin}`, async (e) => (await e.block(pin)).hash);
      const st = await this.all(`PikitLedger rootCount / announcer at block ${pin}`, (e) => e.state(this.ledger, pin));
      return { ...im, ledger: this.ledger, finalized: pin, ...st };
    })();
    return this.opened;
  }

  async root(index: number): Promise<LedgerRootRecord> {
    const { finalized: pin } = await this.world();
    return this.all(`root ${index} (rootAt + RootPosted)`, async (e) => {
      const rec = await e.client.readContract({ address: this.ledger, abi: pikitLedgerAbi, functionName: "rootAt", args: [BigInt(index)], blockNumber: BigInt(pin) });
      const postedBlock = Number(rec.postedBlock);
      const logs = parseEventLogs({ abi: pikitLedgerAbi, eventName: "RootPosted", logs: await e.logs(this.ledger, postedBlock, postedBlock) });
      const ev = logs.find((l) => l.args.index === BigInt(index));
      if (!ev) throw new Error(`RpcLedgerSource: no RootPosted(${index}) in block ${postedBlock} (rootAt(${index}).postedBlock)`);
      const r = ev.args.root;
      const out = LedgerRootRecord.parse({
        rootIndex: index, postedBlock, txHash: lower(ev.transactionHash),
        epoch: Number(r.epoch), seed: lower(r.seed), throughWindow: Number(r.throughWindow), roomsStateRoot: lower(r.roomsStateRoot), inputLogRoot: lower(r.inputLogRoot),
        boardBatchRoot: lower(r.boardBatchRoot), ledgerRoot: lower(r.ledgerRoot), payoutsRoot: lower(r.payoutsRoot), supplyMilli: r.supplyMilli.toString(), dataHash: lower(r.dataHash),
      });
      // 저장 칸(rootAt)과 사건 칸이 같아야 한다 (컨트랙트가 같은 값을 쓰지만, 읽은 사건이 그 루트인지 확인)
      if (out.epoch !== Number(rec.epoch) || out.throughWindow !== Number(rec.throughWindow) || out.ledgerRoot !== lower(rec.ledgerRoot)) {
        throw new Error(`RpcLedgerSource: RootPosted(${index}) in block ${postedBlock} differs from rootAt(${index})`);
      }
      return out;
    });
  }

  async announcerChanges(fromBlock: number, toBlock: number): Promise<AnnouncerChange[]> {
    if (toBlock < fromBlock) return [];
    return this.all(`AnnouncerChanged (blocks ${fromBlock}…${toBlock})`, async (e) =>
      parseEventLogs({ abi: pikitLedgerAbi, eventName: "AnnouncerChanged", logs: await e.logs(this.ledger, fromBlock, toBlock) }).map((l) => ({
        previous: lower(l.args.previous), next: lower(l.args.next), fromWindow: Number(l.args.fromWindow), blockNumber: Number(l.blockNumber), logIndex: Number(l.logIndex),
      })));
  }

  async blocks(fromWindow: number, toWindow: number, timestampWindows: readonly number[]): Promise<LedgerBlocks> {
    const { finalized: pin } = await this.world();
    if (toWindow > pin) throw new Error(`RpcLedgerSource: chain finalized only through block ${pin}; the replay needs block ${toWindow}`);
    const needTs = new Set(timestampWindows.filter((w) => w >= fromWindow && w <= toWindow));
    // 뒤에서부터: 해시가 아직 없거나(앞에서 읽은 블록의 parentHash로 못 얻음) timestamp가 필요한 윈도만 읽는다
    const reads: number[] = [];
    const covered = new Set<number>();
    for (let w = toWindow; w >= fromWindow; w--) {
      if (covered.has(w) && !needTs.has(w)) continue;
      reads.push(w);
      covered.add(w);
      covered.add(w - 1);
    }
    return this.all(`blocks ${fromWindow}…${toWindow}`, async (e) => {
      const got = await e.readBlocks(reads);
      const hashes: Record<string, string> = {};
      const timestamps: Record<string, number> = {};
      const put = (n: number, hash: string) => {
        if (n < fromWindow || n > toWindow) return;
        const seen = hashes[String(n)];
        if (seen !== undefined && seen !== hash) throw new Error(`RpcLedgerSource: the RPC gave two hashes for block ${n} (${seen}, ${hash})`);
        hashes[String(n)] = hash;
      };
      for (const n of reads) {
        const b = got.get(n)!;
        put(n, b.hash);
        put(n - 1, b.parentHash);
        if (needTs.has(n)) timestamps[String(n)] = b.timestamp;
      }
      return { hashes, timestamps };
    });
  }

  async blockHashesAt(windows: readonly number[]): Promise<Record<string, string>> {
    if (windows.length === 0) return {};
    const { finalized: pin } = await this.world();
    const want = [...new Set(windows)].filter((w) => w <= pin).sort((a, b) => a - b);
    return this.all("block hashes (batch rows before the range)", async (e) => {
      const got = await e.readBlocks(want);
      return Object.fromEntries(want.map((w) => [String(w), got.get(w)!.hash]));
    });
  }

  async isValidSignature(wallet: string, hash: string, signature: string, blockNumber: number): Promise<boolean> {
    const { finalized: pin } = await this.world();
    if (blockNumber > pin) throw new Error(`RpcLedgerSource: ERC-1271 check at block ${blockNumber}, after the finalized block ${pin}`);
    const sig = unwrapErc6492(signature);
    return this.all(`ERC-1271 isValidSignature of ${lower(wallet)} at block ${blockNumber}`, async (e) => {
      try {
        const r = await e.client.readContract({
          address: lower(wallet) as Hex, abi: erc1271Abi, functionName: "isValidSignature", args: [lower(hash) as Hex, sig], blockNumber: BigInt(blockNumber),
        });
        return lower(r) === ERC1271_MAGIC;
      } catch (err) {
        if (isCallFailure(err)) return false;
        throw err;
      }
    });
  }
}
