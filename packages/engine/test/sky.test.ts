import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { Catalog } from "@pikit/protocol";
import {
  capsuleBlockContact, cloneRoom, createRoom, dropSkyBoost, getActiveBlockFromRingBuffer, hitboxPrimitives, maybeDropSkyItem,
  physicsFor, rewardCapMilli, runWindow, serializeRoom, STATE_ENCODING_TAG, stepScales, stepSkyItem,
  type PickaxeState, type Rng, type RngFactory, type RoomSkyEvent, type RoomState, type SkyItem,
} from "../src/index.js";
import { busyBoard, createPickaxe, loadRules10Catalog, loadRules9Catalog, roomHash, seedFrom, windowFactory } from "./helpers.js";

// ──────────────────────────────────────────────────────────────────────────
// 하늘 이벤트 "✨ 별" (D125, 명세 docs/specs/07-sky-event.md §8 시험 1~8·10; 9는 room.test.ts의 --jitless)
// ──────────────────────────────────────────────────────────────────────────

// (규칙 11) 하늘 이벤트 규칙은 그대로다 — 이 파일은 버프(성장·GIANT)가 없는 규칙 10 카탈로그 사본으로 돈다(아래 "커지지 않은 몸 = 등급 지름" 등이
// 성장 없이만 성립). 출시 카탈로그(규칙 12)에서 하늘 효과와 버프 크기가 한 길(stepScales)로 섞이는 시험은 rules12.test.ts.
const catalog = loadRules10Catalog();
const sky = catalog.skyEvent;

// 8지갑 바쁜 판(seed 99 × 3,000윈도)의 끝 상태 해시 — 규칙 7(D137)에서 다시 고정했다: 황금 입구 삭제(스폰 = 바로 판), 날 5점·손잡이 피해,
// 물리 ×1.3, 띠 생성, LUCKY 종류(상태에 들어감), 상태 태그 v9가 모두 해시를 바꾼다. (규칙 6 값: dc3572235d…·별 4개는 스크래치 참고 구현과 같았다.)
// 규칙 8(D215, 명세 21): CHOG 블록 두 종류가 판 구성(흙 자리)과 LUCKY 풀을 바꿔 다시 고정 — 이번 판에는 별이 사라지는(EXPIRED) 경우도 들어간다.
// (규칙 7 값: 5ba2f1b5da…, 별 4개 모두 잡힘)
// 규칙 9(D228, 명세 22): 값·β·막타 몫과 상태 태그 v10이 해시만 바꾼다 — 물리·판은 그대로라 별 사건 목록은 규칙 8과 같다(불변 확인).
// (규칙 8 값: 19ac69c50a…)
// 규칙 10(명세 23): 이 고정값은 **규칙 9 카탈로그 + v10 직렬화**로 잰다 — 규칙 10 엔진이 규칙 9 결과를 비트까지 다시 낸다는 증거(rules10.test.ts와 같은 방법).
// 규칙 11(명세 24): 규칙 10 바쁜 판 고정값(별 사건·끝 해시 v11·LUCKY PICK 단계·잭팟 통 — 규칙 10 키트가 채웠던 값)은 이제 **규칙 10 카탈로그 사본 +
// v11 직렬화**로 잰다(고정, 키트가 다시 채우지 않는다). 규칙 11 출시 카탈로그의 바쁜 판은 rules11.test.ts(KIT(rules11) 자리).
// 규칙 12(명세 25): 사본 카탈로그의 LUCKY가 luckyWeight 꼴(행운 종류 1씩)이 되어 LUCKY 종류·몫이 바뀐다 → 끝 해시 고정(규칙 9 v10 · 규칙 10 v11)은 지웠다.
// 별 사건 · LUCKY PICK 단계 · 잭팟 통은 LUCKY와 무관해 그대로 고정이다(물리 무변경). 물리·보상 비트 증거는 r11-baseline.test.ts, 출시 카탈로그의 바쁜 판은
// rules12.test.ts(KIT(rules12) 자리).

