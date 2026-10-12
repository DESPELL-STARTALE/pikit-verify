import { BOARD_BATCH_BLOCKS, EPOCH_BLOCKS, type Hex32 } from "./crypto.js";

// ──────────────────────────────────────────────────────────────────────────
// 체인 타이머와 앵커·묶음 약속 주기 — 한 곳 (D95, 블록 = 0.3초). settler·game-server·web·배포 도구는 여기서만 가져온다.
// 컨트랙트 상수와 같아야 하는 것은 그 이름을 적었다(test/timers.test.ts가 .sol 원문과 대조한다).
//
// 고정 비용(트래픽과 무관한 체인 tx)을 줄이려고 앵커를 드물게 낸다. 지급은 앵커를 기다리지 않으므로(D93) 앵커가 늦어져도
// 바뀌는 것은 "공개 검증이 체인에 고정되기까지의 시간"과 아래 판매 중지·동결 타이머뿐이다:
//
//   앵커 주기     방에 플레이어 곡괭이가 있으면 ANCHOR_INTERVAL_ACTIVE(1,000 = 5분)마다.
//                 쉬는데 직전 앵커 뒤로 돈이 움직였으면(구매·취소·정산·환불·프로모·세션 등록) ANCHOR_INTERVAL_IDLE(6,000 = 30분)마다.
//                 그 밖(봇만 움직임)에는 처리 지연이 ANCHOR_HEARTBEAT_LAG(7,000 = 35분)에 닿을 때만(하트비트).
//   판매 중지     처리 지연 > SALES_LAG(8,000 = 40분). 하트비트보다 1,000블록(5분) 뒤 — 앵커 tx 재시도 여유.
//   동결·무효     처리 지연 > T_FREEZE(12,000 = 1시간). 판매 중지 뒤 20분: 앵커 지갑·RPC 장애가 이미 플레이한 구매를
//                 무효로 뒤집지 않도록. 죽은 서버는 클라이언트가 몇 초 만에 잡고(L1·L2 → 구매 잠금) 그사이 들어간 구매는
//                 무효(refundUnprocessed)·정산 시한(refundUnsettled)으로 100% 돌아간다 — 늦어질 뿐이다.
//   시드 공개     SEED_REVEAL_MAX_LAG_EPOCHS = SALES_LAG / EPOCH_BLOCKS(40): 앵커가 시드를 공개하므로 판매 중지와 같이 닫힌다.
// ──────────────────────────────────────────────────────────────────────────

/** PikitShop.SALES_LAG — 처리 지연이 이보다 크면 구매가 되돌려진다(판매 중지). */
export const SALES_LAG = 8_000;
/** PikitFairness.T_FREEZE — 처리 지연이 이보다 크면 방 동결, 덮이지 않은 구매는 무효(F = P_last + T_FREEZE + 1). */
export const T_FREEZE = 12_000;
/** PikitFairness.SEED_REVEAL_MAX_LAG_EPOCHS = SALES_LAG / EPOCH_BLOCKS. */
export const SEED_REVEAL_MAX_LAG_EPOCHS = SALES_LAG / EPOCH_BLOCKS;
/** PikitFairness.BATCH_BLOCKS — 전역 묶음 j = 블록 [W0 + 2000j, W0 + 2000j + 1999]. */
export const BATCH_BLOCKS = BOARD_BATCH_BLOCKS;

/** 방 하나라도 플레이어 곡괭이가 살아 있거나 대기 중이면 직전 앵커 게시 블록에서 이만큼 뒤에. */
export const ANCHOR_INTERVAL_ACTIVE = 1_000;
/** 모두 쉬지만 직전 앵커 뒤로 체인 활동(돈)이 있었으면 이만큼 뒤에. */
export const ANCHOR_INTERVAL_IDLE = 6_000;
/** 언제든 처리 지연(머리 − 직전 P)이 이만큼이면 앵커를 낸다(판매가 닫히지 않게 하는 하트비트). */
export const ANCHOR_HEARTBEAT_LAG = 7_000;
/** 정상 앵커 지연의 상한(하트비트 + 에폭 정렬 200) — 넘으면 E13 운영 경보(settler, 덮지 않은 구매·플레이어 곡괭이가 있을 때 — 쉬는 판은 SALES_LAG, D133). 플레이어 배너에는 쓰지 않는다(D132). */
export const ANCHOR_LAG_ALERT = ANCHOR_HEARTBEAT_LAG + EPOCH_BLOCKS;

/** 블록 시간(D95: 300 ms). 블록 수 ↔ 시간 환산(감시·점검 표시)에만 쓴다 — 타이머 자체는 블록 단위다. */
export const BLOCK_MS = 300;

/**
 * 묶음 사전 약속 여유(B2, 2026-10-10 운영 검토): 지금 묶음 뒤로 이만큼(288 = 48시간)까지 약속해 둔다.
 * 약속은 그 묶음 첫 블록 전에만 받고 늦은 묶음을 건너뛰는 길이 없다(PikitFairness.commitBatches) — settler·앵커 키·RPC가
 * 여유보다 오래 멈추면 앵커가 영영 못 나아가 재배포밖에 없다. 48시간이면 주말 내내 VM이 죽어도 버틴다.
 * 대가: 묶음 해시는 "묶음 첫 블록에 활성인 방별 규칙"을 묶으므로 **규칙 전환·방 추가(ROOM_IDS)는 48시간 넘게 앞서 예약**해야 한다
 * (체인 규칙 전환 공지 PikitShop.NOTICE는 72시간이라 체인 예약 전환은 언제나 이 안에 이미 보인다). settler 설정 BATCH_COMMIT_AHEAD로 바꾼다.
 */
