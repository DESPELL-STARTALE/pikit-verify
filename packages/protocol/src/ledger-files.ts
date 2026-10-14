import { z } from "zod";
import { Address, Bytes32, BlockNumber, DecimalString, HexBytes, U32 } from "./primitives.js";
import {
  BuyIntentMessage, CancelQueueMessage, GrantMessage, LedgerLeaf, LedgerSessionMessage, LedgerSignature,
} from "./ledger.js";

// ──────────────────────────────────────────────────────────────────────────
// 명세 20 장부 공개 파일·명단 모양 (계획 §2.5·§2.10, D196). **ledgerHash 밖** — 모양을 바꿔도 장부 규칙 해시는 그대로다
// (그래도 공개 파일 형식이라 바꾸면 replayHash·검증기가 함께 바뀐다).
//
//  - SignedWindowList: 윈도 w 명단 = 서명된 머리(window·entriesHash·count) + 항목 본문. game-server `ListSource.listFor(w)`가 주고,
//    엔진 처리 전이라 결정이 없다.
//  - `ledger/<e>.json` (pikit.ledger/v1): 에폭 e의 명단 전부 + 항목마다 장부 결정 + 그 에폭에 쓰인 세션 허가 + 블록 timestamp.
//  - `ledger/leaves/<k>.json` (pikit.ledger-leaves/v1): 루트 k 경계의 장부 잎 전부(지갑 오름차순).
//  - LedgerRootRecord: PikitLedger `Root` 10칸 + 체인 자리(RootPosted).
// ──────────────────────────────────────────────────────────────────────────

export const LEDGER_FILE_SCHEMA_ID = "pikit.ledger/v1" as const;
export const LEDGER_LEAVES_SCHEMA_ID = "pikit.ledger-leaves/v1" as const;

/** 명단 항목 하나. ref = BUY·CANCEL은 의향서 EIP-712 다이제스트, GRANT는 grantRef. entryHash(kind, roomId, ref)의 재료. */
export const LedgerListEntry = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("BUY"), ref: Bytes32, intent: BuyIntentMessage, signature: LedgerSignature }).strict(),
  z.object({ kind: z.literal("CANCEL"), ref: Bytes32, intent: CancelQueueMessage, signature: LedgerSignature }).strict(),
  z.object({ kind: z.literal("GRANT"), ref: Bytes32, grant: GrantMessage }).strict(),
]);
export type LedgerListEntry = z.infer<typeof LedgerListEntry>;

/** 항목의 entryHash 재료 (kind, roomId, ref). GRANT의 roomId는 0. */
export function listEntryKey(e: LedgerListEntry): { kind: LedgerListEntry["kind"]; roomId: number; ref: `0x${string}` } {
  return { kind: e.kind, roomId: e.kind === "GRANT" ? 0 : e.intent.roomId, ref: e.ref as `0x${string}` };
}

/** 항목의 지갑 (BUY·CANCEL = intent.wallet, GRANT = grant.wallet). */
export function listEntryWallet(e: LedgerListEntry): string {
  return e.kind === "GRANT" ? e.grant.wallet : e.intent.wallet;
}

/**
 * 서명된 명단 (count ≥ 1). signer = 서명한 ANNOUNCE 키 주소(편의 — 검증기는 체인 `AnnouncerChanged`로 그 창의 키를 정하고 복구 값과 대조).
 * entries.length = count, entriesHash = entriesHash(entries의 entryHash) — 해시 일치는 A3/검증기가 본다(여기는 모양만).
 */
export const SignedWindowList = z.object({
  window: BlockNumber,
  entriesHash: Bytes32,
  count: U32.min(1),
  signer: Address,
  signature: LedgerSignature,
  entries: z.array(LedgerListEntry).min(1),
}).strict().refine((l) => l.entries.length === l.count, { message: "entries.length must equal count" });
export type SignedWindowList = z.infer<typeof SignedWindowList>;

