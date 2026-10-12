import { createPublicClient, http, parseEventLogs, type Hex, type Log, type PublicClient, type Transport } from "viem";
import {
  canonicalJson, CHAIN_SNAPSHOT_SCHEMA_ID, pikitFairnessAbi, pikitShopAbi, SETTLE_KIND_ONCHAIN, ZERO_BYTES32,
  type AnchorRecord, type CancelRecord, type PurchaseRecord, type SettleKind, type SettlementRecord, type VoidRangeRecord,
} from "@pikit/protocol";
import { ChainDisagreement, ChainFacts, type AnchorStub, type ChainCatalog, type ChainNeed, type ChainRoomRules, type ChainSource, type VoidOverPaidRecord } from "./chain.js";
import { limitedTransport } from "./rpc-limit.js";

// ──────────────────────────────────────────────────────────────────────────
// 체인 값을 RPC에서 바로 읽는 ChainSource (보안 리뷰 H-1·L-7, 감사 F-2, 명세 17 P0-16 b·d).
// 운영자가 준 파일은 하나도 믿지 않는다. RPC를 2곳 주면 **모든 값을 두 곳에서 따로 읽어 대조**하고, 하나라도 다르면 첫 차이를 담은
// ChainDisagreement로 멈춘다(검증 실패, 종료 1). 두 곳은 각자 초당 maxRps(기본 20)로 동시에 읽는다 — 시간은 한 곳과 같다.
//   1) 곳마다 eth_chainId, PikitShop.fairness() → 그 PikitFairness의 shop()이 이 상점인지, genesisBlock()·seedRoot(), 확정 머리.
//      기준 블록 pin = 확정 머리들 중 가장 작은 것. 모든 eth_call은 blockNumber = pin으로 읽는다(곳마다 같은 상태). pin의 블록 해시도 대조
//   2) 사건은 블록 [eventsFrom ?? genesisBlock, T], T = min(pin, throughBlock). pin < 마지막 윈도(그 블록 해시가 아직 확정 전)거나
//      T < 마지막 윈도 − 1(빠진 입력을 못 잡음)이면 오류
//   3) 상점·공정성 로그를 logChunk블록씩(기본 100). 범위 오류면 구간을 반으로 줄이고 그 크기를 기억한다(settler와 같다).
//      상점: Purchased → purchases, CancelRequested → cancels, Settled(settleEnd, 6칸) → settlements, VoidOverPaid → voidOverPaid
//      공정성: PurchasesVoided → voids, Anchored → anchors (postedBlock = 로그가 실린 블록)
//   4) 방마다 roomOf(roomId)의 rulesHash와 예약된 nextRulesHash(0이 아니면) → roomRules (체인에 없는 방은 건너뛴다, 하나도 없으면 오류),
//      그 규칙들마다 catalogOf(rulesHash)의 등급 가격·REWARD 상한·over 상한 → catalogs (검증기가 재생 카탈로그와 대조, M-2·D162)
//   5) 윈도 [fromWindow ?? genesisBlock, 마지막 윈도]의 블록 해시: 블록 k를 읽으면 k의 해시와 parentHash(= k − 1의 해시)가 함께 나온다.
//      k = from + 1, + 3, …(짝이 없는 마지막 윈도는 그 블록 자신)을 concurrency개(기본 16)까지 동시에 읽는다
// 범위 고르기(스냅숏 시작·latest)는 anchorCount()·anchorAt(i)·purchaseOf(id) eth_call로 — 로그를 처음부터 읽지 않는다.
// 비용은 거의 5)다 — 블록 해시는 윈도 2개에 getBlock 1번(로그는 logChunk블록에 1번). 값은 모두 소문자로 바꾼다(protocol 원시 형식).
// 오류 글에는 URL을 넣지 않는다(키가 URL에 있을 수 있다) — 곳은 rpc#1·rpc#2로 부른다.
// ──────────────────────────────────────────────────────────────────────────

export interface RpcChainSourceOptions {
  rpcUrls: readonly string[];         // 1곳 또는 2곳(교차 확인)
  shop: string;                       // PikitShop 주소 (세계 목록의 shop)
  maxRps?: number;                    // 곳마다 초당 요청 상한, 기본 20
  maxRetries?: number;                // 속도 제한·시간 초과 재시도, 기본 6
  backoffBaseMs?: number;             // 기본 200
  logChunk?: number;                  // eth_getLogs 한 번의 블록 수, 기본 100 (범위 오류면 반으로 줄이고 기억)
  throughBlock?: number;              // 사건을 읽는 마지막 블록, 기본 확정 머리
  concurrency?: number;               // 곳마다 동시에 읽는 블록 수, 기본 16
  transport?: (url: string) => Transport;   // 시험·주입용 (기본 http)
}

