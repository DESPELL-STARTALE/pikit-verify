import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  catalogBuffKind, catalogComboPrizeMilli, catalogDurabilityMax, catalogLuckyCeilingMilli, catalogPickLevelBps, catalogScaleCap, luckyPoolCount, parseCatalog,
  type BuffKind, type Catalog, type EngineInput,
} from "@pikit/protocol";
import {
  applyHitReward, capsuleBlockContact, cloneRoom, createRoom, drawLuckyBuff, drawPickLevelBps, expireBuffs, getActiveBlockFromRingBuffer, GRAVITY_MUL_ONE_BPS,
  growOnCombo, hitboxPrimitives, PhysicsEngine, physicsFor, runWindow, scaleTargetOf, settleAbnormal, settleNormal, skyGrowScale, streamU53, Xoshiro128ss,
  type BlockState, type EnginePayout, type HitEvent, type PickaxeResult, type PickaxeState, type Rng, type RngFactory, type RoomBonusEvent, type RoomBuffEvent,
  type RoomJackpotEvent, type RoomState, type SpawnRecord,
} from "../src/index.js";
import { createPickaxe, expectedSettlement, fixedRng, loadCatalog, loadRules10Catalog, OWNERS, roomHash, seedFrom, sha256Hex, windowFactory } from "./helpers.js";
import { golden1, golden2, golden3, golden4, golden4Catalog, replayLog, type Log } from "./golden-logs.js";
import { serializeRoomV11 } from "./serialize-v11.js";
import { newSafety, tapTicks, type Safety } from "./tools/balance.js";

// ──────────────────────────────────────────────────────────────────────────
// 규칙 11 (명세 24 §4 · §5.3): COMBO 사다리 · 성장 · LUCKY 버프(GIANT · DASH · SPEED · LIFE) · 몸마다 중력 배수 · 정수 크레딧 정산 · 상태 v12 · 등급별 사다리.
//  - 새 칸이 없는 카탈로그(규칙 10 사본) = 규칙 10 결과 비트까지 (골든 기록 4개의 끝 상태 해시, v11 직렬화)
//  - 단위·방 시험은 출시 카탈로그(catalog.example.json = catalogs/normal.json — 숫자는 WB0가 G1에서 맞추는 잠정값이라 기대값은 카탈로그에서 계산한다)
//  - 바쁜 판(8지갑 × 3,000윈도): 틱마다 박힘 · 관통 0, 커진 몸 겹침 ≤ 0.05, 지름 ≤ 상한, 버프 = 새 LUCKY 칸마다(≤ maxPerPickaxe, 스트림 `buff|<키>|<n>`),
//    같은 타격의 COMBO 성장이 버프 뽑기보다 먼저, 정산은 모두 정수 크레딧(시험 쪽 식 expectedSettlement와 같음)
// ──────────────────────────────────────────────────────────────────────────

const shipped = loadCatalog();
const rules10 = loadRules10Catalog();
const owner = OWNERS[0]!;
const TWO53 = 9007199254740992;

function kindOf(c: Catalog, id: string): number {
  const k = c.blocks.findIndex((b) => b.id === id);
  assert.ok(k >= 0, `block ${id}`);
  return k;
}
const [DIRT, CLAY, STONE] = ["dirt", "clay", "stone"].map((id) => kindOf(shipped, id)) as [number, number, number];

function buffsOf(c: Catalog): NonNullable<Catalog["buffs"]> {
  assert.ok(c.buffs, "catalog.buffs");
  return c.buffs;
}
function specOf<K extends BuffKind>(c: Catalog, kind: K): Extract<NonNullable<Catalog["buffs"]>["lucky"]["table"][number], { kind: K }> {
  const s = buffsOf(c).lucky.table.find((x) => x.kind === kind);
  assert.ok(s, `buff ${kind}`);
  return s as Extract<NonNullable<Catalog["buffs"]>["lucky"]["table"][number], { kind: K }>;
}
/** 그 종류 누적 가중 구간의 가운데 u (u × 2⁵³이 정수 — 실제 스트림의 수와 같은 꼴). */
function slotU(c: Catalog, kind: BuffKind): number {
  const table = buffsOf(c).lucky.table;
  const total = table.reduce((a, x) => a + x.weight, 0);
  let cum = 0;
  for (const x of table) {
    if (x.kind === kind) return Math.floor(((cum + x.weight / 2) / total) * TWO53) / TWO53;
    cum += x.weight;
  }
  throw new Error(`no ${kind}`);
}

/** 하늘(블록 없는 y < 0)에 둔 플레이어 곡괭이 (등급 몸·내구도). */
function player(c: Catalog, tier: number, key = "1:0", x = 5, y = -30): PickaxeState {
  const t = c.pickaxes[tier]!;
  return {
    ...createPickaxe(x, y, { scale: t.scale, attack: t.attack, frictionPerTick: t.frictionPerTick, durabilityTotal: t.durability, durabilityLeft: t.durability, tier, vy: 0 }),
    key, owner, priceMilli: t.priceCredits * 1000,
  };
}
/** 칸 (x, y)의 종류 kind 블록을 친다. */
function hit(c: Catalog, p: PickaxeState, kind: number, x: number, y = 3, damage = 1): number {
  const b: BlockState = { kind, x, y, health: c.blocks[kind]!.hp };
  return applyHitReward(c, p, b, damage, { window: 7, tick: p.hits++ });
}
const steps = (p: PickaxeState) => p.bonusEvents.map((e) => [e.kind, e.blockKind, e.streakCount]);
/** 등급마다 bonusCap = 가격 × 100 (상한이 상금을 자르지 않게). */
function roomyCap(c: Catalog): Catalog {
  const x = structuredClone(c);
  for (const t of x.pickaxes) t.bonusCap = t.priceCredits * 100;
  return x;
}

/** 이름표마다 정해 둔 수를 차례로 돌려주는 가짜 팩토리 — 연 이름표와 이름표마다 뽑은 수를 센다. 정해 두지 않은 이름표는 오류. */
function scripted(values: Record<string, number[]>): { rng: RngFactory; labels: string[]; draws: Map<string, number> } {
  const labels: string[] = [];
  const draws = new Map<string, number>();
  const rng: RngFactory = (label) => {
    labels.push(label);
    const list = values[label];
    if (!list) throw new Error(`unexpected stream ${label}`);
    return {
      next: () => {
        const v = list.shift();
        if (v === undefined) throw new Error(`${label} over-drawn`);
        draws.set(label, (draws.get(label) ?? 0) + 1);
        return v;
      },
    };
  };
  return { rng, labels, draws };
}

// ──────────────────────────────────────────────────────────────────────────
// 1) 규칙 11 칸이 없으면 규칙 10 그대로
// ──────────────────────────────────────────────────────────────────────────

