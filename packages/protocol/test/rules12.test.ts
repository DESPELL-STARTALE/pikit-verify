// 규칙 12 (명세 25 §3.2·§3.3·§3.4·§4.1·§4.3): LUCKY 가중치 · 아이템 룰렛 확률 · 4칸 · 봇 반발 — 카탈로그 새 칸과 함수, 출시 NORMAL 모양 고정.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import {
  catalogBuffKind, catalogDurabilityMax, catalogItemWins, catalogLuckyCeilingMilli, catalogQuadChanceBps, luckyPoolCount, parseCatalog,
} from "../src/index.js";

type Raw = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
const normalRaw = (): Raw => JSON.parse(readFileSync(new URL("../../catalogs/normal.json", import.meta.url), "utf8")) as Raw;
function rejects(edit: (x: Raw) => void, re: RegExp): void {
  const x = normalRaw();
  edit(x);
  assert.throws(() => parseCatalog(x), re);
}
const TWO53 = 1n << 53n;

describe("rules 12 schema (spec 25)", () => {
  it("the shipped NORMAL is rules 12: luckyWeight 1 × 10 + CHOG 0, items roulette 15 ticks, chance 60/85/100 %, quad only on kind 10, SYSTEM bot bounce 0.5", () => {
    const c = parseCatalog(normalRaw());
    assert.equal(c.rulesVersion, 12);
    assert.deepEqual(c.blocks.map((b) => b.luckyWeight), [...new Array<number>(10).fill(1), 0, 0]);
    assert.equal(c.buffs?.items.maxPerPickaxe, 3);
    assert.equal(c.buffs?.items.rouletteTicks, 15);
    assert.deepEqual(c.buffs?.items.chanceBps, [6000, 6000, 6000, 6000, 6000, 6000, 8500, 8500, 8500, 8500, 10000, 10000]);
    assert.deepEqual(c.buffs?.items.table.map((b) => b.kind), ["GIANT", "DASH", "SPEED", "LIFE"]);
    assert.deepEqual(c.generation.quadChanceBps, [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 2000, 0]);
    assert.deepEqual(c.bots.map((b) => [b.code, b.attack, b.bounce]), [["SYSTEM", 50, 0.5]]);
    const ex = parseCatalog(JSON.parse(readFileSync(new URL("../../catalog.example.json", import.meta.url), "utf8")));
    assert.deepEqual(ex, c, "example = 출시 NORMAL");
  });

  it("§4.1 rejects: luckyWeight, items, quadChanceBps, bot bounce", () => {
    rejects((x) => { x.blocks[0].luckyWeight = 1001; }, /luckyWeight/);
    rejects((x) => { for (const b of x.blocks) b.luckyWeight = 0; }, /lucky: shareByTier > 0 needs Σ blocks\[\]\.luckyWeight > 0/);
    rejects((x) => { delete x.buffs.items.rouletteTicks; }, /rouletteTicks/);
    rejects((x) => { x.buffs.items.rouletteTicks = 0; }, /rouletteTicks/);
    rejects((x) => { x.buffs.items.rouletteTicks = 91; }, /rouletteTicks/);
    rejects((x) => { x.buffs.items.chanceBps[0] = 10001; }, /chanceBps/);
    rejects((x) => { x.buffs.items.chanceBps.pop(); }, /buffs\.items\.chanceBps must have one entry per block kind \(12\)/);
    rejects((x) => { x.buffs.items.table.push({ kind: "GIANT", weight: 1, scaleBps: 15000, ticks: 150 }); }, /buffs\.items\.table\[\]\.kind must be unique/);
    rejects((x) => { x.buffs.lucky = x.buffs.items; delete x.buffs.items; }, /items/);
    rejects((x) => { x.generation.quadChanceBps.pop(); }, /generation\.quadChanceBps must have one entry per block kind \(12\)/);
    rejects((x) => { x.generation.quadChanceBps[9] = 100; }, /generation\.quadChanceBps\[9\] must be 0 \(kind < fixedFromKind\)/);
    rejects((x) => { x.generation.quadChanceBps[10] = 10001; }, /quadChanceBps/);
    // 고정 줄이 촘촘해 r + 1이 다른 고정 줄 — 4칸이 하나라도 켜져 있으면 거부, 모두 0이면 받는다
    const dense = (x: Raw) => { x.blocks[10].batchCount = 20; x.blocks[11].batchCount = 40; x.blocks[0].batchCount -= 43; x.generation.fixedClearKinds = []; };
    rejects(dense, /generation\.quadChanceBps: fixed row \d+ needs row \d+ inside the batch and not fixed/);
    const ok = normalRaw();
    dense(ok);
    ok.generation.quadChanceBps = ok.generation.quadChanceBps.map(() => 0);
    parseCatalog(ok);
    delete ok.generation.quadChanceBps;
    assert.equal(catalogQuadChanceBps(parseCatalog(ok), 10), 0, "quadChanceBps가 없으면 0");
    for (const v of [0, 1.01, -0.5]) rejects((x) => { x.bots[0].bounce = v; }, /bounce/);
    const noBounce = normalRaw();
    delete noBounce.bots[0].bounce;
    assert.equal(parseCatalog(noBounce).bots[0]!.bounce, undefined, "bounce는 optional, zod default 없음");
  });

  it("catalogItemWins: u53 × 10⁴ < bps × 2⁵³ — boundaries at 0, the threshold ± 1, 0 bps and 10000 bps", () => {
    const c = parseCatalog(normalRaw());
    const t60 = (6000n * TWO53 + 9999n) / 10000n; // 처음으로 지는 u53
    assert.equal(catalogItemWins(c, 0, 0n), true);
    assert.equal(catalogItemWins(c, 0, t60 - 1n), true);
    assert.equal(catalogItemWins(c, 0, t60), false);
    assert.equal(catalogItemWins(c, 0, t60 + 1n), false);
    const t85 = (8500n * TWO53 + 9999n) / 10000n;
    assert.equal(catalogItemWins(c, 6, t85 - 1n), true);
    assert.equal(catalogItemWins(c, 6, t85), false);
    assert.equal(catalogItemWins(c, 10, TWO53 - 1n), true, "10000 bps는 언제나");
    const zero = normalRaw();
    zero.buffs.items.chanceBps[0] = 0;
    assert.equal(catalogItemWins(parseCatalog(zero), 0, 0n), false, "0 bps는 절대 안 나온다");
    assert.throws(() => catalogItemWins(c, 12, 0n), /unknown block kind 12/);
    assert.throws(() => catalogItemWins(c, 0, TWO53));
    assert.throws(() => catalogItemWins(c, 0, -1n));
    const none = normalRaw();
    delete none.buffs;
    assert.equal(catalogItemWins(parseCatalog(none), 0, 0n), false, "buffs가 없으면 아이템 없음");
  });

  it("catalogBuffKind reads buffs.items.table", () => {
    const c = parseCatalog(normalRaw());
    assert.equal(catalogBuffKind(c, 0n)?.kind, "GIANT");
    assert.equal(catalogBuffKind(c, TWO53 / 4n)?.kind, "DASH");
    assert.equal(catalogBuffKind(c, TWO53 - 1n)?.kind, "LIFE");
    const empty = normalRaw();
    empty.buffs.items.table = [];
    assert.equal(catalogBuffKind(parseCatalog(empty), 0n), null);
  });

  it("LUCKY pool = Σ luckyWeight; ceiling = share × Σw ÷ min(w > 0) × price × life", () => {
    const c = parseCatalog(normalRaw());
    assert.equal(luckyPoolCount(c), 10);
    for (const p of c.pickaxes) {
      const life = catalogDurabilityMax(c, p.tier) / p.durability;
      // (개정 2) 가장 큰 사다리 칸 ×5 (FE·VD·EM·RS)
      const share = c.lucky.shareByTier[p.tier]!;
      assert.equal(catalogLuckyCeilingMilli(c, p.tier), Math.floor(((share * 10) / 1) * (50000 / 10000) * p.priceCredits * life * 1000), p.code);
    }
    // 가중치가 다르면 가장 가벼운 양수 가중치가 분모
    const w = normalRaw();
    delete w.lucky.multByKind; // 사다리 없음 = ×1 — 분모 규칙만 본다
    w.blocks[0].luckyWeight = 5;
    w.blocks[1].luckyWeight = 2;
    const cw = parseCatalog(w);
    assert.equal(luckyPoolCount(cw), 15);
    const p0 = cw.pickaxes[0]!;
    assert.equal(catalogLuckyCeilingMilli(cw, 0), Math.floor(((0.08 * 15) / 1) * p0.priceCredits * (catalogDurabilityMax(cw, 0) / p0.durability) * 1000));
    for (const b of w.blocks) if (b.luckyWeight === 1) b.luckyWeight = 3;
    const c3 = parseCatalog(w);
    assert.equal(luckyPoolCount(c3), 5 + 2 + 3 * 8);
    assert.equal(catalogLuckyCeilingMilli(c3, 0), Math.floor(((0.08 * 31) / 2) * p0.priceCredits * (catalogDurabilityMax(c3, 0) / p0.durability) * 1000));
    // share = 0이면 빈 풀도 받고 천장 0
    const off = normalRaw();
    off.lucky.shareByTier = off.lucky.shareByTier.map(() => 0);
    delete off.lucky.multByKind;
    for (const b of off.blocks) b.luckyWeight = 0;
    const co = parseCatalog(off);
    assert.equal(luckyPoolCount(co), 0);
    assert.equal(catalogLuckyCeilingMilli(co, 0), 0);
  });

  it("catalogQuadChanceBps reads generation.quadChanceBps", () => {
    const c = parseCatalog(normalRaw());
    assert.deepEqual(c.blocks.map((_, k) => catalogQuadChanceBps(c, k)), [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 2000, 0]);
  });
  it("§3.8 limits.queueGapWindows: shipped 16, integer 0..60, optional (absent = no gap)", () => {
    assert.equal(parseCatalog(normalRaw()).limits.queueGapWindows, 16);
    for (const v of [-1, 61, 1.5, "12"]) rejects((x) => { x.limits.queueGapWindows = v; }, /queueGapWindows/);
    for (const v of [0, 60]) { const x = normalRaw(); x.limits.queueGapWindows = v; assert.equal(parseCatalog(x).limits.queueGapWindows, v); }
    const none = normalRaw();
    delete none.limits.queueGapWindows;
    assert.equal(parseCatalog(none).limits.queueGapWindows, undefined, "optional, zod default 없음");
  });
});
