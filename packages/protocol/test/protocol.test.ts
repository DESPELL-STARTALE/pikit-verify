import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import {
  canonicalHash, canonicalJson, type Catalog, catalogBaseCeilingMilli, catalogTotalCapMilli, catalogFixedRows, catalogLastHitCapMilli, catalogLastHitMilli, catalogLuckyCeilingMilli, catalogOverCapMilli, catalogRewardCapMilli, clearOfFixedRows, luckyPoolCount,
  FeedEvent, MAX_OVER_MULTIPLE, HistoryItem, InputLog, JoinOptions, parseCatalog, PickaxeHistoryRecord, PickaxeLiveState,
  isBigPayout, pikitLedgerAbi, QueueState, shortPlayerId,
  BatchView, MeView,
} from "../src/index.js";

const exampleUrl = new URL("../../catalog.example.json", import.meta.url);
const example = JSON.parse(readFileSync(exampleUrl, "utf8")) as unknown;

describe("catalog", () => {
  it("catalog.example.json passes the schema", () => {
    const c = parseCatalog(example);
    assert.equal(c.pickaxes.length, 5);
    assert.equal(c.blocks.reduce((s, b) => s + b.batchCount, 0), 2000);
  });

  it("rejects a batch whose kind counts do not add up", () => {
    const bad = structuredClone(example) as { blocks: { batchCount: number }[] };
    bad.blocks[0]!.batchCount += 1;
    assert.throws(() => parseCatalog(bad), /batchCount/);
  });

  it("(rules 8, spec 21) every block has a unique lowercase id and an explicit luckyEligible; the LUCKY pool must not be empty", () => {
    type B = { id?: unknown; luckyEligible?: unknown; batchCount: number };
    const bad = (f: (blocks: B[]) => void, re: RegExp) => {
      const x = structuredClone(example) as { blocks: B[] };
      f(x.blocks);
      assert.throws(() => parseCatalog(x), re);
    };
    bad((b) => { delete b[0]!.id; }, /id/);
    bad((b) => { delete b[0]!.luckyEligible; }, /luckyEligible/);
    bad((b) => { b[1]!.id = "dirt"; }, /blocks\[\]\.id must be unique/);
    bad((b) => { b[0]!.id = "Dirt"; }, /id/);
    bad((b) => { b[0]!.luckyEligible = "yes"; }, /luckyEligible/);
    bad((b) => { for (const x of b) x.luckyEligible = false; }, /at least one blocks\[\] entry must be luckyEligible/);
    const c = parseCatalog(example);
    assert.equal(luckyPoolCount(c), c.blocks.filter((b) => b.luckyEligible).reduce((a, b) => a + b.batchCount, 0));
  });

  it("frictionPerTick table matches (0.75^(1.3/fps))^(1/weight) within 1e-15 (rules 7 time scale 1.3: per-tick friction^1.3)", () => {
    // 규칙표를 만들 때의 확인용 계산(엔진 밖). Math.pow 결과는 V8 버전마다 마지막 비트가 다를 수 있어 오차를 허용한다.
    // physics.friction은 참고값(0.75^1.3을 6자리로 적음) — 표는 규칙 6 표(0.75)를 1.3제곱한 것이다(명세 16 §6.1)
    const c = parseCatalog(example);
    assert.ok(Math.abs(c.physics.friction - Math.pow(0.75, 1.3)) < 1e-6);
    const frame = Math.pow(0.75, 1.3 / c.physics.fps);
    for (const p of [...c.pickaxes, ...c.bots]) {
      const expected = Math.pow(frame, 1 / p.weight);
      assert.ok(Math.abs(p.frictionPerTick - expected) < 1e-15, `${p.code}: ${p.frictionPerTick} vs ${expected}`);
    }
  });
});

