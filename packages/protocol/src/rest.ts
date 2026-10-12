import { z } from "zod";
import { Address, Bytes32, BlockNumber, DecimalString, HexBytes, U32 } from "./primitives.js";
import { CancelIntentMessage, CreditIntentMessage, SessionGrantMessage, Signature65 } from "./eip712.js";
import { SettleKind, SettlementStatus } from "./purchase.js";
import { BonusEventSummary, EndReason, RefundKind } from "./history.js";
import { PlayerShortId, QueueState } from "./feed.js";

// ──────────────────────────────────────────────────────────────────────────
// REST 응답 형식 (apps/api ↔ apps/web, 일부는 settler 내부 HTTP와 같은 모양). docs/INTERFACES.md §2.
// 봉투({ success, data, meta })는 api가 씌운다. 여기 형식은 `data`의 모양이다.
// ──────────────────────────────────────────────────────────────────────────

// ── 크레딧 구매·취소 relay (개정 3, D79·D81) ───────────────────────────────────

/**
 * `POST /purchases/credit` (api) → settler 내부 `POST /internal/relay/credit`. 세션 키가 서명한 의향서를 서버가 대신 제출한다.
 * grant = 그 세션 키가 체인에 아직 등록되지 않았을 때 지갑의 SessionGrant 서명(처음 한 번). 있으면 relayer가 먼저 registerSessionKey.
 */
export const CreditPurchaseRequest = z.object({
  intent: CreditIntentMessage,
  signature: Signature65,
  grant: z.object({ grant: SessionGrantMessage, signature: HexBytes }).strict().optional(),
}).strict();
export type CreditPurchaseRequest = z.infer<typeof CreditPurchaseRequest>;

/** `POST /purchases/cancel` → `POST /internal/relay/cancel`. */
export const CancelRequest = z.object({
  intent: CancelIntentMessage,
  signature: Signature65,
  grant: z.object({ grant: SessionGrantMessage, signature: HexBytes }).strict().optional(),
}).strict();
export type CancelRequest = z.infer<typeof CancelRequest>;

/**
 * relay 요청 상태: QUEUED(검사 통과, 보낼 차례) → SENT(tx 보냄) → CONFIRMED(영수증 성공) | FAILED(revert·만료).
 * REJECTED는 체인에 보내기 전 검사에서 막힌 것(가스를 쓰지 않음, code에 이유).
 */
export const RelayStatus = z.enum(["QUEUED", "SENT", "CONFIRMED", "FAILED", "REJECTED"]);
export type RelayStatus = z.infer<typeof RelayStatus>;

/**
 * relay 거절 코드 (409 code와 같음).
 * GAS_BUDGET = 이 지갑의 최근 24시간 relay 가스가 하루 예산(RELAY_GAS_DAILY_MON)을 넘음 → 기다린다.
 * CANCEL_LIMIT = 최근 24시간 대기열 취소 relay가 하루 한도(RELAY_CANCELS_PER_DAY)에 닿음 (구매 → 취소 반복으로 하우스 가스를 태우지 못하게).
 * FREE_CREDITS_EXHAUSTED = 오늘(UTC) 하우스가 낸 무료 가스가 전체 하루 상한(FREE_GAS_DAILY_MON)에 닿음 — 홀더(오늘 CHOG NFT ≥ 1)와
 *   전에 3일 이상 플레이한 지갑만 계속 산다 (D103, D109).
 * ON_BREAK = 쉬어가기(/me/protection) — protectionRefusal.
 * BATCH_OPEN = 이 지갑의 앞 묶음(크레딧 구매 하나)이 아직 끝 정산 확정 전 — 다 정산되면 다시 산다 (D113, 크레딧 구매만·취소는 아님).
 */
export const RelayRefusalCode = z.enum([
  "BAD_SIGNATURE", "WALLET_MISMATCH", "SESSION_NOT_REGISTERED", "SESSION_EXPIRED", "SPEND_LIMIT", "NONCE_USED", "DEADLINE",
  "RULES_MISMATCH", "SALES_CLOSED", "INSUFFICIENT_BALANCE", "BAD_TIER", "BAD_ITEMS", "RATE_LIMITED", "DUPLICATE", "REVERTED",
  "GAS_BUDGET", "CANCEL_LIMIT", "FREE_CREDITS_EXHAUSTED", "ON_BREAK", "BATCH_OPEN",
]);
export type RelayRefusalCode = z.infer<typeof RelayRefusalCode>;

