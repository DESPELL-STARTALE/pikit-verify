import type { EnginePayout } from "@pikit/engine";
import { SETTLE_STALL, type SettlementRecord } from "@pikit/protocol";
import type { VoidOverPaidRecord } from "./chain.js";

// ──────────────────────────────────────────────────────────────────────────
// 정산 대조 (개정 3, D82·D93, 규칙 7 D137 §10): 체인 `Settled`(settleEnd) ↔ 재생한 엔진 정산 값, 곡괭이마다 한 칸.
//
// 체인(PikitShop.settleEnd)이 강제하는 것 — 검증기가 다시 볼 필요는 없지만 깨지면 체인이 거부한다:
//   - REWARD payoutMilli ≤ 등급 상한 tierCapsMilli (= engine rewardCapMilli = 가격 × rewardCapBps), REFUND ≤ 그 곡괭이 가격
//   - overMilli ≤ 등급 over 상한 tierOverCapsMilli (= engine overCapMilli), over > 0이면 kind = REWARD, 시간당 over 한도
//   - 곡괭이(purchaseId, itemIndex)마다 settleEnd 1번 (kind + payout + over가 한 호출 — "끝은 보내고 큰 지급만 안 보내기"가 불가능, 감사 F-1 ①)
//   - Pending·Processed 구매만 정산 가능(D93: 곡괭이가 끝나자마자 앵커를 기다리지 않고 보낸다) — Void·Refunded는 거부.
//     정산이 하나도 없는 Void 구매는 refundUnprocessed가 가격 100%, 정산된 곡괭이가 있으면 나머지는 settleTimeout 뒤 refundUnsettled
// 검증기가 여기서 확인하는 것 — 체인은 알 수 없는 "정확한 값"과 "빠진 지급" (모두 실패 E12, §10):
//   - 체인 정산마다 같은 곡괭이의 재생 정산이 있고 kind·payoutMilli·overMilli(0 포함)·지갑이 정확히 같다 (KIND·AMOUNT·BUYER).
//     재생이 정상 종료(REWARD)인데 체인이 REFUND로 닫은 것(§10-4)은 KIND
//   - 재생에서 정산이 없는 곡괭이(VOID로 없어진 것, 아직 안 끝난 것, 없는 항목)에 체인 정산이 있으면 NOT_PAID·VOID_PURCHASE
//   - 시한 지난 미지급(§10-2, OVERDUE): 재생 정산(끝 윈도 w)이 있는데 체인 값이 빠짐없이 담은 마지막 블록이 w + SETTLE_STALL을 넘도록
//     settleEnd가 없다 (무효 구매 제외 — 아래). 정산 시한 뒤 refundUnsettled로 닫힌 정상 종료(§10-4)도 여기서 잡힌다
//   - 무효로 사라진 큰 지급(§10-3, VOID_OVER): 무효 구매(voidPurchase)의 곡괭이가 그 전에 정상 종료해 over > 0인데 settleEnd도
//     VoidOverPaid(개정 6 payOverAfterVoid — 무효 환불 100%와 별도로 over를 준다)도 없이 max(끝 윈도, 무효 블록) + SETTLE_STALL이 지났다.
//     VoidOverPaid가 있으면 over·지갑이 재생 값과 같아야 하고(VOID_OVER_AMOUNT), 그런 곡괭이가 아닌데 있으면 VOID_OVER_EXTRA
//   - 재생 정산이 있고 그 구매가 처리된 앵커에 덮였는데 체인 정산이 아직 없고 시한 전이면 "unsettled" (경고 — settler가 늦을 수 있다)
//   - 무효 구매의 나머지 미정산 곡괭이(over 0)는 경고도 실패도 아니다 — 환불 100% ≥ 정산 값
// 정확한 값은 결정론 재생만이 정한다: 같은 입력 기록 + 시드 + 블록 해시면 누구나 같은 payoutMilli를 얻는다.
// ──────────────────────────────────────────────────────────────────────────

/** 재생에서 나온 정산 1건 (엔진 EnginePayout + 방 번호 + 키에서 읽은 구매 번호·항목 순번). */
export interface ReplayPayout extends EnginePayout {
  roomId: number;
  purchaseId: string;   // 10진 문자열 (체인 purchaseId)
  itemIndex: number;
}

/** 곡괭이 키 "<purchaseId>:<itemIndex>"를 나눈다. 형식이 틀리면 오류(체인 구매가 아닌 키). */
export function parseItemKey(key: string): { purchaseId: string; itemIndex: number } {
  const m = /^(0|[1-9][0-9]*):([0-9])$/.exec(key);
  if (!m) throw new Error(`not an on-chain item key: ${key}`);
  return { purchaseId: m[1]!, itemIndex: Number(m[2]) };
}

export function replayPayout(roomId: number, p: EnginePayout): ReplayPayout {
  return { ...p, roomId, ...parseItemKey(p.key) };
}

