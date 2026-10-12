// RpcChainSource(체인 값을 RPC에서 직접 읽기, H-1)와 limitedTransport를 가짜 JSON-RPC(viem custom 트랜스포트, 같은 프로세스 — 네트워크 없음)로 시험한다.
// 가짜 체인은 체인 값 묶음(ChainFacts)을 그대로 로그(Purchased·CancelRequested·Settled·PurchasesVoided·Anchored)·블록·eth_call로 내준다.
// 데모 묶음(WorldProducer)의 체인 사건을 RPC로 다시 읽으면 같은 값이 나오고, 그 값으로 verifyEpochs가 통과(정직)·연결 검사만 실패(retier)해야 한다.
import assert from "node:assert/strict";
import { before, describe, it } from "node:test";
import {
  custom, decodeFunctionData, encodeAbiParameters, encodeEventTopics, encodeFunctionResult, getAddress, HttpRequestError, keccak256, TimeoutError, toHex,
  type Abi, type AbiEvent, type Hex, type Transport,
} from "viem";
import { onchainRulesHash, pikitFairnessAbi, pikitShopAbi, SETTLE_KIND_ONCHAIN, WorldManifest, ZERO_BYTES32, type Hex32 } from "@pikit/protocol";
import { AGREE_CHECK, ChainDisagreement, ChainFacts, limitedTransport, LINKAGE_CHECK, RpcChainSource, verifyEpochs, type EpochVerifyReport, type RpcChainSourceOptions } from "../src/index.js";
import { buildDemoBundle, EPOCHS, SHOP, W0, type DemoBundle } from "./demo-bundle.js";

const FAIRNESS = "0xfa1e000000000000000000000000000000000006";
const LAST = W0 + EPOCHS * 200 - 1;   // 데모 묶음의 마지막 윈도
const upper = (h: string) => `0x${h.slice(2).toUpperCase()}`;
const lower = (h: string) => h.toLowerCase();

interface FakeRoom { rulesHash: Hex; nextRulesHash?: Hex; createdBlock?: number }
interface FakeLog { address: string; topics: Hex[]; data: Hex; blockNumber: number; logIndex: number; txHash: string }

/** ABI의 이벤트 하나를 로그(topics + data)로. args = 이름 → 값 (indexed는 topic, 나머지는 data). */
function eventLog(abi: Abi, eventName: string, args: Record<string, unknown>): { topics: Hex[]; data: Hex } {
  const ev = abi.find((x): x is AbiEvent => x.type === "event" && x.name === eventName);
  if (!ev) throw new Error(`no event ${eventName}`);
  const rest = ev.inputs.filter((i) => !i.indexed);
  return {
    topics: encodeEventTopics({ abi: [ev], eventName, args: Object.fromEntries(ev.inputs.filter((i) => i.indexed).map((i) => [i.name!, args[i.name!]])) } as never) as Hex[],
    data: encodeAbiParameters(rest, rest.map((i) => args[i.name!]) as never),
  };
}

/**
 * 가짜 체인 (JSON-RPC): snap의 사건을 로그로, 블록 해시를 블록으로(없는 블록은 만든 해시, parentHash = 앞 블록 해시), 상점·공정성 읽기를 eth_call로.
 * 실제 RPC처럼 로그 주소는 체크섬 형식, 해시는 대문자로 내준다(읽는 쪽이 소문자로 바꾸는지). 정산·앵커는 그 블록의 다른 로그 뒤 번호.
 */
class FakeChain {
  finalized: number;
  maxRange = 60;                 // eth_getLogs 구간 상한 — 넘으면 -32602 "block range too large"
  rangeRejected = 0;
  fail429 = 0;                   // 다음 N번 요청을 HTTP 429로
  served429 = 0;
  fairnessShop: string;          // PikitFairness.shop() (다른 상점 흉내)
  readonly requests: { method: string; params: unknown[] }[] = [];
  readonly transport: Transport;
  private logs: FakeLog[] = [];

  constructor(readonly snap: ChainFacts, private readonly rooms: ReadonlyMap<number, FakeRoom>) {
    this.finalized = snap.throughBlock;
    this.fairnessShop = snap.shop;
    this.transport = custom({ request: async ({ method, params }: { method: string; params?: unknown }) => this.handle(method, (params ?? []) as unknown[]) });
    this.rebuildLogs();
  }

