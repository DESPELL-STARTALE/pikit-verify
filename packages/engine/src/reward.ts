import {
  catalogBaseCeilingMilli, catalogComboPrizeMilli, catalogLastHitCapMilli, catalogLastHitMilli, catalogOverCapMilli, catalogPickFloorMilli,
  catalogRewardCapMilli, catalogPickLevelBps, catalogTotalCapMilli, luckyPoolCount, type Catalog,
} from "@pikit/protocol";
import type { Rng } from "./rng.js";
import type { BlockState, BonusEvent, PickaxeState } from "./types.js";

// ──────────────────────────────────────────────────────────────────────────
// 보상 (규칙 7, D137 — docs/specs/16-rules7.md §4·§8.2·§8.3, 규칙 9 — 명세 22). 곡괭이 1개 = 아래 넷의 합 E:
//  1) 기본 수익: β_t × blocks[k].value × 유효 피해 × 1000 (밀리크레딧, 버림 + 곡괭이별 이월). 블록 값 사다리는 공개(다이아 ×10 · CHOG Ore ×12 · Golden CHOG ×15, 규칙 9)
//  2) LUCKY: 판에 놓일 때 뽑은 행운 종류 X에 준 유효 피해 1당 share ÷ odds_X × 가격 ÷ D (odds_X = batchCount_X ÷ LUCKY 풀, 버림 + 이월)
//     LUCKY 풀 = luckyEligible 종류의 batchCount 합 (규칙 8: CHOG 두 종류는 뽑히지 않는다 — 명세 21)
//  3) 막타 LAST HIT (규칙 9): 한 방에 못 깨는 블록(hp_k > attack_t)을 깬 타격마다 floor(lastHitMult × β_t × value_k × attack_t × 1000),
//     곡괭이당 합 ≤ 가격 × lastHitCapBps (catalogLastHitMilli·catalogLastHitCapMilli)
//  4) 보너스: POP(새 블록 2연속 같은 종류) · BIG POP(3연속), 둘 다 곡괭이당 1번, 합 ≤ bonusCap
// 정산은 E를 REWARD(≤ 가격 × rewardCapBps)와 초과분(over)으로 나눈다(room.ts settle). 봇 타격은 아무것도 지급하지 않는다.
// (규칙 10, 명세 23 §3.2) 정산 총액 T = min(총상한, max(E, LUCKY PICK 바닥)) + 잭팟 J — settleNormal·settleAbnormal. E(earnedMilli)는 그대로다.
// (규칙 11, 명세 24 §3.5·§3.10) reward.combo가 있으면 4)는 COMBO 사다리: 같은 종류 새 블록 연속 s ≥ 2가 될 때마다 popPrize × weights[min(s − 2, 길이 − 1)]
//   (사건 POP(s = 2)·BIG_POP(s ≥ 3), streakCount = s, 곡괭이당 횟수 제한 없이 합 ≤ bonusCap). reward.wholeCredits면 정산 T_main·비정상 V·잭팟 J를
//   1,000밀리(= 1크레딧) 단위로 내린다 — 정산은 늘 정수 크레딧(T_main·V의 나머지는 하우스, J의 나머지는 통에 남는다).
// 숨은 보정(판·순간마다 바뀌는 배율)은 없다 — 모든 숫자는 카탈로그에 있다.
// ──────────────────────────────────────────────────────────────────────────

/** 곡괭이 1개의 기본 수익 천장(밀리크레딧) = floor(β_t × max(value) × D × 1000). 엔진은 이 값을 넘게 적립하지 않는다. */
export function baseCeilingMilli(catalog: Catalog, tier: number): number {
  return catalogBaseCeilingMilli(catalog, tier);
}

/** REWARD 상한(밀리크레딧) = floor(가격 × 1000 × rewardCapBps ÷ 10,000). 체인 tierCapsMilli가 이 값이다. */
export function rewardCapMilli(catalog: Catalog, tier: number): number {
  return catalogRewardCapMilli(catalog, tier);
}

/** 초과분 상한(밀리크레딧) = 기본 천장 + LUCKY 천장 + bonusCap × 1000 + 막타 상한 − REWARD 상한. 체인 tierOverCapsMilli가 이 값이다. */
export function overCapMilli(catalog: Catalog, tier: number): number {
  return catalogOverCapMilli(catalog, tier);
}

