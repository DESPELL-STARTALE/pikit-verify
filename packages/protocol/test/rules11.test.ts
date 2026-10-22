// 규칙 11 (명세 24): COMBO · 성장 · LUCKY 버프 · 등급별 사다리 · 정수 크레딧 — 카탈로그 새 칸(모두 optional, zod default 없음)과 함수.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import {
  BUFF_MASK, canonicalHash, catalogBaseCeilingMilli, catalogBuffKind, catalogComboPrizeMilli, catalogDurabilityMax, catalogHasCombo,
  catalogLuckyCeilingMilli, catalogPickLevelBps, catalogPickTable, catalogScaleCap, FeedEvent, parseCatalog, PickaxeLiveState, shortPlayerId,
} from "../src/index.js";

type Raw = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
/** 규칙 11 NORMAL을 고쳐서 거부되는지 본다 (re 없으면 zod 기본 오류). */
function rejects(edit: (x: Raw) => void, re?: RegExp): void {
  const x = normalRaw() as Raw;
  edit(x);
  if (re) assert.throws(() => parseCatalog(x), re);
  else assert.throws(() => parseCatalog(x));
}
function accepts(edit: (x: Raw) => void): void {
  const x = normalRaw() as Raw;
  edit(x);
  parseCatalog(x);
}

const read = (rel: string) => JSON.parse(readFileSync(new URL(rel, import.meta.url), "utf8")) as Record<string, unknown>;
const rules10Raw = () => read("../../test/fixtures/catalog-rules10.json");
const normalRaw = () => read("../../catalogs/normal.json");