  /** snap의 사건으로 로그를 (다시) 만든다 — 시험이 snap을 고친 뒤 부른다. */
  rebuildLogs(): void {
    const snap = this.snap;
    this.logs = [];
    const shopAbi = pikitShopAbi as Abi;
    const fairAbi = pikitFairnessAbi as Abi;
    const add = (address: string, e: { topics: Hex[]; data: Hex }, blockNumber: number, logIndex: number, txHash: string) => this.logs.push({ address, ...e, blockNumber, logIndex, txHash });
    for (const p of snap.purchases) {
      add(snap.shop, eventLog(shopAbi, "Purchased", {
        purchaseId: BigInt(p.purchaseId), buyer: p.buyer, roomId: BigInt(p.roomId), rulesHash: p.rulesHash, seq: 1n, tiers: p.tiers, priceCredits: 1000n,
      }), p.blockNumber, p.logIndex, p.txHash);
    }
    for (const c of snap.cancels) add(snap.shop, eventLog(shopAbi, "CancelRequested", { wallet: c.wallet, roomId: BigInt(c.roomId), items: c.items.map(BigInt) }), c.blockNumber, c.logIndex, c.txHash);
    for (const v of snap.voids) add(FAIRNESS, eventLog(fairAbi, "PurchasesVoided", { fromId: BigInt(v.fromId), toId: BigInt(v.toId) }), v.blockNumber, v.logIndex, v.txHash);
    const nextIndex = new Map<number, number>();
    for (const l of this.logs) nextIndex.set(l.blockNumber, Math.max(nextIndex.get(l.blockNumber) ?? 0, l.logIndex + 1));
    const slot = (block: number) => {
      const i = nextIndex.get(block) ?? 0;
      nextIndex.set(block, i + 1);
      return i;
    };
    for (const s of snap.settlements) {
      add(snap.shop, eventLog(shopAbi, "Settled", {
        purchaseId: BigInt(s.purchaseId), itemIndex: s.itemIndex, buyer: s.buyer, kind: SETTLE_KIND_ONCHAIN[s.kind], payoutMilli: BigInt(s.payoutMilli),
        overMilli: BigInt(s.overMilli),
      }), s.blockNumber, slot(s.blockNumber), s.txHash);
    }
    for (const v of snap.voidOverPaid) {
      add(snap.shop, eventLog(shopAbi, "VoidOverPaid", { purchaseId: BigInt(v.purchaseId), itemIndex: v.itemIndex, buyer: v.buyer, overMilli: BigInt(v.overMilli) }), v.blockNumber, slot(v.blockNumber), v.txHash);
    }
    for (const a of snap.anchors) {
      add(FAIRNESS, eventLog(fairAbi, "Anchored", {
        anchorIndex: BigInt(a.anchorIndex), processedThrough: BigInt(a.processedThrough), processedPurchases: BigInt(a.processedPurchases), epoch: a.epoch,
        seed: a.seed, roomsStateRoot: a.roomsStateRoot, inputLogRoot: a.inputLogRoot, boardBatchRoot: a.boardBatchRoot,
      }), a.postedBlock, slot(a.postedBlock), keccak256(toHex(`anchor-tx-${a.anchorIndex}`)));
    }
    this.logs.sort((x, y) => x.blockNumber - y.blockNumber || x.logIndex - y.logIndex);
  }

  hashOf(n: number): string {
    return this.snap.blockHashes[String(n)] ?? keccak256(toHex(`fake-block-${n}`));
  }

  /** 번호로 읽은 블록 (확정 머리 읽기, 기준 블록 pin의 해시 대조 1번은 뺀다). */
  blockReads(): number[] {
    const reads = this.requests.filter((r) => r.method === "eth_getBlockByNumber" && r.params[0] !== "finalized").map((r) => Number(r.params[0]));
    const pin = reads.indexOf(this.finalized);
    if (pin >= 0) reads.splice(pin, 1);
    return reads;
  }

