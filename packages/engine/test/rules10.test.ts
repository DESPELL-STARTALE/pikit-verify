// 규칙 10 (명세 23, 계획 docs/plans/rules10-implementation.md §4.2 W2 ②): LUCKY PICK 사다리 · 상한 없는 골든 CHOG 잭팟 · 정산 T = min(C, max(X, F)) + J.
//  - 단계 뽑기: 결정론 · 10만 번 분포(±4σ) · 봇 0 · 대기열 0
//  - 통: 기여 = floor(가격 × bps/10⁴) 소환 때만(취소한 대기열 0) · 불변식 contributed = pool + paid (바쁜 판 3,000윈도)
//  - 균열: 통 전부 · 통 0 · 블록 사라짐(같은 틱 뒤 곡괭이·다음 틱) · LAST HIT · 곡괭이당 1번 · 통 미달 안 뽑음 · 봇 안 뽑음 · 같은 틱 순서
//  - 정산: 바닥·X·클램프·J 상한 밖 · 비정상 REFUND/REWARD · VOID J 되돌림 · over ≤ overCap + J (throw 0)
//  - 직렬화 v11 칸(규칙 11부터 v12가 담는다) · 규칙 9 카탈로그 = 규칙 9 결과 비트까지(골든 1~3 끝 상태 해시, v10 직렬화로)
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  catalogJackpotContributionMilli, catalogOverCapMilli, catalogPickFloorMilli, catalogPickLevelBps, catalogRewardCapMilli,
  catalogTotalCapMilli, type Catalog, type EngineInput,
} from "@pikit/protocol";
import {
  cloneRoom, createRoom, drawPickLevelBps, PhysicsEngine, runWindow, serializeRoom, settleAbnormal, settleNormal,
  STATE_ENCODING_TAG, streamU53,
  type BlockState, type EnginePayout, type PickaxeState, type RngFactory, type RoomJackpotEvent, type RoomState, type WindowResult,
} from "../src/index.js";
import { busyBoard, createPickaxe, loadRules10Catalog, loadRules9Catalog, roomHash, seedFrom, sha256Hex, windowFactory } from "./helpers.js";
import { golden1, golden2, golden3, replayLog, type Log } from "./golden-logs.js";
import { serializeRoomV10 } from "./serialize-v10.js";

// (규칙 11) 출시 카탈로그는 규칙 11(COMBO·버프·정수 정산)이라 이 파일은 규칙 10 카탈로그 사본(test/fixtures/catalog-rules10.json)으로 돈다 —
// 규칙 10 의미(통 전부 = J, 균열 뒤 통 0 …)가 규칙 11 엔진에서 그대로임을 보인다. 규칙 11 쪽 바뀐 것(J 정수 크레딧 등)은 rules11.test.ts.
const shipped = loadRules10Catalog();
const rules9 = loadRules9Catalog();
const GOLD = shipped.blocks.findIndex((b) => b.id === "chog_gold");

/** 출시 카탈로그에 시험 값을 덮는다 (검사를 거치지 않은 객체 — κ·minPool을 검사 범위 밖으로 둘 수 있게). */
function withRules(base: Catalog, o: { levels?: { multBps: number; per10m: number }[]; jackpot?: Partial<NonNullable<Catalog["jackpot"]>> | null; totalCapBps?: number }): Catalog {
  const c: Catalog = structuredClone(base);
  if (o.levels) c.luckyPick = { levels: o.levels };
  if (o.jackpot === null) delete c.jackpot;
  else if (o.jackpot) c.jackpot = { kindId: "chog_gold", contributionBpsByTier: c.pickaxes.map(() => 1), kappaPpm: 1_000_000, minPoolCredits: 1, ...c.jackpot, ...o.jackpot };
  if (o.totalCapBps !== undefined) c.reward = { ...c.reward, totalCapBps: o.totalCapBps };
  return c;
}

/** 균열이 쉬운 시험 카탈로그: minPool 1크레딧, κ 10⁹ppm(검사 밖) → 통 ≤ 1,000·가격이면 q ≥ 1 = 통 ≥ minPool인 첫 골든 타격에서 반드시 균열. 기여 10bps. */
const crackEasy = withRules(shipped, { jackpot: { contributionBpsByTier: shipped.pickaxes.map(() => 10), kappaPpm: 1_000_000_000, minPoolCredits: 1 } });

/** 방을 만든 뒤 링버퍼의 살아 있는 블록을 모두 골든 CHOG로 (체력 그대로 198,948.7 — 데미지로는 거의 안 깨진다). */
function goldenRoom(catalog: Catalog, seedNo: number): { state: RoomState; seed: Uint8Array } {
  const seed = seedFrom(seedNo);
  const state = createRoom(catalog, windowFactory(seed, 1, 0), 1, 0);
  const hp = catalog.blocks[GOLD]!.hp;
  for (const b of state.blocks) if (b.health > 0) { b.kind = GOLD; b.health = hp; }
  return { state, seed };
}