// 규칙 10 골든 기록 4개의 끝 상태 해시 — verifier test/fixtures/golden-{1,2,3,4}.json의 finalStateHash(규칙 10, rulesVersion 10 · e950843에서 읽음).
// verifier 픽스처는 규칙 11 값으로 다시 쓰이므로 여기 손으로 박는다. golden-4는 시험 카탈로그 golden4Catalog(규칙 10 카탈로그 바탕).
const RULES10_FINAL = {
  golden1: "0xfae3675ec278cd2b7108b0d943ae53965800cb9b7c49a8d5c2c131c1e7f1245e",
  golden2: "0x9371e035808d85cd03bec4cbdf964115d7d9d235106663bf169b95eb8a290281",
  golden3: "0x81f5e37745e4db4fa77c4d4a9663777f49ddb17d1628087b1b3f97eb35339e1c",
  golden4: "0x0668df79714e41261695bd596931bce01a256b6e01e28a23dbe1b973142ab451",
} as const;

describe("rules 11 off: a catalog without combo · wholeCredits · buffs · byTier is rules 10 bit for bit", () => {
  it("the four rules-10 golden logs replay to their rules-10 final state hashes (v11 encoding) — no buff, no growth, milli settlements as before", () => {
    const cases: [keyof typeof RULES10_FINAL, Log, Catalog][] = [
      ["golden1", golden1, rules10], ["golden2", golden2, rules10], ["golden3", golden3(1), rules10], ["golden4", golden4, golden4Catalog(rules10)],
    ];
    let fractional = 0;
    for (const [name, log, cat] of cases) {
      let payouts = 0;
      let buffs = 0;
      const state = replayLog(cat, log, (res) => {
        payouts += res.payouts.length;
        buffs += res.buffs.length;
        for (const p of res.payouts) if (p.payoutMilli % 1000 !== 0 || p.overMilli % 1000 !== 0) fractional += 1;
      });
      assert.equal(`0x${sha256Hex(serializeRoomV11(state))}`, RULES10_FINAL[name], name);
      assert.ok(payouts > 0, `${name}: 정산이 있다`);
      assert.equal(buffs, 0, `${name}: buffs가 없으면 버프 사건 없음`);
      for (const p of state.pickaxes) {
        const base = p.owner === null ? cat.bots[p.tier]!.scale : cat.pickaxes[p.tier]!.scale;
        assert.deepEqual([p.popStacks, p.buffCount, p.giantUntil, p.speedUntil, p.gravityMulBps, p.scaleTarget], [0, 0, 0, 0, GRAVITY_MUL_ONE_BPS, base], `${name} ${p.key}`);
      }
    }
    assert.ok(fractional > 0, "규칙 10은 밀리 정산 그대로(내림 없음)");
  });
});

// ──────────────────────────────────────────────────────────────────────────
// 2) COMBO 사다리 (명세 24 §3.5)
// ──────────────────────────────────────────────────────────────────────────

describe("COMBO ladder (spec 24 §3.5): every new same-kind block at s ≥ 2 pays u × weights[min(s − 2, last)]", () => {
  it("s = 2 · 3 · 4 · 5 · 6 · 7 pay u × weights[min(s − 2, last)] (the shipped weights) on every tier — POP at s = 2, BIG_POP from s = 3, streakCount = s, no once-per-pickaxe limit", () => {
    const c = roomyCap(shipped);
    const W = c.reward.combo?.weights ?? [];
    assert.ok(W.length >= 1 && W.every((w, i) => i === 0 || w >= W[i - 1]!), `COMBO weights ${JSON.stringify(W)}`);
    for (let tier = 0; tier < c.pickaxes.length; tier++) {
      const u = c.pickaxes[tier]!.popPrize;
      assert.ok(u > 0 && c.pickaxes[tier]!.bigPopPrize === 0, "combo 카탈로그: 단위 u = popPrize, bigPopPrize 0");
      const p = player(c, tier);
      for (let x = 0; x < 7; x++) hit(c, p, STONE, x);
      assert.deepEqual(steps(p), [2, 3, 4, 5, 6, 7].map((s) => [s === 2 ? "POP" : "BIG_POP", STONE, s]));
      const want = [2, 3, 4, 5, 6, 7].map((s) => u * W[Math.min(s - 2, W.length - 1)]! * 1000);
      assert.deepEqual(p.bonusEvents.map((e) => e.prizeMilli), want);
      assert.deepEqual(p.bonusEvents.map((e) => e.paidMilli), want);
      assert.deepEqual(p.bonusEvents.map((e) => catalogComboPrizeMilli(c, tier, e.streakCount)), want);
      assert.equal(p.bonusMilli, want.reduce((a, x) => a + x, 0));
      assert.ok(p.popDone && p.bigDone);
    }
  });

  it("a new block of another kind restarts the ladder (the next same-kind pair is POP again); re-hitting a touched cell neither extends nor breaks it", () => {
    const c = roomyCap(shipped);
    const p = player(c, 2);
    hit(c, p, DIRT, 0); hit(c, p, DIRT, 1); hit(c, p, DIRT, 2);   // POP(2) · BIG_POP(3)
    hit(c, p, CLAY, 3);                                           // 끊김 (s = 1)
    hit(c, p, CLAY, 4);                                           // POP(2) 다시
    hit(c, p, CLAY, 4); hit(c, p, DIRT, 0);                       // 이미 닿은 칸 — 아무것도 없음
    hit(c, p, CLAY, 5);                                           // BIG_POP(3)
    assert.deepEqual(steps(p), [["POP", DIRT, 2], ["BIG_POP", DIRT, 3], ["POP", CLAY, 2], ["BIG_POP", CLAY, 3]]);
    assert.equal(p.streakLen, 3);
  });

  it("bonusCap clips: the step that crosses the cap pays the rest, later steps keep their prize with paid 0 — Σ paid = bonus = cap", () => {
    const c = shipped;
    const cap = c.pickaxes[0]!.bonusCap * 1000;
    let s = 1;
    let sum = 0;
    while (sum <= cap) { s += 1; sum += catalogComboPrizeMilli(c, 0, s); }   // s에서 상한을 넘는다
    const n = s + 2;                                                        // 그 뒤 두 단계 더 (새 블록 n개 = 단계 n − 1개)
    const p = player(c, 0);
    for (let x = 0; x < n; x++) hit(c, p, STONE, x % 10, 3 + Math.floor(x / 10));
    let room = cap;
    const want = Array.from({ length: n - 1 }, (_, i) => {
      const prize = catalogComboPrizeMilli(c, 0, i + 2);
      const paid = Math.max(0, Math.min(prize, room));
      room -= paid;
      return [prize, paid];
    });
    assert.deepEqual(p.bonusEvents.map((e) => [e.prizeMilli, e.paidMilli]), want);
    assert.equal(p.bonusMilli, cap);
    assert.ok(want.some(([prize, paid]) => paid! < prize!), "상한이 단계를 자른다");
    assert.deepEqual(want.slice(-2).map(([, paid]) => paid), [0, 0]);
  });

  it("a tier whose COMBO unit is 0 has no COMBO event and no money (the streak is still counted)", () => {
    const c = structuredClone(shipped);
    c.pickaxes[1]!.popPrize = 0;
    const p = player(c, 1);
    for (let x = 0; x < 5; x++) hit(c, p, STONE, x);
    assert.deepEqual([p.bonusEvents.length, p.bonusMilli, p.streakLen], [0, 0, 5]);
  });

  it("bots get no COMBO, no growth and no buff (no money, no event, no stream)", () => {
    const p = createPickaxe(5, 5, { tier: 0 });   // 주인 없음 = 봇
    for (let x = 0; x < 4; x++) assert.equal(hit(shipped, p, STONE, x), 0);
    assert.deepEqual([p.bonusEvents.length, p.bonusMilli, p.streakLen], [0, 0, 0]);
    growOnCombo(shipped, p);
    assert.equal(p.popStacks, 0);
    assert.equal(drawLuckyBuff(shipped, p, () => { throw new Error("a bot opened a buff stream"); }, { window: 1, tick: 1 }), null);
    assert.equal(p.buffCount, 0);
  });
});

