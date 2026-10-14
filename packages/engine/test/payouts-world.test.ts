// 곡괭이별 정산(EnginePayout, 개정 3: 잔액은 체인)과 세계(방 여러 개) 처리 순서, 묶음 생성, 엔진 버전 해시 (D37·D41·D82).
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";
import { keccak_256 } from "@noble/hashes/sha3";
import { bytesToHex, utf8ToBytes } from "@noble/hashes/utils";
import { parseCatalog, type Catalog, type EngineInput } from "@pikit/protocol";
import {
  addRoom, createRoom, earnedMilli, engineBuildInfo, engineVersionHash, overCapMilli, regenerateBatch, rewardCapMilli, runWindow, runWorldWindow,
  tierRewardCapsMilli, type CompletedBatch, type EnginePayout, type PickaxeResult, type World,
} from "../src/index.js";
import { busyBoard, fuzzPlan, loadCatalog, OWNERS, runPlan, seedFrom, windowFactory } from "./helpers.js";

const catalog = loadCatalog();
const [A, B, C] = OWNERS as [string, string, string];
const price = (tier: number) => catalog.pickaxes[tier]!.priceCredits * 1000;
const row = (p: EnginePayout) => [p.key, p.kind, p.cause, p.payoutMilli, p.overMilli];

/** 방 하나를 window 1…last 돌리고 모든 정산을 모은다. inputs(w)는 그 윈도 입력. */
function runRoom(cat: Catalog, seedNo: number, last: number, inputs: (w: number) => EngineInput[]) {
  const seed = seedFrom(seedNo);
  const state = createRoom(cat, windowFactory(seed, 1, 0), 1, 0);
  const payouts: EnginePayout[] = [];
  for (let w = 1; w <= last; w++) payouts.push(...runWindow(state, cat, w, inputs(w), windowFactory(seed, 1, w)).payouts);
  return { state, payouts };
}

describe("purchases: no balance checks (money already moved on chain)", () => {
  it("purchases from several wallets all enter the queue; nothing is rejected and nothing is paid on entry", () => {
    const state = createRoom(catalog, windowFactory(seedFrom(80), 1, 0), 1, 0);
    const res = runWindow(state, catalog, 1, [
      { type: "purchase", ref: "1", owner: A, tiers: [0, 1] },
      { type: "purchase", ref: "2", owner: B, tiers: [2] },
      { type: "purchase", ref: "3", owner: C, tiers: [3, 4] },
    ], windowFactory(seedFrom(80), 1, 1));
    assert.deepEqual(state.rejected, []);
    assert.deepEqual(res.payouts, []);
    assert.deepEqual(res.spawned.map((s) => s.key), ["1:0", "2:0", "3:0"]);
    assert.deepEqual(state.owners.map((s) => s.queue.map((q) => [q.key, q.priceMilli])), [[["1:1", price(1)]], [], [["3:1", price(4)]]]);
    // 규칙 7(D137): 황금 입구가 없다 — 스폰한 곡괭이는 그 윈도에 바로 판 위에 있다
    assert.deepEqual(state.pickaxes.filter((p) => p.owner !== null).map((p) => p.key), ["1:0", "2:0", "3:0"]);
  });

  it("malformed purchases are rejected defensively (BAD_TIER, TOO_MANY_TIERS) without any payout", () => {
    const state = createRoom(catalog, windowFactory(seedFrom(81), 1, 0), 1, 0);
    const res = runWindow(state, catalog, 1, [
      { type: "purchase", ref: "1", owner: A, tiers: [99] },
      { type: "purchase", ref: "2", owner: A, tiers: Array.from({ length: catalog.limits.maxTiersPerBuy + 1 }, () => 0) },
    ], windowFactory(seedFrom(81), 1, 1));
    assert.deepEqual(state.rejected.map((r) => [r.index, r.reason]), [[0, "BAD_TIER"], [1, "TOO_MANY_TIERS"]]);
    assert.deepEqual(res.payouts, []);
  });
});

