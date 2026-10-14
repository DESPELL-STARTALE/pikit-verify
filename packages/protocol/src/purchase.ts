import { z } from "zod";

// ──────────────────────────────────────────────────────────────────────────
// 정산 이름 (DB `settlement`, 히스토리·방 메시지). 개정 6의 체인 이벤트 모양(Purchased·Settled·Refunded …)은 D4에서 지웠다 —
// 개정 7(명세 20)에서 지급은 장부(ledger.ts·ledger-files.ts)가 정하고 체인에는 시간당 루트만 오른다.
// ──────────────────────────────────────────────────────────────────────────

/**
 * 정산 종류 (규칙 7 D137, 장부 지급 잎의 kind REWARD 0 · REFUND 1):
 *  REWARD = 정상 종료. payoutMilli ≤ 등급 REWARD 상한(가격 × rewardCapBps), 넘는 몫은 같은 지급의 overMilli
 *  REFUND = 비정상 종료·취소·넘침·대기열 환불(가격 이하), overMilli = 0
 * 곡괭이 하나 = 지급 하나.
 */
export const SettleKind = z.enum(["REWARD", "REFUND"]);
export type SettleKind = z.infer<typeof SettleKind>;

/** 정산 상태 (DB `settlement.status`). 장부 세계의 game-server는 바로 SETTLED로 쓴다(명세 20 §2.12). */
export const SettlementStatus = z.enum(["PENDING", "SENT", "SETTLED", "VOID"]);
export type SettlementStatus = z.infer<typeof SettlementStatus>;