// ──────────────────────────────────────────────────────────────────────────
// 3) 성장 (명세 24 §3.8-1)
// ──────────────────────────────────────────────────────────────────────────

describe("growth (spec 24 §3.8-1): + growStepBps per COMBO step, ≤ growMaxStacks, capped by catalogScaleCap", () => {
  it("growOnCombo: popStacks 1 … growMaxStacks then stays; size target = min(cap, tier size × (1 + k × step)); GIANT × scaleBps on top, still ≤ cap — the body itself follows in stepScales", () => {
    const c = shipped;
    const b = buffsOf(c);
    const giant = specOf(c, "GIANT");
    for (let tier = 0; tier < c.pickaxes.length; tier++) {
      const base = c.pickaxes[tier]!.scale;
      const cap = catalogScaleCap(c, tier);
      assert.equal(cap, Math.min((base * b.scaleCap.mulBps) / 10000, b.scaleCap.tiles));
      const p = player(c, tier);
      for (let i = 1; i <= b.growMaxStacks + 2; i++) {
        growOnCombo(c, p);
        const k = Math.min(i, b.growMaxStacks);
        assert.equal(p.popStacks, k);
        assert.equal(p.scaleTarget, Math.max(base, Math.min(cap, (base * (10000 + k * b.growStepBps)) / 10000)));
      }
      assert.equal(p.scale, base, "growOnCombo는 목표만 바꾼다");
      p.giantUntil = 100;
      const withGiant = scaleTargetOf(c, p);
      assert.equal(withGiant, Math.max(base, Math.min(cap, (((base * (10000 + b.growMaxStacks * b.growStepBps)) / 10000) * giant.scaleBps) / 10000)));
      assert.ok(withGiant <= cap && withGiant >= base);
    }
  });

  it("the size target never goes below the tier size (a cap under the tier size keeps the tier size)", () => {
    const c = structuredClone(shipped);
    buffsOf(c).scaleCap.tiles = 0.5;
    const p = player(c, 2);
    growOnCombo(c, p);
    p.giantUntil = 10;
    assert.equal(scaleTargetOf(c, p), c.pickaxes[2]!.scale);
    assert.equal(p.scaleTarget, c.pickaxes[2]!.scale);
  });
});

// ──────────────────────────────────────────────────────────────────────────
// 4) LUCKY 버프 (명세 24 §3.8-2) — 단위
// ──────────────────────────────────────────────────────────────────────────