describe("payouts: exactly one per pickaxe, REWARD/over split, amounts within the on-chain caps (rules 7, spec 16 §8.3)", () => {
  /**
   * 정산 불변식 (체인 settleEnd와 같은 조건): 곡괭이(대기열 항목 포함)마다 정확히 1건, VOID는 0건.
   *  정상 종료(DURABILITY) ⇔ REWARD/END: payout = min(E, 0.9·P), over = E − payout ≤ over 상한
   *  비정상 종료 ⇔ REFUND/ABNORMAL_END, over 0 · 취소·넘침·대기열 환불 = REFUND 가격 100%, over 0
   * 돌려준 값: [REWARD 수, over > 0인 REWARD 수, REFUND 수]
   */
  function checkPayouts(payouts: readonly EnginePayout[], results: readonly PickaxeResult[]): [number, number, number] {
    let rewards = 0;
    let overs = 0;
    let refunds = 0;
    const byKey = new Map<string, EnginePayout>();
    for (const p of payouts) {
      assert.ok(Number.isSafeInteger(p.payoutMilli) && p.payoutMilli >= 0, `${p.key}: payout ${p.payoutMilli}`);
      assert.ok(Number.isSafeInteger(p.overMilli) && p.overMilli >= 0, `${p.key}: over ${p.overMilli}`);
      assert.equal(p.priceMilli, price(p.tier));
      assert.ok(!byKey.has(p.key), `${p.key}: 정산이 두 번`);
      byKey.set(p.key, p);
      assert.ok(p.overMilli <= overCapMilli(catalog, p.tier), `${p.key}: over ${p.overMilli} > cap`);
      if (p.kind === "REWARD") {
        rewards += 1;
        if (p.overMilli > 0) overs += 1;
        assert.equal(p.cause, "END");
        assert.ok(p.payoutMilli <= rewardCapMilli(catalog, p.tier), `${p.key}: reward ${p.payoutMilli} > cap ${rewardCapMilli(catalog, p.tier)}`);
        if (p.overMilli > 0) assert.equal(p.payoutMilli, rewardCapMilli(catalog, p.tier), `${p.key}: over가 있으면 REWARD는 상한`);
      } else {
        refunds += 1;
        assert.equal(p.kind, "REFUND");
        assert.equal(p.overMilli, 0, `${p.key}: REFUND에 over`);
        assert.ok(p.payoutMilli <= p.priceMilli, `${p.key}: refund ${p.payoutMilli} > price`);
        if (p.cause !== "ABNORMAL_END") assert.equal(p.payoutMilli, p.priceMilli, `${p.key}: ${p.cause}는 100%`);
      }
    }
    for (const r of results) {
      const p = byKey.get(r.key);
      if (r.endReason === "VOID") {
        assert.equal(p, undefined, `${r.key}: VOID에 정산`);
        assert.deepEqual([r.paidMilli, r.overMilli], [0, 0]);
        continue;
      }
      assert.ok(p, `${r.key}: 끝난 곡괭이에 정산이 없다`);
      assert.deepEqual([p.payoutMilli, p.overMilli, p.window], [r.paidMilli, r.overMilli, r.endWindow]);
      const earned = earnedMilli(r);
      if (r.endReason === "DURABILITY") {
        const cap = rewardCapMilli(catalog, r.tier);
        assert.deepEqual([p.kind, p.cause, p.payoutMilli, p.overMilli], ["REWARD", "END", Math.min(earned, cap), earned - Math.min(earned, cap)]);
      } else {
        assert.deepEqual([p.kind, p.cause, p.overMilli], ["REFUND", "ABNORMAL_END", 0]);
      }
    }
    return [rewards, overs, refunds];
  }

  it("fuzzed seeds (with freezes and cancels): one payout per non-VOID pickaxe, REWARD = min(E, 0.9·P) + over = rest, REFUND over 0", () => {
    let rewards = 0;
    let overs = 0;
    let refunds = 0;
    for (let s = 200; s < 224; s++) {
      const seed = seedFrom(s);
      const run = runPlan(catalog, seed, fuzzPlan(catalog, seed, 500, s % 3 === 0), 500);
      const [a, b, c] = checkPayouts(run.payouts, run.results);
      rewards += a; overs += b; refunds += c;
    }
    assert.ok(rewards >= 100, `REWARD 표본 ${rewards}`);
    assert.ok(overs > 0, `over > 0 표본 ${overs}`);
    assert.ok(refunds > 0, `REFUND 표본 ${refunds}`);
  });

  it("busy board (8 wallets × 3,000 windows): every window's payouts keep the invariants, and over happens on a fair share of REWARDs", () => {
    let windows = 0;
    const run = busyBoard(catalog, 41, 3000, 8, (_state, res) => {
      windows += 1;
      for (const p of res.payouts) assert.equal(p.window, res.window);
      for (const r of res.ended) assert.equal(r.endWindow, res.window);
    });
    assert.equal(windows, 3000);
    const [rewards, overs, refunds] = checkPayouts(run.payouts, run.results);
    assert.ok(rewards >= 150, `REWARD 표본 ${rewards}`);
    assert.equal(refunds, 0, "바쁜 판에서도 비정상 종료 없음");
    assert.ok(overs / rewards > 0.1 && overs / rewards < 0.8, `over > 0 비율 ${overs}/${rewards}`);
  });

  it("TIMER and STUCK ends are REFUND = min(P, E + u·P) ≤ price", () => {
    for (const [limits, reason] of [[{ timerTicks: 40 }, "TIMER"], [{ stuckTicks: 3 }, "STUCK"]] as const) {
      const cat: Catalog = { ...catalog, limits: { ...catalog.limits, ...limits } };
      const { state, payouts } = runRoom(cat, 82, 60, (w) => (w === 1 ? [{ type: "purchase", ref: "5", owner: A, tiers: [0, 4, 2] }] : []));
      const ended = state.results.filter((r) => r.endReason === reason);
      assert.ok(ended.length >= 1, `${reason} 종료가 있어야 함 (${state.results.map((r) => r.endReason).join(",")})`);
      for (const r of ended) {
        const p = payouts.find((x) => x.key === r.key)!;
        assert.deepEqual([p.kind, p.cause, p.overMilli, r.overMilli], ["REFUND", "ABNORMAL_END", 0, 0]);
        const unused = Math.floor(((r.durabilityTotal - r.durabilityUsed) * r.priceMilli) / r.durabilityTotal);
        assert.ok(Math.abs(p.payoutMilli - Math.min(r.priceMilli, earnedMilli(r) + unused)) <= 1);
        assert.ok(p.payoutMilli <= r.priceMilli);
      }
    }
  });
});

