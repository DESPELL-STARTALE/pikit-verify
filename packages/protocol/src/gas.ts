// ──────────────────────────────────────────────────────────────────────────
// 가스 한도 정책 (docs/DEPLOY.md "가스 한도", docs/INTERFACES.md 9.6.10, contracts/README.md 가스 절).
// Monad는 gas used가 아니라 gas limit 전액을 청구한다. 그리고 한도가 모자라 되돌려진 tx도 한도 전액을 낸다(영수증 gasUsed = 한도라
// 영수증으로는 가스 부족과 논리 되돌림을 구분할 수 없다). 그래서 한도는 "추정보다 작게 깎지 않는다"가 첫째 규칙이다.
//
// 보낼 gas limit (gasFor) — 상한(cap)은 터무니없는 추정(테스트넷 vault.claim 추정 23,938,769 → 2.44 MON)을 막는 안전장치일 뿐,
// 그럴듯한 추정 밑으로 자르는 천장이 아니다:
//   추정 ≤ 상한          → 추정 × (1 + 여유)
//   상한 < 추정 ≤ 2 × 상한 → 추정 × (1 + 여유) + 경고 "GAS ESTIMATE ABOVE CAP" (Monad 추정은 높게 나온다 — 상한으로 잘라
//                         가스 부족으로 되돌려지면 한도 전액을 아무것도 없이 낸다. 추정대로 내는 편이 싸다)
//   추정 > 2 × 상한       → 보내지 않는다: GasEstimateTooHighError를 던진다(settler는 그 행을 실패로 세고 물러난다 → E14)
// 사고(2026-10-09, 구매 #0): settle 상한 150,000 < Monad 추정 152,471 → 상한으로 보냄 → vault.onSettle 안에서 가스 부족 → 38번 반복.
// 개정 5(D105)부터 MON을 밖으로 보내는 함수(withdraw·executeWithdraw)가 없어 "고정 한도" 예외도 없다.
//
// 여유(D95): 운영자만 보내고 가스가 인자로 정해지는 함수(anchor·revealSeed·commitBatches·settleEnd·settleEndMany·payOverAfterVoid)는 5%,
// 플레이어·relay 함수처럼 추정과 실릴 때 사이에 다른 tx가 상태를 바꿀 수 있는 것은 10%.
//
// 상한 = max(forge --isolate 가스 보고서 최대값 × 1.35, Monad 테스트넷 eth_estimateGas × 1.5)을 위로 반올림.
// Monad는 cold 스토리지·계정 접근이 이더리움보다 훨씬 비싸서(settle 첫 지급: forge 88k vs Monad 추정 152k) forge 값만으로는 모자란다.
// 개정 5(D105, 2026-10-10): 금고를 계산대에 합쳐 정산·구매·환불마다 하던 vault 호출(Monad에서 비싼 cold 계정 접근)이 없어졌다.
// forge --isolate(개정 5): buyWithCredits 1개 149,808~198,831(정산 멈춤 검사 8개 무효 238,147) · 10개 166,392~223,535 /
//   settle 61,577~78,810 · 잭팟 69,600~106,599 / settleMany 같은 지갑 10개 145,719(+잭팟 181,009) · 20개 226,068(개당 ≈ 8k),
//   지갑 10곳 403,911(개당 ≈ 36k) / grantPromo 46,935~81,135 / refundUnprocessed 77,901~85,560 / refundUnsettled 59,997~70,137.
// 개정 6(D138, 2026-10-12, rules 7): settle·settleMany·잭팟 → settleEnd·settleEndMany(REWARD + over 한 호출) + payOverAfterVoid.
//   forge --isolate: settleEnd Reward 빈 잔액 79,085 · 이후 61,997 · + over 새 시간 창 107,369(최대) · 같은 창 70,370 /
//   settleEndMany 한 지갑 10개 149,648(+ over 1개 177,932) · 20개 233,987 · 지갑 10곳 407,840 / payOverAfterVoid 91,604.
//   상한은 개정 5의 settle·settleMany 값을 그대로 쓴다(forge 최대 × 1.35 안, Monad 실측은 재배포 뒤).
// cancelQueued(2026-10-11, 보안 리뷰 M-2: 항목마다 취소 비트를 쓴다 — 건드린 구매마다 SSTORE 하나): 1개 54,198 · 한 구매 10개 69,692 ·
//   구매 10곳 각 1개 130,796(최악, 구매마다 차가운 슬롯 2개 읽기 + 쓰기 ≈ 8.5k). Monad는 차가운 슬롯이 훨씬 비싸 단위당 20,000.
//   buyWithCredits는 구매 기록에 방 번호를 같은 슬롯에 넣어 +39(최악 238,186).
// Monad 추정은 개정 4(2026-10-09, vault 호출 포함) 값만 있다: settle 첫 지급 152,471 · 따뜻함 135,269 / settleMany 2개 198,550 ·
//   3개 227,859 / anchor 107,353~114,290 / commitBatches 1개 36,617 · 12개 66,444 / grantPromo 110,622 / refundUnsettled 123,577 /
//   buyWithCredits 175,012. 개정 5는 이보다 싸야 하므로 상한은 그대로 두거나(settleMany·grantPromo·환불) forge 최대 × 1.35를
//   덮게 올렸다(buyWithCredits). 테스트넷 재배포 뒤 다시 잰다.
// 개수에 따라 늘어나는 함수는 단위당 가스를 더한다:
//   buyWithCredits 등급 하나당 · cancelQueued 항목 하나당(구매가 다르면 차가운 슬롯 쓰기) · settleEndMany 정산 하나당 · commitBatches 묶음 하나당
//   anchor·revealSeed  시드 사슬 한 단계당 102 gas (keccak 1회) → 140, 한 번에 최대 4,096단계
// 값은 contracts/README.md "가스" 표와 같아야 한다. 테스트넷에서 다시 재면 이 표와 docs를 함께 고친다.
// ──────────────────────────────────────────────────────────────────────────

export interface GasCap {
  base: bigint;
  /** 단위(buyWithCredits: 등급 수, cancelQueued: 항목 수, anchor·revealSeed: 시드 단계 수, commitBatches: 묶음 수)마다 더하는 가스 */
  perUnit?: bigint;
  /** 추정에 더하는 여유(%). 기본 10 */
  padPct?: bigint;
}

export const GAS_CAPS = {
  buyWithCredits: { base: 330_000n, perUnit: 2_600n },
  cancelQueued: { base: 100_000n, perUnit: 20_000n },
  registerSessionKey: { base: 90_000n },
  settleEnd: { base: 300_000n, padPct: 5n },
  settleEndMany: { base: 230_000n, perUnit: 47_000n, padPct: 5n },
  payOverAfterVoid: { base: 300_000n, padPct: 5n },
  refundUnprocessed: { base: 210_000n },
  refundUnsettled: { base: 190_000n },
  grantPromo: { base: 170_000n },
  anchor: { base: 190_000n, perUnit: 140n, padPct: 5n },
  revealSeed: { base: 50_000n, perUnit: 140n, padPct: 5n },
  commitBatches: { base: 110_000n, perUnit: 4_000n, padPct: 5n },
  skipMissedBatches: { base: 120_000n, padPct: 5n },
  createRoom: { base: 100_000n },
  setRoomOpen: { base: 50_000n },
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

/** 함수의 가스 상한. units = buyWithCredits의 등급 수, cancelQueued 항목 수, settleEndMany 정산 수, anchor·revealSeed의 시드 단계 수, commitBatches 묶음 수. */
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