describe("LUCKY buffs (spec 24 §3.8-2): one per new LUCKY cell, kind by weight from `buff|<key>|<n>`", () => {
  it("the first number of `buff|<key>|<n>` picks the kind by cumulative weight; DASH alone draws a second number (angle × 2π); n = buffCount; one stream per buff", () => {
    const c = shipped;
    for (const spec of buffsOf(c).lucky.table) {
      const p = player(c, 0, "77:0");
      const s = scripted({ "buff|77:0|0": [slotU(c, spec.kind), 0.125] });
      const ev = drawLuckyBuff(c, p, s.rng, { window: 9, tick: 40 });
      assert.deepEqual(ev, { key: "77:0", owner, tier: 0, window: 9, tick: 40, kind: spec.kind, n: 0 } satisfies RoomBuffEvent);
      assert.equal(catalogBuffKind(c, BigInt(slotU(c, spec.kind) * TWO53))?.kind, spec.kind);
      assert.deepEqual(s.labels, ["buff|77:0|0"]);
      assert.equal(s.draws.get("buff|77:0|0"), spec.kind === "DASH" ? 2 : 1);
      assert.equal(p.buffCount, 1);
    }
  });

  it("effects on every tier: GIANT → giantUntil = tick + ticks and the GIANT size target · DASH → |v| = speed at angle 2π·u₂ · SPEED → gravity × gravityBps until tick + ticks · LIFE → total and left + ⌊D × bps / 10⁴⌋", () => {
    const c = shipped;
    const [g, d, sp, life] = [specOf(c, "GIANT"), specOf(c, "DASH"), specOf(c, "SPEED"), specOf(c, "LIFE")];
    const at = { window: 3, tick: 500 };
    for (let tier = 0; tier < c.pickaxes.length; tier++) {
      const t = c.pickaxes[tier]!;
      const draw = (kind: BuffKind, p: PickaxeState) => drawLuckyBuff(c, p, scripted({ [`buff|${p.key}|0`]: [slotU(c, kind), 0.125] }).rng, at);

      const pg = player(c, tier);
      draw("GIANT", pg);
      assert.equal(pg.giantUntil, at.tick + g.ticks);
      assert.equal(pg.scaleTarget, Math.max(t.scale, Math.min(catalogScaleCap(c, tier), (t.scale * g.scaleBps) / 10000)));
      assert.equal(pg.scale, t.scale, "지름은 stepScales가 따라간다");

      const pd = player(c, tier);
      pd.vx = 0.2; pd.vy = -0.1;
      draw("DASH", pd);
      // detSinCos 절단 오차 ≤ 7e-12 (trig.ts) — 비트 재현이 목적이고 정확도는 1e-10이면 충분하다
      assert.ok(Math.abs(Math.hypot(pd.vx, pd.vy) - d.speed) < 1e-10, `|v| ${Math.hypot(pd.vx, pd.vy)}`);
      assert.ok(Math.abs(pd.vx - d.speed * Math.SQRT1_2) < 1e-10 && Math.abs(pd.vy - d.speed * Math.SQRT1_2) < 1e-10, "u₂ = 1/8 → θ = π/4");

      const ps = player(c, tier);
      draw("SPEED", ps);
      assert.deepEqual([ps.gravityMulBps, ps.speedUntil], [sp.gravityBps, at.tick + sp.ticks]);

      const pl = player(c, tier);
      pl.durabilityLeft = t.durability - 100;
      draw("LIFE", pl);
      const add = Math.floor((t.durability * life.durabilityBps) / 10000);
      assert.deepEqual([pl.durabilityTotal, pl.durabilityLeft], [t.durability + add, t.durability - 100 + add]);
      // 다른 칸은 그대로
      assert.deepEqual([pl.scaleTarget, pl.gravityMulBps, pl.giantUntil, pl.speedUntil, pl.vx, pl.vy], [t.scale, GRAVITY_MUL_ONE_BPS, 0, 0, 0, 0]);
    }
  });

  it("at most maxPerPickaxe per pickaxe: n = 0, 1, …, then no stream is opened and null comes back; maxPerPickaxe LIFEs = catalogDurabilityMax", () => {
    const c = shipped;
    const max = buffsOf(c).lucky.maxPerPickaxe;
    const p = player(c, 0, "5:1");
    const values: Record<string, number[]> = {};
    for (let n = 0; n < max; n++) values[`buff|5:1|${n}`] = [slotU(c, "LIFE")];
    const s = scripted(values);
    const evs = Array.from({ length: max + 2 }, (_, i) => drawLuckyBuff(c, p, s.rng, { window: 1, tick: i }));
    assert.deepEqual(evs.map((e) => e?.n ?? null), [...Array.from({ length: max }, (_, n) => n), null, null]);
    assert.deepEqual(s.labels, Array.from({ length: max }, (_, n) => `buff|5:1|${n}`));
    assert.equal(p.buffCount, max);
    assert.equal(p.durabilityTotal, catalogDurabilityMax(c, 0));
  });

  it("100,000 draws follow the weights within ±4σ — the shipped table and a skewed 5 : 1 : 3 : 1 table", () => {
    const skew = structuredClone(shipped);
    const w: Record<BuffKind, number> = { GIANT: 5, DASH: 1, SPEED: 3, LIFE: 1 };
    for (const x of buffsOf(skew).lucky.table) x.weight = w[x.kind];
    parseCatalog(skew);
    const N = 100_000;
    for (const c of [shipped, skew]) {
      const table = buffsOf(c).lucky.table;
      const total = table.reduce((a, x) => a + x.weight, 0);
      const counts = new Map<BuffKind, number>();
      const rng = windowFactory(seedFrom(424242), 1, 1);
      for (let i = 0; i < N; i++) {
        const ev = drawLuckyBuff(c, player(c, 0, `${i}:0`), rng, { window: 1, tick: 0 });
        assert.ok(ev);
        counts.set(ev.kind, (counts.get(ev.kind) ?? 0) + 1);
      }
      for (const x of table) {
        const q = x.weight / total;
        const sigma = Math.sqrt(N * q * (1 - q));
        const got = counts.get(x.kind) ?? 0;
        assert.ok(Math.abs(got - N * q) <= 4 * sigma, `${x.kind}: ${got} vs ${N * q} ± ${(4 * sigma).toFixed(0)}`);
      }
    }
  });

  it("GIANT and SPEED end at the end of tick `until` (exactly `ticks` physics ticks after the drawing tick): size target and gravity go back; LIFE and popStacks stay", () => {
    const c = shipped;
    const [g, sp] = [specOf(c, "GIANT"), specOf(c, "SPEED")];
    const state = createRoom(c, windowFactory(seedFrom(2), 1, 0), 1, 0);
    const p = player(c, 1);
    state.pickaxes.push(p);
    growOnCombo(c, p);
    const T = 1000;
    drawLuckyBuff(c, p, scripted({ "buff|1:0|0": [slotU(c, "GIANT")] }).rng, { window: 1, tick: T });
    drawLuckyBuff(c, p, scripted({ "buff|1:0|1": [slotU(c, "SPEED")] }).rng, { window: 1, tick: T });
    drawLuckyBuff(c, p, scripted({ "buff|1:0|2": [slotU(c, "LIFE")] }).rng, { window: 1, tick: T });
    const grown = scaleTargetOf(c, { tier: 1, popStacks: 1, giantUntil: 0 });
    assert.ok(p.scaleTarget > grown, "GIANT 목표가 더 크다");
    const life = p.durabilityTotal;
    for (let t = T; t <= T + Math.max(g.ticks, sp.ticks); t++) {
      expireBuffs(state, c, t);
      assert.equal(p.giantUntil > 0, t < T + g.ticks, `GIANT at tick ${t}`);
      assert.equal(p.gravityMulBps, t < T + sp.ticks ? sp.gravityBps : GRAVITY_MUL_ONE_BPS, `SPEED at tick ${t}`);
    }
    assert.deepEqual([p.giantUntil, p.speedUntil, p.scaleTarget, p.popStacks, p.durabilityTotal], [0, 0, grown, 1, life]);
  });

  it("gravity is per body: × gravityBps (SPEED) scales the free-fall step of that body only — × 1 (10,000) is the untouched rules-10 path (no multiply)", () => {
    for (const shape of ["tier", "circle"] as const) {
      const c = structuredClone(shipped);
      if (shape === "circle") c.pickaxes[0]!.hitbox = { shape: "circle" };
      const physics = physicsFor(c);
      const state = createRoom(c, windowFactory(seedFrom(3), 1, 0), 1, 0);
      const a = player(c, 0, "1:0", 3, -40);
      const b = player(c, 0, "2:0", 7, -40);
      b.gravityMulBps = 16000;
      physics.advancePickaxe(a, state.blocks, c.world.width, fixedRng());
      physics.advancePickaxe(b, state.blocks, c.world.width, fixedRng());
      const g = c.physics.gravity / (c.physics.fps * c.physics.fps);
      assert.equal(a.vy, g * a.frictionPerTick, `${shape}: ×1 = frameGravity 그대로`);
      assert.ok(Math.abs(b.vy - 1.6 * a.vy) <= 1e-12 * a.vy, `${shape}: ×1.6 (${b.vy} vs ${1.6 * a.vy})`);
      assert.equal(b.vx, a.vx);
    }
  });

  it("LIFE raises this pickaxe's LUCKY ceiling by D_total / D: all LIFEs on the rarest kind reach catalogLuckyCeilingMilli (Dmax) exactly; without LIFE it stops at the D ceiling", () => {
    const c = shipped;
    let rare = -1;
    c.blocks.forEach((b, k) => { if (b.luckyEligible && b.batchCount > 0 && (rare < 0 || b.batchCount < c.blocks[rare]!.batchCount)) rare = k; });
    const t = c.pickaxes[0]!;
    const dMax = catalogDurabilityMax(c, 0);
    assert.ok(dMax > t.durability);
    const plain = player(c, 0, "1:0");
    const lifed = player(c, 0, "2:0");
    plain.luckyKind = rare;
    lifed.luckyKind = rare;
    lifed.durabilityTotal = dMax;
    lifed.durabilityLeft = dMax;
    for (let d = 0, i = 0; d < 2 * dMax; d += t.attack, i++) {
      hit(c, plain, rare, i % 10, 3 + Math.floor(i / 10), t.attack);
      hit(c, lifed, rare, i % 10, 3 + Math.floor(i / 10), t.attack);
    }
    const dCeil = Math.floor(((c.lucky.share * luckyPoolCount(c)) / c.blocks[rare]!.batchCount) * t.priceCredits * 1000);
    assert.equal(plain.luckyMilli, dCeil);
    assert.equal(lifed.luckyMilli, catalogLuckyCeilingMilli(c, 0));
    assert.ok(lifed.luckyMilli > plain.luckyMilli);
  });
});