  private handle(method: string, params: unknown[]): unknown {
    this.requests.push({ method, params });
    if (this.fail429 > 0) {
      this.fail429 -= 1;
      this.served429 += 1;
      throw new HttpRequestError({ url: "https://rpc.example/KEY", status: 429, details: "Too Many Requests" });
    }
    switch (method) {
      case "eth_chainId": return toHex(this.snap.chainId);
      case "eth_getBlockByNumber": {
        const n = params[0] === "finalized" ? this.finalized : Number(params[0]);
        if (n > this.finalized + 100) return null;
        return { number: toHex(n), hash: upper(this.hashOf(n)), parentHash: upper(this.hashOf(n - 1)), timestamp: toHex(1_700_000_000 + n), transactions: [] };
      }
      case "eth_getLogs": {
        const f = params[0] as { address?: string | string[]; fromBlock: string; toBlock: string };
        const from = Number(f.fromBlock);
        const to = Number(f.toBlock);
        if (to - from + 1 > this.maxRange) {
          this.rangeRejected += 1;
          throw Object.assign(new Error(`block range too large, max ${this.maxRange} blocks`), { code: -32602 });
        }
        const addrs = [f.address ?? []].flat().map(lower);
        return this.logs.filter((l) => l.blockNumber >= from && l.blockNumber <= to && addrs.includes(lower(l.address))).map((l) => ({
          address: getAddress(l.address), topics: l.topics, data: l.data, blockNumber: toHex(l.blockNumber), blockHash: this.hashOf(l.blockNumber),
          transactionHash: upper(l.txHash), transactionIndex: "0x0", logIndex: toHex(l.logIndex), removed: false,
        }));
      }
      case "eth_call": {
        const call = params[0] as { to: string; data?: Hex; input?: Hex };
        const data = (call.data ?? call.input)!;
        if (lower(call.to) === this.snap.shop) {
          const fn = decodeFunctionData({ abi: pikitShopAbi, data });
          if (fn.functionName === "fairness") return encodeFunctionResult({ abi: pikitShopAbi, functionName: "fairness", result: getAddress(FAIRNESS) });
          if (fn.functionName === "purchaseOf") {
            const pr = this.snap.purchases.find((x) => x.purchaseId === String(fn.args[0]));
            if (!pr) throw Object.assign(new Error("execution reverted: UnknownPurchase"), { code: 3 });
            return encodeFunctionResult({
              abi: pikitShopAbi, functionName: "purchaseOf",
              result: { buyer: getAddress(pr.buyer), blockNumber: pr.blockNumber, catalogId: 1, refunded: false, tiers: pr.tiers, settledMask: 0, voidOverMask: 0, priceCredits: 1000n },
            });
          }
          if (fn.functionName === "catalogOf") {
            const c = this.snap.catalogs.find((x) => x.rulesHash === lower(fn.args[0] as string));
            return encodeFunctionResult({
              abi: pikitShopAbi, functionName: "catalogOf",
              result: [c ? 1 : 0, 0n, (c?.tierPrices ?? []).map(BigInt), (c?.tierCapsMilli ?? []).map(BigInt), (c?.tierOverCapsMilli ?? []).map(BigInt)],
            });
          }
          if (fn.functionName === "roomOf") {
            const room = this.rooms.get(Number(fn.args[0]));
            return encodeFunctionResult({
              abi: pikitShopAbi, functionName: "roomOf",
              result: { rulesHash: room?.rulesHash ?? ZERO_BYTES32, nextRulesHash: room?.nextRulesHash ?? ZERO_BYTES32, switchBlock: 0n, open: room !== undefined, exists: room !== undefined, createdBlock: BigInt(room?.createdBlock ?? 0) },
            });
          }
        }
        if (lower(call.to) === FAIRNESS) {
          const fn = decodeFunctionData({ abi: pikitFairnessAbi, data });
          if (fn.functionName === "shop") return encodeFunctionResult({ abi: pikitFairnessAbi, functionName: "shop", result: getAddress(this.fairnessShop) });
          if (fn.functionName === "genesisBlock") return encodeFunctionResult({ abi: pikitFairnessAbi, functionName: "genesisBlock", result: BigInt(this.snap.genesisBlock) });
          if (fn.functionName === "seedRoot") return encodeFunctionResult({ abi: pikitFairnessAbi, functionName: "seedRoot", result: this.snap.seedRoot as Hex });
          const anchors = [...this.snap.anchors].sort((a, b) => a.anchorIndex - b.anchorIndex);
          if (fn.functionName === "anchorCount") return encodeFunctionResult({ abi: pikitFairnessAbi, functionName: "anchorCount", result: BigInt(anchors.length) });
          if (fn.functionName === "anchorAt") {
            const a = anchors[Number(fn.args[0])];
            if (!a) throw Object.assign(new Error("execution reverted: AnchorIndexOutOfRange"), { code: 3 });
            return encodeFunctionResult({ abi: pikitFairnessAbi, functionName: "anchorAt", result: { postedBlock: BigInt(a.postedBlock), processedThrough: BigInt(a.processedThrough), epoch: a.epoch } });
          }
        }
        throw Object.assign(new Error("execution reverted"), { code: 3 });
      }
      default:
        throw Object.assign(new Error(`method ${method} not supported`), { code: -32601 });
    }
  }
}

