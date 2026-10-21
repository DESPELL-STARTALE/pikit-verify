import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { catalogLastHitCapMilli, catalogLuckyCeilingMilli, catalogLuckyShare, luckyCeilingMilliOf, luckyPoolCount, MAX_OVER_MULTIPLE, MAX_REWARD_CAP_BPS } from "@pikit/protocol";
import {
  abnormalEndValueMilli, applyHitReward, baseCeilingMilli, createRoom, createStreamFactory, drawLuckyKind, earnedMilli, luckyRateMilli,
  overCapMilli, rewardCapMilli, runWindow, splitRewardMilli, tierOverCapsMilli, tierRewardCapsMilli, utf8, Xoshiro128ss,
  type BlockState, type SpawnRecord,
} from "../src/index.js";
import { busyBoard, createPickaxe, hmacSha256, loadCatalog, loadRules10Catalog, loadRules9Catalog, OWNERS, seedFrom, windowFactory } from "./helpers.js";

describe("Rng", () => {
  it("xoshiro128** matches the reference output for state {1, 2, 3, 4}", () => {
    const bytes = new Uint8Array([0, 0, 0, 1, 0, 0, 0, 2, 0, 0, 0, 3, 0, 0, 0, 4]);
    const r = Xoshiro128ss.fromBytes(bytes);
    // 참조 구현(prng.di.unimi.it/xoshiro128starstar.c)의 첫 출력들
    assert.deepEqual([r.nextU32(), r.nextU32(), r.nextU32(), r.nextU32()], [11520, 0, 5927040, 70819200]);
  });

  it("next() stays in [0, 1) and is reproducible", () => {
    const a = Xoshiro128ss.fromBytes(new Uint8Array(16).fill(7));
    const b = Xoshiro128ss.fromBytes(new Uint8Array(16).fill(7));
    for (let i = 0; i < 10000; i++) {
      const u = a.next();
      assert.ok(u >= 0 && u < 1);
      assert.strictEqual(u, b.next());
    }
  });

  it("rejects an all-zero state", () => {
    assert.throws(() => Xoshiro128ss.fromBytes(new Uint8Array(16)));
  });

  it("stream factory: same label continues the same stream, different labels are independent", () => {
    const f = createStreamFactory(hmacSha256, new Uint8Array(32).fill(1));
    const g = createStreamFactory(hmacSha256, new Uint8Array(32).fill(1));
    const first = f("kick|1:0").next();
    assert.notStrictEqual(f("kick|1:0").next(), first, "같은 이름표는 이어서 뽑는다");
    assert.strictEqual(g("kick|1:0").next(), first, "새 팩토리(새 윈도)는 0번째부터");
    assert.notStrictEqual(g("kick|1:1").next(), first);
  });

  it("utf8 encodes like the platform TextEncoder", () => {
    for (const s of ["", "PIKIT/stream/v1|kick|1:0", "흙길", "😀 é"]) {
      assert.deepEqual(utf8(s), new TextEncoder().encode(s));
    }
  });
});

// ──────────────────────────────────────────────────────────────────────────
// 보상 (규칙 7, D137 — 명세 16 §4.1·§4.8·§8.2): 기본 = β_t × 블록 값 × 피해, LUCKY, 상한
// (규칙 8, D215 — 명세 21) 사다리 위에 CHOG Ore · Golden CHOG. 둘은 LUCKY로 뽑히지 않는다(규칙 12: luckyWeight 0)
// (규칙 9 — 명세 22) 사다리 1 · 2 · 3 · 4 · 5 · 6 · 7 · 8 · 9 · 10 · 12 · 15 (다이아 ×10), 막타는 last-hit.test.ts
// ──────────────────────────────────────────────────────────────────────────

