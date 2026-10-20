import { z } from "zod";

// ──────────────────────────────────────────────────────────────────────────
// 규칙표(카탈로그) — 엔진이 쓰는 모든 숫자는 여기서만 온다. 바뀌면 rulesVersion과 rulesHash가 바뀐다.
// 설계: docs/pikit-monad-architecture.md 부록 B·E, docs/route-streak-balance.md §0.3.
// ──────────────────────────────────────────────────────────────────────────

export const CATALOG_SCHEMA_ID = "pikit.catalog/v1" as const;

/** 방 모드. 출시는 NORMAL 하나다(D104: 구슬 가격 ×1~×20이 한 방에서 옛 LITE·HARDCORE를 대신한다). */
export type GameMode = "NORMAL";

/** 월드(방) 크기와 카메라·스폰 규칙. */
export interface WorldRules {
  width: number;                    // 가로 칸 수 (지금 게임 10)
  height: number;                   // 화면 세로 칸 수 (지금 게임 15)
  ringBufferRowMultiplier: number;  // 링버퍼 줄 수 = height × 이 값 (지금 게임 2)
  ticksPerWindow: number;           // 확정 블록 1개 = 9틱
  spawnOffsetRows: number;          // 스폰 y = scrollY − 이 값 (지금 게임 2)
  cameraLeadFraction: number;       // 카메라 목표 = 가장 깊은 곡괭이 y − height × 이 값 (0.25)
  cameraLerp: number;               // 카메라 보간 계수 (0.1)
  botStartY: number;                // 봇 시작 y (새 게임 −2, 블록은 0줄부터)
}

/**
 * 물리 상수. 마찰은 곡괭이 등급마다 미리 계산한 값(pickaxes[].frictionPerTick)을 쓴다 — 엔진은 Math.pow를 부르지 않는다.
 * 속도는 칸/틱, 각속도는 rad/틱. 아래 여섯 개(minBounceVy~spinKick)는 2026-10-06 곡괭이 모양 히트박스와 함께 생겼다(D70·D71):
 * 원(circle) 몸은 minBounceVy·maxSpin만 쓰고(옛 상수 0.25·0.4를 그대로 넣으면 옛 궤적과 비트까지 같다), 나머지는 곡괭이(pickaxe) 몸만 쓴다.
 */
export interface PhysicsRules {
  fps: number;              // 틱/초 (30)
  bounce: number;           // 반발 계수 (블록. 벽은 1)
  gravity: number;          // 중력 가속도 (칸/초²). 틱당 = gravity / fps²
  friction: number;         // 참고용 원래 마찰 계수. frictionPerTick 표를 만들 때만 쓴다(엔진은 읽지 않음)
  denominator: number;      // 시스템 보정(튕김 킥) 강도 분모
  minBounceVy: number;      // 최소 튕김: 바닥(위로 미는 면)에 닿은 뒤 위쪽 속도가 이보다 작으면 (0.10~0.20) ÷ denominator만큼 더 띄운다 (칸/틱)
  maxSpin: number;          // 각속도 상한 (rad/틱)
  angularDamping: number;   // 곡괭이 몸: 틱마다 각속도에 곱하는 값 (0~1)
  contactFriction: number;  // 곡괭이 몸: 접촉면 마찰 계수 μ (접선 충격 ≤ μ × 법선 충격) — 미끄러지는 접촉이 회전을 만든다
  headFirstTorque: number;  // 곡괭이 몸: 머리를 진행 방향으로 돌리는 힘 (각속도 += 이 값 × (머리 방향 × 속도)). 0이면 없음
  spinKick: number;         // 곡괭이 몸: 블록에 튕길 때 각속도가 이보다 작으면 ±spinKick 안에서 무작위로 돌린다(시스템 보정, 손잡이로 선 채 멈추지 않게). 0이면 없음
}

/**
 * 곡괭이 날(머리) = 몸 좌표의 꺾은선 pts를 따라 놓인 캡슐들(점 i → i+1, 반지름 r). 그림의 초승달 날에 맞춘 값(규칙 7: 5점 재맞춤, 명세 16 §5.2).
 * 몸 좌표: 지름 1, 몸 중심 0, x = 머리 방향, y = x를 +90° 돌린 방향.
 */
export interface HitboxBlade {
  pts: [number, number][];   // 꺾은선 꼭짓점 (2개 이상). 한 점은 정확히 날 끝 (0.5 − r, 0)
  r: number;                 // 막대 반지름
}

/**
 * 곡괭이 히트박스 (등급마다). 길이는 모두 그 몸의 지름 scale에 곱하는 비율이다.
 *  circle   지름 scale인 원 (옛 엔진 그대로)
 *  pickaxe  날 막대들(blade) + 손잡이 캡슐. 몸 기준(각도 0)에서 머리 쪽이 +x, 무게중심 = 몸 좌표 (x, y):
 *             손잡이 = 선분 B–H, B = (headOffset − handleLength, 0), H = (headOffset, 0), 반지름 handleRadius
 *             날 = blade.pts의 이웃한 두 점을 잇는 캡슐들, 반지름 blade.r
 *           세계 좌표: (x, y) + scale × (cos θ · lx − sin θ · ly, sin θ · lx + cos θ · ly), θ = angle (y는 아래로 커지므로 θ가 커지면 화면에서 시계 방향)
 *           모양은 지름 scale인 원 안에 들어간다(날 점마다 |p| + r ≤ 0.5, handleLength − headOffset + handleRadius ≤ 0.5) → 지름 상한·벽·스폰 규칙은 그대로.
 *           날 끝 한 점이 정확히 (0.5 − r, 0)이라 축 방향 범위가 −0.5…+0.5 → 화면의 그림 맞춤(축 양 끝 = 히트박스 양 끝)이 그대로다
 *           (규칙 7, D137) 피해는 조각 구분 없이 — 날이든 손잡이든 겹친 블록에 공격력 그대로
 *           inertia = 관성 모멘트 ÷ (질량 × scale²) — 작을수록 비켜 맞을 때 더 많이 돈다
 */
export type PickaxeHitbox =
  | { shape: "circle" }
  | { shape: "pickaxe"; headOffset: number; handleLength: number; handleRadius: number; inertia: number; blade: HitboxBlade };

/**
 * 곡괭이 등급 하나. 금액은 모두 크레딧(1 크레딧 = 0.001 MON).
 * 곡괭이 1개 = 기본(β_t × 블록 값 × 깎은 체력) + LUCKY(행운 종류에 준 피해) + POP + BIG POP (규칙 7, 명세 16 §4.1).
 */
export interface PickaxeTier {
  tier: number;              // 0부터 (구매 이벤트의 tiers[] 값)
  code: string;              // FE, FC, VD, WB, BM
  name: string;
  priceCredits: number;      // 가격 (정수 크레딧)
  attack: number;            // 공격력 (틱당 블록당 최대 피해)
  scale: number;             // 지름 (칸) — 히트박스는 이 원 안에 들어간다
  hitbox: PickaxeHitbox;     // 충돌 모양 (원 / 곡괭이)
  weight: number;            // 무게 (≥ 0.5)
  durability: number;        // 내구도 D = 줄 수 있는 유효 피해 총량
  frictionPerTick: number;   // = (friction^(1/fps))^(1/weight), 규칙표를 만들 때 한 번 계산해 고정 (docs/determinism.md)
  beta: number;              // β_t (크레딧 / 값·체력). 기본 수익 = β_t × blocks[k].value × 유효 피해
  popPrize: number;          // POP 상금 (크레딧, 새 블록 2연속 같은 종류, 곡괭이당 1번). 0이면 POP 없음
  bigPopPrize: number;       // BIG POP 상금 (크레딧, 새 블록 3연속 같은 종류, 곡괭이당 1번). 0이면 없음
  bonusCap: number;          // 곡괭이 1개가 받는 보너스(POP + BIG POP) 합계 상한 (크레딧) = popPrize + bigPopPrize
}

