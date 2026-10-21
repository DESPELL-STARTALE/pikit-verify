// 규칙 10 (명세 23, D246): 카탈로그 새 칸 셋(reward.totalCapBps · luckyPick · jackpot)의 스키마·함수, 피드 새 종류, winOf.
// 숫자는 카탈로그에서 읽는다 — 출시 표 숫자는 protocol.test.ts(키트가 채움)에 있다.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import {
  canonicalHash, type Catalog, catalogCrack, catalogCrackChance, catalogJackpotContributionMilli, catalogJackpotKind, catalogJackpotMinPoolMilli,
  catalogOverCapMilli, catalogPickFloorMilli, catalogPickLevelBps, catalogPickTable, catalogRewardCapMilli, catalogTotalCapMilli,
  FeedEvent, HistoryItem, JackpotView, MeView, parseCatalog, PickaxeLiveState, shortPlayerId, WIN_CAUSE, WIN_FEED_MIN_BPS, winOf,
} from "../src/index.js";

const read = (rel: string) => JSON.parse(readFileSync(new URL(rel, import.meta.url), "utf8")) as Record<string, unknown>;
const rules9Raw = () => read("../../test/fixtures/catalog-rules9.json");
const normalRaw = () => read("../../test/fixtures/catalog-rules10.json"); // 규칙 10 출시 표 사본 (규칙 11부터 normal.json은 규칙 11)
const TWO53 = 1n << 53n;
/** D228 규칙 9 카탈로그 해시 (rules.lock 규칙 9 줄과 같은 값) — 새 칸이 optional이라 그대로여야 한다. */

type Raw = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
const bad = (base: () => Raw, f: (x: Raw) => void, re: RegExp) => {
  const x = structuredClone(base());
  f(x);
  assert.throws(() => parseCatalog(x), re);
};

