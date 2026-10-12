// 판 생성 (규칙 7, D137 — 명세 16 §7.1): 희귀 종류(Emerald 이상)는 묶음마다 batchCount개의 띠에 하나씩, 흔한 종류는 비복원 추첨.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";
import { bandOf, regenerateBatch } from "../src/index.js";
import { generateRows, loadCatalog } from "./helpers.js";

const catalog = loadCatalog();
const W = catalog.world.width;
const R = catalog.limits.batchBlocks / W;   // 200줄
const { bandedFromKind, bandMargin } = catalog.generation;
const RARE = catalog.blocks.map((_, k) => k).filter((k) => k >= bandedFromKind);
const BATCHES = 12;
const gen = generateRows(catalog, 4242, BATCHES);

/** 종류 k가 놓인 줄 (줄 순서, 같은 줄에 둘이면 두 번). */
function rowsOf(k: number): number[] {
  const out: number[] = [];
  for (let y = 0; y < gen.rows; y++) for (let x = 0; x < W; x++) if (gen.kindAt(y, x) === k) out.push(y);
  return out;
}

describe("banded generation (rules 7)", () => {
  it("shipped catalog: bands from Emerald (6) with a 1-row margin; Emerald · Gold · Netherite · Diamond = 60 · 40 · 26 · 18 per batch", () => {
    assert.deepEqual([bandedFromKind, bandMargin], [6, 1]);
    assert.deepEqual(RARE.map((k) => catalog.blocks[k]!.batchCount), [60, 40, 26, 18]);
  });

  it("bandOf cuts n rows into c bands, the first n mod c bands one row longer, covering [0, n) without gaps", () => {
    assert.deepEqual(bandOf(0, 60, 200), [0, 4]);
    assert.deepEqual(bandOf(19, 60, 200), [76, 80]);
    assert.deepEqual(bandOf(20, 60, 200), [80, 83]);
    assert.deepEqual(bandOf(59, 60, 200), [197, 200]);
    for (const c of [60, 40, 26, 18, 7, 1]) {
      let next = 0;
      for (let i = 0; i < c; i++) {
        const [s, e] = bandOf(i, c, 200);
        assert.equal(s, next);
        assert.ok(e - s === Math.floor(200 / c) || e - s === Math.floor(200 / c) + 1);
        next = e;
      }
      assert.equal(next, 200);
    }
  });

  it("every batch has the exact composition for every kind, and regenerateBatch reproduces it from the row windows", () => {
    assert.equal(gen.batches.length, BATCHES);
    for (const b of gen.batches) {
      assert.equal(b.kinds.length, catalog.limits.batchBlocks);
      const counts = catalog.blocks.map((_, k) => b.kinds.filter((x) => x === k).length);
      assert.deepEqual(counts, catalog.blocks.map((x) => x.batchCount), `batch ${b.batchIndex}`);
      assert.deepEqual(regenerateBatch(catalog, b.batchIndex, b.rowWindows, gen.factoryFor), b.kinds);
      // 다른 스트림이면 다른 판
      assert.notDeepEqual(regenerateBatch(catalog, b.batchIndex, b.rowWindows, (w) => gen.factoryFor(w + 1)), b.kinds);
    }
  });

  it("each rare kind has exactly one block in each band, on an inner row (margin 1)", () => {
    for (const k of RARE) {
      const c = catalog.blocks[k]!.batchCount;
      const ys = rowsOf(k);
      assert.equal(ys.length, c * BATCHES);
      ys.forEach((y, n) => {
        const batch = Math.floor(n / c);
        const [s, e] = bandOf(n % c, c, R);
        const rr = y - batch * R;
        assert.ok(rr >= s + bandMargin && rr < e - bandMargin, `kind ${k} #${n}: 묶음 ${batch} 줄 ${rr} ∉ 띠 안쪽 [${s + bandMargin}, ${e - bandMargin})`);
      });
    }
  });

  it("the same rare kind (Emerald … Diamond) is at least 3 rows apart, across batch boundaries too", () => {
    for (const k of RARE) {
      const ys = rowsOf(k);
      let gap = Infinity;
      for (let i = 1; i < ys.length; i++) gap = Math.min(gap, ys[i]! - ys[i - 1]!);
      assert.ok(gap >= 3, `kind ${k}: 최소 줄 간격 ${gap}`);
    }
  });

  it("any 15-row screen holds at most 3 Diamonds (and Diamonds do appear in pairs/threes, so the bound is tight)", () => {
    const per = new Array<number>(gen.rows).fill(0);
    for (const y of rowsOf(9)) per[y]! += 1;
    let run = 0;
    let max = 0;
    for (let y = 0; y < gen.rows; y++) {
      run += per[y]!;
      if (y >= 15) run -= per[y - 15]!;
      max = Math.max(max, run);
    }
    assert.ok(max <= 3, `15줄 화면 다이아 최대 ${max}`);
    assert.ok(max >= 2);
  });

  it("is deterministic: the same seed gives the same hash twice, a different seed differs, and `node --jitless` gives the same hash", () => {
    assert.equal(generateRows(catalog, 4242, BATCHES).hash, gen.hash);
    assert.notEqual(generateRows(catalog, 4243, BATCHES).hash, gen.hash);
    const script = fileURLToPath(new URL("./fixtures/board-hash.js", import.meta.url));
    type Out = { jitless: boolean; hash: string; batches: number };
    const normal = JSON.parse(execFileSync(process.execPath, [script, "4242", "3"], { encoding: "utf8" })) as Out;
    const jitless = JSON.parse(execFileSync(process.execPath, ["--jitless", script, "4242", "3"], { encoding: "utf8" })) as Out;
    assert.deepEqual([normal.jitless, jitless.jitless, normal.batches], [false, true, 3]);
    assert.equal(jitless.hash, normal.hash);
    assert.equal(normal.hash, generateRows(catalog, 4242, 3).hash);
  });
});