describe("rules 11 schema (spec 24)", () => {
  it("the rules-10 catalog parses unchanged — no zod defaults, same canonicalHash", () => {
    const raw = rules10Raw();
    const c = parseCatalog(raw);
    assert.equal(c.rulesVersion, 10);
    assert.equal("combo" in c.reward, false);
    assert.equal("wholeCredits" in c.reward, false);
    assert.equal("buffs" in c, false);
    assert.equal("byTier" in c.luckyPick!, false);
    assert.equal(catalogHasCombo(c), false);
    assert.equal(canonicalHash(c), canonicalHash(raw));
  });

  it("the shipped NORMAL (rules 13) keeps the rules-11 numbers: combo [1, 2, 4, 7, 11], whole credits, buffs, SYSTEM bot, 3 tiers", () => {
    const c = parseCatalog(normalRaw());
    assert.equal(c.rulesVersion, 13);
    assert.deepEqual(c.reward.combo, { weights: [1, 2, 4, 7, 11] });
    assert.equal(c.reward.wholeCredits, true);
    assert.equal(catalogHasCombo(c), true);
    assert.deepEqual(c.pickaxes.map((p) => p.popPrize), [77, 178, 330]);
    assert.deepEqual(c.pickaxes.map((p) => p.bigPopPrize), [0, 0, 0]);
    assert.deepEqual(c.pickaxes.map((p) => p.bonusCap), c.pickaxes.map((p) => p.priceCredits * 2));
    assert.equal(c.bots[0]!.code, "SYSTEM");
    assert.equal(c.pickaxes.length, 3);
    assert.ok(c.buffs);
    assert.deepEqual(c.buffs.items.table.map((b) => b.kind), ["GIANT", "DASH", "SPEED", "LIFE"]);
  });

  it("rejects every invalid reward.combo", () => {
    for (const w of [[], [0], [101], [1.5], [-1], [1, 1, 1, 1, 1, 1, 1, 1, 1]]) rejects((x) => { x.reward.combo.weights = w; });
    rejects((x) => { x.reward.combo.weights = [1, 3, 2]; }, /weights\[2\] must be ≥ weights\[1\]/);
    rejects((x) => { x.reward.combo = {}; });
    rejects((x) => { x.reward.combo.extra = 1; });
    rejects((x) => { x.pickaxes[2].bigPopPrize = 1; x.pickaxes[2].bonusCap += 1; }, /pickaxes\[2\]\.bigPopPrize must be 0 when reward\.combo is set/);
    rejects((x) => { x.reward.combo.weights = [100]; }, /bonusCap must be ≥ popPrize × reward\.combo\.weights\[0\]/);
    rejects((x) => { delete x.reward.combo; }, /bonusCap must equal popPrize \+ bigPopPrize/);
    accepts((x) => { x.reward.combo.weights = [1, 1, 100, 100, 100, 100, 100, 100]; });
    accepts((x) => { x.pickaxes[0].bonusCap = x.pickaxes[0].popPrize; });
  });

  it("rejects reward.wholeCredits other than true", () => {
    for (const v of [false, 1, "true", null]) rejects((x) => { x.reward.wholeCredits = v; });
    accepts((x) => { delete x.reward.wholeCredits; });
  });

  it("rejects every invalid buffs block", () => {
    const T = (x: Raw, kind: string) => x.buffs.items.table.find((b: Raw) => b.kind === kind) as Raw;
    rejects((x) => { x.buffs.items.table.push({ kind: "DASH", weight: 1, speed: 0.2 }); }, /buffs\.items\.table\[\]\.kind must be unique/);
    rejects((x) => { x.buffs.items.table[0].kind = "FLY"; });
    rejects((x) => { x.buffs.extra = 1; });
    rejects((x) => { x.buffs.items.extra = 1; });
    rejects((x) => { delete x.buffs.items.table; });
    rejects((x) => { T(x, "DASH").scaleBps = 15000; });                // 다른 종류의 칸은 strict로 거부
    for (const w of [0, -1, 1.5]) rejects((x) => { T(x, "LIFE").weight = w; });
    for (const v of [9999, 30001, 15000.5]) rejects((x) => { T(x, "GIANT").scaleBps = v; });
    for (const v of [0, 601]) rejects((x) => { T(x, "GIANT").ticks = v; });
    for (const v of [0, 0.41, -0.1]) rejects((x) => { T(x, "DASH").speed = v; });
    for (const v of [9999, 30001]) rejects((x) => { T(x, "SPEED").gravityBps = v; });
    for (const v of [0, 601]) rejects((x) => { T(x, "SPEED").ticks = v; });
    for (const v of [-1, 5001]) rejects((x) => { T(x, "LIFE").durabilityBps = v; });
    for (const v of [-1, 5001]) rejects((x) => { x.buffs.growStepBps = v; });
    for (const v of [-1, 9]) rejects((x) => { x.buffs.growMaxStacks = v; });
    for (const v of [9999, 30001]) rejects((x) => { x.buffs.scaleCap.mulBps = v; });
    for (const v of [0, 3.01]) rejects((x) => { x.buffs.scaleCap.tiles = v; });
    for (const v of [-1, 9]) rejects((x) => { x.buffs.items.maxPerPickaxe = v; });
    accepts((x) => { x.buffs.items.table = []; });
    accepts((x) => { x.buffs.items.maxPerPickaxe = 8; x.buffs.growMaxStacks = 8; x.buffs.scaleCap = { mulBps: 30000, tiles: 3 }; });
    accepts((x) => { delete x.buffs; });
  });

  it("rejects every invalid luckyPick.byTier shape", () => {
    // 출시 NORMAL(3등급)은 이미 byTier다
    const toByTier = (x: Raw) => { assert.ok(Array.isArray(x.luckyPick.byTier)); };
    accepts(toByTier);
    accepts((x) => { toByTier(x); x.luckyPick.byTier[1] = []; });
    rejects((x) => { x.luckyPick.levels = structuredClone(x.luckyPick.byTier[0]); }, /exactly one of levels or byTier/);
    rejects((x) => { x.luckyPick = {}; }, /exactly one of levels or byTier/);
    rejects((x) => { toByTier(x); x.luckyPick.byTier.pop(); }, /one entry per pickaxe tier \(3\)/);
    rejects((x) => { toByTier(x); x.luckyPick.byTier.push([]); }, /one entry per pickaxe tier \(3\)/);
    rejects((x) => { toByTier(x); x.luckyPick.byTier[2][0].per10m = 10_000_000; }, /luckyPick\.byTier\[2\]: Σ levels\[\]\.per10m \(\d+\) must be ≤ 10000000/);
    rejects((x) => { toByTier(x); x.luckyPick.byTier[2][1].multBps = x.luckyPick.byTier[2][0].multBps; }, /luckyPick\.byTier\[2\]\[1\]\.multBps must be strictly ascending/);
    rejects((x) => { toByTier(x); x.luckyPick.byTier[2].push({ multBps: x.reward.totalCapBps + 1, per10m: 1 }); }, /luckyPick\.byTier\[2\]\[\d+\]\.multBps must be ≤ reward\.totalCapBps/);
    rejects((x) => { toByTier(x); x.luckyPick.byTier[0][0].multBps = 10000; });
    rejects((x) => { toByTier(x); x.luckyPick.byTier[0][0].per10m = 0; });
    rejects((x) => { toByTier(x); x.luckyPick.byTier[0] = Array.from({ length: 17 }, (_, i) => ({ multBps: 11000 + i, per10m: 1 })); });
    rejects((x) => { toByTier(x); x.luckyPick.byTier[0][0].extra = 1; });
  });

  it("COMBO prize = popPrize × weights[min(s − 2, last)] × 1000 for s = 2…7", () => {
    const c = parseCatalog(normalRaw());
    assert.deepEqual([2, 3, 4, 5, 6, 7].map((s) => catalogComboPrizeMilli(c, 0, s)), [77_000, 154_000, 308_000, 539_000, 847_000, 847_000]);
    assert.equal(catalogComboPrizeMilli(c, 2, 2), 330_000);
    assert.equal(catalogComboPrizeMilli(c, 0, 0), 0);
    assert.equal(catalogComboPrizeMilli(c, 0, 1), 0);
    assert.throws(() => catalogComboPrizeMilli(c, 0, 2.5), /bad streak/);
    assert.throws(() => catalogComboPrizeMilli(c, 3, 2), /unknown tier 3/);
    const r10 = parseCatalog(rules10Raw());
    assert.equal(catalogHasCombo(r10), false);
    assert.equal(catalogComboPrizeMilli(r10, 0, 5), 0);
  });

  it("buff weighting: index = (u53 × Σw) >> 53 picks the first cumulative > index", () => {
    const c = parseCatalog(normalRaw());
    const kind = (u: bigint) => catalogBuffKind(c, u)?.kind;
    const q = 1n << 51n; // Σw = 4 → 칸 경계 = k × 2⁵³ / 4
    assert.equal(kind(0n), "GIANT");
    assert.equal(kind(q - 1n), "GIANT");
    assert.equal(kind(q), "DASH");
    assert.equal(kind(2n * q - 1n), "DASH");
    assert.equal(kind(2n * q), "SPEED");
    assert.equal(kind(3n * q - 1n), "SPEED");
    assert.equal(kind(3n * q), "LIFE");
    assert.equal(kind((1n << 53n) - 1n), "LIFE");
    assert.throws(() => catalogBuffKind(c, 1n << 53n));
    assert.throws(() => catalogBuffKind(c, -1n));
    const raw = normalRaw() as Raw;
    raw.buffs.items.table[0].weight = 3; // Σw = 6, GIANT = [0,3)
    const w = parseCatalog(raw);
    const b = (x: bigint) => ((x << 53n) + 5n) / 6n; // ⌈x × 2⁵³ / 6⌉
    assert.equal(catalogBuffKind(w, b(3n) - 1n)?.kind, "GIANT");
    assert.equal(catalogBuffKind(w, b(3n))?.kind, "DASH");
    assert.equal(catalogBuffKind(parseCatalog(rules10Raw()), 0n), null);
    raw.buffs.items.table = [];
    assert.equal(catalogBuffKind(parseCatalog(raw), 0n), null);
  });

  it("LUCKY PICK byTier: each tier draws on its own ladder, boundaries at ⌈cum × 2⁵³ / 10⁷⌉", () => {
    const raw = normalRaw() as Raw;
    const shared = structuredClone(raw.luckyPick.byTier[0]) as { multBps: number; per10m: number }[];
    raw.luckyPick = { byTier: raw.pickaxes.map(() => structuredClone(shared)) };
    raw.luckyPick.byTier[1] = [{ multBps: 50000, per10m: 5_000_000 }];
    raw.luckyPick.byTier[2] = [];
    const c = parseCatalog(raw);
    const edge = (cum: number) => ((BigInt(cum) << 53n) + 9_999_999n) / 10_000_000n;
    assert.equal(catalogPickLevelBps(c, edge(5_000_000) - 1n, 1), 50000);
    assert.equal(catalogPickLevelBps(c, edge(5_000_000), 1), 0);
    assert.equal(catalogPickLevelBps(c, 0n, 2), 0);
    const first = shared[0]!;
    assert.equal(catalogPickLevelBps(c, edge(first.per10m) - 1n, 0), first.multBps);
    assert.equal(catalogPickLevelBps(c, edge(first.per10m), 0), shared[1]!.multBps);
    assert.equal(catalogPickLevelBps(c, edge(first.per10m) - 1n, 1), 50000);
    assert.deepEqual(catalogPickTable(c, 1), [{ multBps: 50000, per10m: 5_000_000, oneIn: 2, atLeastPer10m: 5_000_000 }]);
    assert.deepEqual(catalogPickTable(c, 2), []);
    assert.equal(catalogPickTable(c, 0).length, shared.length);
    // 출시 NORMAL: 등급마다 자기 사다리 (LUCKY SHOT 5 · STEADY 3 · BIG GAME 7단계)
    const n = parseCatalog(normalRaw());
    assert.deepEqual([0, 1, 2].map((t) => catalogPickTable(n, t).map((l) => l.multBps)), [
      [15000, 20000, 30000, 50000, 100000], [11000, 12000, 15000], [15000, 20000, 30000, 50000, 100000, 200000, 400000],
    ]);
    assert.throws(() => catalogPickLevelBps(n, 1n << 53n, 0));
    // levels 모드: 모든 등급이 같은 사다리
    const lv = normalRaw() as Raw;
    lv.luckyPick = { levels: structuredClone(shared) };
    const l = parseCatalog(lv);
    assert.deepEqual(catalogPickTable(l, 0), catalogPickTable(l, 2));
  });

  it("ceilings and scale cap include LIFE and scaleCap", () => {
    const c = parseCatalog(normalRaw());
    const lifeBps = (normalRaw() as Raw).buffs.items.table.find((b: Raw) => b.kind === "LIFE").durabilityBps;
    assert.equal(lifeBps, 800);
    assert.equal(catalogDurabilityMax(c, 0), 1108 + 3 * Math.floor((1108 * lifeBps) / 10000));
    assert.equal(catalogDurabilityMax(c, 0), 1108 + 3 * 88);
    assert.equal(catalogDurabilityMax(c, 2), 22160 + 3 * Math.floor((22160 * lifeBps) / 10000));
    assert.equal(catalogScaleCap(c, 0), 2);
    assert.equal(catalogScaleCap(c, 2), 3);
    assert.equal(catalogScaleCap(c, 1), 3);
    const raw = normalRaw() as Raw;
    raw.buffs.items.table = raw.buffs.items.table.filter((b: Raw) => b.kind !== "LIFE");
    const noLife = parseCatalog(raw);
    assert.equal(catalogDurabilityMax(noLife, 0), 1108);
    const vMax = Math.max(...c.blocks.map((b) => b.value));
    const p0 = c.pickaxes[0]!;
    assert.equal(catalogBaseCeilingMilli(c, 0), Math.floor(p0.beta * vMax * catalogDurabilityMax(c, 0) * 1000));
    assert.equal(catalogBaseCeilingMilli(noLife, 0), Math.floor(p0.beta * vMax * 1108 * 1000));
    const lifeLucky = catalogLuckyCeilingMilli(c, 0);
    const plainLucky = catalogLuckyCeilingMilli(noLife, 0);
    assert.ok(plainLucky > 0);
    const dMax0 = catalogDurabilityMax(c, 0);
    assert.ok(Math.abs(lifeLucky - (plainLucky * dMax0) / 1108) <= 2, `${lifeLucky} vs ${plainLucky} × ${dMax0}/1108`);
    raw.buffs.items.maxPerPickaxe = 0;
    raw.buffs.items.table.push({ kind: "LIFE", weight: 1, durabilityBps: 5000 });
    assert.equal(catalogDurabilityMax(parseCatalog(raw), 0), 1108);
    delete raw.buffs;
    assert.equal(catalogScaleCap(parseCatalog(raw), 2), 2);
  });

  it("BUFF feed event carries buffKind (and the cell, rules 12) exactly when kind = BUFF; live state bounds popStacks/buffMask", () => {
    const base = { seq: 1, roomId: 1, playerShortId: shortPlayerId(`0x${"ab".repeat(20)}`), itemKey: "1:0", tier: 0, amountMilli: 0, streakCount: 0, endReason: null, tick: 9, blockNumber: 100 };
    const cell = { cellX: 3, cellY: 7 };
    for (const k of ["GIANT", "DASH", "SPEED", "LIFE"]) FeedEvent.parse({ ...base, ...cell, kind: "BUFF", buffKind: k });
    assert.throws(() => FeedEvent.parse({ ...base, ...cell, kind: "BUFF" }), /buffKind is set exactly when kind = BUFF/);
    assert.throws(() => FeedEvent.parse({ ...base, kind: "BUFF", buffKind: "GIANT" }), /cellX is set exactly when kind = JACKPOT or BUFF/);
    assert.throws(() => FeedEvent.parse({ ...base, ...cell, kind: "POP" }), /cellX is set exactly when kind = JACKPOT or BUFF/);
    assert.throws(() => FeedEvent.parse({ ...base, kind: "POP", buffKind: "GIANT" }), /buffKind is set exactly when kind = BUFF/);
    assert.throws(() => FeedEvent.parse({ ...base, ...cell, kind: "BUFF", buffKind: "FLY" }));
    assert.deepEqual(BUFF_MASK, { GIANT: 1, SPEED: 2, LIFE: 4 });
    const live = {
      itemKey: "1:0", playerShortId: null, tier: 0, x: 1, y: 1, angle: 0, scale: 1, durabilityLeftBps: 10000, earnedMilli: 0, bonusMilli: 0,
      luckyKind: -1, luckyMultBps: 0, streakCount: 0, popTargetKind: -1, pickLevelBps: 0, jackpotMilli: 0, popStacks: 8, buffMask: 7,
    };
    PickaxeLiveState.parse(live);
    for (const bad of [{ popStacks: 9 }, { popStacks: -1 }, { buffMask: 8 }, { buffMask: -1 }, { popStacks: undefined }, { buffMask: undefined }]) {
      assert.throws(() => PickaxeLiveState.parse({ ...live, ...bad }), JSON.stringify(bad));
    }
  });
});