describe("shipped catalog (rules 10, spec 23: rules 9 + LUCKY PICK ladder + jackpot + ×1.7 HP ladder)", () => {
  const load = (name: string) => JSON.parse(readFileSync(new URL(`../../catalogs/${name}.json`, import.meta.url), "utf8")) as unknown;
  // (규칙 10) 출시 카탈로그 해시 — _analysis/rules10/kit/fill-tests.mjs가 채운다. 규칙 9 해시(D228)는 test/fixtures/catalog-rules9.json 시험이 지킨다.
  const PUBLISHED_NORMAL = "0x02ad4c1dc0090f7df46820910565ce062cb227c2afcf79d300e915b24902a1fd";
  // 규칙 7 날 5점 재맞춤 (명세 16 §5.2): 외날 FE·FC·VD, 양날 WB·BM, 봇. 손잡이는 모두 같다, handleDamage는 없다(어디로 맞아도 공격력)
  const handle = { shape: "pickaxe", headOffset: 0.24, handleLength: 0.66, handleRadius: 0.08, inertia: 0.1 } as const;
  const single = { ...handle, blade: { pts: [[0.287, -0.148], [0.277, -0.04], [0.45, 0], [0.114, 0.344], [-0.149, 0.381]], r: 0.05 } };
  const double = { ...handle, blade: { pts: [[0.015, -0.326], [0.177, -0.21], [0.398, 0], [0.211, 0.182], [0.025, 0.306]], r: 0.102 } };
  const bot = { ...handle, blade: { pts: [[0.188, -0.402], [0.284, -0.242], [0.444, 0], [0.261, 0.264], [0.034, 0.442]], r: 0.056 } };

  it("one room (D104): only NORMAL ships — LITE / HARDCORE catalogs are gone", () => {
    assert.throws(() => readFileSync(new URL("../../catalogs/lite.json", import.meta.url)), /ENOENT/);
    assert.throws(() => readFileSync(new URL("../../catalogs/hardcore.json", import.meta.url)), /ENOENT/);
  });

  it("NORMAL parses (rules 10, spec 23): no gate, 5-point blades, the bot slot, LUCKY + banded generation, ladder + jackpot, and matches the published table byte-for-byte", () => {
    const c = parseCatalog(load("normal"));
    assert.equal(c.rulesVersion, 10);
    assert.equal((c as unknown as Record<string, unknown>).gate, undefined, "황금 입구 삭제");
    assert.deepEqual(c.reward, { rewardCapBps: 9000, lastHitMult: 2, lastHitCapBps: 10000, totalCapBps: 400000 }, "총 상한 40 × 가격 (명세 23 §2.5)");
    assert.equal(c.luckyPick?.levels.length, 10, "사다리 10단계 ×1.1 … ×40 (명세 23 §2.2)");
    assert.deepEqual(c.luckyPick?.levels.map((l) => l.multBps), [11000, 12000, 13000, 15000, 20000, 30000, 50000, 100000, 200000, 400000]);
    assert.equal(c.jackpot?.kindId, "chog_gold");
    assert.equal(c.jackpot?.contributionBpsByTier.length, c.pickaxes.length);
    assert.deepEqual(c.lucky, { share: 0.08 });
    assert.deepEqual(c.generation, { bandedFromKind: 6, bandMargin: 1, fixedFromKind: 10, fixedClearRows: 2, fixedClearKinds: [9] });
    // 봇 = 예전 Blood Moon 몸(지름 2, 무게 4, 공격력 135.7) + 봇 날 — 등급 ×20(공격력 1,220)과 떨어져 있다 (D104)
    assert.deepEqual(c.bots, [{ code: "BOT", count: 3, attack: 135.7, scale: 2, weight: 4, frictionPerTick: 0.9968882956338715, hitbox: bot }]);
    for (const t of c.pickaxes) assert.deepEqual(t.hitbox, t.tier <= 2 ? single : double, t.code);
    assert.equal(canonicalHash(c), PUBLISHED_NORMAL);
  });

  it("rules 10 economy (spec 23 §2): 12 kinds, R9 value ladder up to Golden CHOG, ×1.7 HP ladder, CHOG kinds out of LUCKY, per-tier β refitted, POP · BIG POP as rules 7; example catalog = NORMAL", () => {
    const n = parseCatalog(load("normal"));
    const m = [1, 2, 5, 10, 20];
    assert.deepEqual(n.pickaxes.map((p) => p.code), ["FE", "FC", "VD", "WB", "BM"]);
    assert.deepEqual(n.pickaxes.map((p) => p.priceCredits), m.map((x) => 1000 * x));
    assert.deepEqual(n.pickaxes.map((p) => p.attack), m.map((x) => 61 * x));
    assert.deepEqual(n.pickaxes.map((p) => p.durability), m.map((x) => 1108 * x));
    assert.deepEqual(n.pickaxes.map((p) => p.scale), [1, 1.25, 1.5, 1.75, 2], "크기 사다리는 그대로");
    assert.deepEqual(n.blocks.map((b) => b.id), ["dirt", "clay", "gravel", "stone", "copper", "iron", "emerald", "gold", "netherite", "diamond", "chog", "chog_gold"]);
    assert.deepEqual(n.blocks.map((b) => b.name).slice(10), ["CHOG Ore", "Golden CHOG"]);
    assert.deepEqual(n.blocks.map((b) => b.value), [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 12, 15], "공개 블록 값 (규칙 9: 다이아 ×10, CHOG가 그 위)");
    // (규칙 10, 명세 23 §2.1 — 최종) hp_k = round2(100 × 1.7^k), k = 0…10, 골든 CHOG는 198,948.7 그대로(균열로만 깨진다)
    const round2 = (x: number) => Math.round(x * 100) / 100;
    assert.deepEqual(n.blocks.map((b) => b.hp), [...Array.from({ length: 11 }, (_, k) => round2(100 * 1.7 ** k)), 198948.7], "체력 = 100 × 1.7^k, 골든 CHOG 그대로");
    assert.deepEqual(n.blocks.map((b) => b.batchCount), [661, 452, 302, 201, 134, 89, 60, 40, 26, 18, 12, 5], "CHOG 자리는 흙에서");
    assert.deepEqual(n.blocks.map((b) => b.luckyEligible), [...new Array<boolean>(10).fill(true), false, false], "CHOG 두 종류는 LUCKY로 뽑히지 않는다");
    assert.equal(luckyPoolCount(n), 1983);
    assert.deepEqual(n.pickaxes.map((p) => p.beta), [0.060155, 0.049021, 0.041053, 0.034268, 0.02805], "출시 β (명세 23 §2.4 — 키트가 채움)");
    const beta = n.pickaxes.map((p) => p.beta);
    const rules9Beta = parseCatalog(JSON.parse(readFileSync(new URL("../../test/fixtures/catalog-rules9.json", import.meta.url), "utf8"))).pickaxes.map((p) => p.beta);
    for (let t = 0; t < beta.length; t++) {
      assert.equal(Math.round(beta[t]! * 1e6) / 1e6, beta[t], "β는 6자리");
      assert.ok(beta[t]! < rules9Beta[t]!, "규칙 10 β < 규칙 9 β (사다리·잭팟 몫만큼)");
      if (t > 0) assert.ok(beta[t]! < beta[t - 1]!, "등급이 오를수록 β가 작다");
    }
    assert.deepEqual(n.pickaxes.map((p) => p.popPrize), [305, 620, 1359, 2450, 4317]);
    assert.deepEqual(n.pickaxes.map((p) => p.bigPopPrize), m.map((x) => 200 * x), "BIG POP = 가격의 20%");
    assert.deepEqual(n.pickaxes.map((p) => p.bonusCap), n.pickaxes.map((p) => p.popPrize + p.bigPopPrize));
    assert.deepEqual(n.physics, {
      fps: 30, bounce: 0.75, gravity: 2.7603333333333335, friction: 0.687986, denominator: 4.615384615384615, minBounceVy: 0.325, maxSpin: 0.52,
      angularDamping: 0.9354933117266963, contactFriction: 0.4, headFirstTorque: 0.325, spinKick: 0.078,
    }, "시간 배율 1.3 (명세 16 §6.1)");
    assert.deepEqual(n.pickaxes.map((p) => p.frictionPerTick), [0.9876111583347639, 0.9920406758278139, 0.9944747768864999, 0.9959343580610697, 0.9968882956338715]);
    assert.equal(n.world.cameraLerp, 0.12800245492246298);
    assert.equal(canonicalHash(parseCatalog(example)), canonicalHash(n));
  });

  it("sky event (D125) stays, time-scaled 1.3× (spec 16 §6.1)", () => {
    const c = parseCatalog(load("normal"));
    assert.deepEqual(c.skyEvent, {
      minPlayers: 5, chancePerWindow: 0.002, cooldownWindows: 300,
      item: { diameter: 0.5, weight: 1, frictionPerTick: c.pickaxes[0]!.frictionPerTick, startVy: 0.13, vxJitter: 0.052, aboveRows: 2, catchRadius: 0.6, lifeTicks: 69 },
      grow: { scale: 2.5, stepPerTick: 0.13, durationTicks: 138 },
    });
    const noSky = structuredClone(load("normal")) as Record<string, unknown>;
    delete noSky.skyEvent;
    assert.throws(() => parseCatalog(noSky), /skyEvent/, "규칙 7은 하늘 절이 늘 있다(상태 태그 하나)");
  });

  it("sky event schema (D125): rejects bad values and unknown keys", () => {
    type Sky = Record<string, unknown> & { item: Record<string, unknown>; grow: Record<string, unknown> };
    const c = load("normal") as { skyEvent: Sky };
    const bad = (f: (s: Sky) => void, re: RegExp) => {
      const x = structuredClone(c);
      f(x.skyEvent);
      assert.throws(() => parseCatalog(x), re);
    };
    bad((s) => { s.minPlayers = 0; }, /minPlayers/);
    bad((s) => { s.chancePerWindow = 0; }, /chancePerWindow/);
    bad((s) => { s.chancePerWindow = 1; }, /chancePerWindow/);
    bad((s) => { s.cooldownWindows = -1; }, /cooldownWindows/);
    bad((s) => { s.item.diameter = 1; }, /diameter/);
    bad((s) => { s.item.lifeTicks = 0; }, /lifeTicks/);
    bad((s) => { s.item.catchRadius = 0; }, /catchRadius/);
    bad((s) => { s.grow.scale = 8.5; }, /grow\.scale exceeds/);
    bad((s) => { s.grow.durationTicks = 0; }, /durationTicks/);
    bad((s) => { s.bonus = 1; }, /bonus/);
    bad((s) => { s.item.payout = 1; }, /payout/);
    bad((s) => { s.grow.attackMul = 2; }, /attackMul/);
    const ok = structuredClone(c);
    ok.skyEvent.grow.scale = 8;
    parseCatalog(ok);
  });

  it("rules 10 caps (spec 23 §3.2, §6.4): REWARD cap = 0.9 × price, total cap = 40 × price, over cap = total cap − REWARD cap = 39.1 × price ≤ 100 × price", () => {
    const c = parseCatalog(load("normal"));
    assert.deepEqual(c.pickaxes.map((_, t) => catalogRewardCapMilli(c, t)), [900_000, 1_800_000, 4_500_000, 9_000_000, 18_000_000]);
    for (const p of c.pickaxes) {
      const price = p.priceCredits * 1000;
      assert.equal(catalogTotalCapMilli(c, p.tier), 40 * price);
      assert.equal(catalogOverCapMilli(c, p.tier), 40 * price - catalogRewardCapMilli(c, p.tier));
      assert.equal(catalogOverCapMilli(c, p.tier), (391 * price) / 10);
      assert.ok(catalogOverCapMilli(c, p.tier) <= MAX_OVER_MULTIPLE * price);
      assert.ok(catalogOverCapMilli(c, p.tier) >= catalogLuckyCeilingMilli(c, p.tier), "over 상한 ≥ LUCKY 최대 (명세 23 §6.4)");
    }
  });

  it("rules 9 caps on the rules-9 catalog (spec 16 §4.1, §8.1-8 + spec 22 §6): REWARD cap = 0.9 × price, over cap = base ceiling + LUCKY ceiling + bonus cap + LAST HIT cap − REWARD cap ≤ 100 × price", () => {
    const load = () => JSON.parse(readFileSync(new URL("../../test/fixtures/catalog-rules9.json", import.meta.url), "utf8")) as unknown;
    const c = parseCatalog(load());
    assert.equal(c.reward.totalCapBps, undefined);
    assert.deepEqual(c.pickaxes.map((_, t) => catalogRewardCapMilli(c, t)), [900_000, 1_800_000, 4_500_000, 9_000_000, 18_000_000]);
    // 기본 천장의 값은 가장 큰 값 = Golden CHOG
    assert.deepEqual(c.pickaxes.map((_, t) => catalogBaseCeilingMilli(c, t)), c.pickaxes.map((p) => Math.floor(p.beta * 15 * p.durability * 1000)));
    // LUCKY 천장 = share × LUCKY 풀 ÷ 18 (가장 드문 행운 종류 = 다이아 — CHOG는 뽑히지 않는다) × 가격 — 가격의 약 8.8배
    assert.deepEqual(c.pickaxes.map((_, t) => catalogLuckyCeilingMilli(c, t)), c.pickaxes.map((p) => Math.floor(((0.08 * 1983) / 18) * p.priceCredits * 1000)));
    for (const p of c.pickaxes) {
      const over = catalogOverCapMilli(c, p.tier);
      assert.equal(catalogLastHitCapMilli(c, p.tier), p.priceCredits * 1000, "막타 상한 = 가격 × lastHitCapBps ÷ 10,000 = 1배");
      assert.equal(over, catalogBaseCeilingMilli(c, p.tier) + catalogLuckyCeilingMilli(c, p.tier) + p.bonusCap * 1000 + catalogLastHitCapMilli(c, p.tier) - catalogRewardCapMilli(c, p.tier));
      assert.ok(over <= MAX_OVER_MULTIPLE * p.priceCredits * 1000, `${p.code} over cap ≤ 100 × price`);
      const most = (catalogRewardCapMilli(c, p.tier) + over) / (p.priceCredits * 1000);
      assert.ok(most > 11 && most < 12.5, `${p.code}: most one pickaxe can pay = ${most.toFixed(2)} × price (LUCKY ×8.8 + base ceiling + bonus + LAST HIT ×1)`);
    }
    for (const p of c.pickaxes) assert.equal(catalogTotalCapMilli(c, p.tier), catalogRewardCapMilli(c, p.tier) + catalogOverCapMilli(c, p.tier), "규칙 9: 총 상한 = REWARD 상한 + over 상한");
    // 스키마: rewardCapBps ≤ 9,700, over 상한 ≤ 100 × 가격, bonusCap = POP + BIG POP
    const raw = load() as { reward: Record<string, number>; pickaxes: Record<string, unknown>[]; lucky: { share: number } };
    const bad = (f: (x: typeof raw) => void, re: RegExp) => { const x = structuredClone(raw); f(x); assert.throws(() => parseCatalog(x), re); };
    bad((x) => { x.reward.rewardCapBps = 9701; }, /rewardCapBps/);
    // (규칙 9) 막타 두 칸은 필수, lastHitMult 0~5, lastHitCapBps 정수 0~100,000
    bad((x) => { delete x.reward.lastHitMult; }, /lastHitMult/);
    bad((x) => { delete x.reward.lastHitCapBps; }, /lastHitCapBps/);
    bad((x) => { x.reward.lastHitMult = 5.01; }, /lastHitMult/);
    bad((x) => { x.reward.lastHitMult = -1; }, /lastHitMult/);
    bad((x) => { x.reward.lastHitCapBps = 100_001; }, /lastHitCapBps/);
    bad((x) => { x.reward.lastHitCapBps = 0.5; }, /lastHitCapBps/);
    bad((x) => { x.pickaxes[0]!.bonusCap = 1; }, /bonusCap must equal/);
    bad((x) => { x.lucky.share = 1; x.pickaxes[0]!.beta = 50; }, /over-price cap/);
    bad((x) => { (x.pickaxes[0]!.hitbox as Record<string, unknown>).handleDamage = 0; }, /handleDamage|Unrecognized/);
  });

  it("(rules 9, spec 22 §3) LAST HIT prize = floor(lastHitMult × β_t × value × attack_t × 1000), only for blocks a tier cannot break in one hit", () => {
    const c = parseCatalog(load("normal"));
    for (const p of c.pickaxes) for (const b of c.blocks) {
      const want = b.hp > p.attack ? Math.floor(2 * p.beta * b.value * p.attack * 1000) : 0;
      assert.equal(catalogLastHitMilli(c, p.tier, b.kind), want, `${p.code} × ${b.id}`);
    }
    // 대상 (hp > 공격력): ×1 모두 · ×2 점토부터 · ×5 돌부터 · ×10 구리부터 · ×20 철부터 (규칙 10, 명세 23 §2.1)
    assert.deepEqual(c.pickaxes.map((p) => c.blocks.findIndex((b) => b.hp > p.attack)), [0, 1, 3, 4, 5]);
    // 표의 예 (키트가 채움): ×1 흙 · ×1 금 · ×20 금 막타
    assert.equal(catalogLastHitMilli(c, 0, 0), 7_338);
    assert.equal(catalogLastHitMilli(c, 0, 7), 58_711);
    assert.equal(catalogLastHitMilli(c, 4, 7), 547_536);
    const off = parseCatalog({ ...(load("normal") as object), reward: { ...c.reward, lastHitMult: 0 } });
    assert.equal(catalogLastHitMilli(off, 0, 7), 0, "lastHitMult 0 = 막타 없음");
    assert.throws(() => catalogLastHitMilli(c, 9, 0), /unknown tier/);
  });

  it("generation (spec 16 §7.1): band length ≥ 2 × margin + 1, banded kinds < width", () => {
    const raw = load("normal") as { generation: { bandedFromKind: number; bandMargin: number } };
    const bad = (f: (x: typeof raw) => void, re: RegExp) => { const x = structuredClone(raw); f(x); assert.throws(() => parseCatalog(x), re); };
    bad((x) => { x.generation.bandMargin = 2; }, /band too short/);     // 에메랄드 ⌊200 / 60⌋ = 3 < 5
    bad((x) => { x.generation.bandedFromKind = 12; }, /bandedFromKind/);
    // (규칙 8) 고정 줄: fixedFromKind 범위, 피하는 종류는 고정 아닌 띠 종류, 피한 뒤에도 띠마다 줄이 남아야 한다
    const g = (x0: unknown) => x0 as { generation: { fixedFromKind: number; fixedClearRows: number; fixedClearKinds: number[] } };
    bad((x) => { g(x).generation.fixedFromKind = 5; }, /fixedFromKind/);
    bad((x) => { g(x).generation.fixedFromKind = 13; }, /fixedFromKind/);
    bad((x) => { g(x).generation.fixedClearKinds = [10]; }, /fixedClearKinds/);
    bad((x) => { g(x).generation.fixedClearKinds = [5]; }, /fixedClearKinds/);
    bad((x) => { g(x).generation.fixedClearKinds = [9, 9]; }, /fixedClearKinds/);
    bad((x) => { g(x).generation.fixedClearRows = 8; }, /no row ≥ 9 rows away/);   // Ore 줄이 17줄마다라 ±8이면 남는 줄이 없다
    bad((x) => { x.generation.bandedFromKind = 0; }, /band too short|fewer than world\.width/);
    const ok = structuredClone(raw);
    ok.generation.bandedFromKind = 9;
    parseCatalog(ok);
  });

  it("(rules 8, spec 21 §3.6) fixed rows: CHOG Ore on each band's first-quarter row, Golden CHOG on the inner row farthest from them; Diamond rows clear of both by 3+", () => {
    const c = parseCatalog(load("normal"));
    const rows = catalogFixedRows(c);
    assert.deepEqual(rows.map((r, k) => (r.length ? k : -1)).filter((k) => k >= 0), [10, 11]);
    assert.deepEqual(rows[10], [4, 21, 38, 55, 72, 89, 106, 123, 140, 156, 172, 188]);
    assert.deepEqual(rows[11], [30, 64, 115, 148, 196]);
    assert.equal(clearOfFixedRows(c, 4), false);
    assert.equal(clearOfFixedRows(c, 6), false);
    assert.equal(clearOfFixedRows(c, 7), true);
    assert.deepEqual([clearOfFixedRows(c, 185), clearOfFixedRows(c, 186), clearOfFixedRows(c, 190), clearOfFixedRows(c, 191)], [true, false, false, true], "188 ± 2");
    const none = parseCatalog({ ...(load("normal") as object), generation: { bandedFromKind: 6, bandMargin: 1, fixedFromKind: 12, fixedClearRows: 2, fixedClearKinds: [] } });
    assert.ok(catalogFixedRows(none).every((r) => r.length === 0), "fixedFromKind = blocks.length → 고정 줄 없음 (규칙 7 방식)");
  });

  it("bot slot (D104): every field is required; bots no longer point at a tier", () => {
    const raw = load("normal") as { bots: Record<string, unknown>[] };
    for (const k of ["code", "count", "attack", "scale", "weight", "frictionPerTick", "hitbox"]) {
      const { [k]: _drop, ...rest } = raw.bots[0]!;
      assert.throws(() => parseCatalog({ ...raw, bots: [rest] }), Error, `missing ${k}`);
    }
    assert.throws(() => parseCatalog({ ...raw, bots: [{ ...raw.bots[0], tier: 4 }] }), /tier|Unrecognized/);
    assert.throws(() => parseCatalog({ ...raw, bots: [{ ...raw.bots[0], scale: 9 }] }), /bots\[0\]\.scale/);
  });
});