describe("sky event (D125): golden busy board", () => {
  it("the 8-wallet busy board (seed 99 × 3,000) drops, catches and loses stars at pinned windows (rules-9 catalog)", () => {
    const run = busyBoard(loadRules9Catalog(), 99, 3000);
    assert.deepEqual(run.sky.map((e) => `${e.window}:${e.kind}:${e.key}`), [
      "367:DROP:36:0", "368:CAUGHT:36:0", "751:DROP:73:0", "751:CAUGHT:73:0", "1275:DROP:134:0", "1276:CAUGHT:134:0", "2541:DROP:255:0", "2542:CAUGHT:266:0",
    ]);
  });

  // (규칙 10 고정값 — 규칙 10 카탈로그 사본) 같은 바쁜 판: HP ×1.7이라 별 사건이 규칙 9와 다르다. LUCKY PICK 단계 수와 잭팟 통도 고정
  it("(rules-10 catalog) the same busy board: stars, LUCKY PICK levels and the jackpot pool are the rules-10 values bit for bit", () => {
    const levels = new Map<number, number>();
    const run = busyBoard(catalog, 99, 3000, 8, (_s, res) => {
      for (const sp of res.spawned) if (sp.pickLevelBps > 0) levels.set(sp.pickLevelBps, (levels.get(sp.pickLevelBps) ?? 0) + 1);
    });
    assert.deepEqual(run.sky.map((e) => `${e.window}:${e.kind}:${e.key}`), [
      "367:DROP:29:0", "367:CAUGHT:26:0", "751:DROP:55:0", "751:CAUGHT:61:0", "1275:DROP:101:0", "1278:CAUGHT:94:0", "2541:DROP:177:0", "2543:CAUGHT:177:0",
    ]);
    assert.deepEqual(Object.fromEntries([...levels].sort((a, b) => a[0] - b[0])), { 11000: 6, 12000: 3, 13000: 2, 15000: 9, 20000: 10, 30000: 1, 50000: 2 });
    assert.deepEqual(run.state.jackpot, { poolMilli: 3_687_700, contributedMilli: 3_687_700, paidMilli: 0, wins: 0 });
    assert.equal(run.state.jackpot.contributedMilli, run.state.jackpot.poolMilli + run.state.jackpot.paidMilli);
  });

  it("§8-10 serialization: one tag (v13, rules 12) with the sky section always present; JSON clone round trip keeps the hash (with a star in flight and a boost)", () => {
    const tag = (s: RoomState) => new TextDecoder().decode(serializeRoom(s).subarray(4, 4 + STATE_ENCODING_TAG.length));
    assert.equal(STATE_ENCODING_TAG, "PIKIT/state/v13");
    assert.equal(tag(createRoom(catalog, windowFactory(seedFrom(1), 1, 0), 1, 0)), "PIKIT/state/v13");
    let seenItem = false;
    let seenBoost = false;
    // (규칙 8.1) CHOG 고정 줄 판에서는 첫 세 별이 떨어진 윈도에 바로 잡혀, 윈도 끝에 날아가는 별은 2,541 윈도에 처음 보인다 → 3,000윈도(위 시험과 같은 길이)
    busyBoard(catalog, 99, 3000, 8, (state) => {
      if ((state.sky.item && !seenItem) || (state.sky.boosts.length > 0 && !seenBoost)) {
        seenItem ||= state.sky.item !== null;
        seenBoost ||= state.sky.boosts.length > 0;
        assert.equal(roomHash(cloneRoom(state)), roomHash(state));
      }
    });
    assert.ok(seenItem && seenBoost);
  });
});

// ── 단위 시험용 방 ─────────────────────────────────────────────────────────

/** 블록이 없는 하늘(y < 0)에 플레이어 곡괭이 n개를 놓은 방. 봇은 그대로(판 아래쪽). */
function skyRoom(n: number, opts: { c?: Catalog; tiers?: number[]; xs?: number[]; y?: number } = {}): RoomState {
  const c = opts.c ?? catalog;
  const state = createRoom(c, windowFactory(seedFrom(5), 1, 0), 1, 0);
  for (let i = 0; i < n; i++) state.pickaxes.push(player(c, `${i + 1}:0`, opts.tiers?.[i] ?? 0, opts.xs?.[i] ?? 1 + i, opts.y ?? -30));
  return state;
}

