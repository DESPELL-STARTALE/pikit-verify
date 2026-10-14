import { GRANT_MAX_MILLI, MAX_INPUTS_PER_ROOM_WINDOW, MAX_INTENT_ITEMS, utcDayOf } from "@pikit/protocol";
import type { CancelRecord, LedgerDecision, LedgerListEntry, LedgerRejectReason, PayoutLeaf, PurchaseRecord } from "@pikit/protocol";
import type { EnginePayout } from "@pikit/engine";
import type { EntryAuth } from "./auth.js";
import { roomOf, type LedgerContext } from "./context.js";
import type { LedgerListLike } from "./list.js";
import { LedgerInvariantError, type LedgerState } from "./state.js";

// ──────────────────────────────────────────────────────────────────────────
// 윈도 w 장부 전이 (ledgerHash 안, 계획 §2.4, D199). game-server와 검증기가 **같은 함수**를 쓴다.
//
// 명단 w의 항목을 순서대로, 항목마다 결정 하나:
//   GRANT   GRANT_TOO_LARGE (0 또는 > GRANT_MAX_MILLI) → GRANT_DAY (day ∉ [blockDay − 1, blockDay], blockDay = floor(ts(w) ÷ 86,400) UTC)
//           → GRANT_ALREADY (day ≤ lastGrantDay) → balance += amount, lastGrantDay = day.   seq와 상관없다.
//   BUY     ── seq를 소비하지 않는 거절 (의향서가 이 창에 유효하지 않다 — 서버가 남의 seq를 태울 수 없게):
//             BAD_SIGNATURE → SESSION_MISSING → SESSION_EXPIRED (ts(w) > expiresAt) → TARGET_MISMATCH (targetWindow ≠ w) → SEQ_USED (seq ≤ lastSeq)
//           ── 여기서 lastSeq = seq (소비). 아래 거절도 seq는 소비된 채 남는다 (계획 §2.3 "서명·세션이 맞고 seq > lastSeq면 소비"):
//             UNKNOWN_ROOM (목록에 없음 · createdWindow ≥ w) → RULES_MISMATCH → BAD_TIERS (1 ≤ n ≤ min(10, maxTiersPerBuy), 모두 카탈로그 안)
//             → ROOM_WINDOW_FULL (이 방 이번 윈도 입력 + 1 > 100) → INSUFFICIENT_CREDITS (가격 > balance)
//           → balance −= 가격, openStake += 가격, purchaseId = nextPurchaseId++ → PurchaseRecord
//   CANCEL  BUY와 같은 인증·seq 순서, 그 뒤 UNKNOWN_ROOM → BAD_TIERS (1~10개, 항목 번호 ≤ 9, 겹침 없음) → ROOM_WINDOW_FULL (items 수만큼)
//           → CancelRecord (잔액은 그대로 — 엔진이 대기 중인 칸만 REFUND 정산을 내고 applyPayouts가 돌려준다)
// 거절은 상태를 바꾸지 않는다(seq 소비만 예외). 엔진 기록: 블록 = w − 1, 로그 번호 = 명단 순번, tx = 의향서 다이제스트(ref).
// 정산(applyPayouts): 엔진 EnginePayout마다 openStake −= price, balance += payout + over → 지급 잎.
// ──────────────────────────────────────────────────────────────────────────

/** 명단 하나를 적용한 결과. purchases·cancels = 받은 항목의 엔진 기록 (명단 순서). */
export interface WindowApplication {
  window: number;
  decisions: LedgerDecision[];
  purchases: PurchaseRecord[];
  cancels: CancelRecord[];
  /** 이 명단의 받은 GRANT 합 (공급 불변식). */
  grantedMilli: bigint;
}

const applied = (purchaseId: bigint | null = null): LedgerDecision => ({ status: "APPLIED", reason: null, purchaseId: purchaseId === null ? null : purchaseId.toString() });
const rejected = (reason: LedgerRejectReason): LedgerDecision => ({ status: "REJECTED", reason, purchaseId: null });

