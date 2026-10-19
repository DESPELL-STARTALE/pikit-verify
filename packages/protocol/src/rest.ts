import { z } from "zod";
import { Address, Bytes32, BlockNumber, DecimalString, HexBytes, U32 } from "./primitives.js";
import { SettleKind, SettlementStatus } from "./purchase.js";
import { BonusEventSummary, EndReason, RefundKind } from "./history.js";
import { PlayerShortId, QueueState } from "./feed.js";
import { BuyIntentMessage, CancelQueueMessage, LedgerSessionMessage, LedgerSignature } from "./ledger.js";
import { LedgerRejectReason, LedgerRootFields } from "./ledger-files.js";

// ──────────────────────────────────────────────────────────────────────────
// REST 응답 형식 (apps/api ↔ apps/web, 일부는 settler 내부 HTTP와 같은 모양). docs/INTERFACES.md §2.
// 봉투({ success, data, meta })는 api가 씌운다. 여기 형식은 `data`의 모양이다.
// ──────────────────────────────────────────────────────────────────────────

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
  lastHits: z.number().int().nonnegative(),       // (규칙 9) 막타 횟수 (스폰 전 0)
  lastHitMilli: z.number().int().nonnegative(),   // (규칙 9) 막타 몫
  pickLevelBps: z.number().int().nonnegative(),   // (규칙 10) LUCKY PICK 단계 (multBps, 스폰 전·없음 0)
  pickMilli: z.number().int().nonnegative(),      // (규칙 10) 사다리 보충 (끝나기 전 0)
  jackpotMilli: z.number().int().nonnegative(),   // (규칙 10) 골든 CHOG 잭팟 (0 = 없음)
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

/** 오늘 받기 결과·미리보기에서 0을 받는(받은) 이유. 받을 수 있으면 null. */
export const DailyCreditsReason = z.enum([
  "ALREADY_CLAIMED",          // 오늘(UTC) 이미 받음 — 다음은 nextClaimAt
  "FREE_CREDITS_EXHAUSTED",   // 오늘 무료 가스 전체 상한 — 홀더·전에 3일 이상 플레이한 지갑 먼저 (오늘 무료 크레딧이 소진됐어요, D109)
  "NEW_WALLETS_EXHAUSTED",    // 오늘 처음 받는 새 지갑 수 상한 — 홀더는 예외
  "HOLDERS_PENDING",          // 오늘 00:00 UTC 보유표를 settler가 아직 만드는 중 (D117) — 잠시 뒤 다시
  "HOLDERS_UNAVAILABLE",      // 스냅샷 블록의 CHOG 잔액을 어느 RPC에서도 읽지 못함 (D210) — 지금 블록으로 대신 읽지 않는다. 서버 탓(연속 유지), 잠시 뒤 다시
  "NEW_WALLETS_HOURLY",       // 최근 1시간 새 지갑 칸(하루 상한 ÷ 24)이 참 — 한 번의 몰림이 하루를 다 쓰지 못하게 (D109). 잠시 뒤 다시
  "NEW_WALLETS_NETWORK",      // 같은 네트워크(IPv4 /24 · IPv6 /64)나 같은 기기에서 오늘 새 지갑을 이미 상한만큼 받음 (D109, 받기 때만) — 내일
  "SYNCING",                  // 서버가 체인 구매 기록을 아직 따라잡는 중 (follower 커서가 머리에서 멀다, L-4) — 잠시 뒤 다시 (받기 때만)
  "PROMO_BUDGET_EXHAUSTED",   // 체인 프로모 예산(− 아직 체인에 안 오른 지급)이 받을 양보다 적음 — 운영자가 채우는 중, 연속은 끊기지 않는다 (리뷰 M2·L2, D159)
]);
export type DailyCreditsReason = z.infer<typeof DailyCreditsReason>;

/** 오늘 받은 지급 행의 상태 (promo_grant.status, 명세 20): PENDING(명단 대기) → LISTED(명단에 듦) → APPLIED | REJECTED. SKIPPED = 받을 양이 0으로 기록한 날 (옛 채움 방식의 행, 또는 기본·토큰 몫 설정이 모두 0). */
export const DailyGrantStatus = z.enum(["PENDING", "LISTED", "APPLIED", "REJECTED", "SKIPPED"]);
export type DailyGrantStatus = z.infer<typeof DailyGrantStatus>;