/** 등급 순서의 REWARD 상한 (배포·announceCatalog의 tierCapsMilli 인자). */
export function tierRewardCapsMilli(catalog: Catalog): number[] {
  return catalog.pickaxes.map((_, tier) => rewardCapMilli(catalog, tier));
}

/** 등급 순서의 초과분 상한 (배포·announceCatalog의 tierOverCapsMilli 인자). */
export function tierOverCapsMilli(catalog: Catalog): number[] {
  return catalog.pickaxes.map((_, tier) => overCapMilli(catalog, tier));
}

/** 그리드 칸 키 (곡괭이별 "처음 닿은 블록" 목록에 쓴다). y는 0 이상(블록은 0줄부터). */
export function cellKey(block: BlockState, worldWidth: number): number {
  return block.y * worldWidth + block.x;
}

/**
 * LUCKY 종류 뽑기: u ∈ [0, 1) 하나로 LUCKY 풀의 구성 비율대로 (index = floor(u × LUCKY 풀), 종류 번호 순으로
 * luckyEligible 종류의 batchCount를 빼며 찾음 — luckyEligible = false인 종류(규칙 8: CHOG 두 종류)는 건너뛴다).
 * 정수 비교만 — 구현마다 같은 결과.
 */
export function drawLuckyKind(catalog: Catalog, u: number): number {
  let index = Math.floor(u * luckyPoolCount(catalog));
  for (let k = 0; k < catalog.blocks.length; k++) {
    const b = catalog.blocks[k]!;
    if (!b.luckyEligible) continue;
    if (index < b.batchCount) return k;
    index -= b.batchCount;
  }
  throw new Error("drawLuckyKind: u out of range");
}

/**
 * LUCKY 지급률 (밀리크레딧 / 유효 피해 1) = share × LUCKY 풀 ÷ batchCount_X × 가격 × 1000 ÷ D.
 * 뽑힐 수 없는 종류(luckyEligible = false)·개수 0인 종류·share 0이면 0.
 */
export function luckyRateMilli(catalog: Catalog, tier: number, kind: number): number {
  const p = catalog.pickaxes[tier];
  const b = catalog.blocks[kind];
  if (!p || !b) throw new Error(`luckyRateMilli: unknown tier ${tier} or kind ${kind}`);
  if (catalog.lucky.share <= 0 || b.batchCount <= 0 || !b.luckyEligible) return 0;
  return ((((catalog.lucky.share * luckyPoolCount(catalog)) / b.batchCount) * p.priceCredits * 1000) / p.durability);
}

/** (규칙 11, 명세 24 §3.10) 밀리크레딧을 정수 크레딧으로 내림: ⌊x / 1000⌋ × 1000. */
export function wholeCreditsMilli(milli: number): number {
  return Math.floor(milli / 1000) * 1000;
}

/** (규칙 10) 스트림의 다음 수 u ∈ [0, 1)(53비트, rng.ts next()) → u × 2⁵³ (정확한 정수). LUCKY PICK·균열·(규칙 11) 버프 뽑기는 이 BigInt만 비교한다. */
export function streamU53(stream: Rng): bigint {
  return BigInt(stream.next() * 9007199254740992);
}

/**
 * (규칙 10, 명세 23 §3.1) LUCKY PICK 단계 = catalogPickLevelBps(c, u53(`pick|<키>` 첫 수), 등급). 카탈로그에 luckyPick이 없으면 0.
 * (규칙 11, 명세 24 §3.18) 사다리는 그 등급의 것 — luckyPick.byTier[tier]가 있으면 그것, 없으면 levels.
 */
export function drawPickLevelBps(catalog: Catalog, stream: Rng, tier: number): number {
  return catalogPickLevelBps(catalog, streamU53(stream), tier);
}

/** 타격이 일어난 때 (사건 기록용). */
export interface HitTime {
  window: number;
  tick: number;
}