// ──────────────────────────────────────────────────────────────────────────
// 5) 정수 크레딧 정산 (명세 24 §3.10) — 단위
// ──────────────────────────────────────────────────────────────────────────

describe("integer settlement (spec 24 §3.10): T_main and V are floored to whole credits, the remainder is the house's", () => {
  it("normal end: T_main = ⌊min(C, max(X, F)) / 1000⌋ × 1000; pickMilli = max(0, T_main − min(X, C)); the rules-10 catalog keeps milli", () => {
    const c = shipped;
    const p = player(c, 0);
    p.baseMilli = 512_345;
    assert.deepEqual(settleNormal(c, p), { payoutMilli: 512_000, overMilli: 0, pickMilli: 0, totalMilli: 512_000 });
    assert.deepEqual(settleNormal(rules10, p), { payoutMilli: 512_345, overMilli: 0, pickMilli: 0, totalMilli: 512_345 });
    p.pickLevelBps = 15_000;   // 바닥 1.5P (정수) — 보충 = 바닥 − X
    const cap = Math.floor((c.pickaxes[0]!.priceCredits * 1000 * c.reward.rewardCapBps) / 10000);
    assert.deepEqual(settleNormal(c, p), { payoutMilli: cap, overMilli: 1_500_000 - cap, pickMilli: 1_500_000 - 512_345, totalMilli: 1_500_000 });
  });

  it("abnormal end: V = ⌊min(P, X + unused) / 1000⌋ × 1000 (REFUND), and a ladder level still floors T_main", () => {
    const c = shipped;
    const p = player(c, 0);
    p.baseMilli = 12_345;
    p.durabilityLeft = Math.floor(p.durabilityTotal / 2);
    const v = Math.min(p.priceMilli, 12_345 + Math.floor((p.durabilityLeft * p.priceMilli) / p.durabilityTotal));
    assert.ok(v % 1000 !== 0, "내림이 실제로 일어나는 예");
    assert.deepEqual(settleAbnormal(c, p), { kind: "REFUND", payoutMilli: v - (v % 1000), overMilli: 0, pickMilli: 0, totalMilli: v - (v % 1000) });
    p.pickLevelBps = 11_000;
    const s = settleAbnormal(c, p);
    assert.equal(s.kind, "REWARD");
    assert.equal(s.totalMilli % 1000, 0);
    assert.equal(s.payoutMilli % 1000, 0);
  });
});

// ──────────────────────────────────────────────────────────────────────────
// 6) 바쁜 판 (8지갑 · 3,000윈도) — 틱마다 안전 · 버프 배선 · COMBO · 정수 정산
// ──────────────────────────────────────────────────────────────────────────

interface BuffDraw { key: string; n: number; buffCount: number; popStacks: number; steps: number; streak: number }
interface Expected { key: string; n: number; window: number; tick: number }
interface BusyOut {
  state: RoomState;
  safety: Safety;
  spawned: SpawnRecord[];
  buffs: RoomBuffEvent[];
  events: RoomBonusEvent[];
  payouts: EnginePayout[];
  ended: PickaxeResult[];
  jackpots: RoomJackpotEvent[];
  expected: Expected[];        // 타격 목록에서 따로 센 "새 LUCKY 칸" (≤ maxPerPickaxe) — 엔진 장부와 무관하게
  draws: BuffDraw[];           // `buff|…` 스트림을 연 순간의 곡괭이 상태
  grownBodyTicks: number;
  maxEmbedGrown: number;       // 커진 몸(지름 > 등급 지름) 조각과 살아 있는 블록의 가장 깊은 겹침 (틱 끝)
  maxScale: number[];          // 등급별 최대 지름
  problems: string[];          // 틱 끝 불변식 위반
}

/** 몸 조각과 살아 있는 블록의 가장 깊은 겹침. */
function embedDepth(physics: PhysicsEngine, c: Catalog, p: PickaxeState, blocks: RoomState["blocks"]): number {
  let worst = 0;
  for (const prim of hitboxPrimitives(physics.hitboxFor(p), p)) {
    const sx = Math.max(0, Math.floor(Math.min(prim.ax, prim.bx) - prim.r));
    const ex = Math.min(c.world.width - 1, Math.floor(Math.max(prim.ax, prim.bx) + prim.r));
    const sy = Math.floor(Math.min(prim.ay, prim.by) - prim.r);
    const ey = Math.floor(Math.max(prim.ay, prim.by) + prim.r);
    for (let y = sy; y <= ey; y++) for (let x = sx; x <= ex; x++) {
      const block = getActiveBlockFromRingBuffer(blocks, c.world.width, x, y);
      const contact = block ? capsuleBlockContact(prim, block) : null;
      if (contact && contact.depth > worst) worst = contact.depth;
    }
  }
  return worst;
}

/**
 * helpers.busyBoard와 같은 구매 계획(지갑 n개, 앞 곡괭이가 끝나면 바로 1개, 등급 = (ref + i) mod 등급 수)을 돌리며 본다:
 *  - 틱 끝(tapTicks): 박힘·관통(balance 도구와 같은 정의), 지름 ≤ max(상한, 하늘 효과), 크기 목표 ∈ [등급 지름, 상한], popStacks = min(상한, COMBO 단계),
 *    커진 몸 겹침, 끝난 SPEED는 중력 ×1, 잭팟 contributed = pool + paid
 *  - advancePickaxe 감싸기: 플레이어 곡괭이가 처음 친 칸 중 내 LUCKY 종류인 것(곡괭이당 maxPerPickaxe개까지) = 기대 버프
 *  - 스트림 팩토리 감싸기: `buff|<키>|<n>`을 여는 순간 n = buffCount, popStacks(같은 타격 COMBO 성장이 먼저 됐나)
 */