export const DEFAULT_MAX_RPS = 20;

/** 컨트랙트 SettleKind 번호 → protocol 이름. */
const KIND_BY_NUMBER = new Map(Object.entries(SETTLE_KIND_ONCHAIN).map(([kind, n]) => [n as number, kind as SettleKind]));

/** 오류와 cause 사슬의 글 전부 (viem은 RPC 오류를 겹겹이 감싼다). */
function errorText(e: unknown): string {
  const out: string[] = [];
  for (let cur: unknown = e; cur && typeof cur === "object" && out.length < 10; cur = (cur as { cause?: unknown }).cause) {
    const x = cur as { code?: unknown; shortMessage?: string; details?: string; message?: string };
    out.push(`${String(x.code ?? "")} ${x.shortMessage ?? ""} ${x.details ?? ""} ${x.message ?? ""}`);
  }
  return out.join(" | ");
}

/** eth_getLogs 구간이 너무 넓다는 제공자 오류 (settler rpc-source와 같은 판정). */
const isRangeError = (e: unknown) =>
  /block range|range (is )?too (large|big|wide)|exceed(s|ed)? .*(range|block|result)|query returned more than|too many (results|blocks|logs)|limit.*(block|range)|-32602.*range|max.*block.*range/i.test(errorText(e));

const lower = (s: string) => s.toLowerCase();
const short = (v: unknown) => { const s = typeof v === "string" ? v : canonicalJson(v); return s.length > 160 ? `${s.slice(0, 157)}…` : s; };

/** 곳들의 값이 모두 같아야 한다. 배열은 첫 다른 원소, 객체(블록 해시 표)는 첫 다른 키를 알려 준다. */
function agree<T>(what: string, values: readonly T[]): T {
  const first = values[0]!;
  for (const other of values.slice(1)) {
    if (Array.isArray(first) && Array.isArray(other)) {
      const n = Math.max(first.length, other.length);
      for (let i = 0; i < n; i++) {
        if (canonicalJson(first[i] ?? null) !== canonicalJson(other[i] ?? null)) throw new ChainDisagreement(`${what}[${i}]`, short(first[i] ?? "none"), short(other[i] ?? "none"));
      }
    } else if (first && other && typeof first === "object" && typeof other === "object") {
      const a = first as Record<string, unknown>;
      const b = other as Record<string, unknown>;
      const keys = [...new Set([...Object.keys(a), ...Object.keys(b)])].sort((x, y) => Number(x) - Number(y) || x.localeCompare(y));
      for (const k of keys) {
        if (canonicalJson(a[k] ?? null) !== canonicalJson(b[k] ?? null)) throw new ChainDisagreement(`${what}[${k}]`, short(a[k] ?? "none"), short(b[k] ?? "none"));
      }
    } else if (canonicalJson(first) !== canonicalJson(other)) {
      throw new ChainDisagreement(what, short(first), short(other));
    }
  }
  return first;
}

interface Opened {
  chainId: number;
  fairness: Hex;
  genesisBlock: number;
  seedRoot: string;
  pin: number;                     // 기준 블록 = 곳들의 확정 머리 중 가장 작은 것
}

/** RPC 한 곳. 읽기만 하고 대조는 RpcChainSource가 한다. */
class Endpoint {
  readonly client: PublicClient;
  chunk: number;

  constructor(url: string, private readonly o: RpcChainSourceOptions) {
    const base = o.transport ?? ((u: string) => http(u, { retryCount: 0 }));
    const transport = limitedTransport(base(url), { maxRps: o.maxRps ?? DEFAULT_MAX_RPS, maxRetries: o.maxRetries, backoffBaseMs: o.backoffBaseMs });
    this.client = createPublicClient({ transport }) as PublicClient;
    this.chunk = Math.max(1, o.logChunk ?? 100);
  }

  async open(shop: Hex): Promise<Omit<Opened, "pin"> & { head: number }> {
    const chainId = await this.client.getChainId();
    const fairness = lower(await this.client.readContract({ address: shop, abi: pikitShopAbi, functionName: "fairness" })) as Hex;
    const [linkedShop, genesis, seedRoot, head] = await Promise.all([
      this.client.readContract({ address: fairness, abi: pikitFairnessAbi, functionName: "shop" }),
      this.client.readContract({ address: fairness, abi: pikitFairnessAbi, functionName: "genesisBlock" }),
      this.client.readContract({ address: fairness, abi: pikitFairnessAbi, functionName: "seedRoot" }),
      this.client.getBlock({ blockTag: "finalized" }),
    ]);
    if (lower(linkedShop) !== shop) throw new Error(`RpcChainSource: PikitShop ${shop} names PikitFairness ${fairness}, whose shop() is ${lower(linkedShop)}`);
    return { chainId, fairness, genesisBlock: Number(genesis), seedRoot: lower(seedRoot), head: Number(head.number) };
  }