/**
 * 블록 종류 하나. kind 순서 = 희귀도·값 순서(0 Dirt … 9 Diamond · 10 CHOG Ore · 11 Golden CHOG, 규칙 8 — 명세 21).
 * id = 화면이 그림·색·소리를 고르는 이름(소문자, 카탈로그 안에서 하나뿐). 엔진은 kind 번호만 쓴다.
 */
export interface BlockKind {
  kind: number;
  id: string;             // "dirt" … "diamond" · "chog" · "chog_gold" (웹 apps/web/lib/game/block-kinds.ts BLOCK_IDS)
  name: string;
  hp: number;             // 체력
  value: number;          // 블록 값 (공개 사다리, 규칙 9: 1 · 2 · 3 · … · 10 다이아 · 12 CHOG Ore · 15 Golden CHOG). 기본 수익 = β_t × value × 유효 피해
  batchCount: number;     // 2,000블록 묶음 안 개수 (합 = limits.batchBlocks)
  luckyEligible: boolean; // LUCKY 종류로 뽑힐 수 있나 (규칙 8: CHOG 두 종류는 false — 값이 큰 블록에 LUCKY를 겹치지 않는다)
}

/**
 * 정산 나눔 (규칙 7, 감사 F-1·F-9). 정상 종료 곡괭이가 번 것 E = 기본 + LUCKY + 보너스 + 막타를
 * REWARD = min(E, 가격 × rewardCapBps / 10,000), 초과분(over) = E − REWARD로 나눠 `settleEnd` 한 번에 보낸다.
 * 막타 LAST HIT (규칙 9, 명세 22 §3): 주인 있는 곡괭이가 **한 방에 못 깨는 블록**(hp_k > attack_t)을 깨면
 * floor(lastHitMult × β_t × value_k × attack_t × 1000) 밀리를 더 받는다(catalogLastHitMilli). 곡괭이당 합 ≤ 가격 × lastHitCapBps / 10,000.
 */
export interface RewardRules {
  rewardCapBps: number;      // REWARD 상한 (가격의 bps, ≤ 9,700). 출시 9,000
  lastHitMult: number;       // (규칙 9) 막타 상금 = 그 블록 한 대(β_t × value × attack_t)의 이 배수. 0이면 막타 없음. 출시 2
  lastHitCapBps: number;     // (규칙 9) 곡괭이 1개 막타 합 상한 (가격의 bps). 출시 10,000 (= 가격 1배)
  /**
   * (규칙 10, 명세 23 §3.2) 총 상한 C = ⌊가격밀리 × totalCapBps / 10,000⌋ — 정산 T_main = min(C, max(X, 바닥)) (잭팟 제외).
   * 정수 ∈ [rewardCapBps, 1,000,000]. 출시 400,000 (= 가격 40배). 없으면 규칙 9(catalogTotalCapMilli = REWARD 상한 + 규칙 9 over 상한).
   */
  totalCapBps?: number;
  /** (규칙 11, 명세 24 §4.1) COMBO — 같은 종류 새 블록 연속 s ≥ 2면 popPrize × weights[min(s − 2, 길이 − 1)]. 없으면 규칙 10 POP/BIG POP. */
  combo?: ComboRules;
  /** (규칙 11) 정산을 1,000밀리(= 1크레딧) 단위로 내림. true만(있으면). */
  wholeCredits?: true;
}

/** (규칙 11) COMBO 배수표: 정수 1…100, 길이 1…8, 줄지 않음. 출시(잠정) [1, 2, 3, 5]. */
export interface ComboRules {
  weights: number[];
}

/** (규칙 11, 명세 24 §4.1) LUCKY 버프 한 칸 — 표 안에서 kind 중복 없음, weight 정수 ≥ 1. */
export type BuffSpec =
  | { kind: "GIANT"; weight: number; scaleBps: number; ticks: number }   // 지름 × scaleBps/10⁴, ticks 동안
  | { kind: "DASH"; weight: number; speed: number }                      // 속도 벡터를 이 크기로 (칸/틱, ≤ 0.40)
  | { kind: "SPEED"; weight: number; gravityBps: number; ticks: number } // 중력 × gravityBps/10⁴, ticks 동안
  | { kind: "LIFE"; weight: number; durabilityBps: number };             // 내구도 += ⌊D × durabilityBps / 10⁴⌋
export type BuffKind = BuffSpec["kind"];
export const BUFF_KINDS = ["GIANT", "DASH", "SPEED", "LIFE"] as const satisfies readonly BuffKind[];

/** (규칙 11, 명세 24 §4.1) 성장(COMBO마다 popStacks +1)·크기 상한·LUCKY 버프. 없으면 규칙 10(성장·버프 없음). */
export interface BuffRules {
  growStepBps: number;      // popStacks 1당 지름 +bps (0…5,000)
  growMaxStacks: number;    // popStacks 상한 (0…8)
  scaleCap: {
    mulBps: number;         // 지름 상한 = 등급 지름 × mulBps/10⁴ (10,000…30,000)
    tiles: number;          // 그리고 이 칸 수 이하 (0 < x ≤ 3.0)
  };
  lucky: {
    maxPerPickaxe: number;  // 곡괭이 1개 버프 횟수 상한 (0…8)
    table: BuffSpec[];
  };
}

/**
 * LUCKY 블록 (규칙 7, 명세 16 §4.8, D137): 곡괭이가 판에 놓이는 틱에 스트림 `lucky|<키>`의 수 하나로 행운 종류 X를 뽑는다
 * (확률 = blocks[X].batchCount / LUCKY 풀, LUCKY 풀 = luckyEligible 종류의 batchCount 합 — luckyPoolCount).
 * 그 곡괭이는 X 종류에 준 유효 피해 1당 share ÷ odds_X × 가격 ÷ D 크레딧을 더 받는다.
 * X는 물리와 무관하게 뽑히므로 기대 추가 = share × (뽑힐 수 있는 종류에 준 피해 ÷ D) — 모든 종류가 뽑힐 수 있으면 늘 share.
 * (규칙 8, 명세 21) CHOG 두 종류는 luckyEligible = false라 CHOG에 준 피해만큼 LUCKY 기대가 조금 준다(판 노리기 쪽으로는 거꾸로 — 헤지).
 * share = 0이면 끈다(행운 종류는 그래도 뽑아 보인다).
 */
export interface LuckyRules {
  share: number;             // 기대 추가 (가격 대비). 출시 0.08
}

/**
 * (규칙 10, 명세 23 §2.2·§3) LUCKY PICK 사다리 한 단계: 소환 때 스트림 `pick|<키>`의 수 하나로 단계 0개 또는 1개를 뽑는다(배타).
 * multBps = 바닥 배수(가격의 bps, 10,000 초과) · per10m = 10,000,000분의 몇(정수 ≥ 1). 나머지 10⁷ − Σper10m = 단계 없음.
 */
export interface LuckyPickLevel {
  multBps: number;
  per10m: number;
}
export type LuckyLevel = LuckyPickLevel;
/**
 * (규칙 10) LUCKY PICK — levels는 multBps 엄격 오름차순, 16개 이하, Σper10m ≤ 10⁷. 없으면 단계 없음(규칙 9).
 * (규칙 11) byTier = 등급별 levels(길이 = 등급 수). levels와 byTier 중 정확히 하나.
 */
export interface LuckyPickRules {
  levels?: LuckyLevel[];
  byTier?: LuckyLevel[][];
}

/**
 * (규칙 10, 명세 23 §2.3·§4) 골든 CHOG 잭팟 — 상한 없는 통.
 *  - 플레이어 곡괭이가 판에 나올 때 통 += ⌊가격밀리 × contributionBpsByTier[tier] / 10,000⌋ (catalogJackpotContributionMilli)
 *  - 통 ≥ minPoolCredits × 1000이면 kindId 블록을 칠 때마다 균열 확률 q = kappaPpm × 가격 ÷ (10⁶ × 통) (catalogCrack) → 균열이면 통 전부
 *  - 검사: kappaPpm × 최고가(크레딧) < minPoolCredits × 10⁶ (통 ≥ minPool이면 q < 1 → 한 대 기대값이 정확히 κ × 가격)
 * 등급별 기여율을 읽는 곳은 catalogJackpotContributionMilli 하나뿐이다(모양이 바뀌어도 그 함수만 고친다).
 */
