import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";
import type { EngineInput } from "@pikit/protocol";
import { catalogLastHitCapMilli, catalogLuckyCeilingMilli } from "@pikit/protocol";
import { baseCeilingMilli, cloneRoom, createRoom, earnedMilli, overCapMilli, rewardCapMilli, runWindow } from "../src/index.js";
import { expectedSettlement, fuzzPlan, loadCatalog, OWNERS, runPlan, seedFrom, windowFactory, roomHash } from "./helpers.js";

const catalog = loadCatalog();
const [A, B] = OWNERS as [string, string, string];

describe("room: queue and spawn rules", () => {
  it("a purchase in window w spawns the first pickaxe on the board in w (no gate — rules 7); the next one spawns the window after the first ends", () => {
    const seed = seedFrom(1);
    const plan = new Map<number, EngineInput[]>([[1, [{ type: "purchase", ref: "10", owner: A, tiers: [0, 0] }]]]);
    const run = runPlan(catalog, seed, plan, 600);
    assert.ok(run.results.length >= 2, "두 곡괭이 모두 끝나야 함");
    const [first, second] = run.results as [typeof run.results[0], typeof run.results[0]];
    assert.strictEqual(first.key, "10:0");
    assert.strictEqual(second.key, "10:1");
    assert.strictEqual(first.spawnTick, 0, "첫 곡괭이는 구매 윈도의 첫 틱에 판에 놓인다");
    assert.ok(second.spawnTick > first.endTick, "대기열 다음 곡괭이는 앞 곡괭이가 끝난 뒤에");
    const gap = catalog.limits.queueGapWindows ?? 0;
    assert.strictEqual(second.spawnTick, (first.endWindow + gap) * catalog.world.ticksPerWindow, "앞 곡괭이가 끝난 윈도 e의 다음 윈도 + queueGapWindows의 첫 틱 (윈도 w의 틱은 (w−1)·T부터)");
  });

  describe("(규칙 12, 명세 25 §3.8, D267) limits.queueGapWindows", () => {
    const T = catalog.world.ticksPerWindow;
    const withGap = (g: number | undefined) => {
      const c = structuredClone(catalog);
      if (g === undefined) delete c.limits.queueGapWindows; else c.limits.queueGapWindows = g;
      return c;
    };
    const pairs = (c: typeof catalog, seed: number, n: number) => {
      const plan = new Map<number, EngineInput[]>([[1, [{ type: "purchase", ref: "10", owner: A, tiers: Array.from({ length: n }, () => 0) }]]]);
      return runPlan(c, seedFrom(seed), plan, 4000).results.filter((r) => r.owner === A);
    };

    it("shipped catalog uses G = 16; the next queued pickaxe spawns exactly G windows after the settle window's successor", () => {
      assert.strictEqual(catalog.limits.queueGapWindows, 16);
      const rs = pairs(catalog, 41, 4);
      assert.strictEqual(rs.length, 4);
      for (let i = 1; i < rs.length; i++) {
        const spawnWindow = rs[i]!.spawnTick / T + 1;
        assert.strictEqual(spawnWindow, rs[i - 1]!.endWindow + 1 + 16, `#${i}`);
      }
    });

    it("G = 0 and an absent field both give the rules-11 behaviour (next window), bit-identical to each other", () => {
      for (const g of [0, undefined]) {
        const rs = pairs(withGap(g), 42, 3);
        for (let i = 1; i < rs.length; i++) assert.strictEqual(rs[i]!.spawnTick / T + 1, rs[i - 1]!.endWindow + 1, `G=${g} #${i}`);
      }
      const plan = new Map<number, EngineInput[]>([[1, [{ type: "purchase", ref: "10", owner: A, tiers: [0, 0, 0] }]]]);
      assert.strictEqual(runPlan(withGap(0), seedFrom(42), plan, 3000).hash, runPlan(withGap(undefined), seedFrom(42), plan, 3000).hash);
    });

    it("the gap counts from the window the pickaxe is actually removed (after the item-roulette grace), not the window its durability ran out", () => {
      const c = withGap(5);
      const R = c.buffs!.items!.rouletteTicks;
      const seed = seedFrom(43);
      const state = createRoom(c, windowFactory(seed, 1, 0), 1, 0);
      runWindow(state, c, 1, [{ type: "purchase", ref: "10", owner: A, tiers: [0, 0] }], windowFactory(seed, 1, 1));
      const p = state.pickaxes.find((x) => x.owner === A)!;
      // 내구도가 바닥난 채 GIANT 룰렛이 R틱 돈다 (불변식 tick < itemUntil ≤ tick + R, tick = 마지막으로 돈 틱) → 유예
      p.durabilityLeft = 0;
      p.itemUntil = state.tick - 1 + R;
      p.itemKind = c.buffs!.items!.table.findIndex((e) => e.kind === "GIANT");
      const graceEnd = Math.floor((p.itemUntil) / T) + 1;   // itemUntil 틱이 든 윈도
      assert.ok(graceEnd > 2, "유예가 다음 윈도를 넘어가야 시험이 의미 있음");
      const ended: (typeof state.results)[number][] = [];
      for (let w = 2; w <= graceEnd + 12; w++) ended.push(...runWindow(state, c, w, [], windowFactory(seed, 1, w)).ended);
      const first = ended.find((r) => r.key === "10:0")!;
      assert.strictEqual(first.endWindow, graceEnd, "유예가 끝난 윈도에 빠진다 (내구도가 바닥난 윈도 2가 아니라)");
      const second = state.pickaxes.find((x) => x.key === "10:1") ?? ended.find((r) => r.key === "10:1");
      assert.ok(second, "다음 곡괭이가 나와 있어야 함");
      assert.strictEqual(second.spawnTick / T + 1, graceEnd + 1 + 5);
    });

    it("a fresh purchase into an empty queue is not delayed: it spawns in its own purchase window even right after a settle", () => {
      const first = pairs(catalog, 44, 1)[0]!;
      const buyAt = first.endWindow + 1;
      const plan = new Map<number, EngineInput[]>([
        [1, [{ type: "purchase", ref: "10", owner: A, tiers: [0] }]],
        [buyAt, [{ type: "purchase", ref: "11", owner: A, tiers: [0] }]],
      ]);
      const rs = runPlan(catalog, seedFrom(44), plan, buyAt + 1).state.pickaxes.filter((p) => p.owner === A);
      assert.strictEqual(rs.length, 1);
      assert.strictEqual(rs[0]!.key, "11:0");
      assert.strictEqual(rs[0]!.spawnTick, (buyAt - 1) * T, "구매 윈도의 첫 틱");
    });
  });

  it("only one live pickaxe per owner; the queue holds at most queueMax and refunds the overflow 100% (REFUND OVERFLOW)", () => {
    const state = createRoom(catalog, windowFactory(seedFrom(2), 1, 0), 1, 0);
    const tiers = Array.from({ length: 10 }, () => 0);
    const res = runWindow(state, catalog, 1, [
      { type: "purchase", ref: "1", owner: A, tiers },
      { type: "purchase", ref: "2", owner: A, tiers: [1, 1] },
    ], windowFactory(seedFrom(2), 1, 1));
    assert.strictEqual(state.pickaxes.filter((p) => p.owner === A).length, 1);
    const slot = state.owners.find((s) => s.owner === A)!;
    // 입력이 스폰보다 먼저: 10개가 대기열을 채우고, 뒤의 2개는 넘침, 그다음 맨 앞 1개가 스폰
    assert.strictEqual(slot.queue.length, catalog.limits.queueMax - 1);
    const overflow = res.payouts.filter((e) => e.cause === "OVERFLOW");
    assert.deepEqual(overflow.map((e) => e.key), ["2:0", "2:1"], "대기열이 찬 뒤 산 2개는 넘침");
    assert.strictEqual(overflow[0]!.payoutMilli, catalog.pickaxes[1]!.priceCredits * 1000);
    assert.strictEqual(overflow[0]!.kind, "REFUND");
  });

  it("purchases are queued without any balance check (paid on chain); cancel refunds 100%", () => {
    const state = createRoom(catalog, windowFactory(seedFrom(3), 1, 0), 1, 0);
    const res = runWindow(state, catalog, 1, [
      { type: "purchase", ref: "1", owner: B, tiers: [0] },
      { type: "purchase", ref: "2", owner: B, tiers: [0, 0, 0] },
      { type: "cancel", owner: B, itemKey: "2:2" },
    ], windowFactory(seedFrom(3), 1, 1));
    assert.deepEqual(state.rejected, []);
    assert.deepEqual(res.payouts.map((p) => [p.key, p.kind, p.cause, p.payoutMilli]), [["2:2", "REFUND", "CANCEL", catalog.pickaxes[0]!.priceCredits * 1000]]);
  });

  it("freeze: live pickaxe gets min(P, E + u·P) (rules 11 wholeCredits: floored to whole credits), queued ones 100%", () => {
    const state = createRoom(catalog, windowFactory(seedFrom(4), 1, 0), 1, 0);
    runWindow(state, catalog, 1, [{ type: "purchase", ref: "1", owner: A, tiers: [2, 2] }], windowFactory(seedFrom(4), 1, 1));
    for (let w = 2; w <= 20; w++) runWindow(state, catalog, w, [], windowFactory(seedFrom(4), 1, w));
    const res = runWindow(state, catalog, 21, [{ type: "freeze", reason: "FREEZE" }], windowFactory(seedFrom(4), 1, 21));
    const r = state.results.find((x) => x.key === "1:0")!;
    assert.strictEqual(r.endReason, "FREEZE");
    const price = catalog.pickaxes[2]!.priceCredits * 1000;
    const unused = ((r.durabilityTotal - r.durabilityUsed) * price) / r.durabilityTotal;   // u × P
    const exact = Math.min(price, earnedMilli(r) + unused);
    const expected = catalog.reward.wholeCredits ? Math.floor(exact / 1000) * 1000 : exact;
    assert.ok(Math.abs(r.paidMilli - expected) <= 1, `paid ${r.paidMilli} vs min(P, E + u·P) ${expected}`);
    if (catalog.reward.wholeCredits) assert.equal(r.paidMilli % 1000, 0, "(규칙 11) 정수 크레딧");
    assert.ok(r.paidMilli <= price);
    assert.deepEqual(res.payouts.map((p) => [p.key, p.kind, p.cause, p.overMilli]), [["1:0", "REFUND", "ABNORMAL_END", 0], ["1:1", "REFUND", "QUEUE_REFUND", 0]]);
    assert.strictEqual(res.payouts[0]!.payoutMilli, r.paidMilli);
    assert.strictEqual(res.payouts[1]!.payoutMilli, price);
    assert.strictEqual(state.pickaxes.some((p) => p.owner !== null), false);
  });

  it("never pauses (D94): bots tick every window even with no player pickaxe alive or queued", () => {
    const state = createRoom(catalog, windowFactory(seedFrom(5), 1, 0), 1, 0);
    const botY0 = state.pickaxes.map((p) => p.y);
    const res = runWindow(state, catalog, 1, [], windowFactory(seedFrom(5), 1, 1));
    assert.strictEqual(res.ticksRun, catalog.world.ticksPerWindow);
    assert.strictEqual(state.tick, catalog.world.ticksPerWindow);
    assert.ok(state.pickaxes.every((p) => p.owner === null));
    assert.ok(state.pickaxes.some((p, i) => p.y !== botY0[i]), "bots moved");
  });
});