/**
 * 플레이어 곡괭이의 타격 1건을 보상 상태에 반영한다. 반환값: 이번 타격으로 적립된 밀리크레딧(기본 + LUCKY + 막타 + 보너스).
 * destroyed = 이 타격으로 블록이 깨졌나(물리 HitEvent.destroyed) — 막타 판정에만 쓴다.
 *  1) 기본: raw = β_t × value(종류) × 유효 피해 × 1000 → 이월에 더하고 정수 부분만 적립 (올림·반올림 금지), 천장 가드
 *  2) LUCKY: 종류가 행운 종류면 raw = 지급률 × 유효 피해 → 따로 이월, 천장 가드(그 종류에 D를 모두 준 값)
 *  3) (규칙 9) 막타: destroyed이고 hp_k > attack_t(카탈로그 값)이고 lastHitMult > 0이면 상금 catalogLastHitMilli를 곡괭이당 상한 안에서 지급,
 *     lastHits += 1 (지급 0이어도). 4보다 앞 — 막타 대부분은 이미 닿은 블록의 두 번째 이상 타격이다
 *  4) 새 블록(이 곡괭이가 처음 닿은 칸)이면 같은 종류 연속 길이를 세고
 *     - POP: 직전 새 블록과 같은 종류 → 곡괭이당 1번 popPrize
 *     - BIG POP: 연속 길이가 3이 되는 순간 → 곡괭이당 1번 bigPopPrize
 *     - (규칙 11) reward.combo가 있으면 위 둘 대신 COMBO: 연속 길이 s ≥ 2가 될 때마다 catalogComboPrizeMilli(c, t, s),
 *       사건 POP(s = 2)·BIG_POP(s ≥ 3) — 횟수 제한 없음. 성장(popStacks)은 돈이 아니라 room.ts creditHits가 buffs.ts로 한다
 *  5) 보너스 합계는 bonusCap을 넘지 않는다. 사건에는 상금과 실제 지급을 함께 남긴다.
 */
export function applyHitReward(catalog: Catalog, pickaxe: PickaxeState, block: BlockState, damage: number, at: HitTime = { window: 0, tick: 0 }, destroyed = false): number {
  if (pickaxe.owner === null) return 0;
  const tier = catalog.pickaxes[pickaxe.tier];
  const kind = catalog.blocks[block.kind];
  if (!tier || !kind) throw new Error(`applyHitReward: unknown tier ${pickaxe.tier} or kind ${block.kind}`);

  // ── 1) 기본 수익
  const raw = tier.beta * kind.value * damage * 1000;
  const acc = pickaxe.carryMilli + raw;
  let whole = Math.floor(acc);
  pickaxe.carryMilli = acc - whole;
  const ceiling = baseCeilingMilli(catalog, pickaxe.tier);
  if (pickaxe.baseMilli + whole > ceiling) whole = Math.max(0, ceiling - pickaxe.baseMilli);   // 실수 누적 오차까지 막는 최후 가드
  pickaxe.baseMilli += whole;
  let credited = whole;

  // ── 2) LUCKY
  if (block.kind === pickaxe.luckyKind) {
    const rate = luckyRateMilli(catalog, pickaxe.tier, block.kind);
    if (rate > 0) {
      const lacc = pickaxe.luckyCarryMilli + rate * damage;
      let lwhole = Math.floor(lacc);
      pickaxe.luckyCarryMilli = lacc - lwhole;
      // 그 종류에 D를 모두 준 값 — protocol catalogLuckyCeilingMilli와 같은 식(가장 드문 행운 종류가 그 최대).
      // (규칙 11) LIFE로 늘어난 내구도까지: × 총 내구도 / D (늘지 않았으면 1 — 규칙 10과 비트까지 같음)
      const life = pickaxe.durabilityTotal > tier.durability ? pickaxe.durabilityTotal / tier.durability : 1;
      const lceil = Math.floor(((catalog.lucky.share * luckyPoolCount(catalog)) / kind.batchCount) * tier.priceCredits * life * 1000);
      if (pickaxe.luckyMilli + lwhole > lceil) lwhole = Math.max(0, lceil - pickaxe.luckyMilli);
      pickaxe.luckyMilli += lwhole;
      credited += lwhole;
    }
  }

  // ── 3) 막타 (규칙 9) — 반드시 4의 "이미 닿은 칸" 조기 반환 앞
  if (destroyed && kind.hp > tier.attack && catalog.reward.lastHitMult > 0) {
    const prize = catalogLastHitMilli(catalog, pickaxe.tier, block.kind);
    const paid = Math.max(0, Math.min(prize, catalogLastHitCapMilli(catalog, pickaxe.tier) - pickaxe.lastHitMilli));
    pickaxe.lastHitMilli += paid;
    pickaxe.lastHits += 1;
    credited += paid;
  }

  // ── 4) 새 블록 · POP · BIG POP
  const key = cellKey(block, catalog.world.width);
  if (pickaxe.touched.includes(key)) return credited;
  pickaxe.touched.push(key);
  const prevNewKind = pickaxe.popPrevKind;
  pickaxe.popPrevKind = block.kind;
  if (block.kind === pickaxe.streakKind) pickaxe.streakLen += 1;
  else {
    pickaxe.streakKind = block.kind;
    pickaxe.streakLen = 1;
  }

  const emit = (kindOf: BonusEvent["kind"], prizeMilli: number): void => {
    const paid = grantBonusMilli(pickaxe, prizeMilli, tier.bonusCap);
    credited += paid;
    pickaxe.bonusEvents.push({
      kind: kindOf, tick: at.tick, window: at.window, blockKind: block.kind,
      streakCount: pickaxe.streakLen, prizeMilli, paidMilli: paid,
    });
  };
  if (catalog.reward.combo) {
    // (규칙 11) COMBO 사다리: s ≥ 2가 될 때마다 한 단계 (상금 0인 등급은 사건 없음)
    const s = pickaxe.streakLen;
    const prize = s >= 2 ? catalogComboPrizeMilli(catalog, pickaxe.tier, s) : 0;
    if (prize > 0) {
      if (s === 2) pickaxe.popDone = true;
      else pickaxe.bigDone = true;
      emit(s === 2 ? "POP" : "BIG_POP", prize);
    }
    return credited;
  }
  if (!pickaxe.popDone && prevNewKind === block.kind && tier.popPrize > 0) {
    pickaxe.popDone = true;
    emit("POP", tier.popPrize * 1000);
  }
  if (!pickaxe.bigDone && pickaxe.streakLen === 3 && tier.bigPopPrize > 0) {
    pickaxe.bigDone = true;
    emit("BIG_POP", tier.bigPopPrize * 1000);
  }
  return credited;
}