export interface JackpotRules {
  kindId: string;                  // 균열하는 블록 id (출시 "chog_gold")
  contributionBpsByTier: number[]; // 등급별 기여 (bps 정수 0…1,000, 길이 = pickaxes.length). 출시 [8, 11, 13, 18, 28]
  kappaPpm: number;                // 한 대 기대값 계수 κ (ppm 정수 0…1,000,000). 출시 5,000
  minPoolCredits: number;          // 균열을 뽑는 최소 통 Q_min (크레딧 정수 ≥ 1). 출시 20,000
}

/**
 * 보드 생성 (규칙 7, 명세 16 §7.1): kind ≥ bandedFromKind 종류는 묶음(rowsPerBatch 줄)을 batchCount개의 띠로 나눠 띠마다 정확히 1개,
 * 띠 안쪽 줄(양 끝 bandMargin 줄 제외)에서 차례 표본으로 놓는다. 나머지 종류는 남은 칸에 비복원 추첨.
 * (규칙 8, 명세 21 §3.6) kind ≥ fixedFromKind 종류(CHOG 두 종류)는 띠 안의 **정해진 줄**에 놓는다(칸만 무작위) — catalogFixedRows:
 * 가장 낮은 고정 종류는 띠의 첫 4분의 1 줄(start + ⌊길이 / 4⌋), 그 위 종류는 이미 정한 고정 줄에서 가장 먼 안쪽 줄(같으면 더 아래 줄).
 * 그래서 CHOG Ore는 16~17줄마다 정확히 1개(어느 17줄을 봐도 1개 이상), Golden CHOG는 띠마다 Ore에서 8줄 떨어진 곳.
 * fixedClearKinds 종류(다이아)는 고정 줄에서 fixedClearRows 줄 안(|Δ| ≤ fixedClearRows)에 놓이지 않는다 — 고가 블록이 몰리지 않게.
 */
export interface GenerationRules {
  bandedFromKind: number;    // 이 종류부터 띠 배치 (출시 6 = Emerald)
  bandMargin: number;        // 띠 양 끝 여백 줄 (출시 1)
  fixedFromKind: number;     // 이 종류부터 띠 안 고정 줄 (출시 10 = CHOG Ore; blocks.length면 없음)
  fixedClearRows: number;    // fixedClearKinds 종류는 고정 줄에서 이 줄 수 안에 놓이지 않는다 (출시 2 → 최소 3줄 간격)
  fixedClearKinds: number[]; // 고정 줄을 피하는 띠 종류 (출시 [9] = 다이아)
}

export interface LimitRules {
  queueMax: number;        // 대기열 상한 (10)
  maxTiersPerBuy: number;  // 한 번에 사는 최대 개수 (10)
  timerTicks: number;      // 안전 타이머 (6,000틱 = 200초)
  stuckTicks: number;      // 멈춤 판정 (900틱 = 30초 동안 피해 0)
  batchBlocks: number;     // 블록 묶음 크기 (2,000)
}

/**
 * 시스템 봇 칸 하나 (D104) — 봇은 곡괭이 등급을 가리키지 않고 자기 몸을 따로 적는다.
 * 봇은 내구도·가격·보상이 없다(무제한, 정산 없음). 엔진의 봇 상태 tier = 이 배열의 위치(플레이어 곡괭이의 tier = pickaxes 위치).
 */
export interface BotSpec {
  code: string;              // 화면·도구 표기 (예: "BOT")
  count: number;
  attack: number;            // 공격력 (틱당 블록당 최대 피해)
  scale: number;             // 지름 (칸)
  weight: number;            // 무게 (≥ 0.5) — frictionPerTick을 만들 때 쓴 값(참고, 엔진은 읽지 않음)
  frictionPerTick: number;   // = (friction^(1/fps))^(1/weight), 등급 칸과 같은 규칙
  hitbox: PickaxeHitbox;     // 봇 그림에 맞춘 충돌 모양 (D101)
}

/**
 * 하늘 이벤트 "✨ 별" (D125) — 판 위 플레이어 곡괭이가 minPlayers개 이상이면 가끔 별 1개가 떨어지고,
 * 먼저 닿은(중심 catchRadius 안) 플레이어 곡괭이가 grow.durationTicks 동안 커진다. 돈(공격력·내구도·POP·정산)은 바꾸지 않는다.
 *  - 무작위: 조건이 맞는 윈도의 스트림 `sky`에서 u₁(확률) → 맞으면 u₂(고를 곡괭이)·u₃(처음 vx), 별의 튕김은 `skykick|<id>`.
 * 명세: docs/specs/07-sky-event.md.
 */
export interface SkyEventRules {
  minPlayers: number;          // 판 위 플레이어 곡괭이 수 문턱 (봇 제외)
  chancePerWindow: number;     // 조건이 맞는 윈도마다 떨어질 확률
  cooldownWindows: number;     // 별이 끝난(잡힘·사라짐) 뒤 다음 별까지 쉬는 윈도
  item: {
    diameter: number;          // 별 원 몸 지름 (칸)
    weight: number;            // 참고값 (엔진은 읽지 않는다)
    frictionPerTick: number;   // 원 몸 공기 마찰
    startVy: number;           // 처음 vy (칸/틱, 아래로 +)
    vxJitter: number;          // 처음 vx = (u₃ − ½) × vxJitter
    aboveRows: number;         // 고른 곡괭이 몇 칸 위에서 떨어지나
    catchRadius: number;       // 곡괭이 중심에서 이 거리 안에 별 중심이 들어오면 잡힘 (등급 무관)
    lifeTicks: number;         // 이 틱 안에 안 잡히면 사라짐
  };
  grow: {
    scale: number;             // 효과 중 지름 = max(등급 지름, scale)
    stepPerTick: number;       // 틱당 커지기·줄이기 폭
    durationTicks: number;     // 효과 길이
  };
}

export interface Catalog {
  schema: typeof CATALOG_SCHEMA_ID;
  rulesVersion: number;
  mode: GameMode;
  world: WorldRules;
  physics: PhysicsRules;
  pickaxes: PickaxeTier[];
  blocks: BlockKind[];
  reward: RewardRules;
  lucky: LuckyRules;
  luckyPick?: LuckyPickRules;      // (규칙 10) 없으면 단계 없음
  jackpot?: JackpotRules;          // (규칙 10) 없으면 잭팟 없음
  buffs?: BuffRules;               // (규칙 11) 없으면 성장·버프 없음
  generation: GenerationRules;
  limits: LimitRules;
  bots: BotSpec[];
  skyEvent: SkyEventRules;
}

// ──────────────────────────────────────────────────────────────────────────
// 검증 스키마
// ──────────────────────────────────────────────────────────────────────────
/** REWARD 상한의 위 한계 (가격의 bps) — 체인 카탈로그 공지 검사와 같은 값(tierCapsMilli ≤ 0.97 × 가격, 명세 16 §9.2-9). */
export const MAX_REWARD_CAP_BPS = 9700;
/** 초과분(over) 상한의 위 한계 = 가격 × 이 값 (체인 MAX_OVER_MULTIPLE). */
export const MAX_OVER_MULTIPLE = 100;
/** (규칙 10) reward.totalCapBps의 위 한계 (가격 100배). */
export const MAX_TOTAL_CAP_BPS = 1_000_000;
/** (규칙 10) LUCKY PICK 확률 분모 — per10m은 10,000,000분의 몇. */
export const PICK_PER10M_DENOM = 10_000_000;
/** (규칙 10) LUCKY PICK 단계 수 상한. */
export const MAX_PICK_LEVELS = 16;
/** (규칙 10) 등급별 잭팟 기여의 위 한계 (bps). */
export const MAX_JACKPOT_CONTRIBUTION_BPS = 1000;
/** (규칙 10) kappaPpm의 위 한계 (ppm). */
export const MAX_KAPPA_PPM = 1_000_000;
/** (규칙 11) COMBO 배수표 길이·값 상한. */
export const MAX_COMBO_WEIGHTS = 8;
export const MAX_COMBO_WEIGHT = 100;
/** (규칙 11) popStacks · 버프 횟수 상한. */
export const MAX_GROW_STACKS = 8;
export const MAX_BUFFS_PER_PICKAXE = 8;