function player(c: Catalog, key: string, tier: number, x: number, y: number): PickaxeState {
  const t = c.pickaxes[tier]!;
  return {
    ...createPickaxe(x, y, { scale: t.scale, attack: t.attack, frictionPerTick: t.frictionPerTick, durabilityTotal: t.durability, durabilityLeft: t.durability, tier, vy: 0 }),
    key, owner: `0x${key[0]!.repeat(40)}`, priceMilli: t.priceCredits * 1000,
  };
}

/** 이름표를 적고, `sky` 스트림은 주어진 값을 차례로 돌려주는 가짜 팩토리. */
function spyRng(values: number[]): { rng: RngFactory; labels: string[] } {
  const labels: string[] = [];
  const zero: Rng = { next: () => 0.5 };
  const skyStream: Rng = { next: () => { const v = values.shift(); if (v === undefined) throw new Error("sky stream over-drawn"); return v; } };
  return { labels, rng: (label) => { labels.push(label); return label === "sky" ? skyStream : zero; } };
}

const physics = physicsFor(catalog);

describe("sky event (D125): drop rule", () => {
  it("§8-4 condition: 4 player pickaxes → the `sky` stream is never drawn; 5 → drawn; bots are not counted", () => {
    const four = skyRoom(4);
    assert.ok(four.pickaxes.filter((p) => p.owner === null).length >= 3, "봇 3개가 판에 있다");
    const a = spyRng([0]);
    const out: RoomSkyEvent[] = [];
    maybeDropSkyItem(four, catalog, 1, a.rng, physics, out);
    assert.deepEqual(a.labels, []);
    assert.equal(out.length, 0);

    const five = skyRoom(5);
    const b = spyRng([0.5]);
    maybeDropSkyItem(five, catalog, 1, b.rng, physics, out);
    assert.deepEqual(b.labels, ["sky"]);
    assert.equal(out.length, 0, "u₁ = 0.5 ≥ 0.002 → 안 떨어짐, u₂·u₃는 안 뽑음");
  });

  it("§8-4 cooldown: nothing drawn at nextWindow − 1, drawn at nextWindow; nothing drawn while a star is in flight", () => {
    const state = skyRoom(5);
    state.sky.nextWindow = 50;
    const a = spyRng([]);
    maybeDropSkyItem(state, catalog, 49, a.rng, physics, []);
    assert.deepEqual(a.labels, []);
    const b = spyRng([0.0019, 0, 0.5]);
    const out: RoomSkyEvent[] = [];
    maybeDropSkyItem(state, catalog, 50, b.rng, physics, out);
    assert.deepEqual(b.labels, ["sky"]);
    assert.equal(out.length, 1);
    const c = spyRng([]);
    maybeDropSkyItem(state, catalog, 51, c.rng, physics, []);
    assert.deepEqual(c.labels, [], "별이 있으면 안 뽑음");
  });

  it("§8-5 pick and place: u₂ → index in board order; x₀ clamped to [d, width − d]; 2 rows above; vx = (u₃ − ½)·vxJitter; DROP names the target", () => {
    const state = skyRoom(6, { tiers: [0, 1, 2, 3, 4, 0], xs: [1, 2, 3, 4, 9.9, 6] });
    const out: RoomSkyEvent[] = [];
    maybeDropSkyItem(state, catalog, 7, spyRng([0.001, 4.5 / 6, 1]).rng, physics, out);
    const it = state.sky.item!;
    const target = state.pickaxes.filter((p) => p.owner !== null)[4]!;
    assert.equal(target.x, 9.9);
    assert.equal(it.x, catalog.world.width - sky.item.diameter, "x₀ 클램프");
    assert.equal(it.y, target.y - sky.item.aboveRows);
    assert.equal(it.vx, 0.5 * sky.item.vxJitter);
    assert.equal(it.vy, sky.item.startVy);
    assert.equal(it.scale, sky.item.diameter);
    assert.equal(it.id, 7);
    assert.deepEqual(out, [{ kind: "DROP", id: 7, window: 7, tick: state.tick, x: it.x, y: it.y, key: target.key, owner: target.owner, tier: 4 }]);
  });

  it("§8-5 blocked spot → first free one going up 0.5 rows, then sideways in the candidate order; all blocked → no star and no cooldown", () => {
    // 블록이 꽉 찬 판 깊이(줄 3~6)에 곡괭이를 두면 2칸 위도 블록 안이다
    const state = skyRoom(5, { xs: [5.5, 1, 2, 3, 4], y: 6.5 });
    const target = state.pickaxes.find((p) => p.key === "1:0")!;
    const ys = new Set(state.blocks.filter((b) => b.health > 0).map((b) => b.y));
    assert.ok(ys.has(4) && ys.has(3) && ys.has(2), "줄 2~4는 살아 있는 블록");
    // 별 지름 0.5 → 줄 0 위(y ≤ −0.25)부터 빈자리. y₀ = 4.5, 4.0 … 0.5 (j ≤ 8) 모두 블록 안 → 못 떨어짐
    const before = state.sky.nextWindow;
    const out: RoomSkyEvent[] = [];
    maybeDropSkyItem(state, catalog, 3, spyRng([0, 0, 0.5]).rng, physics, out);
    assert.equal(state.sky.item, null);
    assert.equal(out.length, 0);
    assert.equal(state.sky.nextWindow, before);
    // 곡괭이 칸 위쪽 블록 하나만 비우면 그 자리(x₀ 그대로, 처음 빈 줄)에 놓인다
    for (const b of state.blocks) if (b.y === 2 && b.x === 5) b.health = 0;
    maybeDropSkyItem(state, catalog, 4, spyRng([0, 0, 0.5]).rng, physics, out);
    const it = state.sky.item!;
    assert.equal(it.x, 5.5);
    assert.equal(it.y, target.y - 2 - 0.5 * 4, "y₀ − 0.5·j 중 처음 빈 줄 (2.5)");
    // 그 줄을 다시 막고 옆 칸(x = 6.5 → 후보 x₀ + 1)을 비우면 옆으로
    state.sky.item = null;
    for (const b of state.blocks) if (b.y === 2 && b.x === 5) b.health = 1;
    for (const b of state.blocks) if (b.y === 2 && b.x === 6) b.health = 0;
    maybeDropSkyItem(state, catalog, 5, spyRng([0, 0, 0.5]).rng, physics, out);
    assert.equal(state.sky.item!.x, 6.5);
    assert.equal(state.sky.item!.y, 2.5);
  });
});