describe("determinism", () => {
  it("same seed + same inputs → bit-identical state bytes and payouts (two runs)", () => {
    const seed = seedFrom(11);
    const plan = fuzzPlan(catalog, seed, 500, true);
    const a = runPlan(catalog, seed, plan, 500);
    const b = runPlan(catalog, seed, plan, 500);
    assert.ok(a.results.length > 3, "시나리오에 끝난 곡괭이가 충분해야 함");
    assert.strictEqual(a.hash, b.hash);
    assert.deepEqual(a.results, b.results);
  });

  it("a different seed gives a different trajectory", () => {
    const plan = fuzzPlan(catalog, seedFrom(11), 200, false);
    assert.notStrictEqual(runPlan(catalog, seedFrom(11), plan, 200).hash, runPlan(catalog, seedFrom(12), plan, 200).hash);
  });

  it("snapshot → JSON clone → continue gives the same result as an uninterrupted run (restart safety)", () => {
    const seed = seedFrom(13);
    const plan = fuzzPlan(catalog, seed, 300, false);
    const straight = runPlan(catalog, seed, plan, 300);

    let state = createRoom(catalog, windowFactory(seed, 1, 0), 1, 0);
    for (let w = 1; w <= 300; w++) {
      if (w % 37 === 0) {   // 서버 재시작: 스냅샷에서 복원
        state = cloneRoom(state);
      }
      runWindow(state, catalog, w, plan.get(w) ?? [], windowFactory(seed, 1, w));
    }
    assert.strictEqual(roomHash(state), straight.hash);
  });

  it("`node --jitless` (interpreter only) and normal `node` produce the same hash and payouts", () => {
    // V8 플래그 확인: 자식 프로세스가 process.execArgv에 --jitless가 있는지 스스로 보고한다.
    // --jitless는 최적화 컴파일러(Sparkplug/Maglev/TurboFan)를 끄고 Ignition 인터프리터로만 돈다.
    const script = fileURLToPath(new URL("./fixtures/run-scenario.js", import.meta.url));
    const normal = JSON.parse(execFileSync(process.execPath, [script, "21", "300"], { encoding: "utf8" })) as { jitless: boolean; hash: string; paid: unknown };
    const jitless = JSON.parse(execFileSync(process.execPath, ["--jitless", script, "21", "300"], { encoding: "utf8" })) as { jitless: boolean; hash: string; paid: unknown };
    assert.strictEqual(normal.jitless, false);
    assert.strictEqual(jitless.jitless, true, "자식 프로세스에 --jitless가 걸려 있어야 함");
    assert.strictEqual(jitless.hash, normal.hash);
    assert.deepEqual(jitless.paid, normal.paid);
  });

  it("(D125) a busy board where sky stars drop, get caught and grow pickaxes: `node --jitless` = normal `node`", () => {
    const script = fileURLToPath(new URL("./fixtures/run-scenario.js", import.meta.url));
    type Out = { jitless: boolean; hash: string; paid: unknown; sky: [number, number, string, string | null][] };
    const normal = JSON.parse(execFileSync(process.execPath, [script, "busy", "99", "1300"], { encoding: "utf8" })) as Out;
    const jitless = JSON.parse(execFileSync(process.execPath, ["--jitless", script, "busy", "99", "1300"], { encoding: "utf8" })) as Out;
    assert.strictEqual(jitless.jitless, true);
    assert.ok(normal.sky.some((e) => e[2] === "CAUGHT"), "이 판에서 별이 잡혀야 시험이 의미 있다");
    assert.strictEqual(jitless.hash, normal.hash);
    assert.deepEqual(jitless.paid, normal.paid);
    assert.deepEqual(jitless.sky, normal.sky);
  });
});