describe("cancel / overflow / freeze refunds", () => {
  it("cancel → REFUND 100% for a queued item; NOT_QUEUED for live, unknown or someone else's items", () => {
    const state = createRoom(catalog, windowFactory(seedFrom(83), 1, 0), 1, 0);
    runWindow(state, catalog, 1, [{ type: "purchase", ref: "7", owner: A, tiers: [0, 3, 1] }], windowFactory(seedFrom(83), 1, 1));
    const res = runWindow(state, catalog, 2, [
      { type: "cancel", owner: A, itemKey: "7:1" },   // 대기 중 → 환불
      { type: "cancel", owner: A, itemKey: "7:0" },   // 이미 돌고 있음
      { type: "cancel", owner: B, itemKey: "7:2" },   // 남의 것
      { type: "cancel", owner: A, itemKey: "7:1" },   // 이미 취소됨
      { type: "cancel", owner: A, itemKey: "8:0" },   // 없는 구매
    ], windowFactory(seedFrom(83), 1, 2));
    assert.deepEqual(res.payouts.map(row), [["7:1", "REFUND", "CANCEL", price(3), 0]]);
    assert.deepEqual(state.rejected.map((r) => [r.window, r.index, r.reason]), [[2, 1, "NOT_QUEUED"], [2, 2, "NOT_QUEUED"], [2, 3, "NOT_QUEUED"], [2, 4, "NOT_QUEUED"]]);
    assert.deepEqual(state.owners.find((s) => s.owner === A)!.queue.map((q) => q.key), ["7:2"]);
  });

  it("items beyond queueMax → REFUND price (OVERFLOW), in item order", () => {
    const state = createRoom(catalog, windowFactory(seedFrom(84), 1, 0), 1, 0);
    const res = runWindow(state, catalog, 1, [
      { type: "purchase", ref: "1", owner: A, tiers: Array.from({ length: catalog.limits.queueMax - 1 }, () => 0) },
      { type: "purchase", ref: "2", owner: A, tiers: [1, 2, 3] },
    ], windowFactory(seedFrom(84), 1, 1));
    assert.deepEqual(res.payouts.map(row), [["2:1", "REFUND", "OVERFLOW", price(2), 0], ["2:2", "REFUND", "OVERFLOW", price(3), 0]]);
  });

  it("freeze → ABNORMAL_END REFUND for running pickaxes + QUEUE_REFUND for queued items; only bots keep ticking", () => {
    const state = createRoom(catalog, windowFactory(seedFrom(85), 1, 0), 1, 0);
    runWindow(state, catalog, 1, [
      { type: "purchase", ref: "1", owner: A, tiers: [4, 0] },
      { type: "purchase", ref: "2", owner: B, tiers: [3] },
    ], windowFactory(seedFrom(85), 1, 1));
    for (let w = 2; w <= 10; w++) runWindow(state, catalog, w, [], windowFactory(seedFrom(85), 1, w));
    const res = runWindow(state, catalog, 11, [{ type: "freeze", reason: "ROOM_CLOSED" }], windowFactory(seedFrom(85), 1, 11));
    assert.deepEqual(res.payouts.map((p) => [p.key, p.kind, p.cause, p.overMilli]), [["1:0", "REFUND", "ABNORMAL_END", 0], ["2:0", "REFUND", "ABNORMAL_END", 0], ["1:1", "REFUND", "QUEUE_REFUND", 0]]);
    assert.equal(res.payouts[2]!.payoutMilli, price(0));
    for (const p of res.payouts.slice(0, 2)) {
      const r = res.ended.find((x) => x.key === p.key)!;
      assert.equal(r.endReason, "ROOM_CLOSED");
      assert.equal(p.payoutMilli, r.paidMilli);
      assert.ok(p.payoutMilli <= p.priceMilli && p.payoutMilli > 0);
    }
    assert.equal(res.ticksRun, catalog.world.ticksPerWindow);   // D94: no pause rule
    assert.ok(state.pickaxes.every((p) => p.owner === null));
  });
});

