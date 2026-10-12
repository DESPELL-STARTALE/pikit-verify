// ──────────────────────────────────────────────────────────────────────────
// 결정론 삼각함수 — Math.sin / Math.cos는 사양이 "구현 근사"로 남겨 둬서 엔진·버전마다 마지막 비트가 다를 수 있다.
// 곡괭이 모양 히트박스는 회전 각도로 머리·손잡이 위치를 정하므로 sin·cos가 규칙의 일부가 된다 → + − × ÷와 Math.round만으로 계산한다.
//
//  1) 범위 줄이기 (Cody–Waite): k = round(x / (π/2)), r = (x − k·P1) − k·P2  (P1 = π/2의 double, P2 = 나머지). |r| ≤ π/4 (+ 반올림 오차)
//  2) |r| ≤ π/4에서 고정 다항식 (테일러 계수, 호너 순서 고정): sin r ≈ r + r³(S1 + r²(S2 + …)), cos r ≈ 1 + r²(C1 + r²(C2 + …))
//     절단 오차 ≤ (π/4)^13 / 13! ≈ 7e-12 (sin), (π/4)^14 / 14! ≈ 4e-13 (cos). 정확도가 아니라 "어디서나 같은 비트"가 목적이다.
//  3) 사분면: k mod 4 = 0 → (sin r, cos r), 1 → (cos r, −sin r), 2 → (−sin r, −cos r), 3 → (−cos r, sin r)
// 음수 부호는 0 − v로 만든다(−0을 만들지 않음, docs/determinism.md §3.4).
// 쓰는 곳: 물리(곡괭이 몸의 머리·손잡이 위치, 머리 쪽으로 도는 힘). 입력은 보통 [−π, π]이지만 어떤 유한수든 받는다(|x| < 2^30 권장).
// ──────────────────────────────────────────────────────────────────────────

const HALF_PI_HI = 1.5707963267948966;      // double(π/2)
const HALF_PI_LO = 6.123233995736766e-17;   // π/2 − HALF_PI_HI

const S1 = -1 / 6;
const S2 = 1 / 120;
const S3 = -1 / 5040;
const S4 = 1 / 362880;
const S5 = -1 / 39916800;
const C1 = -1 / 2;
const C2 = 1 / 24;
const C3 = -1 / 720;
const C4 = 1 / 40320;
const C5 = -1 / 3628800;
const C6 = 1 / 479001600;

/** sin과 cos를 한 번에 (같은 범위 줄이기). */
export interface SinCos {
  sin: number;
  cos: number;
}

/** 결정론 sin·cos. + − × ÷와 Math.round만 쓴다. */
export function detSinCos(x: number): SinCos {
  const k = Math.round(x / HALF_PI_HI);
  const r = ((x - k * HALF_PI_HI) - k * HALF_PI_LO) + 0;   // + 0: x = −0이어도 r은 +0
  const r2 = r * r;
  const s = r + r * r2 * (S1 + r2 * (S2 + r2 * (S3 + r2 * (S4 + r2 * S5))));
  const c = 1 + r2 * (C1 + r2 * (C2 + r2 * (C3 + r2 * (C4 + r2 * (C5 + r2 * C6)))));
  const q = ((k % 4) + 4) % 4;
  if (q === 0) return { sin: s, cos: c };
  if (q === 1) return { sin: c, cos: 0 - s };
  if (q === 2) return { sin: 0 - s, cos: 0 - c };
  return { sin: 0 - c, cos: s };
}

/** 결정론 sin (detSinCos의 sin). */
export function detSin(x: number): number {
  return detSinCos(x).sin;
}

/** 결정론 cos (detSinCos의 cos). */
export function detCos(x: number): number {
  return detSinCos(x).cos;
}