describe("rules 10 schema (spec 23 §2, plan §2.1)", () => {
  it("a rules-9 catalog (no totalCapBps / luckyPick / jackpot) parses unchanged — no zod defaults, same canonicalHash", () => {
    const raw = rules9Raw();
    const c = parseCatalog(raw);
    assert.equal(c.rulesVersion, 9);
    assert.equal(c.reward.totalCapBps, undefined);
    assert.equal("totalCapBps" in c.reward, false, "default가 없다");
    assert.equal("luckyPick" in c, false);
    assert.equal("jackpot" in c, false);
    assert.equal(canonicalHash(c), canonicalHash(raw));
    // 규칙 9 카탈로그: 새 함수는 모두 "꺼짐"
    assert.equal(catalogPickLevelBps(c, 0n, 0), 0);
    assert.equal(catalogJackpotKind(c), -1);
    assert.equal(catalogJackpotContributionMilli(c, 4), 0);
    assert.equal(catalogJackpotMinPoolMilli(c), 0);
    assert.equal(catalogCrack(c, 0, 10 ** 12, 0n), false);
    assert.equal(catalogCrackChance(c, 0, 10 ** 12), 0);
    assert.deepEqual(catalogPickTable(c, 0), []);
  });

  it("the shipped catalog parses with all three fields and canonicalHash is independent of where they sit", () => {
    const c = parseCatalog(normalRaw());
    assert.ok(c.reward.totalCapBps !== undefined && c.luckyPick && c.jackpot);
    const moved = { ...normalRaw() };
    const { luckyPick, jackpot, ...rest } = moved;
    assert.equal(canonicalHash(parseCatalog({ jackpot, ...rest, luckyPick })), canonicalHash(c));
  });

  it("each field is optional on its own", () => {
    const n = normalRaw() as Raw;
    const { luckyPick: _l, ...noPick } = n;
    parseCatalog(noPick);
    const { jackpot: _j, ...noJackpot } = n;
    parseCatalog(noJackpot);
    const r9 = rules9Raw() as Raw;
    parseCatalog({ ...r9, jackpot: n.jackpot });
    // (규칙 12 개정 2) LUCKY 천장 ≤ over 상한 — 총 상한을 0.9배로 묶으면 LUCKY를 꺼야 한다
    parseCatalog({ ...r9, lucky: { shareByTier: (r9.lucky as { shareByTier: number[] }).shareByTier.map(() => 0) }, reward: { ...r9.reward, totalCapBps: 9000 } });
  });

  it("totalCapBps: integer in [rewardCapBps, 1,000,000]", () => {
    bad(normalRaw, (x) => { x.reward.totalCapBps = 8999; }, /totalCapBps must be ≥ reward\.rewardCapBps/);
    bad(normalRaw, (x) => { x.reward.totalCapBps = 1_000_001; }, /totalCapBps/);
    bad(normalRaw, (x) => { x.reward.totalCapBps = 400000.5; }, /totalCapBps/);
    bad(normalRaw, (x) => { x.reward.totalCapBps = "400000"; }, /totalCapBps/);
    const ok = structuredClone(normalRaw()) as Raw;
    ok.reward.totalCapBps = 1_000_000;
    parseCatalog(ok);
  });

  it("luckyPick: ≤ 16 levels, integer multBps strictly ascending in (10,000, totalCapBps], integer per10m ≥ 1, Σper10m ≤ 10⁷", () => {
    bad(normalRaw, (x) => { x.luckyPick.levels[1].multBps = 11000; }, /strictly ascending/);
    bad(normalRaw, (x) => { x.luckyPick.levels.reverse(); }, /strictly ascending/);
    bad(normalRaw, (x) => { x.luckyPick.levels[0].multBps = 10000; }, /multBps/);
    bad(normalRaw, (x) => { x.luckyPick.levels[0].multBps = 11000.5; }, /multBps/);
    bad(normalRaw, (x) => { x.luckyPick.levels[9].multBps = 400001; }, /must be ≤ reward\.totalCapBps/);
    bad(normalRaw, (x) => { x.luckyPick.levels[0].per10m = 0; }, /per10m/);
    bad(normalRaw, (x) => { x.luckyPick.levels[0].per10m = 1.5; }, /per10m/);
    bad(normalRaw, (x) => { x.luckyPick.levels[0].per10m = 9_000_000; }, /Σ levels\[\]\.per10m/);
    bad(normalRaw, (x) => { x.luckyPick.levels = Array.from({ length: 17 }, (_, i) => ({ multBps: 11000 + i, per10m: 1 })); }, /levels/);
    bad(normalRaw, (x) => { x.luckyPick.levels[0].extra = 1; }, /extra|Unrecognized/);
    bad(normalRaw, (x) => { x.luckyPick.weights = []; }, /weights|Unrecognized/);
    bad(normalRaw, (x) => { delete x.luckyPick.levels; }, /levels/);
    // 규칙 9 상한(총 상한 없음)에서는 바닥이 등급별 총 상한(≈ 11 × 가격)을 넘으면 거부
    bad(() => ({ ...rules9Raw(), luckyPick: { levels: [{ multBps: 400000, per10m: 1 }] } }), () => {}, /exceeds the total cap/);
    parseCatalog({ ...rules9Raw(), luckyPick: { levels: [{ multBps: 20000, per10m: 1 }] } });
    // 정확히 16개, Σ = 10⁷, 빈 배열은 받는다
    const ok = structuredClone(normalRaw()) as Raw;
    ok.luckyPick.levels = Array.from({ length: 16 }, (_, i) => ({ multBps: 11000 + i, per10m: 625_000 }));
    parseCatalog(ok);
    ok.luckyPick.levels = [];
    parseCatalog(ok);
  });

  it("jackpot: kindId is a block id, contributionBpsByTier has one integer 0…1,000 per tier, kappaPpm 0…10⁶, minPoolCredits ≥ 1, κ × max price < minPool × 10⁶", () => {
    bad(normalRaw, (x) => { x.jackpot.kindId = "ruby"; }, /jackpot\.kindId \(ruby\) must be a blocks\[\]\.id/);
    bad(normalRaw, (x) => { x.jackpot.kindId = "Chog_gold"; }, /kindId/);
    bad(normalRaw, (x) => { x.jackpot.contributionBpsByTier = [8, 11, 13, 18]; }, /one entry per pickaxe tier \(5\)/);
    bad(normalRaw, (x) => { x.jackpot.contributionBpsByTier = [8, 11, 13, 18, 28, 30]; }, /one entry per pickaxe tier/);
    bad(normalRaw, (x) => { x.jackpot.contributionBpsByTier = []; }, /contributionBpsByTier/);
    bad(normalRaw, (x) => { x.jackpot.contributionBpsByTier[4] = 1001; }, /contributionBpsByTier/);
    bad(normalRaw, (x) => { x.jackpot.contributionBpsByTier[0] = -1; }, /contributionBpsByTier/);
    bad(normalRaw, (x) => { x.jackpot.contributionBpsByTier[0] = 8.5; }, /contributionBpsByTier/);
    bad(normalRaw, (x) => { delete x.jackpot.contributionBpsByTier; x.jackpot.contributionBps = 25; }, /contributionBps/);
    bad(normalRaw, (x) => { x.jackpot.kappaPpm = 1_000_001; }, /kappaPpm/);
    bad(normalRaw, (x) => { x.jackpot.kappaPpm = -1; }, /kappaPpm/);
    bad(normalRaw, (x) => { x.jackpot.kappaPpm = 5000.5; }, /kappaPpm/);
    bad(normalRaw, (x) => { x.jackpot.minPoolCredits = 0; }, /minPoolCredits/);
    bad(normalRaw, (x) => { x.jackpot.minPoolCredits = 1.5; }, /minPoolCredits/);
    bad(normalRaw, (x) => { x.jackpot.cap = 1; }, /cap|Unrecognized/);
    // κ × 최고가(20,000) < minPool × 10⁶ — 같으면 거부(q가 1이 될 수 있다), 하나 작으면 받는다
    bad(normalRaw, (x) => { x.jackpot.kappaPpm = 50_000; x.jackpot.minPoolCredits = 1000; }, /kappaPpm × max price must be < minPoolCredits × 10⁶/);
    const edge = structuredClone(normalRaw()) as Raw;
    edge.jackpot.kappaPpm = 49_999; edge.jackpot.minPoolCredits = 1000;
    parseCatalog(edge);
    edge.jackpot.kappaPpm = 0;
    parseCatalog(edge);
  });
});