/** 지갑 n개가 앞 곡괭이가 끝나면 바로 다음을 산다(등급 = (ref + i) % 등급 수). 윈도마다 onWindow. rngWrap으로 스트림 이름표를 엿볼 수 있다. */
function drive(
  state: RoomState, catalog: Catalog, seed: Uint8Array, from: number, to: number, wallets: number,
  onWindow?: (res: WindowResult) => void, rngWrap?: (f: RngFactory) => RngFactory,
): void {
  const owners = Array.from({ length: wallets }, (_, i) => `0x${String(i + 1).repeat(40).slice(0, 40)}`);
  let ref = 1;
  for (let w = from; w <= to; w++) {
    const inputs: EngineInput[] = [];
    owners.forEach((owner, i) => {
      const slot = state.owners.find((x) => x.owner === owner);
      if (!slot || (slot.activeKey === null && slot.queue.length === 0)) inputs.push({ type: "purchase", ref: `${w}-${ref++}`, owner, tiers: [(ref + i) % catalog.pickaxes.length] });
    });
    const f = windowFactory(seed, 1, w);
    const res = runWindow(state, catalog, w, inputs, rngWrap ? rngWrap(f) : f);   // (onWindow?.(runWindow(…))는 onWindow가 없으면 runWindow를 부르지 않는다)
    onWindow?.(res);
  }
}

/** 플레이어 곡괭이의 타격을 순서대로 기록 (advancePickaxe를 감싼다 — 엔진 코드는 그대로, 이 시험 프로세스 안에서만). */
interface HitRec { tick: number; key: string; owner: string | null; kind: number; x: number; y: number; block: BlockState; jackpotBefore: number; poolBefore: number }
function tapHits(state: () => RoomState): { log: HitRec[]; restore: () => void } {
  const log: HitRec[] = [];
  const advance = PhysicsEngine.prototype.advancePickaxe;
  PhysicsEngine.prototype.advancePickaxe = function (this: PhysicsEngine, p: PickaxeState, ...rest) {
    const jackpotBefore = p.jackpotMilli;
    const hits = advance.call(this, p, ...rest);
    const s = state();
    for (const h of hits) log.push({ tick: s.tick, key: p.key, owner: p.owner, kind: h.block.kind, x: h.block.x, y: h.block.y, block: h.block, jackpotBefore, poolBefore: s.jackpot.poolMilli });
    return hits;
  } as typeof advance;
  return { log, restore: () => { PhysicsEngine.prototype.advancePickaxe = advance; } };
}

const ownerOf = (i: number) => `0x${String(i + 1).repeat(40).slice(0, 40)}`;

// ──────────────────────────────────────────────────────────────────────────
describe("rules 10: catalog shape the engine reads", () => {
  it("the rules-10 catalog (fixture) has a ladder, a jackpot on Golden CHOG and a total cap", () => {
    assert.equal(shipped.rulesVersion, 10);
    assert.ok(shipped.luckyPick && shipped.luckyPick.levels!.length > 0);
    assert.equal(shipped.jackpot?.kindId, "chog_gold");
    assert.ok((shipped.reward.totalCapBps ?? 0) > shipped.reward.rewardCapBps);
    assert.ok(GOLD >= 0);
  });
  it("the rules-9 fixture has none of the three (the bit-equality baseline)", () => {
    assert.equal(rules9.rulesVersion, 9);
    assert.equal(rules9.luckyPick, undefined);
    assert.equal(rules9.jackpot, undefined);
    assert.equal(rules9.reward.totalCapBps, undefined);
  });
});

