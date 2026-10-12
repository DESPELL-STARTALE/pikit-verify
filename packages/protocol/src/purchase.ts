import { z } from "zod";
import { Address, Bytes32, BlockNumber, DecimalString, U32 } from "./primitives.js";

// ──────────────────────────────────────────────────────────────────────────
// 체인 이벤트 (finalized 블록에서 읽은 모양, 컨트랙트가 진실 — DECISIONS D53) 와 정산 형식 (개정 3, D77~).
// 구매는 두 길(MON tx · relayer가 낸 크레딧 의향서) 모두 같은 `Purchased` 이벤트로 들어온다.
// ──────────────────────────────────────────────────────────────────────────

const ChainLog = {
  chainId: z.number().int().positive(),
  blockNumber: BlockNumber,
  blockHash: Bytes32,
  txHash: Bytes32,
  logIndex: z.number().int().nonnegative(),
};

/**
 * `Purchased(uint256 indexed purchaseId, address indexed buyer, uint256 indexed roomId, bytes32 rulesHash, uint64 seq,
 *  uint8[] tiers, uint256 priceCredits)` — 개정 5(D105): 구매는 relay 크레딧 길 하나, 가격 × 1000 밀리가 지갑 크레딧 잔액에서 빠졌다.
 */
export const PurchasedEvent = z.object({
  ...ChainLog,
  shop: Address,
  purchaseId: DecimalString,
  buyer: Address,
  roomId: U32,
  rulesHash: Bytes32,              // onchainRulesHash(catalogHash, engineVersionHash) (D41)
  seq: DecimalString,
  tiers: z.array(z.number().int().min(0).max(31)).min(1).max(10),
  priceCredits: DecimalString,
}).strict();
export type PurchasedEvent = z.infer<typeof PurchasedEvent>;

/** `IntentUsed(address indexed wallet, address indexed sessionKey, uint256 nonce)` — relayer가 낸 의향서 (같은 tx의 Purchased·CancelRequested 바로 앞). */
export const IntentUsedEvent = z.object({
  ...ChainLog,
  wallet: Address,
  sessionKey: Address,
  nonce: DecimalString,
}).strict();
export type IntentUsedEvent = z.infer<typeof IntentUsedEvent>;

/** `CancelRequested(address indexed wallet, uint256 indexed roomId, uint256[] items)` — items = (purchaseId << 8) | itemIndex. */
export const CancelRequestedEvent = z.object({
  ...ChainLog,
  wallet: Address,
  roomId: U32,
  items: z.array(DecimalString).min(1).max(10),
}).strict();
export type CancelRequestedEvent = z.infer<typeof CancelRequestedEvent>;

/**
 * 정산 종류 (컨트랙트 SettleKind 0/1, 규칙 7 D137 — Jackpot 삭제):
 *  REWARD = 정상 종료. payoutMilli ≤ 등급 REWARD 상한 tierCapsMilli(가격 × rewardCapBps), 넘는 몫은 같은 호출의 overMilli
 *           (≤ 등급 over 상한 tierOverCapsMilli, 시간당 overLimitMilli에 셈)
 *  REFUND = 비정상 종료·취소·넘침·대기열 환불(가격 이하), overMilli = 0
 * 곡괭이 하나 = `settleEnd(purchaseId, itemIndex, kind, payoutMilli, overMilli)` 정확히 한 번 (감사 F-1).
 */
export const SettleKind = z.enum(["REWARD", "REFUND"]);
export type SettleKind = z.infer<typeof SettleKind>;
export const SETTLE_KIND_ONCHAIN: Record<SettleKind, 0 | 1> = { REWARD: 0, REFUND: 1 };

/**
 * `Settled(uint256 indexed purchaseId, uint8 itemIndex, address indexed buyer, uint8 kind, uint256 payoutMilli, uint256 overMilli)`
 * — `settleEnd` 한 번. 지갑 크레딧 잔액에 payoutMilli + overMilli가 한 번에 들어간다.
 */
export const SettledEvent = z.object({
  ...ChainLog,
  purchaseId: DecimalString,
  itemIndex: z.number().int().min(0).max(9),
  buyer: Address,
  kind: SettleKind,
  payoutMilli: DecimalString,
  overMilli: DecimalString,
}).strict().refine((e) => e.overMilli === "0" || e.kind === "REWARD", { message: "overMilli > 0 only on REWARD" });
export type SettledEvent = z.infer<typeof SettledEvent>;

/** `Refunded(uint256 indexed purchaseId, address indexed buyer, uint256 amountMilli)` — 무효 구매 100%를 잔액으로. `UnsettledRefunded`도 같은 모양으로 읽는다. */
export const RefundedEvent = z.object({
  ...ChainLog,
  purchaseId: DecimalString,
  buyer: Address,
  amountMilli: DecimalString,
}).strict();
export type RefundedEvent = z.infer<typeof RefundedEvent>;

/** 구매 상태 (DB `onchain_purchase.status`, 체인 PurchaseStatus Pending/Processed/Void/Refunded와 같은 뜻). */
export const PurchaseStatus = z.enum(["PENDING", "PROCESSED", "VOID", "REFUNDED"]);
export type PurchaseStatus = z.infer<typeof PurchaseStatus>;

/**
 * 곡괭이 1개의 정산 (엔진이 정한 값 → settler가 settleEnd/settleEndMany로 체인에). DB `settlement` 1행 = 곡괭이 1개 (규칙 7).
 * payoutMilli·overMilli는 엔진 값 그대로(정수 밀리크레딧, 반올림 없음). 체인은 REWARD ≤ 등급 REWARD 상한, over ≤ 등급 over 상한,
 * REFUND ≤ 가격(over 0)만 강제하고 정확한 값은 검증기가 재생으로 확인한다(verifier checkSettlements, over 0 포함).
 */
export const Payout = z.object({
  itemKey: z.string().min(1),       // "<purchaseId>:<itemIndex>"
  purchaseId: DecimalString,
  itemIndex: z.number().int().min(0).max(9),
  owner: Address,
  roomId: U32,
  tier: z.number().int().nonnegative(),
  priceMilli: z.number().int().positive(),
  kind: SettleKind,
  cause: z.enum(["END", "ABNORMAL_END", "CANCEL", "OVERFLOW", "QUEUE_REFUND"]),
  payoutMilli: z.number().int().nonnegative(),
  overMilli: z.number().int().nonnegative(),   // 가격 × rewardCapBps를 넘은 몫 (REWARD만, 그 밖 0) — 같은 settleEnd 호출
  window: BlockNumber,              // 엔진이 값을 정한 윈도
}).strict()
  .refine((p) => p.overMilli === 0 || p.kind === "REWARD", { message: "overMilli > 0 only on REWARD" })
  .refine((p) => (p.kind === "REWARD") === (p.cause === "END"), { message: "kind REWARD ⇔ cause END" });
export type Payout = z.infer<typeof Payout>;

/** 정산 상태 (DB `settlement.status`): 대기 → tx 보냄 → 체인 확정, 또는 무효 구매(정산 안 함). */
export const SettlementStatus = z.enum(["PENDING", "SENT", "SETTLED", "VOID"]);
export type SettlementStatus = z.infer<typeof SettlementStatus>;