describe("rules 10 caps (spec 23 §3.2)", () => {
  it("catalogOverCapMilli: rules 10 = total cap − REWARD cap; rules 9 catalog = the rules-9 formula (unchanged value)", () => {
    const n = parseCatalog(normalRaw());
    const r9 = parseCatalog(rules9Raw());
    for (const p of n.pickaxes) {
      const price = p.priceCredits * 1000;
      assert.equal(catalogTotalCapMilli(n, p.tier), Math.floor((price * n.reward.totalCapBps!) / 10000));
      assert.equal(catalogOverCapMilli(n, p.tier), catalogTotalCapMilli(n, p.tier) - catalogRewardCapMilli(n, p.tier));
    }
    // 규칙 9 카탈로그 over 상한 — 사본을 규칙 12 luckyWeight 모양으로 옮겨 LUCKY 천장(규칙 12 식)만 바뀐 값
    assert.deepEqual(r9.pickaxes.map((_, t) => catalogOverCapMilli(r9, t)), [2_963_739, 5_514_700, 12_558_745, 23_631_910, 44_707_694]);
    // 같은 규칙 9 카탈로그에 totalCapBps만 넣으면 규칙 10 식
    const withCap = parseCatalog({ ...rules9Raw(), reward: { ...(rules9Raw() as Raw).reward, totalCapBps: 100000 } });
    assert.equal(catalogOverCapMilli(withCap, 0), 10_000_000 - 900_000);
  });
});