const positive = () => z.number().finite().positive();
const nonNegative = () => z.number().finite().nonnegative();
const int = () => z.number().int();

const WorldRulesSchema: z.ZodType<WorldRules> = z.object({
  width: int().min(3),
  height: int().min(3),
  ringBufferRowMultiplier: int().min(2),
  ticksPerWindow: int().min(1),
  spawnOffsetRows: nonNegative(),
  cameraLeadFraction: nonNegative(),
  cameraLerp: positive().max(1),
  botStartY: z.number().finite(),
}).strict();

const PhysicsRulesSchema: z.ZodType<PhysicsRules> = z.object({
  fps: int().positive(),
  bounce: nonNegative().max(1),
  gravity: positive(),
  friction: positive().max(1),
  denominator: positive(),
  minBounceVy: nonNegative(),
  maxSpin: positive(),
  angularDamping: positive().max(1),
  contactFriction: nonNegative(),
  headFirstTorque: nonNegative(),
  spinKick: nonNegative(),
}).strict();

const FIT_EPSILON = 1e-12;
// 서브스텝 한도 = 가장 작은 반지름 → 너무 가늘면 틱당 계산이 커진다
const minRadius = () => z.number().finite().min(0.05);
const HitboxBladeSchema: z.ZodType<HitboxBlade> = z.object({
  pts: z.array(z.tuple([z.number().finite(), z.number().finite()])).min(2).max(8),
  r: minRadius(),
}).strict();
const PickaxeHitboxSchema: z.ZodType<PickaxeHitbox> = z.discriminatedUnion("shape", [
  z.object({ shape: z.literal("circle") }).strict(),
  z.object({
    shape: z.literal("pickaxe"),
    headOffset: nonNegative(),
    handleLength: positive(),
    handleRadius: minRadius(),
    inertia: positive(),
    blade: HitboxBladeSchema,
  }).strict(),
]).superRefine((h, ctx) => {
  if (h.shape !== "pickaxe") return;
  if (h.headOffset > h.handleLength) ctx.addIssue({ code: "custom", message: "hitbox.headOffset must be ≤ handleLength (centre of mass on the handle)" });
  if (h.handleLength - h.headOffset + h.handleRadius > 0.5 + FIT_EPSILON) ctx.addIssue({ code: "custom", message: "hitbox handle must fit in the scale circle (handleLength − headOffset + handleRadius ≤ 0.5)" });
  const { pts, r } = h.blade;
  if (pts.some(([x, y]) => Math.sqrt(x * x + y * y) + r > 0.5 + FIT_EPSILON)) ctx.addIssue({ code: "custom", message: "hitbox blade must fit in the scale circle (|p| + r ≤ 0.5 for every point)" });
  if (!pts.some(([x, y]) => y === 0 && Math.abs(x - (0.5 - r)) <= FIT_EPSILON)) ctx.addIssue({ code: "custom", message: "hitbox blade needs its tip point at (0.5 − r, 0) (axial reach = +0.5, the sprite fit's anchor)" });
});

const PickaxeTierSchema: z.ZodType<PickaxeTier> = z.object({
  tier: int().nonnegative(),
  code: z.string().min(1),
  name: z.string().min(1),
  priceCredits: int().positive(),
  attack: positive(),
  scale: positive(),
  hitbox: PickaxeHitboxSchema,
  weight: z.number().finite().min(0.5),
  durability: positive(),
  frictionPerTick: positive().max(1),
  beta: positive(),
  popPrize: int().nonnegative(),
  bigPopPrize: int().nonnegative(),
  bonusCap: int().nonnegative(),
}).strict();

const BlockKindSchema: z.ZodType<BlockKind> = z.object({
  kind: int().nonnegative(),
  id: z.string().regex(/^[a-z][a-z0-9_]*$/),
  name: z.string().min(1),
  hp: positive(),
  value: positive(),
  batchCount: int().nonnegative(),
  luckyEligible: z.boolean(),
}).strict();

const LuckyLevelsSchema = z.array(z.object({
  multBps: int().min(10_001),
  per10m: int().min(1).max(PICK_PER10M_DENOM),
}).strict()).max(MAX_PICK_LEVELS);
const LuckyPickRulesSchema: z.ZodType<LuckyPickRules> = z.object({
  levels: LuckyLevelsSchema.optional(),              // (규칙 11) byTier와 둘 중 하나 — default 없음
  byTier: z.array(LuckyLevelsSchema).optional(),     // (규칙 11) 등급별
}).strict();

const buffWeight = () => int().min(1);
const buffTicks = () => int().min(1).max(600);
const BuffSpecSchema: z.ZodType<BuffSpec> = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("GIANT"), weight: buffWeight(), scaleBps: int().min(10_000).max(30_000), ticks: buffTicks() }).strict(),
  z.object({ kind: z.literal("DASH"), weight: buffWeight(), speed: positive().max(0.4) }).strict(),
  z.object({ kind: z.literal("SPEED"), weight: buffWeight(), gravityBps: int().min(10_000).max(30_000), ticks: buffTicks() }).strict(),
  z.object({ kind: z.literal("LIFE"), weight: buffWeight(), durabilityBps: int().min(0).max(5000) }).strict(),
]);
const BuffRulesSchema: z.ZodType<BuffRules> = z.object({
  growStepBps: int().min(0).max(5000),
  growMaxStacks: int().min(0).max(MAX_GROW_STACKS),
  scaleCap: z.object({
    mulBps: int().min(10_000).max(30_000),
    tiles: positive().max(3),
  }).strict(),
  lucky: z.object({
    maxPerPickaxe: int().min(0).max(MAX_BUFFS_PER_PICKAXE),
    table: z.array(BuffSpecSchema),
  }).strict(),
}).strict();

const JackpotRulesSchema: z.ZodType<JackpotRules> = z.object({
  kindId: z.string().regex(/^[a-z][a-z0-9_]*$/),
  contributionBpsByTier: z.array(int().min(0).max(MAX_JACKPOT_CONTRIBUTION_BPS)).min(1),
  kappaPpm: int().min(0).max(MAX_KAPPA_PPM),
  minPoolCredits: int().min(1),
}).strict();

const SkyEventRulesSchema: z.ZodType<SkyEventRules> = z.object({
  minPlayers: int().min(1),
  chancePerWindow: positive().lt(1),
  cooldownWindows: int().nonnegative(),
  item: z.object({
    diameter: positive().lt(1),
    weight: positive(),
    frictionPerTick: positive().max(1),
    startVy: z.number().finite(),
    vxJitter: nonNegative(),
    aboveRows: nonNegative(),
    catchRadius: positive(),
    lifeTicks: int().min(1),
  }).strict(),
  grow: z.object({
    scale: positive(),
    stepPerTick: positive(),
    durationTicks: int().min(1),
  }).strict(),
}).strict();