/** 의향서의 가격(밀리) 또는 null(등급이 틀림). 엔진 purchase와 같은 판정: 개수 ≤ maxTiersPerBuy, 모든 등급이 카탈로그에 있음. */
export function intentPriceMilli(ctx: LedgerContext, roomId: number, tiers: readonly number[]): bigint | null {
  const room = roomOf(ctx, roomId);
  if (!room) return null;
  const max = Math.min(MAX_INTENT_ITEMS, room.catalog.limits.maxTiersPerBuy);
  if (tiers.length < 1 || tiers.length > max) return null;
  let sum = 0n;
  for (const t of tiers) {
    const p = Number.isInteger(t) && t >= 0 ? room.catalog.pickaxes[t] : undefined;
    if (!p) return null;
    sum += BigInt(p.priceCredits) * 1000n;
  }
  return sum;
}

/** 취소 항목 형식: 1~10개, 10진 정수, 항목 번호(하위 8비트) ≤ 9, 겹침 없음. */
function cancelItemsOk(items: readonly string[]): boolean {
  if (items.length < 1 || items.length > MAX_INTENT_ITEMS) return false;
  const seen = new Set<string>();
  for (const s of items) {
    if (!/^(0|[1-9][0-9]*)$/.test(s)) return false;
    const id = BigInt(s);
    if ((id & 0xffn) > 9n || seen.has(s)) return false;
    seen.add(s);
  }
  return true;
}

/**
 * 명단 w를 상태에 적용한다(상태를 그 자리에서 고친다). auth[i] = authenticateEntries의 결과(항목 순서), blockTimestamp = 블록 w의 timestamp(unix 초).
 * 명단 모양(checkListStructure)은 부르는 쪽이 먼저 확인한다.
 */
export function applyWindowList(
  state: LedgerState, ctx: LedgerContext, list: LedgerListLike, auth: readonly EntryAuth[], blockTimestamp: number,
): WindowApplication {
  const w = list.window;
  if (auth.length !== list.entries.length) throw new LedgerInvariantError(`list ${w}: ${auth.length} auth results for ${list.entries.length} entries`);
  if (!Number.isSafeInteger(blockTimestamp) || blockTimestamp < 0) throw new LedgerInvariantError(`list ${w}: bad block timestamp ${blockTimestamp}`);
  const ts = BigInt(blockTimestamp);
  const blockDay = utcDayOf(blockTimestamp);
  const roomInputs = new Map<number, number>();
  const out: WindowApplication = { window: w, decisions: [], purchases: [], cancels: [], grantedMilli: 0n };

  list.entries.forEach((e: LedgerListEntry, index) => {
    const decide = (d: LedgerDecision) => { out.decisions.push(d); };
    if (e.kind === "GRANT") {
      const amount = BigInt(e.grant.amountMilli);
      if (amount === 0n || amount > GRANT_MAX_MILLI) return decide(rejected("GRANT_TOO_LARGE"));
      if (e.grant.day < blockDay - 1 || e.grant.day > blockDay) return decide(rejected("GRANT_DAY"));
      if (e.grant.day <= state.get(e.grant.wallet).lastGrantDay) return decide(rejected("GRANT_ALREADY"));
      const a = state.account(e.grant.wallet);
      a.balanceMilli += amount;
      a.lastGrantDay = e.grant.day;
      out.grantedMilli += amount;
      return decide(applied());
    }

    const a0 = auth[index];
    if (a0 === null || a0 === undefined) throw new LedgerInvariantError(`list ${w} entry ${index}: ${e.kind} without auth`);
    const intent = e.intent;
    if (!a0.signatureOk) return decide(rejected("BAD_SIGNATURE"));
    if (a0.sessionExpiresAt === null) return decide(rejected("SESSION_MISSING"));
    if (ts > a0.sessionExpiresAt) return decide(rejected("SESSION_EXPIRED"));
    if (intent.targetWindow !== w) return decide(rejected("TARGET_MISMATCH"));
    const seq = BigInt(intent.seq);
    if (seq <= state.get(intent.wallet).lastSeq) return decide(rejected("SEQ_USED"));
    const acct = state.account(intent.wallet);
    acct.lastSeq = seq;   // 소비 — 아래 거절도 seq는 그대로 쓴 것

    const room = roomOf(ctx, intent.roomId);
    if (!room || room.createdWindow >= w) return decide(rejected("UNKNOWN_ROOM"));
    const used = roomInputs.get(room.roomId) ?? 0;
    const link = { roomId: room.roomId, blockNumber: w - 1, logIndex: index, txHash: e.ref.toLowerCase() };

    if (e.kind === "BUY") {
      if (e.intent.rulesHash.toLowerCase() !== room.rulesHash.toLowerCase()) return decide(rejected("RULES_MISMATCH"));
      const price = intentPriceMilli(ctx, room.roomId, e.intent.tiers);
      if (price === null) return decide(rejected("BAD_TIERS"));
      if (used + 1 > MAX_INPUTS_PER_ROOM_WINDOW) return decide(rejected("ROOM_WINDOW_FULL"));
      if (price > acct.balanceMilli) return decide(rejected("INSUFFICIENT_CREDITS"));
      acct.balanceMilli -= price;
      acct.openStakeMilli += price;
      const purchaseId = state.nextPurchaseId;
      state.nextPurchaseId += 1n;
      roomInputs.set(room.roomId, used + 1);
      out.purchases.push({
        purchaseId: purchaseId.toString(), buyer: intent.wallet.toLowerCase(), rulesHash: e.intent.rulesHash.toLowerCase(), tiers: [...e.intent.tiers], ...link,
      });
      return decide(applied(purchaseId));
    }

    if (!cancelItemsOk(e.intent.items)) return decide(rejected("BAD_TIERS"));
    if (used + e.intent.items.length > MAX_INPUTS_PER_ROOM_WINDOW) return decide(rejected("ROOM_WINDOW_FULL"));
    roomInputs.set(room.roomId, used + e.intent.items.length);
    out.cancels.push({ wallet: intent.wallet.toLowerCase(), items: [...e.intent.items], ...link });
    return decide(applied());
  });
  return out;
}