describe("sky event (D125): catch rule", () => {
  /** 별 한 걸음 뒤 자리를 미리 계산해(블록 없는 하늘이라 킥 없음) 곡괭이를 그 자리 기준으로 놓는다. */
  function catchSetup(offsets: { dx: number; dy: number; tier?: number; bot?: boolean }[]): { state: RoomState; out: RoomSkyEvent[] } {
    const state = skyRoom(0);
    const item: SkyItem = { id: 1, x: 5, y: -30, vx: 0, vy: 0.1, angle: 0, vAngle: 0, scale: 0.5, frictionPerTick: sky.item.frictionPerTick, dropTick: 0, ticks: 0 };
    const probe = { ...item };
    physics.advanceBall(probe, state.blocks, catalog.world.width, { next: () => 0.5 });
    state.sky.item = item;
    offsets.forEach((o, i) => {
      const p = player(catalog, `${i + 1}:0`, o.tier ?? 0, probe.x + o.dx, probe.y + o.dy);
      if (o.bot) p.owner = null;
      state.pickaxes.push(p);
    });
    const out: RoomSkyEvent[] = [];
    stepSkyItem(state, catalog, 10, spyRng([]).rng, physics, out);
    return { state, out };
  }

  it("centre distance 0.59 catches, 0.61 does not — the same for ×1 and ×20 (no hitbox advantage)", () => {
    for (const tier of [0, 4]) {
      const hit = catchSetup([{ dx: 0.59, dy: 0, tier }]);
      assert.equal(hit.out[0]?.kind, "CAUGHT", `tier ${tier} 0.59`);
      assert.equal(hit.out[0]?.key, "1:0");
      assert.equal(hit.state.sky.item, null);
      assert.equal(hit.state.sky.nextWindow, 10 + 1 + sky.cooldownWindows);
      assert.deepEqual(hit.state.sky.boosts, [{ key: "1:0", untilTick: hit.state.tick + sky.grow.durationTicks }]);
      const miss = catchSetup([{ dx: 0, dy: -0.61, tier }]);
      assert.equal(miss.out.length, 0, `tier ${tier} 0.61`);
      assert.ok(miss.state.sky.item);
    }
  });

  it("two within reach in one tick → the closer one; same distance → the earlier on the board; bots never catch", () => {
    assert.equal(catchSetup([{ dx: 0.5, dy: 0 }, { dx: -0.3, dy: 0 }]).out[0]!.key, "2:0");
    assert.equal(catchSetup([{ dx: 0.3, dy: 0 }, { dx: -0.3, dy: 0 }]).out[0]!.key, "1:0");
    const bot = catchSetup([{ dx: 0, dy: 0, bot: true }]);
    assert.equal(bot.out.length, 0, "봇 위를 지나도 안 잡힘");
    assert.equal(catchSetup([{ dx: 0, dy: 0, bot: true }, { dx: 0.4, dy: 0 }]).out[0]!.key, "2:0");
  });

  it("a pickaxe that ends on this tick cannot catch (catch runs after settle)", () => {
    for (const ends of [false, true]) {
      const state = skyRoom(1, { xs: [5], y: -30 });
      const p = state.pickaxes.find((q) => q.owner !== null)!;
      if (ends) p.durabilityLeft = 0;
      state.sky.item = { id: 1, x: 5, y: -30, vx: 0, vy: 0, angle: 0, vAngle: 0, scale: 0.5, frictionPerTick: sky.item.frictionPerTick, dropTick: 0, ticks: 0 };
      state.sky.nextWindow = 1_000_000;
      const res = runWindow(state, catalog, 1, [], windowFactory(seedFrom(5), 1, 1));
      if (ends) {
        assert.ok(res.ended.some((r) => r.key === p.key));
        assert.ok(!res.sky.some((e) => e.kind === "CAUGHT"));
      } else assert.equal(res.sky[0]?.kind, "CAUGHT");
    }
  });

  it("expires after lifeTicks (69) uncaught → EXPIRED with no owner; cooldown = w + 1 + 300", () => {
    const state = skyRoom(0);
    state.sky.item = { id: 3, x: 5, y: -300, vx: 0, vy: 0, angle: 0, vAngle: 0, scale: 0.5, frictionPerTick: sky.item.frictionPerTick, dropTick: 0, ticks: 0 };
    const out: RoomSkyEvent[] = [];
    for (let t = 0; t < sky.item.lifeTicks - 1; t++) stepSkyItem(state, catalog, 20, spyRng([]).rng, physics, out);
    assert.equal(out.length, 0);
    assert.equal(state.sky.item!.ticks, sky.item.lifeTicks - 1);
    stepSkyItem(state, catalog, 21, spyRng([]).rng, physics, out);
    assert.equal(out.length, 1);
    assert.equal(out[0]!.kind, "EXPIRED");
    assert.equal(out[0]!.key, null);
    assert.equal(out[0]!.owner, null);
    assert.equal(state.sky.item, null);
    assert.equal(state.sky.nextWindow, 21 + 301);
  });
});

