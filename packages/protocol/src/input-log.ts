import { z } from "zod";
import { Address, Bytes32, BlockNumber, U32 } from "./primitives.js";

// ──────────────────────────────────────────────────────────────────────────
// 엔진 입력 기록 — 엔진이 윈도(확정 블록) w에서 처리하는 입력. 누구나 이 파일 + 카탈로그 + 시드로 재생한다.
// 입력은 모두 체인에서 온다(개정 3: 서버 영수증 없음, D111: 연결 규칙): 블록 b의 Purchased·CancelRequested·PurchasesVoided와
// 동결 시작 블록 → 윈도 b + 1부터, 방마다 (블록, 로그 번호, 순번) 순서, 윈도당 상한(넘친 것은 다음 윈도). docs/fairness-chain-linkage.md
// ──────────────────────────────────────────────────────────────────────────

/**
 * 곡괭이 구매 = 체인 `Purchased` 이벤트 하나 (relayer가 낸 크레딧 의향서, 개정 5·D105). ref = purchaseId.
 * 크레딧은 이미 체인 잔액에서 빠졌다. 엔진은 잔액을 보지 않고 대기열에 넣기만 한다.
 * 개정 5에는 결제 수단이 하나(프로모 크레딧)뿐이라 결제 수단 칸이 없다(D107).
 */
export const PurchaseInput = z.object({
  type: z.literal("purchase"),
  ref: z.string().regex(/^(0|[1-9][0-9]*)$/),
  owner: Address,
  tiers: z.array(z.number().int().nonnegative()).min(1),
}).strict();
export type PurchaseInput = z.infer<typeof PurchaseInput>;

/** 대기 중인 곡괭이 취소 = 체인 `CancelRequested`의 항목 하나. 아직 대기 중이면 가격 100%를 정산(REFUND)한다. */
export const CancelInput = z.object({
  type: z.literal("cancel"),
  owner: Address,
  itemKey: z.string().regex(/^(0|[1-9][0-9]*):[0-9]$/),
}).strict();
export type CancelInput = z.infer<typeof CancelInput>;

/**
 * 방 동결: 처리 지연(블록 − 마지막 앵커 processedThrough)이 T_FREEZE(12,000)를 처음 넘은 블록 F의 체인 규칙 → 윈도 F + 1, 그때 있던 모든 방.
 * 돌던 곡괭이는 비정상 종료 값, 대기열은 100%. ROOM_CLOSED는 엔진에 남아 있지만 체인 사건이 없어 운영에서는 나오지 않는다(검증기는 EXTRA로 실패).
 */
export const FreezeInput = z.object({
  type: z.literal("freeze"),
  reason: z.enum(["FREEZE", "ROOM_CLOSED"]),
}).strict();
export type FreezeInput = z.infer<typeof FreezeInput>;

/**
 * 무효 구매 제거 (설계 §5.3). 늦은 앵커의 `PurchasesVoided(fromId, toId)`(블록 a) → 구간의 구매마다 윈도 a + 1부터 (D111).
 * 환불(`refundUnprocessed`·`refundUnsettled`)은 엔진 입력을 만들지 않는다 — 무효 구매의 곡괭이는 그 전에 동결(윈도 F + 1)이 끝냈고,
 * 정산 시한(288,000블록) 뒤의 곡괭이는 오래전에 끝났다.
 * 엔진: 그 구매의 대기 항목과 살아 있는 곡괭이를 지급 없이 없앤다(endReason VOID, 정산 없음).
 */
export const VoidPurchaseInput = z.object({
  type: z.literal("voidPurchase"),
  ref: z.string().regex(/^(0|[1-9][0-9]*)$/),
  owner: Address,
}).strict();
export type VoidPurchaseInput = z.infer<typeof VoidPurchaseInput>;

/** 방 입력 (방 엔진이 처리한다). 모두 체인 이벤트 또는 체인 데이터로 정해지는 규칙(동결·무효)에서 온다. */
export const EngineInput = z.discriminatedUnion("type", [PurchaseInput, CancelInput, FreezeInput, VoidPurchaseInput]);
export type EngineInput = z.infer<typeof EngineInput>;