export const CatalogSchema: z.ZodType<Catalog> = z.object({
  schema: z.literal(CATALOG_SCHEMA_ID),
  rulesVersion: int().nonnegative(),
  mode: z.enum(["NORMAL"]),
  world: WorldRulesSchema,
  physics: PhysicsRulesSchema,
  pickaxes: z.array(PickaxeTierSchema).min(1),
  blocks: z.array(BlockKindSchema).min(1),
  reward: z.object({
    rewardCapBps: int().min(1).max(MAX_REWARD_CAP_BPS),
    lastHitMult: nonNegative().max(5),
    lastHitCapBps: int().min(0).max(100_000),
    totalCapBps: int().min(1).max(MAX_TOTAL_CAP_BPS).optional(),   // (규칙 10) default 없음 — 없으면 규칙 9
    combo: z.object({                                                // (규칙 11) default 없음
      weights: z.array(int().min(1).max(MAX_COMBO_WEIGHT)).min(1).max(MAX_COMBO_WEIGHTS),
    }).strict().optional(),
    wholeCredits: z.literal(true).optional(),                        // (규칙 11) default 없음
  }).strict(),
  lucky: z.object({
    share: nonNegative().max(1),
  }).strict(),
  luckyPick: LuckyPickRulesSchema.optional(),   // (규칙 10) default 없음
  jackpot: JackpotRulesSchema.optional(),       // (규칙 10) default 없음
  buffs: BuffRulesSchema.optional(),            // (규칙 11) default 없음
  generation: z.object({
    bandedFromKind: int().min(1),
    bandMargin: int().nonnegative(),
    fixedFromKind: int().min(1),
    fixedClearRows: int().nonnegative(),
    fixedClearKinds: z.array(int().nonnegative()),
  }).strict(),
  limits: z.object({
    queueMax: int().positive(),
    maxTiersPerBuy: int().positive(),
    timerTicks: int().positive(),
    stuckTicks: int().positive(),
    batchBlocks: int().positive(),
  }).strict(),
  bots: z.array(z.object({
    code: z.string().min(1),
    count: int().nonnegative(),
    attack: positive(),
    scale: positive(),
    weight: z.number().finite().min(0.5),
    frictionPerTick: positive().max(1),
    hitbox: PickaxeHitboxSchema,
  }).strict()),
  skyEvent: SkyEventRulesSchema,
}).strict().superRefine((c, ctx) => {
  // 표 안의 순번이 실제 위치와 같아야 한다 (엔진은 배열 위치로 찾는다)
  c.pickaxes.forEach((p, i) => { if (p.tier !== i) ctx.addIssue({ code: "custom", message: `pickaxes[${i}].tier must be ${i}` }); });
  c.blocks.forEach((b, i) => { if (b.kind !== i) ctx.addIssue({ code: "custom", message: `blocks[${i}].kind must be ${i}` }); });
  const total = c.blocks.reduce((s, b) => s + b.batchCount, 0);
  if (total !== c.limits.batchBlocks) ctx.addIssue({ code: "custom", message: `Σ blocks[].batchCount (${total}) must equal limits.batchBlocks (${c.limits.batchBlocks})` });
  if (c.limits.batchBlocks % c.world.width !== 0) ctx.addIssue({ code: "custom", message: "limits.batchBlocks must be a multiple of world.width" });
  const names = new Set(c.blocks.map((b) => b.name));
  if (names.size !== c.blocks.length) ctx.addIssue({ code: "custom", message: "blocks[].name must be unique" });
  const ids = new Set(c.blocks.map((b) => b.id));
  if (ids.size !== c.blocks.length) ctx.addIssue({ code: "custom", message: "blocks[].id must be unique" });
  for (const p of c.pickaxes) if (p.scale > c.world.width - 2) ctx.addIssue({ code: "custom", message: `pickaxes[${p.tier}].scale exceeds world.width − 2` });
  c.bots.forEach((b, i) => { if (b.scale > c.world.width - 2) ctx.addIssue({ code: "custom", message: `bots[${i}].scale exceeds world.width − 2` }); });
  // (규칙 7) 보너스 상한 = POP + BIG POP, 초과분 상한 ≤ 체인 MAX_OVER_MULTIPLE × 가격 (명세 16 §8.1-8)
  // (규칙 11) COMBO가 있으면 BIG POP 없음 ∧ bonusCap ≥ popPrize × weights[0], 배수표는 줄지 않음
  const combo = c.reward.combo;
  if (combo) combo.weights.forEach((w, i) => {
    if (i > 0 && w < combo.weights[i - 1]!) ctx.addIssue({ code: "custom", message: `reward.combo.weights[${i}] must be ≥ weights[${i - 1}] (non-decreasing)` });
  });
  for (const p of c.pickaxes) {
    if (combo) {
      if (p.bigPopPrize !== 0) ctx.addIssue({ code: "custom", message: `pickaxes[${p.tier}].bigPopPrize must be 0 when reward.combo is set` });
      if (p.bonusCap < p.popPrize * combo.weights[0]!) ctx.addIssue({ code: "custom", message: `pickaxes[${p.tier}].bonusCap must be ≥ popPrize × reward.combo.weights[0]` });
    } else if (p.bonusCap !== p.popPrize + p.bigPopPrize) ctx.addIssue({ code: "custom", message: `pickaxes[${p.tier}].bonusCap must equal popPrize + bigPopPrize` });
    const over = catalogOverCapMilli(c, p.tier);
    if (over > MAX_OVER_MULTIPLE * p.priceCredits * 1000) ctx.addIssue({ code: "custom", message: `pickaxes[${p.tier}]: over-price cap ${over} milli exceeds ${MAX_OVER_MULTIPLE} × price` });
  }
  // (규칙 7) 띠 생성: 띠 종류마다 ⌊rowsPerBatch / c_k⌋ ≥ 2·margin + 1, 띠 종류 수 < width
  const g = c.generation;
  if (g.bandedFromKind >= c.blocks.length) ctx.addIssue({ code: "custom", message: "generation.bandedFromKind must be < blocks.length" });
  else {
    const rowsPerBatch = Math.floor(c.limits.batchBlocks / c.world.width);
    if (c.blocks.length - g.bandedFromKind >= c.world.width) ctx.addIssue({ code: "custom", message: "generation: banded kinds must be fewer than world.width" });
    let bandsOk = true;
    for (let k = g.bandedFromKind; k < c.blocks.length; k++) {
      const n = c.blocks[k]!.batchCount;
      if (n < 1 || Math.floor(rowsPerBatch / n) < 2 * g.bandMargin + 1) {
        bandsOk = false;
        ctx.addIssue({ code: "custom", message: `generation: blocks[${k}] band too short (⌊${rowsPerBatch} / ${n}⌋ < 2 × bandMargin + 1)` });
      }
    }
    // (규칙 8) 고정 줄: bandedFromKind ≤ fixedFromKind ≤ blocks.length, 피하는 종류는 고정이 아닌 띠 종류, 피한 뒤에도 띠마다 안쪽 줄이 남아야 한다
    if (g.fixedFromKind < g.bandedFromKind || g.fixedFromKind > c.blocks.length) ctx.addIssue({ code: "custom", message: "generation.fixedFromKind must be in [bandedFromKind, blocks.length]" });
    else if (new Set(g.fixedClearKinds).size !== g.fixedClearKinds.length || g.fixedClearKinds.some((k) => k < g.bandedFromKind || k >= g.fixedFromKind)) {
      ctx.addIssue({ code: "custom", message: "generation.fixedClearKinds must be distinct banded kinds below fixedFromKind" });
    } else if (bandsOk) {
      const fixed = catalogFixedRows(c);
      for (const k of g.fixedClearKinds) {
        const n = c.blocks[k]!.batchCount;
        for (let i = 0; i < n; i++) {
          const [s0, e0] = bandOf(i, n, rowsPerBatch);
          let free = 0;
          for (let r = s0 + g.bandMargin; r < e0 - g.bandMargin; r++) if (clearOfFixedRows(c, r, fixed)) free += 1;
          if (free === 0) { ctx.addIssue({ code: "custom", message: `generation: blocks[${k}] band ${i} has no row ≥ ${g.fixedClearRows + 1} rows away from the fixed rows` }); break; }
        }
      }
    }
  }
  // LUCKY: 뽑을 풀이 비면 안 된다 (luckyEligible이고 batchCount > 0인 종류가 하나 이상). 개수 0인 종류는 뽑히지 않는다
  if (luckyPoolCount(c) <= 0) ctx.addIssue({ code: "custom", message: "lucky: at least one blocks[] entry must be luckyEligible with batchCount > 0" });
  // (규칙 10, 명세 23 §2) 총 상한·사다리·잭팟
  const tc = c.reward.totalCapBps;
  if (tc !== undefined && tc < c.reward.rewardCapBps) ctx.addIssue({ code: "custom", message: "reward.totalCapBps must be ≥ reward.rewardCapBps" });
  if (c.luckyPick) {
    const { levels, byTier } = c.luckyPick;
    // 사다리 한 줄 검사 — tiers = 그 줄을 쓰는 등급(levels는 전부, byTier[t]는 t만)
    const checkLevels = (lv: LuckyLevel[], path: string, tiers: number[]) => {
      let sum = 0;
      lv.forEach((l, i) => {
        sum += l.per10m;
        if (i > 0 && l.multBps <= lv[i - 1]!.multBps) ctx.addIssue({ code: "custom", message: `${path}[${i}].multBps must be strictly ascending` });
        if (tc !== undefined) {
          if (l.multBps > tc) ctx.addIssue({ code: "custom", message: `${path}[${i}].multBps must be ≤ reward.totalCapBps` });
        } else {
          // 총 상한이 없으면(규칙 9 상한) 등급마다 바닥 ≤ catalogTotalCapMilli
          for (const t of tiers) if (catalogPickFloorMilli(c, t, l.multBps) > catalogTotalCapMilli(c, t)) {
            ctx.addIssue({ code: "custom", message: `${path}[${i}].multBps exceeds the total cap of pickaxes[${t}] (set reward.totalCapBps)` });
            break;
          }
        }
      });
      if (sum > PICK_PER10M_DENOM) ctx.addIssue({ code: "custom", message: `${path}: Σ levels[].per10m (${sum}) must be ≤ ${PICK_PER10M_DENOM}` });
    };
    if ((levels === undefined) === (byTier === undefined)) {
      ctx.addIssue({ code: "custom", message: "luckyPick: exactly one of levels or byTier is required" });
    } else if (levels) {
      checkLevels(levels, "luckyPick.levels", c.pickaxes.map((p) => p.tier));
    } else if (byTier) {
      if (byTier.length !== c.pickaxes.length) ctx.addIssue({ code: "custom", message: `luckyPick.byTier must have one entry per pickaxe tier (${c.pickaxes.length})` });
      byTier.forEach((lv, t) => { if (t < c.pickaxes.length) checkLevels(lv, `luckyPick.byTier[${t}]`, [t]); });
    }
  }
  if (c.buffs) {
    const kinds = new Set(c.buffs.lucky.table.map((b) => b.kind));
    if (kinds.size !== c.buffs.lucky.table.length) ctx.addIssue({ code: "custom", message: "buffs.lucky.table[].kind must be unique" });
  }
  if (c.jackpot) {
    const j = c.jackpot;
    if (!c.blocks.some((b) => b.id === j.kindId)) ctx.addIssue({ code: "custom", message: `jackpot.kindId (${j.kindId}) must be a blocks[].id` });
    if (j.contributionBpsByTier.length !== c.pickaxes.length) ctx.addIssue({ code: "custom", message: `jackpot.contributionBpsByTier must have one entry per pickaxe tier (${c.pickaxes.length})` });
    let maxPrice = 0;
    for (const p of c.pickaxes) if (p.priceCredits > maxPrice) maxPrice = p.priceCredits;
    if (BigInt(j.kappaPpm) * BigInt(maxPrice) >= BigInt(j.minPoolCredits) * 1_000_000n) {
      ctx.addIssue({ code: "custom", message: "jackpot: kappaPpm × max price must be < minPoolCredits × 10⁶ (crack chance < 1 once the pool reaches minPool)" });
    }
  }
  // (D125) 커진 몸도 판 폭 안에서 움직일 수 있어야 한다 (등급 지름과 같은 한도)
  if (c.skyEvent && c.skyEvent.grow.scale > c.world.width - 2) ctx.addIssue({ code: "custom", message: "skyEvent.grow.scale exceeds world.width − 2" });
});