export const RelayView = z.object({
  id: z.number().int().positive(),
  kind: z.enum(["CREDIT", "CANCEL"]),
  wallet: Address,
  nonce: DecimalString,
  status: RelayStatus,
  txHash: Bytes32.nullable(),
  purchaseId: DecimalString.nullable(),   // CREDIT이 CONFIRMED이면 체인 purchaseId
  code: RelayRefusalCode.nullable(),
  detail: z.string().nullable(),
}).strict();
export type RelayView = z.infer<typeof RelayView>;

/**
 * relay 코드별 고정 문장 (보안 리뷰 M-1, D109). api가 RelayView.detail과 409 message에 이것만 싣는다 — settler가 남긴
 * 체인·RPC 오류 원문(viem 오류 문장에는 `URL: https://…/<API키>`가 들어간다)은 사용자에게 절대 보내지 않는다.
 */
export const RELAY_CODE_MESSAGES: Record<RelayRefusalCode, string> = {
  BAD_SIGNATURE: "the intent signature does not match the session key",
  WALLET_MISMATCH: "the intent wallet is not the signed-in wallet",
  SESSION_NOT_REGISTERED: "the session key is not registered on chain yet (attach the wallet's session grant)",
  SESSION_EXPIRED: "the session key expired — sign in again",
  SPEND_LIMIT: "the session spend limit is reached or above the server maximum — sign in again for a new session",
  NONCE_USED: "this intent nonce was already used",
  DEADLINE: "the intent deadline passed",
  RULES_MISMATCH: "the rules changed — reload and try again",
  SALES_CLOSED: "sales are paused right now",
  INSUFFICIENT_BALANCE: "not enough credits",
  BAD_TIER: "unknown pickaxe tier",
  BAD_ITEMS: "these items cannot be cancelled",
  RATE_LIMITED: "too many requests — try again shortly",
  DUPLICATE: "this intent was already submitted",
  REVERTED: "the transaction failed on chain",
  GAS_BUDGET: "this wallet's daily relay gas budget is used up — try again later",
  CANCEL_LIMIT: "the daily queue-cancel limit is reached",
  FREE_CREDITS_EXHAUSTED: "today's free gas is used up — regular players and CHOG holders first",
  ON_BREAK: "this wallet is on a break",
  BATCH_OPEN: "the previous batch is still running or not settled yet — buy again after it is settled",
};

/** 사용자에게 보여 줄 relay 문장: 코드가 있으면 고정 문장, 없으면 null (원문 detail은 버린다). */
export function relayCodeMessage(code: RelayRefusalCode | null): string | null {
  return code ? RELAY_CODE_MESSAGES[code] : null;
}

// ── 히스토리 (D15, D26, D63) ────────────────────────────────────────────────

export const HistoryStatus = z.enum(["QUEUED", "ACTIVE", "ENDED", "CANCELLED", "VOID"]);
export type HistoryStatus = z.infer<typeof HistoryStatus>;

export const HistoryRefund = z.object({
  kind: RefundKind,
  amountMilli: z.number().int().nonnegative(),
  onChain: z.boolean(),
  txHash: Bytes32.nullable(),
  claimable: z.boolean(),            // VOID_PURCHASE이고 아직 체인에서 돌려받지 않음 → POST /refunds/:purchaseId/claim (잔액으로)
  purchaseId: DecimalString.optional(),
}).strict();
export type HistoryRefund = z.infer<typeof HistoryRefund>;

/** 곡괭이 1개의 체인 정산 (DB settlement). 끝난 행(ENDED·CANCELLED)만 있다. VOID = 무효·시한 환불된 구매(정산 대신 refundUnprocessed / refundUnsettled). */
export const HistorySettlement = z.object({
  status: SettlementStatus,
  kind: SettleKind,
  payoutMilli: z.number().int().nonnegative(),
  overMilli: z.number().int().nonnegative(),   // 같은 settleEnd의 초과분
  txHash: Bytes32.nullable(),        // SENT·SETTLED
  blockNumber: BlockNumber.nullable(),   // SETTLED (확정 블록)
}).strict();
export type HistorySettlement = z.infer<typeof HistorySettlement>;