// ──────────────────────────────────────────────────────────────────────────
describe("rules 10: LUCKY PICK draw at spawn", () => {
  it("is deterministic: same seed → same levels; another seed → different levels", () => {
    const levels = (seedNo: number) => {
      const out: number[] = [];
      busyBoard(shipped, seedNo, 400, 8, (_, res) => { for (const s of res.spawned) out.push(s.pickLevelBps); });
      return out;
    };
    const a = levels(5);
    assert.deepEqual(levels(5), a);
    assert.ok(a.length > 20, `spawns ${a.length}`);
    assert.notDeepEqual(levels(6).slice(0, a.length), a);
  });

  it("spawned pickaxes carry the level on the record and on the board state; bots never draw", () => {
    let withLevel = 0;
    busyBoard(shipped, 7, 600, 8, (state, res) => {
      for (const s of res.spawned) {
        const p = state.pickaxes.find((q) => q.key === s.key) ?? state.results.find((r) => r.key === s.key);
        assert.ok(p, s.key);
        assert.equal(p.pickLevelBps, s.pickLevelBps);
        if (s.pickLevelBps > 0) withLevel += 1;
        assert.ok(s.pickLevelBps === 0 || shipped.luckyPick!.levels!.some((l) => l.multBps === s.pickLevelBps));
      }
      for (const p of state.pickaxes) if (p.owner === null) { assert.equal(p.pickLevelBps, 0); assert.equal(p.goldenHits, 0); assert.equal(p.jackpotMilli, 0); }
    });
    assert.ok(withLevel > 0, "a 600-window busy board shows at least one LUCKY PICK");
  });

  it("uses only the `pick|<key>` stream's first number (drawPickLevelBps = catalogPickLevelBps(u × 2⁵³))", () => {
    const f = windowFactory(seedFrom(1), 1, 3);
    const u = windowFactory(seedFrom(1), 1, 3)(`pick|42:0`).next();
    assert.equal(drawPickLevelBps(shipped, f(`pick|42:0`), 0), catalogPickLevelBps(shipped, BigInt(u * 2 ** 53), 0));
    assert.equal(BigInt(u * 2 ** 53), streamU53(windowFactory(seedFrom(1), 1, 3)(`pick|42:0`)));
  });

  it("100,000 draws: every level's frequency within ±4σ of per10m / 10⁷ (and 'none' too)", () => {
    const levels = shipped.luckyPick!.levels!;
    const counts = new Map<number, number>();
    const N = 100_000;
    for (let i = 0; i < N; i++) {
      const lvl = drawPickLevelBps(shipped, windowFactory(seedFrom(i % 97), 1, 1 + Math.floor(i / 97))(`pick|${i}:0`), 0);
      counts.set(lvl, (counts.get(lvl) ?? 0) + 1);
    }
    const none = 1 - levels.reduce((a, l) => a + l.per10m, 0) / 1e7;
    for (const [bps, p] of [...levels.map((l) => [l.multBps, l.per10m / 1e7] as const), [0, none] as const]) {
      const got = counts.get(bps) ?? 0;
      const exp = N * p;
      const sigma = Math.sqrt(N * p * (1 - p));
      assert.ok(Math.abs(got - exp) <= 4 * sigma + 1e-9, `level ${bps}: ${got} vs ${exp.toFixed(1)} ± ${(4 * sigma).toFixed(1)}`);
    }
    for (const bps of counts.keys()) assert.ok(bps === 0 || levels.some((l) => l.multBps === bps), `unexpected level ${bps}`);
  });

  it("queued items have no level and add nothing to the pool; a cancelled queue item contributes 0", () => {
    const seed = seedFrom(11);
    const state = createRoom(shipped, windowFactory(seed, 1, 0), 1, 0);
    const owner = ownerOf(0);
    const r1 = runWindow(state, shipped, 1, [{ type: "purchase", ref: "77", owner, tiers: [0, 1, 4] }], windowFactory(seed, 1, 1));
    assert.equal(r1.spawned.length, 1);
    const c0 = catalogJackpotContributionMilli(shipped, 0);
    assert.equal(r1.spawned[0]!.contributionMilli, c0);
    assert.deepEqual(state.jackpot, { poolMilli: c0, contributedMilli: c0, paidMilli: 0, wins: 0 });
    // 대기열 항목: 상태에 단계 칸이 없다(QueueItem), 통은 그대로
    const slot = state.owners.find((s) => s.owner === owner)!;
    assert.deepEqual(slot.queue.map((q) => q.key), ["77:1", "77:2"]);
    assert.ok(!("pickLevelBps" in slot.queue[0]!));
    const r2 = runWindow(state, shipped, 2, [{ type: "cancel", owner, itemKey: "77:2" }], windowFactory(seed, 1, 2));
    assert.ok(r2.payouts.some((p) => p.key === "77:2" && p.kind === "REFUND" && p.cause === "CANCEL"));
    assert.equal(state.jackpot.contributedMilli, c0, "cancelled queue item contributes 0");
  });

  it("contribution = floor(price × contributionBpsByTier[tier] / 10⁴) at spawn only, per tier", () => {
    const seen = new Set<number>();
    let sum = 0;
    busyBoard(shipped, 13, 500, 6, (state, res) => {
      for (const s of res.spawned) {
        const price = shipped.pickaxes[s.tier]!.priceCredits * 1000;
        assert.equal(s.contributionMilli, Math.floor((price * shipped.jackpot!.contributionBpsByTier[s.tier]!) / 1e4));
        sum += s.contributionMilli;
        seen.add(s.tier);
      }
      assert.equal(state.jackpot.contributedMilli, sum);
    });
    assert.equal(seen.size, shipped.pickaxes.length);
  });
});