function runBusy(c: Catalog, seedNo: number, windows: number, wallets = 8): BusyOut {
  const seed = seedFrom(seedNo);
  const W = c.world.width;
  const b = c.buffs;
  const physics = physicsFor(c);
  const state = createRoom(c, windowFactory(seed, 1, 0), 1, 0);
  const out: BusyOut = {
    state, safety: newSafety(), spawned: [], buffs: [], events: [], payouts: [], ended: [], jackpots: [], expected: [], draws: [],
    grownBodyTicks: 0, maxEmbedGrown: 0, maxScale: c.pickaxes.map(() => 0), problems: [],
  };
  const comboEvents = c.reward.combo !== undefined && c.pickaxes.every((t) => t.popPrize > 0);   // 그러면 COMBO 단계 수 = 사건 수
  const note = (msg: string) => { if (out.problems.length < 20) out.problems.push(msg); };

  const seen = new Map<string, Set<number>>();
  const luckyNew = new Map<string, number>();
  const advance = PhysicsEngine.prototype.advancePickaxe;
  PhysicsEngine.prototype.advancePickaxe = function (this: PhysicsEngine, p: PickaxeState, blocks: BlockState[], width: number, rng: Rng): HitEvent[] {
    const hits = advance.call(this, p, blocks, width, rng);
    if (p.owner !== null && b) {
      let cells = seen.get(p.key);
      if (!cells) { cells = new Set(); seen.set(p.key, cells); }
      for (const h of hits) {
        const cell = h.block.y * W + h.block.x;
        if (cells.has(cell)) continue;
        cells.add(cell);
        if (h.block.kind !== p.luckyKind) continue;
        const k = luckyNew.get(p.key) ?? 0;
        luckyNew.set(p.key, k + 1);
        if (k < b.lucky.maxPerPickaxe) out.expected.push({ key: p.key, n: k, window: state.window, tick: state.tick });
      }
    }
    return hits;
  };

  const onTickEnd = (s: RoomState) => {
    for (const p of s.pickaxes) {
      if (p.owner === null) {
        if (p.scale !== c.bots[p.tier]!.scale || p.popStacks !== 0 || p.buffCount !== 0) note(`bot ${p.key} changed`);
        continue;
      }
      const base = c.pickaxes[p.tier]!.scale;
      const cap = catalogScaleCap(c, p.tier);
      const boosted = s.sky.boosts.some((x) => x.key === p.key);
      const allowed = Math.max(cap, boosted ? skyGrowScale(c.skyEvent, base) : 0);
      if (p.scale > allowed + 1e-9) note(`${p.key} scale ${p.scale} > ${allowed}`);
      if (p.scaleTarget > cap + 1e-12 || p.scaleTarget < base) note(`${p.key} target ${p.scaleTarget} ∉ [${base}, ${cap}]`);
      if (b && comboEvents && p.popStacks !== Math.min(b.growMaxStacks, p.bonusEvents.length)) note(`${p.key} popStacks ${p.popStacks} vs ${p.bonusEvents.length} steps`);
      if (b && p.buffCount > b.lucky.maxPerPickaxe) note(`${p.key} buffCount ${p.buffCount}`);
      if (p.speedUntil === 0 && p.gravityMulBps !== GRAVITY_MUL_ONE_BPS) note(`${p.key} gravity ${p.gravityMulBps} after SPEED`);
      if (p.giantUntil === 0 && p.scaleTarget !== scaleTargetOf(c, p)) note(`${p.key} target not reset after GIANT`);
      if (p.scale > base + 1e-12) {
        out.grownBodyTicks += 1;
        out.maxEmbedGrown = Math.max(out.maxEmbedGrown, embedDepth(physics, c, p, s.blocks));
      }
      out.maxScale[p.tier] = Math.max(out.maxScale[p.tier]!, p.scale);
    }
    if (s.jackpot.contributedMilli !== s.jackpot.poolMilli + s.jackpot.paidMilli) note(`jackpot ${JSON.stringify(s.jackpot)}`);
  };
  const tapped = tapTicks(c, state, out.safety, onTickEnd);
  const owners = Array.from({ length: wallets }, (_, i) => `0x${String(i + 1).repeat(40).slice(0, 40)}`);
  let ref = 1;
  try {
    for (let w = 1; w <= windows; w++) {
      const inputs: EngineInput[] = [];
      owners.forEach((o, i) => {
        const slot = state.owners.find((x) => x.owner === o);
        if (!slot || (slot.activeKey === null && slot.queue.length === 0)) inputs.push({ type: "purchase", ref: String(ref++), owner: o, tiers: [(ref + i) % c.pickaxes.length] });
      });
      const base = windowFactory(seed, 1, w);
      const rng: RngFactory = (label) => {
        if (label.startsWith("buff|")) {
          const [, key, n] = label.split("|") as [string, string, string];
          const p = state.pickaxes.find((q) => q.key === key);
          if (!p) note(`buff stream for ${key} not on the board`);
          else out.draws.push({ key, n: Number(n), buffCount: p.buffCount, popStacks: p.popStacks, steps: p.bonusEvents.length, streak: p.streakLen });
        }
        return base(label);
      };
      const res = runWindow(state, tapped, w, inputs, rng);
      out.spawned.push(...res.spawned);
      out.buffs.push(...res.buffs);
      out.events.push(...res.events);
      out.payouts.push(...res.payouts);
      out.ended.push(...res.ended);
      out.jackpots.push(...res.jackpots);
    }
  } finally {
    PhysicsEngine.prototype.advancePickaxe = advance;
  }
  return out;
}

const memo = new Map<string, BusyOut>();
function busy(c: Catalog, name: string, seedNo: number, windows: number): BusyOut {
  const k = `${name}|${seedNo}|${windows}`;
  let r = memo.get(k);
  if (!r) { r = runBusy(c, seedNo, windows); memo.set(k, r); }
  return r;
}

/** 성장·GIANT 스트레스 카탈로그: 한 단계 +50 %, 8단계, 상한 ×3·3칸, 곡괭이당 버프 8개, GIANT(×2, 600틱) 가중이 크고 DASH 0.40 · SPEED ×3 — 큰 몸이 가장 많이 생기는 쪽. */
function stressCatalog(): Catalog {
  const c = structuredClone(shipped);
  const b = buffsOf(c);
  b.growStepBps = 5000;
  b.growMaxStacks = 8;
  b.scaleCap = { mulBps: 30000, tiles: 3 };
  b.lucky.maxPerPickaxe = 8;
  for (const x of b.lucky.table) {
    if (x.kind === "GIANT") { x.weight = 6; x.scaleBps = 20000; x.ticks = 600; }
    if (x.kind === "DASH") { x.weight = 2; x.speed = 0.4; }
    if (x.kind === "SPEED") { x.weight = 2; x.gravityBps = 30000; x.ticks = 600; }
  }
  return parseCatalog(c);
}

