import { z } from "zod";
import { BlockNumber, U32 } from "./primitives.js";
import { EndReason, ExceptionCode } from "./history.js";

// ──────────────────────────────────────────────────────────────────────────
// 실시간 화면용 형식 — 피드(방 안 + 전체 티커), 대기열, 살아 있는 곡괭이, 생존 신호.
// 게임 서버가 Colyseus 메시지·상태로 보내고, API가 전체 피드로 다시 보낸다(docs/INTERFACES.md §1, §2).
// 원칙: 남의 전체 주소는 화면 형식에 넣지 않는다(짧은 id만). 내 기록 전체는 히스토리(API, 로그인)로만.
// ──────────────────────────────────────────────────────────────────────────

/**
 * 닉네임 (Q7 결정, D45): 영문자·숫자 1~12자, 공백·특수문자 없음 — 옛 PIKIT-BE `UpdateUserNameBodyDto`(`/^[A-Za-z0-9]+$/`, 최대 12) 그대로.
 * 유일성은 대소문자 무시(api DB). 닉네임은 "…"를 담을 수 없어 주소형 짧은 id와 겹치지 않는다.
 */
export const Nickname = z.string().regex(/^[A-Za-z0-9]{1,12}$/, "letters and digits only, 1..12");
export type Nickname = z.infer<typeof Nickname>;

/** 짧은 플레이어 id: 닉네임이 있으면 닉네임, 없으면 "0x" + 앞 4자리 + "…" + 뒤 4자리 (소문자). 피드·방 상태에서 주소 대신 쓴다. */
export const PlayerShortId = z.union([z.string().regex(/^0x[0-9a-f]{4}…[0-9a-f]{4}$/, "0xabcd…ef01"), Nickname]);
export type PlayerShortId = z.infer<typeof PlayerShortId>;

/** 화면 표시 id: 닉네임이 있으면 그것, 없으면 shortPlayerId(address). */
export function displayPlayerId(address: string, nickname?: string | null): PlayerShortId {
  return nickname ? Nickname.parse(nickname) : shortPlayerId(address);
}

/**
 * BIG_PAYOUT 피드 기준 (D46, 2026-10-10 개정): 곡괭이 총지급 > 가격 — 진짜 이득일 때만.
 * 가격보다 적게 돌려받은 결과를 승리처럼 축하하지 않는다(LDW, UKGC RTS 14F). 옛 기준은 ≥ 0.9 × 가격이었다.
 * 화면의 "돈 축하"(금 배너·동전·색종이·잭팟 소리)도 이 함수 하나로 판정한다(web lib/result.ts).
 */
export function isBigPayout(paidMilli: number, priceMilli: number): boolean {
  return paidMilli > priceMilli;
}

/** 주소(0x + 40 hex)를 짧은 id로. 대문자 주소도 받는다(소문자로 바꿈). */
export function shortPlayerId(address: string): PlayerShortId {
  const a = address.toLowerCase();
  if (!/^0x[0-9a-f]{40}$/.test(a)) throw new Error(`shortPlayerId: not an address: ${address}`);
  return `${a.slice(0, 6)}…${a.slice(-4)}`;
}

// ── WIN (규칙 10, 명세 23 §5) ───────────────────────────────────────────────

/** WIN 피드 기준: (payout + over) ≥ 가격 × 1.5 (bps). 남의 WIN은 이 이상만 전체 티커에 나간다. */
export const WIN_FEED_MIN_BPS = 15_000;

/** WIN causes 비트: 무엇이 그 결과를 만들었나. 화면의 "주원인" = JACKPOT > PICK > 그 밖. */
export const WIN_CAUSE = {
  MINING: 1,     // baseMilli > 0
  LUCKY: 2,      // luckyMilli > 0
  PICK: 4,       // pickMilli > 0 (사다리 보충)
  JACKPOT: 8,    // jackpotMilli > 0
  LAST_HIT: 16,  // lastHitMilli > 0
  POP: 32,       // bonusMilli > 0 (POP·BIG POP)
} as const;
/** 모든 causes 비트의 합 (63). */
export const WIN_CAUSE_ALL = 63;