/**
 * 오늘 받기 보너스의 근거 (D210): 그날 00:00 UTC 스냅샷 블록(타임스탬프 ≥ 00:00 UTC인 Monad 메인넷 첫 블록 — settler가 찾는다)의 보유량.
 * 한 블록에서 한 자산은 한 지갑에만 있으므로, 00:00 뒤 NFT·토큰을 다른 지갑으로 옮겨도 그날 두 번 세지 않는다. 그 뒤 산 것은 다음 날 스냅샷부터.
 * 웹 위 막대 배지는 이 값이 아니라 실시간 보유량이다(비교해 "지금 더/덜 가짐 — 내일부터" 줄을 그린다).
 */
export const DailySnapshot = z.object({
  block: z.number().int().nonnegative().nullable(), // 스냅샷 블록 번호 (CHOG 체인 143). 아직 없으면(00:00 직후 settler가 재는 중) null
  at: z.string().min(1),                           // 기준 시각 = 그날 00:00 UTC (ISO)
  nftCount: z.number().int().nonnegative(),         // CHOG Genesis NFT 수
  chogBalance: DecimalString,                       // CHOG 토큰 개수 (정수 내림, 소수 없음), 예 "12345"
}).strict();
export type DailySnapshot = z.infer<typeof DailySnapshot>;

/**
 * `GET /credits/today`(미리보기, 주지 않음) · `POST /credits/claim`(받기) 응답.
 * 받기는 promo_grant(DAILY, 오늘) 행만 만든다 — 체인 프로모 잔액은 settler가 grantPromo로 넣는다(보통 몇 초, grantStatus가 APPLIED가 됨).
 */
export const DailyCreditsView = z.object({
  day: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),   // UTC 날짜
  claimed: z.boolean(),                            // 오늘 행이 있음 (받았거나 0으로 기록됨)
  grantedCredits: z.number().int().nonnegative(), // 오늘 받은 양 (claimed가 아니면 지금 받으면 받을 양) = targetCredits — 잔액에 더한다 (D234). 막혔으면 0
  targetCredits: z.number().int().nonnegative(),  // 오늘 받는 양 = (기본|홀더 정액 + 토큰 몫) × (2배 날 2) (D234: 잔액을 빼지 않는다)
  baseCredits: z.number().int().nonnegative(),
  nftHolder: z.boolean(),                         // 스냅샷에 CHOG Genesis NFT ≥ 1 (D117·D136 — 개수와 무관) = snapshot.nftCount > 0
  nftHolderCredits: z.number().int().nonnegative(), // 홀더 정액 설정값 (1,000,000, D171) — 홀더면 baseCredits 대신 (D136). 비홀더에게도 안내용으로 준다
  snapshot: DailySnapshot,                        // 보너스의 근거 = 그날 00:00 UTC 스냅샷 보유량 (D210). 받은 뒤에는 받을 때 고정한 값
  chogCredits: z.number().int().nonnegative(),    // 토큰 몫 = min(⌊CHOG ÷ chogUnit⌋ × chogCreditsPerUnit, chogCapCredits) (× 2 전)
  chogUnit: z.number().int().positive(),          // CHOG 몇 개가 한 단위 (100,000)
  chogCreditsPerUnit: z.number().int().nonnegative(), // 한 단위당 크레딧 (100,000, D171)
  chogCapCredits: z.number().int().nonnegative(), // 토큰 몫 상한 (5,000,000, D171)
  streakDays: z.number().int().nonnegative(),     // 오늘까지 이어진 연속 받기 일수 (오늘 받기 전이면 받았을 때의 값)
  bonus: z.enum(["STREAK", "RETURN"]).nullable(), // × 2의 이유
  reason: DailyCreditsReason.nullable(),
  grantStatus: DailyGrantStatus.nullable(),       // 오늘 행의 상태 (없으면 null)
  nextClaimAt: z.string().min(1),                 // 다음 UTC 자정 (ISO)
}).strict();
export type DailyCreditsView = z.infer<typeof DailyCreditsView>;

/**
 * `GET /credits/policy` — 오늘 받기 정책 값 (로그인 없이, D171). api 설정(DAILY_*)을 그대로 준다 — 로그인 전 화면(안내 창·`/rules`·받기 창 규칙 표)이
 * 숫자를 웹 빌드에 묻지 않고 이 값으로 그린다. 로그인하면 DailyCreditsView의 같은 필드가 우선이다.
 */