/** 세계 목록의 방마다 체인 rulesHash (keccak256(catalogHash ‖ engineVersionHash)). */
function roomsOf(d: DemoBundle): Map<number, FakeRoom> {
  const w = WorldManifest.parse(d.world);
  return new Map(w.rooms.map((r) => [r.roomId, { rulesHash: onchainRulesHash(r.catalogHash as Hex32, w.engineVersionHash as Hex32), createdBlock: r.createdWindow }]));
}

const options = (fake: FakeChain, o: Partial<RpcChainSourceOptions> = {}): RpcChainSourceOptions =>
  ({ rpcUrls: ["https://rpc.example/KEY"], shop: getAddress(SHOP), transport: () => fake.transport, maxRps: 100_000, backoffBaseMs: 1, ...o });
const failed = (r: EpochVerifyReport) => r.checks.filter((c) => !c.ok).map((c) => c.name);

describe("RpcChainSource (H-1): chain values straight from the RPC", () => {
  let demo: DemoBundle;
  let snap: ChainFacts;
  before(() => {
    demo = buildDemoBundle();
    snap = ChainFacts.parse(demo.chain);
  });

  it("reads back exactly the producer's chain values: purchases, cancels, voids, settlements, anchors, rules and block hashes (lower-case)", async () => {
    const fake = new FakeChain(snap, roomsOf(demo));
    fake.fail429 = 1;
    const src = new RpcChainSource(options(fake));
    const { fairness, ...got } = await src.snapshot({ throughWindow: LAST, rooms: [1, 2] });
    assert.equal(fairness, FAIRNESS, "PikitShop.fairness() is reported as a trust root (M-4)");
    assert.deepEqual(got, snap);
    // 연결 (블록, 로그 번호, tx)·소문자·종류·앵커 실린 블록
    assert.ok(got.purchases.length > 200 && got.cancels.length === 1 && got.voids.length === 2 && got.voidOverPaid.length === 1 && got.anchors.length === EPOCHS);
    assert.ok([...got.purchases.map((p) => p.buyer), ...got.cancels.map((c) => c.wallet), ...got.settlements.map((s) => s.buyer)].every((a) => /^0x[0-9a-f]{40}$/.test(a)));
    assert.ok([...got.purchases, ...got.cancels, ...got.voids, ...got.settlements].every((x) => /^0x[0-9a-f]{64}$/.test(x.txHash)));
    assert.deepEqual([...new Set(got.settlements.map((s) => s.kind))].sort(), [...new Set(snap.settlements.map((s) => s.kind))].sort());
    assert.ok(got.settlements.some((s) => s.kind === "REFUND") && got.settlements.some((s) => s.kind === "REWARD"));
    assert.deepEqual(got.anchors.map((a) => a.postedBlock), Array.from({ length: EPOCHS }, (_, i) => W0 + 200 * (i + 1) - 1 + 30));
    // 블록 해시: 윈도 [W0, LAST] 전부, 블록 k를 읽어 k와 parentHash(k − 1) — 요청 1번에 윈도 2개
    assert.deepEqual(Object.keys(got.blockHashes).map(Number), Array.from({ length: LAST - W0 + 1 }, (_, i) => W0 + i));
    for (let w = W0; w <= LAST; w++) assert.equal(got.blockHashes[String(w)], fake.hashOf(w));
    const reads = fake.blockReads();
    assert.equal(reads.length, (LAST - W0 + 1) / 2);
    assert.ok(reads.every((k) => (k - W0) % 2 === 1), "odd offsets only: each read also gives the parent");
    // 속도 제한(429 한 번은 그 자리에서 다시) · 로그 구간(100 → 범위 오류 한 번 → 50, 기억)
    assert.equal(fake.served429, 1);
    assert.equal(fake.rangeRejected, 1);
    assert.equal(src.logChunk, 50);
    assert.equal(got.throughBlock, fake.finalized);
  });

  it("verifyEpochs over the RPC source: the honest demo bundle passes; the finalized head past the replay is read to the head", async () => {
    const fake = new FakeChain(snap, roomsOf(demo));
    fake.finalized = snap.throughBlock + 25;
    const r = await verifyEpochs({ world: demo.world, catalogs: demo.catalogs, epochs: demo.epochs, chain: new RpcChainSource(options(fake)) });
    assert.deepEqual(failed(r), []);
    assert.ok(r.ok && r.checks.some((c) => c.name === LINKAGE_CHECK && c.ok));
    assert.ok(r.linkage.checked > 200);
    assert.equal(r.linkage.matched, r.linkage.checked);
    assert.equal(r.anchors.length, EPOCHS);
    assert.ok(r.settlements.checked > 20 && r.settlements.mismatches.length === 0);
    assert.equal(r.chainThroughBlock, fake.finalized);
  });

  it("verifyEpochs over the RPC source (M-2, PoC R6-06): a shop deployed with the same rulesHash but double prices fails the price check of every room", async () => {
    const doubled = structuredClone(snap);
    for (const c of doubled.catalogs) c.tierPrices = c.tierPrices.map((p) => String(2n * BigInt(p)));
    const fake = new FakeChain(doubled, roomsOf(demo));
    const r = await verifyEpochs({ world: demo.world, catalogs: demo.catalogs, epochs: demo.epochs, chain: new RpcChainSource(options(fake)) });
    assert.deepEqual(failed(r), ["room 1: chain tier prices (catalogOf) = catalog prices", "room 2: chain tier prices (catalogOf) = catalog prices"]);
    const shopCalls = fake.requests.filter((q) => q.method === "eth_call" && lower((q.params[0] as { to: string }).to) === snap.shop);
    assert.ok(shopCalls.some((q) => decodeFunctionData({ abi: pikitShopAbi, data: (q.params[0] as { data: Hex }).data }).functionName === "catalogOf"));
  });

  it("verifyEpochs over the RPC source: an operator who re-tiered a purchase (×1 logged as ×20) fails only the linkage check (FIELDS)", async () => {
    const cheat = buildDemoBundle("retier");
    const fake = new FakeChain(ChainFacts.parse(cheat.chain), roomsOf(cheat));
    const r = await verifyEpochs({ world: cheat.world, catalogs: cheat.catalogs, epochs: cheat.epochs, chain: new RpcChainSource(options(fake)) });
    assert.deepEqual(failed(r), [LINKAGE_CHECK]);
    assert.deepEqual([...new Set(r.linkage.mismatches.map((m) => m.code))], ["FIELDS"]);
    assert.equal(r.anchors.length, EPOCHS, "the operator's anchors agree with the operator's log");
  });
});

