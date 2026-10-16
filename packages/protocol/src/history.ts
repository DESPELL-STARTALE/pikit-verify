import { z } from "zod";
import { Address, BlockNumber, BonusEventKind, U32 } from "./primitives.js";

// ──────────────────────────────────────────────────────────────────────────
// 곡괭이 히스토리 1행(곡괭이 1개 = 1행)과 예외·환불 기록 (설계 §5, §8.5, 부록 D)
// ──────────────────────────────────────────────────────────────────────────

/** 곡괭이가 끝난 이유. DURABILITY만 정상 종료, 나머지는 비정상 종료 값 min(P, E + u·P)을 받는다(VOID는 0). */
export const EndReason = z.enum(["DURABILITY", "STUCK", "TIMER", "FREEZE", "ROOM_CLOSED", "VOID"]);
export type EndReason = z.infer<typeof EndReason>;

/**
 * 곡괭이 1개의 보너스 사건 요약 (엔진 BonusEvent와 같은 값). 곡괭이당 몇 개뿐이다(보너스 상한 때문에 금액이 있는 것은 더 적다).
 * prizeMilli = 규칙상 상금, paidMilli = 상한을 적용해 실제 들어간 값. streakCount = 그 순간 같은 종류 새 블록 연속 길이.
 */
export const BonusEventSummary = z.object({
  kind: BonusEventKind,
  tick: z.number().int().nonnegative(),
  window: BlockNumber,
  blockKind: z.number().int().nonnegative(),
  streakCount: z.number().int().nonnegative(),
  prizeMilli: z.number().int().nonnegative(),
  paidMilli: z.number().int().nonnegative(),
}).strict();
export type BonusEventSummary = z.infer<typeof BonusEventSummary>;

export const PickaxeHistoryRecord = z.object({
  itemKey: z.string().min(1),          // 곡괭이 번호: MON "purchaseId:항목순번", 크레딧 "logIndex:항목순번"
  owner: Address,
  roomId: U32,
  tier: z.number().int().nonnegative(),
  priceCredits: z.number().int().positive(),
  rulesVersion: U32,
  spawnWindow: BlockNumber,
  spawnTick: z.number().int().nonnegative(),
  endWindow: BlockNumber,
  endTick: z.number().int().nonnegative(),
  endReason: EndReason,
  hits: z.number().int().nonnegative(),
  distinctBlocks: z.number().int().nonnegative(),
  blocksBroken: z.number().int().nonnegative(),
  durabilityUsed: z.number().nonnegative(),
  durabilityTotal: z.number().positive(),
  pop: z.boolean(),
  bigPop: z.boolean(),                 // BIG POP (새 블록 3연속) 받음
  events: z.array(BonusEventSummary),  // 보너스 사건 POP·BIG_POP (시간 순)
  luckyKind: z.number().int().nonnegative(),   // LUCKY 종류 (스폰 때 `lucky|<키>`로 뽑힘)
  baseMilli: z.number().int().nonnegative(),   // 블록 값 × β_t × 피해
  luckyMilli: z.number().int().nonnegative(),  // LUCKY 종류에 준 피해 몫
  bonusMilli: z.number().int().nonnegative(),  // POP + BIG POP
  lastHits: z.number().int().nonnegative(),    // (규칙 9) 막타 횟수 (한 방에 못 깨는 블록을 깬 수, 상한에 걸려 0을 받은 것 포함)
  lastHitMilli: z.number().int().nonnegative(),  // (규칙 9) 막타 몫 (≤ 가격 × lastHitCapBps). E = base + lucky + bonus + lastHit
  paidMilli: z.number().int().nonnegative(),   // 끝 정산 payoutMilli (REWARD ≤ 가격 × rewardCapBps, 비정상 종료면 min(P, E + u·P))
  overMilli: z.number().int().nonnegative(),   // 같은 settleEnd의 초과분 (REWARD만, 그 밖 0)
  pnlMilli: z.number().int(),                  // paid + over − price (곡괭이 하나의 순손익)
}).strict();
export type PickaxeHistoryRecord = z.infer<typeof PickaxeHistoryRecord>;

/**
 * 예외 E1~E16 (설계 §5.2, 개정 3에서 E11·E12 뜻이 바뀌고 E14·E15가 생김, D107에서 E16). 감지 규칙과 해결은 문서에 있고,
 * 기록은 "언제·어디서·무엇을 보고" 감지했는지만 남긴다.
 *  E11 정산 지연: 끝난 곡괭이의 정산이 N블록 넘게 체인에 없음 · E12 체인 정산 값 ≠ 재생 값(검증기·감시 봇)
 *  E14 정산 tx 실패(revert·가스 부족) · E15 relayer 실패(의향서 제출 revert가 이어짐)
 *  E16 초과분(over) 시간당 한도에 걸려 그 곡괭이의 settleEnd가 다음 창을 기다림(실패 아님 — 창이 넘어가면 settler가 보낸다)
 */
export const ExceptionCode = z.enum(["E1", "E2", "E3", "E4", "E5", "E6", "E7", "E8", "E9", "E10", "E11", "E12", "E13", "E14", "E15", "E16"]);
export type ExceptionCode = z.infer<typeof ExceptionCode>;

export const ExceptionRecord = z.object({
  code: ExceptionCode,
  roomId: U32.optional(),
  detectedAtBlock: BlockNumber,
  detectedBy: z.enum(["CLIENT", "SERVER", "WATCHDOG", "CONTRACT", "ENGINE"]),
  lagBlocks: z.number().int().nonnegative().optional(),   // 처리 지연 (블록)
  resolvedAtBlock: BlockNumber.optional(),
  note: z.string().max(500).optional(),
}).strict();
export type ExceptionRecord = z.infer<typeof ExceptionRecord>;

/** 환불 기록. 서버 재량 없이 규칙으로만 생긴다 (설계 §5.3, 부록 B). 돈은 모두 체인 잔액으로 간다(개정 3). */
export const RefundKind = z.enum([
  "VOID_PURCHASE",     // 처리되지 못한 구매 → refundUnprocessed로 가격 100%를 잔액으로, 또는 정산 시한 뒤 refundUnsettled로 안 된 곡괭이 100% (체인 tx, 누구나)
  "QUEUE_REFUND",      // 동결·방 닫힘 때 대기 중이던 곡괭이 100% (정산 REFUND)
  "CANCEL",            // 대기열 취소 100% (정산 REFUND)
  "OVERFLOW",          // 대기열 상한 초과분 100% (정산 REFUND)
  "ABNORMAL_END",      // 비정상 종료 min(P, E + u·P) (정산 REFUND)
]);
export type RefundKind = z.infer<typeof RefundKind>;