/** winOf 입력 = 정산이 끝난 곡괭이 1개의 몫들 (엔진 PickaxeResult·히스토리 행과 같은 이름, 밀리크레딧 정수). */
export interface WinInput {
  priceMilli: number;
  baseMilli: number;
  luckyMilli: number;
  bonusMilli: number;
  lastHitMilli: number;
  pickMilli: number;
  jackpotMilli: number;
  paidMilli: number;
  overMilli: number;
}

/**
 * 순수 함수: multipleBps = ⌊(paid + over) × 10⁴ / 가격⌋ (BigInt — 큰 잭팟도 정확). < WIN_FEED_MIN_BPS면 null.
 * causes = 0보다 큰 몫마다 WIN_CAUSE 비트.
 */
export function winOf(r: WinInput): { multipleBps: number; causes: number } | null {
  if (!Number.isSafeInteger(r.priceMilli) || r.priceMilli <= 0) throw new Error(`winOf: bad priceMilli ${r.priceMilli}`);
  const multipleBps = Number((BigInt(r.paidMilli + r.overMilli) * 10_000n) / BigInt(r.priceMilli));
  if (multipleBps < WIN_FEED_MIN_BPS) return null;
  let causes = 0;
  if (r.baseMilli > 0) causes |= WIN_CAUSE.MINING;
  if (r.luckyMilli > 0) causes |= WIN_CAUSE.LUCKY;
  if (r.pickMilli > 0) causes |= WIN_CAUSE.PICK;
  if (r.jackpotMilli > 0) causes |= WIN_CAUSE.JACKPOT;
  if (r.lastHitMilli > 0) causes |= WIN_CAUSE.LAST_HIT;
  if (r.bonusMilli > 0) causes |= WIN_CAUSE.POP;
  return { multipleBps, causes };
}

// ── 피드 ────────────────────────────────────────────────────────────────────

// BIG_POP (규칙 7, D137): 새 블록 3연속 같은 종류, 곡괭이당 1번 (POP과 같은 꼴, streakCount 3).
// 끝 사건(PICKAXE_END·BIG_PAYOUT): amountMilli = 끝 정산 payout(REWARD·REFUND 몫), overMilli = 같은 settleEnd의 초과분 — 합이 곡괭이가 받은 전부.
// SKY_DROP·SKY_CATCH (D125, 하늘 이벤트 "✨ 별"): 돈과 무관한 연출 사건(amountMilli 0). SKY_DROP = 별이 겨눈(고른) 곡괭이·떨어진 틱,
// SKY_CATCH = 별을 잡은 곡괭이·잡은 틱. 같은 별은 skyId(떨어진 윈도 번호)로 묶는다 — 둘의 곡괭이가 다르면 "가로챔". 사라짐은 피드에 없다.
// LAST_HIT (규칙 9, 명세 22 §3): 한 방에 못 깨는 블록을 깬 막타 1건. amountMilli = 실제 지급(상한 적용 후, 0일 수 있음), overMilli 없음,
// streakCount 0, tick = 깬 틱. 엔진 WindowResult.lastHits가 원본(BonusEventKind와 장부 해시는 그대로 — BonusEvent가 아니다).
// (규칙 10, 명세 23 §5) LUCKY_PICK: 소환 때 사다리 단계가 붙음(multBps = 단계, amountMilli 0, tick = 소환 틱).
// JACKPOT: 골든 CHOG 균열 1건(amountMilli = 잭팟 J, poolAfterMilli = 균열 뒤 통(0), cellX·cellY = 블록 칸).
// WIN: 정산 결과가 가격의 WIN_FEED_MIN_BPS 이상(winOf) — amountMilli = payout, overMilli = over, endReason, multBps = ⌊(payout + over) × 10⁴ / 가격⌋, causes 비트(WIN_CAUSE).
// (규칙 11, 명세 24 §4.3) COMBO는 POP(s = 2)·BIG_POP(s ≥ 3)을 그대로 쓴다(streakCount = s, 곡괭이당 여러 번).
// BUFF: 아이템 1건(규칙 12, 명세 25 §4.3: buffKind = 종류, amountMilli 0, tick = 뽑기 틱, cellX·cellY = 마지막으로 맞힌 칸).
// 같은 틱 순서: JACKPOT → LAST_HIT → POP/BIG → BUFF → PICKAXE_END(+BIG_PAYOUT) → WIN → SKY.
export const FeedEventKind = z.enum(["POP", "BIG_POP", "BIG_PAYOUT", "QUEUE_SPAWN", "PICKAXE_END", "SKY_DROP", "SKY_CATCH", "LAST_HIT", "LUCKY_PICK", "JACKPOT", "WIN", "BUFF"]);
export type FeedEventKind = z.infer<typeof FeedEventKind>;