// ──────────────────────────────────────────────────────────────────────────
describe("rules 10: Golden CHOG crack", () => {
  it("a player's Golden hit cracks: whole pool paid, pool 0, block gone, LAST HIT applies, one jackpot per pickaxe", () => {
    const { state, seed } = goldenRoom(crackEasy, 21);
    const tap = tapHits(() => state);
    const jackpots: RoomJackpotEvent[] = [];
    const results: WindowResult[] = [];
    try {
      drive(state, crackEasy, seed, 1, 400, 4, (res) => { jackpots.push(...res.jackpots); results.push(res); });
    } finally { tap.restore(); }
    assert.ok(jackpots.length >= 3, `jackpots ${jackpots.length}`);
    const keys = new Set<string>();
    for (const j of jackpots) {
      assert.equal(j.blockKind, GOLD);
      assert.equal(j.poolAfterMilli, 0);
      assert.ok(j.amountMilli > 0);
      assert.ok(!keys.has(j.key), `one jackpot per pickaxe (${j.key})`);
      keys.add(j.key);
      // 균열한 타격의 기록: 그 곡괭이의 그 틱 그 칸, 직전 통 = J
      const i = tap.log.findIndex((h) => h.tick === j.tick && h.key === j.key && h.x === j.x && h.y === j.y);
      assert.ok(i >= 0);
      const hit = tap.log[i]!;
      assert.equal(hit.poolBefore, j.amountMilli);
      // 블록은 체력 0 — 같은 틱 뒤 곡괭이와 다음 틱부터 그 칸(같은 줄)은 아무도 못 친다
      assert.equal(hit.block.health, 0);
      for (const later of tap.log.slice(i + 1)) assert.ok(!(later.block === hit.block && later.y === j.y), `cracked block hit again by ${later.key} at tick ${later.tick}`);
      // LAST HIT: 골든 hp > 모든 공격력 → 깨뜨린 타격으로 막타가 붙는다
      const res = results.find((r) => r.window === j.window)!;
      assert.ok(res.lastHits.some((l) => l.key === j.key && l.tick === j.tick && l.blockKind === GOLD), "LAST HIT on the crack");
    }
    // 끝난 곡괭이: J가 결과·정산에 들어감
    const ended = results.flatMap((r) => r.ended);
    for (const j of jackpots) {
      const r = ended.find((e) => e.key === j.key);
      if (!r) continue;
      assert.equal(r.jackpotMilli, j.amountMilli);
      assert.ok(r.lastHits >= 1);
      assert.ok(r.blocksBroken >= 1);
      assert.ok(r.paidMilli + r.overMilli >= j.amountMilli);
    }
    // 한 번 받은 곡괭이는 뒤 골든 타격에서 뽑지 않는다: 뒤 타격의 jackpotBefore > 0이면 그 곡괭이의 사건은 하나뿐
    for (const h of tap.log) if (h.jackpotBefore > 0) assert.equal(jackpots.filter((j) => j.key === h.key).length, 1);
  });

  it("same tick: the first eligible hitter in state.pickaxes order cracks; the pool is 0 after it, so later hits that window do not draw", () => {
    // 앞 100윈도는 minPool이 닿을 수 없는 카탈로그(뽑지 않음 → 골든을 친 곡괭이가 자격을 가진 채 쌓인다), 그다음 균열이 쉬운 카탈로그 —
    // 같은 틱에 자격 있는 곡괭이 둘 이상이 골든을 치는 순간이 생긴다. 카탈로그는 윈도마다 넘기는 값이다.
    const noDraw = withRules(crackEasy, { jackpot: { minPoolCredits: 1e12 } });
    const { state, seed } = goldenRoom(crackEasy, 22);
    const tap = tapHits(() => state);
    const jackpots: RoomJackpotEvent[] = [];
    let windowsWithTwo = 0;
    const onWindow = (res: WindowResult) => {
      jackpots.push(...res.jackpots);
      if (res.jackpots.length > 1) windowsWithTwo += 1;
    };
    try {
      drive(state, noDraw, seed, 1, 100, 8, onWindow);
      drive(state, crackEasy, seed, 101, 500, 8, onWindow);
    } finally { tap.restore(); }
    assert.equal(windowsWithTwo, 0, "pool only grows at spawn → at most one crack per window");
    let contested = 0;
    for (const j of jackpots) {
      // 그 틱에 골든을 친 자격 있는 플레이어 타격(봇 먼저, 들어온 순 = 기록 순)
      const eligible = tap.log.filter((h) => h.tick === j.tick && h.owner !== null && h.kind === GOLD && h.jackpotBefore === 0);
      const first = eligible.findIndex((h) => h.poolBefore >= 1000);
      assert.ok(first >= 0);
      assert.equal(eligible[first]!.key, j.key, `tick ${j.tick}: first eligible ${eligible[first]!.key}, crack ${j.key}`);
      // 뒤 곡괭이는 통 0을 본다 (같은 곡괭이의 같은 틱 다른 골든 타격은 이미 J가 있어 뽑지 않는다 — 기록의 poolBefore는 그 곡괭이 타격 전 값)
      for (const later of eligible.slice(first + 1)) if (later.key !== j.key) assert.equal(later.poolBefore, 0, `${later.key} drew after the crack`);
      if (new Set(eligible.slice(first).map((h) => h.key)).size > 1) contested += 1;
      assert.equal(jackpots.filter((x) => x.key === j.key).length, 1);
    }
    assert.ok(jackpots.length >= 5, `jackpots ${jackpots.length}`);
    assert.ok(contested >= 1, "at least one tick where two players hit Golden");
  });

  it("below minPool: no draw (no `crack|` stream), Golden hits still counted; bot hits never draw", () => {
    const noDraw = withRules(crackEasy, { jackpot: { minPoolCredits: 1e12 } });
    const { state, seed } = goldenRoom(noDraw, 23);
    const labels: string[] = [];
    drive(state, noDraw, seed, 1, 200, 4, (res) => assert.equal(res.jackpots.length, 0), (f) => (l) => { labels.push(l); return f(l); });
    assert.equal(labels.filter((l) => l.startsWith("crack|")).length, 0);
    assert.ok(state.results.length > 0 && state.results.every((r) => r.jackpotMilli === 0));
    assert.equal(state.jackpot.paidMilli, 0);
    assert.ok(state.jackpot.poolMilli > 0);
    assert.ok(state.pickaxes.some((p) => p.owner !== null && p.goldenHits > 0), "Golden hits are still counted below minPool");

    // 통 ≥ minPool: 플레이어 키의 crack 스트림만, n은 0부터 이어진다
    const { state: s2, seed: seed2 } = goldenRoom(withRules(crackEasy, { jackpot: { kappaPpm: 1 } }), 24);   // q 아주 작음 → 뽑기는 많고 균열은 거의 없음
    const crackLabels: string[] = [];
    drive(s2, withRules(crackEasy, { jackpot: { kappaPpm: 1 } }), seed2, 1, 200, 4, undefined, (f) => (l) => { if (l.startsWith("crack|")) crackLabels.push(l); return f(l); });
    assert.ok(crackLabels.length > 0);
    for (const l of crackLabels) assert.ok(!l.startsWith("crack|bot:"), l);
    const byKey = new Map<string, number[]>();
    for (const l of crackLabels) { const m = /^crack\|(.+)\|(\d+)$/.exec(l)!; const a = byKey.get(m[1]!) ?? []; a.push(Number(m[2])); byKey.set(m[1]!, a); }
    for (const [k, ns] of byKey) assert.deepEqual(ns, ns.map((_, i) => i), `${k}: n = 0, 1, 2, …`);
    for (const p of s2.pickaxes) if (p.owner === null) assert.equal(p.goldenHits, 0);
  });

  it("invariant contributed = pool + paid on a 3,000-window busy board (shipped catalog and the crack-easy catalog), no guard throws", () => {
    for (const c of [shipped, crackEasy]) {
      let wins = 0;
      busyBoard(c, 31, 3000, 8, (state, res) => {
        const j = state.jackpot;
        assert.equal(j.contributedMilli, j.poolMilli + j.paidMilli);
        wins += res.jackpots.length;
        assert.equal(j.wins, wins);
        for (const p of res.payouts) checkPayout(c, p, res);
      });
    }
  });
});

