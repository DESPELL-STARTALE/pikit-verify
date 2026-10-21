import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  catalogBuffKind, catalogComboPrizeMilli, catalogDurabilityMax, catalogFixedRows, catalogItemWins, catalogLastHitCapMilli, catalogLastHitMilli,
  catalogLuckyCeilingMilli, catalogLuckyMultLevels, catalogLuckyShare, catalogPickLevelBps, catalogQuadChanceBps, catalogScaleCap, luckyPoolCount, parseCatalog,
  type BuffKind, type BuffSpec, type Catalog, type EngineInput,
} from "@pikit/protocol";
import {
  applyHitReward, capsuleBlockContact, cloneRoom, createRingBuffer, createRoom, drawLuckyKind, drawPickLevelBps, expireBuffs, generateBlockRows,
  getActiveBlockFromRingBuffer, GRAVITY_MUL_ONE_BPS, growOnCombo, hitboxPrimitives, lastHitPrizeMilli, luckyRateMilli, mirrorQuad, PhysicsEngine, physicsFor,
  QUAD_HP_MULT, quadAnchor, regenerateBatch, resolveItems, rollItem, runWindow, scaleTargetOf, settleAbnormal, settleNormal, skyGrowScale, STATE_ENCODING_TAG,
  streamU53, Xoshiro128ss,
  type BlockState, type CompletedBatch, type EnginePayout, type HitEvent, type PickaxeResult, type PickaxeState, type Rng, type RngFactory, type RoomBonusEvent,
  type RoomBuffEvent, type RoomJackpotEvent, type RoomLastHitEvent, type RoomState, type SpawnRecord,
} from "../src/index.js";
import { createPickaxe, expectedSettlement, fixedRng, loadCatalog, loadRules10Catalog, OWNERS, roomHash, seedFrom, windowFactory } from "./helpers.js";
import { newSafety, rules12Violations, tapTicks, type Safety } from "./tools/balance.js";

// ──────────────────────────────────────────────────────────────────────────
// 규칙 12 (명세 25 §3 · §4 · §5.3): 봇 몸마다 블록 반발 · LUCKY luckyWeight · 막타 룰렛 아이템(t₀에 뽑고 t₀ + rouletteTicks에 적용, 그동안 끝 유예) ·
// 2×2 CHOG(묶음 HP 4배 · 묶음당 1타 · HP 미러 · 막타 × 4) · 상태 v13 — 그리고 규칙 11에서 그대로 이어지는 COMBO 사다리 · 성장 · 몸마다 중력 배수 ·
// 정수 크레딧 정산 · 등급별 사다리. 기대값은 출시 카탈로그(catalog.example.json = catalogs/normal.json, 규칙 12 — 값은 W1이 G1에서 맞추는
// 잠정값이라 카탈로그에서 계산한다). 규칙 11 결과 비트까지(고정 기준, 명세 25 §5.3-1)는 r11-baseline.test.ts.
//  1 봇 반발 · 2 LUCKY · 3 COMBO · 4 성장 · 5 아이템 뽑기·적용 · 6 유예(방) · 7 2×2 생성·물리·보상 · 8 정수 정산 · 9 바쁜 판(출시) · 10 바쁜 판(시험 카탈로그,
//  §5.3-7) · 11 정수 잭팟 · 12 상태 v13 · 등급별 사다리
//  - 바쁜 판(8지갑 × 3,000윈도): 틱마다 박힘 · 관통 0, 불변식(아이템 대기 · 2×2 네 칸) 위반 0, 수명 ≤ 타이머 + R, 아이템 = 뽑을 수 있는 막타마다
//    (대기·상한이면 뽑지 않음, 스트림 `item|<키>|<h>`), 같은 타격의 COMBO 성장이 아이템 뽑기보다 먼저, 정산은 모두 정수 크레딧(expectedSettlement와 같음)
// ──────────────────────────────────────────────────────────────────────────

const shipped = loadCatalog();
const rules10 = loadRules10Catalog();   // reward 칸만 쓴다(정수 크레딧 없는 카탈로그 = 밀리 정산)
const owner = OWNERS[0]!;
const TWO53 = 9007199254740992;

function kindOf(c: Catalog, id: string): number {
  const k = c.blocks.findIndex((b) => b.id === id);
  assert.ok(k >= 0, `block ${id}`);
  return k;
}
const [DIRT, CLAY, STONE, DIAMOND, CHOG, GOLD] = ["dirt", "clay", "stone", "diamond", "chog", "chog_gold"].map((id) => kindOf(shipped, id)) as [number, number, number, number, number, number];