export const BATCH_COMMIT_AHEAD = 288;
/** 다시 채우는 단위: 여유가 BATCH_COMMIT_AHEAD − 이 값 아래로 내려가면 다시 끝까지 채운다 → 약 2시간마다 묶음 12~13개짜리 tx 하나(하루 약 12 tx). */
export const BATCH_COMMIT_REFILL = 12;
/** 기본 설정에서 다시 채우는 기준(276 = 46시간): 여유는 늘 46~48시간 사이. */
export const BATCH_COMMIT_MIN_AHEAD = BATCH_COMMIT_AHEAD - BATCH_COMMIT_REFILL;
/** 점검(check)·감시가 FAIL로 보는 약속 여유(시간). 이보다 작으면 settler 묶음 작업이 멈춘 것 — 영구 정지 전에 고쳐야 한다. */
export const BATCH_COMMIT_LEAD_FAIL_HOURS = 24;

/**
 * PikitFairness.SKIP_LEAD — 늦은 묶음 건너뛰기 (D97). 약속이 끊겨 다음 묶음이 이미 시작됐고(missed) 처리 지연이 T_FREEZE를 넘었으면
 * 누구나 `skipMissedBatches()`를 부를 수 있다: 다음 약속 묶음 = 첫 블록이 지금 + SKIP_LEAD 이상인 첫 묶음, 그 첫 블록까지 판매 중지.
 * 덮이지 않은 구매는 이미 동결 규칙으로 무효다(뒤이은 늦은 앵커가 무효로 확정 → refundUnprocessed 100%). settler 묶음 작업이 스스로 부른다.
 * 그래서 48시간 넘는 장애도 재배포 없이 복구된다.
 */
export const BATCH_SKIP_LEAD = 400;

/**
 * PikitShop.SETTLE_STALL — 정산 멈춤 판매 중지 (D97). 가장 오래된 "열린" 구매(정산·환불·무효로 닫히지 않음)의 구매 블록이 이만큼(30분)
 * 넘게 지났으면 체인이 구매를 되돌린다(SettlementStalled). 풀리는 길은 기존 정산 시한 장치다: 정산하거나, 오너가 settleTimeout을 줄이고
 * 누구나 refundUnsettled. 정산 키만 죽고 판매가 열린 채 24시간 뒤 100% 환불(공짜 플레이)이 되는 길을 막는다.
 */
export const SETTLE_STALL = 6_000;

/** 블록 수 → 시간 (BLOCK_MS 기준, 표시용). */
export function blocksToHours(blocks: number): number {
  return (blocks * BLOCK_MS) / 3_600_000;
}

/** 약속 여유(블록): 다음 미약속 묶음(nextBatchIndex)의 첫 블록 − 확정 머리. 0 이하면 이미 늦었다(앵커가 그 묶음에서 멈춘다). */
export function committedLeadBlocks(head: number, genesisBlock: number, nextBatchIndex: number): number {
  return batchStartBlock(nextBatchIndex, genesisBlock) - head;
}

/** 확정 머리 head가 속한 전역 묶음 (W0 전이면 −1). */
export function batchIndexAt(head: number, genesisBlock: number): number {
  return head < genesisBlock ? -1 : Math.floor((head - genesisBlock) / BATCH_BLOCKS);
}

/** 전역 묶음 j의 첫 블록. */
export function batchStartBlock(batchIndex: number, genesisBlock: number): number {
  return genesisBlock + BATCH_BLOCKS * batchIndex;
}

export type BatchCommitPlan =
  | { kind: "none" }                                       // 아직 충분히 앞서 있다
  | { kind: "commit"; first: number; count: number }       // commitBatches(first, count개)
  | { kind: "missed"; batchIndex: number; startBlock: number };   // 그 묶음이 이미 시작됐다 — 앵커가 넘을 수 없다. 동결 뒤 skipMissedBatches(D97)

/**
 * 묶음 사전 약속 계획 (settler 묶음 작업과 bootstrap이 같은 규칙을 쓴다). next = PikitFairness.nextBatchIndex().
 * ahead = 지금 묶음 뒤로 약속해 둘 묶음 수(기본 BATCH_COMMIT_AHEAD = 48시간). 남은 여유가 ahead − BATCH_COMMIT_REFILL 이하가 되면
 * 지금 묶음 + ahead까지 한 tx로 채운다. tx는 머리 다음 블록 이후에 실리므로 첫 블록이 head + 1 이하인 묶음은 이미 늦었다.
 */
export function batchCommitPlan(head: number, genesisBlock: number, next: number, ahead: number = BATCH_COMMIT_AHEAD): BatchCommitPlan {
  const current = batchIndexAt(head, genesisBlock);
  const minAhead = Math.max(2, ahead - BATCH_COMMIT_REFILL);
  if (next > current + minAhead) return { kind: "none" };
  const startBlock = batchStartBlock(next, genesisBlock);
  if (startBlock <= head + 1) return { kind: "missed", batchIndex: next, startBlock };
  return { kind: "commit", first: next, count: current + ahead - next + 1 };
}

/** PikitShop.roomOf(roomId)의 규칙 부분: 지금 규칙과 예약된 다음 규칙(없으면 null). */
export interface RoomRulesSchedule {
  roomId: number;
  rulesHash: Hex32;
  nextRulesHash: Hex32 | null;
  switchBlock: number;
}

/** 블록 b에 활성인 방별 규칙 (PikitShop._activeRules와 같은 규칙: 예약이 있고 b ≥ switchBlock이면 다음 규칙). */
export function roomsRulesAt(rooms: readonly RoomRulesSchedule[], block: number): { roomId: number; rulesHash: Hex32 }[] {
  return rooms.map((r) => ({ roomId: r.roomId, rulesHash: r.nextRulesHash !== null && block >= r.switchBlock ? r.nextRulesHash : r.rulesHash }));
}