describe("reward hooks", () => {
  // (규칙 11) 이 표는 LIFE가 없는 규칙 10 카탈로그 사본으로 잰다 — 천장 β × max(v) × D. 출시 카탈로그(LIFE 있음)의 천장 β × max(v) × D_max는 rules12.test.ts.
  const catalog = loadRules10Catalog();
  const owner = OWNERS[0]!;
  const block = (kind: number, x: number, y: number): BlockState => ({ kind, x, y, health: catalog.blocks[kind]!.hp, quad: 0 });
  const player = (tier: number, luckyKind = -1) => {
    const t = catalog.pickaxes[tier]!;
    return createPickaxe(5, 5, { owner, tier, durabilityTotal: t.durability, durabilityLeft: t.durability, attack: t.attack, luckyKind });
  };
  const DIRT = 0;
  const DIAMOND = 9;
  const CHOG = 10;
  const CHOG_GOLD = 11;

  it("the shipped value ladder is 1 · 2 · 3 · 4 · 5 · 6 · 7 · 8 · 9 · 10 · 12 · 15 (Dirt … Diamond · CHOG Ore · Golden CHOG)", () => {
    assert.deepEqual(catalog.blocks.map((b) => b.value), [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 12, 15]);
    assert.deepEqual([catalog.blocks[CHOG]!.id, catalog.blocks[CHOG_GOLD]!.id], ["chog", "chog_gold"]);
  });

  it("(rules 8) a CHOG hit pays β_t × its value like any block — one Golden CHOG hit = 15 × one Dirt hit — and never LUCKY", () => {
    for (let tier = 0; tier < catalog.pickaxes.length; tier++) {
      const t = catalog.pickaxes[tier]!;
      for (const kind of [CHOG, CHOG_GOLD]) {
        const p = player(tier, DIAMOND);
        assert.equal(applyHitReward(catalog, p, block(kind, 1, 1), t.attack), Math.floor(t.beta * catalog.blocks[kind]!.value * t.attack * 1000));
        assert.equal(p.luckyMilli, 0);
        assert.equal(luckyRateMilli(catalog, tier, kind, 10_000), 0, "CHOG는 행운 종류가 될 수 없다 → 지급률 0");
      }
    }
  });

  it("value ladder: one Diamond hit pays exactly 10 × one Dirt hit (same damage, same tier, β_t of that tier)", () => {
    for (let tier = 0; tier < catalog.pickaxes.length; tier++) {
      const t = catalog.pickaxes[tier]!;
      const d = t.attack;
      const diamond = player(tier);
      const dirt5 = player(tier);
      assert.equal(applyHitReward(catalog, diamond, block(DIAMOND, 1, 1), d), Math.floor(t.beta * 10 * d * 1000));
      // 흙 10대(새 칸 10개 — POP·BIG POP 상금은 보너스로 따로 센다) = 다이아 1대: 이월 덕에 버림이 쌓이지 않는다
      for (let x = 0; x < 10; x++) applyHitReward(catalog, dirt5, block(DIRT, x % 10, 1 + Math.floor(x / 10)), d);
      assert.equal(dirt5.baseMilli, diamond.baseMilli, `tier ${tier}: 흙 10대 ${dirt5.baseMilli} vs 다이아 1대 ${diamond.baseMilli}`);
      const single = player(tier);
      applyHitReward(catalog, single, block(DIRT, 1, 1), d);
      assert.equal(single.baseMilli, Math.floor(t.beta * d * 1000));
      assert.ok(Math.abs(diamond.baseMilli + diamond.carryMilli - 10 * (single.baseMilli + single.carryMilli)) < 1e-6, "버리기 전 값은 정확히 10배");
    }
  });

  it("every kind pays floor(β_t × value × damage × 1000) on a fresh pickaxe", () => {
    for (let tier = 0; tier < catalog.pickaxes.length; tier++) {
      const t = catalog.pickaxes[tier]!;
      catalog.blocks.forEach((b, kind) => {
        const p = player(tier);
        applyHitReward(catalog, p, block(kind, 1, 1), 7.25);
        const raw = t.beta * b.value * 7.25 * 1000;
        assert.equal(p.baseMilli, Math.floor(raw), `tier ${tier} kind ${kind}`);
        assert.ok(Math.abs(p.carryMilli - (raw - Math.floor(raw))) < 1e-9);
      });
    }
  });

  it("base pay = floor(β·v·d·1000) with the fraction carried per pickaxe", () => {
    const p = player(0);
    const dirt = block(DIRT, 1, 1);
    const raw = catalog.pickaxes[0]!.beta * catalog.blocks[DIRT]!.value * 1 * 1000;   // β_×1 × 1 × 1 × 1000
    applyHitReward(catalog, p, dirt, 1);
    assert.equal(p.baseMilli, Math.floor(raw));
    assert.ok(Math.abs(p.carryMilli - (raw - Math.floor(raw))) < 1e-9);
    applyHitReward(catalog, p, dirt, 1);
    assert.equal(p.baseMilli, Math.floor(2 * raw), "버린 소수가 다음 타격에서 살아난다");
    for (let i = 0; i < 8; i++) applyHitReward(catalog, p, dirt, 1);
    assert.equal(p.baseMilli, Math.floor(10 * raw));
    assert.ok(p.carryMilli >= 0 && p.carryMilli < 1);
  });

  it("base pay never exceeds β × max(v) × D even when every point of durability hits the top kind (Golden CHOG)", () => {
    for (let tier = 0; tier < catalog.pickaxes.length; tier++) {
      const p = player(tier);
      const d = catalog.pickaxes[tier]!.durability;
      let left = d;
      let x = 0;
      while (left > 0) {
        const dmg = Math.min(7.3, left);
        left -= dmg;
        applyHitReward(catalog, p, block(CHOG_GOLD, x++ % 10, 3), dmg);
      }
      assert.ok(p.baseMilli <= baseCeilingMilli(catalog, tier));
      applyHitReward(catalog, p, block(CHOG_GOLD, 0, 4), 1000);   // 내구도를 넘는 피해(물리상 불가) — 천장 가드
      assert.equal(p.baseMilli, baseCeilingMilli(catalog, tier));
    }
  });

  it("bots earn nothing", () => {
    const bot = createPickaxe(5, 5, {});
    assert.equal(bot.luckyKind, -1);
    assert.equal(applyHitReward(catalog, bot, block(DIAMOND, 1, 1), 100), 0);
    assert.deepEqual([bot.baseMilli, bot.luckyMilli, bot.bonusMilli], [0, 0, 0]);
  });

  it("abnormal end value = min(P, E + u·P) with E = base + lucky + bonus", () => {
    const p = player(0);
    p.priceMilli = 3_000_000;
    p.baseMilli = 400_000;
    p.luckyMilli = 100_000;
    p.durabilityLeft = p.durabilityTotal / 2;
    assert.equal(earnedMilli(p), 500_000);
    assert.equal(abnormalEndValueMilli(p), 2_000_000);
    p.bonusMilli = 2_000_000;
    assert.equal(abnormalEndValueMilli(p), 3_000_000, "가격을 넘지 않는다");
  });
});