/** 정산 한 건의 체인 상한 불변식 (엔진 가드와 같은 식). */
function checkPayout(c: Catalog, p: EnginePayout, res: WindowResult): void {
  const r = res.ended.find((e) => e.key === p.key);
  const J = r?.jackpotMilli ?? 0;
  if (p.kind === "REFUND") { assert.ok(p.payoutMilli <= p.priceMilli); assert.equal(p.overMilli, 0); }
  else assert.ok(p.payoutMilli <= catalogRewardCapMilli(c, p.tier));
  assert.ok(p.overMilli <= catalogOverCapMilli(c, p.tier) + J, `${p.key}: over ${p.overMilli} > ${catalogOverCapMilli(c, p.tier)} + ${J}`);
}

// ──────────────────────────────────────────────────────────────────────────
describe("rules 10: settlement T = min(C, max(X, F)) + J", () => {
  const owned = (tier: number, o: Partial<PickaxeState> = {}): PickaxeState => {
    const t = shipped.pickaxes[tier]!;
    return { ...createPickaxe(0, 0, { owner: ownerOf(0), tier, durabilityTotal: t.durability, durabilityLeft: 0 }), priceMilli: t.priceCredits * 1000, ...o };
  };
  const P = shipped.pickaxes[0]!.priceCredits * 1000;
  const cap = catalogRewardCapMilli(shipped, 0);

  it("no level, no J: T = X (rules 9 split)", () => {
    const s = settleNormal(shipped, owned(0, { baseMilli: 400_000 }));
    assert.deepEqual(s, { payoutMilli: 400_000, overMilli: 0, pickMilli: 0, totalMilli: 400_000 });
  });
  it("X < floor → floor (×2 = 2·P), the top-up is pickMilli", () => {
    const s = settleNormal(shipped, owned(0, { baseMilli: 300_000, pickLevelBps: 20_000 }));
    assert.equal(s.totalMilli, catalogPickFloorMilli(shipped, 0, 20_000));
    assert.equal(s.totalMilli, 2 * P);
    assert.equal(s.pickMilli, 2 * P - 300_000);
    assert.equal(s.payoutMilli, cap);
    assert.equal(s.overMilli, 2 * P - cap);
  });
  it("X > floor → X, no top-up", () => {
    const s = settleNormal(shipped, owned(0, { baseMilli: 1_500_000, pickLevelBps: 11_000 }));
    assert.deepEqual(s, { payoutMilli: cap, overMilli: 1_500_000 - cap, pickMilli: 0, totalMilli: 1_500_000 });
  });
  it("40× (here: a small total cap) clamps T_main; J stays outside the cap", () => {
    const small = withRules(shipped, { totalCapBps: 15_000 });
    const C = catalogTotalCapMilli(small, 0);
    assert.equal(C, 1.5 * P);
    const a = settleNormal(small, owned(0, { baseMilli: 100_000, pickLevelBps: 400_000 }));
    assert.equal(a.totalMilli, C);
    assert.equal(a.pickMilli, C - 100_000);
    const b = settleNormal(small, owned(0, { baseMilli: 1_800_000 }));   // X > C → C, no top-up
    assert.equal(b.totalMilli, C);
    assert.equal(b.pickMilli, 0);
    const J = 7 * P;
    const c = settleNormal(small, owned(0, { baseMilli: 100_000, pickLevelBps: 400_000, jackpotMilli: J }));
    assert.equal(c.totalMilli, C + J);
    assert.equal(c.payoutMilli, cap);
    assert.equal(c.overMilli, C + J - cap);
    assert.ok(c.overMilli <= catalogOverCapMilli(small, 0) + J);
    assert.ok(c.overMilli > catalogOverCapMilli(small, 0), "this J needs the + J in the over guard");
  });
  it("the shipped total cap is 40 × price for every tier", () => {
    shipped.pickaxes.forEach((t, i) => assert.equal(catalogTotalCapMilli(shipped, i), 40 * t.priceCredits * 1000));
  });
  it("abnormal end: no level and no J → REFUND V (rules 9); with a level → REWARD max(V, F); with J only → REWARD min(C, V) + J", () => {
    const half = { durabilityLeft: shipped.pickaxes[0]!.durability / 2, baseMilli: 100_000 };   // V = 100,000 + P/2
    const V = 100_000 + P / 2;
    assert.deepEqual(settleAbnormal(shipped, owned(0, half)), { kind: "REFUND", payoutMilli: V, overMilli: 0, pickMilli: 0, totalMilli: V });
    const lv = settleAbnormal(shipped, owned(0, { ...half, pickLevelBps: 11_000 }));
    assert.equal(lv.kind, "REWARD");
    assert.equal(lv.totalMilli, 1.1 * P);
    assert.equal(lv.pickMilli, 1.1 * P - V);
    assert.equal(lv.payoutMilli, cap);
    const jp = settleAbnormal(shipped, owned(0, { ...half, jackpotMilli: 50 * P }));
    assert.equal(jp.kind, "REWARD");
    assert.equal(jp.totalMilli, V + 50 * P);
    assert.equal(jp.pickMilli, 0);
    assert.equal(jp.payoutMilli, cap);
  });
  it("rules-9 catalog: settleNormal = the rules-9 split for any X up to the old ceiling", () => {
    for (const X of [0, 1, 899_999, 900_000, 2_345_678, catalogTotalCapMilli(rules9, 0)]) {
      const s = settleNormal(rules9, owned(0, { baseMilli: X }));
      assert.deepEqual(s, { payoutMilli: Math.min(X, catalogRewardCapMilli(rules9, 0)), overMilli: X - Math.min(X, catalogRewardCapMilli(rules9, 0)), pickMilli: 0, totalMilli: X });
    }
  });
});