describe("sky event (D125): GROW effect", () => {
  it("grows stepPerTick (0.13) per tick to 2.5 (×1: 12 ticks), holds for durationTicks, shrinks stepPerTick per tick back to the tier size, then the entry is removed; attack / durability / friction untouched", () => {
    const state = skyRoom(1, { xs: [5], y: -30 });
    const p = state.pickaxes.find((q) => q.owner !== null)!;
    const before = { attack: p.attack, durabilityLeft: p.durabilityLeft, durabilityTotal: p.durabilityTotal, frictionPerTick: p.frictionPerTick, vx: p.vx, vy: p.vy };
    state.sky.boosts.push({ key: p.key, untilTick: state.tick + sky.grow.durationTicks });
    const sizes: number[] = [];
    let guard = 0;
    while (state.sky.boosts.length > 0 && guard++ < 1000) {
      stepScales(state, catalog, physics);
      sizes.push(p.scale);
      state.tick += 1;
    }
    // 규칙 7(시간 배율 1.3): 틱당 0.13 → ×1은 ⌈1.5 / 0.13⌉ = 12번째 틱에 2.5
    const n = Math.ceil((sky.grow.scale - 1) / sky.grow.stepPerTick);
    assert.equal(n, 12);
    assert.ok(Math.abs(sizes[n - 1]! - 2.5) < 1e-9 && sizes[n - 2]! < 2.5, `${n}번째 틱에 2.5 (${sizes.slice(n - 3, n + 1).join(",")})`);
    assert.equal(sizes[n - 1], 2.5);
    assert.ok(sizes.slice(n - 1, sky.grow.durationTicks).every((s) => s === 2.5), "효과 동안 2.5");
    assert.equal(p.scale, 1, "등급 지름으로 돌아옴");
    assert.equal(sizes.length, sky.grow.durationTicks + n, `줄이기도 ${n}틱`);
    assert.deepEqual({ attack: p.attack, durabilityLeft: p.durabilityLeft, durabilityTotal: p.durabilityTotal, frictionPerTick: p.frictionPerTick, vx: p.vx, vy: p.vy }, before);
  });

  it("×20 grows 2.0 → 2.5 only (max(tier, 2.5))", () => {
    const state = skyRoom(1, { tiers: [4], xs: [5], y: -30 });
    const p = state.pickaxes.find((q) => q.owner !== null)!;
    state.sky.boosts.push({ key: p.key, untilTick: state.tick + 100 });
    for (let i = 0; i < 10; i++) { stepScales(state, catalog, physics); state.tick += 1; }
    assert.equal(p.scale, 2.5);
  });

  it("safe grow: a body boxed in by blocks cannot grow (tryGrow false) — position, velocity and size untouched (no embedding, no tunnelling)", () => {
    const state = skyRoom(0);
    // 줄 5의 칸 (5, 5) 하나만 비우고 그 안에 ×1(지름 1)을 꼭 맞게 둔다 — 사방이 살아 있는 블록
    for (const b of state.blocks) if (b.y === 5 && b.x === 5) b.health = 0;
    const p = player(catalog, "1:0", 0, 5.5, 5.5);
    p.vx = 0.01; p.vy = 0.02;
    state.pickaxes.push(p);
    const snap = { x: p.x, y: p.y, vx: p.vx, vy: p.vy, angle: p.angle, scale: p.scale };
    assert.equal(physics.tryGrow(p, 1.1, state.blocks, catalog.world.width), false);
    assert.deepEqual({ x: p.x, y: p.y, vx: p.vx, vy: p.vy, angle: p.angle, scale: p.scale }, snap);
    state.sky.boosts.push({ key: p.key, untilTick: state.tick + 10 });
    stepScales(state, catalog, physics);
    assert.deepEqual({ x: p.x, y: p.y, vx: p.vx, vy: p.vy, angle: p.angle, scale: p.scale }, snap, "틀에 낀 틱은 그대로");
    // 옆 칸이 깨지면 마저 커진다(밀림 ≤ 증가량일 때만)
    for (const b of state.blocks) if (b.y === 5 && (b.x === 4 || b.x === 6)) b.health = 0;
    for (const b of state.blocks) if (b.y === 4 && b.x >= 4 && b.x <= 6) b.health = 0;
    stepScales(state, catalog, physics);
    assert.ok(p.scale > 1);
    assert.ok(Math.abs(p.x - snap.x) + Math.abs(p.y - snap.y) <= 0.1 + 1e-6);
  });

  it("settle (any end reason) removes the entry: dropSkyBoost + freeze through runWindow", () => {
    const state = skyRoom(2, { xs: [3, 7], y: -30 });
    const [a, b] = state.pickaxes.filter((q) => q.owner !== null);
    state.sky.boosts.push({ key: a!.key, untilTick: 999 }, { key: b!.key, untilTick: 999 });
    dropSkyBoost(state, a!.key);
    assert.deepEqual(state.sky.boosts.map((x) => x.key), [b!.key]);
    runWindow(state, catalog, 1, [{ type: "freeze", reason: "FREEZE" }], windowFactory(seedFrom(5), 1, 1));
    assert.deepEqual(state.sky.boosts, []);
  });
});