/** 보너스 지급 (밀리크레딧). 곡괭이별 상한을 넘는 부분은 버린다. */
function grantBonusMilli(pickaxe: PickaxeState, prizeMilli: number, capCredits: number): number {
  const room = capCredits * 1000 - pickaxe.bonusMilli;
  const granted = Math.max(0, Math.min(prizeMilli, room));
  pickaxe.bonusMilli += granted;
  return granted;
}

/** 곡괭이가 지금까지 번 것 E = 기본 + LUCKY + 보너스 + 막타 (밀리크레딧). 몫을 손으로 더하지 말고 이 함수를 쓴다. */
export function earnedMilli(pickaxe: Pick<PickaxeState, "baseMilli" | "luckyMilli" | "bonusMilli" | "lastHitMilli">): number {
  return pickaxe.baseMilli + pickaxe.luckyMilli + pickaxe.bonusMilli + pickaxe.lastHitMilli;
}

/**
 * 정상 종료 정산 나눔 (규칙 7, 감사 F-1): payoutMilli = min(E, REWARD 상한), overMilli = E − payoutMilli. `settleEnd` 한 번에 둘 다 간다.
 */
export function splitRewardMilli(catalog: Catalog, tier: number, earned: number): { payoutMilli: number; overMilli: number } {
  const cap = rewardCapMilli(catalog, tier);
  const payoutMilli = Math.min(earned, cap);
  return { payoutMilli, overMilli: earned - payoutMilli };
}

/**
 * 비정상 종료 값 (동결·멈춤·타이머·방 닫힘) = min(P, E + u × P), u = 남은 내구도 / D. 밀리크레딧, 내림. over는 없다.
 * "번 것은 그대로, 쓰지 못한 내구도만큼의 가격은 돌려준다. 다만 낸 돈보다 많이 받지는 않는다." (설계 §5.3)
 */