describe("canonical JSON", () => {
  it("is independent of key order and whitespace", () => {
    const a = { b: 1, a: [1, { y: 2, x: "é" }] };
    const b = JSON.parse('{ "a": [1, {"x":"é", "y":2}], "b": 1 }') as unknown;
    assert.equal(canonicalJson(a), '{"a":[1,{"x":"é","y":2}],"b":1}');
    assert.equal(canonicalHash(a), canonicalHash(b));
  });

  it("rejects non-finite numbers", () => {
    assert.throws(() => canonicalJson({ x: Number.NaN }));
  });

  it("gives the example catalog a stable rulesHash", () => {
    const h = canonicalHash(parseCatalog(example));
    assert.match(h, /^0x[0-9a-f]{64}$/);
    assert.equal(h, canonicalHash(JSON.parse(JSON.stringify(example))));
  });
});

describe("purchase / intent shapes", () => {
  const addr = `0x${"ab".repeat(20)}`;
  const h32 = `0x${"11".repeat(32)}`;

  it("join options use chainRoomId (Colyseus reserves roomId)", () => {
    JoinOptions.parse({ chainRoomId: 1, rulesVersion: 1 });
    assert.throws(() => JoinOptions.parse({ roomId: 1 }));
  });

  it("history item: queued rows have null end fields and wall-clock createdAt", () => {
    HistoryItem.parse({
      itemKey: "8812:0", owner: addr, roomId: 1, tier: 0, priceCredits: 3000, rulesVersion: 1, status: "QUEUED",
      enqueuedWindow: 100, spawnWindow: null, spawnTick: null, endWindow: null, endTick: null, endReason: null,
      hits: 0, distinctBlocks: 0, blocksBroken: 0, durabilityUsed: 0, durabilityTotal: null, pop: false, events: [],
      bigPop: false, luckyKind: -1, baseMilli: 0, luckyMilli: 0, bonusMilli: 0, lastHits: 0, lastHitMilli: 0, pickLevelBps: 0, pickMilli: 0, jackpotMilli: 0, paidMilli: null, overMilli: 0, pnlMilli: null,
      createdAt: "2026-10-06T00:00:00.000Z", spawnedAt: null, endedAt: null, settlement: null,
    });
  });

  it("contract ABIs come from the Foundry artifacts (abi/*.json = abi.generated.ts); only PikitLedger ships (rev 7, D4)", async () => {
    const { existsSync } = await import("node:fs");
    const json = (n: string) => JSON.parse(readFileSync(new URL(`../../abi/${n}.json`, import.meta.url), "utf8"));
    assert.deepEqual(json("PikitLedger"), pikitLedgerAbi);
    for (const gone of ["PikitVault", "PikitShop", "PikitFairness"]) assert.ok(!existsSync(new URL(`../../abi/${gone}.json`, import.meta.url)), `${gone} was removed`);
    const abi: readonly { type: string; name?: string; stateMutability?: string }[] = pikitLedgerAbi;
    const names = new Set(abi.map((x) => x.name));
    for (const n of ["postRoot", "revealSeed", "RootPosted", "AnnouncerChanged", "seedRoot", "genesisBlock", "rulesHash", "ledgerHash"]) assert.ok(names.has(n), n);
    assert.ok(abi.every((x) => x.stateMutability !== "payable"), "nothing payable");
  });

  it("rejects an input log with unordered windows", () => {
    assert.throws(() => InputLog.parse({
      schema: "pikit.inputlog/v0", rulesHash: h32, chainId: 143, shop: addr, roomId: 1, seed: h32, firstWindow: 0, lastWindow: 10,
      windows: [{ window: 5, inputs: [] }, { window: 3, inputs: [] }],
    }));
  });
});

