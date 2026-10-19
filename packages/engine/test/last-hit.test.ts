import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { catalogLastHitCapMilli, catalogLastHitMilli, parseCatalog, type Catalog } from "@pikit/protocol";
import {
  abnormalEndValueMilli, applyHitReward, earnedMilli, overCapMilli, rewardCapMilli, serializeRoom,
  type BlockState, type PickaxeState, type RoomLastHitEvent,
} from "../src/index.js";
import { busyBoard, createPickaxe, loadRules9Catalog, OWNERS, roomHash, sha256Hex } from "./helpers.js";

// ──────────────────────────────────────────────────────────────────────────
// 막타 LAST HIT (규칙 9, 명세 22 §3 — hard, k = reward.lastHitMult):
// 주인 있는 곡괭이가 한 방에 못 깨는 블록(hp_k > attack_t, 카탈로그 값)을 깨면 floor(k × β_t × v_k × attack_t × 1000) 밀리,
// 곡괭이당 합 ≤ 가격 × lastHitCapBps ÷ 10,000. E의 일부(REWARD 0.9 상한·over 그대로), 봇 0, BonusEvent 아님.
// ──────────────────────────────────────────────────────────────────────────

// (규칙 10) 막타 규칙은 그대로다. 이 파일의 E = 정산 식·규칙 9 over 상한은 규칙 9 카탈로그로 잰다(사다리·잭팟이 없는 카탈로그).
// 규칙 10의 균열 막타는 rules10.test.ts. (W3 키트 결정) 이 표는 규칙 9 고정값으로 둔다 — 규칙 10 출시 카탈로그의 막타 예(×1 흙 · ×1 금 · ×20 금)는 protocol.test.ts가 키트 값으로 고정한다.
const catalog = loadRules9Catalog();
const owner = OWNERS[0]!;
const [DIRT, CLAY, GOLD, DIAMOND] = [0, 1, 7, 9];

function player(c: Catalog, tier: number): PickaxeState {
  const t = c.pickaxes[tier]!;
  return createPickaxe(5, 5, { owner, tier, durabilityTotal: t.durability, durabilityLeft: t.durability, attack: t.attack, priceMilli: t.priceCredits * 1000 });
}
const block = (c: Catalog, kind: number, x: number, y = 3): BlockState => ({ kind, x, y, health: c.blocks[kind]!.hp });
/** 블록을 깨는 타격 하나 (피해 = 그 등급 공격력). */
const breakIt = (c: Catalog, p: PickaxeState, kind: number, x: number, y = 3): number =>
  applyHitReward(c, p, block(c, kind, x, y), c.pickaxes[p.tier]!.attack, { window: 9, tick: p.hits++ }, true);
const withReward = (patch: Partial<Catalog["reward"]>): Catalog => parseCatalog({ ...catalog, reward: { ...catalog.reward, ...patch } });

describe("LAST HIT (rules 9): one hit", () => {
  it("pays only when the hit destroys the block — a non-breaking hit on the same block pays nothing", () => {
    const t = catalog.pickaxes[0]!;
    const p = player(catalog, 0);
    const first = applyHitReward(catalog, p, block(catalog, DIRT, 1), t.attack, { window: 9, tick: 0 }, false);
    assert.equal(p.lastHits, 0);
    assert.equal(p.lastHitMilli, 0);
    assert.equal(first, p.baseMilli + p.luckyMilli + p.bonusMilli, "안 깬 타격 = 기본(+보너스)만");
    const before = p.baseMilli + p.luckyMilli + p.bonusMilli;
    const second = breakIt(catalog, p, DIRT, 1);
    const prize = catalogLastHitMilli(catalog, 0, DIRT);
    assert.equal(prize, Math.floor(2 * t.beta * 1 * t.attack * 1000));
    assert.equal(p.lastHits, 1);
    assert.equal(p.lastHitMilli, prize);
    assert.equal(second, p.baseMilli + p.luckyMilli + p.bonusMilli - before + prize, "반환값에 막타 몫이 들어간다");
    assert.equal(earnedMilli(p), p.baseMilli + p.luckyMilli + p.bonusMilli + p.lastHitMilli, "E = 네 몫 합");
  });

  it("pays on an already-touched cell (most LAST HITs are 2nd+ hits — the early return for touched cells must come after it)", () => {
    const p = player(catalog, 0);
    applyHitReward(catalog, p, block(catalog, GOLD, 4), 61, { window: 9, tick: 0 }, false);
    assert.deepEqual(p.touched, [3 * catalog.world.width + 4]);
    breakIt(catalog, p, GOLD, 4);
    assert.equal(p.touched.length, 1, "같은 칸 — 새 블록이 아니다");
    assert.equal(p.lastHits, 1);
    assert.equal(p.lastHitMilli, catalogLastHitMilli(catalog, 0, GOLD));
  });

  it("skips blocks the tier breaks in one hit (hp ≤ attack): ×2 on Dirt, ×5 on Clay — counted from catalog values", () => {
    for (const [tier, kind] of [[1, DIRT], [2, DIRT], [2, CLAY], [4, 3]] as const) {
      const p = player(catalog, tier);
      breakIt(catalog, p, kind, 0);
      assert.ok(catalog.blocks[kind]!.hp <= catalog.pickaxes[tier]!.attack);
      assert.deepEqual([p.lastHits, p.lastHitMilli], [0, 0], `tier ${tier} kind ${kind}`);
    }
    const p = player(catalog, 1);
    breakIt(catalog, p, CLAY, 0);
    assert.equal(p.lastHitMilli, catalogLastHitMilli(catalog, 1, CLAY), "×2는 Clay(199.47 > 122)부터");
  });

  it("bots never earn LAST HIT", () => {
    const bot = createPickaxe(5, 5, { attack: 135.7 });
    applyHitReward(catalog, bot, block(catalog, DIAMOND, 1), 135.7, { window: 1, tick: 1 }, true);
    assert.deepEqual([bot.lastHits, bot.lastHitMilli, bot.baseMilli], [0, 0, 0]);
  });

  it("per-pickaxe cap (lastHitCapBps): a small cap clips the pay, the count still rises, nothing above the cap", () => {
    const c = withReward({ lastHitCapBps: 150 });   // ×1: 가격 1,000 × 1.5% = 15,000 밀리
    const cap = catalogLastHitCapMilli(c, 0);
    assert.equal(cap, 15_000);
    const prize = catalogLastHitMilli(c, 0, DIRT);
    const p = player(c, 0);
    for (let x = 0; x < 3; x++) breakIt(c, p, DIRT, x);
    assert.equal(p.lastHits, 3);
    assert.equal(p.lastHitMilli, cap);
    assert.ok(prize < cap && 2 * prize > cap, "두 번째에서 상한에 닿는 시험");
  });

  it("lastHitMult 0 turns it off: no count, no pay, no room events", () => {
    const c = withReward({ lastHitMult: 0 });
    const p = player(c, 0);
    breakIt(c, p, GOLD, 0);
    assert.deepEqual([p.lastHits, p.lastHitMilli], [0, 0]);
    let events = 0;
    busyBoard(c, 7, 400, 4, (_s, res) => { events += res.lastHits.length; });
    assert.equal(events, 0);
  });

  it("abnormal end value includes LAST HIT in E: min(P, E + u·P)", () => {
    const p = player(catalog, 0);
    breakIt(catalog, p, GOLD, 0);
    p.durabilityLeft = p.durabilityTotal / 2;
    const unused = Math.floor((p.durabilityLeft * p.priceMilli) / p.durabilityTotal);
    assert.ok(p.lastHitMilli > 0);
    assert.equal(abnormalEndValueMilli(p), Math.min(p.priceMilli, earnedMilli(p) + unused));
    assert.equal(earnedMilli(p), p.baseMilli + p.luckyMilli + p.bonusMilli + p.lastHitMilli);
  });
});