describe("voidPurchase", () => {
  it("removes queued + running items of that purchase with no payout (VOID end); ALREADY_VOID on repeat and on a late purchase input", () => {
    const state = createRoom(catalog, windowFactory(seedFrom(86), 1, 0), 1, 0);
    runWindow(state, catalog, 1, [
      { type: "purchase", ref: "77", owner: A, tiers: [0, 1, 2] },
      { type: "purchase", ref: "78", owner: A, tiers: [0] },
    ], windowFactory(seedFrom(86), 1, 1));
    for (let w = 2; w <= 5; w++) runWindow(state, catalog, w, [], windowFactory(seedFrom(86), 1, w));
    const res = runWindow(state, catalog, 6, [{ type: "voidPurchase", ref: "77", owner: A }], windowFactory(seedFrom(86), 1, 6));
    assert.deepEqual(res.voided, [{ ref: "77", owner: A, removedItemKeys: ["77:1", "77:2", "77:0"] }]);
    assert.ok(!res.payouts.some((p) => p.key.startsWith("77:")), "무효 구매는 정산이 없다(체인 refundUnprocessed가 100%)");
    const ended = res.ended.find((r) => r.key === "77:0")!;
    assert.deepEqual([ended.endReason, ended.paidMilli], ["VOID", 0]);
    assert.ok(!state.pickaxes.some((p) => p.key.startsWith("77:")));
    assert.deepEqual(state.owners.find((s) => s.owner === A)!.queue.map((q) => q.key), ["78:0"]);
    assert.deepEqual(state.voidedRefs, ["77"]);

    const again = runWindow(state, catalog, 7, [
      { type: "voidPurchase", ref: "77", owner: A },
      { type: "purchase", ref: "77", owner: A, tiers: [0] },
    ], windowFactory(seedFrom(86), 1, 7));
    assert.deepEqual(again.voided, []);
    assert.deepEqual(state.rejected.map((r) => [r.window, r.index, r.reason]), [[7, 0, "ALREADY_VOID"], [7, 1, "ALREADY_VOID"]]);
    assert.ok(again.spawned.every((s) => s.key === "78:0"), "다음 구매는 무효 다음 윈도에 스폰");
  });
});