/**
 * "이 곡괭이 검증하기" 재료 (더하기, 2026-10-10): 끝난(없으면 스폰된) 윈도가 든 에폭과 그 에폭의 공개 상태.
 * 누구나 `pikit-verify verify --epoch <epoch>`로 그 에폭을 다시 돌려 정산 값을 대조한다. 에폭 행이 아직 없으면 항목이 없다.
 */
export const HistoryVerification = z.object({
  epoch: z.number().int().nonnegative(),
  seedPublished: z.boolean(),            // 에폭 시드가 공개됐나 (API seed_published_at)
  anchorTx: Bytes32.nullable(),          // 그 에폭을 덮은 체인 앵커 tx (아직 없으면 null)
}).strict();
export type HistoryVerification = z.infer<typeof HistoryVerification>;

/**
 * 히스토리 1행 = 곡괭이 1개 (`GET /history`, 방 메시지 `history.append`·`pickaxe.end`).
 * 대기 중·진행 중·취소된 곡괭이는 끝 값이 없어 null이다. 끝난 행(ENDED·VOID)은 PickaxeHistoryRecord의 값을 모두 가진다.
 * 블록 번호와 함께 벽시계 시각(ISO 8601, 서버가 DB에 기록한 created_at 등)을 준다: 블록 번호는 검증용, 시각은 화면용.
 */
export const HistoryItem = z.object({
  itemKey: z.string().min(1),
  owner: Address,
  roomId: U32,
  tier: z.number().int().nonnegative(),
  priceCredits: z.number().int().positive(),
  rulesVersion: U32.nullable(),
  status: HistoryStatus,
  enqueuedWindow: BlockNumber,
  spawnWindow: BlockNumber.nullable(),
  spawnTick: z.number().int().nonnegative().nullable(),
  endWindow: BlockNumber.nullable(),
  endTick: z.number().int().nonnegative().nullable(),
  endReason: EndReason.nullable(),
  hits: z.number().int().nonnegative(),
  distinctBlocks: z.number().int().nonnegative(),
  blocksBroken: z.number().int().nonnegative(),
  durabilityUsed: z.number().nonnegative(),
  durabilityTotal: z.number().positive().nullable(),
  pop: z.boolean(),
  bigPop: z.boolean(),
  events: z.array(BonusEventSummary),
  luckyKind: z.number().int().min(-1),       // LUCKY 종류 (스폰 전 −1)
  baseMilli: z.number().int().nonnegative(),
  luckyMilli: z.number().int().nonnegative(),
  bonusMilli: z.number().int().nonnegative(),
  paidMilli: z.number().int().nonnegative().nullable(),   // 끝 정산 payoutMilli (REWARD/REFUND)
  overMilli: z.number().int().nonnegative(),   // 같은 settleEnd의 초과분 (0 = 없음)
  pnlMilli: z.number().int().nullable(),     // ENDED·VOID: paid + over − price, CANCELLED: 환불 − price, 그 밖 null
  createdAt: z.string().min(1),              // 대기열에 들어간 시각 (ISO 8601)
  spawnedAt: z.string().min(1).nullable(),   // 스폰된 시각
  endedAt: z.string().min(1).nullable(),     // 끝난 시각
  purchaseId: DecimalString.optional(),
  purchaseTx: Bytes32.optional(),
  refund: HistoryRefund.optional(),
  settlement: HistorySettlement.nullable(),   // 체인 끝 정산 settleEnd (끝나기 전·무효 아님이면 null)
  verification: HistoryVerification.optional(),   // 검증 재료 (스폰된 곡괭이, 에폭 행이 있을 때)
}).strict();
export type HistoryItem = z.infer<typeof HistoryItem>;