describe("rules 10: settlement inside the room", () => {
  const everyone11 = withRules(shipped, { levels: [{ multBps: 11_000, per10m: 10_000_000 }] });

  it("freeze with a LUCKY PICK level → REWARD / ABNORMAL_END at 1.1 × price; without → REFUND (rules-9 catalog)", () => {
    for (const [c, kind] of [[everyone11, "REWARD"], [rules9, "REFUND"]] as const) {
      const seed = seedFrom(41);
      const state = createRoom(c, windowFactory(seed, 1, 0), 1, 0);
      runWindow(state, c, 1, [{ type: "purchase", ref: "5", owner: ownerOf(0), tiers: [0] }], windowFactory(seed, 1, 1));
      const res = runWindow(state, c, 2, [{ type: "freeze", reason: "FREEZE" }], windowFactory(seed, 1, 2));
      const p = res.payouts.find((x) => x.key === "5:0")!;
      assert.equal(p.kind, kind);
      assert.equal(p.cause, "ABNORMAL_END");
      const r = res.ended.find((x) => x.key === "5:0")!;
      if (kind === "REWARD") {
        assert.equal(r.pickLevelBps, 11_000);
        assert.equal(p.payoutMilli + p.overMilli, 1_100_000);
        assert.equal(r.pickMilli, 1_100_000 - Math.min(1_000_000, r.baseMilli + r.luckyMilli + r.bonusMilli + r.lastHitMilli + Math.floor((r.durabilityTotal - r.durabilityUsed) * 1_000_000 / r.durabilityTotal)));
      } else {
        assert.equal(r.pickLevelBps, 0);
        assert.equal(r.pickMilli, 0);
      }
    }
  });

  it("a jackpot far above the over cap settles without throwing (guard = overCap + J, risk R3)", () => {
    const big = withRules(crackEasy, { jackpot: { kappaPpm: 1e15 } });
    const { state, seed } = goldenRoom(big, 51);
    state.jackpot.poolMilli = 100 * 20_000_000;   // 시험: 통을 최고가의 100배로 (불변식 유지)
    state.jackpot.contributedMilli = state.jackpot.poolMilli;
    const ended: WindowResult["ended"] = [];
    const payouts: EnginePayout[] = [];
    drive(state, big, seed, 1, 600, 1, (res) => { ended.push(...res.ended); payouts.push(...res.payouts); });
    const winner = ended.find((r) => r.jackpotMilli > 0)!;
    assert.ok(winner, "a jackpot");
    assert.ok(winner.jackpotMilli >= 2_000_000_000);   // 통 + 그 사이 소환 기여
    const p = payouts.find((x) => x.key === winner.key)!;
    assert.equal(p.kind, "REWARD");
    assert.ok(p.overMilli > catalogOverCapMilli(big, winner.tier));
    assert.equal(p.payoutMilli + p.overMilli, winner.paidMilli + winner.overMilli);
    assert.ok(winner.paidMilli + winner.overMilli >= winner.jackpotMilli);
  });

  it("VOID: no payout and J goes back to the pool (paid −J, wins −1)", () => {
    const { state, seed } = goldenRoom(crackEasy, 61);
    const owner = ownerOf(0);
    let won: RoomJackpotEvent | null = null;
    let w = 1;
    runWindow(state, crackEasy, w, [{ type: "purchase", ref: "900", owner, tiers: [4] }], windowFactory(seed, 1, w));
    for (w = 2; w < 400 && !won; w++) {
      const res = runWindow(state, crackEasy, w, [], windowFactory(seed, 1, w));
      won = res.jackpots[0] ?? null;
      assert.equal(res.ended.length, 0, "the BM pickaxe should still be alive when it cracks");
    }
    assert.ok(won, "crack");
    const before = { ...state.jackpot };
    const res = runWindow(state, crackEasy, w, [{ type: "voidPurchase", ref: "900", owner }], windowFactory(seed, 1, w));
    assert.equal(res.payouts.length, 0);
    const r = res.ended.find((e) => e.key === "900:0")!;
    assert.equal(r.endReason, "VOID");
    assert.equal(r.jackpotMilli, 0);
    assert.equal(state.jackpot.poolMilli, before.poolMilli + won.amountMilli);
    assert.equal(state.jackpot.paidMilli, before.paidMilli - won.amountMilli);
    assert.equal(state.jackpot.wins, before.wins - 1);
    assert.equal(state.jackpot.contributedMilli, state.jackpot.poolMilli + state.jackpot.paidMilli);
  });
});