describe("LAST HIT (rules 9): room", () => {
  it("busy board (8 wallets × 3,000 windows): no throw; events = per-pickaxe counts and pay; Σ ≤ cap; over ≤ over cap", () => {
    const byKey = new Map<string, RoomLastHitEvent[]>();
    const run = busyBoard(catalog, 99, 3000, 8, (_s, res) => {
      for (const e of res.lastHits) {
        assert.equal(e.window, res.window);
        const t = catalog.pickaxes[e.tier]!;
        assert.ok(catalog.blocks[e.blockKind]!.hp > t.attack, "한 방 블록에는 막타가 없다");
        assert.equal(e.prizeMilli, catalogLastHitMilli(catalog, e.tier, e.blockKind));
        assert.ok(e.paidMilli >= 0 && e.paidMilli <= e.prizeMilli);
        const a = byKey.get(e.key) ?? [];
        a.push(e);
        byKey.set(e.key, a);
      }
    });
    let total = 0;
    for (const r of run.results) {
      const ev = byKey.get(r.key) ?? [];
      assert.equal(ev.length, r.lastHits, `${r.key}: 사건 수`);
      assert.equal(ev.reduce((s, e) => s + e.paidMilli, 0), r.lastHitMilli, `${r.key}: Σ paid`);
      assert.ok(r.lastHitMilli <= catalogLastHitCapMilli(catalog, r.tier));
      if (r.endReason === "DURABILITY") {
        assert.equal(r.paidMilli + r.overMilli, earnedMilli(r));
        assert.equal(r.paidMilli, Math.min(earnedMilli(r), rewardCapMilli(catalog, r.tier)));
        assert.ok(r.overMilli <= overCapMilli(catalog, r.tier));
      }
      total += r.lastHits;
    }
    assert.ok(total > 100, `막타 표본이 너무 적음 (${total})`);
  });

  it("a large k and cap (k 5, 10× price) still keeps over under its cap (the cap formula carries the LAST HIT cap)", () => {
    const c = withReward({ lastHitMult: 5, lastHitCapBps: 100_000 });
    assert.equal(overCapMilli(c, 0) - overCapMilli(catalog, 0), catalogLastHitCapMilli(c, 0) - catalogLastHitCapMilli(catalog, 0));
    const run = busyBoard(c, 99, 1500);
    for (const r of run.results) if (r.endReason === "DURABILITY") assert.ok(r.overMilli <= overCapMilli(c, r.tier));
  });

  it("state: both fields are serialized (hash moves with them); JSON clone round trip keeps the hash", () => {
    const run = busyBoard(catalog, 5, 300, 4);
    const live = run.state.pickaxes.find((p) => p.owner !== null);
    assert.ok(live, "살아 있는 플레이어 곡괭이가 있어야 함");
    const h0 = roomHash(run.state);
    assert.equal(roomHash(structuredClone(run.state)), h0);
    assert.equal(roomHash(JSON.parse(JSON.stringify(run.state))), h0);
    const a = structuredClone(run.state);
    a.pickaxes.find((p) => p.key === live.key)!.lastHitMilli += 1;
    const b = structuredClone(run.state);
    b.pickaxes.find((p) => p.key === live.key)!.lastHits += 1;
    assert.notEqual(roomHash(a), h0);
    assert.notEqual(roomHash(b), h0);
    assert.notEqual(roomHash(a), roomHash(b));
    const r = structuredClone(run.state);
    assert.ok(r.results.length > 0);
    r.results[0]!.lastHits += 1;
    assert.notEqual(sha256Hex(serializeRoom(r)), h0, "결과 행도 두 칸을 담는다");
  });
});