// ── 플레이어 보호 (/me/protection, 2026-10-10 — 책임 있는 게임 최소선) ───────────
// 1단계 무료 크레딧(D103): 돈이 들지 않으므로 하루 지출 한도는 지웠다. 쉬어가기는 서버가 막는다.
// 연령 확인은 D115에서 지웠다(1단계 무료).

/** 쉬어가기 기간 (24시간 · 7일 · 30일 · 6개월 · 영구). 쉬는 동안 구매와 오늘 받기가 막힌다. 줄이거나 풀 수 없다. */
export const BreakPeriod = z.enum(["24h", "7d", "30d", "180d", "forever"]);
export type BreakPeriod = z.infer<typeof BreakPeriod>;

export const PlayerProtectionView = z.object({
  breakUntil: z.string().min(1).nullable(),                      // 쉬어가기 끝 (ISO), 영구면 null + breakForever
  breakForever: z.boolean(),
}).strict();
export type PlayerProtectionView = z.infer<typeof PlayerProtectionView>;

/** 서버가 구매·오늘 받기 때 보는 보호 상태. */
export interface ProtectionState {
  breakForever: boolean;
  breakUntilMs: number | null;
}

/**
 * 프로모 구매·오늘 받기를 서버에서 막는 판정 (api relay 앞단·오늘 받기, settler relayer). 쉬어가기(기간·영구). 통과면 null.
 */
export function protectionRefusal(p: ProtectionState, nowMs: number): { code: "ON_BREAK"; detail: string } | null {
  if (p.breakForever) return { code: "ON_BREAK", detail: "this wallet took a permanent break; purchases are closed" };
  if (p.breakUntilMs !== null && p.breakUntilMs > nowMs) {
    return { code: "ON_BREAK", detail: `this wallet is on a break until ${new Date(p.breakUntilMs).toISOString()}; purchases are closed` };
  }
  return null;
}

// ── 오늘 받기 · 추첨권 (D103, 1단계 무료 크레딧) ────────────────────────────────

/**
 * 오늘 받기의 수치 (api 설정과 같은 기본값 — 웹이 규칙 화면에 그대로 보여 준다).
 * 목표 = 기본 + (CHOG Genesis NFT ≥ 1이면 정액) + min(⌊CHOG 토큰 ÷ 1,000⌋, 상한) (D117). 7일 연속째 날·7일 넘게 쉬다 돌아온 첫날은 목표 × 2(둘이 겹쳐도 × 2).
 * 받는 양 = 목표 − 체인 프로모 잔액 − 아직 정산되지 않은 내 곡괭이 값(대기·진행·정산 대기). 1,000 미만이면 그날은 0.
 */
export const DAILY_CLAIM_MIN_CREDITS = 1_000;

/** 오늘 받기 결과·미리보기에서 0을 받는(받은) 이유. 받을 수 있으면 null. */
export const DailyCreditsReason = z.enum([
  "ALREADY_CLAIMED",          // 오늘(UTC) 이미 받음 — 다음은 nextClaimAt
  "BALANCE_ENOUGH",           // 목표 − 잔액 − 진행 중 값 < 1,000 (이겨서 이미 충분)
  "FREE_CREDITS_EXHAUSTED",   // 오늘 무료 가스 전체 상한 — 홀더·전에 3일 이상 플레이한 지갑 먼저 (오늘 무료 크레딧이 소진됐어요, D109)
  "NEW_WALLETS_EXHAUSTED",    // 오늘 처음 받는 새 지갑 수 상한 — 홀더는 예외
  "HOLDERS_PENDING",          // 오늘 00:00 UTC 보유표를 만드는 중이거나 CHOG 잔액을 읽지 못함 (D117) — 잠시 뒤 다시
  "NEW_WALLETS_HOURLY",       // 최근 1시간 새 지갑 칸(하루 상한 ÷ 24)이 참 — 한 번의 몰림이 하루를 다 쓰지 못하게 (D109). 잠시 뒤 다시
  "NEW_WALLETS_NETWORK",      // 같은 네트워크(IPv4 /24 · IPv6 /64)나 같은 기기에서 오늘 새 지갑을 이미 상한만큼 받음 (D109, 받기 때만) — 내일
  "SYNCING",                  // 서버가 체인 구매 기록을 아직 따라잡는 중 (follower 커서가 머리에서 멀다, L-4) — 잠시 뒤 다시 (받기 때만)
  "PROMO_BUDGET_EXHAUSTED",   // 체인 프로모 예산(− 아직 체인에 안 오른 지급)이 받을 양보다 적음 — 운영자가 채우는 중, 연속은 끊기지 않는다 (리뷰 M2·L2, D159)
]);
export type DailyCreditsReason = z.infer<typeof DailyCreditsReason>;