export function abnormalEndValueMilli(pickaxe: PickaxeState): number {
  const unused = pickaxe.durabilityTotal > 0 ? Math.floor((pickaxe.durabilityLeft * pickaxe.priceMilli) / pickaxe.durabilityTotal) : 0;
  return Math.min(pickaxe.priceMilli, earnedMilli(pickaxe) + unused);
}

/** (규칙 10) 정산 한 건의 값 (밀리크레딧). totalMilli = payoutMilli + overMilli = T_main + J. */
export interface Settlement {
  payoutMilli: number;
  overMilli: number;
  pickMilli: number;    // 사다리 보충 = T_main − min(바탕, 총상한) (≥ 0)
  totalMilli: number;
}

/**
 * (규칙 10, 명세 23 §3.2) 바탕 값 base(정상 = X, 비정상 = V)에 바닥·총상한·잭팟을 적용해 나눈다. 정수 밀리, 계산 순서 고정:
 *   F = catalogPickFloorMilli(c, tier, pickLevelBps)(단계 없으면 0) · C = catalogTotalCapMilli(c, tier)
 *   T_main = min(C, max(base, F)) · pickMilli = T_main − min(base, C) · T = T_main + J
 *   payoutMilli = min(T, REWARD 상한) · overMilli = T − payoutMilli
 * 카탈로그에 luckyPick·jackpot·totalCapBps가 없으면 F = 0, J = 0, C ≥ E의 최대라 규칙 9의 splitRewardMilli와 같다.
 * (규칙 11, 명세 24 §3.10) wholeCredits면 T_main = ⌊min(C, max(base, F)) / 1000⌋ × 1000(나머지는 하우스), pickMilli = max(0, T_main − min(base, C))
 *   (단계가 없으면 내림만큼 음수가 되므로 0). J는 균열 때 이미 정수 크레딧이라 T·payout·over가 모두 정수 크레딧이다.
 */
function settleFrom(catalog: Catalog, p: Pick<PickaxeState, "tier" | "pickLevelBps" | "jackpotMilli">, base: number): Settlement {
  const floor = p.pickLevelBps > 0 ? catalogPickFloorMilli(catalog, p.tier, p.pickLevelBps) : 0;
  const cap = catalogTotalCapMilli(catalog, p.tier);
  const raw = Math.min(cap, Math.max(base, floor));
  const main = catalog.reward.wholeCredits ? wholeCreditsMilli(raw) : raw;
  const pickMilli = Math.max(0, main - Math.min(base, cap));
  const totalMilli = main + p.jackpotMilli;
  const payoutMilli = Math.min(totalMilli, rewardCapMilli(catalog, p.tier));
  return { payoutMilli, overMilli: totalMilli - payoutMilli, pickMilli, totalMilli };
}

/** (규칙 10) 정상 종료(DURABILITY) 정산 = REWARD/END: T = min(총상한, max(X, 바닥)) + J, X = earnedMilli. */
export function settleNormal(catalog: Catalog, p: PickaxeState): Settlement {
  return settleFrom(catalog, p, earnedMilli(p));
}

/**
 * (규칙 10) 비정상 종료(TIMER·STUCK·FREEZE·ROOM_CLOSED) 정산. V = abnormalEndValueMilli(p).
 *  단계도 J도 없으면 규칙 9 그대로 REFUND V(over 0, 보충 0).
 *  하나라도 있으면 REWARD/ABNORMAL_END: T = min(총상한, max(V, 바닥)) + J를 REWARD 상한과 over로 나눈다(단계가 있으면 바닥 ≥ 1.1·P > V).
 * (규칙 11) wholeCredits면 V를 먼저 정수 크레딧으로 내린다(⌊V / 1000⌋ × 1000).
 */
export function settleAbnormal(catalog: Catalog, p: PickaxeState): Settlement & { kind: "REFUND" | "REWARD" } {
  const raw = abnormalEndValueMilli(p);
  const v = catalog.reward.wholeCredits ? wholeCreditsMilli(raw) : raw;
  if (p.pickLevelBps === 0 && p.jackpotMilli === 0) return { kind: "REFUND", payoutMilli: v, overMilli: 0, pickMilli: 0, totalMilli: v };
  return { kind: "REWARD", ...settleFrom(catalog, p, v) };
}
