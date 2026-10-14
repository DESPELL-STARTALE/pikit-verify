// 가짜 Monad JSON-RPC (네트워크 없음): `pikit.ledger-chain/v1` 체인 값을 PikitLedger view·로그(RootPosted·AnnouncerChanged)·블록·ERC-1271 eth_call로 내준다.
// 같은 프로세스는 viem custom 트랜스포트(.transport), CLI 시험은 HTTP 서버(listen)로 쓴다. 실제 RPC처럼 주소는 체크섬, 해시는 대문자로 내준다.
import { createServer, type Server } from "node:http";
import {
  custom, decodeFunctionData, encodeAbiParameters, encodeEventTopics, encodeFunctionResult, getAddress, HttpRequestError, keccak256, toHex,
  type Abi, type AbiEvent, type Hex, type Transport,
} from "viem";
import { pikitLedgerAbi } from "@pikit/protocol";
import { ERC1271_MAGIC, unwrapErc6492, type LedgerChainFile } from "../src/index.js";

const erc1271Abi = [{
  type: "function", name: "isValidSignature", stateMutability: "view",
  inputs: [{ name: "hash", type: "bytes32" }, { name: "signature", type: "bytes" }], outputs: [{ name: "", type: "bytes4" }],
}] as const;

const upper = (h: string) => `0x${h.slice(2).toUpperCase()}`;
const lower = (h: string) => h.toLowerCase();

interface FakeLog { topics: Hex[]; data: Hex; blockNumber: number; logIndex: number; txHash: string }

function eventLog(eventName: string, args: Record<string, unknown>): { topics: Hex[]; data: Hex } {
  const ev = (pikitLedgerAbi as Abi).find((x): x is AbiEvent => x.type === "event" && x.name === eventName)!;
  const rest = ev.inputs.filter((i) => !i.indexed);
  return {
    topics: encodeEventTopics({ abi: [ev], eventName, args: Object.fromEntries(ev.inputs.filter((i) => i.indexed).map((i) => [i.name!, args[i.name!]])) } as never) as Hex[],
    data: encodeAbiParameters(rest, rest.map((i) => args[i.name!]) as never),
  };
}

export class FakeLedgerChain {
  maxRange = 60;            // eth_getLogs 구간 상한 — 넘으면 -32602
  rangeRejected = 0;
  fail429 = 0;              // 다음 N번 요청을 HTTP 429로
  readonly requests: { method: string; params: unknown[] }[] = [];
  readonly transport: Transport;
  private logs: FakeLog[] = [];

  constructor(readonly c: LedgerChainFile) {
    this.transport = custom({ request: async ({ method, params }: { method: string; params?: unknown }) => this.handle(method, (params ?? []) as unknown[]) });
    this.rebuild();
  }

  /** 체인 값(c)을 고친 뒤 로그를 다시 만든다. */
  rebuild(): void {
    this.logs = [];
    for (const a of this.c.announcerChanges) {
      this.logs.push({ ...eventLog("AnnouncerChanged", { previous: a.previous, next: a.next, fromWindow: BigInt(a.fromWindow) }), blockNumber: a.blockNumber, logIndex: a.logIndex, txHash: keccak256(toHex(`ann-${a.blockNumber}`)) });
    }
    for (const r of this.c.roots) {
      const root = {
        epoch: r.epoch, seed: r.seed, throughWindow: BigInt(r.throughWindow), roomsStateRoot: r.roomsStateRoot, inputLogRoot: r.inputLogRoot, boardBatchRoot: r.boardBatchRoot,
        ledgerRoot: r.ledgerRoot, payoutsRoot: r.payoutsRoot, supplyMilli: BigInt(r.supplyMilli), dataHash: r.dataHash,
      };
      this.logs.push({ ...eventLog("SeedRevealed", { epoch: r.epoch, seed: r.seed }), blockNumber: r.postedBlock, logIndex: 0, txHash: r.txHash });
      this.logs.push({ ...eventLog("RootPosted", { index: BigInt(r.rootIndex), root }), blockNumber: r.postedBlock, logIndex: 1, txHash: r.txHash });
    }
    this.logs.sort((x, y) => x.blockNumber - y.blockNumber || x.logIndex - y.logIndex);
  }

  /** 번호로 읽은 블록 (확정 머리·기준 블록 해시 대조는 뺀다). */
  blockReads(): number[] {
    return this.requests.filter((r) => r.method === "eth_getBlockByNumber" && r.params[0] !== "finalized").map((r) => Number(r.params[0])).filter((n) => n !== this.c.finalized);
  }

