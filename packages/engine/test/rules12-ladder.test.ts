// 규칙 12 개정 2 (명세 25 R9 · §5.3): LUCKY 배수 사다리 — 뽑기 분포·경계·스트림 미사용, 봇·대기열 0, 지급 × m, 천장 가드, 결정론, 직렬화.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { catalogLuckyMultLevels, catalogLuckyShare, luckyCeilingMilliOf, luckyPoolCount, parseCatalog, type Catalog } from "@pikit/protocol";
import {
  applyHitReward, cloneRoom, drawLuckyMultBps, luckyRateMilli, serializeRoom, STATE_ENCODING_TAG,
  type BlockState, type PickaxeState, type Rng,
} from "../src/index.js";
import { busyBoard, createPickaxe, fixedRng, OWNERS, roomHash } from "./helpers.js";

const normalRaw = (): Record<string, any> => JSON.parse(readFileSync(fileURLToPath(new URL("../../../protocol/catalogs/normal.json", import.meta.url)), "utf8")); // eslint-disable-line @typescript-eslint/no-explicit-any
const c = parseCatalog(normalRaw());
const noLadder = (() => { const x = normalRaw(); delete x.lucky.multByKind; return parseCatalog(x); })();

/** next()를 센다 — 사다리 없는 종류는 스트림을 쓰지 않아야 한다. */
function counting(inner: Rng): Rng & { calls: number } {
  const r = { calls: 0, next: () => { r.calls++; return inner.next(); } };
  return r;
}
function player(cat: Catalog, tier: number, kind: number, multBps: number): PickaxeState {
  const t = cat.pickaxes[tier]!;
  return createPickaxe(5, 5, {
    owner: OWNERS[0]!, tier, luckyKind: kind, luckyMultBps: multBps,
    durabilityTotal: t.durability, durabilityLeft: t.durability, attack: t.attack, priceMilli: t.priceCredits * 1000,
  });
}
const block = (cat: Catalog, kind: number, i: number): BlockState => ({ kind, x: i % 10, y: 3 + Math.floor(i / 10), health: cat.blocks[kind]!.hp, quad: 0 });