describe("world: rooms in roomId order, payouts per room", () => {
  function twoRoomWorld(): World {
    const world: World = { rooms: [] };
    addRoom(world, { roomId: 2, catalog, state: createRoom(catalog, windowFactory(seedFrom(94), 2, 0), 2, 0) });
    addRoom(world, { roomId: 1, catalog, state: createRoom(catalog, windowFactory(seedFrom(94), 1, 0), 1, 0) });
    return world;
  }
  const rng = (w: number) => (roomId: number) => windowFactory(seedFrom(94), roomId, w);

  it("runs rooms ascending by roomId, each with its own inputs and payouts; a later room is skipped until it exists", () => {
    const world = twoRoomWorld();
    assert.deepEqual(world.rooms.map((r) => r.roomId), [1, 2]);
    assert.throws(() => addRoom(world, { roomId: 2, catalog, state: world.rooms[1]!.state }), /exists/);
    const res = runWorldWindow(world, 1, new Map<number, EngineInput[]>([
      [2, [{ type: "purchase", ref: "2", owner: A, tiers: [0, 0] }, { type: "cancel", owner: A, itemKey: "2:1" }]],
      [1, [{ type: "purchase", ref: "1", owner: A, tiers: [0, 1] }, { type: "cancel", owner: A, itemKey: "1:1" }]],
    ]), rng(1));
    assert.deepEqual(res.rooms.map((r) => r.roomId), [1, 2]);
    assert.deepEqual(res.rooms.map((r) => r.result.payouts.map(row)), [[["1:1", "REFUND", "CANCEL", price(1), 0]], [["2:1", "REFUND", "CANCEL", price(0), 0]]]);
    assert.ok(world.rooms.every((r) => r.state.pickaxes.filter((p) => p.owner === A).length === 1), "같은 지갑이 방마다 곡괭이 하나씩");

    // 윈도 5에 만든 방 3: 윈도 2~5에는 건너뛰고 6부터 돈다
    addRoom(world, { roomId: 3, catalog, state: createRoom(catalog, windowFactory(seedFrom(94), 3, 5), 3, 5) });
    for (let w = 2; w <= 5; w++) assert.deepEqual(runWorldWindow(world, w, new Map(), rng(w)).rooms.map((r) => r.roomId), [1, 2]);
    assert.throws(() => runWorldWindow(world, 6, new Map([[4, []]]), rng(6)), /unknown room 4/);
    assert.deepEqual(runWorldWindow(world, 6, new Map(), rng(6)).rooms.map((r) => r.roomId), [1, 2, 3]);
  });
});

describe("determinism of payouts", () => {
  it("two identical runs produce byte-identical payout lists and state hashes", () => {
    const seed = seedFrom(87);
    const plan = fuzzPlan(catalog, seed, 600, true);
    const a = runPlan(catalog, seed, plan, 600);
    const b = runPlan(catalog, seed, plan, 600);
    assert.ok(a.payouts.length > 10, `정산 표본 ${a.payouts.length}`);
    assert.ok(new Set(a.payouts.map((p) => p.cause)).size >= 3, "여러 종류의 정산이 섞여야 의미가 있다");
    assert.equal(JSON.stringify(b.payouts), JSON.stringify(a.payouts));
    assert.equal(b.hash, a.hash);
  });
});