describe("bonus table in the catalog", () => {
  it("the example catalog: POP + BIG POP only (no patterns, no escalation — rules 7) and 3 bots", () => {
    const c = parseCatalog(example) as unknown as Record<string, unknown> & { reward: Record<string, unknown>; bots: { count: number }[] };
    assert.equal(c.reward.patterns, undefined);
    assert.equal(c.reward.streakEscalation, undefined);
    assert.equal(c.bots.reduce((s, b) => s + b.count, 0), 3, "오너 결정 2026-10-06: 봇 3개");
    const x = structuredClone(example) as { reward: Record<string, unknown> };
    x.reward.patterns = [];
    assert.throws(() => parseCatalog(x), /patterns|Unrecognized/, "패턴 칸은 지웠다(원칙 2)");
  });
});

describe("feed / queue / live state", () => {
  const addr = `0x${"ab".repeat(20)}`;
  const feed = {
    seq: 12, kind: "BIG_POP", roomId: 1, playerShortId: shortPlayerId(addr), itemKey: "8812:0", tier: 4, amountMilli: 4000000,
    streakCount: 3, endReason: null, tick: 4410, blockNumber: 52103441,
  };

  it("shortPlayerId keeps 4 + 4 hex digits and never the full address", () => {
    assert.equal(shortPlayerId(`0x1234${"0".repeat(32)}ABCD`), "0x1234…abcd");
    assert.throws(() => shortPlayerId("0x1234"));
    assert.throws(() => FeedEvent.parse({ ...feed, playerShortId: addr }), "전체 주소는 피드에 못 들어간다");
  });

  it("FeedEvent (rules 7): POP · BIG_POP; endReason only on end events; no JACKPOT / PATTERN / STREAK; sky events carry skyId", () => {
    FeedEvent.parse(feed);
    FeedEvent.parse({ ...feed, kind: "POP", streakCount: 2 });
    FeedEvent.parse({ ...feed, kind: "BIG_PAYOUT", endReason: "DURABILITY", amountMilli: 18000000, overMilli: 6000000 });
    assert.throws(() => FeedEvent.parse({ ...feed, kind: "PICKAXE_END", overMilli: 0 }), "끝 사건에는 endReason");
    assert.throws(() => FeedEvent.parse({ ...feed, kind: "PICKAXE_END", endReason: "DURABILITY" }), "끝 사건에는 overMilli(0 포함)");
    assert.throws(() => FeedEvent.parse({ ...feed, overMilli: 0 }), "overMilli는 끝 사건에만");
    for (const kind of ["PATTERN", "STREAK", "BUFF"]) assert.throws(() => FeedEvent.parse({ ...feed, kind }), kind);
    assert.throws(() => FeedEvent.parse({ ...feed, kind: "JACKPOT" }), "JACKPOT(규칙 10)은 poolAfterMilli·cellX·cellY가 있어야 한다");
    assert.throws(() => FeedEvent.parse({ ...feed, patternId: null }), "patternId 칸은 없다(strict)");
    assert.throws(() => FeedEvent.parse({ ...feed, prize: "GOLD" }), "prize 칸은 없다(strict)");
    FeedEvent.parse({ ...feed, kind: "SKY_DROP", amountMilli: 0, skyId: 52103441 });
    FeedEvent.parse({ ...feed, kind: "SKY_CATCH", amountMilli: 0, skyId: 52103441 });
    assert.throws(() => FeedEvent.parse({ ...feed, kind: "SKY_CATCH", amountMilli: 0 }), "SKY_CATCH에는 skyId가 있다");
    assert.throws(() => FeedEvent.parse({ ...feed, kind: "POP", skyId: 7 }), "skyId는 하늘 사건에만");
    assert.throws(() => FeedEvent.parse({ ...feed, kind: "SKY_DROP", amountMilli: 0, skyId: -1 }), "skyId는 u32");
    // (규칙 9) LAST_HIT: amountMilli = 실제 지급, overMilli·endReason·skyId 없음, streakCount 0
    FeedEvent.parse({ ...feed, kind: "LAST_HIT", amountMilli: 11442, streakCount: 0 });
    FeedEvent.parse({ ...feed, kind: "LAST_HIT", amountMilli: 0, streakCount: 0 });
    assert.throws(() => FeedEvent.parse({ ...feed, kind: "LAST_HIT", overMilli: 0 }), "overMilli는 끝 사건에만");
  });

  it("BIG_PAYOUT only for a true win: paid > price (D46 revised — no celebration of partial losses)", () => {
    assert.equal(isBigPayout(3_000_001, 3_000_000), true);
    assert.equal(isBigPayout(3_000_000, 3_000_000), false, "break-even is not a win");
    assert.equal(isBigPayout(2_910_000, 3_000_000), false, "0.97× (old cap) is a loss");
    assert.equal(isBigPayout(2_700_000, 3_000_000), false, "0.9× was BIG_PAYOUT before, now a loss");
    assert.equal(isBigPayout(0, 3_000_000), false);
  });

  it("QueueState rejects more items than queueMax", () => {
    const item = { itemKey: "8812:1", tier: 4, priceMilli: 15000000 };
    const q = { roomId: 1, playerShortId: shortPlayerId(addr), activeItemKey: "8812:0", items: [item], queueMax: 1, nextSpawnWindow: 100 };
    QueueState.parse(q);
    assert.throws(() => QueueState.parse({ ...q, items: [item, { ...item, itemKey: "8812:2" }] }));
  });

  it("PickaxeLiveState carries no server-only fields", () => {
    const live = {
      itemKey: "8812:0", playerShortId: null, tier: 4, x: 3.2, y: 40.5, angle: 1.1, scale: 2,
      durabilityLeftBps: 10000, earnedMilli: 0, bonusMilli: 0, streakCount: 0, popTargetKind: -1, luckyKind: -1, pickLevelBps: 0, jackpotMilli: 0,
    };
    PickaxeLiveState.parse(live);
    PickaxeLiveState.parse({ ...live, luckyKind: 9 });
    assert.throws(() => PickaxeLiveState.parse({ ...live, luckyKind: undefined }), "luckyKind는 꼭 있다");
    PickaxeLiveState.parse({ ...live, popTargetKind: 3 });
    assert.throws(() => PickaxeLiveState.parse({ ...live, popTargetKind: -2 }));
    assert.throws(() => PickaxeLiveState.parse({ ...live, vx: 0.1 }), "속도는 화면 형식에 없다(strict)");
    assert.throws(() => PickaxeLiveState.parse({ ...live, buffs: [], twin: null }), "버프·쌍둥이 칸은 없다(D99)");
  });

  it("PickaxeHistoryRecord carries the bonus event summary, LUCKY, LAST HIT (rules 9) and the settleEnd split (payout + over)", () => {
    const rec = {
      itemKey: "8812:0", owner: addr, roomId: 1, tier: 4, priceCredits: 20000, rulesVersion: 7, spawnWindow: 10, spawnTick: 0,
      endWindow: 200, endTick: 1500, endReason: "DURABILITY", hits: 40, distinctBlocks: 30, blocksBroken: 12, durabilityUsed: 22160,
      durabilityTotal: 22160, pop: true, bigPop: true, luckyKind: 9, baseMilli: 11000000, luckyMilli: 5000000, bonusMilli: 8317000,
      lastHits: 3, lastHitMilli: 2000000, pickLevelBps: 0, pickMilli: 0, jackpotMilli: 0, paidMilli: 18000000, overMilli: 8317000, pnlMilli: 6317000,
      events: [
        { kind: "POP", tick: 77, window: 19, blockKind: 3, streakCount: 2, prizeMilli: 4317000, paidMilli: 4317000 },
        { kind: "BIG_POP", tick: 90, window: 21, blockKind: 3, streakCount: 3, prizeMilli: 4000000, paidMilli: 4000000 },
      ],
    };
    PickaxeHistoryRecord.parse(rec);
    assert.throws(() => PickaxeHistoryRecord.parse({ ...rec, gatePrize: null }), "입구 칸은 없다");
    // (규칙 10) 사다리·잭팟 세 칸은 필수
    for (const k of ["pickLevelBps", "pickMilli", "jackpotMilli"] as const) {
      const { [k]: _d, ...without } = rec;
      assert.throws(() => PickaxeHistoryRecord.parse(without), k);
    }
    assert.throws(() => PickaxeHistoryRecord.parse({ ...rec, jackpotMilli: -1 }));
    assert.throws(() => PickaxeHistoryRecord.parse({ ...rec, events: [{ ...rec.events[0], kind: "STREAK" }] }));
    assert.throws(() => PickaxeHistoryRecord.parse({ ...rec, events: [{ ...rec.events[0], kind: "LAST_HIT" }] }), "막타는 BonusEvent가 아니다(BonusEventKind 그대로)");
    const { lastHits: _n, ...noLastHit } = rec;
    assert.throws(() => PickaxeHistoryRecord.parse(noLastHit), "lastHits는 필수");
    assert.throws(() => PickaxeHistoryRecord.parse({ ...rec, lastHitMilli: -1 }));
  });
});