describe("rules 12 rev2 LUCKY ladder in the engine (spec 25 R9)", () => {
  it("10⁶ draws per ladder group land within ±4σ of per10m", () => {
    const N = 1_000_000;
    for (const kind of [0, 4]) {
      const lv = catalogLuckyMultLevels(c, kind);
      const seen = new Map<number, number>();
      const s = fixedRng(kind + 7);
      for (let i = 0; i < N; i++) { const m = drawLuckyMultBps(c, s, kind); seen.set(m, (seen.get(m) ?? 0) + 1); }
      assert.equal(seen.size, lv.length, `kind ${kind}: only ladder steps`);
      let mean = 0;
      for (const l of lv) {
        const p = l.per10m / 1e7;
        const got = (seen.get(l.multBps) ?? 0) / N;
        const sigma = Math.sqrt((p * (1 - p)) / N);
        assert.ok(Math.abs(got - p) <= 4 * sigma, `kind ${kind} ×${l.multBps / 1e4}: ${got} vs ${p} (σ ${sigma})`);
        mean += got * l.multBps;
      }
      assert.ok(Math.abs(mean / 10000 - 1) < 0.01, `kind ${kind} E[m] ${mean / 10000}`);
    }
  });

  it("each draw consumes exactly one number; no ladder ([] · missing · kind −1) → 10,000 with zero stream use", () => {
    const one = counting(fixedRng(3));
    drawLuckyMultBps(c, one, 0);
    assert.equal(one.calls, 1);
    for (const [cat, kind] of [[c, 7], [c, 10], [c, 11], [c, -1], [noLadder, 0], [noLadder, 4]] as const) {
      const r = counting(fixedRng(5));
      assert.equal(drawLuckyMultBps(cat, r, kind), 10000, `kind ${kind}`);
      assert.equal(r.calls, 0, `kind ${kind} must not touch the stream`);
    }
  });

  it("payout scales with m; at m = 1 the rate is bit-identical to the pre-ladder formula; rate uses the tier's share", () => {
    for (let t = 0; t < c.pickaxes.length; t++) {
      const P = c.pickaxes[t]!;
      for (const k of [0, 4, 9]) {
        const old = (((catalogLuckyShare(c, t) * luckyPoolCount(c)) / c.blocks[k]!.luckyWeight) * P.priceCredits * 1000) / P.durability;
        assert.equal(luckyRateMilli(c, t, k, 10000), old, `tier ${t} kind ${k}`);
        assert.equal(luckyRateMilli(c, t, k, 20000), 2 * old);
      }
      assert.equal(luckyRateMilli(c, t, 10, 50000), 0, "CHOG weight 0");
    }
    assert.ok(Math.abs(luckyRateMilli(c, 1, 0, 10000) / luckyRateMilli(c, 0, 0, 10000) - (0.3 / 0.08) * (c.pickaxes[1]!.priceCredits / c.pickaxes[0]!.priceCredits) * (c.pickaxes[0]!.durability / c.pickaxes[1]!.durability)) < 1e-9);
    // 같은 타격열에서 ×5 곡괭이의 LUCKY = ×1의 5배 (천장 전, 이월 내림 오차 ≤ 1밀리/타)
    const a = player(c, 1, 0, 10000);
    const b = player(c, 1, 0, 50000);
    const atk = c.pickaxes[1]!.attack;
    for (let i = 0; i < 20; i++) {
      applyHitReward(c, a, block(c, 0, i), atk, { window: 1, tick: i }, false);
      applyHitReward(c, b, block(c, 0, i), atk, { window: 1, tick: i }, false);
    }
    assert.ok(a.luckyMilli > 0);
    assert.ok(Math.abs(b.luckyMilli - 5 * a.luckyMilli) <= 5 * 20, `${b.luckyMilli} vs 5 × ${a.luckyMilli}`);
    assert.equal(b.baseMilli, a.baseMilli, "기본 수익은 배수와 무관");
  });

  it("engine guard: hitting the LUCKY kind far past D stops exactly at luckyCeilingMilliOf(tier, kind, m, life)", () => {
    for (let t = 0; t < c.pickaxes.length; t++) {
      for (const [k, m] of [[0, 50000], [4, 20000], [0, 5000]] as const) {
        const p = player(c, t, k, m);
        const atk = c.pickaxes[t]!.attack;
        for (let i = 0, d = 0; d < 3 * p.durabilityTotal; i++, d += atk) applyHitReward(c, p, block(c, k, i), atk, { window: 1, tick: i }, false);
        assert.equal(p.luckyMilli, luckyCeilingMilliOf(c, t, k, m, 1), `tier ${t} kind ${k} m ${m}`);
      }
    }
  });

  it("room: spawned players carry a step of their kind's ladder (10,000 for kinds without one), bots 0, queue items carry none; deterministic", () => {
    const run = () => {
      const spawned: Array<{ luckyKind: number; luckyMultBps: number }> = [];
      let queued = 0;
      const r = busyBoard(c, 7, 2000, 8, (state, res) => {
        spawned.push(...res.spawned);
        for (const s of state.owners) for (const q of s.queue) { queued++; assert.ok(!("luckyMultBps" in q), "대기열에는 배수가 없다"); }
        for (const p of state.pickaxes) if (p.owner === null) assert.equal(p.luckyMultBps, 0, "bot");
      });
      return { r, spawned, queued };
    };
    const { r, spawned } = run();
    assert.ok(spawned.length > 150, `spawned ${spawned.length}`);
    const steps = new Set<number>();
    for (const s of spawned) {
      const lv = catalogLuckyMultLevels(c, s.luckyKind);
      if (lv.length === 0) assert.equal(s.luckyMultBps, 10000);
      else { assert.ok(lv.some((l) => l.multBps === s.luckyMultBps), `kind ${s.luckyKind} m ${s.luckyMultBps}`); steps.add(s.luckyMultBps); }
    }
    assert.ok(steps.size >= 3, `steps seen ${[...steps]}`);
    for (const e of r.results) assert.ok(e.luckyMultBps >= 5000 && e.luckyMultBps <= 50000);
    assert.equal(run().r.hash, r.hash, "같은 시드 = 같은 방");
  });

  it("state v13: luckyMultBps is part of the room hash; serialize is stable across cloneRoom", () => {
    assert.equal(STATE_ENCODING_TAG, "PIKIT/state/v13");
    const { state } = busyBoard(c, 3, 40, 4);
    const players = state.pickaxes.filter((p) => p.owner !== null);
    assert.ok(players.length > 0);
    const h = roomHash(state);
    const copy = cloneRoom(state);
    assert.deepEqual(serializeRoom(copy), serializeRoom(state));
    assert.equal(roomHash(copy), h);
    const target = copy.pickaxes.find((p) => p.owner !== null)!;
    target.luckyMultBps = target.luckyMultBps === 10000 ? 20000 : 10000;
    assert.notEqual(roomHash(copy), h);
  });
});