/** 오늘 받은 프로모 지급 행의 상태 (promo_grant.status). SKIPPED = 받을 양이 1,000 미만이라 0으로 기록한 날. */
export const DailyGrantStatus = z.enum(["REQUESTED", "SENT", "APPLIED", "REJECTED", "SKIPPED"]);
export type DailyGrantStatus = z.infer<typeof DailyGrantStatus>;

/**
 * `GET /credits/today`(미리보기, 주지 않음) · `POST /credits/claim`(받기) 응답.
 * 받기는 promo_grant(DAILY, 오늘) 행만 만든다 — 체인 프로모 잔액은 settler가 grantPromo로 넣는다(보통 몇 초, grantStatus가 APPLIED가 됨).
 */
export const DailyCreditsView = z.object({
  day: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),   // UTC 날짜
  claimed: z.boolean(),                            // 오늘 행이 있음 (받았거나 0으로 기록됨)
  grantedCredits: z.number().int().nonnegative(), // 오늘 받은 양 (claimed가 아니면 지금 받으면 받을 양)
  targetCredits: z.number().int().nonnegative(),  // 오늘 채워 주는 목표 (× 2 포함)
  baseCredits: z.number().int().nonnegative(),
  nftHolder: z.boolean(),                         // 오늘 00:00 UTC 보유표에 CHOG Genesis NFT ≥ 1 (D117·D136 — 개수와 무관)
  nftHolderCredits: z.number().int().nonnegative(), // 홀더 정액 설정값 (100,000) — 홀더면 baseCredits 대신 (D136). 비홀더에게도 안내용으로 준다
  chogBalance: DecimalString,                     // 그날 쓴 CHOG 토큰 개수 (정수 내림, 소수 없음), 예 "12345"
  chogCredits: z.number().int().nonnegative(),    // 토큰 몫 = min(⌊CHOG ÷ chogUnit⌋ × chogCreditsPerUnit, chogCapCredits) (× 2 전)
  chogUnit: z.number().int().positive(),          // CHOG 몇 개가 한 단위 (100,000)
  chogCreditsPerUnit: z.number().int().nonnegative(), // 한 단위당 크레딧 (10,000)
  chogCapCredits: z.number().int().nonnegative(), // 토큰 몫 상한 (500,000)
  streakDays: z.number().int().nonnegative(),     // 오늘까지 이어진 연속 받기 일수 (오늘 받기 전이면 받았을 때의 값)
  bonus: z.enum(["STREAK", "RETURN"]).nullable(), // × 2의 이유
  promoMilli: DecimalString,                      // 계산에 쓴 체인 프로모 잔액
  unsettledMilli: z.number().int().nonnegative(), // 계산에 쓴 아직 정산되지 않은 내 곡괭이 값
  reason: DailyCreditsReason.nullable(),
  grantStatus: DailyGrantStatus.nullable(),       // 오늘 행의 상태 (없으면 null)
  nextClaimAt: z.string().min(1),                 // 다음 UTC 자정 (ISO)
}).strict();
export type DailyCreditsView = z.infer<typeof DailyCreditsView>;

/** `POST /credits/claim` 본문. api에 Turnstile이 켜져 있으면(TURNSTILE_SECRET, 운영 필수 — D109) turnstileToken(Cloudflare Turnstile)이 필요하다. */
export const DailyClaimRequest = z.object({
  turnstileToken: z.string().min(1).max(2048).optional(),
}).strict();
export type DailyClaimRequest = z.infer<typeof DailyClaimRequest>;