  async blockHash(n: number): Promise<{ hash: string; parentHash: string }> {
    const b = await this.client.getBlock({ blockNumber: BigInt(n) });
    if (Number(b.number) !== n || !b.hash) throw new Error(`RpcChainSource: asked block ${n}, got ${b.number}`);
    return { hash: lower(b.hash), parentHash: lower(b.parentHash) };
  }

  /** [from, to]의 주소들 로그 (블록·로그 순서). logChunk블록씩 읽고, 범위 오류면 구간을 반으로 줄여 다시 읽는다(줄인 크기는 기억). */
  async logs(address: Hex[], from: number, to: number): Promise<Log[]> {
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

  /** 윈도 [from, to]의 블록 해시. 블록 k 하나로 k와 k − 1(parentHash)을 얻는다 — 요청 1번에 윈도 2개. */
  async blockHashRange(from: number, to: number): Promise<Record<string, string>> {
    const out: Record<string, string> = {};
    const count = to - from + 1;
    if (count <= 0) return out;
    const pairs = Math.floor(count / 2);
    const reads = pairs + (count % 2);                                  // 짝이 없는 마지막 윈도는 그 블록 자신을 읽는다
    const blockAt = (i: number) => (i < pairs ? from + 1 + 2 * i : to);
    const put = (n: number, hash: string) => {
      if (n < from || n > to) return;
      const seen = out[String(n)];
      if (seen !== undefined && seen !== hash) throw new Error(`RpcChainSource: the RPC gave two hashes for block ${n} (${seen}, ${hash})`);
      out[String(n)] = hash;
    };
    let next = 0;
    let failed = false;
    const worker = async () => {
      while (!failed && next < reads) {
        const k = blockAt(next++);
        try {
          const b = await this.blockHash(k);
          put(k, b.hash);
          put(k - 1, b.parentHash);
        } catch (e) {
          failed = true;
          throw e;
        }
      }
    };
    await Promise.all(Array.from({ length: Math.min(Math.max(1, this.o.concurrency ?? 16), reads) }, worker));
    return out;
  }
}

/** 한 곳에서 읽은 사건 (블록·로그 순서). */
interface Events {
  purchases: PurchaseRecord[];
  cancels: CancelRecord[];
  settlements: SettlementRecord[];
  voidOverPaid: VoidOverPaidRecord[];
  voids: VoidRangeRecord[];
  anchors: AnchorRecord[];
}

function decodeEvents(logs: Log[], shop: Hex, fairness: Hex): Events {
  const ev: Events = { purchases: [], cancels: [], settlements: [], voidOverPaid: [], voids: [], anchors: [] };
  for (const l of parseEventLogs({ abi: pikitShopAbi, logs: logs.filter((x) => lower(x.address) === shop) })) {
    const at = { blockNumber: Number(l.blockNumber), logIndex: Number(l.logIndex), txHash: lower(l.transactionHash) };
    if (l.eventName === "Purchased") {
      const a = l.args;
      ev.purchases.push({ purchaseId: a.purchaseId.toString(), buyer: lower(a.buyer), roomId: Number(a.roomId), rulesHash: lower(a.rulesHash), tiers: a.tiers.map(Number), ...at });
    } else if (l.eventName === "CancelRequested") {
      ev.cancels.push({ wallet: lower(l.args.wallet), roomId: Number(l.args.roomId), items: l.args.items.map((x) => x.toString()), ...at });
    } else if (l.eventName === "Settled") {
      const a = l.args;
      const kind = KIND_BY_NUMBER.get(Number(a.kind));
      if (kind === undefined) throw new Error(`RpcChainSource: Settled in block ${at.blockNumber} log ${at.logIndex} has unknown kind ${a.kind}`);
      ev.settlements.push({
        purchaseId: a.purchaseId.toString(), itemIndex: Number(a.itemIndex), buyer: lower(a.buyer), kind, payoutMilli: a.payoutMilli.toString(),
        overMilli: a.overMilli.toString(), blockNumber: at.blockNumber, txHash: at.txHash,
      });
    } else if (l.eventName === "VoidOverPaid") {
      const a = l.args;
      ev.voidOverPaid.push({
        purchaseId: a.purchaseId.toString(), itemIndex: Number(a.itemIndex), buyer: lower(a.buyer), overMilli: a.overMilli.toString(),
        blockNumber: at.blockNumber, txHash: at.txHash,
      });
    }
  }
  for (const l of parseEventLogs({ abi: pikitFairnessAbi, logs: logs.filter((x) => lower(x.address) === fairness) })) {
    if (l.eventName === "PurchasesVoided") {
      ev.voids.push({ fromId: l.args.fromId.toString(), toId: l.args.toId.toString(), blockNumber: Number(l.blockNumber), logIndex: Number(l.logIndex), txHash: lower(l.transactionHash) });
    } else if (l.eventName === "Anchored") {
      const a = l.args;
      ev.anchors.push({
        anchorIndex: Number(a.anchorIndex), postedBlock: Number(l.blockNumber), processedThrough: Number(a.processedThrough),
        processedPurchases: Number(a.processedPurchases), epoch: Number(a.epoch), seed: lower(a.seed), roomsStateRoot: lower(a.roomsStateRoot),
        inputLogRoot: lower(a.inputLogRoot), boardBatchRoot: lower(a.boardBatchRoot),
      });
    }
  }
  return ev;
}

export class RpcChainSource implements ChainSource {
  private readonly endpoints: Endpoint[];
  private readonly shop: Hex;
  private opened: Promise<Opened> | null = null;

