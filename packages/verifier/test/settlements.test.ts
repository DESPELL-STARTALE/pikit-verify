// checkSettlements: 체인 Settled(settleEnd) ↔ 재생 정산 대조 (개정 3, D82, 규칙 7 §10). 체인은 상한만, 정확한 값은 재생이 정한다.
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { SETTLE_STALL, type SettlementRecord } from "@pikit/protocol";
import { checkSettlements, parseItemKey, replayPayout, type ReplayPayout, type VoidOverPaidRecord } from "../src/index.js";

const A = "0xa11ce00000000000000000000000000000000001";
const B = "0xb0b0000000000000000000000000000000000002";

function paid(key: string, kind: "REWARD" | "REFUND", payoutMilli: number, owner = A, window = 100, overMilli = 0): ReplayPayout {
  return replayPayout(1, {
    key, owner, tier: 0, priceMilli: 3_000_000, kind, cause: kind === "REWARD" ? "END" : "CANCEL", payoutMilli, overMilli, window, tick: 7,
  });
}

function onchain(key: string, kind: "REWARD" | "REFUND", payoutMilli: string | number, buyer = A, blockNumber = 150, overMilli: string | number = 0): SettlementRecord {
  const { purchaseId, itemIndex } = parseItemKey(key);
  return { purchaseId, itemIndex, buyer, kind, payoutMilli: String(payoutMilli), overMilli: String(overMilli), blockNumber, txHash: `0x${"ab".repeat(32)}` };
}

const replayed = [paid("3:0", "REWARD", 2_402_881), paid("3:1", "REFUND", 3_000_000), paid("4:0", "REFUND", 1_234_567, B), paid("9:0", "REWARD", 999)];