describe("sky event (D125): busy-board invariants (§8-8, §3.10-3·4) + physics safety", () => {
  /** 몸 조각과 살아 있는 블록의 가장 깊은 겹침 (윈도 끝 박힘). */
  function embedDepth(p: PickaxeState, blocks: RoomState["blocks"]): number {
    let worst = 0;
    for (const prim of hitboxPrimitives(physics.hitboxFor(p), p)) {
      const sx = Math.max(0, Math.floor(Math.min(prim.ax, prim.bx) - prim.r));
      const ex = Math.min(catalog.world.width - 1, Math.floor(Math.max(prim.ax, prim.bx) + prim.r));
      const sy = Math.floor(Math.min(prim.ay, prim.by) - prim.r);
      const ey = Math.floor(Math.max(prim.ay, prim.by) + prim.r);
      for (let y = sy; y <= ey; y++) for (let x = sx; x <= ex; x++) {
        const block = getActiveBlockFromRingBuffer(blocks, catalog.world.width, x, y);
        const c = block ? capsuleBlockContact(prim, block) : null;
        if (c && c.depth > worst) worst = c.depth;
      }
    }
    return worst;
  }

  it("payout caps hold, boosts are live player pickaxes only, non-boosted bodies have the tier size, grown bodies never embed (> 0.05) in blocks", () => {
    let caught = 0;
    let grownWindows = 0;
    let maxEmbed = 0;
    let abnormal = 0;
    for (const seedNo of [99, 3]) {
      const run = busyBoard(catalog, seedNo, 3000, 8, (state) => {
        const live = new Set(state.pickaxes.filter((p) => p.owner !== null).map((p) => p.key));
        const boosted = new Set(state.sky.boosts.map((b) => b.key));
        for (const k of boosted) assert.ok(live.has(k), `boost ${k} is not a live player pickaxe`);
        for (const p of state.pickaxes) {
          const base = p.owner === null ? catalog.bots[p.tier]!.scale : catalog.pickaxes[p.tier]!.scale;
          if (!boosted.has(p.key)) assert.equal(p.scale, base, `${p.key} not boosted but scale ${p.scale}`);
          else {
            grownWindows += 1;
            const d = embedDepth(p, state.blocks);
            maxEmbed = Math.max(maxEmbed, d);
          }
        }
      });
      caught += run.sky.filter((e) => e.kind === "CAUGHT").length;
      for (const r of run.results) {
        const cap = rewardCapMilli(catalog, r.tier);
        if (r.endReason === "DURABILITY") assert.ok(r.paidMilli <= cap, `${r.key}: ${r.paidMilli} > ${cap}`);
        else { abnormal += 1; assert.ok(r.paidMilli <= r.priceMilli); }
      }
    }
    assert.ok(caught >= 4, `잡힘 ${caught}`);
    // 규칙 7: 효과 138틱(×1.3 빠름)이라 효과 윈도가 규칙 6보다 적다 (시드 99·3 합 82)
    assert.ok(grownWindows > 50, `효과 윈도 ${grownWindows}`);
    assert.ok(maxEmbed <= 0.05, `커진 몸 박힘 최대 ${maxEmbed}`);
    assert.equal(abnormal, 0, "비정상 종료 없음");
  });
});