describe("rules 11 room: the 8-wallet busy board (seed 99 × 3,000 windows) on the shipped catalog", () => {
  const run = () => busy(shipped, "shipped", 99, 3000);

  it("physics safety per tick: no throw, embedded 0, tunnelled 0; grown bodies overlap blocks ≤ 0.05; size ≤ max(catalogScaleCap, sky 2.5); size targets in [tier size, cap]", () => {
    const r = run();
    assert.deepEqual(r.problems, []);
    assert.equal(r.safety.embedded, 0, "박힘");
    assert.equal(r.safety.tunnelled, 0, "관통");
    assert.ok(r.safety.bodyTicks > 100_000, `몸-틱 ${r.safety.bodyTicks}`);
    assert.ok(r.grownBodyTicks > 10_000, `커진 몸-틱 ${r.grownBodyTicks}`);
    assert.ok(r.maxEmbedGrown <= 0.05, `커진 몸 겹침 최대 ${r.maxEmbedGrown}`);
    r.maxScale.forEach((s, t) => assert.ok(s > c0(t), `등급 ${t}가 실제로 커진다 (${s})`));
  });

  it("buffs are wired as specified: exactly one per new LUCKY cell (the n-th one → n, ≤ maxPerPickaxe), drawn on that tick; kind = first number of `buff|<key>|<n>`; COMBO growth of the same hit comes first", () => {
    const r = run();
    const max = buffsOf(shipped).lucky.maxPerPickaxe;
    assert.deepEqual(r.buffs.map((e) => ({ key: e.key, n: e.n, window: e.window, tick: e.tick })), r.expected);
    assert.ok(r.buffs.length > 200, `버프 ${r.buffs.length}`);
    const spawnedBy = new Map(r.spawned.map((s) => [s.key, s]));
    const kinds = new Map<BuffKind, number>();
    for (const e of r.buffs) {
      const sp = spawnedBy.get(e.key);
      assert.ok(sp && sp.owner === e.owner && sp.tier === e.tier, `${e.key}: 판에 나온 플레이어 곡괭이`);
      assert.ok(e.n < max);
      const want = catalogBuffKind(shipped, streamU53(windowFactory(seedFrom(99), 1, e.window)(`buff|${e.key}|${e.n}`)));
      assert.equal(e.kind, want?.kind, `${e.key} #${e.n}`);
      kinds.set(e.kind, (kinds.get(e.kind) ?? 0) + 1);
    }
    for (const x of buffsOf(shipped).lucky.table) assert.ok((kinds.get(x.kind) ?? 0) > 20, `${x.kind} ${kinds.get(x.kind)}`);
    // 스트림을 연 순간: n = buffCount, 같은 타격의 COMBO 성장은 이미 됐다 (popStacks = min(상한, 단계))
    assert.equal(r.draws.length, r.buffs.length);
    const growMax = buffsOf(shipped).growMaxStacks;
    for (const d of r.draws) {
      assert.equal(d.n, d.buffCount, d.key);
      assert.equal(d.popStacks, Math.min(growMax, d.steps), `${d.key}: COMBO 먼저`);
    }
    assert.ok(r.draws.filter((d) => d.streak >= 2 && d.steps <= growMax).length > 10, "COMBO 단계이면서 새 LUCKY 칸인 타격이 있다(순서 시험이 이빨이 있다)");
  });

  it("COMBO in the room: steps POP (s = 2) / BIG_POP (s ≥ 3) with the ladder prize, Σ paid = bonus ≤ bonusCap, window events = pickaxe events; POP more than once per pickaxe happens", () => {
    const r = run();
    for (const e of r.events) {
      assert.ok(e.streakCount >= 2);
      assert.equal(e.kind, e.streakCount === 2 ? "POP" : "BIG_POP");
      assert.equal(e.prizeMilli, catalogComboPrizeMilli(shipped, e.tier, e.streakCount));
    }
    const byKey = new Map<string, number>();
    for (const e of r.events) byKey.set(e.key, (byKey.get(e.key) ?? 0) + 1);
    let multiPop = 0;
    let longest = 0;
    for (const res of r.ended) {
      const paid = res.events.reduce((a, e) => a + e.paidMilli, 0);
      assert.equal(paid, res.bonusMilli, res.key);
      assert.ok(res.bonusMilli <= shipped.pickaxes[res.tier]!.bonusCap * 1000);
      assert.equal(res.events.length, byKey.get(res.key) ?? 0, `${res.key}: 윈도 사건 = 곡괭이 사건`);
      if (res.events.filter((e) => e.kind === "POP").length >= 2) multiPop += 1;
      for (const e of res.events) longest = Math.max(longest, e.streakCount);
    }
    assert.ok(r.ended.length > 200, `끝난 곡괭이 ${r.ended.length}`);
    assert.ok(multiPop > 10, `POP 2번 이상 ${multiPop}`);
    assert.ok(longest >= 4, `최장 연속 ${longest}`);
  });

  it("integer settlement: every payout and over is whole credits and equals the test-side formula (expectedSettlement); flooring really happens", () => {
    const r = run();
    for (const p of r.payouts) assert.ok(p.payoutMilli % 1000 === 0 && p.overMilli % 1000 === 0, `${p.key} ${p.payoutMilli}/${p.overMilli}`);
    let floored = 0;
    for (const res of r.ended) {
      const want = expectedSettlement(shipped, res);
      assert.deepEqual([res.paidMilli, res.overMilli, res.pickMilli], [want.payoutMilli, want.overMilli, want.pickMilli], res.key);
      if ((res.baseMilli + res.luckyMilli + res.bonusMilli + res.lastHitMilli) % 1000 !== 0) floored += 1;
    }
    assert.ok(floored > 100, `내림 ${floored}`);
  });

  it("determinism: the same seed gives the same buffs and final hash, another seed differs (400 windows)", () => {
    const a = runBusy(shipped, 7, 400);
    const b = runBusy(shipped, 7, 400);
    const other = runBusy(shipped, 8, 400);
    assert.ok(a.buffs.length > 0);
    assert.deepEqual(a.buffs, b.buffs);
    assert.equal(roomHash(a.state), roomHash(b.state));
    assert.notDeepEqual(a.buffs, other.buffs);
    assert.notEqual(roomHash(a.state), roomHash(other.state));
  });

  // (규칙 11, 키트가 채움) 출시 카탈로그 바쁜 판(시드 99 · 3,000 윈도 · 지갑 8 — runBusy = helpers.busyBoard 구매 계획): 끝 해시(v12) · LUCKY PICK 단계 ·
  // 잭팟 통 · 버프 종류별 수 · COMBO 단계 수(RoomBonusEvent). _analysis/rules11/kit/fill-tests.mjs가 채운다.
  it("(rules 11) busy board on the shipped catalog (seed 99, 3000 windows, 8 wallets): final hash (v12), LUCKY PICK levels, jackpot pool, buffs per kind and COMBO steps are pinned", () => {
    const r = busy(shipped, "shipped", 99, 3000);
    assert.deepEqual(r.problems, []);
    const levels = new Map<number, number>();
    for (const sp of r.spawned) if (sp.pickLevelBps > 0) levels.set(sp.pickLevelBps, (levels.get(sp.pickLevelBps) ?? 0) + 1);
    const kinds = new Map<string, number>();
    for (const e of r.buffs) kinds.set(e.kind, (kinds.get(e.kind) ?? 0) + 1);
    assert.equal(roomHash(r.state), "fea3d68d5af05cfc89c527dc1724aa711c71c94bd71b5b11b8edc0fbb6ac3c4e");
    assert.deepEqual(Object.fromEntries([...levels].sort((a, b) => a[0] - b[0])), { 11000: 2, 12000: 3, 15000: 7, 20000: 6, 30000: 4, 50000: 2 });
    assert.deepEqual(r.state.jackpot, { poolMilli: 4_254_700, contributedMilli: 4_254_700, paidMilli: 0, wins: 0 });
    assert.deepEqual(Object.fromEntries(kinds), { DASH: 125, SPEED: 144, GIANT: 136, LIFE: 125 });
    assert.equal(r.events.length, 626);
  });
});

function c0(tier: number): number {
  return shipped.pickaxes[tier]!.scale;
}