describe("shipped catalogs: on-chain payout caps", () => {
  it("tierRewardCapsMilli is > 0 and ≤ floor(price × 1000 × 0.97) for every tier (one room — normal, D104)", () => {
    for (const name of ["normal"]) {
      const cat = parseCatalog(JSON.parse(readFileSync(fileURLToPath(import.meta.resolve(`@pikit/protocol/catalogs/${name}.json`)), "utf8")));
      const caps = tierRewardCapsMilli(cat);
      assert.equal(caps.length, cat.pickaxes.length);
      caps.forEach((cap, tier) => {
        const limit = Math.floor(cat.pickaxes[tier]!.priceCredits * 1000 * 0.97);
        assert.ok(Number.isSafeInteger(cap) && cap > 0, `${name} tier ${tier}: cap ${cap}`);
        assert.ok(cap <= limit, `${name} tier ${tier}: cap ${cap} > 97% of price ${limit}`);
        assert.equal(cap, rewardCapMilli(cat, tier));
      });
    }
  });
});

describe("board batches: completion record and generator check", () => {
  /** 묶음을 빨리 채우려고 묶음 크기만 줄인 카탈로그(400칸 = 40줄, 구성 비율 그대로 근사 — 규칙 8의 CHOG 두 종류 포함). 첫 30줄로는 묶음이 끝나지 않는다. */
  function smallBatchCatalog(): Catalog {
    const c = structuredClone(catalog);
    const counts = [132, 90, 60, 40, 27, 18, 12, 8, 5, 4, 3, 1];
    c.limits.batchBlocks = 400;
    c.blocks.forEach((b, i) => { b.batchCount = counts[i]!; });
    return c;
  }

  it("each completed batch has 2,000 (here 400) kinds with the exact composition and is reproducible from row windows", () => {
    const small = smallBatchCatalog();
    const seed = seedFrom(95);
    const state = createRoom(small, windowFactory(seed, 1, 0), 1, 0);
    const batches: CompletedBatch[] = [];
    for (let w = 1; w <= 3600; w++) {   // 판은 100윈도에 약 2~3줄 내려간다 → 40줄 묶음 2개
      const inputs: EngineInput[] = w % 5 === 1 ? [{ type: "purchase", ref: String(w), owner: A, tiers: [4, 4] }] : [];
      batches.push(...runWindow(state, small, w, inputs, windowFactory(seed, 1, w)).batches);
    }
    assert.ok(batches.length >= 2, `묶음이 2개 이상 끝나야 함 (${batches.length})`);
    for (const b of batches) {
      assert.equal(b.kinds.length, 400);
      assert.equal(b.rowWindows.length, 40);
      const counts = small.blocks.map((_, k) => b.kinds.filter((x) => x === k).length);
      assert.deepEqual(counts, small.blocks.map((x) => x.batchCount));
      assert.deepEqual(regenerateBatch(small, b.batchIndex, b.rowWindows, (w) => windowFactory(seed, 1, w)), b.kinds);
      assert.notDeepEqual(regenerateBatch(small, b.batchIndex, b.rowWindows, (w) => windowFactory(seedFrom(96), 1, w)), b.kinds);
    }
    assert.deepEqual(batches.map((b) => b.batchIndex), batches.map((_, i) => i));
  });
});

describe("engine version hash (Q5)", () => {
  it("= keccak256(utf8(`<version>+<source hash>`)) and is a 32-byte hex", () => {
    const info = engineBuildInfo();
    assert.match(info.sourceHash, /^0x[0-9a-f]{64}$/);
    assert.equal(engineVersionHash(), `0x${bytesToHex(keccak_256(utf8ToBytes(`${info.version}+${info.sourceHash}`)))}`);
  });
});