describe("LUCKY PICK draw (spec 23 §3.1): index = ⌊u53 × 10⁷ / 2⁵³⌋", () => {
  const c = parseCatalog(normalRaw());
  const levels = c.luckyPick!.levels!;
  /** index i가 되는 가장 작은 u53 = ⌈i × 2⁵³ / 10⁷⌉ */
  const firstU53 = (i: bigint) => (i * TWO53 + 9_999_999n) / 10_000_000n;

  it("u53 = 0 → the first level; cumulative boundaries −1 / +1; after the last level → 0", () => {
    assert.equal(catalogPickLevelBps(c, 0n, 0), levels[0]!.multBps);
    let cum = 0n;
    for (let k = 0; k < levels.length; k++) {
      cum += BigInt(levels[k]!.per10m);
      const next = k + 1 < levels.length ? levels[k + 1]!.multBps : 0;
      const atBoundary = firstU53(cum);
      assert.equal(catalogPickLevelBps(c, atBoundary - 1n, 0), levels[k]!.multBps, `level ${k} last u53`);
      assert.equal(catalogPickLevelBps(c, atBoundary, 0), next, `level ${k + 1} first u53`);
      assert.equal(catalogPickLevelBps(c, atBoundary + 1n, 0), next);
    }
    assert.equal(catalogPickLevelBps(c, TWO53 - 1n, 0), 0, "마지막 u53 → 단계 없음");
  });

  it("empty levels → 0; u53 out of range throws", () => {
    const empty = parseCatalog({ ...normalRaw(), luckyPick: { levels: [] } });
    assert.equal(catalogPickLevelBps(empty, 0n, 0), 0);
    assert.throws(() => catalogPickLevelBps(c, -1n, 0), /u53/);
    assert.throws(() => catalogPickLevelBps(c, TWO53, 0), /u53/);
  });

  it("floor = ⌊price milli × bps / 10⁴⌋; pick table = catalog (oneIn, atLeastPer10m)", () => {
    assert.equal(catalogPickFloorMilli(c, 0, 0), 0);
    assert.equal(catalogPickFloorMilli(c, 0, 11000), 1_100_000);
    assert.equal(catalogPickFloorMilli(c, 4, 400000), 800_000_000);
    assert.throws(() => catalogPickFloorMilli(c, 0, -1));
    assert.throws(() => catalogPickFloorMilli(c, 9, 11000), /unknown tier/);
    const t = catalogPickTable(c, 0);
    assert.deepEqual(t.map((r) => [r.multBps, r.per10m]), levels.map((l) => [l.multBps, l.per10m]));
    assert.deepEqual(t.map((r) => r.oneIn), levels.map((l) => Math.round(1e7 / l.per10m)));
    assert.equal(t[0]!.atLeastPer10m, levels.reduce((s, l) => s + l.per10m, 0));
    assert.equal(t.at(-1)!.atLeastPer10m, levels.at(-1)!.per10m);
    for (let i = 0; i + 1 < t.length; i++) assert.equal(t[i]!.atLeastPer10m - t[i + 1]!.atLeastPer10m, t[i]!.per10m);
  });
});

describe("jackpot (spec 23 §4)", () => {
  const c = parseCatalog(normalRaw());
  const j = c.jackpot!;
  const minPool = catalogJackpotMinPoolMilli(c);

  it("kind, contribution per tier = ⌊price milli × bps / 10⁴⌋, min pool", () => {
    assert.equal(catalogJackpotKind(c), c.blocks.findIndex((b) => b.id === j.kindId));
    assert.equal(c.blocks[catalogJackpotKind(c)]!.id, "chog_gold");
    for (const p of c.pickaxes) assert.equal(catalogJackpotContributionMilli(c, p.tier), Math.floor((p.priceCredits * 1000 * j.contributionBpsByTier[p.tier]!) / 10000));
    assert.throws(() => catalogJackpotContributionMilli(c, 9), /unknown tier/);
    assert.equal(minPool, j.minPoolCredits * 1000);
  });

  it("crack: pool < minPool → false; u53 = 0 → true; boundary u53 = ⌈κ·P·2⁵³ / (pool·10⁶)⌉ − 1 → true, +1 → false; BigInt for a 10¹⁵-milli pool", () => {
    for (const tier of [0, 4]) {
      const price = BigInt(c.pickaxes[tier]!.priceCredits * 1000);
      assert.equal(catalogCrack(c, tier, minPool - 1, 0n), false, "통 미달은 뽑지 않는다");
      for (const pool of [minPool, minPool + 1, 123_456_789, 10 ** 15]) {
        assert.equal(catalogCrack(c, tier, pool, 0n), true, `u53 0, pool ${pool}`);
        const num = BigInt(j.kappaPpm) * price * TWO53;
        const den = BigInt(pool) * 1_000_000n;
        const edge = (num + den - 1n) / den;   // 첫 false
        assert.equal(catalogCrack(c, tier, pool, edge - 1n), true, `tier ${tier} pool ${pool} edge − 1`);
        assert.equal(catalogCrack(c, tier, pool, edge), false, `tier ${tier} pool ${pool} edge`);
        assert.equal(catalogCrack(c, tier, pool, edge + 1n), false);
        assert.equal(catalogCrack(c, tier, pool, TWO53 - 1n), false);
        // 화면용 확률 ≈ 정수 판정의 비율
        const exact = Number(edge) / 2 ** 53;
        assert.ok(Math.abs(catalogCrackChance(c, tier, pool) - exact) <= 2 ** -52 + exact * 1e-12, `chance ${pool}`);
      }
    }
    // 10¹⁵ 밀리 통: u53 × pool × 10⁶ ≈ 2⁵³ × 10²¹ — Number로는 틀린다
    const pool = 10 ** 15;
    assert.ok(Number.MAX_SAFE_INTEGER < 2 ** 53 * pool);
    assert.equal(catalogCrackChance(c, 0, minPool - 1), 0);
    assert.ok(catalogCrackChance(c, 4, minPool) < 1, "κ × 최고가 < minPool → q < 1");
    assert.throws(() => catalogCrack(c, 0, -1, 0n), /poolMilli/);
    assert.throws(() => catalogCrack(c, 0, 1.5, 0n), /poolMilli/);
    assert.throws(() => catalogCrack(c, 0, minPool, TWO53), /u53/);
  });

  it("with kappaPpm 0 nothing ever cracks", () => {
    const off = parseCatalog({ ...normalRaw(), jackpot: { ...j, kappaPpm: 0 } });
    assert.equal(catalogCrack(off, 0, 10 ** 12, 0n), false);
    assert.equal(catalogCrackChance(off, 0, 10 ** 12), 0);
  });
});