describe("LUCKY (rules 7, spec 16 §4.8; rules 12 — spec 25 §3.2: drawn by luckyWeight, CHOG kinds weight 0)", () => {
  const catalog = loadCatalog();
  const owner = OWNERS[0]!;
  const N = luckyPoolCount(catalog);   // = Σ luckyWeight (출시: 흙~다이아 1씩 = 10)
  const counts = catalog.blocks.map((b) => b.luckyWeight);
  const starts = counts.map((_, k) => counts.slice(0, k).reduce((a, b) => a + b, 0));
  const eligible = counts.map((_, k) => k).filter((k) => counts[k]! > 0);
  const player = (tier: number, luckyKind: number) => {
    const t = catalog.pickaxes[tier]!;
    return createPickaxe(5, 5, { owner, tier, durabilityTotal: t.durability, durabilityLeft: t.durability, attack: t.attack, luckyKind });
  };

  it("drawLuckyKind: index = floor(u × Σ luckyWeight), kinds in luckyWeight proportions with exact boundaries, CHOG never", () => {
    assert.equal(N, 10, "출시: 흙~다이아 1씩");
    assert.deepEqual(eligible, [0, 1, 2, 3, 4, 5, 6, 7, 8, 9], "Dirt … Diamond만 뽑힌다");
    assert.equal(counts.reduce((a, b) => a + b, 0), N);
    const seen = new Array<number>(counts.length).fill(0);
    for (let i = 0; i < N; i++) seen[drawLuckyKind(catalog, (i + 0.5) / N)]! += 1;
    assert.deepEqual(seen, counts, "풀의 칸 한 번씩 = luckyWeight 그대로 (CHOG 두 종류는 0)");
    for (const k of eligible) {
      const c = counts[k]!;
      assert.equal(drawLuckyKind(catalog, starts[k]! / N), k, `kind ${k} 첫 칸`);
      assert.equal(drawLuckyKind(catalog, (starts[k]! + c) / N - 1e-12), k, `kind ${k} 끝 칸`);
      if (k > 0) assert.equal(drawLuckyKind(catalog, starts[k]! / N - 1e-12), k - 1, `kind ${k} 바로 앞`);
    }
    assert.equal(drawLuckyKind(catalog, 0), 0);
    assert.equal(drawLuckyKind(catalog, 1 - 2 ** -32), 9, "가장 큰 u (xoshiro next의 최대) = 다이아 (CHOG가 아니다)");
    assert.throws(() => drawLuckyKind(catalog, 1), /out of range/);
  });

  it("luckyRateMilli = share × Σw ÷ w_X × price × 1000 ÷ D, 0 for CHOG (uniform weights: every kind the same rate)", () => {
    for (let tier = 0; tier < catalog.pickaxes.length; tier++) {
      const t = catalog.pickaxes[tier]!;
      counts.forEach((c, k) => {
        const expected = c > 0 ? (((catalogLuckyShare(catalog, tier) * N) / c) * t.priceCredits * 1000) / t.durability : 0;
        assert.ok(Math.abs(luckyRateMilli(catalog, tier, k, 10_000) - expected) < 1e-9, `tier ${tier} kind ${k}`);
      });
    }
    for (const k of eligible) assert.equal(luckyRateMilli(catalog, 0, k, 10_000), luckyRateMilli(catalog, 0, 0, 10_000), "고른 가중 = 종류마다 같은 지급률");
    const off = structuredClone(catalog);
    off.lucky.shareByTier = off.lucky.shareByTier.map(() => 0);
    assert.equal(luckyRateMilli(off, 0, 9, 10_000), 0);
  });

  it("only hits on the pickaxe's lucky kind pay, luckyRateMilli × damage with floor + carry", () => {
    for (const lucky of [0, 6, 9]) {
      const p = player(1, lucky);
      const rate = luckyRateMilli(catalog, 1, lucky, 10_000);
      let x = 0;
      for (let k = 0; k < counts.length; k++) if (k !== lucky) applyHitReward(catalog, p, { kind: k, x: x++, y: 2, health: 1, quad: 0 }, 50);
      assert.equal(p.luckyMilli, 0, "행운 종류가 아닌 블록은 LUCKY 몫이 없다");
      let raw = 0;
      for (const dmg of [3.3, 1, 0.7, 12]) {
        raw += rate * dmg;
        const before = earnedMilli(p);
        const credited = applyHitReward(catalog, p, { kind: lucky, x: 0, y: 7, health: 1, quad: 0 }, dmg);
        assert.equal(credited, earnedMilli(p) - before, "반환값 = 이번 적립");
        assert.equal(p.luckyMilli, Math.floor(raw + 1e-9), `lucky ${lucky} after ${dmg}`);
        assert.ok(p.luckyCarryMilli >= 0 && p.luckyCarryMilli < 1);
      }
    }
  });

  it("luckyMilli never exceeds its ceiling (all of D on the lucky kind = share × Σw ÷ w_X × price), ≤ catalogLuckyCeilingMilli", () => {
    for (let tier = 0; tier < catalog.pickaxes.length; tier++) {
      const t = catalog.pickaxes[tier]!;
      for (const lucky of [0, 9]) {
        const p = player(tier, lucky);
        let left = t.durability;
        while (left > 0) {
          const dmg = Math.min(t.attack, left);
          left -= dmg;
          applyHitReward(catalog, p, { kind: lucky, x: 0, y: 0, health: 1, quad: 0 }, dmg);
        }
        const ceil = Math.floor(((catalogLuckyShare(catalog, tier) * N) / counts[lucky]!) * t.priceCredits * 1000);
        assert.ok(p.luckyMilli <= ceil && p.luckyMilli >= ceil - 1, `tier ${tier} lucky ${lucky}: ${p.luckyMilli} vs ${ceil}`);
        applyHitReward(catalog, p, { kind: lucky, x: 0, y: 0, health: 1, quad: 0 }, t.durability);   // 내구도를 넘는 피해 — 가드
        assert.equal(p.luckyMilli, ceil);
        assert.ok(p.luckyMilli <= catalogLuckyCeilingMilli(catalog, tier));
      }
    }
  });

  it("a pickaxe's lucky kind is drawn from `lucky|<key>` at placement, reported in SpawnRecord, PickaxeState and PickaxeResult; bots have −1", () => {
    const seed = seedFrom(61);
    const state = createRoom(catalog, windowFactory(seed, 1, 0), 1, 0);
    assert.ok(state.pickaxes.length > 0 && state.pickaxes.every((p) => p.owner === null && p.luckyKind === -1), "봇은 −1");
    const spawned = new Map<string, SpawnRecord>();
    for (let w = 1; w <= 900; w++) {
      const inputs = w === 1 ? OWNERS.map((o, i) => ({ type: "purchase" as const, ref: String(i + 1), owner: o, tiers: [i, 0, 2, 2, 1, 1] })) : [];
      const res = runWindow(state, catalog, w, inputs, windowFactory(seed, 1, w));
      for (const rec of res.spawned) {
        spawned.set(rec.key, rec);
        assert.equal(rec.luckyKind, drawLuckyKind(catalog, windowFactory(seed, 1, w)(`lucky|${rec.key}`).next()), `${rec.key}: lucky|키 첫 수`);
        assert.ok(catalog.blocks[rec.luckyKind]!.luckyWeight > 0, `${rec.key}: 행운 종류는 CHOG가 아니다`);
        assert.equal(state.pickaxes.find((p) => p.key === rec.key)!.luckyKind, rec.luckyKind);
      }
      assert.ok(state.pickaxes.every((p) => (p.owner === null) === (p.luckyKind === -1)));
    }
    assert.ok(spawned.size >= 12, `스폰 ${spawned.size}`);
    for (const r of state.results) {
      assert.equal(r.luckyKind, spawned.get(r.key)!.luckyKind);
      const ceil = luckyCeilingMilliOf(catalog, r.tier, r.luckyKind, r.luckyMultBps, r.durabilityTotal / catalog.pickaxes[r.tier]!.durability);
      assert.ok(r.luckyMilli >= 0 && r.luckyMilli <= ceil);
    }
    assert.ok(new Set([...spawned.values()].map((s) => s.luckyKind)).size >= 3, "여러 종류가 뽑혀야 의미 있다");
  });

  it("busy board: luckyMilli ≤ ceiling for every pickaxe, and some pickaxes do earn lucky pay", () => {
    const run = busyBoard(catalog, 7, 1500, 6);
    let withLucky = 0;
    for (const r of run.results) {
      assert.ok(r.luckyKind >= 0 && r.luckyKind < counts.length && catalog.blocks[r.luckyKind]!.luckyWeight > 0);
      assert.ok(r.luckyMilli <= catalogLuckyCeilingMilli(catalog, r.tier));
      if (r.luckyMilli > 0) withLucky += 1;
    }
    assert.ok(withLucky > 0, "LUCKY 몫을 받은 곡괭이가 있어야 함");
  });
});