export type SettlementMismatchReason =
  | "AMOUNT"          // payoutMilli 또는 overMilli가 재생 값과 다름 (over > 0을 0으로 보고한 것 포함)
  | "KIND"            // REWARD/REFUND가 다름 (재생 정상 종료를 체인이 REFUND로 닫음, §10-4)
  | "BUYER"           // 지갑이 다름
  | "NOT_PAID"        // 재생에서 그 곡괭이에 정산이 없음 (VOID·진행 중·없는 항목)
  | "VOID_PURCHASE"   // 엔진이 무효로 없앤 구매의, 재생 정산이 없는 곡괭이에 체인 정산
  | "DUPLICATE"       // 같은 곡괭이에 체인 정산이 두 번 이상
  | "OVERDUE"         // 재생 정산이 있는데 끝 윈도 + SETTLE_STALL이 지나도록 settleEnd가 없음 (§10-2)
  | "VOID_OVER"       // 무효 구매의 정상 종료(over > 0)에 settleEnd도 VoidOverPaid도 없이 시한(max(끝, 무효 블록) + SETTLE_STALL)이 지남 (§10-3)
  | "VOID_OVER_AMOUNT"// VoidOverPaid의 over·지갑이 재생 값과 다름
  | "VOID_OVER_EXTRA";// 재생에 "무효 구매의 정상 종료 over > 0"이 없는 곡괭이에 VoidOverPaid (또는 두 번)

export interface SettlementMismatch {
  code: "E12";
  key: string;
  reason: SettlementMismatchReason;
  onchain: SettlementRecord | VoidOverPaidRecord | null;   // OVERDUE·VOID_OVER는 체인 기록이 없어 null
  replayed: { kind: EnginePayout["kind"]; payoutMilli: number; overMilli: number; owner: string; window: number } | null;
}

export interface SettlementReport {
  checked: number;                    // 대조한 체인 정산 + VoidOverPaid 수 (범위 밖 제외)
  matched: number;
  mismatches: SettlementMismatch[];   // 실패 (E12)
  unsettled: ReplayPayout[];          // 경고: 재생 정산인데 체인 기록이 아직 없음 (시한 전)
  skipped: number;                    // 재생 범위 밖(뒤 또는 스냅숏 앞)의 곡괭이라 대조하지 않은 체인 기록
}

export interface CheckSettlementsOptions {
  /** 처리된 구매 경계: purchaseId < 이 값이면 앵커가 덮은 구매 (가장 최근 앵커의 processedPurchases). 없으면 시한 전 미정산을 경고로 내지 않는다. */
  processedPurchases?: number | bigint;
  /** 재생한 마지막 윈도. 이보다 뒤 블록에 실린 체인 기록은 재생 범위 밖일 수 있어 건너뛴다. 없으면 모두 대조한다. */
  throughBlock?: number;
  /** 체인 기록을 빠짐없이 담은 마지막 블록 (체인 값 throughBlock). 있으면 시한이 이 값보다 앞인 미지급을 실패로. */
  chainThroughBlock?: number;
  /**
   * 엔진이 voidPurchase로 없앤 구매 번호들. 무효 전에 끝난 곡괭이의 재생 정산은 그대로 대조하고(앵커 전 정산, D93),
   * 재생 정산이 없는 곡괭이의 체인 정산은 VOID_PURCHASE 실패. 체인 settleEnd가 없는 재생 정산은 over > 0이면 VoidOverPaid로 대조
   * (없이 시한이 지나면 VOID_OVER), 아니면 아무것도 아님(나머지는 환불 100%).
   */
  voidedPurchases?: Iterable<string>;
  /** 무효 구매 → 그 구매를 무효로 한 PurchasesVoided의 블록 (무효 over 시한 = max(끝 윈도, 이 블록) + SETTLE_STALL). */
  voidBlocks?: ReadonlyMap<string, number>;
  /** 체인 VoidOverPaid (개정 6 payOverAfterVoid). */
  voidOverPaid?: readonly VoidOverPaidRecord[];
  /**
   * 스냅숏 시작: 재생 범위 앞에서 끝난 곡괭이의 체인 기록은 대조하지 않는다(skipped) — purchaseId < processedPurchases(믿는 앵커가 덮은 구매)이고
   * 스냅숏 세계에서 살아 있거나 대기열에 있던 곡괭이(alive)가 아닌 것. 그 밖의 곡괭이는 재생 정산이 있어야 한다.
   */
  before?: { processedPurchases: number | bigint; alive: ReadonlySet<string> };
}

/**
 * 체인 정산을 재생 정산과 곡괭이마다 한 칸으로 대조한다. replayed는 재생 순서 그대로(곡괭이마다 최대 1건 — 엔진 불변식).
 * 결과의 mismatches가 비어 있으면 통과. unsettled는 실패가 아니다.
 */