/**
 * 장부 거절 이유 (장부 규칙이 명단 항목을 받지 않은 이유 — 재생으로 확인되는 값). api 단계 거절(409)은 rest.ts `IntentRefusalCode`.
 *  BAD_SIGNATURE     세션 키 서명이 의향서의 sessionKey가 아님(복구 실패 포함)
 *  SESSION_MISSING   그 (wallet, sessionKey)의 LedgerSession 허가가 파일에 없음 / 지갑 서명이 틀림(EOA 복구 실패이고 erc1271Block도 없음)
 *  SESSION_EXPIRED   블록 w timestamp > expiresAt
 *  TARGET_MISMATCH   intent.targetWindow ≠ 명단 창
 *  SEQ_USED          seq ≤ lastSeq (상태 그대로 — seq도 소비하지 않음)
 *  UNKNOWN_ROOM      방이 세계 목록에 없음
 *  RULES_MISMATCH    rulesHash ≠ 체인 rulesHash
 *  BAD_TIERS         등급이 카탈로그에 없음 · 개수 1~10 밖 / 취소 항목 형식 틀림
 *  ROOM_WINDOW_FULL  이 방의 이번 윈도 입력이 MAX_INPUTS_PER_ROOM_WINDOW를 넘음
 *  INSUFFICIENT_CREDITS 가격 > balance
 *  GRANT_DAY         day가 [blockDay − 1, blockDay] 밖
 *  GRANT_ALREADY     day ≤ lastGrantDay (하루 1번)
 *  GRANT_TOO_LARGE   amountMilli > GRANT_MAX_MILLI 또는 0
 * seq 소비 여부(SEQ_USED·BAD_SIGNATURE 등은 소비 안 함, 잔액 부족은 소비)는 A3 규칙이 정한다(계획 §2.3: "서명·세션이 맞고 seq > lastSeq면 소비").
 */
export const LedgerRejectReason = z.enum([
  "BAD_SIGNATURE", "SESSION_MISSING", "SESSION_EXPIRED", "TARGET_MISMATCH", "SEQ_USED", "UNKNOWN_ROOM", "RULES_MISMATCH",
  "BAD_TIERS", "ROOM_WINDOW_FULL", "INSUFFICIENT_CREDITS", "GRANT_DAY", "GRANT_ALREADY", "GRANT_TOO_LARGE",
]);
export type LedgerRejectReason = z.infer<typeof LedgerRejectReason>;

/** 항목 하나의 장부 결정. APPLIED BUY는 purchaseId(전역 nextPurchaseId에서 받은 번호)를 가진다. */
export const LedgerDecision = z.object({
  status: z.enum(["APPLIED", "REJECTED"]),
  reason: LedgerRejectReason.nullable(),
  purchaseId: DecimalString.nullable(),
}).strict().superRefine((d, ctx) => {
  if ((d.status === "REJECTED") !== (d.reason !== null)) ctx.addIssue({ code: "custom", message: "reason is set iff status is REJECTED" });
  if (d.status === "REJECTED" && d.purchaseId !== null) ctx.addIssue({ code: "custom", message: "REJECTED has no purchaseId" });
});
export type LedgerDecision = z.infer<typeof LedgerDecision>;

/** 장부 파일 안의 명단 = 서명된 명단 + 항목마다 결정(같은 길이). */
export const LedgerFileList = z.object({
  window: BlockNumber,
  entriesHash: Bytes32,
  count: U32.min(1),
  signer: Address,
  signature: LedgerSignature,
  entries: z.array(LedgerListEntry).min(1),
  decisions: z.array(LedgerDecision).min(1),
}).strict().superRefine((l, ctx) => {
  if (l.entries.length !== l.count) ctx.addIssue({ code: "custom", message: `window ${l.window}: entries.length must equal count` });
  if (l.decisions.length !== l.entries.length) ctx.addIssue({ code: "custom", message: `window ${l.window}: one decision per entry` });
  l.entries.forEach((e, i) => {
    const d = l.decisions[i];
    if (d && e.kind !== "BUY" && d.purchaseId !== null) ctx.addIssue({ code: "custom", message: `window ${l.window} entry ${i}: only BUY has purchaseId` });
    if (d && e.kind === "BUY" && d.status === "APPLIED" && d.purchaseId === null) ctx.addIssue({ code: "custom", message: `window ${l.window} entry ${i}: applied BUY needs purchaseId` });
  });
});
export type LedgerFileList = z.infer<typeof LedgerFileList>;

/**
 * 세션 허가 기록. signature = 지갑 서명(EOA는 65바이트, 스마트 지갑은 임의 길이 — ERC-1271/6492).
 * erc1271Block = api가 RPC로 1271을 확인한 블록(EOA면 null). 검증기는 EOA는 복구, 1271은 그 블록에서 `isValidSignature`를 다시 부른다.
 */
export const LedgerSessionRecord = z.object({
  session: LedgerSessionMessage,
  signature: HexBytes,
  erc1271Block: BlockNumber.nullable(),
}).strict();
export type LedgerSessionRecord = z.infer<typeof LedgerSessionRecord>;

