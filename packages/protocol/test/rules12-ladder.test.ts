// 규칙 12 개정 2 (명세 25 R9 · §5.3): LUCKY shareByTier · 종류별 배수 사다리 multByKind — 카탈로그 검사와 뽑기·천장 함수.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import {
  catalogDurabilityMax, catalogLuckyCeilingMilli, catalogLuckyMultBps, catalogLuckyMultLevels, catalogLuckyShare, catalogOverCapMilli,
  luckyCeilingMilliOf, luckyPoolCount, MAX_LUCKY_MULT_LEVELS, parseCatalog,
} from "../src/index.js";

type Raw = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
const normalRaw = (): Raw => JSON.parse(readFileSync(new URL("../../catalogs/normal.json", import.meta.url), "utf8")) as Raw;
function rejects(edit: (x: Raw) => void, re: RegExp): void {
  const x = normalRaw();
  edit(x);
  assert.throws(() => parseCatalog(x), re);
}
const TWO53 = 1n << 53n;
const DENOM = 10_000_000n;
/** index = ⌊u53 × 10⁷ / 2⁵³⌋ ≥ cum 이 되는 가장 작은 u53 */
const firstU53At = (cum: bigint): bigint => (cum * TWO53 + DENOM - 1n) / DENOM;

describe("rules 12 rev2 LUCKY ladder (spec 25 R9)", () => {
  const c = parseCatalog(normalRaw());

  // 출시 NORMAL은 규칙 13(사다리 kinds 0–9), 규칙 12 표(사다리 kinds 0–6)는 동결 사본 test/fixtures/catalog-rules12.json이 지킨다.
  const rules12 = parseCatalog(JSON.parse(readFileSync(new URL("../../test/fixtures/catalog-rules12.json", import.meta.url), "utf8")));
  for (const [label, cat, version, firstEmpty] of [["shipped NORMAL (rules 13)", c, 13, 10], ["frozen rules-12 NORMAL", rules12, 12, 7]] as const) it(`${label}: shareByTier [0.08, 0.30, 0.08], ladders on kinds 0–${firstEmpty - 1}, [] on ${firstEmpty}–11, every ladder Σ = 10⁷ and E[m] = 1`, () => {
    assert.equal(cat.rulesVersion, version);
    assert.deepEqual(cat.lucky.shareByTier, [0.08, 0.3, 0.08]);
    assert.equal(cat.lucky.multByKind?.length, cat.blocks.length);
    cat.blocks.forEach((_, k) => {
      const lv = catalogLuckyMultLevels(cat, k);
      if (k >= firstEmpty) { assert.deepEqual(lv, [], `kind ${k}`); return; }
      assert.ok(lv.length >= 1 && lv.length <= MAX_LUCKY_MULT_LEVELS);
      assert.equal(lv.reduce((s, l) => s + l.per10m, 0), 10_000_000);
      assert.equal(lv.reduce((s, l) => s + l.per10m * l.multBps, 0), 10_000_000 * 10_000);
    });
    assert.deepEqual(cat.pickaxes.map((_, t) => catalogLuckyShare(cat, t)), [0.08, 0.3, 0.08]);
  });

  it("catalogLuckyMultBps: u53 0 → first step, 2⁵³−1 → top, and the exact cumulative edges switch steps", () => {
    for (let k = 0; k < c.blocks.length; k++) {
      const lv = catalogLuckyMultLevels(c, k);
      if (lv.length === 0) {
        assert.equal(catalogLuckyMultBps(c, k, 0n), 10000);
        assert.equal(catalogLuckyMultBps(c, k, TWO53 - 1n), 10000);
        continue;
      }
      assert.equal(catalogLuckyMultBps(c, k, 0n), lv[0]!.multBps);
      assert.equal(catalogLuckyMultBps(c, k, TWO53 - 1n), lv[lv.length - 1]!.multBps);
      let cum = 0n;
      for (let i = 0; i + 1 < lv.length; i++) {
        cum += BigInt(lv[i]!.per10m);
        const edge = firstU53At(cum);
        assert.equal(catalogLuckyMultBps(c, k, edge - 1n), lv[i]!.multBps, `kind ${k} below edge ${i}`);
        assert.equal(catalogLuckyMultBps(c, k, edge), lv[i + 1]!.multBps, `kind ${k} at edge ${i}`);
      }
    }
    assert.throws(() => catalogLuckyMultBps(c, 0, TWO53));
    assert.throws(() => catalogLuckyMultBps(c, 0, -1n));
  });

  it("multByKind missing or [] means ×1 everywhere (ceiling = share × Σw ÷ w × P × life)", () => {
    const x = normalRaw();
    delete x.lucky.multByKind;
    const m = parseCatalog(x);
    assert.equal(m.lucky.multByKind, undefined);
    for (let k = 0; k < m.blocks.length; k++) {
      assert.deepEqual(catalogLuckyMultLevels(m, k), []);
      assert.equal(catalogLuckyMultBps(m, k, 12345n), 10000);
    }
    const y = normalRaw();
    y.lucky.multByKind = y.blocks.map(() => []);
    const e = parseCatalog(y);
    m.pickaxes.forEach((p, t) => {
      const dMax = catalogDurabilityMax(m, t);
      const life = dMax === p.durability ? 1 : dMax / p.durability;
      const want = Math.floor(((catalogLuckyShare(m, t) * luckyPoolCount(m)) / 1) * 1 * p.priceCredits * life * 1000);
      assert.equal(catalogLuckyCeilingMilli(m, t), want, `tier ${t}`);
      assert.equal(catalogLuckyCeilingMilli(e, t), want, `tier ${t} ([])`);
    });
  });

  it("ceilings use the tier's share and the top step of each kind", () => {
    c.pickaxes.forEach((p, t) => {
      const dMax = catalogDurabilityMax(c, t);
      const life = dMax === p.durability ? 1 : dMax / p.durability;
      let best = 0;
      for (let k = 0; k < c.blocks.length; k++) {
        const lv = catalogLuckyMultLevels(c, k);
        if (c.blocks[k]!.luckyWeight === 0) { assert.equal(luckyCeilingMilliOf(c, t, k, 50000, life), 0); continue; }
        const top = lv.length ? lv[lv.length - 1]!.multBps : 10000;
        best = Math.max(best, luckyCeilingMilliOf(c, t, k, top, life));
      }
      assert.equal(catalogLuckyCeilingMilli(c, t), best);
      assert.equal(best, Math.floor(catalogLuckyShare(c, t) * 10 * 5 * p.priceCredits * life * 1000), `tier ${t}: share × 10 × 5 × P`);
      assert.ok(best <= catalogOverCapMilli(c, t));
    });
    // 같은 가격이면 share 비 = 천장 비 (STEADY 0.30 vs 0.08)
    assert.equal(luckyCeilingMilliOf(c, 1, 0, 10000, 1) / luckyCeilingMilliOf(c, 1, 0, 10000, 1), 1);
    const x = normalRaw();
    x.lucky.shareByTier = [0.3, 0.3, 0.3];
    const s = parseCatalog(x);
    assert.equal(luckyCeilingMilliOf(s, 0, 0, 10000, 1), Math.floor(((0.3 * 10) / 1) * 1 * c.pickaxes[0]!.priceCredits * 1000));
    assert.equal(luckyCeilingMilliOf(c, 0, 0, 10000, 1), Math.floor(((0.08 * 10) / 1) * 1 * c.pickaxes[0]!.priceCredits * 1000));
  });

  it("rejects: shareByTier length / range, multByKind length, Σ per10m, Σ per10m × multBps, ascending, 9 steps, ladder on a weight-0 kind, multBps range, ceiling > over cap, lucky.share gone", () => {
    rejects((x) => { x.lucky.shareByTier.pop(); }, /lucky\.shareByTier must have one entry per pickaxe tier \(3\)/);
    rejects((x) => { x.lucky.shareByTier.push(0.1); }, /lucky\.shareByTier must have one entry per pickaxe tier \(3\)/);
    rejects((x) => { x.lucky.shareByTier[1] = 1.01; }, /shareByTier/);
    rejects((x) => { x.lucky.shareByTier[0] = -0.01; }, /shareByTier/);
    rejects((x) => { x.lucky.share = 0.08; }, /lucky|share/);
    rejects((x) => { x.lucky.multByKind.pop(); }, /lucky\.multByKind must have one entry per block kind \(12\)/);
    rejects((x) => { x.lucky.multByKind[0][0].per10m -= 1; }, /lucky\.multByKind\[0\]: Σ per10m \(9999999\) must be 10000000/);
    rejects((x) => { x.lucky.multByKind[4] = [{ multBps: 5000, per10m: 5_000_000 }, { multBps: 20000, per10m: 5_000_000 }]; }, /lucky\.multByKind\[4\]: Σ per10m × multBps .* must be 100000000000 \(E\[m\] = 1\)/);
    rejects((x) => { x.lucky.multByKind[4] = [{ multBps: 10000, per10m: 7_000_000 }, { multBps: 5000, per10m: 2_000_000 }, { multBps: 20000, per10m: 1_000_000 }]; }, /lucky\.multByKind\[4\]\[1\]\.multBps must be strictly ascending/);
    rejects((x) => { x.lucky.multByKind[4] = [{ multBps: 10000, per10m: 5_000_000 }, { multBps: 10000, per10m: 5_000_000 }]; }, /strictly ascending/);
    rejects((x) => { x.lucky.multByKind[0] = Array.from({ length: 9 }, (_, i) => ({ multBps: 10000 + i, per10m: i === 0 ? 2_000_000 : 1_000_000 })); }, /multByKind/);
    for (const k of [7, 10, 11]) {
      if (k === 7) continue;
      rejects((x) => { x.lucky.multByKind[k] = [{ multBps: 10000, per10m: 10_000_000 }]; }, new RegExp(`lucky\\.multByKind\\[${k}\\] must be \\[\\] \\(luckyWeight 0\\)`));
    }
    rejects((x) => { x.blocks[7].luckyWeight = 0; x.lucky.multByKind[7] = [{ multBps: 10000, per10m: 10_000_000 }]; }, /lucky\.multByKind\[7\] must be \[\] \(luckyWeight 0\)/);
    rejects((x) => { x.lucky.multByKind[0][3].multBps = 1_000_001; }, /multBps/);
    rejects((x) => { x.lucky.multByKind[0][0].multBps = 0; }, /multBps/);
    rejects((x) => { x.lucky.multByKind[0][0].per10m = 0; }, /per10m/);
    rejects((x) => { x.reward.totalCapBps = 100000; }, /lucky: LUCKY ceiling of pickaxes\[1\] exceeds the over cap \(catalogOverCapMilli\)/);
  });

  it("a valid custom ladder with up to 8 steps parses (and a 1-step ×1 ladder equals no ladder)", () => {
    const x = normalRaw();
    x.lucky.multByKind[0] = [
      { multBps: 2500, per10m: 2_000_000 }, { multBps: 5000, per10m: 2_000_000 }, { multBps: 7500, per10m: 2_000_000 }, { multBps: 10000, per10m: 1_000_000 },
      { multBps: 12500, per10m: 1_000_000 }, { multBps: 15000, per10m: 1_000_000 }, { multBps: 20000, per10m: 500_000 }, { multBps: 45000, per10m: 500_000 },
    ];
    const s = x.lucky.multByKind[0].reduce((a: number, l: { multBps: number; per10m: number }) => a + l.multBps * l.per10m, 0);
    assert.equal(s, 10_000_000 * 10_000);
    assert.equal(catalogLuckyMultLevels(parseCatalog(x), 0).length, 8);
    const y = normalRaw();
    y.lucky.multByKind[0] = [{ multBps: 10000, per10m: 10_000_000 }];
    assert.equal(catalogLuckyMultBps(parseCatalog(y), 0, TWO53 - 1n), 10000);
  });
});