export const InputWindow = z.object({
  window: BlockNumber,
  blockHash: Bytes32.optional(),   // 윈도 키 재료. v0 재생기는 없으면 0x00…으로 본다
  inputs: z.array(EngineInput),
}).strict();
export type InputWindow = z.infer<typeof InputWindow>;

export const INPUT_LOG_SCHEMA_ID = "pikit.inputlog/v0" as const;

/**
 * v0 입력 기록 파일. 시드 사슬 대신 시드 하나(seed)를 쓴다 — M1에서 에폭별 시드 사슬로 바꾼다.
 * firstWindow = 방이 만들어진 윈도(판·봇 생성, 입력 없음). 재생은 firstWindow + 1 … lastWindow를 순서대로 돈다.
 * windows에는 입력이 있는 윈도만 적는다(없는 윈도는 입력 없이 돈다).
 */
export const InputLog = z.object({
  schema: z.literal(INPUT_LOG_SCHEMA_ID),
  rulesHash: Bytes32,              // canonicalHash(카탈로그). 다르면 재생을 거부한다
  chainId: z.number().int().positive(),
  shop: Address,
  roomId: U32,
  seed: Bytes32,
  firstWindow: BlockNumber,
  lastWindow: BlockNumber,
  windows: z.array(InputWindow),
}).strict().superRefine((log, ctx) => {
  if (log.lastWindow < log.firstWindow) ctx.addIssue({ code: "custom", message: "lastWindow must be ≥ firstWindow" });
  let prev = -1;
  for (const w of log.windows) {
    if (w.window <= prev) ctx.addIssue({ code: "custom", message: `windows must be strictly increasing (at ${w.window})` });
    if (w.window <= log.firstWindow || w.window > log.lastWindow) ctx.addIssue({ code: "custom", message: `window ${w.window} outside (firstWindow, lastWindow]` });
    prev = w.window;
  }
});
export type InputLog = z.infer<typeof InputLog>;

// ──────────────────────────────────────────────────────────────────────────
// v3 입력 기록: 에폭(200블록)마다 파일 하나, 모든 방 (D37·D40, 개정 3에서 공유 장부 입력을 없앰 → v2, 체인 연결 D111 → v3)
//  - 입력마다 체인 연결(InputLink: 블록·로그 번호·순번·tx)을 함께 적는다. 입력 = 체인 사건(docs/fairness-chain-linkage.md):
//      블록 b의 사건 → 윈도 b + 1부터, 방마다 (블록, 로그 번호, 순번) 순서로 윈도당 MAX_INPUTS_PER_ROOM_WINDOW개까지(넘친 것은 다음 윈도로)
//  - 윈도 w의 처리 순서: 방들(roomId 오름차순, 방마다 위 순서)
//  - 해시 사슬: 위 순서로 줄마다 h_i = keccak256(h_{i−1} ‖ keccak256(canonicalJSON(InputLogEntry))), 에폭을 넘어 이어진다.
//    줄에 연결(link)도 들어가므로 앵커의 inputLogRoot가 "어느 체인 사건에서 왔나"까지 묶는다
//  - 앵커의 inputLogRoot = processedThrough 윈도까지의 사슬 머리
//  - 블록 해시는 기록에 넣지 않는다(검증자가 체인에서 직접 받는다). 시드 S_e는 공개된 뒤 seed에 채운다(선택)
// ──────────────────────────────────────────────────────────────────────────

export const EPOCH_INPUT_LOG_SCHEMA_ID = "pikit.inputlog/v3" as const;

/**
 * 방 하나가 윈도 하나에 받는 입력 상한 (보안 리뷰 M-2, D108). 넘는 것은 (블록, 로그 번호, 순번) 순서 그대로 다음 윈도로 넘긴다.
 * 연결 규칙의 일부라 game-server·검증기·감시 봇이 같은 값을 쓴다(바꾸면 옛 기록의 기대 윈도가 달라진다).
 */
export const MAX_INPUTS_PER_ROOM_WINDOW = 100;