/**
 * `ledger/<e>.json` — 에폭 e의 장부 입력과 결정.
 *  sessions: 이 에폭 명단의 BUY·CANCEL이 쓴 세션 허가 전부((wallet, sessionKey) 오름차순, 중복 없음)
 *  lists: 빈 명단이 아닌 창만, 창 오름차순
 *  blockTimestamps: 명단이 있는 창 w의 블록 w timestamp(unix 초) — 세션 기한·GRANT 날 판정 재료. 검증기는 RPC로 대조한다.
 */
export const LedgerEpochFile = z.object({
  schema: z.literal(LEDGER_FILE_SCHEMA_ID),
  chainId: z.number().int().positive(),
  ledger: Address,
  epoch: U32,
  firstWindow: BlockNumber,
  lastWindow: BlockNumber,
  sessions: z.array(LedgerSessionRecord),
  lists: z.array(LedgerFileList),
  blockTimestamps: z.record(z.string().regex(/^(0|[1-9][0-9]*)$/), z.number().int().nonnegative()),
}).strict().superRefine((f, ctx) => {
  if (f.lastWindow < f.firstWindow) ctx.addIssue({ code: "custom", message: "lastWindow must be ≥ firstWindow" });
  let prev = -1;
  for (const l of f.lists) {
    if (l.window <= prev) ctx.addIssue({ code: "custom", message: `lists must be strictly increasing by window (at ${l.window})` });
    if (l.window < f.firstWindow || l.window > f.lastWindow) ctx.addIssue({ code: "custom", message: `list ${l.window} outside [firstWindow, lastWindow]` });
    if (f.blockTimestamps[String(l.window)] === undefined) ctx.addIssue({ code: "custom", message: `list ${l.window}: missing block timestamp` });
    prev = l.window;
  }
  let prevKey = "";
  for (const s of f.sessions) {
    const key = `${s.session.wallet}:${s.session.sessionKey}`;
    if (key <= prevKey) ctx.addIssue({ code: "custom", message: `sessions must be strictly ascending by (wallet, sessionKey) (at ${key})` });
    prevKey = key;
  }
});
export type LedgerEpochFile = z.infer<typeof LedgerEpochFile>;

/**
 * `ledger/leaves/<k>.json` — 루트 k(0부터, 컨트랙트 rootAt 순번) 경계의 장부 상태 전부.
 * leaves = 잔액·스테이크·seq·lastGrantDay 중 하나라도 0이 아닌 지갑 전부, 지갑 오름차순(중복 없음).
 * ledgerRoot = ledgerRoot(leaves), supplyMilli = ledgerSupplyMilli(leaves) — 루트 칸과 같아야 한다.
 */
export const LedgerLeavesFile = z.object({
  schema: z.literal(LEDGER_LEAVES_SCHEMA_ID),
  chainId: z.number().int().positive(),
  ledger: Address,
  rootIndex: z.number().int().nonnegative(),
  epoch: U32,
  throughWindow: BlockNumber,
  nextPurchaseId: DecimalString,
  ledgerRoot: Bytes32,
  supplyMilli: DecimalString,
  leaves: z.array(LedgerLeaf),
}).strict().superRefine((f, ctx) => {
  let prev = "";
  for (const l of f.leaves) {
    if (l.wallet <= prev) ctx.addIssue({ code: "custom", message: `leaves must be strictly ascending by wallet (at ${l.wallet})` });
    prev = l.wallet;
  }
});
export type LedgerLeavesFile = z.infer<typeof LedgerLeavesFile>;

/** PikitLedger `Root` 10칸 (postRoot 인자 · RootPosted 이벤트). */
export const LedgerRootFields = z.object({
  epoch: U32,
  seed: Bytes32,
  throughWindow: BlockNumber,
  roomsStateRoot: Bytes32,
  inputLogRoot: Bytes32,
  boardBatchRoot: Bytes32,
  ledgerRoot: Bytes32,
  payoutsRoot: Bytes32,
  supplyMilli: DecimalString,
  dataHash: Bytes32,
}).strict();
export type LedgerRootFields = z.infer<typeof LedgerRootFields>;

/** 체인 `RootPosted(index, root)` 1건 + 실린 자리. */
export const LedgerRootRecord = LedgerRootFields.extend({
  rootIndex: z.number().int().nonnegative(),
  postedBlock: BlockNumber,
  txHash: Bytes32,
}).strict();
export type LedgerRootRecord = z.infer<typeof LedgerRootRecord>;