describe("RpcChainSource with two endpoints (F-2, P0-16 d): every chain fact is read from both and must agree", () => {
  let demo: DemoBundle;
  let snap: ChainFacts;
  before(() => {
    demo = buildDemoBundle();
    snap = ChainFacts.parse(demo.chain);
  });
  /** 두 곳: 같은 데모 체인, b는 patch로 한 가지를 다르게. transport는 URL로 고른다. */
  const pair = (patch?: (b: FakeChain) => void) => {
    const a = new FakeChain(snap, roomsOf(demo));
    const b = new FakeChain(structuredClone(snap), roomsOf(demo));
    patch?.(b);
    const src = new RpcChainSource({
      rpcUrls: ["https://one.example/KEY", "https://two.example/KEY"], shop: getAddress(SHOP), maxRps: 100_000, backoffBaseMs: 1,
      transport: (url) => (url.includes("one") ? a.transport : b.transport),
    });
    return { a, b, src };
  };

  it("agreeing endpoints: the honest demo passes, both endpoints served every read (blocks, logs, calls)", async () => {
    const { a, b, src } = pair();
    const r = await verifyEpochs({ world: demo.world, catalogs: demo.catalogs, epochs: demo.epochs, chain: src });
    assert.deepEqual(failed(r), []);
    assert.equal(src.endpointCount, 2);
    assert.deepEqual(a.blockReads().sort((x, y) => x - y), b.blockReads().sort((x, y) => x - y));
    assert.equal(a.requests.filter((q) => q.method === "eth_getLogs").length, b.requests.filter((q) => q.method === "eth_getLogs").length);
  });

  it("the common finalized head is the lower of the two; reads are pinned there", async () => {
    const { src } = pair((b) => { b.finalized = snap.throughBlock + 40; });
    const got = await src.snapshot({ throughWindow: LAST, rooms: [1, 2] });
    assert.equal(got.throughBlock, snap.throughBlock);
  });

  for (const [what, patch, re] of [
    ["a block hash", (b: FakeChain) => { b.snap.blockHashes[String(W0 + 10)] = `0x${"0d".repeat(32)}`; }, /block hashes\[\d+\]/],
    ["a settlement amount", (b: FakeChain) => { b.snap.settlements[3]!.payoutMilli = "1"; }, /settlements \(blocks \d+…\d+\)\[3\]/],
    ["an anchor root", (b: FakeChain) => { b.snap.anchors[2]!.roomsStateRoot = `0x${"0e".repeat(32)}`; }, /anchors \(blocks \d+…\d+\)\[2\]/],
    ["the seed commitment", (b: FakeChain) => { b.snap.seedRoot = `0x${"5f".repeat(32)}`; }, /seedRoot/],
  ] as const) {
    it(`disagreeing endpoints (${what}): the run fails the agreement check with the first difference`, async () => {
      const { src } = pair((b) => { patch(b); b.rebuildLogs(); });
      const r = await verifyEpochs({ world: demo.world, catalogs: demo.catalogs, epochs: demo.epochs, chain: src });
      assert.deepEqual(failed(r), [AGREE_CHECK]);
      const detail = r.checks.find((c) => !c.ok)!.detail!;
      assert.match(detail, re);
      assert.match(detail, /rpc#1 .* vs rpc#2 /);
      assert.doesNotMatch(detail, /example|KEY/, "no URL in the message");
      await assert.rejects(src.snapshot({ throughWindow: LAST, rooms: [1, 2] }), ChainDisagreement);
    });
  }

  it("snapshot start over RPC: anchors found by anchorAt (binary search), events read only from P_k + 1 − T_FREEZE, block hashes from the first replayed window", async () => {
    const { a, src } = pair();
    const E = 4;
    const r = await verifyEpochs({
      world: demo.world, catalogs: demo.catalogs, epochs: demo.epochs.slice(E), chain: src, firstEpoch: E + 1, snapshot: demo.snapshots[E - 1],
    });
    assert.deepEqual(failed(r), []);
    assert.equal(r.start?.anchorIndex, E - 1);
    const logs = a.requests.filter((q) => q.method === "eth_getLogs").map((q) => Number((q.params[0] as { fromBlock: string }).fromBlock));
    assert.equal(Math.min(...logs), Math.max(W0, W0 + 200 * E - 2 + 1 - 12_000), "events from max(genesis, P_k + 1 − T_FREEZE)");
    const reads = a.blockReads().filter((k) => k < W0 + 200 * E);
    assert.ok(reads.length < 40, `only batch rows before the snapshot are read before it (${reads.length})`);
  });

  it("refuses more than two endpoints", () => {
    assert.throws(() => new RpcChainSource({ rpcUrls: ["a", "b", "c"], shop: SHOP }), /1 or 2 RPC URLs/);
  });
});

describe("RpcChainSource: rules, settle kinds, ranges and refusals", () => {
  const A = "0xa11ce00000000000000000000000000000000001";
  const R1 = `0x${"11".repeat(32)}` as Hex;
  const R2 = `0x${"22".repeat(32)}` as Hex;
  const R3 = `0x${"33".repeat(32)}` as Hex;
  const tiny = (): ChainFacts => ChainFacts.parse({
    schema: "pikit.chain/v3", chainId: 10143, shop: SHOP, genesisBlock: 100, seedRoot: `0x${"5e".repeat(32)}`, throughBlock: 110,
    rulesHashes: [R1], roomRules: [], anchors: [], blockHashes: {}, purchases: [], cancels: [], voids: [],
    catalogs: [{ rulesHash: R1, tierPrices: ["1000", "2000"], tierCapsMilli: ["900000", "1800000"], tierOverCapsMilli: ["9617976", "18993816"] }],
    settlements: (["REWARD", "REFUND", "REWARD"] as const).map((kind, i) => ({
      purchaseId: "7", itemIndex: i, buyer: A, kind, payoutMilli: String(1000 * (i + 1)), overMilli: i === 2 ? "123456789" : "0", blockNumber: 105,
      txHash: `0x${String(i + 1).repeat(64)}`,
    })),
  });
  const rooms = new Map<number, FakeRoom>([[1, { rulesHash: R1 }], [2, { rulesHash: R2, nextRulesHash: R3 }]]);

  it("rulesHashes = each existing room's rules + its scheduled next rules (missing rooms skipped); Settled (rules 7 shape) kind 0/1 = REWARD/REFUND with overMilli", async () => {
    const fake = new FakeChain(tiny(), rooms);
    const got = await new RpcChainSource(options(fake)).snapshot({ throughWindow: 109, rooms: [1, 2, 3] });
    assert.deepEqual(got.rulesHashes, [R1, R2, R3]);
    assert.deepEqual(got.roomRules, [{ roomId: 1, rulesHash: R1, nextRulesHash: null, createdBlock: 0 }, { roomId: 2, rulesHash: R2, nextRulesHash: R3, createdBlock: 0 }]);
    assert.deepEqual(got.catalogs, [
      { rulesHash: R1, tierPrices: ["1000", "2000"], tierCapsMilli: ["900000", "1800000"], tierOverCapsMilli: ["9617976", "18993816"] },
      { rulesHash: R2, tierPrices: [], tierCapsMilli: [], tierOverCapsMilli: [] },
      { rulesHash: R3, tierPrices: [], tierCapsMilli: [], tierOverCapsMilli: [] },
    ], "catalogOf for every active and scheduled rules hash (unregistered = empty arrays)");
    assert.deepEqual(got.settlements.map((s) => [s.kind, s.itemIndex, s.payoutMilli, s.overMilli]), [["REWARD", 0, "1000", "0"], ["REFUND", 1, "2000", "0"], ["REWARD", 2, "3000", "123456789"]]);
    assert.deepEqual(got.settlements.map((s) => s.txHash), tiny().settlements.map((s) => s.txHash));
    assert.equal(got.throughBlock, 110);
    assert.deepEqual(Object.keys(got.blockHashes).map(Number), [100, 101, 102, 103, 104, 105, 106, 107, 108, 109]);
    assert.deepEqual(fake.blockReads().sort((a, b) => a - b), [101, 103, 105, 107, 109]);
  });

  it("an odd number of windows: the unpaired last window is read itself (its parent hash must agree)", async () => {
    const fake = new FakeChain(tiny(), rooms);
    const got = await new RpcChainSource(options(fake, { concurrency: 2 })).snapshot({ throughWindow: 110, rooms: [1] });
    assert.deepEqual(Object.keys(got.blockHashes).map(Number), [100, 101, 102, 103, 104, 105, 106, 107, 108, 109, 110]);
    for (let w = 100; w <= 110; w++) assert.equal(got.blockHashes[String(w)], fake.hashOf(w));
    assert.deepEqual(fake.blockReads().sort((a, b) => a - b), [101, 103, 105, 107, 109, 110]);
  });

  it("throughBlock limits the events read (default = finalized head)", async () => {
    const fake = new FakeChain(tiny(), rooms);
    const early = await new RpcChainSource(options(fake, { throughBlock: 104 })).snapshot({ throughWindow: 105, rooms: [1] });
    assert.equal(early.throughBlock, 104);
    assert.deepEqual(early.settlements, [], "Settled in block 105 is past throughBlock");
    const capped = await new RpcChainSource(options(fake, { throughBlock: 10_000 })).snapshot({ throughWindow: 105, rooms: [1] });
    assert.equal(capped.throughBlock, 110, "never past the finalized head");
    assert.equal(capped.settlements.length, 3);
  });

  it("refuses: another shop's fairness contract, a head before the last window, events cut before the last window − 1, no room on chain", async () => {
    const other = new FakeChain(tiny(), rooms);
    other.fairnessShop = `0x${"5c".repeat(20)}`;
    await assert.rejects(new RpcChainSource(options(other)).snapshot({ throughWindow: 105, rooms: [1] }), /whose shop\(\) is 0x5c5c/);
    const behind = new FakeChain(tiny(), rooms);
    behind.finalized = 104;
    await assert.rejects(new RpcChainSource(options(behind)).snapshot({ throughWindow: 105, rooms: [1] }), /chain finalized only through block 104/);
    const fake = new FakeChain(tiny(), rooms);
    await assert.rejects(new RpcChainSource(options(fake, { throughBlock: 103 })).snapshot({ throughWindow: 105, rooms: [1] }), /events are read only through block 103/);
    await assert.rejects(new RpcChainSource(options(fake)).snapshot({ throughWindow: 105, rooms: [7, 8] }), /none of the rooms 7, 8 exists/);
  });

  it("a log range error halves the chunk down to 1 and is remembered; other RPC errors are not retried", async () => {
    const fake = new FakeChain(tiny(), rooms);
    fake.maxRange = 3;
    const src = new RpcChainSource(options(fake, { logChunk: 16 }));
    const got = await src.snapshot({ throughWindow: 105, rooms: [1] });
    assert.equal(got.settlements.length, 3);
    assert.equal(src.logChunk, 2);
    assert.equal(fake.rangeRejected, 3, "16 → 8 → 4 → 2, then no more rejections");
    const none = new FakeChain(tiny(), rooms);
    none.maxRange = 0;
    await assert.rejects(new RpcChainSource(options(none, { logChunk: 4 })).snapshot({ throughWindow: 105, rooms: [1] }), /block range too large/);
    const calls = none.requests.length;
    await assert.rejects(new RpcChainSource(options(none, { shop: A })).snapshot({ throughWindow: 105, rooms: [1] }));
    assert.equal(none.requests.length - calls, 2, "eth_chainId + one reverted eth_call, no retry");
  });
});

describe("limitedTransport (the game-server block clock uses the same one)", () => {
  /** 내부 트랜스포트: 요청마다 fails 앞에서 하나를 던지고, 비면 "0x1". */
  const scripted = (fails: unknown[], calls: number[]): Transport =>
    custom({ async request() { calls.push(Date.now()); const e = fails.shift(); if (e) throw e; return "0x1"; } });
  const send = (t: Transport) => t({}).request({ method: "eth_chainId" } as never);

  it("spaces requests 1000 / maxRps ms apart", async () => {
    const calls: number[] = [];
    const t = limitedTransport(scripted([], calls), { maxRps: 50 });
    for (let i = 0; i < 6; i++) await send(t);
    assert.ok(calls[5]! - calls[0]! >= 95, `6 requests at 50/s span ≥ 100 ms (${calls[5]! - calls[0]!} ms)`);
  });

  it("retries rate limits (HTTP 429 honouring Retry-After, -32005, -32007, 'too many requests') and timeouts in place, up to maxRetries; throws other errors at once", async () => {
    const calls: number[] = [];
    const fails: unknown[] = [
      new HttpRequestError({ url: "https://rpc.example", status: 429, headers: new Headers({ "retry-after": "0.05" }) }),
      Object.assign(new Error("limit exceeded"), { code: -32005 }),
      Object.assign(new Error("50/second request limit reached - reduce calls per second"), { code: -32007 }),
      new Error("Too Many Requests"),
      new TimeoutError({ body: {}, url: "https://rpc.example" }),
    ];
    const t = limitedTransport(scripted(fails, calls), { maxRps: 100_000, backoffBaseMs: 1 });
    assert.equal(await send(t), "0x1");
    assert.equal(calls.length, 6);
    assert.ok(calls[1]! - calls[0]! >= 45, `Retry-After 0.05 s honoured (${calls[1]! - calls[0]!} ms)`);
    fails.push(Object.assign(new Error("execution reverted"), { code: 3 }));
    await assert.rejects(send(t), /execution reverted/);
    assert.equal(calls.length, 7, "not retried");
    const capped: number[] = [];
    const few = limitedTransport(scripted([1, 2, 3].map(() => Object.assign(new Error("limit exceeded"), { code: -32005 })), capped), { maxRps: 100_000, maxRetries: 2, backoffBaseMs: 1 });
    await assert.rejects(send(few));
    assert.equal(capped.length, 3, "1 try + 2 retries");
  });
});
