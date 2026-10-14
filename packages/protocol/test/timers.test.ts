// 체인 타이머 한 곳(D95): protocol 상수 = 컨트랙트 상수, 주기·타이머 사이 순서, 묶음 약속 계획.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import {
  ANCHOR_HEARTBEAT_LAG, ANCHOR_INTERVAL_ACTIVE, ANCHOR_INTERVAL_IDLE, ANCHOR_LAG_ALERT, BATCH_BLOCKS, BATCH_COMMIT_AHEAD, BATCH_COMMIT_MIN_AHEAD,
  BATCH_SKIP_LEAD, batchCommitPlan, blocksToHours, committedLeadBlocks, EPOCH_BLOCKS, roomsRulesAt, SALES_LAG, SEED_REVEAL_MAX_LAG_EPOCHS, SETTLE_STALL,
  T_FREEZE, type Hex32,
} from "../src/index.js";

const sol = (name: string) => readFileSync(new URL(`../../../../contracts/src/${name}.sol`, import.meta.url), "utf8");
const constant = (src: string, name: string): number => {
  const m = new RegExp(`constant ${name} = ([0-9_]+);`).exec(src);
  if (!m) throw new Error(`constant ${name} not found`);
  return Number(m[1]!.replaceAll("_", ""));
};

describe("chain timers (D95)", () => {
  it("equal the contract constants (rev 7 PikitLedger; the rev 6 contracts were removed in D4)", () => {
    const ledger = sol("PikitLedger");
    assert.equal(constant(ledger, "EPOCH_BLOCKS"), EPOCH_BLOCKS);
    // timers.ts는 엔진 해시 안이라 개정 6 상수(SALES_LAG·SETTLE_STALL·SKIP_LEAD …)도 값 그대로 남는다 — 서로의 순서만 본다
    assert.ok(SETTLE_STALL < SALES_LAG, "정산이 멈추면 처리 지연(앵커) 판매 중지보다 먼저 멈춘다");
    assert.ok(BATCH_SKIP_LEAD > 0 && BATCH_SKIP_LEAD < BATCH_BLOCKS, "건너뛴 뒤 다음 묶음이 시작하기 전에 약속 tx가 실릴 여유, 그러나 묶음 하나보다 짧게");
  });

  it("keep the cadence inside the gates: active < idle < heartbeat < alert < sales close < freeze", () => {
    assert.ok(ANCHOR_INTERVAL_ACTIVE < ANCHOR_INTERVAL_IDLE && ANCHOR_INTERVAL_IDLE < ANCHOR_HEARTBEAT_LAG);
    assert.ok(ANCHOR_HEARTBEAT_LAG < ANCHOR_LAG_ALERT && ANCHOR_LAG_ALERT < SALES_LAG && SALES_LAG < T_FREEZE);
    // an idle anchor posted ≤ one epoch after its P keeps the lag under the heartbeat
    assert.ok(ANCHOR_INTERVAL_IDLE + EPOCH_BLOCKS <= ANCHOR_HEARTBEAT_LAG);
    assert.equal(SEED_REVEAL_MAX_LAG_EPOCHS * EPOCH_BLOCKS, SALES_LAG);
    assert.ok(BATCH_COMMIT_AHEAD > BATCH_COMMIT_MIN_AHEAD && BATCH_COMMIT_MIN_AHEAD >= 2);
  });

  it("plans batch pre-commitments 48 h ahead: bootstrap 0..288, nothing while ≥ 46 h ahead, refill to +288 in one tx, missed when started", () => {
    const g = 10_000;
    assert.equal(BATCH_COMMIT_AHEAD, 288);
    assert.equal(blocksToHours(BATCH_COMMIT_AHEAD * BATCH_BLOCKS), 48);
    assert.deepEqual(batchCommitPlan(g - 500, g, 0), { kind: "commit", first: 0, count: 288 });          // current −1 → 0..287
    assert.deepEqual(batchCommitPlan(g - 500, g, 288), { kind: "none" });
    assert.deepEqual(batchCommitPlan(g + 11 * 2000, g, 288), { kind: "none" });                          // current 11, 276 ahead + this one
    assert.deepEqual(batchCommitPlan(g + 12 * 2000, g, 288), { kind: "commit", first: 288, count: 13 }); // current 12 → 288..300
    assert.deepEqual(batchCommitPlan(g + 288 * 2000 - 1, g, 288), { kind: "missed", batchIndex: 288, startBlock: g + 576_000 });
    // a deployment that only had 12 committed catches up to +288 in one tx
    assert.deepEqual(batchCommitPlan(g + 10 * 2000, g, 12), { kind: "commit", first: 12, count: 287 });
    // custom lead (settler BATCH_COMMIT_AHEAD)
    assert.deepEqual(batchCommitPlan(g - 500, g, 0, 24), { kind: "commit", first: 0, count: 24 });
    assert.deepEqual(batchCommitPlan(g + 10 * 2000, g, 24, 24), { kind: "none" });
    assert.deepEqual(batchCommitPlan(g + 12 * 2000, g, 24, 24), { kind: "commit", first: 24, count: 13 });
  });

  it("measures the committed lead in blocks / hours", () => {
    const g = 10_000;
    assert.equal(committedLeadBlocks(g + 500, g, 3), 5_500);
    assert.equal(committedLeadBlocks(g - 500, g, 0), 500);
    assert.ok(committedLeadBlocks(g + 2_000, g, 1) <= 0);   // batch 1 already started → missed
    assert.equal(blocksToHours(12_000), 1);
  });

  it("uses the rules active at a block (a scheduled switch applies from its switch block)", () => {
    const a = `0x${"aa".repeat(32)}` as Hex32;
    const b = `0x${"bb".repeat(32)}` as Hex32;
    const rooms = [{ roomId: 1, rulesHash: a, nextRulesHash: b, switchBlock: 500 }, { roomId: 2, rulesHash: a, nextRulesHash: null, switchBlock: 0 }];
    assert.deepEqual(roomsRulesAt(rooms, 499), [{ roomId: 1, rulesHash: a }, { roomId: 2, rulesHash: a }]);
    assert.deepEqual(roomsRulesAt(rooms, 500), [{ roomId: 1, rulesHash: b }, { roomId: 2, rulesHash: a }]);
  });
});