describe("invariants (fuzzed seeds)", () => {
  it("every pickaxe: base ≤ β·max(v)·D, lucky ≤ its ceiling, bonus ≤ cap, LAST HIT ≤ its cap, E = four shares; normal end paid = min(T, REWARD cap), over = T − paid ≤ over cap + J (rules 10 T); abnormal end without level/J paid ≤ P, over 0", () => {
    let pickaxes = 0;
    let abnormal = 0;
    for (let s = 100; s < 124; s++) {
      const seed = seedFrom(s);
      const run = runPlan(catalog, seed, fuzzPlan(catalog, seed, 450, s % 3 === 0), 450);
      for (const r of run.results) {
        pickaxes += 1;
        const tier = catalog.pickaxes[r.tier]!;
        const baseCeil = baseCeilingMilli(catalog, r.tier);
        const cap = tier.bonusCap * 1000;
        assert.ok(r.baseMilli <= baseCeil, `${r.key}: base ${r.baseMilli} > ceiling ${baseCeil}`);
        assert.ok(r.luckyMilli <= catalogLuckyCeilingMilli(catalog, r.tier), `${r.key}: lucky ${r.luckyMilli}`);
        assert.ok(r.bonusMilli <= cap, `${r.key}: bonus ${r.bonusMilli} > cap ${cap}`);
        assert.ok(r.lastHitMilli <= catalogLastHitCapMilli(catalog, r.tier), `${r.key}: last hit ${r.lastHitMilli}`);
        assert.equal(earnedMilli(r), r.baseMilli + r.luckyMilli + r.bonusMilli + r.lastHitMilli, "E = 네 몫 합 (규칙 9)");
        assert.ok(r.durabilityUsed <= r.durabilityTotal + 1e-9);
        const e = expectedSettlement(catalog, r);
        if (r.endReason === "DURABILITY" || e.kind === "REWARD") {
          assert.equal(r.paidMilli, e.payoutMilli);
          assert.equal(r.overMilli, e.overMilli);
          assert.equal(r.pickMilli, e.pickMilli);
          assert.ok(r.paidMilli <= rewardCapMilli(catalog, r.tier));
          assert.ok(r.overMilli <= overCapMilli(catalog, r.tier) + r.jackpotMilli);
          if (r.endReason !== "DURABILITY") abnormal += 1;
        } else {
          // 비정상 종료(동결·멈춤·타이머)는 설계상 가격 1배까지 (설계 §5.3: min(P, E + u·P)), 초과분 없음
          abnormal += 1;
          assert.ok(r.paidMilli <= r.priceMilli, `${r.key}: abnormal paid ${r.paidMilli} > price ${r.priceMilli}`);
          assert.equal(r.overMilli, 0);
        }
      }
      for (const p of run.payouts) {
        assert.ok(Number.isSafeInteger(p.payoutMilli) && p.payoutMilli >= 0, `${p.key}: payout ${p.payoutMilli}`);
        if (p.kind === "REFUND") assert.ok(p.payoutMilli <= p.priceMilli && p.overMilli === 0, `${p.key}: refund above price or with over`);
      }
    }
    assert.ok(pickaxes >= 100, `표본이 너무 적음 (${pickaxes})`);
    assert.ok(abnormal > 0, "동결 시나리오가 비정상 종료를 만들어야 함");
  });
});