export const CreditsPolicyView = z.object({
  baseCredits: z.number().int().nonnegative(),        // DAILY_BASE_CREDITS
  nftHolderCredits: z.number().int().nonnegative(),   // DAILY_NFT_HOLDER_CREDITS (기본 대신, 정액)
  chogUnit: z.number().int().positive(),              // DAILY_CHOG_UNIT
  chogCreditsPerUnit: z.number().int().nonnegative(), // DAILY_CHOG_CREDITS_PER_UNIT
  chogCapCredits: z.number().int().nonnegative(),     // DAILY_CHOG_CAP_CREDITS
}).strict();
export type CreditsPolicyView = z.infer<typeof CreditsPolicyView>;

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

// ── 리더보드 (D172 — docs/specs/19-leaderboard.md) ─────────────────────────────

/** 리더보드 기간: 오늘(UTC 0시부터) · 7일(오늘 포함 UTC 7일) · 전체. */
export const LeaderboardPeriod = z.enum(["today", "7d", "all"]);
export type LeaderboardPeriod = z.infer<typeof LeaderboardPeriod>;

/**
 * 한 지갑의 줄. 캐서 번 크레딧 = 그 기간 끝 정산 REWARD(정상 종료) 행의 payout + over 합(VOID 제외).
 * 봇은 정산 행이 없어 저절로 빠진다. 금액은 밀리크레딧 정수.
 */
export const LeaderboardRow = z.object({
  rank: z.number().int().positive(),               // 같은 금액이면 같은 순위 (1, 2, 2, 4)
  address: z.string().regex(/^0x[0-9a-f]{40}$/),   // 소문자 전체 주소 (탐색기 링크용, 화면은 줄여 보인다)
  earnedMilli: z.number().int().nonnegative(),
  pickaxes: z.number().int().positive(),
  bestMilli: z.number().int().nonnegative(),       // 곡괭이 하나의 가장 큰 payout + over
}).strict();
export type LeaderboardRow = z.infer<typeof LeaderboardRow>;

export const LeaderboardView = z.object({
  period: LeaderboardPeriod,
  since: z.string().nullable(),                    // 기간 시작 (ISO, 전체면 null)
  rows: z.array(LeaderboardRow).max(50),           // 위 50
  me: LeaderboardRow.nullable(),                   // 로그인했으면 내 줄(위 50 안이면 rows의 그 줄과 같음), 로그인 안 했거나 그 기간 기록이 없으면 null
  asOf: z.string().min(1),
}).strict();
export type LeaderboardView = z.infer<typeof LeaderboardView>;

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
  id: z.string().regex(/^p(0|[1-9][0-9]*)$/),               // "p<purchaseId>" (장부 구매)
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
  earnedMilli: z.number().int().nonnegative(),   // 지금까지 번 것 E = 기본 + LUCKY + 보너스 + 막타 (네 몫 합, 규칙 9)
  bonusMilli: z.number().int().nonnegative(),
  durabilityLeftBps: z.number().int().min(0).max(10000),
  pickLevelBps: z.number().int().nonnegative(),   // (규칙 10) LUCKY PICK 단계 (multBps, 0 = 없음)
  jackpotMilli: z.number().int().nonnegative(),   // (규칙 10) 받은 잭팟 (밀리, 0 = 없음)
}).strict();
export type ActivePickaxeSummary = z.infer<typeof ActivePickaxeSummary>;

// ── 잭팟 (규칙 10, 명세 23 §4) ──────────────────────────────────────────────

/**
 * 골든 CHOG 잭팟 통 (`/metrics`·`/stats`·/rules 페이지). 엔진 RoomState.jackpot 값 그대로 + 카탈로그 minPool.
 * 불변식: contributedMilli = poolMilli + paidMilli. contributionBpsByTier는 /rules 표용(카탈로그 값 그대로, 선택).
 */
export const JackpotView = z.object({
  poolMilli: z.number().int().nonnegative(),
  minPoolMilli: z.number().int().nonnegative(),
  contributedMilli: z.number().int().nonnegative(),
  paidMilli: z.number().int().nonnegative(),
  wins: z.number().int().nonnegative(),
  contributionBpsByTier: z.array(z.number().int().min(0).max(1000)).optional(),
}).strict();
export type JackpotView = z.infer<typeof JackpotView>;