  constructor(private readonly o: RpcChainSourceOptions) {
    if (o.rpcUrls.length < 1 || o.rpcUrls.length > 2) throw new Error(`RpcChainSource: give 1 or 2 RPC URLs (got ${o.rpcUrls.length})`);
    this.endpoints = o.rpcUrls.map((url) => new Endpoint(url, o));
    this.shop = lower(o.shop) as Hex;
  }

  /** RPC 곳 수 (2 = 교차 확인). */
  get endpointCount(): number {
    return this.endpoints.length;
  }

  /** 지금 eth_getLogs 구간 크기 (범위 오류를 받으면 줄어든다, 곳들 중 가장 작은 것). */
  get logChunk(): number {
    return Math.min(...this.endpoints.map((e) => e.chunk));
  }

  /** 모든 곳에서 같은 읽기를 동시에 하고 값이 같은지 본다. */
  private async all<T>(what: string, read: (e: Endpoint) => Promise<T>): Promise<T> {
    return agree(what, await Promise.all(this.endpoints.map(read)));
  }

  private open(): Promise<Opened> {
    this.opened ??= (async () => {
      const got = await Promise.all(this.endpoints.map((e) => e.open(this.shop)));
      const same = agree("chainId / PikitFairness / genesisBlock / seedRoot", got.map(({ head: _h, ...rest }) => rest));
      const pin = Math.min(...got.map((g) => g.head));
      await this.all(`block hash of the common finalized block ${pin}`, (e) => e.blockHash(pin));
      return { ...same, pin };
    })();
    return this.opened;
  }

  async head(): Promise<{ finalized: number; anchorCount: number; genesisBlock: number }> {
    const { fairness, pin, genesisBlock } = await this.open();
    const count = await this.all("PikitFairness.anchorCount()", async (e) =>
      Number(await e.client.readContract({ address: fairness, abi: pikitFairnessAbi, functionName: "anchorCount", blockNumber: BigInt(pin) })));
    return { finalized: pin, anchorCount: count, genesisBlock };
  }

  async anchorAt(index: number): Promise<AnchorStub> {
    const { fairness, pin } = await this.open();
    return this.all(`PikitFairness.anchorAt(${index})`, async (e) => {
      const a = await e.client.readContract({ address: fairness, abi: pikitFairnessAbi, functionName: "anchorAt", args: [BigInt(index)], blockNumber: BigInt(pin) });
      return { anchorIndex: index, postedBlock: Number(a.postedBlock), processedThrough: Number(a.processedThrough) };
    });
  }

  async purchaseBlock(purchaseId: string): Promise<number | null> {
    const { pin } = await this.open();
    return this.all(`PikitShop.purchaseOf(${purchaseId})`, async (e) => {
      try {
        const r = await e.client.readContract({ address: this.shop, abi: pikitShopAbi, functionName: "purchaseOf", args: [BigInt(purchaseId)], blockNumber: BigInt(pin) });
        return lower(r.buyer) === lower(`0x${"0".repeat(40)}`) ? null : Number(r.blockNumber);
      } catch (err) {
        if (/revert/i.test(errorText(err))) return null;
        throw err;
      }
    });
  }

