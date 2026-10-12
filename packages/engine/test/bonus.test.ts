import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { parseCatalog, type Catalog } from "@pikit/protocol";
import { applyHitReward, createRoom, runWindow, type BlockState, type PickaxeState } from "../src/index.js";
import { createPickaxe, fuzzPlan, loadCatalog, OWNERS, seedFrom, windowFactory } from "./helpers.js";

// ──────────────────────────────────────────────────────────────────────────
// 보너스 (규칙 7, D137 — 명세 16 §8.2): POP(새 블록 2연속 같은 종류) · BIG POP(3연속), 둘 다 곡괭이당 1번, 합 ≤ bonusCap.
// 규칙 6의 순서 패턴·"연속!" 단계 상금은 지웠다 — 이 파일이 그 시험(bonus-patterns)을 대신한다.
// ──────────────────────────────────────────────────────────────────────────

const catalog = loadCatalog();
const owner = OWNERS[0]!;
const [DIRT, CLAY, STONE, DIAMOND] = [0, 1, 3, 9];

function player(c: Catalog, tier: number): PickaxeState {
  const t = c.pickaxes[tier]!;
  return createPickaxe(5, 5, { owner, tier, durabilityTotal: t.durability, durabilityLeft: t.durability, attack: t.attack });
}

/** 칸 (x, y)에 종류 kind인 블록을 친다 (피해 1). */
function hit(c: Catalog, p: PickaxeState, kind: number, x: number, y = 3): number {
  const b: BlockState = { kind, x, y, health: c.blocks[kind]!.hp };
  return applyHitReward(c, p, b, 1, { window: 7, tick: p.hits++ });
}

const kinds = (p: PickaxeState) => p.bonusEvents.map((e) => [e.kind, e.blockKind, e.streakCount]);

describe("POP and BIG POP", () => {
  it("two new same-kind blocks → POP (streakCount 2); the third → BIG POP (streakCount 3); prizes are the tier's", () => {
    for (let tier = 0; tier < catalog.pickaxes.length; tier++) {
      const t = catalog.pickaxes[tier]!;
      const p = player(catalog, tier);
      hit(catalog, p, STONE, 0);
      assert.equal(p.bonusEvents.length, 0);
      hit(catalog, p, STONE, 1);
      assert.deepEqual(kinds(p), [["POP", STONE, 2]]);
      hit(catalog, p, STONE, 2);
      assert.deepEqual(kinds(p), [["POP", STONE, 2], ["BIG_POP", STONE, 3]]);
      const [pop, big] = p.bonusEvents as [typeof p.bonusEvents[0], typeof p.bonusEvents[0]];
      assert.deepEqual([pop.prizeMilli, pop.paidMilli, pop.window, pop.tick], [t.popPrize * 1000, t.popPrize * 1000, 7, 1]);
      assert.deepEqual([big.prizeMilli, big.paidMilli, big.window, big.tick], [t.bigPopPrize * 1000, t.bigPopPrize * 1000, 7, 2]);
      assert.equal(p.bonusMilli, t.bonusCap * 1000, "POP + BIG POP = bonusCap");
      assert.ok(p.popDone && p.bigDone);
    }
  });

  it("each fires at most once per pickaxe: later runs (even longer ones, other kinds) pay nothing more", () => {
    const p = player(catalog, 0);
    for (let x = 0; x < 6; x++) hit(catalog, p, DIRT, x);
    for (let x = 0; x < 4; x++) hit(catalog, p, CLAY, x, 4);
    for (let x = 0; x < 4; x++) hit(catalog, p, DIAMOND, x, 5);
    assert.deepEqual(kinds(p), [["POP", DIRT, 2], ["BIG_POP", DIRT, 3]]);
    assert.equal(p.streakLen, 4, "연속 수는 계속 센다");
    assert.equal(p.bonusMilli, catalog.pickaxes[0]!.bonusCap * 1000);
  });

  it("a different kind resets the streak: POP on one kind, BIG POP later on a fresh run of three of another kind", () => {
    const p = player(catalog, 2);
    hit(catalog, p, DIRT, 0); hit(catalog, p, DIRT, 1);                     // POP (연속 2)
    hit(catalog, p, CLAY, 2);                                               // 끊김
    hit(catalog, p, STONE, 3); hit(catalog, p, STONE, 4);                   // 연속 2 — POP은 이미 받았다
    assert.deepEqual(kinds(p), [["POP", DIRT, 2]]);
    hit(catalog, p, STONE, 5);                                              // 연속 3 → BIG POP
    assert.deepEqual(kinds(p), [["POP", DIRT, 2], ["BIG_POP", STONE, 3]]);
  });

  it("only consecutive new blocks count: Dirt · Clay · Dirt pays nothing, two more Dirt then pay POP and BIG POP in order", () => {
    const p = player(catalog, 1);
    hit(catalog, p, DIRT, 0); hit(catalog, p, CLAY, 1); hit(catalog, p, DIRT, 2);   // 다른 종류 사이 — 연속 없음
    assert.equal(p.bonusEvents.length, 0);
    hit(catalog, p, DIRT, 3); hit(catalog, p, DIRT, 4);
    assert.deepEqual(kinds(p), [["POP", DIRT, 2], ["BIG_POP", DIRT, 3]]);
  });

  it("re-hitting an already touched block is not a new block: it neither extends nor breaks the streak", () => {
    const p = player(catalog, 4);
    hit(catalog, p, STONE, 0); hit(catalog, p, STONE, 1); hit(catalog, p, STONE, 1); hit(catalog, p, STONE, 0);
    assert.equal(p.streakLen, 2);
    assert.deepEqual(kinds(p), [["POP", STONE, 2]]);
    hit(catalog, p, CLAY, 9, 9);   // 이 칸은 처음이지만…
    hit(catalog, p, CLAY, 9, 9);   // …다시 치면 연속에 넣지 않는다
    assert.equal(p.streakLen, 1);
  });

  it("a tier whose POP / BIG POP prize is 0 has no such event; the other still fires", () => {
    const c = structuredClone(catalog);
    c.pickaxes[0]!.popPrize = 0;
    c.pickaxes[0]!.bonusCap = c.pickaxes[0]!.bigPopPrize;
    const noPop = parseCatalog(c);
    const p = player(noPop, 0);
    for (let x = 0; x < 3; x++) hit(noPop, p, DIRT, x);
    assert.deepEqual(kinds(p), [["BIG_POP", DIRT, 3]]);

    const d = structuredClone(catalog);
    d.pickaxes[0]!.bigPopPrize = 0;
    d.pickaxes[0]!.bonusCap = d.pickaxes[0]!.popPrize;
    const noBig = parseCatalog(d);
    const q = player(noBig, 0);
    for (let x = 0; x < 3; x++) hit(noBig, q, DIRT, x);
    assert.deepEqual(kinds(q), [["POP", DIRT, 2]]);
  });

  it("bonus never exceeds bonusCap (defensive guard): a smaller cap clips BIG POP, the event keeps prize and the actual pay", () => {
    // 스키마는 bonusCap = POP + BIG을 요구한다 — 엔진의 상한 가드만 따로 보려고 parse하지 않은 복제를 쓴다
    const c = structuredClone(catalog);
    const t = c.pickaxes[3]!;
    t.bonusCap = t.popPrize + Math.floor(t.bigPopPrize / 4);
    const p = player(c, 3);
    const credited = [hit(c, p, DIRT, 0), hit(c, p, DIRT, 1), hit(c, p, DIRT, 2)];
    const big = p.bonusEvents[1]!;
    assert.equal(big.prizeMilli, t.bigPopPrize * 1000);
    assert.equal(big.paidMilli, (t.bonusCap - t.popPrize) * 1000);
    assert.equal(p.bonusMilli, t.bonusCap * 1000);
    assert.equal(p.bonusEvents.reduce((s, e) => s + e.paidMilli, 0), p.bonusMilli);
    assert.equal(credited.reduce((s, x) => s + x, 0), p.baseMilli + p.luckyMilli + p.bonusMilli, "반환값 합 = 적립 합");
  });

  it("bots earn no POP", () => {
    const bot = createPickaxe(5, 5, {});
    for (let x = 0; x < 3; x++) applyHitReward(catalog, bot, { kind: DIRT, x, y: 3, health: 100 }, 1);
    assert.deepEqual(bot.bonusEvents, []);
    assert.equal(bot.bonusMilli, 0);
  });
});