/**
 * `/me.ledger` (명세 20, D196). 금액은 밀리크레딧 10진 문자열.
 *  balanceMilli·openStakeMilli·lastSeq = 장부 상태(마지막 처리 윈도 updatedWindow 기준)
 *  pendingSeqMax = 아직 처리되지 않은(PENDING·LISTED) 내 의향서 seq 최댓값, 없으면 null — 웹 다음 seq = max(lastSeq, pendingSeqMax) + 1
 *  reservedMilli = 아직 처리되지 않은 내 BUY 가격 합(api 잔액 예약)
 */
export const MeLedgerView = z.object({
  balanceMilli: DecimalString,
  openStakeMilli: DecimalString,
  reservedMilli: DecimalString,
  lastSeq: DecimalString,
  pendingSeqMax: DecimalString.nullable(),
  lastGrantDay: U32,
  updatedWindow: BlockNumber.nullable(),
}).strict();
export type MeLedgerView = z.infer<typeof MeLedgerView>;

export const MeLedgerSessionView = z.object({
  sessionKey: Address,
  expiresAt: DecimalString,                 // unix 초
  smartWallet: z.boolean(),                 // ERC-1271로 확인한 허가
}).strict();
export type MeLedgerSessionView = z.infer<typeof MeLedgerSessionView>;

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
  /** 장부 잔액 (명세 20, 더하기 — D196). 새 세계에서는 balances.promoMilli 대신 이것이 진실이다 */
  ledger: MeLedgerView.optional(),
  /** 장부 세션 허가 (LedgerSession, 명세 20). 없거나 기한이 지났으면 null — 첫 의향서 때 IntentRequest.session을 붙인다 */
  ledgerSession: MeLedgerSessionView.nullable().optional(),
}).strict();
export type MeView = z.infer<typeof MeView>;

// ── 장부 의향서 (명세 20, D196) ─────────────────────────────────────────────

/**
 * 세션 허가 첨부 (그 세션 키의 허가가 서버에 아직 없을 때 첫 의향서에 붙인다).
 * signature = 지갑 서명(EOA 65바이트, 스마트 지갑은 ERC-1271/6492 임의 길이).
 */
export const LedgerSessionGrant = z.object({
  session: LedgerSessionMessage,
  signature: HexBytes,
}).strict();
export type LedgerSessionGrant = z.infer<typeof LedgerSessionGrant>;

/** `POST /api/v1/intents` 본문. signature = 세션 키의 EIP-712 서명(도메인 PIKIT-LEDGER). */
export const IntentRequest = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("BUY"), intent: BuyIntentMessage, signature: LedgerSignature, session: LedgerSessionGrant.optional() }).strict(),
  z.object({ kind: z.literal("CANCEL"), intent: CancelQueueMessage, signature: LedgerSignature, session: LedgerSessionGrant.optional() }).strict(),
]);
export type IntentRequest = z.infer<typeof IntentRequest>;

/**
 * 의향서 상태 (ledger_intent.status):
 *  PENDING = api가 받음, 명단 대기 · LISTED = targetWindow 명단에 들어감(서명됨) · LATE = 그 창 명단이 이 의향서 없이 닫힘(같은 seq로 새 창에 다시 서명)
 *  APPLIED = 장부가 받음(BUY면 purchaseId) · REJECTED = 장부가 거절(reason)
 */
export const IntentStatus = z.enum(["PENDING", "LISTED", "LATE", "APPLIED", "REJECTED"]);
export type IntentStatus = z.infer<typeof IntentStatus>;

/**
 * api 단계 거절 (409 code). 의향서 행을 만들지 않는다.
 *  SEQ_USED = seq ≤ 장부 lastSeq · SEQ_IN_USE = 같은 지갑의 PENDING·LISTED 의향서가 이 seq를 이미 씀(다른 탭)
 *  TOO_LATE = targetWindow ≤ closedThrough · TOO_EARLY = targetWindow > closedThrough + TARGET_MAX_AHEAD
 *  SESSION_REQUIRED = 이 세션 키의 허가가 없음(session을 붙여 다시) · BATCH_OPEN = 열린 묶음(D113, 크레딧 구매만)
 *  MAINTENANCE = 루트 신선도 문(마지막 POSTED 루트가 너무 오래됨, 503) · SMART_WALLET_UNSUPPORTED = 1271 허가를 아직 받지 않음
 */
export const IntentRefusalCode = z.enum([
  "INSUFFICIENT_CREDITS", "SEQ_USED", "SEQ_IN_USE", "TOO_LATE", "TOO_EARLY", "SESSION_REQUIRED", "SESSION_EXPIRED", "BAD_SIGNATURE",
  "WALLET_MISMATCH", "RULES_MISMATCH", "BAD_TIERS", "BATCH_OPEN", "MAINTENANCE", "SMART_WALLET_UNSUPPORTED",
  "ROOM_WINDOW_FULL", "UNKNOWN_ROOM",
]);
export type IntentRefusalCode = z.infer<typeof IntentRefusalCode>;