// ──────────────────────────────────────────────────────────────────────────
describe("rules 10: state encoding (v11 fields, encoded since rules 11 by v12)", () => {
  it("tag, round-trip and every rules-10 field moves the hash", () => {
    assert.equal(STATE_ENCODING_TAG, "PIKIT/state/v12");
    const { state, seed } = goldenRoom(crackEasy, 71);
    drive(state, crackEasy, seed, 1, 120, 4);
    assert.ok(state.results.length > 0 && state.pickaxes.some((p) => p.owner !== null));
    const bytes = serializeRoom(state);
    assert.equal(new TextDecoder().decode(bytes.subarray(4, 4 + STATE_ENCODING_TAG.length)), STATE_ENCODING_TAG);
    assert.deepEqual(serializeRoom(cloneRoom(state)), bytes);
    const h0 = roomHash(state);
    const player = (s: RoomState) => s.pickaxes.find((p) => p.owner !== null)!;
    const mutations: [string, (s: RoomState) => void][] = [
      ["pool", (s) => { s.jackpot.poolMilli += 1; }],
      ["contributed", (s) => { s.jackpot.contributedMilli += 1; }],
      ["paid", (s) => { s.jackpot.paidMilli += 1; }],
      ["wins", (s) => { s.jackpot.wins += 1; }],
      ["pickaxe.pickLevelBps", (s) => { player(s).pickLevelBps += 1; }],
      ["pickaxe.goldenHits", (s) => { player(s).goldenHits += 1; }],
      ["pickaxe.jackpotMilli", (s) => { player(s).jackpotMilli += 1; }],
      ["result.pickLevelBps", (s) => { s.results[0]!.pickLevelBps += 1; }],
      ["result.pickMilli", (s) => { s.results[0]!.pickMilli += 1; }],
      ["result.jackpotMilli", (s) => { s.results[0]!.jackpotMilli += 1; }],
    ];
    const seen = new Set([h0]);
    for (const [name, m] of mutations) {
      const c = cloneRoom(state);
      m(c);
      const h = roomHash(c);
      assert.ok(!seen.has(h), name);
      seen.add(h);
    }
  });
});