/** 카탈로그 JSON을 검사해 돌려준다. 틀리면 이유를 모두 담은 오류를 던진다. */
export function parseCatalog(input: unknown): Catalog {
  return CatalogSchema.parse(input);
}

/** n줄을 c개의 띠로 나눴을 때 띠 i = [start, end) (앞의 n mod c개 띠가 한 줄 더 길다). 엔진 board.ts가 다시 내보낸다. */
export function bandOf(i: number, c: number, n: number): [number, number] {
  const base = Math.floor(n / c);
  const extra = n - base * c;
  const start = i * base + Math.min(i, extra);
  return [start, start + base + (i < extra ? 1 : 0)];
}

/**
 * (규칙 8, 명세 21 §3.6) 고정 줄: rows[k][i] = 고정 종류 k의 띠 i에서 그 블록이 놓이는 묶음 안 줄 번호 (고정이 아닌 종류는 []).
 * 종류를 fixedFromKind부터 올라가며: 첫 종류는 띠의 첫 4분의 1 줄(start + ⌊길이 / 4⌋ — 새 판의 첫 화면 위쪽, 폰 안내 카드에도 안 가림),
 * 그다음 종류는 띠 안쪽 줄 중 이미 정한 고정 줄(앞뒤 묶음 포함)에서 가장 먼 줄 — 거리가 같으면 더 아래(깊은) 줄. 아래 줄을 고르는 까닭:
 * 새 세계의 첫 화면에 늘 같은 자리의 Golden CHOG가 있으면 숙련자 타이밍 이득(오라클 S1)이 커진다(명세 21 §3.6) — 첫 Golden은 30줄.
 * 정수만 쓰는 결정 규칙(시드와 무관), 칸은 엔진이 줄 스트림으로 고른다.
 * 출시 카탈로그: CHOG Ore 4 · 21 · 38 · 55 · 72 · 89 · 106 · 123 · 140 · 156 · 172 · 188, Golden CHOG 30 · 64 · 115 · 148 · 196.
 */
export function catalogFixedRows(catalog: Pick<Catalog, "blocks" | "generation" | "limits" | "world">): number[][] {
  const n = Math.floor(catalog.limits.batchBlocks / catalog.world.width);
  const { bandMargin, fixedFromKind } = catalog.generation;
  const rows: number[][] = catalog.blocks.map(() => []);
  const placed: number[] = [];
  for (let k = fixedFromKind; k < catalog.blocks.length; k++) {
    const c = catalog.blocks[k]!.batchCount;
    const own: number[] = [];
    for (let i = 0; i < c; i++) {
      const [s, e] = bandOf(i, c, n);
      if (placed.length === 0) { own.push(s + Math.floor((e - s) / 4)); continue; }
      let best = -1;
      let bestD = -1;
      for (let r = s + bandMargin; r < e - bandMargin; r++) {
        let d = Infinity;
        for (const p of placed) d = Math.min(d, Math.abs(r - p), Math.abs(r - p - n), Math.abs(r - p + n));
        if (d >= bestD) { best = r; bestD = d; }   // 같으면 더 아래 줄
      }
      own.push(best);
    }
    rows[k] = own;
    placed.push(...own);
  }
  return rows;
}

/**
 * (규칙 8) 묶음 안 줄 r이 모든 고정 줄(앞뒤 묶음 포함)에서 fixedClearRows 줄보다 멀리 있나 — fixedClearKinds 종류가 놓일 수 있는 줄.
 * fixed = catalogFixedRows(catalog)를 미리 구해 넘기면 다시 계산하지 않는다(엔진 drawRow).
 */
export function clearOfFixedRows(catalog: Pick<Catalog, "blocks" | "generation" | "limits" | "world">, r: number, fixed: readonly (readonly number[])[] = catalogFixedRows(catalog)): boolean {
  const n = Math.floor(catalog.limits.batchBlocks / catalog.world.width);
  const d = catalog.generation.fixedClearRows;
  for (const own of fixed) {
    for (const f of own) if (Math.abs(r - f) <= d || Math.abs(r - f - n) <= d || Math.abs(r - f + n) <= d) return false;
  }
  return true;
}