/** 코드별 고정 문장 (relay와 같은 원칙 — 내부 오류 원문을 사용자에게 보내지 않는다). */
export const INTENT_CODE_MESSAGES: Record<IntentRefusalCode, string> = {
  INSUFFICIENT_CREDITS: "not enough credits",
  SEQ_USED: "this intent sequence number was already used — reload and try again",
  SEQ_IN_USE: "another pending intent uses this sequence number — try again",
  TOO_LATE: "the target window already closed — sign again for a later window",
  TOO_EARLY: "the target window is too far ahead",
  SESSION_REQUIRED: "sign the session permission with your wallet first",
  SESSION_EXPIRED: "the session key expired — sign in again",
  BAD_SIGNATURE: "the intent signature does not match the session key",
  WALLET_MISMATCH: "the intent wallet is not the signed-in wallet",
  RULES_MISMATCH: "the rules changed — reload and try again",
  BAD_TIERS: "unknown pickaxe tier or bad item list",
  BATCH_OPEN: "the previous batch is still running — buy again after it ends",
  MAINTENANCE: "purchases are paused for maintenance",
  SMART_WALLET_UNSUPPORTED: "smart-contract wallets are not supported yet",
  ROOM_WINDOW_FULL: "this room-window already holds 100 inputs — re-sign for a later window",
  UNKNOWN_ROOM: "this room does not exist in this world",
};

export function intentCodeMessage(code: IntentRefusalCode | null): string | null {
  return code ? INTENT_CODE_MESSAGES[code] : null;
}

/** `GET /api/v1/intents/:digest` · `POST /api/v1/intents` 응답. */
export const IntentView = z.object({
  digest: Bytes32,
  kind: z.enum(["BUY", "CANCEL"]),
  wallet: Address,
  seq: DecimalString,
  targetWindow: BlockNumber,
  status: IntentStatus,
  reason: LedgerRejectReason.nullable(),        // REJECTED
  purchaseId: DecimalString.nullable(),         // APPLIED BUY
  listWindow: BlockNumber.nullable(),           // LISTED·APPLIED·REJECTED
  listIndex: z.number().int().nonnegative().nullable(),
  createdAt: z.string().min(1),
}).strict();
export type IntentView = z.infer<typeof IntentView>;

/** 루트 행 상태 (ledger_root.status): READY = game-server가 만듦, SENT = settler가 tx 보냄, POSTED = 체인 확정. */
export const LedgerRootStatus = z.enum(["READY", "SENT", "POSTED"]);
export type LedgerRootStatus = z.infer<typeof LedgerRootStatus>;

/** `GET /api/v1/ledger/roots/latest` — 루트 10칸 + 상태. */
export const RootView = LedgerRootFields.extend({
  rootIndex: z.number().int().nonnegative(),
  status: LedgerRootStatus,
  txHash: Bytes32.nullable(),
  postedBlock: BlockNumber.nullable(),
}).strict();
export type RootView = z.infer<typeof RootView>;

/** 루트 신선도 (api 판매 문, D202). sinceWindow = 마지막 POSTED 루트의 throughWindow, 없으면 W0 − 1. closedThrough·ageBlocks = null이면 명단 커서 없음(문 닫힘). */
export const RootFreshness = z.object({
  closedThrough: BlockNumber.nullable(),
  sinceWindow: z.number().int().min(-1),
  ageBlocks: z.number().int().nonnegative().nullable(),
  maxAgeBlocks: z.number().int().nonnegative(),
  salesOpen: z.boolean(),
}).strict();
export type RootFreshness = z.infer<typeof RootFreshness>;

/** `GET /api/v1/ledger/roots/latest` — 마지막 POSTED 루트(없으면 null) + 신선도 + 서명 도메인·세계. */
export const LatestRootView = z.object({
  root: RootView.nullable(),
  freshness: RootFreshness,
  ledger: z.object({
    address: Address,
    chainId: z.number().int().positive(),
    genesisBlock: BlockNumber,
    rootEveryEpochs: z.number().int().positive(),
  }).strict(),
}).strict();
export type LatestRootView = z.infer<typeof LatestRootView>;