describe("caps (rules 7, spec 16 §4.1·§8.3; rules 9 numbers — spec 22 §6)", () => {
  // (규칙 10) 규칙 9 over 상한 식은 totalCapBps가 없는 카탈로그의 식이다 → 규칙 9 카탈로그로 잰다. 규칙 10 over 상한(40·P − 0.9·P)은 아래 시험·rules10.test.ts.
  // (W3 키트 결정) 이 표는 규칙 9 고정값(catalog-rules9.json) — 규칙 10 출시 숫자가 바뀌어도 그대로. 규칙 10 over 상한은 위 시험.
  const catalog = loadRules9Catalog();

  it("(rules 10) the shipped catalog's over cap = total cap − REWARD cap = 39.1 × price", () => {
    const r10 = loadCatalog();
    r10.pickaxes.forEach((t, tier) => {
      assert.equal(overCapMilli(r10, tier), 40 * t.priceCredits * 1000 - rewardCapMilli(r10, tier));
      assert.equal(rewardCapMilli(r10, tier), Math.floor((t.priceCredits * 1000 * 9000) / 10000));
      assert.ok(overCapMilli(r10, tier) <= MAX_OVER_MULTIPLE * t.priceCredits * 1000);
    });
  });

  it("REWARD cap = floor(price × 1000 × rewardCapBps ÷ 10,000) = 0.9 × price; over cap = base ceiling + LUCKY ceiling + bonusCap + LAST HIT cap − REWARD cap", () => {
    assert.equal(catalog.reward.rewardCapBps, 9000);
    assert.ok(catalog.reward.rewardCapBps <= MAX_REWARD_CAP_BPS);
    assert.deepEqual(tierRewardCapsMilli(catalog), [900_000, 1_800_000, 4_500_000, 9_000_000, 18_000_000]);
    // (규칙 12) LUCKY 천장이 share × Σw ÷ min(w > 0)(사본 luckyWeight 1씩 → 0.8·P)라 규칙 9 값(…, 8.8·P)보다 8.01·P 작다
    assert.deepEqual(tierOverCapsMilli(catalog), [2_963_739, 5_514_700, 12_558_745, 23_631_910, 44_707_694]);
    catalog.pickaxes.forEach((t, tier) => {
      assert.equal(rewardCapMilli(catalog, tier), Math.floor((t.priceCredits * 1000 * 9000) / 10000));
      assert.equal(overCapMilli(catalog, tier),
        baseCeilingMilli(catalog, tier) + catalogLuckyCeilingMilli(catalog, tier) + t.bonusCap * 1000 + catalogLastHitCapMilli(catalog, tier) - rewardCapMilli(catalog, tier));
      assert.equal(catalogLastHitCapMilli(catalog, tier), t.priceCredits * 1000, "막타 상한 = 가격 1배 (lastHitCapBps 10,000)");
      assert.ok(overCapMilli(catalog, tier) <= MAX_OVER_MULTIPLE * t.priceCredits * 1000, "over 상한 ≤ 체인 MAX");
      assert.ok(rewardCapMilli(catalog, tier) <= Math.floor(t.priceCredits * 1000 * 0.97));
    });
  });

  it("splitRewardMilli: payout = min(E, REWARD cap), over = E − payout", () => {
    const cap = rewardCapMilli(catalog, 0);
    assert.deepEqual(splitRewardMilli(catalog, 0, 0), { payoutMilli: 0, overMilli: 0 });
    assert.deepEqual(splitRewardMilli(catalog, 0, cap - 1), { payoutMilli: cap - 1, overMilli: 0 });
    assert.deepEqual(splitRewardMilli(catalog, 0, cap), { payoutMilli: cap, overMilli: 0 });
    assert.deepEqual(splitRewardMilli(catalog, 0, cap + 1), { payoutMilli: cap, overMilli: 1 });
    assert.deepEqual(splitRewardMilli(catalog, 0, 1_234_567), { payoutMilli: 900_000, overMilli: 334_567 });
  });
});