describe("batch lock (spec 08, D113)", () => {
  const item = {
    index: 0, itemKey: "77:0", tier: 0, priceMilli: 1_000_000, phase: "WAITING", endCause: null, payoutMilli: null, overMilli: 0, endedAt: null,
  };
  const batch = {
    id: "p77", nonce: "5", purchaseId: "77", roomId: 1, createdAt: "2026-10-11T00:00:00.000Z",
    items: [item, { ...item, index: 1, itemKey: "77:1", tier: 2, priceMilli: 5_000_000, phase: "ENDED", endCause: "END", payoutMilli: 812_000, endedAt: "2026-10-11T00:01:00.000Z" }],
  };

  it("BatchView: items in index order, id p<purchase>, phases and endCause; MeView.batch is required and nullable", () => {
    BatchView.parse(batch);
    BatchView.parse({ ...batch, nonce: null });
    BatchView.parse({ ...batch, purchaseId: null, items: [{ ...item, itemKey: null, phase: "SENDING" }] });
    assert.throws(() => BatchView.parse({ ...batch, id: "r12" }), "relay 묶음(r)은 없다 (D4)");
    assert.throws(() => BatchView.parse({ ...batch, relayId: 12 }), "relayId 칸은 없다 (D4)");
    assert.throws(() => BatchView.parse({ ...batch, id: "p012" }), "앞자리 0 없음");
    assert.throws(() => BatchView.parse({ ...batch, items: [batch.items[1], batch.items[0]] }), "칸은 index 순서");
    assert.throws(() => BatchView.parse({ ...batch, items: [] }), "빈 묶음은 없다(null)");
    assert.throws(() => BatchView.parse({ ...batch, items: Array.from({ length: 11 }, (_, i) => ({ ...item, index: i })) }), "최대 10칸");
    assert.throws(() => BatchView.parse({ ...batch, items: [{ ...item, phase: "SPAWNING" }] }), "SPAWNING은 화면만");
    assert.throws(() => BatchView.parse({ ...batch, items: [{ ...item, endCause: "GATE" }] }), "GATE는 끝 원인이 아니다");
    for (const cause of ["END", "ABNORMAL_END", "CANCEL", "OVERFLOW", "QUEUE_REFUND"]) BatchView.parse({ ...batch, items: [{ ...item, endCause: cause }] });

    const addr = `0x${"ab".repeat(20)}`;
    const me = {
      address: addr, playerShortId: shortPlayerId(addr), nickname: null, balances: { promoMilli: "0", blockNumber: 1 },
      pending: { settlingMilli: 0, activeEarnedMilli: 0 }, activePickaxes: [], queues: [], sessionKey: null, nextIntentNonce: "0",
    };
    MeView.parse({ ...me, batch: null });
    MeView.parse({ ...me, batch });
    assert.throws(() => MeView.parse(me), "batch 칸은 꼭 있다(없으면 null)");
  });
});