describe("rules 11 room: stress catalog (growth + 50 % × 8, GIANT × 2 for 600 ticks, cap 3 tiles) — the safe-grow path under the most big bodies", () => {
  it("8 wallets × 1,500 windows: no throw, embedded 0, tunnelled 0, grown bodies overlap ≤ 0.05, size ≤ cap, buffs = new LUCKY cells", () => {
    const c = stressCatalog();
    const r = runBusy(c, 5, 1500);
    assert.deepEqual(r.problems, []);
    assert.equal(r.safety.embedded, 0, "박힘");
    assert.equal(r.safety.tunnelled, 0, "관통");
    assert.ok(r.maxEmbedGrown <= 0.05, `커진 몸 겹침 최대 ${r.maxEmbedGrown}`);
    assert.deepEqual(r.buffs.map((e) => ({ key: e.key, n: e.n, window: e.window, tick: e.tick })), r.expected);
    assert.ok(r.maxScale.some((s, t) => s >= catalogScaleCap(c, t) - 1e-9), `상한까지 커진 등급이 있다 (${r.maxScale.join(", ")})`);
  });
});

// ──────────────────────────────────────────────────────────────────────────
// 7) 정수 잭팟 (명세 24 §3.10): J = ⌊통 / 1000⌋ × 1000, 나머지는 통에
// ──────────────────────────────────────────────────────────────────────────

describe("integer jackpot (spec 24 §3.10): J is whole credits, the remainder stays in the pool", () => {
  /** 균열이 잦은 시험 카탈로그: 기여 777 bps(가격의 7.77 % — 밀리 나머지가 생긴다), κ 400,000 ppm, minPool 10,000 크레딧(κ × 최고가 < minPool × 10⁶). */
  function crackCatalog(): Catalog {
    const c = structuredClone(shipped);
    c.jackpot = { kindId: "chog_gold", contributionBpsByTier: c.pickaxes.map(() => 777), kappaPpm: 400_000, minPoolCredits: 10_000 };
    return parseCatalog(c);
  }

  it("busy board with frequent cracks: every crack pays whole credits (≥ 1), leaves < 1 credit in the pool, contributed = pool + paid every tick; every settlement (winners too) is whole and matches expectedSettlement", () => {
    const c = crackCatalog();
    const r = runBusy(c, 21, 3000);
    assert.deepEqual(r.problems, []);
    let remainders = 0;
    for (const j of r.jackpots) {
      assert.ok(j.amountMilli >= 1000 && j.amountMilli % 1000 === 0, `J ${j.amountMilli}`);
      assert.ok(j.poolAfterMilli >= 0 && j.poolAfterMilli < 1000, `남은 통 ${j.poolAfterMilli}`);
      if (j.poolAfterMilli > 0) remainders += 1;
    }
    assert.ok(r.jackpots.length >= 3, `균열 ${r.jackpots.length}`);
    assert.ok(remainders >= 1, "나머지가 통에 남는 균열이 있다");
    for (const p of r.payouts) assert.ok(p.payoutMilli % 1000 === 0 && p.overMilli % 1000 === 0, `${p.key} ${p.payoutMilli}/${p.overMilli}`);
    const winners = new Set(r.jackpots.map((j) => j.key));
    let settledWinners = 0;
    for (const res of r.ended) {
      const want = expectedSettlement(c, res);
      assert.deepEqual([res.paidMilli, res.overMilli], [want.payoutMilli, want.overMilli], res.key);
      if (winners.has(res.key)) { settledWinners += 1; assert.ok(res.jackpotMilli > 0 && res.jackpotMilli % 1000 === 0); }
    }
    assert.ok(settledWinners >= 1);
    assert.equal(r.state.jackpot.contributedMilli, r.state.jackpot.poolMilli + r.state.jackpot.paidMilli);
  });
});

// ──────────────────────────────────────────────────────────────────────────
// 8) 상태 v12 · 등급별 사다리
// ──────────────────────────────────────────────────────────────────────────

describe("state v12 (spec 24 §4.3)", () => {
  it("JSON round trip keeps the hash with live buffs; each new pickaxe field (and LIFE's durabilityTotal) moves the hash; swapping giantUntil and speedUntil moves it", () => {
    const c = shipped;
    const state = createRoom(c, windowFactory(seedFrom(1), 1, 0), 1, 0);
    const p = player(c, 2, "1:0", 5, -30);
    Object.assign(p, { popStacks: 2, buffCount: 2, giantUntil: 400, speedUntil: 310, gravityMulBps: 16000 });
    p.scaleTarget = scaleTargetOf(c, p);
    state.pickaxes.push(p);
    const h = roomHash(state);
    assert.equal(roomHash(cloneRoom(state)), h);
    const fields: [keyof PickaxeState, number][] = [
      ["popStacks", 3], ["buffCount", 3], ["giantUntil", 401], ["speedUntil", 311], ["gravityMulBps", 10000], ["scaleTarget", p.scaleTarget + 0.125], ["durabilityTotal", p.durabilityTotal + 664],
    ];
    for (const [field, value] of fields) {
      const s = cloneRoom(state);
      Object.assign(s.pickaxes.at(-1)!, { [field]: value });
      assert.notEqual(roomHash(s), h, field);
    }
    const swapped = cloneRoom(state);
    Object.assign(swapped.pickaxes.at(-1)!, { giantUntil: 310, speedUntil: 400 });
    assert.notEqual(roomHash(swapped), h);
  });
});

describe("LUCKY PICK by tier (spec 24 §3.18): luckyPick.byTier[t] is tier t's ladder", () => {
  it("drawPickLevelBps(c, stream, tier) = catalogPickLevelBps(c, u53, tier); spawned pickaxes carry a level of their own tier's ladder", () => {
    const c = structuredClone(shipped);
    const ladder = (t: number) => [{ multBps: 11000 + 1000 * t, per10m: 3_000_000 }, { multBps: 30000 + 1000 * t, per10m: 1_000_000 }];
    c.luckyPick = { byTier: c.pickaxes.map((_, t) => ladder(t)) };
    const cat = parseCatalog(c);
    for (let t = 0; t < cat.pickaxes.length; t++) {
      for (let i = 0; i < 200; i++) {
        const bytes = new Uint8Array(16).map((_, j) => (i * 31 + j * 7 + t) & 0xff);
        const got = drawPickLevelBps(cat, Xoshiro128ss.fromBytes(bytes), t);
        assert.equal(got, catalogPickLevelBps(cat, streamU53(Xoshiro128ss.fromBytes(bytes)), t));
        assert.ok(got === 0 || ladder(t).some((l) => l.multBps === got));
      }
    }
    const r = runBusy(cat, 11, 300);
    const seenTiers = new Set<number>();
    for (const s of r.spawned) {
      assert.ok(s.pickLevelBps === 0 || ladder(s.tier).some((l) => l.multBps === s.pickLevelBps), `${s.key} tier ${s.tier} level ${s.pickLevelBps}`);
      if (s.pickLevelBps > 0) seenTiers.add(s.tier);
    }
    assert.equal(seenTiers.size, cat.pickaxes.length, "모든 등급이 자기 사다리에서 뽑았다");
  });
});
