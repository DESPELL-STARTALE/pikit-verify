import {
  catalogBaseCeilingMilli, catalogLastHitCapMilli, catalogLastHitMilli, catalogOverCapMilli, catalogRewardCapMilli, luckyPoolCount, type Catalog,
} from "@pikit/protocol";
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
      // 그 종류에 D를 모두 준 값 — protocol catalogLuckyCeilingMilli와 같은 식(가장 드문 행운 종류가 그 최대)
      const lceil = Math.floor(((catalog.lucky.share * luckyPoolCount(catalog)) / kind.batchCount) * tier.priceCredits * 1000);
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
