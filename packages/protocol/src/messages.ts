import { z } from "zod";
import { Address, Bytes32, BlockNumber, DecimalString, U32 } from "./primitives.js";
import { FeedEventKind, PlayerShortId } from "./feed.js";
import { SettleKind } from "./purchase.js";
import { HistoryItem } from "./rest.js";
import { LedgerEntryKind, LedgerSignature } from "./ledger.js";
import { LedgerRejectReason } from "./ledger-files.js";

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
  "auth.duplicate.session", "rules.stale", "sales.closed", "room.frozen",
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


/**
 * `pickaxe.end` — 곡괭이 주인에게. record.paidMilli = 엔진이 정한 정산 값(최종), record.settlement = 정산 상태(처음엔 PENDING).
 * 잔액은 체인 정산이 확정된 뒤(`pickaxe.settled`)에 바뀐다. 화면은 그 사이 "정산 중"으로 보여 준다.
 */
export const PickaxeEndMsg = z.object({ record: HistoryItem }).strict();
export type PickaxeEndMsg = z.infer<typeof PickaxeEndMsg>;

/** `pickaxe.settled` — 곡괭이 주인의 모든 연결. 장부 지급이 커밋된 윈도 뒤(game-server, 명세 20 §2.8). 장부 지급에는 체인 tx가 없어 txHash = null. */
export const PickaxeSettledMsg = z.object({
  itemKey: z.string().min(1),
  purchaseId: DecimalString,
  itemIndex: z.number().int().min(0).max(9),
  kind: SettleKind,
  payoutMilli: z.number().int().nonnegative(),
  overMilli: z.number().int().nonnegative(),
  txHash: Bytes32.nullable(),
  blockNumber: BlockNumber,
}).strict();
export type PickaxeSettledMsg = z.infer<typeof PickaxeSettledMsg>;

/** `history.append` — 그 주소의 모든 연결. cursor는 GET /history 커서와 같은 체계. */
export const HistoryAppendMsg = z.object({ record: HistoryItem, cursor: z.string() }).strict();
export type HistoryAppendMsg = z.infer<typeof HistoryAppendMsg>;

// ── 장부 명단·의향서 결과 (명세 20, D196) ─────────────────────────────────────

/** `list` 항목 (영수증 재료): entryHash(kind, roomId, ref)를 다시 계산해 entriesHash·서명을 확인할 수 있다. GRANT의 roomId는 0. */
export const ListEntryMsg = z.object({
  kind: LedgerEntryKind,
  roomId: U32,
  ref: Bytes32,
}).strict();
export type ListEntryMsg = z.infer<typeof ListEntryMsg>;

/**
 * `list` — 명단 w가 DB에 커밋된 뒤 모든 방 연결에 (창 번호 시계 역할도 한다).
 * 빈 명단은 `{ window, count: 0, entriesHash: null, signer: null, signature: null, entries: [] }` (서명하지 않는다).
 * 웹은 내 다이제스트(ref)가 있으면 이 메시지를 영수증으로 저장한다.
 */
export const ListMsg = z.object({
  window: BlockNumber,
  count: U32,
  entriesHash: Bytes32.nullable(),
  signer: z.string().regex(/^0x[0-9a-f]{40}$/).nullable(),
  signature: LedgerSignature.nullable(),
  entries: z.array(ListEntryMsg),
}).strict().superRefine((m, ctx) => {
  if (m.entries.length !== m.count) ctx.addIssue({ code: "custom", message: "entries.length must equal count" });
  const empty = m.count === 0;
  if (empty !== (m.signature === null) || empty !== (m.entriesHash === null) || empty !== (m.signer === null)) {
    ctx.addIssue({ code: "custom", message: "empty list ⇔ no entriesHash/signer/signature" });
  }
});
export type ListMsg = z.infer<typeof ListMsg>;

/** `intent.result` — 의향서 주인의 연결에, 그 창(listWindow) 처리가 커밋된 뒤. */
export const IntentResultMsg = z.object({
  digest: Bytes32,
  kind: z.enum(["BUY", "CANCEL"]),
  status: z.enum(["APPLIED", "REJECTED"]),
  reason: LedgerRejectReason.nullable(),
  purchaseId: DecimalString.nullable(),
  listWindow: BlockNumber,
  listIndex: z.number().int().nonnegative(),
}).strict().refine((m) => (m.status === "REJECTED") === (m.reason !== null), { message: "reason is set iff REJECTED" });
export type IntentResultMsg = z.infer<typeof IntentResultMsg>;

// ── 방 채팅 (D212) ──────────────────────────────────────────────────────────
// 로그인한 연결만 보낸다(관전자는 읽기만). 서버가 다듬고(trim·제어 문자 제거) 1~160자만 받는다. 지갑마다 2초에 1개·1분에 20개.
// 저장하지 않는다 — 방마다 최근 50개 고리만 메모리에 두고 들어올 때 `chat.history`로 준다. 들어옴·나감 줄은 없다.

/** 채팅 한 줄 최대 글자 수 (JS 문자열 길이 = UTF-16 단위, 입력칸 maxLength와 같은 셈). */
export const CHAT_MAX_CHARS = 160;
/** 방마다 기억하는(그리고 들어올 때 보내는) 최근 채팅 수. */
export const CHAT_HISTORY_MAX = 50;

/** `chat.send` (클라이언트 → 서버). 길이·모양은 서버가 다듬은 뒤 본다 — 여기서는 문자열인지만. */
export const ChatSend = z.object({ text: z.string().max(CHAT_MAX_CHARS * 8) }).strict();
export type ChatSend = z.infer<typeof ChatSend>;

/** `chat.msg` — 방 전원. id = 방 안 순번, at = 서버 시각(ms). shortId = 피드·LIVE와 같은 화면 이름. */
export const ChatMsg = z.object({
  id: z.number().int().nonnegative(),
  wallet: Address,
  shortId: PlayerShortId,
  text: z.string().min(1).max(CHAT_MAX_CHARS),
  at: z.number().int().nonnegative(),
}).strict();
export type ChatMsg = z.infer<typeof ChatMsg>;

/** `chat.history` — 들어온 연결에 한 번: 최근 CHAT_HISTORY_MAX개, 옛것부터. */
export const ChatHistoryMsg = z.object({ messages: z.array(ChatMsg).max(CHAT_HISTORY_MAX) }).strict();
export type ChatHistoryMsg = z.infer<typeof ChatHistoryMsg>;

/** 채팅을 받지 않은 이유. RATE_LIMITED면 retryAfterMs 뒤에 다시. */
export const ChatRejectReason = z.enum(["NOT_SIGNED_IN", "BAD_FORMAT", "EMPTY", "TOO_LONG", "RATE_LIMITED"]);
export type ChatRejectReason = z.infer<typeof ChatRejectReason>;

/** `chat.rejected` — 보낸 연결에만 (방송하지 않는다). */
export const ChatRejectedMsg = z.object({ reason: ChatRejectReason, retryAfterMs: z.number().int().nonnegative().optional() }).strict();
export type ChatRejectedMsg = z.infer<typeof ChatRejectedMsg>;