function buffsOf(c: Catalog): NonNullable<Catalog["buffs"]> {
  assert.ok(c.buffs, "catalog.buffs");
  return c.buffs;
}
function itemsOf(c: Catalog): NonNullable<Catalog["buffs"]>["items"] {
  return buffsOf(c).items;
}
function specOf<K extends BuffKind>(c: Catalog, kind: K): Extract<BuffSpec, { kind: K }> {
  const s = itemsOf(c).table.find((x) => x.kind === kind);
  assert.ok(s, `item ${kind}`);
  return s as Extract<BuffSpec, { kind: K }>;
}
/** 그 종류 누적 가중 구간의 가운데 u (u × 2⁵³이 정수 — 실제 스트림의 수와 같은 꼴). */
function slotU(c: Catalog, kind: BuffKind): number {
  const table = itemsOf(c).table;
  const total = table.reduce((a, x) => a + x.weight, 0);
  let cum = 0;
  for (const x of table) {
    if (x.kind === kind) return Math.floor(((cum + x.weight / 2) / total) * TWO53) / TWO53;
    cum += x.weight;
  }
  throw new Error(`no ${kind}`);
}
/** 아이템 당첨 문턱: u53 < 이 값이면 당첨 (u53 × 10⁴ < bps × 2⁵³ ⟺ u53 < ⌈bps × 2⁵³ / 10⁴⌉). */
function winLimitU53(bps: number): bigint {
  return (BigInt(bps) * (1n << 53n) + 9999n) / 10000n;
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
  const b: BlockState = { kind, x, y, health: c.blocks[kind]!.hp, quad: 0 };
  return applyHitReward(c, p, b, damage, { window: 7, tick: p.hits++ });
}
const steps = (p: PickaxeState) => p.bonusEvents.map((e) => [e.kind, e.blockKind, e.streakCount]);
/** 등급마다 bonusCap = 가격 × 100 (상한이 상금을 자르지 않게). */
function roomyCap(c: Catalog): Catalog {
  const x = structuredClone(c);
  for (const t of x.pickaxes) t.bonusCap = t.priceCredits * 100;
  return x;
}
/** 4칸 확률: CHOG Ore = ore, Golden CHOG = gold (나머지 0). */
function quadCatalog(ore: number, gold: number, base: Catalog = shipped): Catalog {
  const c = structuredClone(base);
  c.generation.quadChanceBps = c.blocks.map((_, k) => (k === CHOG ? ore : k === GOLD ? gold : 0));
  return parseCatalog(c);
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
// 1) 봇 반발 (명세 25 §3.1 · §5.3-2)
// ──────────────────────────────────────────────────────────────────────────

/** 빈 링(30줄 × 폭)에 줄 floor만 단단한 블록(체력 큼). */
function floorRing(c: Catalog, floor = 12): BlockState[] {
  const W = c.world.width;
  const blocks: BlockState[] = [];
  for (let y = 0; y < 30; y++) for (let x = 0; x < W; x++) blocks.push({ kind: 0, x, y, health: y === floor ? 1e12 : 0, quad: 0 });
  return blocks;
}
/** 몸 하나를 n틱 돌려 틱마다 (x, y, vx, vy, angle, vAngle). */
function trace(c: Catalog, body: PickaxeState, blocks: BlockState[], ticks: number, rngSeed = 3): number[][] {
  const physics = physicsFor(c);
  const rng = fixedRng(rngSeed);
  const out: number[][] = [];
  for (let t = 0; t < ticks; t++) {
    physics.advancePickaxe(body, blocks, c.world.width, rng);
    out.push([body.x, body.y, body.vx, body.vy, body.angle, body.vAngle]);
  }
  return out;
}

describe("bot bounce (spec 25 §3.1): bot bodies bounce off blocks with bots[i].bounce — players, walls and the sky star keep theirs", () => {
  const withBounce = (e: number | undefined, circle = false): Catalog => {
    const c = structuredClone(shipped);
    if (e === undefined) delete c.bots[0]!.bounce;
    else c.bots[0]!.bounce = e;
    if (circle) {
      c.bots[0]!.hitbox = { shape: "circle" };
      for (const t of c.pickaxes) t.hitbox = { shape: "circle" };
    }
    return parseCatalog(c);
  };
  const bot = (c: Catalog, x = 5, y = 9): PickaxeState => {
    const b = c.bots[0]!;
    return createPickaxe(x, y, { tier: 0, scale: b.scale, attack: b.attack, frictionPerTick: b.frictionPerTick, vy: 0.3 });
  };

  it("bounceOf: a bot body (owner null) uses bots[tier].bounce, a player body physics.bounce; physicsFor fills a missing bot bounce with physics.bounce", () => {
    assert.equal(shipped.bots[0]!.bounce, 0.5, "출시(잠정) 봇 반발");
    const ph = physicsFor(shipped);
    assert.equal(ph.bounceOf({ owner: null, tier: 0 }), 0.5);
    assert.equal(ph.bounceOf({ owner, tier: 0 }), shipped.physics.bounce);
    assert.equal(physicsFor(withBounce(undefined)).bounceOf({ owner: null, tier: 0 }), shipped.physics.bounce);
    assert.equal(new PhysicsEngine(shipped.physics).bounceOf({ owner: null, tier: 3 }), shipped.physics.bounce, "칸이 없으면 physics.bounce");
  });

  for (const circle of [false, true]) {
    it(`same floor contact (${circle ? "circle bodies" : "pickaxe hitboxes"}): the bot rebounds with its own e (0.5 ≠ 0.85, smaller first rebound), bounce absent = physics.bounce bit for bit, a player body ignores bots[].bounce`, () => {
      const run = (e: number | undefined, who: "bot" | "player") => {
        const c = withBounce(e, circle);
        return trace(c, who === "bot" ? bot(c) : player(c, 0, "1:0", 5, 9), floorRing(c), 60);
      };
      const half = run(0.5, "bot");
      const full = run(0.85, "bot");
      assert.notDeepEqual(half, full, "봇 반발이 바뀌면 봇 몸의 궤적이 바뀐다");
      assert.deepEqual(run(undefined, "bot"), run(shipped.physics.bounce, "bot"), "bounce가 없으면 physics.bounce와 비트까지 같다");
      const firstUp = (tr: number[][]) => tr.find((s) => s[3]! < 0)?.[3] ?? 0;   // 첫 튕김의 위 속도(음수) — 뒤 튕김은 회전이 섞인다
      assert.ok(firstUp(full) < 0 && firstUp(half) < 0 && firstUp(half) > firstUp(full), `첫 튕김 0.5 ${firstUp(half)} vs 0.85 ${firstUp(full)}`);
      const p1 = run(0.5, "player");
      assert.ok(p1.some((s) => s[3]! < 0), "사람 몸도 바닥에 튕겼다");
      assert.deepEqual(p1, run(0.85, "player"), "사람 곡괭이는 bots[].bounce와 무관");
    });
  }

  it("walls stay e = 1 for bots: a bot that only meets the side wall moves the same with bounce 0.5 and 0.85", () => {
    const run = (e: number) => {
      const c = withBounce(e);
      const b = bot(c, 1.2, -20);
      b.vx = -0.4;
      b.vy = 0;
      return trace(c, b, floorRing(c), 10, 5);
    };
    const a = run(0.5);
    assert.ok(a.some((s) => s[2]! > 0), "벽에 닿아 튕겼다");
    assert.deepEqual(a, run(0.85));
  });
});

// ──────────────────────────────────────────────────────────────────────────
// 2) LUCKY ORE (명세 25 §3.2 · §5.3-3)
// ──────────────────────────────────────────────────────────────────────────

describe("LUCKY ORE (spec 25 §3.2): kind by luckyWeight, rate share × Σw ÷ w_X × P ÷ D, ceiling share × Σw ÷ min(w > 0) × P × life", () => {
  const skewW = [3, 0, 1, 2, 5, 1, 1, 1, 1, 7, 0, 0];
  const skewed = (): Catalog => {
    const c = structuredClone(shipped);
    c.blocks.forEach((b, k) => { b.luckyWeight = skewW[k]!; });
    delete c.lucky.multByKind;   // (개정 2) 가중 0 종류엔 사다리가 없어야 한다 — 기울인 판은 배수 없이(×1)
    c.lucky.shareByTier = c.lucky.shareByTier.map(() => 0.08);
    return parseCatalog(c);
  };

  it("100,000 draws on the shipped catalog: each of the 10 ores 1/10 within ±4σ, CHOG never", () => {
    const N = 100_000;
    const r = Xoshiro128ss.fromBytes(new Uint8Array(16).map((_, i) => i * 13 + 1));
    const pool = luckyPoolCount(shipped);
    assert.equal(pool, 10, "출시: 흙~다이아 1씩");
    const seen = new Array<number>(shipped.blocks.length).fill(0);
    for (let i = 0; i < N; i++) seen[drawLuckyKind(shipped, r.next())]! += 1;
    shipped.blocks.forEach((b, k) => {
      if (b.luckyWeight === 0) { assert.equal(seen[k], 0, b.id); return; }
      const q = b.luckyWeight / pool;
      const sigma = Math.sqrt(N * q * (1 - q));
      assert.ok(Math.abs(seen[k]! - N * q) <= 4 * sigma, `${b.id}: ${seen[k]} vs ${N * q} ± ${(4 * sigma).toFixed(0)}`);
    });
  });

  it("boundaries (skewed weights 3 · 0 · 1 · 2 · 5 · 1 · 1 · 1 · 1 · 7 · 0 · 0): u = 0 → the first weighted kind, every edge index −1/+1, weight 0 never; Σw = 0 (share 0) → −1", () => {
    const c = skewed();
    const pool = skewW.reduce((a, x) => a + x, 0);
    assert.equal(luckyPoolCount(c), pool);
    assert.equal(drawLuckyKind(c, 0), 0);
    const at = (index: number) => drawLuckyKind(c, (index + 0.5) / pool);
    let start = 0;
    let prev = -1;
    skewW.forEach((w, k) => {
      if (w === 0) return;
      assert.equal(at(start), k, `kind ${k}: first index ${start}`);
      assert.equal(at(start + w - 1), k, `kind ${k}: last index ${start + w - 1}`);
      if (prev >= 0) assert.equal(at(start - 1), prev, `index ${start - 1} is the kind before`);
      prev = k;
      start += w;
    });
    for (let i = 0; i < pool; i++) assert.ok(skewW[at(i)]! > 0);
    const off = structuredClone(shipped);
    off.lucky.shareByTier = off.lucky.shareByTier.map(() => 0);
    delete off.lucky.multByKind;
    off.blocks.forEach((b) => { b.luckyWeight = 0; });
    assert.equal(drawLuckyKind(parseCatalog(off), 0.5), -1);
  });

  it("rate = share × Σw ÷ w_X × price × 1000 ÷ D (0 for w = 0), and the expected LUCKY Σ_X (w_X/Σw) × rate_X × d_X = share × P × (damage to weighted kinds) ÷ D — kind-neutral", () => {
    const d = [500, 300, 200, 120, 80, 50, 30, 20, 10, 5, 400, 100];
    for (const c of [shipped, skewed()]) {
      const pool = luckyPoolCount(c);
      for (let tier = 0; tier < c.pickaxes.length; tier++) {
        const t = c.pickaxes[tier]!;
        let e = 0;
        c.blocks.forEach((b, k) => {
          const want = b.luckyWeight > 0 ? (((catalogLuckyShare(c, tier) * pool) / b.luckyWeight) * t.priceCredits * 1000) / t.durability : 0;
          assert.equal(luckyRateMilli(c, tier, k, 10_000), want, `tier ${tier} kind ${k}`);
          e += (b.luckyWeight / pool) * luckyRateMilli(c, tier, k, 10_000) * d[k]!;
        });
        const eligible = c.blocks.reduce((a, b, k) => a + (b.luckyWeight > 0 ? d[k]! : 0), 0);
        const neutral = (catalogLuckyShare(c, tier) * t.priceCredits * 1000 * eligible) / t.durability;
        assert.ok(Math.abs(e - neutral) <= 1e-9 * neutral, `tier ${tier}: E ${e} vs ${neutral}`);
      }
    }
  });

  it("ceiling: all of D on kind X stops at ⌊share × Σw ÷ w_X × P × 1000⌋; with every LIFE (D_max) the lightest kind reaches catalogLuckyCeilingMilli exactly (= share × Σw ÷ min(w > 0) × P × D_max/D)", () => {
    for (const c of [shipped, skewed()]) {
      let light = -1;
      c.blocks.forEach((b, k) => { if (b.luckyWeight > 0 && (light < 0 || b.luckyWeight < c.blocks[light]!.luckyWeight)) light = k; });
      const t = c.pickaxes[0]!;
      const dMax = catalogDurabilityMax(c, 0);
      assert.ok(dMax > t.durability);
      const plain = player(c, 0, "1:0");
      const lifed = player(c, 0, "2:0");
      const top = catalogLuckyMultLevels(c, light).at(-1)?.multBps ?? 10_000;   // (개정 2) 천장 = 가장 높은 배수
      plain.luckyKind = light;
      lifed.luckyKind = light;
      plain.luckyMultBps = top;
      lifed.luckyMultBps = top;
      lifed.durabilityTotal = dMax;
      lifed.durabilityLeft = dMax;
      for (let dd = 0, i = 0; dd < 2 * dMax; dd += t.attack, i++) {
        hit(c, plain, light, i % 10, 3 + Math.floor(i / 10), t.attack);
        hit(c, lifed, light, i % 10, 3 + Math.floor(i / 10), t.attack);
      }
      const dCeil = Math.floor(((catalogLuckyShare(c, 0) * luckyPoolCount(c)) / c.blocks[light]!.luckyWeight) * (top / 10_000) * t.priceCredits * 1000);
      assert.equal(plain.luckyMilli, dCeil);
      assert.equal(lifed.luckyMilli, catalogLuckyCeilingMilli(c, 0));
      assert.ok(lifed.luckyMilli > plain.luckyMilli);
    }
  });
});

// ──────────────────────────────────────────────────────────────────────────
// 3) COMBO 사다리 (명세 24 §3.5 — 규칙 11 그대로)
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

  it("bots get no COMBO, no growth and no item (no money, no event, no stream)", () => {
    const p = createPickaxe(5, 5, { tier: 0 });   // 주인 없음 = 봇
    for (let x = 0; x < 4; x++) assert.equal(hit(shipped, p, STONE, x), 0);
    assert.deepEqual([p.bonusEvents.length, p.bonusMilli, p.streakLen], [0, 0, 0]);
    growOnCombo(shipped, p);
    assert.equal(p.popStacks, 0);
    p.lastHits = 1;
    assert.equal(rollItem(shipped, p, { kind: CHOG, x: 1, y: 3 }, () => { throw new Error("a bot opened an item stream"); }, { window: 1, tick: 1 }), null);
    assert.deepEqual([p.buffCount, p.itemUntil, p.itemKind], [0, 0, -1]);
  });
});

// ──────────────────────────────────────────────────────────────────────────
// 4) 성장 (명세 24 §3.8-1 — 규칙 11 그대로)
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
// 5) 막타 아이템 — 뽑기 · 적용 (명세 25 §3.3.2 · §3.3.3 · §3.3.8)
// ──────────────────────────────────────────────────────────────────────────

/** h번째 막타(0부터) 직후의 플레이어 곡괭이 — creditHits가 rollItem을 부르는 순간처럼 lastHits = h + 1. */
function afterLastHit(c: Catalog, tier: number, key: string, h = 0): PickaxeState {
  const p = player(c, tier, key);
  p.lastHits = h + 1;
  return p;
}