describe("checkSettlements", () => {
  it("parses item keys and rejects keys that are not on-chain items", () => {
    assert.deepEqual(parseItemKey("12345678901234567890:9"), { purchaseId: "12345678901234567890", itemIndex: 9 });
    for (const bad of ["L7:0", "01:0", "3:10", "bot:1", "3"]) assert.throws(() => parseItemKey(bad), /not an on-chain item key/);
    assert.deepEqual([replayed[0]!.purchaseId, replayed[0]!.itemIndex, replayed[0]!.roomId], ["3", 0, 1]);
  });

  it("exact match on key, kind, amount and buyer passes", () => {
    const r = checkSettlements(replayed, [onchain("3:0", "REWARD", 2_402_881), onchain("4:0", "REFUND", 1_234_567, B)]);
    assert.deepEqual([r.checked, r.matched, r.mismatches, r.skipped], [2, 2, [], 0]);
    assert.deepEqual(r.unsettled, [], "경계가 없으면 unsettled를 내지 않는다");
  });

  it("a wrong amount (even by 1 milli) or a wrong kind is a failure (E12)", () => {
    const r = checkSettlements(replayed, [onchain("3:0", "REWARD", 2_402_882), onchain("3:1", "REWARD", 3_000_000), onchain("4:0", "REFUND", 1_234_567, A)]);
    assert.deepEqual(r.mismatches.map((m) => [m.code, m.key, m.reason]), [["E12", "3:0", "AMOUNT"], ["E12", "3:1", "KIND"], ["E12", "4:0", "BUYER"]]);
    assert.deepEqual(r.mismatches[0]!.replayed, { kind: "REWARD", payoutMilli: 2_402_881, overMilli: 0, owner: A, window: 100 });
    assert.equal(r.matched, 0);
  });

  it("a settlement for a VOID item (voided purchase, or no replayed payout at all) is a failure; a second settlement is DUPLICATE", () => {
    const r = checkSettlements(replayed, [
      onchain("5:0", "REFUND", 3_000_000),          // 엔진이 무효로 없앤 구매
      onchain("6:1", "REWARD", 10),                 // 재생에서 정산이 없는 항목
      onchain("3:0", "REWARD", 2_402_881),
      onchain("3:0", "REWARD", 2_402_881),
    ], { voidedPurchases: ["5"] });
    assert.deepEqual(r.mismatches.map((m) => [m.key, m.reason]), [["5:0", "VOID_PURCHASE"], ["6:1", "NOT_PAID"], ["3:0", "DUPLICATE"]]);
    assert.equal(r.mismatches[1]!.replayed, null);
    assert.equal(r.matched, 1);
  });

  it("a purchase settled before the anchor and voided later: items with a replayed payout are compared normally, the rest is VOID_PURCHASE (D93)", () => {
    // 5:0은 무효 전에 끝나 정산됨(재생 정산 있음), 5:1은 voidPurchase가 없앰(재생 정산 없음)
    const r = checkSettlements([...replayed, paid("5:0", "REWARD", 1_500)], [
      onchain("5:0", "REWARD", 1_500),
      onchain("5:1", "REFUND", 3_000_000),
    ], { voidedPurchases: ["5"] });
    assert.deepEqual(r.mismatches.map((m) => [m.key, m.reason]), [["5:1", "VOID_PURCHASE"]]);
    assert.equal(r.matched, 1);
    const wrong = checkSettlements([...replayed, paid("5:0", "REWARD", 1_500)], [onchain("5:0", "REWARD", 1_501)], { voidedPurchases: ["5"] });
    assert.deepEqual(wrong.mismatches.map((m) => [m.key, m.reason]), [["5:0", "AMOUNT"]], "무효 구매라도 재생 정산이 있으면 값을 대조한다");
  });

  it("replayed payouts of processed purchases without an on-chain settlement are unsettled (warning only); unprocessed and void ones are not", () => {
    const r = checkSettlements([...replayed, paid("5:0", "REFUND", 3_000_000)], [onchain("3:0", "REWARD", 2_402_881)], { processedPurchases: 6, voidedPurchases: ["5"] });
    assert.deepEqual(r.mismatches, []);
    assert.deepEqual(r.unsettled.map((p) => p.key), ["3:1", "4:0"], "9:0은 아직 처리 전(purchaseId ≥ 6), 5는 무효");
  });

  it("settlements landing after the replayed range are skipped unless the replay already has the payout", () => {
    const r = checkSettlements(replayed, [onchain("7:0", "REWARD", 5, A, 900), onchain("9:0", "REWARD", 999, A, 900), onchain("8:0", "REWARD", 5, A, 300)], { throughBlock: 500 });
    assert.deepEqual([r.skipped, r.checked, r.matched], [1, 2, 1]);
    assert.deepEqual(r.mismatches.map((m) => [m.key, m.reason]), [["8:0", "NOT_PAID"]]);
  });

  it("refuses a replay with two payouts for one pickaxe (engine invariant)", () => {
    assert.throws(() => checkSettlements([replayed[0]!, replayed[0]!], []), /two payouts/);
  });

  it("(rules 7 §10-1) over is part of the amount: a wrong, missing or extra overMilli is AMOUNT; one record per pickaxe, a second one is DUPLICATE", () => {
    const big = [...replayed, paid("7:0", "REWARD", 2_700_000, A, 100, 1_234_567)];
    const ok = checkSettlements(big, [onchain("7:0", "REWARD", 2_700_000, A, 150, 1_234_567), onchain("3:0", "REWARD", 2_402_881)]);
    assert.deepEqual([ok.checked, ok.matched, ok.mismatches], [2, 2, []]);
    const bad = checkSettlements(big, [
      onchain("7:0", "REWARD", 2_700_000, A, 150, 0),             // 큰 지급만 빠뜨림 (over 0)
      onchain("3:0", "REWARD", 2_402_881, A, 150, 1),             // 없던 over
      onchain("7:0", "REWARD", 2_700_000, A, 150, 1_234_567),     // 같은 곡괭이 두 번
    ]);
    assert.deepEqual(bad.mismatches.map((m) => [m.key, m.reason]), [["7:0", "AMOUNT"], ["3:0", "AMOUNT"], ["7:0", "DUPLICATE"]]);
    assert.deepEqual(bad.mismatches[0]!.replayed, { kind: "REWARD", payoutMilli: 2_700_000, overMilli: 1_234_567, owner: A, window: 100 });
    assert.equal(bad.mismatches[0]!.onchain!.overMilli, "0");
  });

  it("(§10-4) a normal end (REWARD) closed on chain as REFUND is KIND", () => {
    const r = checkSettlements(replayed, [onchain("3:0", "REFUND", 3_000_000)]);
    assert.deepEqual(r.mismatches.map((m) => [m.key, m.reason]), [["3:0", "KIND"]]);
  });

  it("(§10-2) a replayed end without settleEnd after end window + SETTLE_STALL is OVERDUE (failure); before that it is only unsettled", () => {
    const base = { processedPurchases: 10 };
    const inTime = checkSettlements(replayed, [onchain("3:0", "REWARD", 2_402_881)], { ...base, chainThroughBlock: 100 + SETTLE_STALL });
    assert.deepEqual(inTime.mismatches, []);
    assert.deepEqual(inTime.unsettled.map((p) => p.key), ["3:1", "4:0", "9:0"]);
    const late = checkSettlements([...replayed, paid("8:0", "REWARD", 5, A, 200)], [onchain("3:0", "REWARD", 2_402_881)], { ...base, chainThroughBlock: 101 + SETTLE_STALL });
    assert.deepEqual(late.mismatches.map((m) => [m.key, m.reason, m.onchain]), [["3:1", "OVERDUE", null], ["4:0", "OVERDUE", null], ["9:0", "OVERDUE", null]]);
    assert.deepEqual(late.unsettled.map((p) => p.key), ["8:0"], "끝 윈도 200은 아직 시한 전");
    const unprocessed = checkSettlements(replayed, [], { chainThroughBlock: 101 + SETTLE_STALL });
    assert.equal(unprocessed.mismatches.length, 4, "앵커 전 구매도 시한은 같다 (D93: 끝나자마자 보낸다)");
  });

  it("(§10-3) a voided purchase whose item ended normally with over > 0 but has no settleEnd is VOID_OVER; without over it is neither failure nor warning", () => {
    const v = [...replayed, paid("5:0", "REWARD", 2_700_000, A, 100, 50_000), paid("5:1", "REWARD", 1_000), paid("5:2", "REFUND", 3_000_000)];
    const r = checkSettlements(v, [], { voidedPurchases: ["5"], processedPurchases: 6, chainThroughBlock: 10 * SETTLE_STALL });
    assert.deepEqual(r.mismatches.filter((m) => m.key.startsWith("5:")).map((m) => [m.key, m.reason]), [["5:0", "VOID_OVER"]]);
    assert.ok(!r.unsettled.some((p) => p.purchaseId === "5"));
    const settled = checkSettlements(v, [onchain("5:0", "REWARD", 2_700_000, A, 150, 50_000)], { voidedPurchases: ["5"] });
    assert.deepEqual(settled.mismatches, [], "무효 전에 settleEnd가 실렸으면 통과");
  });

  it("(rev 6) a void over is matched against VoidOverPaid (payOverAfterVoid): exact over and buyer pass; a wrong amount, a stray one or a second one fails", () => {
    const v = [...replayed, paid("5:0", "REWARD", 2_700_000, A, 100, 50_000), paid("5:1", "REWARD", 1_000)];
    const vo = (key: string, over: number | string, buyer = A, blockNumber = 300): VoidOverPaidRecord => {
      const { purchaseId, itemIndex } = parseItemKey(key);
      return { purchaseId, itemIndex, buyer, overMilli: String(over), blockNumber, txHash: `0x${"cd".repeat(32)}` };
    };
    const o = { voidedPurchases: ["5"], voidBlocks: new Map([["5", 120]]), processedPurchases: 6, chainThroughBlock: 10 * SETTLE_STALL };
    const ok = checkSettlements(v, [], { ...o, voidOverPaid: [vo("5:0", 50_000)] });
    assert.deepEqual(ok.mismatches.filter((m) => m.key.startsWith("5:")), []);
    assert.equal(ok.matched, 1);
    const bad = checkSettlements(v, [], { ...o, voidOverPaid: [vo("5:0", 49_999), vo("5:1", 1), vo("3:0", 7)] });
    assert.deepEqual(bad.mismatches.filter((m) => m.onchain !== null).map((m) => [m.key, m.reason]), [["5:0", "VOID_OVER_AMOUNT"], ["5:1", "VOID_OVER_EXTRA"], ["3:0", "VOID_OVER_EXTRA"]]);
    const buyer = checkSettlements(v, [], { ...o, voidOverPaid: [vo("5:0", 50_000, B)] });
    assert.deepEqual(buyer.mismatches.filter((m) => m.key === "5:0").map((m) => m.reason), ["VOID_OVER_AMOUNT"]);
    const twice = checkSettlements(v, [], { ...o, voidOverPaid: [vo("5:0", 50_000), vo("5:0", 50_000, A, 301)] });
    assert.deepEqual(twice.mismatches.filter((m) => m.key === "5:0").map((m) => m.reason), ["VOID_OVER_EXTRA"]);
  });

  it("(rev 6) an unpaid void over is a warning until max(end window, void block) + SETTLE_STALL, then VOID_OVER", () => {
    const v = [paid("5:0", "REWARD", 2_700_000, A, 100, 50_000)];
    const o = { voidedPurchases: ["5"], voidBlocks: new Map([["5", 400]]), processedPurchases: 6 };
    const early = checkSettlements(v, [], { ...o, chainThroughBlock: 400 + SETTLE_STALL });
    assert.deepEqual([early.mismatches, early.unsettled.map((p) => p.key)], [[], ["5:0"]], "the void came in block 400: the clock starts there");
    const late = checkSettlements(v, [], { ...o, chainThroughBlock: 401 + SETTLE_STALL });
    assert.deepEqual(late.mismatches.map((m) => [m.key, m.reason, m.onchain]), [["5:0", "VOID_OVER", null]]);
  });

  it("snapshot start: records of items that ended before the snapshot are skipped; items alive in the snapshot or bought after it must have a replayed end", () => {
    const before = { processedPurchases: 5, alive: new Set(["4:0"]) };
    const r = checkSettlements(replayed, [
      onchain("1:0", "REWARD", 10),          // 스냅숏 앞에서 끝남 (purchaseId < 5, 살아 있지 않음) → 건너뜀
      onchain("4:1", "REFUND", 3),           // 같음
      onchain("4:0", "REFUND", 1_234_567, B),// 살아 있던 곡괭이 → 재생 정산과 대조 (맞음)
      onchain("2:0", "REWARD", 10),          // 앞 구매지만 재생 정산이 없는데 살아 있지도 않음 → 건너뜀
      onchain("6:0", "REWARD", 10),          // 스냅숏 뒤 구매인데 재생 정산이 없음 → NOT_PAID
    ], { before });
    assert.equal(r.skipped, 3);
    assert.deepEqual(r.mismatches.map((m) => [m.key, m.reason]), [["6:0", "NOT_PAID"]]);
    const alive = checkSettlements(replayed, [onchain("4:2", "REWARD", 10)], { before: { processedPurchases: 5, alive: new Set(["4:2"]) } });
    assert.deepEqual(alive.mismatches.map((m) => [m.key, m.reason]), [["4:2", "NOT_PAID"]], "settled while still alive in the snapshot and never ended in the replay");
  });
});