  handle(method: string, params: unknown[]): unknown {
    this.requests.push({ method, params });
    if (this.fail429 > 0) {
      this.fail429 -= 1;
      throw new HttpRequestError({ url: "https://rpc.example/KEY", status: 429, details: "Too Many Requests" });
    }
    const c = this.c;
    switch (method) {
      case "eth_chainId": return toHex(c.chainId);
      case "eth_getBlockByNumber": {
        const n = params[0] === "finalized" ? c.finalized : Number(params[0]);
        if (n > c.finalized + 100) return null;
        const h = (x: number) => c.blockHashes[String(x)] ?? keccak256(toHex(`fake-block-${x}`));
        return { number: toHex(n), hash: upper(h(n)), parentHash: upper(h(n - 1)), timestamp: toHex(c.blockTimestamps[String(n)] ?? 1_700_000_000 + n), transactions: [] };
      }
      case "eth_getLogs": {
        const f = params[0] as { address?: string | string[]; fromBlock: string; toBlock: string };
        const from = Number(f.fromBlock);
        const to = Number(f.toBlock);
        if (to - from + 1 > this.maxRange) {
          this.rangeRejected += 1;
          throw Object.assign(new Error(`block range too large, max ${this.maxRange} blocks`), { code: -32602 });
        }
        if (![f.address ?? []].flat().map(lower).includes(c.ledger)) return [];
        return this.logs.filter((l) => l.blockNumber >= from && l.blockNumber <= to).map((l) => ({
          address: getAddress(c.ledger), topics: l.topics, data: l.data, blockNumber: toHex(l.blockNumber), blockHash: c.blockHashes[String(l.blockNumber)] ?? keccak256(toHex(l.blockNumber)),
          transactionHash: upper(l.txHash), transactionIndex: "0x0", logIndex: toHex(l.logIndex), removed: false,
        }));
      }
      case "eth_call": {
        const call = params[0] as { to: string; data?: Hex; input?: Hex };
        const data = (call.data ?? call.input)!;
        const block = typeof params[1] === "string" && params[1].startsWith("0x") ? Number(params[1]) : c.finalized;
        if (lower(call.to) === c.ledger) {
          const fn = decodeFunctionData({ abi: pikitLedgerAbi, data });
          const ret = (result: unknown) => encodeFunctionResult({ abi: pikitLedgerAbi, functionName: fn.functionName, result } as never);
          const posted = c.roots.filter((r) => r.postedBlock <= block);
          const ann = c.announcerChanges.filter((a) => a.blockNumber <= block).pop()!;
          switch (fn.functionName) {
            case "seedRoot": return ret(c.seedRoot);
            case "genesisBlock": return ret(BigInt(c.genesisBlock));
            case "rulesHash": return ret(c.rulesHash);
            case "ledgerHash": return ret(c.ledgerHash);
            case "roomIds": return ret(c.roomIds);
            case "EPOCH_BLOCKS": return ret(c.epochBlocks);
            case "ANNOUNCER_DELAY": return ret(BigInt(c.announcerDelay));
            case "rootCount": return ret(BigInt(posted.length));
            case "announcer": return ret(getAddress(ann.next));
            case "announcerFromWindow": return ret(BigInt(ann.fromWindow));
            case "rootAt": {
              const r = posted.find((x) => x.rootIndex === Number(fn.args![0]));
              if (!r) throw Object.assign(new Error("execution reverted: RootIndexOutOfRange"), { code: 3 });
              return ret({ postedBlock: BigInt(r.postedBlock), throughWindow: BigInt(r.throughWindow), epoch: r.epoch, ledgerRoot: r.ledgerRoot });
            }
          }
        }
        const wallet = c.erc1271.find((a) => a.wallet === lower(call.to));
        if (wallet) {
          const fn = decodeFunctionData({ abi: erc1271Abi, data });
          const [hash, sig] = fn.args as [Hex, Hex];
          const ok = c.erc1271.some((a) => a.wallet === lower(call.to) && a.hash === lower(hash) && unwrapErc6492(a.signature) === lower(sig) && a.blockNumber === block && a.valid);
          return encodeFunctionResult({ abi: erc1271Abi, functionName: "isValidSignature", result: ok ? ERC1271_MAGIC : "0xffffffff" });
        }
        return "0x";   // 코드 없는 주소
      }
      default:
        throw Object.assign(new Error(`method ${method} not supported`), { code: -32601 });
    }
  }

  /** HTTP JSON-RPC 서버 (CLI 시험). 돌려주는 것 = { url, server }. */
  async listen(): Promise<{ url: string; server: Server }> {
    const server = createServer((req, res) => {
      let body = "";
      req.on("data", (b) => { body += b; });
      req.on("end", () => {
        const one = (m: { id: unknown; method: string; params?: unknown[] }) => {
          try {
            return { jsonrpc: "2.0", id: m.id, result: this.handle(m.method, m.params ?? []) };
          } catch (e) {
            const err = e as { code?: number; message: string; status?: number };
            if (err.status === 429) throw e;
            return { jsonrpc: "2.0", id: m.id, error: { code: typeof err.code === "number" ? err.code : -32000, message: err.message } };
          }
        };
        try {
          const msg = JSON.parse(body) as unknown;
          const out = Array.isArray(msg) ? msg.map(one) : one(msg as never);
          res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(out));
        } catch {
          res.writeHead(429).end("Too Many Requests");
        }
      });
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    const { port } = server.address() as { port: number };
    return { url: `http://127.0.0.1:${port}/rpc`, server };
  }
}