/** (규칙 11) LUCKY 버프 종류 (카탈로그 BuffSpec.kind와 같은 이름). */
export const BuffKindSchema = z.enum(["GIANT", "DASH", "SPEED", "LIFE"]);
/** (규칙 11) PickaxeLiveState.buffMask 비트 — 지금 켜진 버프. DASH는 순간이라 비트 없음(사건만). */
export const BUFF_MASK = { GIANT: 1, SPEED: 2, LIFE: 4 } as const;

/**
 * 피드 사건 1건. 방 안 모든 사람에게 즉시(`feed.event`), 그리고 전체 티커(`GET /feed/global`)로 나간다.
 *  - seq: 방 안에서 1씩 느는 순번 (재접속 때 빠진 것 채우기·중복 제거). 전체 티커의 순서는 (blockNumber, roomId, seq)
 *  - amountMilli: 이번 사건으로 실제 들어간 밀리크레딧(상한 적용 후). QUEUE_SPAWN은 0, PICKAXE_END·BIG_PAYOUT은 끝 정산 payout(초과분은 overMilli)
 *  - streakCount: 그 순간의 같은 종류 연속 길이(POP = 2, BIG_POP = 3, 규칙 11 COMBO는 s). 연속과 무관한 사건은 0
 */
export const FeedEvent = z.object({
  seq: z.number().int().nonnegative(),
  kind: FeedEventKind,
  roomId: U32,
  playerShortId: PlayerShortId,
  itemKey: z.string().min(1),
  tier: z.number().int().nonnegative(),
  amountMilli: z.number().int().nonnegative(),
  streakCount: z.number().int().nonnegative(),
  endReason: EndReason.nullable(),             // PICKAXE_END·BIG_PAYOUT일 때만
  overMilli: z.number().int().nonnegative().optional(),   // PICKAXE_END·BIG_PAYOUT일 때만 (규칙 7 초과분, 0 포함)
  tick: z.number().int().nonnegative(),
  blockNumber: BlockNumber,                    // 사건이 난 윈도(확정 블록 번호)
  skyId: U32.optional(),                       // SKY_DROP·SKY_CATCH일 때만 (D125) — 별 id = 떨어진 윈도 번호
  multBps: z.number().int().positive().optional(),          // (규칙 10) LUCKY_PICK(단계 > 10,000)·WIN(≥ WIN_FEED_MIN_BPS)일 때만
  causes: z.number().int().min(0).max(WIN_CAUSE_ALL).optional(),   // (규칙 10) WIN일 때만 — WIN_CAUSE 비트
  poolAfterMilli: z.number().int().nonnegative().optional(),   // (규칙 10) JACKPOT일 때만 — 균열 뒤 통
  cellX: z.number().int().nonnegative().optional(),            // (규칙 10) JACKPOT — 깨진 골든 CHOG 칸 · (규칙 12) BUFF — 마지막으로 맞힌 칸
  cellY: z.number().int().nonnegative().optional(),
  buffKind: BuffKindSchema.optional(),                         // (규칙 11) BUFF일 때만
}).strict().superRefine((e, ctx) => {
  const sky = e.kind === "SKY_DROP" || e.kind === "SKY_CATCH";
  if (sky !== (e.skyId !== undefined)) ctx.addIssue({ code: "custom", message: "skyId is set exactly when kind = SKY_DROP | SKY_CATCH" });
  const ends = e.kind === "PICKAXE_END" || e.kind === "BIG_PAYOUT" || e.kind === "WIN";
  if (ends !== (e.endReason !== null)) ctx.addIssue({ code: "custom", message: "endReason is set exactly when kind = PICKAXE_END | BIG_PAYOUT | WIN" });
  if (ends !== (e.overMilli !== undefined)) ctx.addIssue({ code: "custom", message: "overMilli is set exactly when kind = PICKAXE_END | BIG_PAYOUT | WIN" });
  const mult = e.kind === "LUCKY_PICK" || e.kind === "WIN";
  if (mult !== (e.multBps !== undefined)) ctx.addIssue({ code: "custom", message: "multBps is set exactly when kind = LUCKY_PICK | WIN" });
  if (e.kind === "LUCKY_PICK" && e.multBps !== undefined && e.multBps <= 10_000) ctx.addIssue({ code: "custom", message: "LUCKY_PICK multBps must be > 10,000" });
  if (e.kind === "WIN" && e.multBps !== undefined && e.multBps < WIN_FEED_MIN_BPS) ctx.addIssue({ code: "custom", message: `WIN multBps must be ≥ WIN_FEED_MIN_BPS (${WIN_FEED_MIN_BPS})` });
  if ((e.kind === "WIN") !== (e.causes !== undefined)) ctx.addIssue({ code: "custom", message: "causes is set exactly when kind = WIN" });
  const jp = e.kind === "JACKPOT";
  if (jp !== (e.poolAfterMilli !== undefined)) ctx.addIssue({ code: "custom", message: "poolAfterMilli is set exactly when kind = JACKPOT" });
  const cell = jp || e.kind === "BUFF";
  for (const k of ["cellX", "cellY"] as const) {
    if (cell !== (e[k] !== undefined)) ctx.addIssue({ code: "custom", message: `${k} is set exactly when kind = JACKPOT or BUFF` });
  }
  if ((e.kind === "BUFF") !== (e.buffKind !== undefined)) ctx.addIssue({ code: "custom", message: "buffKind is set exactly when kind = BUFF" });
});
export type FeedEvent = z.infer<typeof FeedEvent>;