describe("sky event (D125): review — biggest tier at a wall under a ceiling", () => {
  /** 몸 조각과 살아 있는 블록·양쪽 벽의 가장 깊은 겹침. */
  function worstOverlap(p: PickaxeState, blocks: RoomState["blocks"]): number {
    const width = catalog.world.width;
    let worst = 0;
    for (const prim of hitboxPrimitives(physics.hitboxFor(p), p)) {
      worst = Math.max(worst, prim.r - Math.min(prim.ax, prim.bx), Math.max(prim.ax, prim.bx) + prim.r - width);
      const sx = Math.max(0, Math.floor(Math.min(prim.ax, prim.bx) - prim.r));
      const ex = Math.min(width - 1, Math.floor(Math.max(prim.ax, prim.bx) + prim.r));
      const sy = Math.floor(Math.min(prim.ay, prim.by) - prim.r);
      const ey = Math.floor(Math.max(prim.ay, prim.by) + prim.r);
      for (let y = sy; y <= ey; y++) for (let x = sx; x <= ex; x++) {
        const block = getActiveBlockFromRingBuffer(blocks, width, x, y);
        const c = block ? capsuleBlockContact(prim, block) : null;
        if (c && c.depth > worst) worst = c.depth;
      }
    }
    return worst;
  }

  it("×20 jammed into the top-left corner of a cave (left wall + block ceiling) grows to 2.5 without ever overlapping a wall or block, each step moving ≤ 0.1", () => {
    for (const angle of [0, 0.7, 1.9, 3.3, 5.1]) {
      const state = skyRoom(0);
      // 동굴: 줄 2~6 × x 0~6 비움, 줄 1(천장)·줄 7(바닥)은 x 0~9 살아 있게
      for (const b of state.blocks) {
        if (b.y >= 2 && b.y <= 6 && b.x <= 6) b.health = 0;
        if ((b.y === 1 || b.y === 7) && b.health <= 0) b.health = 1;
      }
      const p = player(catalog, "1:0", 4, 0, 0);
      p.angle = angle;
      // 왼쪽 벽·천장에 꼭 붙인다: 겹치지 않는 가장 왼쪽·위 자리 (0.01 격자)
      let placed = false;
      for (let y = 2.0; y <= 5 && !placed; y += 0.01) for (let x = 0.5; x <= 4 && !placed; x += 0.01) {
        p.x = x; p.y = y;
        if (worstOverlap(p, state.blocks) === 0) placed = true;
      }
      assert.ok(placed);
      state.pickaxes.push(p);
      state.sky.boosts.push({ key: p.key, untilTick: state.tick + sky.grow.durationTicks });
      for (let i = 0; i < 30; i++) {
        const prev = { x: p.x, y: p.y };
        stepScales(state, catalog, physics);
        state.tick += 1;
        assert.ok(Math.hypot(p.x - prev.x, p.y - prev.y) <= sky.grow.stepPerTick + 1e-6, `angle ${angle} step ${i}: moved too far`);
        assert.ok(worstOverlap(p, state.blocks) <= 1e-6, `angle ${angle} step ${i}: overlap ${worstOverlap(p, state.blocks)} at scale ${p.scale}`);
      }
      assert.equal(p.scale, 2.5, `angle ${angle}: fully grown`);
      // 그 뒤 실제 물리로 3윈도 굴려도 박히지 않는다
      for (let w = 1; w <= 3; w++) {
        runWindow(state, catalog, w, [], windowFactory(seedFrom(11), 1, w));
        if (state.pickaxes.includes(p)) assert.ok(worstOverlap(p, state.blocks) <= 0.05, `angle ${angle} window ${w}`);
      }
    }
  });
});