// ──────────────────────────────────────────────────────────────────────────
// 규칙 9 카탈로그 = 규칙 9 결과 (물리 무변경 증거, 명세 23 §11): verifier 골든 1~3의 입력을 규칙 10 엔진으로 재생해 v10 직렬화 해시를 비교한다.
// 기대값 = 규칙 9 시절 packages/verifier/test/fixtures/golden-{1,2,3}.expected.json finalStateHash (rules.lock 2026-10-16). 입력은 golden-logs.ts(손 사본).
// (규칙 11) 규칙 11 엔진도 같은 값을 낸다 — 규칙 10 카탈로그 = 규칙 10 결과는 rules11.test.ts.
// ──────────────────────────────────────────────────────────────────────────
function replayCounting(catalog: Catalog, log: Log): { state: RoomState; jackpots: number; levels: number } {
  let jackpots = 0;
  let levels = 0;
  const state = replayLog(catalog, log, (res) => {
    jackpots += res.jackpots.length;
    levels += res.spawned.filter((s) => s.pickLevelBps > 0).length;
  });
  return { state, jackpots, levels };
}

describe("rules 10: a catalog without luckyPick/jackpot/totalCapBps reproduces rules 9 bit for bit", () => {
  const cases: [string, Log, string][] = [
    ["golden-1", golden1, "0x0119d8d96a4d17128cf179b7fa3423f0856cb6c736d5edd54dfeb6aee83807e5"],
    ["golden-2 (seed 0x62, busy board)", golden2, "0xf2757cb523600737a01e8a73883c8e72205bc7d06ff172a252c6936134341cca"],
    ["golden-3 (BIG POP, LUCKY, LAST HIT, over)", golden3(2), "0x6242cba75c72634b2c5239d85a0491c15258e1400988acaf13742aeca2ece717"],
  ];
  for (const [name, log, hash] of cases) {
    it(`${name}: rules-9 end-state hash (v10 encoding) unchanged, no levels, no pool`, () => {
      const r = replayCounting(rules9, log);
      assert.equal(`0x${sha256Hex(serializeRoomV10(r.state))}`, hash);
      assert.equal(r.jackpots, 0);
      assert.equal(r.levels, 0);
      assert.deepEqual(r.state.jackpot, { poolMilli: 0, contributedMilli: 0, paidMilli: 0, wins: 0 });
      for (const x of r.state.results) { assert.equal(x.pickLevelBps, 0); assert.equal(x.pickMilli, 0); assert.equal(x.jackpotMilli, 0); }
    });
  }
  it("the same logs on the rules-10 catalog do change the outcome (the comparison has teeth)", () => {
    const r = replayCounting(shipped, golden2);
    assert.notEqual(`0x${sha256Hex(serializeRoomV10(r.state))}`, cases[1]![2]);
  });
});