// ── 대기열 ──────────────────────────────────────────────────────────────────

export const QueueItemView = z.object({
  itemKey: z.string().min(1),
  tier: z.number().int().nonnegative(),
  priceMilli: z.number().int().positive(),
}).strict();
export type QueueItemView = z.infer<typeof QueueItemView>;

/**
 * 한 플레이어의 대기열 (방마다). 살아 있는 곡괭이는 최대 1개(activeItemKey), 나머지는 items 순서대로 나온다.
 * 다음 곡괭이는 앞 곡괭이가 끝난 윈도 + 1(nextSpawnWindow)부터 스폰된다.
 */
export const QueueState = z.object({
  roomId: U32,
  playerShortId: PlayerShortId,
  activeItemKey: z.string().min(1).nullable(),
  items: z.array(QueueItemView),
  queueMax: z.number().int().positive(),
  nextSpawnWindow: BlockNumber,
}).strict().refine((q) => q.items.length <= q.queueMax, { message: "items.length must be ≤ queueMax" });
export type QueueState = z.infer<typeof QueueState>;

// ── 살아 있는 곡괭이 ────────────────────────────────────────────────────────

/** 클라이언트가 볼 수 있는 곡괭이 값. 속도·이월·닿은 칸 목록 같은 서버 전용 값은 없다. 봇은 playerShortId = null. */
export const PickaxeLiveState = z.object({
  itemKey: z.string().min(1),
  playerShortId: PlayerShortId.nullable(),
  tier: z.number().int().nonnegative(),
  x: z.number().finite(),
  y: z.number().finite(),
  angle: z.number().finite(),
  scale: z.number().positive(),
  durabilityLeftBps: z.number().int().min(0).max(10000),   // 남은 내구도 / D × 10,000 (내림). 봇은 10,000
  earnedMilli: z.number().int().nonnegative(),             // 지금까지 번 것 (기본 + LUCKY + 보너스 + 막타, 규칙 9)
  bonusMilli: z.number().int().nonnegative(),
  /** LUCKY 종류 (규칙 7): 스폰 때 정해져 보인다. 이 종류에 준 피해 1당 share_t ÷ odds × m × 가격 ÷ D를 더 받는다. 봇은 −1 */
  luckyKind: z.number().int().min(-1),
  /** (규칙 12 개정 2) LUCKY 배수 m (bps, 10,000 = ×1): 스폰 때 `luckymult|<키>`로 뽑혀 보인다. 봇·스폰 전 0 */
  luckyMultBps: z.number().int().nonnegative(),
  streakCount: z.number().int().nonnegative(),             // 지금 같은 종류 새 블록 연속 길이
  /**
   * POP 목표 (화면 안내만, 2026-10-10): 다음에 "처음 맞히면" POP이 되는 블록 종류 = 엔진 popPrevKind(직전 새 블록의 종류).
   * −1 = 아직 새 블록을 맞히지 않았거나, POP을 이미 받았거나(곡괭이당 1번), 봇. 규칙·정산과 무관(엔진 상태를 그대로 보일 뿐)
   */
  popTargetKind: z.number().int().min(-1),
  /** (규칙 10) LUCKY PICK 단계 (multBps, 0 = 없음 · 봇 0). 소환 때 정해져 보인다 — 끝날 때 최소 가격 × 이 배수를 받는다 */
  pickLevelBps: z.number().int().nonnegative(),
  /** (규칙 10) 이 곡괭이가 받은 골든 CHOG 잭팟 (밀리, 0 = 없음) */
  jackpotMilli: z.number().int().nonnegative(),
  /** (규칙 11) 성장 단계 (COMBO마다 +1, ≤ buffs.growMaxStacks · 봇 0) */
  popStacks: z.number().int().min(0).max(8),
  /** (규칙 11) 지금 켜진 버프 비트 (BUFF_MASK: GIANT 1 · SPEED 2 · LIFE 4 · 봇 0) */
  buffMask: z.number().int().min(0).max(7),
}).strict();
export type PickaxeLiveState = z.infer<typeof PickaxeLiveState>;

