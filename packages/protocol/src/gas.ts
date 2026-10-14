// ──────────────────────────────────────────────────────────────────────────
// 가스 한도 정책 (docs/DEPLOY.md "가스 한도", contracts/README.md 가스 절). 개정 7(명세 20): 운영자가 보내는 tx는 PikitLedger
// `postRoot`(시간당 루트)와 `revealSeed`(1분 시드 공개) 둘뿐이다(settler ROOT 키, D203). 개정 6 함수(buy·settle·anchor·promo …)의
// 상한은 그 컨트랙트와 함께 D4에서 지웠다.
// Monad는 gas used가 아니라 gas limit 전액을 청구한다. 그리고 한도가 모자라 되돌려진 tx도 한도 전액을 낸다(영수증 gasUsed = 한도라
// 영수증으로는 가스 부족과 논리 되돌림을 구분할 수 없다). 그래서 한도는 "추정보다 작게 깎지 않는다"가 첫째 규칙이다.
//
// 보낼 gas limit (gasFor) — 상한(cap)은 터무니없는 추정(테스트넷 vault.claim 추정 23,938,769 → 2.44 MON)을 막는 안전장치일 뿐,
// 그럴듯한 추정 밑으로 자르는 천장이 아니다:
//   추정 ≤ 상한          → 추정 × (1 + 여유)
//   상한 < 추정 ≤ 2 × 상한 → 추정 × (1 + 여유) + 경고 "GAS ESTIMATE ABOVE CAP" (Monad 추정은 높게 나온다 — 상한으로 잘라
//                         가스 부족으로 되돌려지면 한도 전액을 아무것도 없이 낸다. 추정대로 내는 편이 싸다)
//   추정 > 2 × 상한       → 보내지 않는다: GasEstimateTooHighError를 던진다(settler는 실패로 세고 물러난다)
// 사고(2026-10-09, 구매 #0): settle 상한 150,000 < Monad 추정 152,471 → 상한으로 보냄 → 가스 부족 → 38번 반복.
//
// 여유(D95): 운영자만 보내고 가스가 인자로 정해지는 함수(postRoot·revealSeed)는 5%, 그 밖 기본 10%.
// 상한 = max(forge --isolate 가스 보고서 최대값 × 1.35, Monad eth_estimateGas × 1.5)을 위로 반올림.
// 단위 = 시드 사슬 한 단계(keccak 1회, 102 gas → 140), 한 번에 최대 4,096단계.
// 개정 7 PikitLedger(D197, 2026-10-13): postRoot = 시드 공개 + 루트 2칸 저장 + 10칸 이벤트. forge --isolate: 첫 루트(60단계) 116,752 ·
//   이후 60단계 102,090 · 45단계 100,584 · 1단계 96,084 · 남이 더 뒤 시드를 공개한 뒤(뒤로 5단계) 88,407 · 4,096단계 513,798.
//   Monad eth_estimateGas(2026-10-13, 테스트넷·메인넷 같은 값, 상태 덮어쓰기로 tx 없이): 첫 루트 114,942 · 이후 60단계 98,326 / 배포 1,205,937.
//   상한 190,000 + 140 × 단계 — 60단계 198,400 ≥ forge 116,752 × 1.35 · Monad 114,942 × 1.5.
//   단위 = 시드 단계 수(앞으로 epoch − lastRevealedEpoch, 누가 더 뒤 시드를 먼저 공개했으면 뒤로 lastRevealedEpoch − epoch).
//   revealSeed: 1단계 34,777 · 4,096단계 452,479. contracts/README.md §8.4
// 값은 contracts/README.md "가스" 표와 같아야 한다. 테스트넷에서 다시 재면 이 표와 docs를 함께 고친다.
// ──────────────────────────────────────────────────────────────────────────

export interface GasCap {
  base: bigint;
  /** 단위(시드 단계 수)마다 더하는 가스 */
  perUnit?: bigint;
  /** 추정에 더하는 여유(%). 기본 10 */
  padPct?: bigint;
}

export const GAS_CAPS = {
  postRoot: { base: 190_000n, perUnit: 140n, padPct: 5n },
  revealSeed: { base: 50_000n, perUnit: 140n, padPct: 5n },
} as const satisfies Record<string, GasCap>;

export type GasFn = keyof typeof GAS_CAPS;

/** 추정이 상한의 이 배수를 넘으면 보내지 않는다. */
export const GAS_REFUSE_FACTOR = 2n;

/** 추정이 상한 × GAS_REFUSE_FACTOR를 넘어 보내지 않을 때 gasFor가 던진다. */
export class GasEstimateTooHighError extends Error {
  constructor(readonly fn: GasFn, readonly estimate: bigint, readonly cap: bigint) {
    super(`GAS ESTIMATE REFUSED: ${fn} estimate ${estimate} > ${GAS_REFUSE_FACTOR} × cap ${cap} — not sent (check the RPC; Monad charges the whole limit)`);
    this.name = "GasEstimateTooHighError";
  }
}

/** 함수의 가스 상한. units = 시드 단계 수. */
export function gasCap(fn: GasFn, units = 0): bigint {
  const c: GasCap = GAS_CAPS[fn];
  if (!Number.isInteger(units) || units < 0) throw new Error(`gasCap(${fn}): units must be a non-negative integer, got ${units}`);
  return c.base + (c.perUnit ?? 0n) * BigInt(units);
}

export interface GasForOptions {
  units?: number;
  /** 추정이 상한을 넘었지만 2배 안일 때 부른다 (기본 console.warn) */
  warn?: (message: string) => void;
}

/** 함수의 추정 여유(%) — 5(운영자·결정적) 또는 10(기본). */
export function gasPadPct(fn: GasFn): bigint {
  const c: GasCap = GAS_CAPS[fn];
  return c.padPct ?? 10n;
}

/**
 * 보낼 gas limit = ceil(추정 × (100 + 여유%) / 100). 추정이 상한을 넘으면 경고하고(2배 안), 2배를 넘으면 GasEstimateTooHighError.
 * 한도를 추정보다 작게 깎지 않는다(Monad는 가스 부족으로 되돌려진 tx도 한도 전액을 받는다).
 */
export function gasFor(fn: GasFn, estimate: bigint, o: GasForOptions = {}): bigint {
  const cap = gasCap(fn, o.units ?? 0);
  if (estimate > cap * GAS_REFUSE_FACTOR) throw new GasEstimateTooHighError(fn, estimate, cap);
  const padded = (estimate * (100n + gasPadPct(fn)) + 99n) / 100n;
  if (estimate > cap) {
    (o.warn ?? console.warn)(`GAS ESTIMATE ABOVE CAP: ${fn} estimate ${estimate} > cap ${cap} — sending with gas ${padded} (estimate + ${gasPadPct(fn)}%; refused above ${GAS_REFUSE_FACTOR} × cap). Raise the cap if this repeats`);
  }
  return padded;
}