describe("room-level bonus accounting", () => {
  it("fuzzed seeds: POP/BIG POP at most once each, Σ event.paid = bonus ≤ bonusCap, events carry streakCount 2/3, window events = pickaxe events", () => {
    let pops = 0;
    let bigs = 0;
    for (let s = 300; s < 310; s++) {
      const seed = seedFrom(s);
      const plan = fuzzPlan(catalog, seed, 400, false);
      const state = createRoom(catalog, windowFactory(seed, 1, 0), 1, 0);
      const fromWindows = new Map<string, number>();
      for (let w = 1; w <= 400; w++) {
        const res = runWindow(state, catalog, w, plan.get(w) ?? [], windowFactory(seed, 1, w));
        for (const e of res.events) {
          assert.equal(e.window, w);
          fromWindows.set(e.key, (fromWindows.get(e.key) ?? 0) + 1);
        }
      }
      for (const r of state.results) {
        const t = catalog.pickaxes[r.tier]!;
        assert.ok(r.bonusMilli <= t.bonusCap * 1000, `${r.key}: bonus ${r.bonusMilli} > cap`);
        assert.equal(r.events.reduce((sum, e) => sum + e.paidMilli, 0), r.bonusMilli, `${r.key}: Σ paid ≠ bonus`);
        const pop = r.events.filter((e) => e.kind === "POP");
        const big = r.events.filter((e) => e.kind === "BIG_POP");
        assert.ok(pop.length <= 1 && big.length <= 1 && r.events.length === pop.length + big.length);
        assert.equal(r.pop, pop.length === 1);
        assert.equal(r.bigPop, big.length === 1);
        for (const e of pop) assert.deepEqual([e.streakCount, e.prizeMilli], [2, t.popPrize * 1000]);
        for (const e of big) assert.deepEqual([e.streakCount, e.prizeMilli], [3, t.bigPopPrize * 1000]);
        for (const e of r.events) assert.ok(e.paidMilli <= e.prizeMilli);
        assert.equal(fromWindows.get(r.key) ?? 0, r.events.length, `${r.key}: 윈도 사건 수 ≠ 곡괭이 사건 수`);
        pops += pop.length;
        bigs += big.length;
      }
    }
    assert.ok(pops > 20 && bigs > 5, `사건 표본이 너무 적음 (POP ${pops}, BIG ${bigs})`);
  });
});