/**
 * `GET /me/tickets` — 상금 기록만(1단계는 지급·추첨 없음, D103).
 * 추첨권 = 이번 주(UTC 월요일 시작) "하루 곡괭이 10개 이상 산 날" 수(최대 7). 플레이한 날 = 이번 달(UTC) 곡괭이를 1개라도 산 날 수.
 * 자격: 오늘 보유표에 CHOG Genesis ≥ 1, 또는 CHOG 토큰 ≥ 50,000개를 오늘까지 7일 연속(매일 보유표).
 */
export const TicketsView = z.object({
  weekStart: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  weekTickets: z.number().int().min(0).max(7),
  ticketMinPickaxes: z.number().int().positive(),  // 하루 이만큼 사야 추첨권 1장 (10)
  monthStart: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  monthPlayDays: z.number().int().nonnegative(),
  todayPickaxes: z.number().int().nonnegative(),
  eligibility: z.object({
    nft: z.boolean(),                              // 오늘 보유표 NFT ≥ 1
    nftCount: z.number().int().nonnegative(),
    token: z.boolean(),                            // 토큰 ≥ 기준을 7일 연속
    tokenDays: z.number().int().min(0).max(7),     // 오늘까지 이어진 기준 이상 날 수 (최대 7)
    tokenMin: z.string().regex(/^\d+$/),           // 기준 (토큰 개수, 소수 없음)
    eligible: z.boolean(),                         // nft || token
  }).strict(),
}).strict();
export type TicketsView = z.infer<typeof TicketsView>;

// ── 오늘 숫자 (LIVE 머리, D123 — docs/specs/09-live-log.md §3.4) ─────────────────

/**
 * `GET /stats/today` — 오늘(UTC 0시부터, 오늘 받기와 같은 경계) 방 피드 사건 수. 로그인 없이, api가 10초 캐시한다.
 * bigPops = BIG POP 사건 수, over1x = 가격을 넘게 받은 곡괭이 수(BIG_PAYOUT), pickaxes = 판에 들어간 곡괭이(QUEUE_SPAWN — 취소된 대기는 안 셈),
 * players = 들어간 곡괭이의 서로 다른 짧은 id 수. 봇은 피드 사건이 없어 저절로 빠진다.
 */
export const TodayStatsView = z.object({
  day: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  bigPops: z.number().int().nonnegative(),
  over1x: z.number().int().nonnegative(),
  pickaxes: z.number().int().nonnegative(),
  players: z.number().int().nonnegative(),
  asOf: z.string().min(1),                         // 센 시각 (ISO)
}).strict();
export type TodayStatsView = z.infer<typeof TodayStatsView>;

// ── 묶음 구매 잠금 (docs/specs/08-purchase-queue.md, D113) ─────────────────────

/** 묶음 안 곡괭이 한 개의 단계 (서버). */
export const BatchItemPhase = z.enum(["SENDING", "CONFIRMING", "WAITING", "ACTIVE", "ENDED", "SETTLED", "VOID"]);
export type BatchItemPhase = z.infer<typeof BatchItemPhase>;

/** 끝 정산 행의 원인 (settlement.cause). */
export const BatchEndCause = z.enum(["END", "ABNORMAL_END", "CANCEL", "OVERFLOW", "QUEUE_REFUND"]);
export type BatchEndCause = z.infer<typeof BatchEndCause>;

export const BatchItemView = z.object({
  index: z.number().int().min(0).max(9),                    // 의향서 tiers 안 위치 = 소환 순서
  itemKey: z.string().min(1).nullable(),                     // "<purchaseId>:<index>", purchaseId를 모르면 null
  tier: z.number().int().min(0).max(31),
  priceMilli: z.number().int().positive(),
  phase: BatchItemPhase,
  endCause: BatchEndCause.nullable(),                        // 끝 정산 행의 cause
  payoutMilli: z.number().int().nonnegative().nullable(),    // 끝 정산 값 (ENDED·SETTLED), 그 밖 null
  overMilli: z.number().int().nonnegative(),                 // 끝 정산의 초과분 (0 = 없음)
  endedAt: z.string().min(1).nullable(),                     // 끝난 시각 ISO (pickaxe.ended_at, 대기 환불은 queue_item.updated_at)
}).strict();
export type BatchItemView = z.infer<typeof BatchItemView>;