/** 엔진 정산 하나 (방 + EnginePayout). runWorldWindow 결과의 rooms[].result.payouts를 그대로 넘긴다. */
export interface RoomPayout {
  roomId: number;
  payout: EnginePayout;
}

/** 지급 잎 (엔진 정산 → 루트 payoutsRoot 재료). */
export function payoutLeafOf(p: EnginePayout): PayoutLeaf {
  const m = /^(0|[1-9][0-9]*):([0-9])$/.exec(p.key);
  if (!m) throw new LedgerInvariantError(`payout key ${p.key} is not "<purchaseId>:<itemIndex>"`);
  return {
    purchaseId: m[1]!, itemIndex: Number(m[2]), owner: p.owner.toLowerCase(), kind: p.kind, cause: p.cause,
    priceMilli: String(p.priceMilli), payoutMilli: String(p.payoutMilli), overMilli: String(p.overMilli), window: p.window,
  };
}

/**
 * 엔진 정산을 장부에 (생긴 순서). 곡괭이마다 openStake −= price, balance += payout + over. 지급 잎을 돌려준다.
 * openStake가 모자라면(엔진과 장부가 어긋남) LedgerInvariantError — 결정이 아니라 재생 실패다.
 */
export function applyPayouts(state: LedgerState, payouts: readonly RoomPayout[]): PayoutLeaf[] {
  const leaves: PayoutLeaf[] = [];
  for (const { payout: p } of payouts) {
    for (const [name, v] of [["priceMilli", p.priceMilli], ["payoutMilli", p.payoutMilli], ["overMilli", p.overMilli]] as const) {
      if (!Number.isSafeInteger(v) || v < 0) throw new LedgerInvariantError(`payout ${p.key}: bad ${name} ${v}`);
    }
    const a = state.get(p.owner);
    const price = BigInt(p.priceMilli);
    if (a.openStakeMilli < price) throw new LedgerInvariantError(`payout ${p.key}: ${p.owner} open stake ${a.openStakeMilli} < price ${price}`);
    const acct = state.account(p.owner);
    acct.openStakeMilli -= price;
    acct.balanceMilli += BigInt(p.payoutMilli) + BigInt(p.overMilli);
    leaves.push(payoutLeafOf(p));
  }
  return leaves;
}
