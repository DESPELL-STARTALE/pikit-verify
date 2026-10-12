import { z } from "zod";
import { Bytes32, BlockNumber, DecimalString, U32 } from "./primitives.js";
import { FeedEventKind, PlayerShortId } from "./feed.js";
import { SettleKind } from "./purchase.js";
import { HistoryItem } from "./rest.js";

// ──────────────────────────────────────────────────────────────────────────
// Colyseus 방 메시지 (apps/game-server ↔ apps/web). docs/INTERFACES.md §1.
// 개정 3: 구매·취소는 방 메시지가 아니다. MON은 지갑 tx, 크레딧·취소는 세션 키 의향서를 api(→ settler relayer)로 보내고,
// 서버는 체인 이벤트(Purchased·CancelRequested)만 믿는다. 방은 결과(purchase.receipt·queue.state·pickaxe.end·pickaxe.settled)만 알린다.
// ──────────────────────────────────────────────────────────────────────────

/**
 * join 옵션. 방 선택은 `chainRoomId`(체인 방 번호)다 — Colyseus가 `roomId`를 내부용으로 쓰므로 그 이름은 쓰지 않는다(D58).
 * 서버는 `filterBy(["chainRoomId"])`.
 */
export const JoinOptions = z.object({
  chainRoomId: U32,
  rulesVersion: U32.optional(),         // 클라이언트가 받은 카탈로그 버전. 다르면 system.notice rules.stale
  clientVersion: z.string().max(64).optional(),
  token: z.string().optional(),         // 쿠키를 못 싣는 환경에서만
}).strict();
export type JoinOptions = z.infer<typeof JoinOptions>;

// ── 클라이언트 → 서버 ───────────────────────────────────────────────────────

export const Locale = z.enum(["en", "ja", "ko"]);
export type Locale = z.infer<typeof Locale>;

/** `settings.update` */
export const SettingsUpdate = z.object({
  feed: z.object({ kinds: z.array(FeedEventKind).optional(), minTier: z.number().int().nonnegative().optional() }).strict().optional(),
  alerts: z.object({ spawn: z.boolean().optional(), reward: z.boolean().optional() }).strict().optional(),
  locale: Locale.optional(),
}).strict();
export type SettingsUpdate = z.infer<typeof SettingsUpdate>;

// ── 서버 → 클라이언트 ───────────────────────────────────────────────────────

/** 엔진 RejectedInput.reason (재생으로 확인되는 규칙 결과). */
export const PurchaseReason = z.enum(["BAD_TIER", "TOO_MANY_TIERS", "NOT_QUEUED", "ALREADY_VOID"]);
export type PurchaseReason = z.infer<typeof PurchaseReason>;

/** `purchase.receipt` — 체인 구매·취소가 엔진에 반영된 윈도의 DB 커밋 뒤 (MON·크레딧·프로모 모두 같은 모양). */
export const PurchaseReceiptMsg = z.object({
  source: z.enum(["PURCHASE", "CANCEL"]),
  purchaseId: DecimalString.optional(),     // PURCHASE
  txHash: Bytes32.optional(),               // 체인 tx
  effectBlock: BlockNumber,                 // 반영된 윈도
  status: z.enum(["APPLIED", "NO_EFFECT", "VOID"]),
  itemKeys: z.array(z.string()),
  overflowItemKeys: z.array(z.string()),
  reason: z.string().optional(),            // 엔진 RejectedInput.reason (PurchaseReason)
}).strict();
export type PurchaseReceiptMsg = z.infer<typeof PurchaseReceiptMsg>;

export const SystemNoticeType = z.enum([
  "auth.duplicate.session", "rules.stale", "sales.closed", "room.frozen", "chat.rate",
]);
export type SystemNoticeType = z.infer<typeof SystemNoticeType>;

/** `system.notice`. */
export const SystemNotice = z.object({
  type: SystemNoticeType,
  message: z.string(),
  durationMs: z.number().int().nonnegative(),
  code: z.string().optional(),
}).strict();
export type SystemNotice = z.infer<typeof SystemNotice>;

/** `chat.message` (그리고 `chat.history.snapshot`은 이것의 배열) */
export const ChatMessage = z.object({ playerShortId: PlayerShortId, message: z.string().min(1).max(200), block: BlockNumber }).strict();
export type ChatMessage = z.infer<typeof ChatMessage>;

/**
 * `pickaxe.end` — 곡괭이 주인에게. record.paidMilli = 엔진이 정한 정산 값(최종), record.settlement = 정산 상태(처음엔 PENDING).
 * 잔액은 체인 정산이 확정된 뒤(`pickaxe.settled`)에 바뀐다. 화면은 그 사이 "정산 중"으로 보여 준다.
 */
export const PickaxeEndMsg = z.object({ record: HistoryItem }).strict();
export type PickaxeEndMsg = z.infer<typeof PickaxeEndMsg>;

/** `pickaxe.settled` — 곡괭이 주인의 모든 연결. 체인 `Settled`가 확정 블록에서 보였을 때(settler follower → DB → game-server). */
export const PickaxeSettledMsg = z.object({
  itemKey: z.string().min(1),
  purchaseId: DecimalString,
  itemIndex: z.number().int().min(0).max(9),
  kind: SettleKind,
  payoutMilli: z.number().int().nonnegative(),
  overMilli: z.number().int().nonnegative(),
  txHash: Bytes32,
  blockNumber: BlockNumber,
}).strict();
export type PickaxeSettledMsg = z.infer<typeof PickaxeSettledMsg>;

/** `history.append` — 그 주소의 모든 연결. cursor는 GET /history 커서와 같은 체계. */
export const HistoryAppendMsg = z.object({ record: HistoryItem, cursor: z.string() }).strict();
export type HistoryAppendMsg = z.infer<typeof HistoryAppendMsg>;