describe("last-hit items (spec 25 §3.3): a player's LAST HIT draws `item|<key>|<h>` — win by the block's chanceBps, kind by weight, DASH angle; applied at t₀ + rouletteTicks", () => {
  const R = itemsOf(shipped).rouletteTicks;
  const at = { window: 9, tick: 40 };

  it("stream and state: h = lastHits − 1; the first number wins, the second picks the kind, DASH alone draws a third (angle × 2π); the event carries t₀, n, h, the cell and its kind — nothing is applied yet", () => {
    const c = shipped;
    assert.equal(R, 15, "출시 룰렛 15틱 (0.5 s)");
    for (const spec of itemsOf(c).table) {
      const p = afterLastHit(c, 0, "77:0", 4);
      const before = structuredClone(p);
      const label = "item|77:0|4";
      const s = scripted({ [label]: [0, slotU(c, spec.kind), 0.125] });
      const ev = rollItem(c, p, { kind: STONE, x: 6, y: 21 }, s.rng, at);
      assert.deepEqual(ev, { key: "77:0", owner, tier: 0, window: 9, tick: 40, kind: spec.kind, n: 0, h: 4, x: 6, y: 21, blockKind: STONE } satisfies RoomBuffEvent);
      assert.equal(catalogBuffKind(c, BigInt(slotU(c, spec.kind) * TWO53))?.kind, spec.kind);
      assert.deepEqual(s.labels, [label]);
      assert.equal(s.draws.get(label), spec.kind === "DASH" ? 3 : 2);
      assert.deepEqual(
        [p.buffCount, p.itemUntil, p.itemKind, p.itemAngle],
        [1, at.tick + R, itemsOf(c).table.indexOf(spec), spec.kind === "DASH" ? 0.125 * (Math.PI * 2) : 0],
      );
      assert.deepEqual({ ...p, buffCount: 0, itemUntil: 0, itemKind: -1, itemAngle: 0 }, before, "효과는 t₀ + R의 resolveItems가 낸다");
    }
  });

  it("win ⟺ u53 × 10⁴ < chanceBps[kind] × 2⁵³ (BigInt, exact at the boundary for every block kind); a miss reads one number and leaves no state and no event", () => {
    const c = shipped;
    const chance = itemsOf(c).chanceBps;
    assert.deepEqual(chance, [6000, 6000, 6000, 6000, 6000, 6000, 8500, 8500, 8500, 8500, 10000, 10000], "출시 확률(명세 25 §3.3.5 C4)");
    c.blocks.forEach((_, k) => {
      const limit = winLimitU53(chance[k]!);
      assert.ok(limit > 0n, `kind ${k}`);
      const win = afterLastHit(c, 1, "3:0");
      assert.ok(rollItem(c, win, { kind: k, x: 0, y: 5 }, scripted({ "item|3:0|0": [Number(limit - 1n) / TWO53, slotU(c, "LIFE")] }).rng, at), `kind ${k}: u53 = L − 1 wins`);
      assert.ok(catalogItemWins(c, k, limit - 1n));
      if (limit === 1n << 53n) return;   // 10,000 bps: 모든 u가 당첨
      const miss = afterLastHit(c, 1, "3:0");
      const s = scripted({ "item|3:0|0": [Number(limit) / TWO53] });
      assert.equal(rollItem(c, miss, { kind: k, x: 0, y: 5 }, s.rng, at), null, `kind ${k}: u53 = L misses`);
      assert.equal(s.draws.get("item|3:0|0"), 1);
      assert.deepEqual([miss.buffCount, miss.itemUntil, miss.itemKind, miss.itemAngle], [0, 0, -1, 0]);
    });
    const zero = structuredClone(c);
    itemsOf(zero).chanceBps[STONE] = 0;
    assert.equal(rollItem(zero, afterLastHit(zero, 0, "3:0"), { kind: STONE, x: 0, y: 5 }, scripted({ "item|3:0|0": [0] }).rng, at), null, "0 bps는 u = 0도 꽝");
  });

  it("no stream while a roulette is pending, at maxPerPickaxe, for a bot or without catalog.buffs; along one pickaxe h counts LAST HITs and n counts items", () => {
    const c = shipped;
    const max = itemsOf(c).maxPerPickaxe;
    const never: RngFactory = (label) => { throw new Error(`opened ${label}`); };
    const pending = afterLastHit(c, 0, "1:0");
    Object.assign(pending, { itemUntil: 55, itemKind: 0, buffCount: 1 });
    assert.equal(rollItem(c, pending, { kind: CHOG, x: 0, y: 0 }, never, at), null);
    const full = afterLastHit(c, 0, "1:0");
    full.buffCount = max;
    assert.equal(rollItem(c, full, { kind: CHOG, x: 0, y: 0 }, never, at), null);
    const bot = createPickaxe(5, 5, { tier: 0 });
    bot.lastHits = 1;
    assert.equal(rollItem(c, bot, { kind: CHOG, x: 0, y: 0 }, never, at), null);
    const plain = structuredClone(c) as Partial<Catalog>;
    delete plain.buffs;
    assert.equal(rollItem(plain as Catalog, afterLastHit(c, 0, "1:0"), { kind: CHOG, x: 0, y: 0 }, never, at), null);

    // 한 곡괭이의 막타 차례: h 0 꽝 · h 1 당첨(n 0) · h 2 대기 중(스트림 없음) · 멈춘 뒤 h 3 당첨(n 1) · h 4 당첨(n 2) · h 5 상한(스트림 없음)
    assert.equal(max, 3);
    const state = createRoom(c, windowFactory(seedFrom(4), 1, 0), 1, 0);
    const p = player(c, 0, "8:0");
    state.pickaxes.push(p);
    const s = scripted({
      "item|8:0|0": [0.999],
      "item|8:0|1": [0, slotU(c, "LIFE")],
      "item|8:0|3": [0, slotU(c, "SPEED")],
      "item|8:0|4": [0, slotU(c, "GIANT")],
    });
    const roll = (tick: number) => {
      p.lastHits += 1;
      return rollItem(c, p, { kind: STONE, x: 1, y: 2 }, s.rng, { window: 1, tick })?.n ?? null;
    };
    assert.equal(roll(100), null);
    assert.equal(roll(101), 0);
    assert.equal(roll(101 + R - 1), null, "대기 중");
    resolveItems(state, c, 101 + R);
    assert.equal(roll(101 + R + 1), 1);
    resolveItems(state, c, 101 + 2 * R + 1);
    assert.equal(roll(101 + 2 * R + 2), 2);
    resolveItems(state, c, 101 + 3 * R + 2);
    assert.equal(roll(101 + 3 * R + 3), null, "상한");
    assert.deepEqual(s.labels, ["item|8:0|0", "item|8:0|1", "item|8:0|3", "item|8:0|4"]);
    assert.equal(p.buffCount, max);
  });

  it("win rate per block class: 100,000 draws each on the real window stream within ±4σ of chanceBps / 10⁴ (10,000 bps wins every time)", () => {
    const c = shipped;
    const N = 100_000;
    const chance = itemsOf(c).chanceBps;
    for (const bps of [...new Set(chance)]) {
      const kind = chance.indexOf(bps);
      const rng = windowFactory(seedFrom(4242 + bps), 1, 1);
      const p = afterLastHit(c, 0, "0:0");
      let wins = 0;
      for (let i = 0; i < N; i++) {
        Object.assign(p, { key: `${i}:0`, buffCount: 0, itemUntil: 0, itemKind: -1, itemAngle: 0 });
        if (rollItem(c, p, { kind, x: 0, y: 0 }, rng, at)) wins += 1;
      }
      const q = bps / 10000;
      if (q === 1) { assert.equal(wins, N); continue; }
      const sigma = Math.sqrt(N * q * (1 - q));
      assert.ok(Math.abs(wins - N * q) <= 4 * sigma, `${bps} bps: ${wins} vs ${N * q} ± ${(4 * sigma).toFixed(0)}`);
    }
  });

  it("item kinds follow the table weights within ±4σ over 100,000 wins — the shipped 1 : 1 : 1 : 1 and a skewed 5 : 1 : 3 : 1", () => {
    const skew = structuredClone(shipped);
    const w: Record<BuffKind, number> = { GIANT: 5, DASH: 1, SPEED: 3, LIFE: 1 };
    for (const x of itemsOf(skew).table) x.weight = w[x.kind];
    parseCatalog(skew);
    const N = 100_000;
    for (const c of [shipped, skew]) {
      const table = itemsOf(c).table;
      const total = table.reduce((a, x) => a + x.weight, 0);
      const counts = new Map<BuffKind, number>();
      const rng = windowFactory(seedFrom(424242), 1, 1);
      const p = afterLastHit(c, 0, "0:0");
      for (let i = 0; i < N; i++) {
        Object.assign(p, { key: `${i}:0`, buffCount: 0, itemUntil: 0, itemKind: -1, itemAngle: 0 });
        const ev = rollItem(c, p, { kind: CHOG, x: 0, y: 0 }, rng, at);   // CHOG 10,000 bps — 늘 당첨
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

  it("resolveItems: nothing on t₀ … t₀ + R − 1; at t₀ + R the rules-11 effects on every tier (GIANT target · DASH |v| at θ · SPEED gravity until · LIFE + ⌊D × bps / 10⁴⌋), then the pending item is cleared", () => {
    const c = shipped;
    const [g, d, sp, life] = [specOf(c, "GIANT"), specOf(c, "DASH"), specOf(c, "SPEED"), specOf(c, "LIFE")];
    const t0 = 500;
    const T = t0 + R;
    for (let tier = 0; tier < c.pickaxes.length; tier++) {
      const t = c.pickaxes[tier]!;
      const state = createRoom(c, windowFactory(seedFrom(5), 1, 0), 1, 0);
      const drawn = (kind: BuffKind, key: string): PickaxeState => {
        const p = afterLastHit(c, tier, key);
        Object.assign(p, { vx: 0.2, vy: -0.1, durabilityLeft: t.durability - 100 });
        assert.ok(rollItem(c, p, { kind: CHOG, x: 0, y: 0 }, scripted({ [`item|${key}|0`]: [0, slotU(c, kind), 0.125] }).rng, { window: 3, tick: t0 }));
        state.pickaxes.push(p);
        return p;
      };
      const [pg, pd, ps, pl] = (["GIANT", "DASH", "SPEED", "LIFE"] as const).map((k, i) => drawn(k, `${i + 1}:0`)) as [PickaxeState, PickaxeState, PickaxeState, PickaxeState];
      const frozen = structuredClone(state.pickaxes);
      for (let tick = t0; tick < T; tick++) resolveItems(state, c, tick);
      assert.deepEqual(state.pickaxes, frozen, "룰렛이 도는 동안 아무것도 바뀌지 않는다");
      resolveItems(state, c, T);
      assert.equal(pg.giantUntil, T + g.ticks);
      assert.equal(pg.scaleTarget, Math.max(t.scale, Math.min(catalogScaleCap(c, tier), (t.scale * g.scaleBps) / 10000)));
      assert.equal(pg.scale, t.scale, "지름은 stepScales가 따라간다");
      // detSinCos 절단 오차 ≤ 7e-12 (trig.ts)
      assert.ok(Math.abs(Math.hypot(pd.vx, pd.vy) - d.speed) < 1e-10, `|v| ${Math.hypot(pd.vx, pd.vy)}`);
      assert.ok(Math.abs(pd.vx - d.speed * Math.SQRT1_2) < 1e-10 && Math.abs(pd.vy - d.speed * Math.SQRT1_2) < 1e-10, "u₃ = 1/8 → θ = π/4");
      assert.deepEqual([ps.gravityMulBps, ps.speedUntil], [sp.gravityBps, T + sp.ticks]);
      const add = Math.floor((t.durability * life.durabilityBps) / 10000);
      assert.deepEqual([pl.durabilityTotal, pl.durabilityLeft], [t.durability + add, t.durability - 100 + add]);
      assert.deepEqual([pl.scaleTarget, pl.gravityMulBps, pl.giantUntil, pl.speedUntil, pl.vx, pl.vy], [t.scale, GRAVITY_MUL_ONE_BPS, 0, 0, 0.2, -0.1], "LIFE는 내구도만");
      for (const p of [pg, pd, ps, pl]) assert.deepEqual([p.itemUntil, p.itemKind, p.itemAngle, p.buffCount], [0, -1, 0, 1]);
      const applied = structuredClone(state.pickaxes);
      resolveItems(state, c, T + 1);
      assert.deepEqual(state.pickaxes, applied, "한 번만 적용");
    }
  });

  it("GIANT and SPEED applied at T = t₀ + R end at the end of tick T + ticks (room order expireBuffs → resolveItems): size target and gravity go back; popStacks stays", () => {
    const c = shipped;
    const [g, sp] = [specOf(c, "GIANT"), specOf(c, "SPEED")];
    const state = createRoom(c, windowFactory(seedFrom(2), 1, 0), 1, 0);
    const pg = afterLastHit(c, 1, "1:0");
    const ps = afterLastHit(c, 1, "2:0");
    state.pickaxes.push(pg, ps);
    growOnCombo(c, pg);
    const grown = pg.scaleTarget;
    const t0 = 1000;
    const T = t0 + R;
    rollItem(c, pg, { kind: CHOG, x: 0, y: 0 }, scripted({ "item|1:0|0": [0, slotU(c, "GIANT")] }).rng, { window: 1, tick: t0 });
    rollItem(c, ps, { kind: CHOG, x: 0, y: 0 }, scripted({ "item|2:0|0": [0, slotU(c, "SPEED")] }).rng, { window: 1, tick: t0 });
    for (let tick = t0; tick <= T + Math.max(g.ticks, sp.ticks); tick++) {
      expireBuffs(state, c, tick);
      resolveItems(state, c, tick);
      assert.equal(pg.giantUntil > 0, tick >= T && tick < T + g.ticks, `GIANT at tick ${tick}`);
      assert.equal(pg.scaleTarget > grown, tick >= T && tick < T + g.ticks, `GIANT target at tick ${tick}`);
      assert.equal(ps.gravityMulBps, tick >= T && tick < T + sp.ticks ? sp.gravityBps : GRAVITY_MUL_ONE_BPS, `SPEED at tick ${tick}`);
    }
    assert.deepEqual([pg.giantUntil, pg.scaleTarget, pg.popStacks, ps.speedUntil], [0, grown, 1, 0]);
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
});

// ──────────────────────────────────────────────────────────────────────────
// 6) 유예 — 룰렛 끝까지 사라지지 않는다 (명세 25 §3.3.4) — 방에서
// ──────────────────────────────────────────────────────────────────────────

/** 지갑 하나가 등급 tier 곡괭이 1개를 사서 판에 나온 방 (윈도 1). */
function oneOnBoard(c: Catalog, tier: number, seedNo = 31): { state: RoomState; seed: Uint8Array; p: PickaxeState } {
  const seed = seedFrom(seedNo);
  const state = createRoom(c, windowFactory(seed, 1, 0), 1, 0);
  runWindow(state, c, 1, [{ type: "purchase", ref: "1", owner, tiers: [tier] }], windowFactory(seed, 1, 1));
  const p = state.pickaxes.find((q) => q.key === "1:0");
  assert.ok(p, "윈도 1에 판에 나왔다");
  return { state, seed, p };
}

interface GraceOut { t0: number; lastAlive: number; end: PickaxeResult | undefined; atResolve: PickaxeState | undefined; problems: string[] }

/**
 * 판에 나온 곡괭이에 다음 틱 t₀(= state.tick)에 뽑은 것처럼 아이템을 걸고(itemUntil = t₀ + R — null이면 걸지 않음), setup으로 끝 조건을 만든 뒤
 * 윈도 2~6을 입력(inputs, 윈도 2에만) 없이 돌린다. 틱 끝마다 곡괭이가 판에 있나 · 불변식을 본다.
 */
function grace(c: Catalog, tier: number, item: BuffKind | null, setup: (p: PickaxeState, t0: number) => void, inputs: EngineInput[] = []): GraceOut {
  const { state, seed, p } = oneOnBoard(c, tier);
  const R = itemsOf(c).rouletteTicks;
  const t0 = state.tick;
  if (item) Object.assign(p, { itemUntil: t0 + R, itemKind: itemsOf(c).table.findIndex((x) => x.kind === item), buffCount: 1 });
  setup(p, t0);
  const out: GraceOut = { t0, lastAlive: -1, end: undefined, atResolve: undefined, problems: [] };
  const tapped = tapTicks(c, state, newSafety(), (s) => {
    const tick = s.tick - 1;
    const q = s.pickaxes.find((x) => x.key === p.key);
    if (q) out.lastAlive = tick;
    if (q && tick === t0 + R) out.atResolve = structuredClone(q);
    out.problems.push(...rules12Violations(c, s, tick));
  });
  for (let w = 2; w <= 6 && !out.end; w++) {
    const res = runWindow(state, tapped, w, w === 2 ? inputs : [], windowFactory(seed, 1, w));
    out.end = res.ended.find((r) => r.key === p.key);
  }
  return out;
}

describe("grace (spec 25 §3.3.4): while a roulette spins (t₀ ≤ tick < t₀ + R) the pickaxe does not end — DURABILITY · TIMER · STUCK; at t₀ + R the item applies, then the end check", () => {
  const c = shipped;
  const R = itemsOf(c).rouletteTicks;
  const D = c.pickaxes[0]!.durability;
  const life = Math.floor((D * specOf(c, "LIFE").durabilityBps) / 10000);
  const sky = (p: PickaxeState) => Object.assign(p, { x: 5, y: -40, vx: 0, vy: 0 });   // 블록에서 먼 하늘 — 그동안 타격 없음

  it("DURABILITY: durability 0 with a pending item lives through t₀ + R − 1 and ends at t₀ + R (GIANT · DASH · SPEED — the item is spent); without an item it ends at t₀", () => {
    const zero = (p: PickaxeState) => { p.durabilityLeft = 0; };
    const plain = grace(c, 0, null, zero);
    assert.deepEqual([plain.end?.endReason, plain.end?.endTick], ["DURABILITY", plain.t0]);
    for (const kind of ["GIANT", "DASH", "SPEED"] as const) {
      const g = grace(c, 0, kind, zero);
      assert.deepEqual(g.problems, []);
      assert.deepEqual([g.end?.endReason, g.end?.endTick, g.lastAlive], ["DURABILITY", g.t0 + R, g.t0 + R - 1], kind);
      assert.equal(g.end?.durabilityUsed, D);
    }
  });

  it("LIFE revives: at t₀ + R durability = ⌊D × durabilityBps / 10⁴⌋ (88 of 1,108 on tier 0 at LIFE 800) and the pickaxe plays on", () => {
    const g = grace(c, 0, "LIFE", (p) => { p.durabilityLeft = 0; });
    assert.deepEqual(g.problems, []);
    assert.equal(life, 88);
    assert.ok(g.atResolve, "t₀ + R 틱 끝에 판에 있다");
    assert.deepEqual([g.atResolve.durabilityLeft, g.atResolve.durabilityTotal, g.atResolve.itemUntil, g.atResolve.itemKind], [life, D + life, 0, -1]);
    assert.ok(g.end === undefined || g.end.endTick > g.t0 + R, `되살아난 뒤에도 돈다 (끝 ${g.end?.endTick})`);
  });

  it("TIMER boundary: a pickaxe whose timer runs out at t₀ is held to t₀ + R (lifetime = timerTicks + R, LIFE does not extend the timer)", () => {
    const timer = c.limits.timerTicks;
    const expire = (p: PickaxeState, t0: number) => { sky(p); p.spawnTick = t0 + 1 - timer; };
    const plain = grace(c, 0, null, expire);
    assert.deepEqual([plain.end?.endReason, plain.end?.endTick], ["TIMER", plain.t0]);
    for (const kind of ["GIANT", "LIFE"] as const) {
      const g = grace(c, 0, kind, expire);
      assert.deepEqual(g.problems, []);
      assert.deepEqual([g.end?.endReason, g.end?.endTick, g.lastAlive], ["TIMER", g.t0 + R, g.t0 + R - 1], kind);
      assert.equal(g.end!.endTick + 1 - g.end!.spawnTick, timer + R, "수명 = 타이머 + R (최대)");
    }
  });

  it("STUCK boundary: no damage for stuckTicks at t₀ is held to t₀ + R as well", () => {
    const stuck = (p: PickaxeState, t0: number) => { sky(p); p.lastDamageTick = t0 + 1 - c.limits.stuckTicks; };
    const plain = grace(c, 0, null, stuck);
    assert.deepEqual([plain.end?.endReason, plain.end?.endTick], ["STUCK", plain.t0]);
    const g = grace(c, 0, "DASH", stuck);
    assert.deepEqual(g.problems, []);
    assert.deepEqual([g.end?.endReason, g.end?.endTick, g.lastAlive], ["STUCK", g.t0 + R, g.t0 + R - 1]);
  });

  it("room-level ends do not wait: FREEZE and VOID end a pickaxe with a pending roulette at once (the item is dropped)", () => {
    const freeze = grace(c, 0, "LIFE", () => {}, [{ type: "freeze", reason: "FREEZE" }]);
    assert.deepEqual([freeze.end?.endReason, freeze.end?.endTick], ["FREEZE", freeze.t0]);
    const voided = grace(c, 0, "LIFE", () => {}, [{ type: "voidPurchase", ref: "1", owner }]);
    assert.deepEqual([voided.end?.endReason, voided.end?.endTick], ["VOID", voided.t0]);
  });

  it("the item invariant is an engine assert: itemUntil beyond tick + rouletteTicks throws", () => {
    const { state, seed, p } = oneOnBoard(c, 0);
    Object.assign(p, { itemUntil: state.tick + R + 1, itemKind: 0, buffCount: 1 });
    assert.throws(() => runWindow(state, c, 2, [], windowFactory(seed, 1, 2)), /engine: item invariant broken/);
  });
});

// ──────────────────────────────────────────────────────────────────────────
// 7) 2×2 CHOG (명세 25 §3.4 · §3.4.9) — 생성 · 물리 · 보상
// ──────────────────────────────────────────────────────────────────────────

interface Gen { state: RoomState; batches: CompletedBatch[]; factoryFor: (w: number) => RngFactory; rowWindow: number[] }

/** 판 생성만: 줄 rows개를 윈도마다 perWindow줄씩 만든다 (링 ringRows줄 — 기본은 덮지 않는 큰 링). */
function generate(c: Catalog, seedNo: number, rows: number, perWindow = 1, ringRows = rows + 1): Gen {
  const seed = seedFrom(seedNo);
  const factoryFor = (w: number) => windowFactory(seed, 1, w);
  const state = {
    blocks: Array.from({ length: c.world.width * ringRows }, () => ({ kind: 0, x: 0, y: 0, health: 0, quad: 0 })),
    generatedRowCount: 0, batchIndex: -1, batchRemaining: [], batchKinds: [], batchRowWindows: [], pickaxes: [],
  } as unknown as RoomState;
  const batches: CompletedBatch[] = [];
  const rowWindow: number[] = [];
  for (let w = 0; state.generatedRowCount < rows; w++) {
    const n = Math.min(perWindow, rows - state.generatedRowCount);
    for (let i = 0; i < n; i++) rowWindow.push(w);
    batches.push(...generateBlockRows(state, c, n, factoryFor(w), w));
  }
  return { state, batches, factoryFor, rowWindow };
}
/** 링에서 칸 (x, y) — 그 줄이 링에 없으면 undefined. */
function cellAt(state: RoomState, c: Catalog, x: number, y: number): BlockState | undefined {
  const W = c.world.width;
  const rows = Math.floor(state.blocks.length / W);
  const b = state.blocks[(((y % rows) + rows) % rows) * W + x];
  return b && b.y === y && b.x === x ? b : undefined;
}

describe("2×2 generation (spec 25 §3.4.2): a fixed row draws u_q, a pair slot and the row below copies it — the kinds array carries the pattern", () => {
  it("quadChanceBps absent and all zeros give the rules-11 board bit for bit (no number drawn), every block single", () => {
    const absent = structuredClone(shipped);
    delete absent.generation.quadChanceBps;
    const a = generate(parseCatalog(absent), 3, 600, 2);
    const z = generate(quadCatalog(0, 0), 3, 600, 2);
    assert.deepEqual(a.batches, z.batches);
    assert.deepEqual(a.state.blocks, z.state.blocks);
    assert.ok(a.state.blocks.slice(0, 600 * shipped.world.width).every((b) => b.quad === 0 && b.health === shipped.blocks[b.kind]!.hp));
  });

  it("chance 10,000: every fixed row is a 2×2 (q 1 · 2 on the fixed row, 3 · 4 right below, health 4 × hp); composition = bc + 3q for the fixed kinds, bc for the banded, Σbc − 3q for the common", () => {
    const c = quadCatalog(10000, 10000);
    const W = c.world.width;
    const rpb = c.limits.batchBlocks / W;
    const { fixedFromKind, bandedFromKind } = c.generation;
    const fixed = catalogFixedRows(c);
    const g = generate(c, 7, 3 * rpb, 3);
    assert.equal(g.batches.length, 3);
    let anchors = 0;
    for (const b of g.batches) {
      const counts = new Array<number>(c.blocks.length).fill(0);
      for (const k of b.kinds) counts[k]! += 1;
      let quads = 0;
      for (let k = fixedFromKind; k < c.blocks.length; k++) {
        const hp = c.blocks[k]!.hp;
        for (const rr of fixed[k]!) {
          const top = [...Array(W).keys()].filter((x) => b.kinds[rr * W + x] === k);
          assert.equal(top.length, 2, `batch ${b.batchIndex} kind ${k} row ${rr}`);
          const x0 = top[0]!;
          assert.equal(top[1], x0 + 1);
          assert.deepEqual([...Array(W).keys()].filter((x) => b.kinds[(rr + 1) * W + x] === k), [x0, x0 + 1], "아래 줄이 같은 두 칸");
          const y = b.batchIndex * rpb + rr;
          const q = [cellAt(g.state, c, x0, y), cellAt(g.state, c, x0 + 1, y), cellAt(g.state, c, x0, y + 1), cellAt(g.state, c, x0 + 1, y + 1)];
          assert.deepEqual(q.map((cell) => [cell?.kind, cell?.quad, cell?.health]), [1, 2, 3, 4].map((m) => [k, m, 4 * hp]));
          quads += 1;
        }
        assert.equal(counts[k], 4 * c.blocks[k]!.batchCount, `kind ${k}: bc + 3 × bc`);
      }
      for (let k = bandedFromKind; k < fixedFromKind; k++) assert.equal(counts[k], c.blocks[k]!.batchCount, `banded ${k}`);
      let common = 0;
      let commonBc = 0;
      for (let k = 0; k < bandedFromKind; k++) {
        assert.ok(counts[k]! <= c.blocks[k]!.batchCount);
        common += counts[k]!;
        commonBc += c.blocks[k]!.batchCount;
      }
      assert.equal(common, commonBc - 3 * quads);
      anchors += quads;
    }
    assert.equal(g.state.blocks.filter((b) => b.quad === 1).length, anchors, "무늬 밖의 2×2 없음");
  });

  it("regenerateBatch = generation, including 2×2s whose two rows were made in different windows (shipped and 10,000)", () => {
    for (const c of [shipped, quadCatalog(10000, 10000)]) {
      const g = generate(c, 8, 3 * (c.limits.batchBlocks / c.world.width), 3);
      for (const b of g.batches) assert.deepEqual(regenerateBatch(c, b.batchIndex, b.rowWindows, g.factoryFor), b.kinds);
      const tops = g.state.blocks.filter((b) => b.quad === 1);
      assert.ok(tops.length > 0);
      if (c !== shipped) assert.ok(tops.some((b) => g.rowWindow[b.y] !== g.rowWindow[b.y + 1]), "창 경계를 걸친 2×2가 있다");
    }
  });

  it("shipped frequency (CHOG Ore 2,000 bps): 2×2 per 1,000 rows over 50 batches within ±4σ of 1,000 × Σ bc × p / 200 (= 12)", () => {
    const c = shipped;
    const rpb = c.limits.batchBlocks / c.world.width;
    const batches = 50;
    const g = generate(c, 12, batches * rpb);
    const quads = g.state.blocks.filter((b) => b.quad === 1).length;
    let mean = 0;
    let variance = 0;
    c.blocks.forEach((b, k) => {
      const p = catalogQuadChanceBps(c, k) / 10000;
      mean += batches * b.batchCount * p;
      variance += batches * b.batchCount * p * (1 - p);
    });
    assert.ok(Math.abs((mean / (batches * rpb)) * 1000 - 12) < 1e-9, `기대 ${(mean / (batches * rpb)) * 1000} / 1,000줄`);
    assert.ok(Math.abs(quads - mean) <= 4 * Math.sqrt(variance), `${quads} vs ${mean} ± ${(4 * Math.sqrt(variance)).toFixed(1)}`);
    assert.ok(g.state.blocks.every((b) => b.quad === 0 || b.kind === CHOG), "출시: Golden은 2×2가 아니다");
  });

  it("the row below copies the anchor's health at generation (a 2×2 struck before its lower row exists keeps one health)", () => {
    const c = quadCatalog(10000, 0);
    const rr = catalogFixedRows(c)[CHOG]![0]!;
    const g = generate(c, 5, rr + 1);
    const anchor = g.state.blocks.find((b) => b.y === rr && b.quad === 1);
    assert.ok(anchor);
    anchor.health = 1234.5;
    mirrorQuad(g.state.blocks, c.world.width, anchor);   // 아래 줄이 아직 없다 — 건너뛴다
    assert.equal(cellAt(g.state, c, anchor.x + 1, rr)!.health, 1234.5);
    generateBlockRows(g.state, c, 1, g.factoryFor(999), 999);
    assert.deepEqual([cellAt(g.state, c, anchor.x, rr + 1), cellAt(g.state, c, anchor.x + 1, rr + 1)].map((b) => [b?.quad, b?.health]), [[3, 1234.5], [4, 1234.5]]);
  });

  it("a 30-row ring: overwriting the top row of a 2×2 also empties its lower half — no live 2×2 cell without its anchor at any row (Ore + Golden 10,000)", () => {
    const c = quadCatalog(10000, 10000);
    const W = c.world.width;
    const ring = c.world.height * c.world.ringBufferRowMultiplier;
    const seed = seedFrom(9);
    const state = {
      blocks: createRingBuffer(c), generatedRowCount: 0, batchIndex: -1, batchRemaining: [], batchKinds: [], batchRowWindows: [], pickaxes: [],
    } as unknown as RoomState;
    assert.equal(state.blocks.length, W * ring);
    const problems: string[] = [];
    let emptied = 0;
    for (let y = 0; y < 3 * (c.limits.batchBlocks / W); y++) {
      const below: BlockState[] = [];
      for (let x = 0; x < W; x++) {
        const old = state.blocks[(y % ring) * W + x]!;
        if ((old.quad === 1 || old.quad === 2) && old.y === y - ring) {
          const b = state.blocks[((y + 1) % ring) * W + x]!;
          if (b.y === old.y + 1 && b.health > 0) below.push(b);
        }
      }
      generateBlockRows(state, c, 1, windowFactory(seed, 1, y), y);
      for (const b of below) { assert.equal(b.health, 0, `(${b.x}, ${b.y}) q${b.quad}`); emptied += 1; }
      problems.push(...rules12Violations(c, state, y));
    }
    assert.deepEqual(problems, []);
    assert.ok(emptied >= 50, `아래 칸을 지운 수 ${emptied}`);
  });
});

/** 빈 링(30줄)에 2×2 하나 — 앵커 (ax, ay), 묶음 체력 health (lower = false면 위 줄만). */
function quadRing(c: Catalog, kind: number, ax: number, ay: number, health: number, lower = true): BlockState[] {
  const W = c.world.width;
  const blocks: BlockState[] = [];
  for (let y = 0; y < 30; y++) for (let x = 0; x < W; x++) blocks.push({ kind: 0, x, y, health: 0, quad: 0 });
  const put = (x: number, y: number, q: number) => { blocks[y * W + x] = { kind, x, y, health, quad: q }; };
  put(ax, ay, 1);
  put(ax + 1, ay, 2);
  if (lower) { put(ax, ay + 1, 3); put(ax + 1, ay + 1, 4); }
  return blocks;
}
/** 같은 자리에 1칸 블록 넷. */
function singleRing(c: Catalog, kind: number, ax: number, ay: number, health: number): BlockState[] {
  const blocks = quadRing(c, kind, ax, ay, health);
  for (const b of blocks) b.quad = 0;
  return blocks;
}

describe("2×2 physics and reward (spec 25 §3.4.3 · §3.4.4): one hit per body per tick on the anchor, four cells one health, LAST HIT × 4", () => {
  const circleCatalog = (): Catalog => {
    const c = structuredClone(shipped);
    for (const t of c.pickaxes) t.hitbox = { shape: "circle" };
    c.bots[0]!.hitbox = { shape: "circle" };
    return parseCatalog(c);
  };
  const bodyAt = (c: Catalog, who: "player" | "bot", x: number, y: number): PickaxeState => {
    if (who === "player") return Object.assign(player(c, 0, "1:0", x, y), { vy: 0 });
    const b = c.bots[0]!;
    return createPickaxe(x, y, { tier: 0, scale: b.scale, attack: b.attack, frictionPerTick: b.frictionPerTick, vy: 0 });
  };

  for (const shape of ["circle", "pickaxe"] as const) {
    it(`a ${shape} body over all four cells strikes the 2×2 once (HitEvent.block = anchor) and the four cells keep one health; four single blocks take several hits — players and bots`, () => {
      const c = shape === "circle" ? circleCatalog() : shipped;
      const physics = physicsFor(c);
      const hp = c.blocks[CHOG]!.hp;
      for (const who of ["player", "bot"] as const) {
        const singles = singleRing(c, CHOG, 4, 12, hp);
        const sHits = physics.advancePickaxe(bodyAt(c, who, 5, 13), singles, c.world.width, fixedRng(7));
        assert.ok(sHits.length >= 2, `${who}: 1칸 넷이면 여러 타 (${sHits.length})`);
        const blocks = quadRing(c, CHOG, 4, 12, 4 * hp);
        const body = bodyAt(c, who, 5, 13);
        const hits = physics.advancePickaxe(body, blocks, c.world.width, fixedRng(7));
        assert.equal(hits.length, 1, `${who}: 2×2는 1타`);
        const anchor = blocks[12 * c.world.width + 4]!;
        assert.equal(hits[0]!.block, anchor);
        const damage = who === "player" ? c.pickaxes[0]!.attack : c.bots[0]!.attack;
        assert.equal(hits[0]!.damage, damage);
        assert.deepEqual([[4, 12], [5, 12], [4, 13], [5, 13]].map(([x, y]) => blocks[y! * c.world.width + x!]!.health), new Array(4).fill(4 * hp - damage));
      }
    });
  }

  it("the hit that empties the anchor empties all four cells (none active); a top row alone (lower row not generated yet) is struck and mirrored without error", () => {
    const c = circleCatalog();
    const physics = physicsFor(c);
    const W = c.world.width;
    const blocks = quadRing(c, CHOG, 4, 12, 1);
    const hits = physics.advancePickaxe(Object.assign(player(c, 0, "1:0", 5, 13), { vy: 0 }), blocks, W, fixedRng(7));
    assert.deepEqual(hits.map((h) => [h.block.quad, h.damage, h.destroyed]), [[1, 1, true]]);
    for (const [x, y] of [[4, 12], [5, 12], [4, 13], [5, 13]] as const) assert.equal(getActiveBlockFromRingBuffer(blocks, W, x, y), null, `(${x}, ${y})`);
    const top = quadRing(c, CHOG, 4, 12, 500, false);
    const th = physics.advancePickaxe(Object.assign(player(c, 0, "1:0", 5, 11.6), { vy: 0.2 }), top, W, fixedRng(7));
    assert.equal(th.length, 1);
    assert.equal(th[0]!.block, top[12 * W + 4]);
    assert.equal(top[12 * W + 5]!.health, top[12 * W + 4]!.health);
    assert.ok(top[12 * W + 4]!.health < 500);
  });

  it("quadAnchor maps q 2 · 3 · 4 to the top-left cell and throws on a dangling cell; mirrorQuad copies the anchor's health only to cells that are there", () => {
    const c = shipped;
    const W = c.world.width;
    const blocks = quadRing(c, GOLD, 2, 20, 77);
    const anchor = blocks[20 * W + 2]!;
    for (const [x, y] of [[2, 20], [3, 20], [2, 21], [3, 21]] as const) assert.equal(quadAnchor(blocks, W, blocks[y * W + x]!), anchor);
    const single: BlockState = { kind: DIRT, x: 0, y: 5, health: 100, quad: 0 };
    assert.equal(quadAnchor(blocks, W, single), single);
    anchor.health = 5;
    mirrorQuad(blocks, W, anchor);
    assert.deepEqual([blocks[20 * W + 3]!.health, blocks[21 * W + 2]!.health, blocks[21 * W + 3]!.health], [5, 5, 5]);
    const dangling = quadRing(c, GOLD, 2, 20, 77);
    dangling[20 * W + 2] = { kind: DIRT, x: 2, y: 20, health: 100, quad: 0 };   // 앵커 자리에 다른 블록
    assert.throws(() => quadAnchor(dangling, W, dangling[21 * W + 3]!), /quadAnchor: no anchor/);
  });

  it("LAST HIT on a 2×2 (anchor, quad 1) pays catalogLastHitMilli × 4 within the per-pickaxe LAST HIT cap; condition and new-block count stay per cell (one new block)", () => {
    const c = shipped;
    for (let tier = 0; tier < c.pickaxes.length; tier++) {
      const one = catalogLastHitMilli(c, tier, CHOG);
      assert.ok(one > 0, `tier ${tier}: CHOG hp > attack`);
      assert.equal(lastHitPrizeMilli(c, tier, { kind: CHOG, quad: 1 }), QUAD_HP_MULT * one);
      for (const q of [0, 2, 3, 4]) assert.equal(lastHitPrizeMilli(c, tier, { kind: CHOG, quad: q }), one);
      const p = player(c, tier);
      const anchor: BlockState = { kind: CHOG, x: 4, y: 12, health: 0, quad: 1 };
      applyHitReward(c, p, anchor, 1, { window: 1, tick: 1 }, true);
      assert.deepEqual([p.lastHits, p.lastHitMilli, p.touched.length], [1, Math.min(QUAD_HP_MULT * one, catalogLastHitCapMilli(c, tier)), 1]);
      assert.ok(QUAD_HP_MULT * one <= catalogLastHitCapMilli(c, tier), "출시 값: 상한 안 (BIG GAME 4,346 cr < 20,000)");
    }
  });
});

// ──────────────────────────────────────────────────────────────────────────
// 8) 정수 크레딧 정산 (명세 24 §3.10 — 규칙 11 그대로) — 단위
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
// 9) 바쁜 판 (8지갑 · 3,000윈도) — 틱마다 안전 · 불변식 · 아이템 배선 · COMBO · 정수 정산
// ──────────────────────────────────────────────────────────────────────────

/** `item|<키>|<h>` 스트림을 연 순간의 곡괭이. */
interface ItemDraw { key: string; h: number; tick: number; lastHits: number; buffCount: number; itemUntil: number; popStacks: number; steps: number; comboNow: boolean }
interface BusyOut {
  seedNo: number;
  state: RoomState;
  safety: Safety;
  spawned: SpawnRecord[];
  buffs: RoomBuffEvent[];
  lastHits: RoomLastHitEvent[];
  events: RoomBonusEvent[];
  payouts: EnginePayout[];
  ended: PickaxeResult[];
  jackpots: RoomJackpotEvent[];
  draws: ItemDraw[];
  struck: Set<string>;         // `<키>|<틱>|<x>,<y>,<종류>` — 플레이어 곡괭이가 친 블록 (2×2는 앵커)
  grownBodyTicks: number;
  maxEmbedGrown: number;       // 커진 몸(지름 > 등급 지름) 조각과 살아 있는 블록의 가장 깊은 겹침 (틱 끝)
  maxScale: number[];          // 등급별 최대 지름
  graced: Set<string>;         // 끝 조건이 참인 채 룰렛을 기다린 틱이 있는 곡괭이 (유예가 실제로 쓰임)
  revived: Set<string>;        // 내구도 0 → > 0 (유예 중 LIFE)
  quads: number;               // 생성된 2×2 (앵커)
  quadsCleared: number;        // 앵커 체력이 0이 된 2×2 (캐거나 균열) — 그때 네 칸 모두 0을 확인
  problems: string[];          // 틱 끝 불변식 위반 (rules12Violations 포함)
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
 *    커진 몸 겹침, 끝난 SPEED는 중력 ×1, 잭팟 contributed = pool + paid, rules12Violations(아이템 대기 · 2×2 네 칸), 유예 · 되살아남, 새 2×2 · 비워진 2×2
 *  - advancePickaxe 감싸기: 플레이어 곡괭이가 친 블록(2×2는 앵커 — quad 2~4가 나오면 위반)
 *  - 스트림 팩토리 감싸기: `item|<키>|<h>`를 여는 순간의 곡괭이 상태(h = lastHits − 1 · 대기 없음 · 상한 아래 · 같은 타격 COMBO 성장이 먼저)
 */
function runBusy(c: Catalog, seedNo: number, windows: number, wallets = 8): BusyOut {
  const seed = seedFrom(seedNo);
  const W = c.world.width;
  const b = c.buffs;
  const physics = physicsFor(c);
  const state = createRoom(c, windowFactory(seed, 1, 0), 1, 0);
  const out: BusyOut = {
    seedNo, state, safety: newSafety(), spawned: [], buffs: [], lastHits: [], events: [], payouts: [], ended: [], jackpots: [], draws: [], struck: new Set(),
    grownBodyTicks: 0, maxEmbedGrown: 0, maxScale: c.pickaxes.map(() => 0), graced: new Set(), revived: new Set(), quads: 0, quadsCleared: 0, problems: [],
  };
  const comboEvents = c.reward.combo !== undefined && c.pickaxes.every((t) => t.popPrize > 0);   // 그러면 COMBO 단계 수 = 사건 수
  const note = (msg: string) => { if (out.problems.length < 20) out.problems.push(msg); };
  const zeroDurability = new Set<string>();
  const anchorsHit: BlockState[] = [];
  const clearedAnchors = new Set<BlockState>();
  let scanned = state.generatedRowCount;
  for (const blk of state.blocks) if (blk.quad === 1) out.quads += 1;

  const advance = PhysicsEngine.prototype.advancePickaxe;
  PhysicsEngine.prototype.advancePickaxe = function (this: PhysicsEngine, p: PickaxeState, blocks: BlockState[], width: number, rng: Rng): HitEvent[] {
    const hits = advance.call(this, p, blocks, width, rng);
    for (const h of hits) {
      if (h.block.quad > 1) note(`${p.key}: hit on 2×2 cell q${h.block.quad} (not the anchor)`);
      if (h.block.quad === 1) anchorsHit.push(h.block);
      if (p.owner !== null) out.struck.add(`${p.key}|${state.tick}|${h.block.x},${h.block.y},${h.block.kind}`);
    }
    return hits;
  };

  const onTickEnd = (s: RoomState) => {
    const tick = s.tick - 1;
    for (const p of s.pickaxes) {
      if (p.owner === null) {
        if (p.scale !== c.bots[p.tier]!.scale || p.popStacks !== 0 || p.buffCount !== 0 || p.itemUntil !== 0) note(`bot ${p.key} changed`);
        continue;
      }
      const base = c.pickaxes[p.tier]!.scale;
      const cap = catalogScaleCap(c, p.tier);
      const boosted = s.sky.boosts.some((x) => x.key === p.key);
      const allowed = Math.max(cap, boosted ? skyGrowScale(c.skyEvent, base) : 0);
      if (p.scale > allowed + 1e-9) note(`${p.key} scale ${p.scale} > ${allowed}`);
      if (p.scaleTarget > cap + 1e-12 || p.scaleTarget < base) note(`${p.key} target ${p.scaleTarget} ∉ [${base}, ${cap}]`);
      if (b && comboEvents && p.popStacks !== Math.min(b.growMaxStacks, p.bonusEvents.length)) note(`${p.key} popStacks ${p.popStacks} vs ${p.bonusEvents.length} steps`);
      if (b && p.buffCount > b.items.maxPerPickaxe) note(`${p.key} buffCount ${p.buffCount}`);
      if (p.speedUntil === 0 && p.gravityMulBps !== GRAVITY_MUL_ONE_BPS) note(`${p.key} gravity ${p.gravityMulBps} after SPEED`);
      if (p.giantUntil === 0 && p.scaleTarget !== scaleTargetOf(c, p)) note(`${p.key} target not reset after GIANT`);
      if (p.scale > base + 1e-12) {
        out.grownBodyTicks += 1;
        out.maxEmbedGrown = Math.max(out.maxEmbedGrown, embedDepth(physics, c, p, s.blocks));
      }
      out.maxScale[p.tier] = Math.max(out.maxScale[p.tier]!, p.scale);
      // 유예: 끝 조건이 참인데 판에 남아 있다면 룰렛 대기 중이어야 한다
      const due = p.durabilityLeft <= 0 || tick + 1 - p.spawnTick >= c.limits.timerTicks || tick + 1 - p.lastDamageTick >= c.limits.stuckTicks;
      if (due) {
        if (p.itemUntil > 0) out.graced.add(p.key);
        else note(`${p.key} due at tick ${tick} without a pending roulette`);
      }
      if (zeroDurability.has(p.key) && p.durabilityLeft > 0) out.revived.add(p.key);
      if (p.durabilityLeft <= 0) zeroDurability.add(p.key);
      else zeroDurability.delete(p.key);
    }
    if (s.jackpot.contributedMilli !== s.jackpot.poolMilli + s.jackpot.paidMilli) note(`jackpot ${JSON.stringify(s.jackpot)}`);
    for (const v of rules12Violations(c, s, tick)) note(v);
    // 새 줄의 2×2
    for (; scanned < s.generatedRowCount; scanned++) for (let x = 0; x < W; x++) if (cellAt(s, c, x, scanned)?.quad === 1) out.quads += 1;
    // 체력이 0이 된 2×2: 네 칸 모두 0
    for (const a of anchorsHit) {
      if (a.health > 0 || clearedAnchors.has(a)) continue;
      clearedAnchors.add(a);
      out.quadsCleared += 1;
      for (const [dx, dy] of [[1, 0], [0, 1], [1, 1]] as const) {
        const cell = cellAt(s, c, a.x + dx, a.y + dy);
        if (cell && cell.health !== 0) note(`2×2 (${a.x}, ${a.y}) cleared but (${cell.x}, ${cell.y}) has ${cell.health}`);
      }
    }
    anchorsHit.length = 0;
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
        if (label.startsWith("item|")) {
          const [, key, h] = label.split("|") as [string, string, string];
          const p = state.pickaxes.find((q) => q.key === key);
          if (!p) note(`item stream for ${key} not on the board`);
          else {
            const last = p.bonusEvents.at(-1);
            out.draws.push({
              key, h: Number(h), tick: state.tick, lastHits: p.lastHits, buffCount: p.buffCount, itemUntil: p.itemUntil, popStacks: p.popStacks,
              steps: p.bonusEvents.length, comboNow: last !== undefined && last.tick === state.tick && last.window === w,
            });
          }
        }
        return base(label);
      };
      const res = runWindow(state, tapped, w, inputs, rng);
      out.spawned.push(...res.spawned);
      out.buffs.push(...res.buffs);
      out.lastHits.push(...res.lastHits);
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

/**
 * 막타 사건만으로 다시 센 아이템 (엔진 장부와 무관하게 — 명세 25 §3.3.2): 곡괭이마다 막타 순서 h, 대기(앞 당첨의 t₀ + R 틱까지)·상한이면 뽑지 않고,
 * 아니면 그 윈도 스트림 `item|<키>|<h>`의 첫 수로 당첨(catalogItemWins), 둘째 수로 종류(catalogBuffKind).
 */
function expectedItems(c: Catalog, r: BusyOut): { draws: number; items: Omit<RoomBuffEvent, "x" | "y">[] } {
  const it = itemsOf(c);
  const seed = seedFrom(r.seedNo);
  const per = new Map<string, { h: number; n: number; until: number }>();
  const items: Omit<RoomBuffEvent, "x" | "y">[] = [];
  let draws = 0;
  for (const e of r.lastHits) {
    const s = per.get(e.key) ?? { h: 0, n: 0, until: 0 };
    per.set(e.key, s);
    const h = s.h++;
    if (s.n >= it.maxPerPickaxe || (s.until > 0 && e.tick <= s.until)) continue;
    draws += 1;
    const stream = windowFactory(seed, 1, e.window)(`item|${e.key}|${h}`);
    if (!catalogItemWins(c, e.blockKind, streamU53(stream))) continue;
    const spec = catalogBuffKind(c, streamU53(stream));
    assert.ok(spec);
    items.push({ key: e.key, owner: e.owner, tier: e.tier, window: e.window, tick: e.tick, kind: spec.kind, n: s.n, h, blockKind: e.blockKind });
    s.n += 1;
    s.until = e.tick + it.rouletteTicks;
  }
  return { draws, items };
}

/** 아이템 배선: 사건 = 막타에서 다시 센 것, 칸 = 그 틱에 그 곡괭이가 친 블록(2×2 앵커), 스트림을 연 순간 = 뽑을 수 있는 상태 · COMBO 성장이 먼저. */
function checkItems(c: Catalog, r: BusyOut): void {
  const want = expectedItems(c, r);
  assert.deepEqual(r.buffs.map(({ x: _x, y: _y, ...rest }) => rest), want.items);
  for (const e of r.buffs) assert.ok(r.struck.has(`${e.key}|${e.tick}|${e.x},${e.y},${e.blockKind}`), `${e.key} #${e.n}: (${e.x}, ${e.y}) kind ${e.blockKind} struck at ${e.tick}`);
  assert.equal(r.draws.length, want.draws, "스트림을 연 수 = 뽑을 수 있던 막타 수");
  const max = itemsOf(c).maxPerPickaxe;
  const growMax = buffsOf(c).growMaxStacks;
  for (const d of r.draws) {
    assert.deepEqual([d.h, d.itemUntil], [d.lastHits - 1, 0], d.key);
    assert.ok(d.buffCount < max, d.key);
    if (c.reward.combo && c.pickaxes.every((t) => t.popPrize > 0)) assert.equal(d.popStacks, Math.min(growMax, d.steps), `${d.key}: COMBO 먼저`);
  }
}

const memo = new Map<string, BusyOut>();
function busy(c: Catalog, name: string, seedNo: number, windows: number): BusyOut {
  const k = `${name}|${seedNo}|${windows}`;
  let r = memo.get(k);
  if (!r) { r = runBusy(c, seedNo, windows); memo.set(k, r); }
  return r;
}

function c0(tier: number): number {
  return shipped.pickaxes[tier]!.scale;
}

describe("rules 12 room: the 8-wallet busy board (seed 99 × 3,000 windows) on the shipped catalog", () => {
  const run = () => busy(shipped, "shipped", 99, 3000);

  it("physics safety per tick: no throw, embedded 0, tunnelled 0; grown bodies overlap blocks ≤ 0.05; size ≤ max(catalogScaleCap, sky 2.5); invariants (items · 2×2) hold every tick", () => {
    const r = run();
    assert.deepEqual(r.problems, []);
    assert.equal(r.safety.embedded, 0, "박힘");
    assert.equal(r.safety.tunnelled, 0, "관통");
    assert.ok(r.safety.bodyTicks > 100_000, `몸-틱 ${r.safety.bodyTicks}`);
    assert.ok(r.grownBodyTicks > 10_000, `커진 몸-틱 ${r.grownBodyTicks}`);
    assert.ok(r.maxEmbedGrown <= 0.05, `커진 몸 겹침 최대 ${r.maxEmbedGrown}`);
    r.maxScale.forEach((s, t) => assert.ok(s > c0(t), `등급 ${t}가 실제로 커진다 (${s})`));
  });

  it("items are wired as specified: one draw per LAST HIT that may draw (no pending roulette, under maxPerPickaxe), `item|<key>|<h>` decides win and kind, the event cell is the struck block; COMBO growth of the same hit comes first", () => {
    const r = run();
    checkItems(shipped, r);
    assert.ok(r.buffs.length > 200, `아이템 ${r.buffs.length}`);
    const kinds = new Map<BuffKind, number>();
    for (const e of r.buffs) kinds.set(e.kind, (kinds.get(e.kind) ?? 0) + 1);
    for (const x of itemsOf(shipped).table) assert.ok((kinds.get(x.kind) ?? 0) > 20, `${x.kind} ${kinds.get(x.kind)}`);
    assert.ok(r.draws.filter((d) => d.comboNow).length > 10, "COMBO 단계이면서 막타인 타격이 있다(순서 시험에 이빨이 있다)");
    assert.ok(r.draws.length > r.buffs.length, "꽝도 있다");
  });

  it("grace in the room: some pickaxes wait for their roulette with an end condition already true, none lives past timerTicks + R", () => {
    const r = run();
    const R = itemsOf(shipped).rouletteTicks;
    assert.ok(r.graced.size > 0, `유예 ${r.graced.size}`);
    for (const e of r.ended) assert.ok(e.endTick + 1 - e.spawnTick <= shipped.limits.timerTicks + R, `${e.key} lived ${e.endTick + 1 - e.spawnTick}`);
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

  it("determinism: the same seed gives the same items and final hash, another seed differs (400 windows)", () => {
    const a = runBusy(shipped, 7, 400);
    const b = runBusy(shipped, 7, 400);
    const other = runBusy(shipped, 8, 400);
    assert.ok(a.buffs.length > 0);
    assert.deepEqual(a.buffs, b.buffs);
    assert.equal(roomHash(a.state), roomHash(b.state));
    assert.notDeepEqual(a.buffs, other.buffs);
    assert.notEqual(roomHash(a.state), roomHash(other.state));
  });

  // KIT(rules12) __BUSY8_R12__
});

// ──────────────────────────────────────────────────────────────────────────
// 10) 바쁜 판 — 시험 카탈로그 (명세 25 §5.3-7 = G2 시험 카탈로그): 아이템 확률 모두 10,000 · 2×2 Ore·Golden 10,000 · LIFE 가중 8 · minPool 1
// ──────────────────────────────────────────────────────────────────────────

/** 명세 25 §5.1 G2의 시험 카탈로그: 막타마다 아이템(상한까지), 모든 CHOG가 2×2, LIFE가 자주(유예 · 되살아남), 잭팟 균열이 잦다(Golden 2×2 균열 미러). */
function acceptCatalog(): Catalog {
  const c = structuredClone(shipped);
  const it = itemsOf(c);
  it.chanceBps = c.blocks.map(() => 10000);
  for (const x of it.table) if (x.kind === "LIFE") x.weight = 8;
  c.generation.quadChanceBps = c.blocks.map((_, k) => (k >= c.generation.fixedFromKind ? 10000 : 0));
  c.blocks[CHOG]!.hp = 2000;   // 2×2 Ore 8,000 — 3,000윈도 안에 캐서 비우고 2×2 막타(× 4)가 난다 (출시 20,160 × 4는 이 길이에 거의 안 비워진다)
  // 균열이 잦게(정수 잭팟 시험과 같은 값): 통 ≥ 10,000크레딧이면 κ × 가격 / 통 — Golden 2×2 균열이 네 칸을 비운다
  c.jackpot = { kindId: "chog_gold", contributionBpsByTier: c.pickaxes.map(() => 777), kappaPpm: 400_000, minPoolCredits: 10_000 };
  return parseCatalog(c);
}

/** 성장·GIANT 스트레스 카탈로그: 한 단계 +50 %, 8단계, 상한 ×3·3칸, 곡괭이당 아이템 8개(막타마다 당첨), GIANT(×2, 600틱) 가중이 크고 DASH 0.40 · SPEED ×3 — 큰 몸이 가장 많이 생기는 쪽. */
function stressCatalog(): Catalog {
  const c = structuredClone(shipped);
  const b = buffsOf(c);
  b.growStepBps = 5000;
  b.growMaxStacks = 8;
  b.scaleCap = { mulBps: 30000, tiles: 3 };
  b.items.maxPerPickaxe = 8;
  b.items.chanceBps = c.blocks.map(() => 10000);
  for (const x of b.items.table) {
    if (x.kind === "GIANT") { x.weight = 6; x.scaleBps = 20000; x.ticks = 600; }
    if (x.kind === "DASH") { x.weight = 2; x.speed = 0.4; }
    if (x.kind === "SPEED") { x.weight = 2; x.gravityBps = 30000; x.ticks = 600; }
  }
  return parseCatalog(c);
}

describe("rules 12 room (spec 25 §5.3-7): 8 wallets × 3,000 windows on the test catalog — items on every LAST HIT, every CHOG a 2×2, LIFE × 8, frequent cracks", () => {
  const c = acceptCatalog();
  const run = () => busy(c, "accept", 41, 3000);

  it("no throw, embedded 0, tunnelled 0, invariant violations 0 (items · 2×2 four cells) every tick; no hit on a non-anchor 2×2 cell", () => {
    const r = run();
    assert.deepEqual(r.problems, []);
    assert.equal(r.safety.embedded, 0, "박힘");
    assert.equal(r.safety.tunnelled, 0, "관통");
    assert.ok(r.safety.bodyTicks > 100_000, `몸-틱 ${r.safety.bodyTicks}`);
  });

  it("2×2s are made and emptied (mined and cracked — a crack empties all four cells); LAST HIT on a 2×2 pays × 4 in the event", () => {
    const r = run();
    assert.ok(r.quads >= 20, `2×2 ${r.quads}`);
    assert.ok(r.quadsCleared >= 10, `비운 2×2 ${r.quadsCleared}`);
    assert.ok(r.jackpots.length >= 3, `균열 ${r.jackpots.length}`);
    assert.ok(r.jackpots.every((j) => j.blockKind === GOLD), "균열은 Golden(모두 2×2)");
    const quadLastHits = r.lastHits.filter((e) => e.blockKind >= c.generation.fixedFromKind && e.prizeMilli === QUAD_HP_MULT * catalogLastHitMilli(c, e.tier, e.blockKind));
    assert.ok(quadLastHits.length >= 5, `2×2 막타 ${quadLastHits.length}`);
    for (const e of r.lastHits) assert.ok(e.paidMilli <= e.prizeMilli);
  });

  it("items wired as specified (at most maxPerPickaxe, one pending at a time); grace is used and LIFE revives; nobody lives past timerTicks + R; settlements whole and equal to expectedSettlement", () => {
    const r = run();
    checkItems(c, r);
    const R = itemsOf(c).rouletteTicks;
    assert.ok(r.buffs.length >= 200, `아이템 ${r.buffs.length}`);
    assert.equal(r.draws.length, r.buffs.length, "확률 10,000: 뽑으면 당첨");
    assert.ok(r.graced.size >= 2, `유예 ${r.graced.size}`);   // 규칙 12 rev2 사다리 카탈로그로 판이 바뀌어 이 시드에서 2 (속성은 > 0)
    assert.ok(r.revived.size >= 1, `되살아남 ${r.revived.size}`);   // 같은 이유로 이 시드에서 1 (속성은 > 0)
    for (const e of r.ended) {
      assert.ok(e.endTick + 1 - e.spawnTick <= c.limits.timerTicks + R, `${e.key} lived ${e.endTick + 1 - e.spawnTick}`);
      const want = expectedSettlement(c, e);
      assert.deepEqual([e.paidMilli, e.overMilli], [want.payoutMilli, want.overMilli], e.key);
    }
  });
});

describe("rules 12 room: stress catalog (growth + 50 % × 8, GIANT × 2 for 600 ticks, 8 items per pickaxe, cap 3 tiles) — the safe-grow path under the most big bodies", () => {
  it("8 wallets × 1,500 windows: no throw, embedded 0, tunnelled 0, grown bodies overlap ≤ 0.05, size ≤ cap, items as specified", () => {
    const c = stressCatalog();
    const r = runBusy(c, 5, 1500);
    assert.deepEqual(r.problems, []);
    assert.equal(r.safety.embedded, 0, "박힘");
    assert.equal(r.safety.tunnelled, 0, "관통");
    assert.ok(r.maxEmbedGrown <= 0.05, `커진 몸 겹침 최대 ${r.maxEmbedGrown}`);
    checkItems(c, r);
    assert.ok(r.maxScale.some((s, t) => s >= catalogScaleCap(c, t) - 1e-9), `상한까지 커진 등급이 있다 (${r.maxScale.join(", ")})`);
  });
});

// ──────────────────────────────────────────────────────────────────────────
// 11) 정수 잭팟 (명세 24 §3.10 — 규칙 11 그대로): J = ⌊통 / 1000⌋ × 1000, 나머지는 통에
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
// 12) 상태 v13 (명세 25 §4.3 · §5.3-6) · 등급별 사다리
// ──────────────────────────────────────────────────────────────────────────

describe("state v13 (spec 25 §4.3)", () => {
  it("tag PIKIT/state/v13; JSON round trip keeps the hash with a pending item and 2×2s on the board; each new field (block quad · itemUntil · itemKind · itemAngle) and each rules-11 pickaxe field moves the hash", () => {
    assert.equal(STATE_ENCODING_TAG, "PIKIT/state/v13");
    const c = quadCatalog(10000, 0);
    const state = createRoom(c, windowFactory(seedFrom(1), 1, 0), 1, 0);
    const anchor = state.blocks.findIndex((b) => b.quad === 1);
    assert.ok(anchor >= 0, "처음 30줄에 Ore 2×2");
    const p = player(c, 2, "1:0", 5, -30);
    Object.assign(p, { popStacks: 2, buffCount: 2, giantUntil: 400, speedUntil: 310, gravityMulBps: 16000, itemUntil: 12, itemKind: 1, itemAngle: 0.75 });
    p.scaleTarget = scaleTargetOf(c, p);
    state.pickaxes.push(p);
    const h = roomHash(state);
    assert.equal(roomHash(cloneRoom(state)), h);
    for (const q of [0, 2, 3, 4]) {
      const s = cloneRoom(state);
      s.blocks[anchor]!.quad = q;
      assert.notEqual(roomHash(s), h, `quad ${q}`);
    }
    const fields: [keyof PickaxeState, number][] = [
      ["itemUntil", 13], ["itemKind", 2], ["itemAngle", 0.5],
      ["popStacks", 3], ["buffCount", 3], ["giantUntil", 401], ["speedUntil", 311], ["gravityMulBps", 10000], ["scaleTarget", p.scaleTarget + 0.125], ["durabilityTotal", p.durabilityTotal + 664],
    ];
    for (const [field, value] of fields) {
      const s = cloneRoom(state);
      Object.assign(s.pickaxes.at(-1)!, { [field]: value });
      assert.notEqual(roomHash(s), h, field);
    }
    const swapped = cloneRoom(state);
    Object.assign(swapped.pickaxes.at(-1)!, { itemUntil: 1, itemKind: 12 });
    assert.notEqual(roomHash(swapped), h, "칸 순서");
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