// ── 생존 신호 ───────────────────────────────────────────────────────────────

/**
 * 화면 상태 (설계 §5.1~5.3, docs/INTERFACES.md §6).
 *  NORMAL: 정상 / DEGRADED: 지연(배너, 크레딧 구매·의향서 막음) / FROZEN: 판매 중지 또는 방 동결 / REFUND_AVAILABLE: 내 무효 구매 환불 가능
 */
export const LivenessStatus = z.enum(["NORMAL", "DEGRADED", "FROZEN", "REFUND_AVAILABLE"]);
export type LivenessStatus = z.infer<typeof LivenessStatus>;

/** 서버가 `liveness` 메시지로 1초마다 보내는 값. 클라이언트는 공개 RPC의 확정 블록과 체인 앵커로 직접 다시 확인한다. */
export const LivenessSignal = z.object({
  roomId: U32,
  serverStatus: LivenessStatus,                 // 서버가 스스로 판단한 상태 (클라이언트는 자기 판단과 더 나쁜 쪽을 쓴다)
  processedBlock: BlockNumber,                  // 방이 처리한 마지막 윈도 (L2)
  roomTick: z.number().int().nonnegative(),     // L4: 9 × 활성 윈도 수
  activeWindows: z.number().int().nonnegative(),
  anchoredThrough: BlockNumber,                 // 마지막 앵커의 처리 완료 블록 P (L5)
  salesOpen: z.boolean(),
  salesHold: z.boolean(),                       // settler 판매 보류(exception_event HOLD:settle·HOLD:runway)가 열려 있음 → salesOpen = false
  exceptions: z.array(ExceptionCode),           // 지금 열린 예외
}).strict();
export type LivenessSignal = z.infer<typeof LivenessSignal>;