/** LUCKY 풀 = luckyEligible 종류의 batchCount 합 (LUCKY 종류 뽑기의 분모, 엔진 drawLuckyKind·luckyRateMilli와 같은 값). */
export function luckyPoolCount(catalog: Pick<Catalog, "blocks">): number {
  let n = 0;
  for (const b of catalog.blocks) if (b.luckyEligible) n += b.batchCount;
  return n;
}

/**
 * 곡괭이 1개 정산 상한 공식 (밀리크레딧) — 엔진·검증기·배포·체인 공지가 모두 이 함수를 쓴다(공식을 한 곳에만 둔다).
 *  기본 천장  = floor(β_t × max(value) × D × 1000)
 *  LUCKY 천장 = floor(share × LUCKY 풀 ÷ min(뽑힐 수 있는 종류의 batchCount > 0) × 가격 × 1000)  (가장 드문 행운 종류에 D를 모두 준 경우)
 *  REWARD 상한 = floor(가격 × 1000 × rewardCapBps ÷ 10,000)
 *  막타 상한  = floor(가격 × 1000 × lastHitCapBps ÷ 10,000)  (규칙 9)
 *  over 상한  = 기본 천장 + LUCKY 천장 + bonusCap × 1000 + 막타 상한 − REWARD 상한 (0 미만이면 0)
 */
export function catalogBaseCeilingMilli(catalog: Catalog, tier: number): number {
  const p = catalog.pickaxes[tier];
  if (!p) throw new Error(`unknown tier ${tier}`);
  let vMax = 0;
  for (const b of catalog.blocks) if (b.value > vMax) vMax = b.value;
  return Math.floor(p.beta * vMax * catalogDurabilityMax(catalog, tier) * 1000);
}
export function catalogLuckyCeilingMilli(catalog: Catalog, tier: number): number {
  const p = catalog.pickaxes[tier];
  if (!p) throw new Error(`unknown tier ${tier}`);
  let minCount = Infinity;
  for (const b of catalog.blocks) if (b.luckyEligible && b.batchCount > 0 && b.batchCount < minCount) minCount = b.batchCount;
  if (!Number.isFinite(minCount) || catalog.lucky.share <= 0) return 0;
  // (규칙 11) LIFE로 늘어난 내구도까지: × Dmax / D (LIFE 없으면 1 — 규칙 10과 비트까지 같음)
  const dMax = catalogDurabilityMax(catalog, tier);
  const life = dMax === p.durability ? 1 : dMax / p.durability;
  return Math.floor(((catalog.lucky.share * luckyPoolCount(catalog)) / minCount) * p.priceCredits * life * 1000);
}
export function catalogRewardCapMilli(catalog: Catalog, tier: number): number {
  const p = catalog.pickaxes[tier];
  if (!p) throw new Error(`unknown tier ${tier}`);
  return Math.floor((p.priceCredits * 1000 * catalog.reward.rewardCapBps) / 10000);
}
export function catalogLastHitCapMilli(catalog: Catalog, tier: number): number {
  const p = catalog.pickaxes[tier];
  if (!p) throw new Error(`unknown tier ${tier}`);
  return Math.floor((p.priceCredits * 1000 * catalog.reward.lastHitCapBps) / 10000);
}
/**
 * (규칙 9) 막타 상금 (밀리크레딧) = floor(lastHitMult × β_t × value_k × attack_t × 1000) — 곱 순서 고정(실수 결정론).
 * 한 방에 깨지는 블록(hp_k ≤ attack_t, 카탈로그 값)은 0. 상한(catalogLastHitCapMilli) 적용 전 값이다.
 */
export function catalogLastHitMilli(catalog: Catalog, tier: number, kind: number): number {
  const p = catalog.pickaxes[tier];
  const b = catalog.blocks[kind];
  if (!p || !b) throw new Error(`unknown tier ${tier} or kind ${kind}`);
  if (b.hp <= p.attack) return 0;
  return Math.floor(catalog.reward.lastHitMult * p.beta * b.value * p.attack * 1000);
}
/** 규칙 9 over 상한 (위 공식 그대로). 규칙 10 카탈로그(totalCapBps 있음)에서는 catalogOverCapMilli가 쓰지 않는다. */
function rules9OverCapMilli(catalog: Catalog, tier: number): number {
  const p = catalog.pickaxes[tier];
  if (!p) throw new Error(`unknown tier ${tier}`);
  return Math.max(0, catalogBaseCeilingMilli(catalog, tier) + catalogLuckyCeilingMilli(catalog, tier) + p.bonusCap * 1000
    + catalogLastHitCapMilli(catalog, tier) - catalogRewardCapMilli(catalog, tier));
}
/**
 * over 상한 (밀리크레딧, 잭팟 제외).
 *  규칙 10 (reward.totalCapBps 있음): 총 상한 − REWARD 상한 (출시 40·P − 0.9·P = 39.1·P, 명세 23 §3.2·§6.4)
 *  규칙 9 (없음): 기본 천장 + LUCKY 천장 + bonusCap × 1000 + 막타 상한 − REWARD 상한 (0 미만이면 0)
 * 엔진 가드: over ≤ catalogOverCapMilli + J(그 곡괭이의 잭팟).
 */
export function catalogOverCapMilli(catalog: Catalog, tier: number): number {
  if (catalog.reward.totalCapBps === undefined) return rules9OverCapMilli(catalog, tier);
  return catalogTotalCapMilli(catalog, tier) - catalogRewardCapMilli(catalog, tier);
}

// ──────────────────────────────────────────────────────────────────────────
// 규칙 10 (명세 23): 총 상한 · LUCKY PICK 사다리 · 골든 CHOG 잭팟. 세 칸이 없으면 규칙 9와 같다.
// 정수 밀리크레딧, 확률 비교는 BigInt만(u53 = BigInt(rng.next() × 2⁵³), 0 ≤ u53 < 2⁵³).
// ──────────────────────────────────────────────────────────────────────────
const TWO53 = 1n << 53n;

function tierPriceMilli(catalog: Pick<Catalog, "pickaxes">, tier: number): number {
  const p = catalog.pickaxes[tier];
  if (!p) throw new Error(`unknown tier ${tier}`);
  return p.priceCredits * 1000;
}
function checkU53(u53: bigint): void {
  if (typeof u53 !== "bigint" || u53 < 0n || u53 >= TWO53) throw new Error(`u53 out of range: ${String(u53)}`);
}

/**
 * 곡괭이 1개 총 상한 C (밀리크레딧, 잭팟 제외).
 *  규칙 10: ⌊가격밀리 × totalCapBps / 10,000⌋ · 규칙 9(totalCapBps 없음): REWARD 상한 + 규칙 9 over 상한.
 */
export function catalogTotalCapMilli(catalog: Catalog, tier: number): number {
  const tc = catalog.reward.totalCapBps;
  if (tc === undefined) return catalogRewardCapMilli(catalog, tier) + rules9OverCapMilli(catalog, tier);
  return Math.floor((tierPriceMilli(catalog, tier) * tc) / 10000);
}

/** (규칙 11) 그 등급의 LUCKY PICK 사다리 — byTier[tier]가 먼저, 없으면 levels, 둘 다 없으면 []. */
function pickLevelsOf(catalog: Catalog, tier: number): readonly LuckyLevel[] {
  if (!catalog.pickaxes[tier]) throw new Error(`unknown tier ${tier}`);
  const lp = catalog.luckyPick;
  if (!lp) return [];
  if (lp.byTier) return lp.byTier[tier] ?? [];
  return lp.levels ?? [];
}

/**
 * LUCKY PICK 단계 뽑기 (명세 23 §3.1): index = ⌊u53 × 10⁷ / 2⁵³⌋, per10m 누적표에서 index < 누적인 첫 단계의 multBps.
 * 없으면(마지막 누적 이상 · luckyPick 없음 · levels 빈 배열) 0. (규칙 11) 사다리 = byTier[tier] 먼저, 없으면 levels.
 */