  async snapshot(need: ChainNeed): Promise<ChainFacts> {
    const { chainId, fairness, genesisBlock, seedRoot, pin } = await this.open();
    const through = Math.min(pin, this.o.throughBlock ?? pin);
    const last = need.throughWindow;
    if (pin < last) throw new Error(`RpcChainSource: chain finalized only through block ${pin}; the replay needs the block hash of window ${last}`);
    if (through < last - 1) throw new Error(`RpcChainSource: events are read only through block ${through}; the replay needs every event through block ${last - 1}`);
    const eventsFrom = Math.max(genesisBlock, need.eventsFrom ?? genesisBlock);
    const fromWindow = Math.max(genesisBlock, need.fromWindow ?? genesisBlock);

    // 사건은 종류마다 원소 하나씩 대조한다 (첫 차이가 "settlements[12]"처럼 나온다)
    const perEndpoint = await Promise.all(this.endpoints.map(async (e) => decodeEvents(await e.logs([this.shop, fairness], eventsFrom, through), this.shop, fairness)));
    const pick = <K extends keyof Events>(k: K): Events[K] => agree(`${k} (blocks ${eventsFrom}…${through})`, perEndpoint.map((x) => x[k]));
    const events: Events = {
      purchases: pick("purchases"), cancels: pick("cancels"), settlements: pick("settlements"), voidOverPaid: pick("voidOverPaid"), voids: pick("voids"), anchors: pick("anchors"),
    };
    const roomRules = await this.all("room rules (roomOf)", async (e) => {
      const rooms = await Promise.all(need.rooms.map(async (roomId) => ({
        roomId, r: await e.client.readContract({ address: this.shop, abi: pikitShopAbi, functionName: "roomOf", args: [BigInt(roomId)], blockNumber: BigInt(pin) }),
      })));
      return rooms.filter(({ r }) => r.exists).map(({ roomId, r }): ChainRoomRules => ({
        roomId, rulesHash: lower(r.rulesHash), nextRulesHash: lower(r.nextRulesHash) === ZERO_BYTES32 ? null : lower(r.nextRulesHash),
        createdBlock: Number(r.createdBlock),
      }));
    });
    if (roomRules.length === 0) throw new Error(`RpcChainSource: none of the rooms ${need.rooms.join(", ")} exists on PikitShop ${this.shop}`);
    const rulesHashes = [...new Set(roomRules.flatMap((r) => (r.nextRulesHash ? [r.rulesHash, r.nextRulesHash] : [r.rulesHash])))];
    const catalogs = await this.all("catalog prices and caps (catalogOf)", (e) => Promise.all(rulesHashes.map(async (rulesHash): Promise<ChainCatalog> => {
      const [, , prices, caps, overCaps] = await e.client.readContract({
        address: this.shop, abi: pikitShopAbi, functionName: "catalogOf", args: [rulesHash as Hex], blockNumber: BigInt(pin),
      });
      return { rulesHash, tierPrices: prices.map(String), tierCapsMilli: caps.map(String), tierOverCapsMilli: overCaps.map(String) };
    })));
    const blockHashes = await this.all("block hashes", (e) => e.blockHashRange(fromWindow, last));
    return ChainFacts.parse({
      schema: CHAIN_SNAPSHOT_SCHEMA_ID, chainId, shop: this.shop, fairness, genesisBlock, seedRoot, throughBlock: through,
      ...(eventsFrom > genesisBlock ? { fromBlock: eventsFrom } : {}),
      rulesHashes, roomRules, catalogs, anchors: events.anchors, blockHashes, settlements: events.settlements, purchases: events.purchases, cancels: events.cancels,
      voids: events.voids, voidOverPaid: events.voidOverPaid,
    });
  }

  async blockHashes(windows: readonly number[]): Promise<Record<string, string>> {
    if (windows.length === 0) return {};
    const { pin } = await this.open();
    const want = [...new Set(windows)].filter((w) => w <= pin).sort((a, b) => a - b);
    return this.all("block hashes (batch rows before the range)", async (e) => {
      const out: Record<string, string> = {};
      let next = 0;
      const worker = async () => {
        while (next < want.length) {
          const w = want[next++]!;
          out[String(w)] = (await e.blockHash(w)).hash;
        }
      };
      await Promise.all(Array.from({ length: Math.min(Math.max(1, this.o.concurrency ?? 16), want.length) }, worker));
      return out;
    });
  }
}