export function checkSettlements(
  replayed: readonly ReplayPayout[], onchain: readonly SettlementRecord[], opts: CheckSettlementsOptions = {},
): SettlementReport {
  const byKey = new Map<string, ReplayPayout>();
  for (const p of replayed) {
    if (byKey.has(p.key)) throw new Error(`checkSettlements: replay produced two payouts for ${p.key}`);
    byKey.set(p.key, p);
  }
  const voided = new Set(opts.voidedPurchases ?? []);
  const seen = new Set<string>();
  const report: SettlementReport = { checked: 0, matched: 0, mismatches: [], unsettled: [], skipped: 0 };
  const view = (p: ReplayPayout | undefined) => (p ? { kind: p.kind, payoutMilli: p.payoutMilli, overMilli: p.overMilli, owner: p.owner, window: p.window } : null);
  const beforeBound = opts.before === undefined ? undefined : BigInt(opts.before.processedPurchases);
  /** 재생 범위 밖의 곡괭이 기록 (뒤: 범위 뒤 블록에 실림, 앞: 스냅숏 앞에서 끝남). */
  const outside = (key: string, purchaseId: string, blockNumber: number) =>
    (opts.throughBlock !== undefined && blockNumber > opts.throughBlock)
    || (beforeBound !== undefined && BigInt(purchaseId) < beforeBound && !opts.before!.alive.has(key));

  for (const s of onchain) {
    const key = `${s.purchaseId}:${s.itemIndex}`;
    const p = byKey.get(key);
    if (!p && outside(key, s.purchaseId, s.blockNumber)) { report.skipped += 1; continue; }
    report.checked += 1;
    const fail = (reason: SettlementMismatchReason) => report.mismatches.push({ code: "E12", key, reason, onchain: s, replayed: view(p) });
    if (seen.has(key)) { fail("DUPLICATE"); continue; }
    seen.add(key);
    if (!p) { fail(voided.has(s.purchaseId) ? "VOID_PURCHASE" : "NOT_PAID"); continue; }
    if (p.kind !== s.kind) { fail("KIND"); continue; }
    if (BigInt(p.payoutMilli) !== BigInt(s.payoutMilli) || BigInt(p.overMilli) !== BigInt(s.overMilli)) { fail("AMOUNT"); continue; }
    if (p.owner.toLowerCase() !== s.buyer.toLowerCase()) { fail("BUYER"); continue; }
    report.matched += 1;
  }

  // VoidOverPaid ↔ "무효 구매의, settleEnd 없는 정상 종료 over > 0"
  const voidOverDue = new Map<string, ReplayPayout>();
  for (const p of replayed) if (!seen.has(p.key) && voided.has(p.purchaseId) && p.overMilli > 0) voidOverDue.set(p.key, p);
  const voidOverSeen = new Set<string>();
  for (const v of opts.voidOverPaid ?? []) {
    const key = `${v.purchaseId}:${v.itemIndex}`;
    const p = voidOverDue.get(key);
    if (!p && !byKey.has(key) && outside(key, v.purchaseId, v.blockNumber)) { report.skipped += 1; continue; }
    report.checked += 1;
    const fail = (reason: SettlementMismatchReason) => report.mismatches.push({ code: "E12", key, reason, onchain: v, replayed: view(byKey.get(key)) });
    if (!p || voidOverSeen.has(key)) { fail("VOID_OVER_EXTRA"); continue; }
    voidOverSeen.add(key);
    if (BigInt(p.overMilli) !== BigInt(v.overMilli) || p.owner.toLowerCase() !== v.buyer.toLowerCase()) { fail("VOID_OVER_AMOUNT"); continue; }
    report.matched += 1;
  }

  // 체인 기록이 없는 재생 정산: 시한이 지났으면 실패, 아니면 (처리된 구매면) 경고
  const bound = opts.processedPurchases === undefined ? undefined : BigInt(opts.processedPurchases);
  const due = (deadline: number) => opts.chainThroughBlock !== undefined && opts.chainThroughBlock > deadline;
  for (const p of replayed) {
    if (seen.has(p.key) || voidOverSeen.has(p.key)) continue;
    const missing = (reason: SettlementMismatchReason) => report.mismatches.push({ code: "E12", key: p.key, reason, onchain: null, replayed: view(p) });
    if (voided.has(p.purchaseId)) {
      if (p.overMilli <= 0) continue;
      if (due(Math.max(p.window, opts.voidBlocks?.get(p.purchaseId) ?? p.window) + SETTLE_STALL)) missing("VOID_OVER");
      else report.unsettled.push(p);
      continue;
    }
    if (due(p.window + SETTLE_STALL)) { missing("OVERDUE"); continue; }
    if (bound !== undefined && BigInt(p.purchaseId) < bound) report.unsettled.push(p);
  }
  return report;
}

/** 실패 한 줄: "<곡괭이> <이유>: chain <kind> <payout>+<over> (block b) vs replay <kind> <payout>+<over> (window w)". */
export function describeSettlementMismatch(m: SettlementMismatch): string {
  const o = m.onchain;
  const chain = o === null ? "none" : "kind" in o ? `${o.kind} ${o.payoutMilli}+${o.overMilli} (block ${o.blockNumber})` : `VoidOverPaid ${o.overMilli} (block ${o.blockNumber})`;
  const replay = m.replayed ? `${m.replayed.kind} ${m.replayed.payoutMilli}+${m.replayed.overMilli} (window ${m.replayed.window})` : "none";
  return `${m.key} ${m.reason}: chain ${chain} vs replay ${replay}`;
}