export function catalogPickLevelBps(catalog: Catalog, u53: bigint, tier: number): number {
  checkU53(u53);
  const levels = pickLevelsOf(catalog, tier);
  if (!levels || levels.length === 0) return 0;
  const index = (u53 * BigInt(PICK_PER10M_DENOM)) >> 53n;
  let cum = 0n;
  for (const l of levels) {
    cum += BigInt(l.per10m);
    if (index < cum) return l.multBps;
  }
  return 0;
}

/** 사다리 바닥 F = ⌊가격밀리 × bps / 10,000⌋ (bps 0 → 0). */
export function catalogPickFloorMilli(catalog: Catalog, tier: number, bps: number): number {
  if (!Number.isInteger(bps) || bps < 0) throw new Error(`bad pick level ${bps}`);
  return Math.floor((tierPriceMilli(catalog, tier) * bps) / 10000);
}

/** 잭팟 블록 종류 번호 (jackpot.kindId의 blocks 위치). 잭팟이 없으면 −1. */
export function catalogJackpotKind(catalog: Catalog): number {
  const j = catalog.jackpot;
  if (!j) return -1;
  return catalog.blocks.findIndex((b) => b.id === j.kindId);
}

/**
 * 등급별 잭팟 기여율 (bps) — 기여율을 읽는 유일한 곳. 잭팟이 없으면 0.
 * (나중에 다른 모양 — 등급 칸 덮어쓰기 등 — 이 생기면 여기만 고친다.)
 */
function jackpotContributionBps(catalog: Catalog, tier: number): number {
  const j = catalog.jackpot;
  if (!j) return 0;
  const bps = j.contributionBpsByTier[tier];
  if (bps === undefined) throw new Error(`unknown tier ${tier}`);
  return bps;
}

/** 소환 때 통에 더하는 몫 = ⌊가격밀리 × contributionBpsByTier[tier] / 10,000⌋. 잭팟이 없으면 0. */
export function catalogJackpotContributionMilli(catalog: Catalog, tier: number): number {
  const price = tierPriceMilli(catalog, tier);
  return Math.floor((price * jackpotContributionBps(catalog, tier)) / 10000);
}

/** 균열을 뽑는 최소 통 (밀리크레딧) = minPoolCredits × 1000. 잭팟이 없으면 0(catalogCrack은 늘 false). */
export function catalogJackpotMinPoolMilli(catalog: Catalog): number {
  return catalog.jackpot ? catalog.jackpot.minPoolCredits * 1000 : 0;
}

/**
 * 균열 판정 (명세 23 §4.2): 통 ≥ minPool ∧ u53 × poolMilli × 10⁶ < kappaPpm × 가격밀리 × 2⁵³ — BigInt만.
 * 잭팟이 없거나 통 < minPool이면 false. poolMilli는 안전 정수(≥ 0)여야 한다.
 */
export function catalogCrack(catalog: Catalog, tier: number, poolMilli: number, u53: bigint): boolean {
  checkU53(u53);
  if (!Number.isSafeInteger(poolMilli) || poolMilli < 0) throw new Error(`bad poolMilli ${poolMilli}`);
  const j = catalog.jackpot;
  const price = tierPriceMilli(catalog, tier);
  if (!j || poolMilli < catalogJackpotMinPoolMilli(catalog)) return false;
  return u53 * BigInt(poolMilli) * 1_000_000n < BigInt(j.kappaPpm) * BigInt(price) * TWO53;
}

/** 한 대 균열 확률 (화면용 실수) = κ × 가격 ÷ 통 (통 < minPool · 잭팟 없음 → 0). 엔진은 쓰지 않는다. */
export function catalogCrackChance(catalog: Catalog, tier: number, poolMilli: number): number {
  const j = catalog.jackpot;
  const price = tierPriceMilli(catalog, tier);
  if (!j || !(poolMilli >= catalogJackpotMinPoolMilli(catalog)) || poolMilli <= 0) return 0;
  return Math.min(1, (j.kappaPpm * price) / (poolMilli * 1_000_000));
}

/** /rules 사다리 표 한 줄: oneIn = round(10⁷ / per10m), atLeastPer10m = 이 단계 이상 per10m 합. */
export interface PickTableRow {
  multBps: number;
  per10m: number;
  oneIn: number;
  atLeastPer10m: number;
}
/** LUCKY PICK 표 (카탈로그 순서 = multBps 오름차순). luckyPick이 없으면 []. (규칙 11) 그 등급의 사다리. */
export function catalogPickTable(catalog: Catalog, tier: number): PickTableRow[] {
  const levels = pickLevelsOf(catalog, tier);
  const rows: PickTableRow[] = [];
  let tail = 0;
  for (let i = levels.length - 1; i >= 0; i--) {
    const l = levels[i]!;
    tail += l.per10m;
    rows.unshift({ multBps: l.multBps, per10m: l.per10m, oneIn: Math.round(PICK_PER10M_DENOM / l.per10m), atLeastPer10m: tail });
  }
  return rows;
}

// ──────────────────────────────────────────────────────────────────────────
// 규칙 11 (명세 24 §4): COMBO · 성장 · LUCKY 버프. 칸이 없으면 규칙 10과 같다.
// ──────────────────────────────────────────────────────────────────────────

/** COMBO가 켜져 있나 (reward.combo 있음). */
export function catalogHasCombo(catalog: Catalog): boolean {
  return catalog.reward.combo !== undefined;
}

/**
 * COMBO 상금 (밀리크레딧) = popPrize × weights[min(s − 2, 길이 − 1)] × 1000. combo가 없거나 s < 2면 0.
 * bonusCap 적용 전 값이다(엔진 grantBonusMilli가 자른다).
 */
export function catalogComboPrizeMilli(catalog: Catalog, tier: number, streak: number): number {
  const p = catalog.pickaxes[tier];
  if (!p) throw new Error(`unknown tier ${tier}`);
  if (!Number.isInteger(streak)) throw new Error(`bad streak ${streak}`);
  const combo = catalog.reward.combo;
  if (!combo || streak < 2) return 0;
  const w = combo.weights[Math.min(streak - 2, combo.weights.length - 1)]!;
  return p.popPrize * w * 1000;
}

/**
 * LUCKY 버프 종류 뽑기: index = (u53 × Σweight) >> 53, 표 순서 누적 weight에서 index < 누적인 첫 칸.
 * buffs가 없거나 표가 비면 null.
 */
export function catalogBuffKind(catalog: Catalog, u53: bigint): BuffSpec | null {
  checkU53(u53);
  const table = catalog.buffs?.lucky.table;
  if (!table || table.length === 0) return null;
  let total = 0n;
  for (const b of table) total += BigInt(b.weight);
  const index = (u53 * total) >> 53n;
  let cum = 0n;
  for (const b of table) {
    cum += BigInt(b.weight);
    if (index < cum) return b;
  }
  return null;
}

/** 지름 상한 = min(등급 지름 × scaleCap.mulBps / 10⁴, scaleCap.tiles). buffs가 없으면 등급 지름. */
export function catalogScaleCap(catalog: Catalog, tier: number): number {
  const p = catalog.pickaxes[tier];
  if (!p) throw new Error(`unknown tier ${tier}`);
  const b = catalog.buffs;
  if (!b) return p.scale;
  return Math.min((p.scale * b.scaleCap.mulBps) / 10000, b.scaleCap.tiles);
}

/**
 * 최대 내구도 = D + maxPerPickaxe × ⌊D × LIFE.durabilityBps / 10⁴⌋ (LIFE를 모두 뽑은 경우, 엔진의 한 번 더하기와 같은 내림).
 * buffs·LIFE가 없으면 D.
 */
export function catalogDurabilityMax(catalog: Catalog, tier: number): number {
  const p = catalog.pickaxes[tier];
  if (!p) throw new Error(`unknown tier ${tier}`);
  const b = catalog.buffs;
  const life = b?.lucky.table.find((x) => x.kind === "LIFE");
  if (!b || !life || life.kind !== "LIFE") return p.durability;
  return p.durability + b.lucky.maxPerPickaxe * Math.floor((p.durability * life.durabilityBps) / 10000);
}