describe("feed / views (spec 23 §5)", () => {
  const addr = `0x${"ab".repeat(20)}`;
  const base = { seq: 1, roomId: 1, playerShortId: shortPlayerId(addr), itemKey: "1:0", tier: 0, amountMilli: 0, streakCount: 0, endReason: null, tick: 9, blockNumber: 100 };

  it("WIN_FEED_MIN_BPS = 1.5×; winOf: 1.49× → null, 1.5× → bits", () => {
    assert.equal(WIN_FEED_MIN_BPS, 15_000);
    const r = { priceMilli: 1_000_000, baseMilli: 0, luckyMilli: 0, bonusMilli: 0, lastHitMilli: 0, pickMilli: 0, jackpotMilli: 0, paidMilli: 900_000, overMilli: 0 };
    assert.equal(winOf({ ...r, overMilli: 590_000 }), null, "1.49×");
    assert.equal(winOf({ ...r, overMilli: 599_999 }), null, "1.4999×");
    assert.deepEqual(winOf({ ...r, overMilli: 600_000 }), { multipleBps: 15_000, causes: 0 });
    assert.deepEqual(winOf({ ...r, baseMilli: 1, luckyMilli: 1, bonusMilli: 1, lastHitMilli: 1, pickMilli: 1, jackpotMilli: 1, overMilli: 600_000 }), { multipleBps: 15_000, causes: 63 });
    assert.deepEqual(winOf({ ...r, pickMilli: 1_100_000, overMilli: 1_100_000 }), { multipleBps: 20_000, causes: WIN_CAUSE.PICK });
    assert.deepEqual(winOf({ ...r, jackpotMilli: 10 ** 15, overMilli: 10 ** 15 }), { multipleBps: Number((BigInt(10 ** 15 + 900_000) * 10_000n) / 1_000_000n), causes: WIN_CAUSE.JACKPOT });
    assert.deepEqual(Object.values(WIN_CAUSE), [1, 2, 4, 8, 16, 32]);
    assert.throws(() => winOf({ ...r, priceMilli: 0 }));
  });

  it("FeedEvent: LUCKY_PICK · JACKPOT · WIN with their fields, and only with them", () => {
    FeedEvent.parse({ ...base, kind: "LUCKY_PICK", multBps: 11000 });
    assert.throws(() => FeedEvent.parse({ ...base, kind: "LUCKY_PICK" }), /multBps/);
    assert.throws(() => FeedEvent.parse({ ...base, kind: "LUCKY_PICK", multBps: 10000 }), /> 10,000/);
    assert.throws(() => FeedEvent.parse({ ...base, kind: "LUCKY_PICK", multBps: 11000, causes: 4 }), /causes/);
    const jp = { ...base, kind: "JACKPOT", amountMilli: 40_000_000, poolAfterMilli: 0, cellX: 3, cellY: 30 };
    FeedEvent.parse(jp);
    for (const k of ["poolAfterMilli", "cellX", "cellY"] as const) {
      const { [k]: _d, ...without } = jp;
      assert.throws(() => FeedEvent.parse(without), new RegExp(k));
    }
    assert.throws(() => FeedEvent.parse({ ...jp, multBps: 11000 }), /multBps/);
    assert.throws(() => FeedEvent.parse({ ...jp, cellX: -1 }));
    const win = { ...base, kind: "WIN", amountMilli: 900_000, overMilli: 600_000, endReason: "DURABILITY", multBps: 15_000, causes: 5 };
    FeedEvent.parse(win);
    assert.throws(() => FeedEvent.parse({ ...win, multBps: 14_999 }), /WIN_FEED_MIN_BPS/);
    assert.throws(() => FeedEvent.parse({ ...win, causes: undefined }), /causes/);
    assert.throws(() => FeedEvent.parse({ ...win, causes: 64 }), /causes/);
    assert.throws(() => FeedEvent.parse({ ...win, endReason: null }), /endReason/);
    assert.throws(() => FeedEvent.parse({ ...win, overMilli: undefined }), /overMilli/);
    assert.throws(() => FeedEvent.parse({ ...win, poolAfterMilli: 0 }), /poolAfterMilli/);
    // 옛 종류에는 새 칸이 없다
    assert.throws(() => FeedEvent.parse({ ...base, kind: "POP", streakCount: 2, multBps: 11000 }), /multBps/);
    assert.throws(() => FeedEvent.parse({ ...base, kind: "PICKAXE_END", endReason: "DURABILITY", overMilli: 0, causes: 1 }), /causes/);
    assert.throws(() => FeedEvent.parse({ ...base, kind: "LAST_HIT", cellX: 1 }), /cellX/);
  });

  it("live state, history, /me summary and JackpotView carry pickLevelBps · pickMilli · jackpotMilli", () => {
    const live = {
      itemKey: "1:0", playerShortId: null, tier: 0, x: 1, y: 1, angle: 0, scale: 1, durabilityLeftBps: 10000, earnedMilli: 0, bonusMilli: 0,
      luckyKind: -1, luckyMultBps: 0, streakCount: 0, popTargetKind: -1, pickLevelBps: 20000, jackpotMilli: 0, popStacks: 0, buffMask: 0,
    };
    PickaxeLiveState.parse(live);
    assert.throws(() => PickaxeLiveState.parse({ ...live, pickLevelBps: undefined }), /pickLevelBps/);
    assert.throws(() => PickaxeLiveState.parse({ ...live, jackpotMilli: -1 }), /jackpotMilli/);
    const hist = {
      itemKey: "1:0", owner: addr, roomId: 1, tier: 0, priceCredits: 1000, rulesVersion: 10, status: "ENDED", enqueuedWindow: 1, spawnWindow: 2, spawnTick: 0,
      endWindow: 9, endTick: 70, endReason: "TIMER", hits: 1, distinctBlocks: 1, blocksBroken: 0, durabilityUsed: 1, durabilityTotal: 1108, pop: false, bigPop: false,
      events: [], luckyKind: 2, luckyMultBps: 10000, baseMilli: 1, luckyMilli: 0, bonusMilli: 0, lastHits: 0, lastHitMilli: 0, pickLevelBps: 15000, pickMilli: 1_499_999, jackpotMilli: 0,
      paidMilli: 900_000, overMilli: 600_000, pnlMilli: 500_000, createdAt: "2026-10-19T00:00:00.000Z", spawnedAt: null, endedAt: null, settlement: null,
    };
    HistoryItem.parse(hist);
    assert.throws(() => HistoryItem.parse({ ...hist, pickMilli: undefined }), /pickMilli/);
    const summary = { itemKey: "1:0", roomId: 1, tier: 0, priceMilli: 1_000_000, spawnWindow: 2, earnedMilli: 0, bonusMilli: 0, durabilityLeftBps: 10000, pickLevelBps: 0, jackpotMilli: 0 };
    const me = {
      address: addr, playerShortId: shortPlayerId(addr), nickname: null, balances: { promoMilli: "0", blockNumber: 1 },
      pending: { settlingMilli: 0, activeEarnedMilli: 0 }, activePickaxes: [summary], queues: [], sessionKey: null, nextIntentNonce: "0", batch: null,
    };
    MeView.parse(me);
    assert.throws(() => MeView.parse({ ...me, activePickaxes: [{ ...summary, jackpotMilli: undefined }] }), /jackpotMilli/);
    const view = { poolMilli: 25_000_000, minPoolMilli: 20_000_000, contributedMilli: 65_000_000, paidMilli: 40_000_000, wins: 1 };
    JackpotView.parse(view);
    JackpotView.parse({ ...view, contributionBpsByTier: [8, 11, 13, 18, 28] });
    assert.throws(() => JackpotView.parse({ ...view, wins: -1 }));
    assert.throws(() => JackpotView.parse({ ...view, capMilli: 1 }), /capMilli|Unrecognized/);
  });
});

// 타입만 보는 줄: Catalog의 새 칸은 optional이다
const _typeCheck = (c: Catalog): number => (c.reward.totalCapBps ?? 0) + (c.luckyPick?.levels?.length ?? 0) + (c.jackpot?.contributionBpsByTier[0] ?? 0);
void _typeCheck;
