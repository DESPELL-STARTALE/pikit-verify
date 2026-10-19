// F-9 카탈로그 검사 (감사 F-9, 명세 16 §4.5·§8.7, 명세 17 §2.11 P0-12) — 시험(test/f9.test.ts)과 CI 규칙 동결 스크립트
// (scripts/ci/rules-freeze.mjs)가 같은 함수를 부른다. 엔진 src/ 밖이라 engineVersionHash를 바꾸지 않는다.
// 등급마다:
//   ① 곡괭이 기대 회수 = rewardCapBps/1e4 + E[over]/price ≤ F9_BOUND(0.98) < 1  (실제 엔진 3인 방, 시드 고정 = 결정론 — balance.ts runRoom·f9Report)
//   ② REWARD 상한 ≤ 0.90 × 가격 (체인 MAX_REWARD_CAP_BPS 9700보다 좁은 출시 약속)
//   ③ over 상한 ≥ LUCKY 최대(catalogLuckyCeilingMilli) — 행운 블록 지급이 상한에 잘리지 않는다
//   ④ over 상한 ≤ MAX_OVER_MULTIPLE × 가격, rewardCapBps ≤ MAX_REWARD_CAP_BPS (f9Report)
// (규칙 10, 명세 23 §6.4) 카탈로그에 totalCapBps·luckyPick·jackpot이 있으면 ① 대신 F-9′:
//   E[T_main]/P (LUCKY 종류·사다리 단계를 기대로, 총상한 포함 — balance.ts tMainExp) + contributionBpsByTier[t]/10⁴ < F9_PRIME_BOUND(0.92)
//   expectedReturn = 그 F-9′ 값 (scripts/ci/rules-freeze.mjs가 < 0.92를 한 번 더 본다). ②③④는 그대로(over 상한 = 총상한 − REWARD 상한).
import { catalogLuckyCeilingMilli, type Catalog } from "@pikit/protocol";
import { overCapMilli, rewardCapMilli } from "../../src/index.js";
import { F9_PRIME_BOUND, f9Report, runRoom, type F9Result } from "./balance.js";

export const REWARD_CAP_MAX_SHARE = 0.9;

export interface F9TierCheck {
  code: string;
  expectedReturn: number;      // 규칙 9: cap + E[over] (가격 대비) · 규칙 10: F-9′ = E[T_main]/P + x_t
  rewardCapMilli: number;
  rewardCapLimitMilli: number; // 0.90 × 가격
  overCapMilli: number;
  luckyMaxMilli: number;
  problems: string[];
}

export interface F9Check {
  ok: boolean;
  report: F9Result;
  tiers: F9TierCheck[];
  problems: string[];
}

export interface F9Options {
  players?: number;
  seeds?: number;
  pickaxes?: number;
}

/** 카탈로그 하나의 F-9 검사. 기본 = f9.test.ts와 같은 표본(3인 방 · 시드 12개 · 플레이어마다 곡괭이 40개). */
export function f9Check(catalog: Catalog, o: F9Options = {}): F9Check {
  const room = runRoom(catalog, o.players ?? 3, Array.from({ length: o.seeds ?? 12 }, (_, i) => i + 1), o.pickaxes ?? 40);
  const report = f9Report(catalog, room.rows);
  const tiers = report.tiers.map((t): F9TierCheck => {
    const price = catalog.pickaxes[t.tier]!.priceCredits * 1000;
    const cap = rewardCapMilli(catalog, t.tier);
    const capLimit = Math.floor(REWARD_CAP_MAX_SHARE * price);
    const over = overCapMilli(catalog, t.tier);
    const lucky = catalogLuckyCeilingMilli(catalog, t.tier);
    const problems: string[] = [];
    if (t.n < 200) problems.push(`only ${t.n} pickaxes sampled (< 200)`);
    if (!(t.sum < 1)) problems.push(`expected return per pickaxe ${t.sum.toFixed(4)} ≥ 1`);
    if (!t.ok) {
      problems.push(t.prime
        ? `F-9′ E[T_main]/P + x_t ${t.sum.toFixed(4)} ≥ ${F9_PRIME_BOUND} or over cap ${t.overCapMilli} > ${t.overCapLimitMilli}`
        : `cap + E[over] ${t.sum.toFixed(4)} > ${0.98} or over cap ${t.overCapMilli} > ${t.overCapLimitMilli}`);
    }
    if (cap > capLimit) problems.push(`REWARD cap ${cap} > 0.90 × price ${capLimit}`);
    if (over < lucky) problems.push(`over cap ${over} < LUCKY maximum ${lucky}`);
    return { code: t.code, expectedReturn: t.sum, rewardCapMilli: cap, rewardCapLimitMilli: capLimit, overCapMilli: over, luckyMaxMilli: lucky, problems };
  });
  const problems = tiers.flatMap((t) => t.problems.map((p) => `${t.code}: ${p}`));
  if (!report.ok && problems.length === 0) problems.push(`rewardCapBps ${report.rewardCapBps} above the chain maximum`);
  return { ok: problems.length === 0, report, tiers, problems };
}