/** 지갑의 열린 묶음 (의향서 하나 = 체인 구매 하나). /me.batch가 null이 아니면 그 지갑은 잠겨 있다. */
export const BatchView = z.object({
  id: z.string().regex(/^[rp](0|[1-9][0-9]*)$/),             // "r<relayId>" (relay로 산 묶음) | "p<purchaseId>" (relay 없음: 개발 모드·체인 직접)
  relayId: z.number().int().positive().nullable(),
  nonce: DecimalString.nullable(),                           // 의향서 nonce (웹이 보낸 것과 맞춰 본다)
  purchaseId: DecimalString.nullable(),
  roomId: U32,
  items: z.array(BatchItemView).min(1).max(10),
  createdAt: z.string().min(1),                              // 서버가 의향서·구매를 처음 기록한 시각 ISO
}).strict().refine((b) => b.items.every((it, i) => it.index === i), { message: "items are in index order 0..n−1" });
export type BatchView = z.infer<typeof BatchView>;

// ── /me (D63) ───────────────────────────────────────────────────────────────

/** DB에서 만든 살아 있는 곡괭이 요약 (위치·버프는 방 상태에만 있다). */
export const ActivePickaxeSummary = z.object({
  itemKey: z.string().min(1),
  roomId: U32,
  tier: z.number().int().nonnegative(),
  priceMilli: z.number().int().positive(),
  spawnWindow: BlockNumber,
  earnedMilli: z.number().int().nonnegative(),
  bonusMilli: z.number().int().nonnegative(),
  durabilityLeftBps: z.number().int().min(0).max(10000),
}).strict();
export type ActivePickaxeSummary = z.infer<typeof ActivePickaxeSummary>;

/**
 * `GET /me`. 잔액은 체인 프로모 잔액(PikitShop.balanceOf, 몇 초 캐시 — 개정 5·D105)이 진실이다 — 1단계(D103)에는 MON 구매·출금이 없다.
 * pending은 서버가 보는 아직 체인에 없는 값(표시용):
 *  settlingMilli = 끝났지만 정산 tx가 아직 확정되지 않은 곡괭이의 정산 값 합, activeEarnedMilli = 살아 있는 곡괭이가 지금까지 번 값.
 */
export const MeView = z.object({
  address: Address,
  playerShortId: PlayerShortId,
  nickname: z.string().nullable(),
  balances: z.object({
    promoMilli: DecimalString,            // 체인 프로모 잔액 (무료 크레딧, 출금·전송 불가)
    blockNumber: BlockNumber,             // 읽은 블록
  }).strict(),
  pending: z.object({
    settlingMilli: z.number().int().nonnegative(),
    activeEarnedMilli: z.number().int().nonnegative(),
  }).strict(),
  activePickaxes: z.array(ActivePickaxeSummary),
  queues: z.array(QueueState),
  sessionKey: z.object({
    id: z.string().min(1),
    address: Address,                      // 세션 키 주소 (secp256k1, D52)
    expiresAt: z.number().int().positive(),   // unix 초
    registered: z.boolean(),               // 체인 sessionOf(나, 세션 키).wallet == 나 (아니면 첫 크레딧 구매 때 SessionGrant 서명이 필요)
    spendLimitCredits: z.number().int().nonnegative(),
    spentCredits: z.number().int().nonnegative(),
  }).strict().nullable(),
  /** 다음 의향서 nonce 제안 (지갑별 비트맵이라 아무 안 쓴 값이면 된다) = 그 지갑 relay 요청 nonce 최댓값 + 1, 없으면 "0" */
  nextIntentNonce: DecimalString,
  /** 플레이어 보호 (더하기, 2026-10-10). 웹 구매 경로가 쉬어가기를 여기서 본다 */
  protection: PlayerProtectionView.optional(),
  /** 열린 묶음 (D113). null이 아니면 그 지갑은 잠겨 있다 — 크레딧 구매는 409 BATCH_OPEN. 모든 칸의 끝 정산이 체인에 확정되면 null */
  batch: BatchView.nullable(),
}).strict();
export type MeView = z.infer<typeof MeView>;