/**
 * 엔진 입력 하나가 온 체인 자리 (D111). 정렬 키 = (block, logIndex, pos), 입력은 윈도 block + 1부터.
 *   purchase     = `Purchased` 로그              pos 0
 *   cancel       = `CancelRequested` 로그의 항목  pos = items 안 순번
 *   voidPurchase = `PurchasesVoided` 로그(PikitFairness, 늦은 앵커)의 구매   pos = purchaseId − fromId
 *   freeze       = 처리 지연이 T_FREEZE를 처음 넘은 블록 F (체인 앵커로 정해지는 규칙, 로그 없음) — logIndex −1(그 블록 로그보다 앞), txHash null
 */
export const InputLink = z.object({
  block: BlockNumber,
  logIndex: z.number().int().min(-1),
  pos: z.number().int().nonnegative(),
  txHash: Bytes32.nullable(),
}).strict().refine((l) => (l.logIndex === -1) === (l.txHash === null), { message: "logIndex −1 (freeze) ⇔ txHash null" });
export type InputLink = z.infer<typeof InputLink>;

/** 연결 순서 (block, logIndex, pos). */
export function compareInputLinks(a: InputLink, b: InputLink): number {
  return a.block - b.block || a.logIndex - b.logIndex || a.pos - b.pos;
}

/** 연결 하나를 가리키는 글자 키 "<block>:<logIndex>:<pos>" (같은 체인 사건 = 같은 키). */
export function inputLinkKey(l: InputLink): string {
  return `${l.block}:${l.logIndex}:${l.pos}`;
}

export const EpochWindowInputs = z.object({
  window: BlockNumber,
  rooms: z.array(z.object({ roomId: U32, inputs: z.array(EngineInput).min(1), links: z.array(InputLink).min(1) }).strict()).min(1),
}).strict().superRefine((w, ctx) => {
  let prev = -1;
  for (const r of w.rooms) {
    if (r.roomId <= prev) ctx.addIssue({ code: "custom", message: `window ${w.window}: rooms must be strictly ascending by roomId` });
    if (r.links.length !== r.inputs.length) ctx.addIssue({ code: "custom", message: `window ${w.window} room ${r.roomId}: one link per input` });
    prev = r.roomId;
  }
});
export type EpochWindowInputs = z.infer<typeof EpochWindowInputs>;

export const EpochInputLog = z.object({
  schema: z.literal(EPOCH_INPUT_LOG_SCHEMA_ID),
  chainId: z.number().int().positive(),
  shop: Address,
  epoch: U32,
  firstWindow: BlockNumber,
  lastWindow: BlockNumber,
  prevHead: Bytes32,
  head: Bytes32,
  seed: Bytes32.optional(),
  windows: z.array(EpochWindowInputs),
}).strict().superRefine((log, ctx) => {
  if (log.lastWindow < log.firstWindow) ctx.addIssue({ code: "custom", message: "lastWindow must be ≥ firstWindow" });
  let prev = -1;
  for (const w of log.windows) {
    if (w.window <= prev) ctx.addIssue({ code: "custom", message: `windows must be strictly increasing (at ${w.window})` });
    if (w.window < log.firstWindow || w.window > log.lastWindow) ctx.addIssue({ code: "custom", message: `window ${w.window} outside [firstWindow, lastWindow]` });
    prev = w.window;
  }
});
export type EpochInputLog = z.infer<typeof EpochInputLog>;

/** 해시 사슬의 줄 하나. index = 그 윈도·그 방 안의 순번, link = 그 입력이 온 체인 자리. */
export interface InputLogEntry {
  window: number;
  roomId: number;
  index: number;
  input: EngineInput;
  link: InputLink;
}

/** 에폭 기록의 줄을 사슬 순서대로 펼친다. */
export function epochLogEntries(log: Pick<EpochInputLog, "windows">): InputLogEntry[] {
  const out: InputLogEntry[] = [];
  for (const w of log.windows) {
    for (const r of w.rooms) r.inputs.forEach((input, index) => out.push({ window: w.window, roomId: r.roomId, index, input, link: r.links[index]! }));
  }
  return out;
}
