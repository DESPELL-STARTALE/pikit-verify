// 밸런스 대조 (규칙 7, D137 — docs/specs/16-rules7.md §8.7, 결과 docs/rules7-balance.md · 규칙 9: 막타 표, E에 막타 포함): 실제 엔진(createRoom/runWindow, 봇 포함)을
// 시드 여러 개로 돌려 잰다. 측정 정의는 스크래치 키트 `_analysis/sim-rules7-2026-10-12/`(r7.mjs·calib.mjs)와 같다.
//   pnpm --filter @pikit/engine balance -- [--seeds=40] [--pickaxes=60] [--players=1,3,8] [--workers=3] [--seedoff=0] [--catalog=normal|<json 경로>] [--feel]
//     (기본) 방: 플레이어 n명(쉬지 않음, 앞 곡괭이가 끝난 다음 윈도에 무작위 등급 1개) + 카탈로그 봇. 방 크기마다 등급별 RTP·POP·BIG POP·배수 분포·
//            초과분(over)·수명·초당 타격, 틱 끝 박힘(중심이 살아 있는 블록 안)·관통(한 틱 이동 선분이 살아 있는 블록을 지남), 노출 다이아 분포
//     --skilled [--windows=600] [--every=20] [--rolls=24] [--warmup=0] [--warmplayers=8]  오라클 순간(w > 60, every 윈도마다)에서 등급마다 rolls번 "지금 사면" 굴림(롤 시드만 다름 =
//            앞으로의 줄·튕김·스폰·LUCKY). 앞 16번 = 추정, 뒤 8번 = 측정 → κ5·κ1·κ 상한·κ_board, "다이아 노출 때만 사기", 노출 다이아 분포
//     --day [--days=10]  무료 하루(10,000 크레딧, ×1만 파산(< 1,000)까지). 시드마다 하루를 days개 **끝까지** 돈다(잘린 마지막 날 없음 — 명세 §8.7)
//     --f9  등급마다 rewardCapBps/1e4 + E[over]/price ≤ 0.98, over 상한 ≤ 100 × 가격, rewardCapBps ≤ 9700 (명세 §4.5). 넘으면 종료 1 (기본 3인 방)
// LUCKY: 행운 종류 X는 물리와 무관하게 뽑히므로(`lucky|<키>`) 곡괭이의 종류별 피해 d_k를 알면 X에 대한 기대값을 정확히 낼 수 있다(명세 §4.8):
//   E_X[LUCKY] = share × 가격 × (뽑힐 수 있는 종류에 준 피해 ÷ D), E_X[over] = Σ_k odds_k × max(0, 기본 + 보너스 + rate_k × d_k − REWARD 상한)
//   (k = luckyWeight > 0인 종류, odds_k = luckyWeight_k ÷ Σw — 규칙 12, 명세 25 §3.2: 출시 흙~다이아 1씩, CHOG 두 종류 0).
// 종류는 id로 찾는다(다이아 = "diamond", 금 = "gold", CHOG = "chog"·"chog_gold") — 번호를 박아 두지 않는다.
//   "LUCKY 기대값" 열·κ·F-9는 이 값을 쓴다(평균은 실현 값과 같고 분산만 작다 — 드문 행운 다이아 하나가 표본 평균을 흔들지 않게). 분포 열은 실현 값.
//   d_k는 PhysicsEngine.advancePickaxe가 돌려주는 피해 목록을 감싸 센다(엔진 코드는 그대로, 이 도구 프로세스 안에서만).
// (규칙 10, 명세 23 · 계획 §4.2 W2 ③) LUCKY PICK 사다리는 물리와 무관하게 뽑히므로(`pick|<키>`) 곡괭이의 바탕 값 X(정상) 또는 V(비정상)를 알면
//   E_ladder[T_main] = Σ_l p_l × min(C, max(x, F_l)) + (1 − L) × min(C, x) 를 정확히 낸다(LUCKY 종류 기대와 함께 — tMainExp).
//   잭팟은 장기적으로 기여가 모두 나가므로(α > 1, 명세 23 §4.4) RTP 몫 = 등급 기여율 x_t = contributionBpsByTier[t] / 10⁴ (방 전체 = 가격 가중 평균).
//   "RTP (ladder at expectation + x_t)" 열이 G1 기준 값이다. R = T_main/P 분포는 닫힌식 혼합 P(R < r) = mean_i [x_i < r] × (1 − Σ_{m_k ≥ r} p_k).
//   --skilled는 κ × 골든 타격 수(통 크기와 무관한 잭팟 기대 상한, 명세 23 §4.3)를 더한 S5·S1 열을 낸다. --f9는 규칙 10 카탈로그면 F-9′.
// (규칙 11, 명세 24 §5.2 G1) 사다리는 등급마다(luckyPick.byTier[t] 먼저, 없으면 levels), wholeCredits면 T_main 기대도 정수 크레딧으로 내린다.
//   LUCKY 기대는 카탈로그 D로 나눈다(LIFE가 늘린 D_total이 아니라 — 엔진 지급률 luckyRateMilli와 같은 분모, LIFE의 추가 타격도 그대로 센다).
//   방 표에 COMBO(곡괭이당 단계 · s ≥ 3 · 최장 · bonusCap 닿음 · 지급 몫) · 버프(종류별 수 · LIFE 몫 · 최대 지름, 하늘 효과 틱 제외 · 상한 넘음) ·
//   소수 정산 건수(wholeCredits면 0이어야 함) · 등급 분포 목표(3등급이면 명세 24 §3.18, 아니면 가장 싼 등급의 규칙 10 띠) 표가 붙는다.
//   --feel  느낌 지표(키트 _analysis/r4-feedback/physics-probe.mjs와 같은 정의, 플레이어 몸의 advancePickaxe 직후 상태):
//           튐 높이 = 위로 가기 시작한 y − 꼭대기 y (0.02칸 넘는 것만), 낙하 속도 = vy > 0인 틱의 vy × fps, 수명 = (끝 틱 − 스폰 틱 + 1) ÷ fps.
//           G1 기준(명세 24 §3.3): 가장 싼 등급 튐 p50 ≥ 1.2칸 · 1칸 이상 튐 ≥ 55 % · 낙하 p50 ≥ 2.4칸/초 · 수명 p50 12~20 s.
// (규칙 12, 명세 25 §5.2 G1) 방 표에 아이템(막타 룰렛 — 곡괭이당 종류별 · 트리거 블록별 · LIFE 몫) · 유예 곡괭이(룰렛 대기가 끝을 미룬 곡괭이) ·
//   LIFE 되살아남(내구도 0 → LIFE로 > 0) · 2×2(1,000줄당 생성 · 막타) · LUCKY 뽑힌 종류 분포 · 불변식 위반(아이템 대기 · 2×2 네 칸 체력 · 수명 > 타이머 + R)이 붙는다.
// 결과: 표(마크다운)를 stdout에.
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { isMainThread, parentPort, Worker, workerData } from "node:worker_threads";
import {
  BUFF_KINDS, catalogLastHitMilli, catalogPickFloorMilli, catalogScaleCap, catalogTotalCapMilli, catalogLuckyMultLevels, catalogLuckyShare, luckyPoolCount, MAX_OVER_MULTIPLE, MAX_REWARD_CAP_BPS,
  parseCatalog, type BuffKind, type Catalog, type EngineInput, type LuckyLevel,
} from "@pikit/protocol";
import {
  cloneRoom, createRoom, getActiveBlockFromRingBuffer, luckyRateMilli, overCapMilli, PhysicsEngine, rewardCapMilli, runWindow, Xoshiro128ss,
  type PickaxeResult, type PickaxeState, type RoomState,
} from "../../src/index.js";
import { seedFrom, windowFactory } from "../helpers.js";

type Mode = "room" | "skilled" | "day" | "f9";

export interface Options {
  mode: Mode;
  seeds: number;
  seedoff: number;
  pickaxes: number;
  players: number[];
  workers: number;
  catalog: string;
  windows: number;
  every: number;
  rolls: number;
  days: number;
  warmup: number;       // (규칙 8, 명세 21 §3.7) 오라클 전에 판을 미리 파는 윈도 수의 바탕 W — 시드마다 W + (seed × 37 mod W)윈도 (0이면 새 판만 잰다)
  warmplayers: number;  // 미리 파는 동안의 플레이어 수 (무작위 등급, 쉬지 않음)
  feel: boolean;        // (규칙 11) 느낌 지표 (튐 높이 · 낙하 속도 · 수명)
}

export function parseOptions(argv: string[]): Options {
  const o: Options = { mode: "room", seeds: 40, seedoff: 0, pickaxes: 60, players: [], workers: 3, catalog: "normal", windows: 600, every: 20, rolls: 24, days: 10, warmup: 0, warmplayers: 8, feel: false };
  for (const a of argv) {
    if (a === "--") continue;   // pnpm run이 넘기는 구분자
    const m = /^--([a-z0-9]+)(?:=(.*))?$/.exec(a);
    if (!m) throw new Error(`balance: unknown argument ${a}`);
    const [, k, v] = m;
    if (k === "skilled" || k === "day" || k === "f9") o.mode = k === "skilled" ? "skilled" : k;
    else if (k === "catalog") o.catalog = v ?? "";
    else if (k === "feel") o.feel = true;
    else if (k === "players") o.players = (v ?? "").split(",").map(Number);
    else if (k === "seeds" || k === "seedoff" || k === "pickaxes" || k === "workers" || k === "windows" || k === "every" || k === "rolls" || k === "days" || k === "warmup" || k === "warmplayers") o[k] = Number(v);
    else throw new Error(`balance: unknown option --${k}`);
  }
  if (o.players.length === 0) o.players = o.mode === "room" ? [1, 3, 8] : o.mode === "f9" ? [3] : [1];
  if (o.players.some((n) => !(Number.isInteger(n) && n >= 1))) throw new Error("balance: --players needs positive integers");
  if (o.rolls < 2) throw new Error("balance: --rolls must be ≥ 2");
  return o;
}

export function loadCatalogFor(name: string): Catalog {
  const path = /^normal$/.test(name) ? fileURLToPath(import.meta.resolve(`@pikit/protocol/catalogs/${name}.json`)) : name;
  return parseCatalog(JSON.parse(readFileSync(path, "utf8")));
}

// 0…8은 옛 주소 그대로(0x1111…, …, 0x9999…). (규칙 11) 9부터는 옛 식이 겹쳤다(ownerOf(10) = 0x1111… = ownerOf(0)) → 0xaaaaaaaa + 번호.
// 엔진 결과는 주소 문자열에 기대지 않는다(스폰 순서 = 구매 seq, 스트림 이름 = 곡괭이 키) — 지갑만 서로 달라야 한다.
const ownerOf = (i: number) => (i < 9 ? `0x${String(i + 1).repeat(40)}` : `0x${"a".repeat(8)}${String(i + 1).padStart(32, "0")}`);
// 숙련자 주소는 ownerOf(i)가 만들 수 없는 값 (옛 0x5555…는 ownerOf(4)와 같았다 — D125 명세 §10)
const SKILLED = "0xffffffffffffffffffffffffffffffffffff5555";
const tierPicker = (seed: Uint8Array) => Xoshiro128ss.fromBytes(new Uint8Array(createHash("sha256").update(seed).update("balance-tiers").digest()));

/** 블록 id → kind (없으면 −1). 다이아·금·CHOG를 번호 대신 id로 찾는다 (규칙 8에서 다이아가 마지막 종류가 아니다) */
export function kindOfId(catalog: Catalog, id: string): number {
  return catalog.blocks.findIndex((b) => b.id === id);
}
/** (규칙 10) 규칙 10 칸(totalCapBps · luckyPick · jackpot)이 하나라도 있으면 F-9′·사다리 열을 쓴다 (scripts/ci/rules-freeze.mjs isRules10Catalog와 같은 판정). */
export function isRules10(catalog: Catalog): boolean {
  return catalog.reward.totalCapBps !== undefined || catalog.luckyPick !== undefined || catalog.jackpot !== undefined;
}
/** (규칙 11) 규칙 11 칸(reward.combo · wholeCredits · buffs · luckyPick.byTier)이 하나라도 있으면 COMBO·버프·정수·분포 목표 표를 낸다. */
export function isRules11(catalog: Catalog): boolean {
  return catalog.reward.combo !== undefined || catalog.reward.wholeCredits !== undefined || catalog.buffs !== undefined || catalog.luckyPick?.byTier !== undefined;
}
/** (규칙 10) 등급 t의 잭팟 기여율 x_t (가격 대비, 장기 잭팟 RTP 몫). 잭팟이 없으면 0. */
export function jackpotShare(catalog: Catalog, tier: number): number {
  return (catalog.jackpot?.contributionBpsByTier[tier] ?? 0) / 1e4;
}
/** (규칙 10) κ (가격 대비 한 골든 타격의 잭팟 기대 상한) = kappaPpm / 10⁶. 잭팟이 없으면 0. */
export function jackpotKappa(catalog: Catalog): number {
  return (catalog.jackpot?.kappaPpm ?? 0) / 1e6;
}
/** (규칙 11) 등급 tier의 LUCKY PICK 사다리 — byTier[tier] 먼저, 없으면 levels (protocol catalogPickLevelBps와 같은 규칙). */
export function ladderOf(catalog: Catalog, tier: number): readonly LuckyLevel[] {
  const lp = catalog.luckyPick;
  if (!lp) return [];
  return lp.byTier ? (lp.byTier[tier] ?? []) : (lp.levels ?? []);
}
/** (규칙 10) 등급 tier의 사다리 단계 (확률·배수). 없으면 []. */
export function ladderLevels(catalog: Catalog, tier: number): { p: number; mult: number; bps: number }[] {
  return ladderOf(catalog, tier).map((l) => ({ p: l.per10m / 1e7, mult: l.multBps / 1e4, bps: l.multBps }));
}
/** (규칙 11, 명세 24 §3.10) wholeCredits면 1,000밀리 단위로 내림 (엔진 wholeCreditsMilli와 같은 식). */
export function wholeOf(catalog: Catalog, milli: number): number {
  return catalog.reward.wholeCredits ? Math.floor(milli / 1000) * 1000 : milli;
}
/**
 * (규칙 10) 바탕 값 x(밀리)에서 사다리 기대 T_main = Σ_l p_l·min(C, max(x, F_l)) + (1 − L)·min(C, x).
 * (규칙 11) 사다리는 그 등급의 것, wholeCredits면 각 항을 정수 크레딧으로 내린다(엔진 settleFrom과 같은 순서).
 */
export function ladderExpectation(catalog: Catalog, tier: number, x: number): number {
  const C = catalogTotalCapMilli(catalog, tier);
  let L = 0;
  let e = 0;
  for (const l of ladderOf(catalog, tier)) {
    const p = l.per10m / 1e7;
    L += p;
    e += p * wholeOf(catalog, Math.min(C, Math.max(x, catalogPickFloorMilli(catalog, tier, l.multBps))));
  }
  return e + (1 - L) * wholeOf(catalog, Math.min(C, x));
}

/** CHOG 블록 kind들 (규칙 8, 명세 21) */
export function chogKinds(catalog: Catalog): number[] {
  return ["chog", "chog_gold"].map((id) => kindOfId(catalog, id)).filter((k) => k >= 0);
}

// ──────────────────────────────────────────────────────────────────────────
// 곡괭이 1개의 기록. 종류별 피해·타격: 플레이어 곡괭이 키 → [d_0 … d_9, 타격_0 … 타격_9]
// ──────────────────────────────────────────────────────────────────────────
const DAMAGE = new Map<string, number[]>();
// (규칙 11·12) 곡괭이 키 → 아이템 종류별 수 (BUFF_KINDS 순서) · 수명 중 최대 지름 (하늘 효과 틱 제외 / 포함)
const BUFFS = new Map<string, number[]>();
const SCALE = new Map<string, { noSky: number; all: number }>();
// (규칙 12) 곡괭이 키 → 아이템을 낸 막타 블록 종류별 수 · 유예(룰렛 대기가 끝을 미룸) · LIFE 되살아남 수 · 2×2 막타 수
const ITEM_BLOCKS = new Map<string, number[]>();
const GRACED = new Set<string>();
const REVIVED = new Map<string, number>();
const ZERO_DUR = new Set<string>();
const QUAD_LAST_HITS = new Map<string, number>();

/** (규칙 11, --feel) 등급 하나의 느낌 히스토그램: 튐 높이(0.01칸 칸), 낙하 속도(0.05칸/초 칸). */
export interface FeelHist { rises: number[]; falls: number[] }
const RISE_BIN = 0.01;
const RISE_BINS = 2000;   // 20칸까지 (넘으면 마지막 칸)
const FALL_BIN = 0.05;
const FALL_BINS = 800;    // 40칸/초까지
const newFeel = (tiers: number): FeelHist[] => Array.from({ length: tiers }, () => ({ rises: new Array<number>(RISE_BINS).fill(0), falls: new Array<number>(FALL_BINS).fill(0) }));
let FEEL: FeelHist[] | null = null;
let FEEL_FPS = 30;
const FEEL_STATE = new Map<string, { prevVy: number; riseY: number; apex: number }>();

let damageTapped = false;
function tapDamage(kinds: number): void {
  if (damageTapped) return;
  damageTapped = true;
  const advance = PhysicsEngine.prototype.advancePickaxe;
  PhysicsEngine.prototype.advancePickaxe = function (this: PhysicsEngine, p: PickaxeState, ...rest) {
    const hits = advance.call(this, p, ...rest);
    if (p.owner !== null && hits.length > 0) {
      let d = DAMAGE.get(p.key);
      if (!d) { d = new Array<number>(2 * kinds).fill(0); DAMAGE.set(p.key, d); }
      for (const h of hits) { d[h.block.kind]! += h.damage; d[kinds + h.block.kind]! += 1; }
    }
    if (FEEL && p.owner !== null) feelTick(FEEL[p.tier]!, p);
    return hits;
  } as typeof advance;
}

/** (--feel) physics-probe.mjs와 같은 정의: vy < 0이 되면 오르기 시작, 다시 vy ≥ 0이 되면 (시작 y − 꼭대기 y) > 0.02칸을 한 번의 튐으로 센다. */
function feelTick(h: FeelHist, p: PickaxeState): void {
  let s = FEEL_STATE.get(p.key);
  if (!s) { s = { prevVy: 0, riseY: NaN, apex: NaN }; FEEL_STATE.set(p.key, s); }
  if (p.vy > 0) h.falls[Math.min(FALL_BINS - 1, Math.floor((p.vy * FEEL_FPS) / FALL_BIN))]! += 1;
  if (p.vy < 0 && s.prevVy >= 0) { s.riseY = p.y; s.apex = p.y; }
  if (p.vy < 0 && !Number.isNaN(s.riseY)) s.apex = Math.min(s.apex, p.y);
  if (p.vy >= 0 && s.prevVy < 0 && !Number.isNaN(s.riseY)) {
    const r = s.riseY - s.apex;
    if (r > 0.02) h.rises[Math.min(RISE_BINS - 1, Math.floor(r / RISE_BIN))]! += 1;
    s.riseY = NaN;
  }
  s.prevVy = p.vy;
}

/** 끝난 플레이어 곡괭이 1개 (밀리크레딧). rb·overRb = LUCKY 종류에 대한 기대값(정상 종료만, 그 밖은 실제 값). */
export interface Row {
  tier: number;
  price: number;
  paid: number;
  over: number;
  rb: number;
  lucky: number;     // (개정 2) 실현 LUCKY
  luckyExp: number;  // (개정 2) LUCKY 기대 (E[m] = 1)
  overRb: number;
  diaHits: number;
  pop: boolean;
  big: boolean;
  life: number;   // 틱
  hits: number;
  normal: boolean;
  lastHit: number;   // (규칙 9) 막타 몫 (밀리, 실제 값 — LUCKY와 무관)
  lastHits: number;  // (규칙 9) 막타 횟수
  x: number;         // (규칙 10) 실제 바탕 값 — 정상 X = E, 비정상 V = min(P, E + 남은 내구도 몫) (밀리)
  tMainExp: number;  // (규칙 10) T_main 기대 (LUCKY 종류 기대 × 사다리 기대, 밀리 — 정상 종료, 비정상은 V에 사다리 기대)
  level: number;     // (규칙 10) 실제 LUCKY PICK 단계 (bps)
  pick: number;      // (규칙 10) 실제 사다리 보충 (밀리)
  jackpot: number;   // (규칙 10) 실제 잭팟 J (밀리)
  goldHits: number;  // (규칙 10) 잭팟 종류(골든 CHOG) 타격 수
  steps: number;     // (규칙 11) COMBO 단계 수 = POP·BIG_POP 사건 수 (규칙 10 카탈로그는 POP·BIG POP)
  steps3: number;    // (규칙 11) 그중 s ≥ 3
  longest: number;   // (규칙 11) 사건의 최장 연속 s (사건 없으면 0)
  bonus: number;     // 보너스(COMBO) 몫 (밀리)
  bonusCapHit: boolean;
  buffs: number[];   // (규칙 11·12) 아이템 종류별 수 (BUFF_KINDS 순서)
  itemBlocks: number[];   // (규칙 12) 아이템을 낸 막타 블록 종류별 수 (blocks 순서)
  graced: boolean;   // (규칙 12) 룰렛 대기(itemUntil > 0)가 끝(내구도 · 타이머 · 멈춤)을 한 틱 이상 미뤘다
  revived: number;   // (규칙 12) LIFE로 되살아난 수 (틱 끝 내구도 0 → 뒤 틱 끝 > 0)
  quadLastHits: number;   // (규칙 12) 2×2 막타 수 (상금 × 4)
  lifeExtra: number; // (규칙 11) LIFE로 늘어난 내구도 = durabilityTotal − D
  durTotal: number;  // 총 내구도 (LIFE 포함)
  maxScale: number;  // (규칙 11) 수명 중 최대 지름 — 하늘 효과 틱 제외
  maxScaleAll: number;  // 하늘 효과 포함
}

function rowOf(catalog: Catalog, r: PickaxeResult): Row {
  const normal = r.endReason === "DURABILITY";
  const kinds = catalog.blocks.length;
  const d = DAMAGE.get(r.key) ?? new Array<number>(2 * kinds).fill(0);
  DAMAGE.delete(r.key);
  const pool = luckyPoolCount(catalog);
  let eligible = 0;
  catalog.blocks.forEach((b, k) => { if (b.luckyWeight > 0) eligible += d[k]!; });
  // LUCKY 지급률의 분모는 카탈로그 D (엔진 luckyRateMilli) — LIFE가 늘린 D_total로 나누면 LIFE 곡괭이의 LUCKY를 적게 센다
  const D = catalog.pickaxes[r.tier]!.durability;
  const luckyExp = D > 0 ? (catalogLuckyShare(catalog, r.tier) * r.priceMilli * eligible) / D : 0;   // (개정 2) E[m] = 1이라 배수와 무관
  // (개정 2) 종류 X·배수 m 둘 다 기대로 적분: Σ_X (w_X/Σw) Σ_m q_m f(B + rate(X, m) × d_X)
  const levelsOf = (k: number) => { const l = catalogLuckyMultLevels(catalog, k); return l.length > 0 ? l : [{ multBps: 10_000, per10m: 10_000_000 }]; };
  const B = r.baseMilli + r.bonusMilli + r.lastHitMilli;   // LUCKY를 뺀 E (규칙 9: 막타 포함 — 빠뜨리면 F-9가 over를 적게 센다)
  const cap = rewardCapMilli(catalog, r.tier);
  let overRb = 0;
  if (normal) {
    catalog.blocks.forEach((b, k) => {
      if (b.luckyWeight > 0) for (const lv of levelsOf(k)) overRb += (b.luckyWeight / pool) * (lv.per10m / 10_000_000) * Math.max(0, B + luckyRateMilli(catalog, r.tier, k, lv.multBps) * d[k]! - cap);
    });
  }
  const dia = kindOfId(catalog, "diamond");
  // (규칙 10) 바탕 값과 사다리 기대
  const X = r.baseMilli + r.luckyMilli + r.bonusMilli + r.lastHitMilli;
  const unused = r.durabilityTotal > 0 ? Math.floor(((r.durabilityTotal - r.durabilityUsed) * r.priceMilli) / r.durabilityTotal) : 0;
  const x = normal ? X : wholeOf(catalog, Math.min(r.priceMilli, X + unused));   // (규칙 11) 비정상 V는 엔진처럼 먼저 내린다
  let tMainExp = 0;
  if (normal) {
    catalog.blocks.forEach((b, k) => {
      if (b.luckyWeight > 0) for (const lv of levelsOf(k)) tMainExp += (b.luckyWeight / pool) * (lv.per10m / 10_000_000) * ladderExpectation(catalog, r.tier, B + luckyRateMilli(catalog, r.tier, k, lv.multBps) * d[k]!);
    });
  } else {
    tMainExp = ladderExpectation(catalog, r.tier, x);
  }
  const gold = kindOfId(catalog, catalog.jackpot?.kindId ?? "chog_gold");
  const buffs = BUFFS.get(r.key) ?? BUFF_KINDS.map(() => 0);
  BUFFS.delete(r.key);
  const itemBlocks = ITEM_BLOCKS.get(r.key) ?? catalog.blocks.map(() => 0);
  ITEM_BLOCKS.delete(r.key);
  const graced = GRACED.delete(r.key);
  const revived = REVIVED.get(r.key) ?? 0;
  REVIVED.delete(r.key);
  ZERO_DUR.delete(r.key);
  const quadLastHits = QUAD_LAST_HITS.get(r.key) ?? 0;
  QUAD_LAST_HITS.delete(r.key);
  const sc = SCALE.get(r.key);
  SCALE.delete(r.key);
  FEEL_STATE.delete(r.key);
  const base = catalog.pickaxes[r.tier]!.scale;
  return {
    tier: r.tier, price: r.priceMilli, paid: r.paidMilli, over: r.overMilli,
    rb: normal ? B + luckyExp : r.paidMilli, lucky: r.luckyMilli, luckyExp: normal ? luckyExp : 0, overRb: normal ? overRb : 0, diaHits: dia >= 0 ? d[kinds + dia]! : 0,
    pop: r.pop, big: r.bigPop, life: r.endTick + 1 - r.spawnTick, hits: r.hits, normal, lastHit: r.lastHitMilli, lastHits: r.lastHits,
    x, tMainExp, level: r.pickLevelBps, pick: r.pickMilli, jackpot: r.jackpotMilli, goldHits: gold >= 0 ? d[kinds + gold]! : 0,
    steps: r.events.length, steps3: r.events.filter((e) => e.streakCount >= 3).length, longest: r.events.reduce((m, e) => Math.max(m, e.streakCount), 0),
    bonus: r.bonusMilli, bonusCapHit: r.bonusMilli >= catalog.pickaxes[r.tier]!.bonusCap * 1000,
    buffs, itemBlocks, graced, revived, quadLastHits,
    lifeExtra: r.durabilityTotal - D, durTotal: r.durabilityTotal, maxScale: sc?.noSky ?? base, maxScaleAll: sc?.all ?? base,
  };
}

// ──────────────────────────────────────────────────────────────────────────
// 보이는 판 특징 (키트 r7.mjs boardFeatures와 같은 정의)
// 노출 블록 = 화면 줄(top = floor(scrollY) … min(생성된 마지막 줄, top + height))의 살아 있는 블록 중 4이웃 하나가 비어 있는 것
// (옆이 벽이면 그 방향은 보지 않고, 아직 생성 안 된 줄도 보지 않는다)
// ──────────────────────────────────────────────────────────────────────────
export interface BoardFeatures {
  expDia: number;            // 노출 다이아
  expDiaTop: number;         // 화면 위쪽 반의 노출 다이아
  expRare: number;           // 노출 금 이상 (Gold 이상 — 규칙 8에서는 CHOG 두 종류 포함)
  expRareHpMissing: number;  // 노출 금 이상의 깎인 체력 비율 합
  expHpMissing: number;      // 노출 블록 전체의 깎인 체력 비율 합 (미리 깎인 블록)
  expSq: number;             // 노출 종류 몫 제곱합 (같은 종류가 몰림)
  expChog: number;           // (규칙 8) 노출 CHOG 블록 (CHOG Ore · Golden CHOG)
}
export const FEATURE_KEYS = ["expDia", "expDiaTop", "expRare", "expRareHpMissing", "expHpMissing", "expSq", "expChog"] as const;

export function boardFeatures(catalog: Catalog, state: RoomState): BoardFeatures {
  const W = catalog.world.width;
  const top = Math.floor(state.scrollY);
  const bottom = Math.min(state.generatedRowCount - 1, top + catalog.world.height);
  const live = (x: number, y: number) => getActiveBlockFromRingBuffer(state.blocks, W, x, y);
  const isExp = (x: number, y: number): boolean => {
    for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]] as const) {
      const nx = x + dx;
      const ny = y + dy;
      if (nx < 0 || nx >= W || ny >= state.generatedRowCount) continue;
      if (!live(nx, ny)) return true;
    }
    return false;
  };
  const expKind = new Array<number>(catalog.blocks.length).fill(0);
  const dia = kindOfId(catalog, "diamond");
  const gold = kindOfId(catalog, "gold");
  const chog = new Set(chogKinds(catalog));
  const midRow = top + catalog.world.height / 2;
  const f: BoardFeatures = { expDia: 0, expDiaTop: 0, expRare: 0, expRareHpMissing: 0, expHpMissing: 0, expSq: 0, expChog: 0 };
  let expN = 0;
  for (let y = top; y <= bottom; y++) {
    for (let x = 0; x < W; x++) {
      const b = live(x, y);
      if (!b || !isExp(x, y)) continue;
      expN += 1;
      expKind[b.kind]! += 1;
      const hp = catalog.blocks[b.kind]!.hp;
      if (gold >= 0 && b.kind >= gold) { f.expRare += 1; f.expRareHpMissing += (hp - b.health) / hp; }
      if (b.kind === dia) { f.expDia += 1; if (y < midRow) f.expDiaTop += 1; }
      if (chog.has(b.kind)) f.expChog += 1;
      if (b.health < hp) f.expHpMissing += (hp - b.health) / hp;
    }
  }
  f.expSq = expN ? expKind.reduce((a, n) => a + (n / expN) ** 2, 0) : 0;
  return f;
}

// ──────────────────────────────────────────────────────────────────────────
// 틱 끝 안전 검사 (박힘·관통) — 엔진을 바꾸지 않고 틱마다 보기: runWindow는 틱마다 catalog.world.ticksPerWindow를 읽는다
// (apps/game-server room/trace.ts와 같은 방법). 읽을 때 state.tick이 바뀌었으면 한 틱이 막 끝난 것이다.
// ──────────────────────────────────────────────────────────────────────────
export interface Safety {
  bodyTicks: number;
  embedded: number;       // 틱 끝에 몸 중심이 살아 있는 블록 안
  tunnelled: number;      // 한 틱 동안의 중심 이동 선분이 (틱 끝에 살아 있는) 블록 안으로 0.1칸 넘게 들어감 = 블록을 건너뜀
  chordDepthMax: number;  // 그 선분이 블록 안으로 들어간 깊이의 최댓값 (칸)
  stepMax: number;        // 틱당 중심 이동 최대 (칸)
  playerTicks: number;
  speedSum: number;       // 플레이어 몸 |v| 합 (칸/틱)
  spinSum: number;        // 플레이어 몸 |각속도| 합 (rad/틱)
}
export const newSafety = (): Safety => ({ bodyTicks: 0, embedded: 0, tunnelled: 0, chordDepthMax: 0, stepMax: 0, playerTicks: 0, speedSum: 0, spinSum: 0 });

/** 칸 안 깊이 (가장 가까운 변까지 거리, 칸 밖이면 0). */
function depthIn(state: RoomState, W: number, x: number, y: number): number {
  const bx = Math.floor(x);
  const by = Math.floor(y);
  if (!getActiveBlockFromRingBuffer(state.blocks, W, bx, by)) return 0;
  return Math.min(x - bx, bx + 1 - x, y - by, by + 1 - y);
}

/** 틱마다 safety를 잰다 — 돌려준 카탈로그(world.ticksPerWindow 게터만 다름)로 runWindow를 부른다. onTick(state)는 틱 끝마다(선택). */
export function tapTicks(catalog: Catalog, state: RoomState, s: Safety, onTickEnd?: (state: RoomState) => void): Catalog {
  const W = catalog.world.width;
  const ticks = catalog.world.ticksPerWindow;
  const prev = new Map<string, { x: number; y: number }>();
  let last = state.tick;
  const onTick = () => {
    const alive = new Set<string>();
    for (const p of state.pickaxes) {
      alive.add(p.key);
      s.bodyTicks += 1;
      if (depthIn(state, W, p.x, p.y) > 0) s.embedded += 1;
      const q = prev.get(p.key);
      if (q) {
        const step = Math.hypot(p.x - q.x, p.y - q.y);
        if (step > s.stepMax) s.stepMax = step;
        const n = Math.max(1, Math.ceil(step / 0.02));
        let deepest = 0;
        for (let i = 1; i < n; i++) deepest = Math.max(deepest, depthIn(state, W, q.x + ((p.x - q.x) * i) / n, q.y + ((p.y - q.y) * i) / n));
        if (deepest > s.chordDepthMax) s.chordDepthMax = deepest;
        if (deepest > 0.1) s.tunnelled += 1;
      }
      prev.set(p.key, { x: p.x, y: p.y });
      if (p.owner !== null) {
        s.playerTicks += 1;
        s.speedSum += Math.hypot(p.vx, p.vy);
        s.spinSum += Math.abs(p.vAngle);
      }
    }
    for (const k of prev.keys()) if (!alive.has(k)) prev.delete(k);
    onTickEnd?.(state);
  };
  const world = { ...catalog.world };
  Object.defineProperty(world, "ticksPerWindow", {
    enumerable: true,
    get: () => {
      if (state.tick !== last) { last = state.tick; onTick(); }
      return ticks;
    },
  });
  return { ...catalog, world };
}

/**
 * (규칙 12, 명세 25 §3.3.4 · §3.4.3) 틱 끝 불변식 위반 목록 (tick = 방금 끝난 틱 = state.tick − 1):
 *  - 아이템: itemUntil = 0 ∨ (플레이어 ∧ tick < itemUntil ≤ tick + rouletteTicks), 대기가 없으면 itemKind −1 · itemAngle 0
 *  - 2×2: 앵커(quad 1)의 세 칸이 링버퍼에 있으면 체력이 앵커와 같다, 살아 있는 2~4 칸은 같은 종류·같은 체력의 앵커가 있다
 * 엔진 시험(rules12.test.ts 바쁜 판)과 이 도구의 "invariant violations" 열이 같은 함수를 쓴다.
 */
export function rules12Violations(catalog: Catalog, state: RoomState, tick: number): string[] {
  const out: string[] = [];
  const R = catalog.buffs?.items.rouletteTicks ?? 0;
  for (const p of state.pickaxes) {
    if (p.itemUntil !== 0 && !(p.owner !== null && tick < p.itemUntil && p.itemUntil <= tick + R)) out.push(`${p.key}: itemUntil ${p.itemUntil} at tick ${tick}`);
    if (p.itemUntil === 0 && (p.itemKind !== -1 || p.itemAngle !== 0)) out.push(`${p.key}: item ${p.itemKind}/${p.itemAngle} without a pending roulette`);
  }
  const W = catalog.world.width;
  const rows = Math.floor(state.blocks.length / W);
  const at = (x: number, y: number) => state.blocks[(((y % rows) + rows) % rows) * W + x];
  for (const b of state.blocks) {
    if (!b.quad) continue;
    if (b.quad === 1) {
      for (const [dx, dy, q] of [[1, 0, 2], [0, 1, 3], [1, 1, 4]] as const) {
        const c = at(b.x + dx, b.y + dy);
        if (c && c.x === b.x + dx && c.y === b.y + dy && c.quad === q && (c.health !== b.health || c.kind !== b.kind)) {
          out.push(`2×2 (${b.x}, ${b.y}): q${q} ${c.kind}/${c.health} ≠ anchor ${b.kind}/${b.health}`);
        }
      }
    } else if (b.health > 0) {
      const ax = b.quad === 2 || b.quad === 4 ? b.x - 1 : b.x;
      const ay = b.quad >= 3 ? b.y - 1 : b.y;
      const a = at(ax, ay);
      if (!a || a.x !== ax || a.y !== ay || a.quad !== 1 || a.kind !== b.kind || a.health !== b.health) out.push(`2×2 cell (${b.x}, ${b.y}) q${b.quad} alive without its anchor`);
    }
  }
  return out;
}

// ──────────────────────────────────────────────────────────────────────────
// 방 (플레이어 n명이 쉬지 않고 무작위 등급)
// ──────────────────────────────────────────────────────────────────────────
export interface RoomOut {
  players: number;
  rows: Row[];
  windows: number;
  safety: Safety;
  exposure: number[];   // 노출 다이아 수 0, 1, 2, 3, 4+ (w > 60, every 윈도마다)
  fractional: { payouts: number; jackpots: number; settlements: number };   // (규칙 11) 정수가 아닌 정산(payout·over)·잭팟 J 건수 / 전체 정산 수
  scaleOverCap: number; // (규칙 11) 하늘 효과 밖에서 지름 > catalogScaleCap인 몸-틱
  feel: FeelHist[] | null;   // (--feel) 등급별 히스토그램
  genRows: number;      // (규칙 12) 만든 줄 수 (방을 만들 때의 줄 포함)
  quads: number;        // (규칙 12) 만든 2×2 수 (앵커 칸)
  luckyMults: Record<string, Record<number, number>>;   // (개정 2) 종류 묶음별 실현 luckyMultBps 분포 (플레이어 곡괭이)
  luckyKinds: number[]; // (규칙 12) 플레이어 곡괭이가 뽑은 LUCKY 종류별 수 (blocks 순서)
  violations: number;   // (규칙 12) 틱 끝 불변식 위반 수 (rules12Violations) + 수명 > 타이머 + R
  violationSamples: string[];
}

/** 시드마다 플레이어 n명이 각자 pickaxes개를 끝낼 때까지 돈다 (키트 r7.mjs tiers 모드와 같은 구매 규칙). feel = 느낌 히스토그램도 모은다. */
export function runRoom(catalog: Catalog, players: number, seeds: readonly number[], pickaxes: number, seedoff = 0, every = 20, feel = false): RoomOut {
  const owners = Array.from({ length: players }, (_, i) => ownerOf(i));
  const playerOf = new Map(owners.map((w, i) => [w, i]));
  tapDamage(catalog.blocks.length);
  const out: RoomOut = {
    players, rows: [], windows: 0, safety: newSafety(), exposure: [0, 0, 0, 0, 0], fractional: { payouts: 0, jackpots: 0, settlements: 0 }, scaleOverCap: 0,
    feel: feel ? newFeel(catalog.pickaxes.length) : null,
    genRows: 0, quads: 0, luckyMults: {}, luckyKinds: catalog.blocks.map(() => 0), violations: 0, violationSamples: [],
  };
  FEEL = out.feel;
  FEEL_FPS = catalog.physics.fps;
  const kindIndex = new Map<BuffKind, number>(BUFF_KINDS.map((k, i) => [k, i]));
  const W = catalog.world.width;
  const { timerTicks, stuckTicks } = catalog.limits;
  const R = catalog.buffs?.items.rouletteTicks ?? 0;
  let counted = 0;   // 2×2를 센 줄 수 (그 방의 generatedRowCount까지)
  const violate = (msgs: readonly string[]) => {
    out.violations += msgs.length;
    for (const m of msgs) if (out.violationSamples.length < 10) out.violationSamples.push(m);
  };
  /** (규칙 12) 새로 만든 줄의 2×2 앵커를 센다 (줄이 링버퍼에 남아 있는 동안 — 틱마다 몇 줄뿐이라 늘 남아 있다). */
  const countQuads = (st: RoomState) => {
    const rows = Math.floor(st.blocks.length / W);
    for (; counted < st.generatedRowCount; counted++) {
      const base = (counted % rows) * W;
      for (let x = 0; x < W; x++) if (st.blocks[base + x]!.y === counted && st.blocks[base + x]!.quad === 1) out.quads += 1;
      out.genRows += 1;
    }
  };
  // (규칙 11) 틱 끝: 플레이어 몸의 최대 지름 (하늘 효과 틱은 따로 — 하늘 효과는 상한 밖 2.5까지 키운다)
  // (규칙 12) 유예 · LIFE 되살아남 · 불변식 · 2×2 생성 수
  const onTickEnd = (st: RoomState) => {
    const tick = st.tick - 1;
    countQuads(st);
    if (catalog.buffs) violate(rules12Violations(catalog, st, tick));
    else if (catalog.generation.quadChanceBps) violate(rules12Violations(catalog, st, tick).filter((m) => m.startsWith("2×2")));
    for (const p of st.pickaxes) {
      if (p.owner === null) continue;
      if (p.itemUntil > 0 && (p.durabilityLeft <= 0 || tick + 1 - p.spawnTick >= timerTicks || tick + 1 - p.lastDamageTick >= stuckTicks)) GRACED.add(p.key);
      if (p.durabilityLeft <= 0) ZERO_DUR.add(p.key);
      else if (ZERO_DUR.delete(p.key)) REVIVED.set(p.key, (REVIVED.get(p.key) ?? 0) + 1);
      if (!catalog.buffs) continue;
      let m = SCALE.get(p.key);
      if (!m) { m = { noSky: 0, all: 0 }; SCALE.set(p.key, m); }
      if (p.scale > m.all) m.all = p.scale;
      if (st.sky.boosts.some((b) => b.key === p.key)) continue;
      if (p.scale > m.noSky) m.noSky = p.scale;
      if (p.scale > catalogScaleCap(catalog, p.tier) + 1e-9) out.scaleOverCap += 1;
    }
  };
  for (const sd of seeds) {
    const seed = seedFrom(10_000 + seedoff + sd);
    const pick = tierPicker(seed);
    const state = createRoom(catalog, windowFactory(seed, 1, 0), 1, 0);
    DAMAGE.clear(); BUFFS.clear(); SCALE.clear(); FEEL_STATE.clear();   // 시드마다 키가 다시 1:0부터
    ITEM_BLOCKS.clear(); GRACED.clear(); REVIVED.clear(); ZERO_DUR.clear(); QUAD_LAST_HITS.clear();
    counted = 0;
    countQuads(state);   // 방을 만들 때의 줄
    const tapped = tapTicks(catalog, state, out.safety, onTickEnd);
    const done = owners.map(() => 0);
    let ref = 1;
    for (let w = 1; done.some((d) => d < pickaxes); w++) {
      if (w > 60 && w % every === 0) out.exposure[Math.min(4, boardFeatures(catalog, state).expDia)]! += 1;
      const inputs: EngineInput[] = [];
      owners.forEach((owner, pi) => {
        if (done[pi]! >= pickaxes) return;
        const slot = state.owners.find((x) => x.owner === owner);
        if (!slot || (slot.activeKey === null && slot.queue.length === 0)) {
          inputs.push({ type: "purchase", ref: String(ref++), owner, tiers: [Math.floor(pick.next() * catalog.pickaxes.length)] });
        }
      });
      const res = runWindow(state, tapped, w, inputs, windowFactory(seed, 1, w));
      out.windows += 1;
      for (const b of res.buffs) {
        let c = BUFFS.get(b.key);
        if (!c) { c = BUFF_KINDS.map(() => 0); BUFFS.set(b.key, c); }
        c[kindIndex.get(b.kind)!]! += 1;
        let k = ITEM_BLOCKS.get(b.key);
        if (!k) { k = catalog.blocks.map(() => 0); ITEM_BLOCKS.set(b.key, k); }
        k[b.blockKind]! += 1;
      }
      for (const e of res.lastHits) if (e.prizeMilli > catalogLastHitMilli(catalog, e.tier, e.blockKind)) QUAD_LAST_HITS.set(e.key, (QUAD_LAST_HITS.get(e.key) ?? 0) + 1);
      for (const sp of res.spawned) if (sp.luckyKind >= 0) {
        out.luckyKinds[sp.luckyKind]! += 1;
        const g = sp.luckyKind <= 3 ? "kinds 0-3" : sp.luckyKind <= 6 ? "kinds 4-6" : "kinds 7+";
        const m = (out.luckyMults[g] ??= {});
        m[sp.luckyMultBps] = (m[sp.luckyMultBps] ?? 0) + 1;
      }
      for (const p of res.payouts) {
        out.fractional.settlements += 1;
        if (p.payoutMilli % 1000 !== 0 || p.overMilli % 1000 !== 0) out.fractional.payouts += 1;
      }
      for (const j of res.jackpots) if (j.amountMilli % 1000 !== 0) out.fractional.jackpots += 1;
      for (const r of res.ended) {
        if (r.endTick + 1 - r.spawnTick > timerTicks + R) violate([`${r.key}: lifetime ${r.endTick + 1 - r.spawnTick} > timer ${timerTicks} + R ${R}`]);
        const pi = playerOf.get(r.owner);
        if (pi === undefined || done[pi]! >= pickaxes) continue;
        out.rows.push(rowOf(catalog, r));
        done[pi]! += 1;
      }
    }
  }
  FEEL = null;
  return out;
}

// ──────────────────────────────────────────────────────────────────────────
// 무료 하루 (×1만, 10,000 크레딧으로 시작해 1,000 아래가 되면 끝)
// ──────────────────────────────────────────────────────────────────────────
export interface Day { n: number; ever: boolean; maxBal: number; ticks: number; best: number }   // best = (규칙 10) 그날 곡괭이 하나의 최고 배수 (지급 + over) ÷ 가격

/** 플레이어 0 = 하루 플레이어(×1만), 나머지 플레이어는 무작위 등급. 시드마다 하루 days개가 끝날 때까지(마지막 날도 끝까지) 돈다. */
export function runDays(catalog: Catalog, players: number, seeds: readonly number[], days: number, seedoff = 0): Day[] {
  const owners = Array.from({ length: players }, (_, i) => ownerOf(i));
  const start = 10 * catalog.pickaxes[0]!.priceCredits * 1000;
  const price = catalog.pickaxes[0]!.priceCredits * 1000;
  const out: Day[] = [];
  for (const sd of seeds) {
    const seed = seedFrom(20_000 + seedoff + sd);
    const pick = tierPicker(seed);
    const state = createRoom(catalog, windowFactory(seed, 1, 0), 1, 0);
    let ref = 1;
    let day: Day = { n: 0, ever: false, maxBal: start, ticks: 0, best: 0 };
    let bal = start;
    let finished = 0;
    for (let w = 1; finished < days; w++) {
      const inputs: EngineInput[] = [];
      owners.forEach((owner, pi) => {
        const slot = state.owners.find((x) => x.owner === owner);
        if (!slot || (slot.activeKey === null && slot.queue.length === 0)) {
          inputs.push({ type: "purchase", ref: String(ref++), owner, tiers: [pi === 0 ? 0 : Math.floor(pick.next() * catalog.pickaxes.length)] });
        }
      });
      const res = runWindow(state, catalog, w, inputs, windowFactory(seed, 1, w));
      for (const r of res.ended) {
        if (r.owner !== owners[0]) continue;
        bal += r.paidMilli + r.overMilli - price;
        day.best = Math.max(day.best, (r.paidMilli + r.overMilli) / price);
        day.n += 1;
        day.ticks += r.endTick + 1 - r.spawnTick;
        if (bal > day.maxBal) day.maxBal = bal;
        if (bal > start) day.ever = true;
        if (bal < price) {
          out.push(day);
          finished += 1;
          day = { n: 0, ever: false, maxBal: start, ticks: 0, best: 0 };
          bal = start;
        }
      }
    }
  }
  return out;
}

// ──────────────────────────────────────────────────────────────────────────
// 오라클 순간 (숙련자 κ — 키트 r7.mjs skilled + calib.mjs)
// ──────────────────────────────────────────────────────────────────────────
export interface Moment {
  tier: number;
  f: BoardFeatures;
  rb: number[];     // 롤마다 (번 것, LUCKY 기대값) ÷ 가격
  tot: number[];    // 롤마다 실제 (지급 + over) ÷ 가격
  over: number[];   // 롤마다 over ÷ 가격
  lad: number[];    // (규칙 10) 롤마다 T_main 기대(LUCKY·사다리 기대) ÷ 가격
  jb: number[];     // (규칙 10) 롤마다 잭팟 기대 상한 κ × 골든 타격 수 (가격 대비 — 통 크기와 무관, 명세 23 §4.3)
}

/** 순간 하나에서 등급 tier를 산다고 치고 롤 시드(앞으로의 줄·튕김·스폰·LUCKY)만 바꿔 끝까지 굴린다. */
function rollout(catalog: Catalog, state: RoomState, w: number, tier: number, rollSeed: Uint8Array): PickaxeResult {
  const s = cloneRoom(state);
  DAMAGE.clear();   // 롤마다 같은 키(skill:w:tier:0)를 쓰고, 복제한 방의 다른 곡괭이도 여기 쌓인다 — 이 도구는 롤 곡괭이만 읽는다
  const ref = `skill:${w}:${tier}`;
  for (let x = w; x < w + 3000; x++) {
    const inputs: EngineInput[] = x === w ? [{ type: "purchase", ref, owner: SKILLED, tiers: [tier] }] : [];
    const res = runWindow(s, catalog, x, inputs, windowFactory(rollSeed, 1, x));
    const done = res.ended.find((r) => r.owner === SKILLED);
    if (done) return done;
  }
  throw new Error("rollout did not end in 3000 windows");
}

/**
 * 오라클 순간 (숙련자 κ). warmup > 0이면 (규칙 8, 명세 21 §3.7) 순간을 재기 전에 warmplayers명이 W + (seed × 37 mod W)윈도 동안 판을 판다 —
 * 1인 방은 600윈도에 판이 3~4줄밖에 안 내려가 기본 오라클은 "새 판"만 잰다. 미리 파면 판이 120~250줄 내려간 여러 위상의 순간(운영 중인 판)을 잰다.
 */
export function runSkilled(catalog: Catalog, players: number, seeds: readonly number[], windows: number, every: number, rolls: number, seedoff = 0, warmup = 0, warmplayers = 8): Moment[] {
  const owners = Array.from({ length: players }, (_, i) => ownerOf(i));
  tapDamage(catalog.blocks.length);
  const moments: Moment[] = [];
  for (const sd of seeds) {
    const seed = seedFrom(30_000 + seedoff + sd);
    const pick = tierPicker(seed);
    const state = createRoom(catalog, windowFactory(seed, 1, 0), 1, 0);
    let ref = 1;
    const warm = warmup > 0 ? warmup + ((sd * 37) % warmup) : 0;
    const warmOwners = Array.from({ length: warmplayers }, (_, i) => ownerOf(50 + i));
    for (let w = 1; w <= warm; w++) {
      const inputs: EngineInput[] = [];
      for (const owner of warmOwners) {
        const slot = state.owners.find((x) => x.owner === owner);
        if (!slot || (slot.activeKey === null && slot.queue.length === 0)) inputs.push({ type: "purchase", ref: `warm${ref++}`, owner, tiers: [Math.floor(pick.next() * catalog.pickaxes.length)] });
      }
      runWindow(state, catalog, w, inputs, windowFactory(seed, 1, w));
    }
    for (let w = warm + 1; w <= warm + windows; w++) {
      if (w > warm + 60 && w % every === 0) {
        const f = boardFeatures(catalog, state);
        for (let tier = 0; tier < catalog.pickaxes.length; tier++) {
          const m: Moment = { tier, f, rb: [], tot: [], over: [], lad: [], jb: [] };
          for (let k = 0; k < rolls; k++) {
            const rollSeed = new Uint8Array(createHash("sha256").update(seed).update(`roll|${w}|${tier}|${k}`).digest());
            const r = rollout(catalog, state, w, tier, rollSeed);
            const row = rowOf(catalog, r);
            m.rb.push(row.rb / row.price);
            m.tot.push((row.paid + row.over) / row.price);
            m.over.push(row.over / row.price);
            m.lad.push(row.tMainExp / row.price);
            m.jb.push(jackpotKappa(catalog) * row.goldHits);
          }
          moments.push(m);
        }
      }
      const inputs: EngineInput[] = [];
      for (const owner of owners) {
        const slot = state.owners.find((x) => x.owner === owner);
        if (!slot || (slot.activeKey === null && slot.queue.length === 0)) {
          inputs.push({ type: "purchase", ref: String(ref++), owner, tiers: [Math.floor(pick.next() * catalog.pickaxes.length)] });
        }
      }
      runWindow(state, catalog, w, inputs, windowFactory(seed, 1, w));
    }
  }
  return moments;
}

// ──────────────────────────────────────────────────────────────────────────
// 통계 도우미
// ──────────────────────────────────────────────────────────────────────────
const sum = (a: readonly number[]) => a.reduce((x, y) => x + y, 0);
const mean = (a: readonly number[]) => (a.length ? sum(a) / a.length : NaN);
const sd = (a: readonly number[]) => { const m = mean(a); return Math.sqrt(a.reduce((s, x) => s + (x - m) * (x - m), 0) / Math.max(1, a.length - 1)); };
const quant = (a: readonly number[], q: number) => { if (!a.length) return NaN; const b = [...a].sort((x, y) => x - y); return b[Math.min(b.length - 1, Math.floor(q * b.length))]!; };
const f3 = (x: number) => x.toFixed(3);
const f4 = (x: number) => x.toFixed(4);
const pct = (x: number) => `${(x * 100).toFixed(1)}%`;

/** Σx/Σprice와 그 표준오차 (곡괭이를 독립으로 본 비율 추정량): sqrt(Σ(x − R·price)²) / Σprice. */
function ratio(rows: readonly Row[], x: (r: Row) => number): { r: number; se: number } {
  const sp = sum(rows.map((r) => r.price));
  const R = sum(rows.map(x)) / sp;
  return { r: R, se: Math.sqrt(sum(rows.map((r) => (x(r) - R * r.price) ** 2))) / sp };
}

// ──────────────────────────────────────────────────────────────────────────
// F-9 (감사 권고 CI 검사, 명세 §4.5)
// ──────────────────────────────────────────────────────────────────────────
export const F9_BOUND = 0.98;
/** (규칙 10, 명세 23 §6.4) F-9′ 상한: E[T_main]/P(사다리·LUCKY 기대) + x_t < 0.92 (CI 고정 표본 — scripts/ci/rules-freeze.mjs F9_PRIME_BOUND와 같은 값). */
export const F9_PRIME_BOUND = 0.92;
/**
 * F-9 등급 한 줄. 규칙 9: sum = capShare + eOver. 규칙 10(prime): sum = F-9′ = eTMain + x, capShare = REWARD 상한 몫(참고), eOver = 0.
 */
export interface F9Tier {
  tier: number; code: string; n: number; capShare: number; eOver: number; eOverSe: number; sum: number; overCapMilli: number; overCapLimitMilli: number; ok: boolean;
  prime: boolean; eTMain: number; eTMainSe: number; x: number;
}
export interface F9Result { tiers: F9Tier[]; rewardCapBps: number; ok: boolean; prime: boolean }

/**
 * 규칙 9: 등급마다 rewardCapBps/1e4 + E[over]/price ≤ 0.98, over 상한 ≤ 100 × 가격, rewardCapBps ≤ 9700.
 * 규칙 10 (F-9′): 등급마다 E[T_main]/P(LUCKY 종류 기대 × 사다리 기대, 총상한 포함) + contributionBpsByTier[t]/10⁴ < 0.92, over 상한 ≤ 100 × 가격.
 */
export function f9Report(catalog: Catalog, rows: readonly Row[]): F9Result {
  const bps = catalog.reward.rewardCapBps;
  const prime = isRules10(catalog);
  const tiers = catalog.pickaxes.map((p, t): F9Tier => {
    const oc = overCapMilli(catalog, t);
    const limit = MAX_OVER_MULTIPLE * p.priceCredits * 1000;
    if (prime) {
      const ts = rows.filter((r) => r.tier === t).map((r) => r.tMainExp / r.price);
      const eTMain = mean(ts);
      const x = jackpotShare(catalog, t);
      return {
        tier: t, code: p.code, n: ts.length, capShare: bps / 1e4, eOver: 0, eOverSe: 0, sum: eTMain + x, overCapMilli: oc, overCapLimitMilli: limit,
        ok: ts.length > 0 && eTMain + x < F9_PRIME_BOUND && oc <= limit, prime, eTMain, eTMainSe: sd(ts) / Math.sqrt(Math.max(1, ts.length)), x,
      };
    }
    // E[over]: LUCKY 종류에 대한 정확한 기대(overRb, 곡괭이의 종류별 피해로 계산 — 분산이 작다)
    const os = rows.filter((r) => r.tier === t).map((r) => r.overRb / r.price);
    const capShare = bps / 1e4;
    const eOver = mean(os);
    return {
      tier: t, code: p.code, n: os.length, capShare, eOver, eOverSe: sd(os) / Math.sqrt(Math.max(1, os.length)), sum: capShare + eOver,
      overCapMilli: oc, overCapLimitMilli: limit, ok: os.length > 0 && capShare + eOver <= F9_BOUND && oc <= limit, prime, eTMain: NaN, eTMainSe: NaN, x: 0,
    };
  });
  return { tiers, rewardCapBps: bps, ok: bps <= MAX_REWARD_CAP_BPS && tiers.every((t) => t.ok), prime };
}

function f9Table(catalog: Catalog, f: F9Result): string[] {
  if (f.prime) {
    const out = [
      `F-9′ (rules 10, spec 23 §6.4 — rewardCapBps ${f.rewardCapBps} ≤ ${MAX_REWARD_CAP_BPS}: ${f.rewardCapBps <= MAX_REWARD_CAP_BPS ? "ok" : "FAIL"}; bound E[T_main]/P (LUCKY + ladder at expectation) + x_t < ${F9_PRIME_BOUND}, over cap = total cap − REWARD cap ≤ ${MAX_OVER_MULTIPLE} × price)`,
      "",
      "| tier | pickaxes | E[T_main] ÷ price ± SE | x_t (jackpot, long run) | **F-9′** | over cap (milli) | ≤ 100 × price | ok |",
      "|---|---|---|---|---|---|---|---|",
    ];
    for (const t of f.tiers) {
      out.push(`| ${catalog.pickaxes[t.tier]!.code} | ${t.n} | ${f4(t.eTMain)} ± ${f4(t.eTMainSe)} | ${f4(t.x)} | **${f4(t.sum)}** | ${t.overCapMilli.toLocaleString("en-US")} | ${t.overCapLimitMilli.toLocaleString("en-US")} | ${t.ok ? "ok" : "FAIL"} |`);
    }
    return out;
  }
  const out = [
    `F-9 (rewardCapBps ${f.rewardCapBps} ≤ ${MAX_REWARD_CAP_BPS}: ${f.rewardCapBps <= MAX_REWARD_CAP_BPS ? "ok" : "FAIL"}; bound cap + E[over]/price ≤ ${F9_BOUND}, over cap ≤ ${MAX_OVER_MULTIPLE} × price)`,
    "",
    "| tier | pickaxes | REWARD cap ÷ price | E[over] ÷ price ± SE | **cap + E[over]** | over cap (milli) | ≤ 100 × price | ok |",
    "|---|---|---|---|---|---|---|---|",
  ];
  for (const t of f.tiers) {
    out.push(`| ${catalog.pickaxes[t.tier]!.code} | ${t.n} | ${t.capShare.toFixed(2)} | ${f4(t.eOver)} ± ${f4(t.eOverSe)} | **${f3(t.sum)}** | ${t.overCapMilli.toLocaleString("en-US")} | ${t.overCapLimitMilli.toLocaleString("en-US")} | ${t.ok ? "ok" : "FAIL"} |`);
  }
  return out;
}

// ──────────────────────────────────────────────────────────────────────────
// 표
// ──────────────────────────────────────────────────────────────────────────
function roomTables(catalog: Catalog, room: RoomOut): string[] {
  const out: string[] = [];
  const fps = catalog.physics.fps;
  const label = (t: number | null) => (t === null ? "all" : `${catalog.pickaxes[t]!.code} ×${catalog.pickaxes[t]!.priceCredits / catalog.pickaxes[0]!.priceCredits}`);
  out.push(`### ${room.players}-player room — ${room.rows.length} player pickaxes, ${room.windows} windows`);
  out.push("");
  out.push("| tier | n | RTP Σ(paid+over)/Σprice ± SE | RTP (LUCKY at expectation) ± SE | P(POP) | P(BIG POP) | > 1× | p50 / p90 / p99 / max multiple | P(over > 0) | E[over] ÷ price | max over ÷ price | non-DURABILITY |");
  out.push("|---|---|---|---|---|---|---|---|---|---|---|---|");
  for (const t of [...catalog.pickaxes.map((_, i) => i), null]) {
    const rs = t === null ? room.rows : room.rows.filter((r) => r.tier === t);
    if (!rs.length) continue;
    const real = ratio(rs, (r) => r.paid + r.over);
    const rb = ratio(rs, (r) => r.rb);
    const mult = rs.map((r) => (r.paid + r.over) / r.price);
    const ov = rs.map((r) => r.over / r.price);
    out.push(`| ${label(t)} | ${rs.length} | ${f3(real.r)} ± ${f3(real.se)} | **${f3(rb.r)}** ± ${f3(rb.se)} | ${pct(mean(rs.map((r) => (r.pop ? 1 : 0))))} | ${pct(mean(rs.map((r) => (r.big ? 1 : 0))))} | ${pct(mean(mult.map((x) => (x > 1 ? 1 : 0))))} | ${[0.5, 0.9, 0.99].map((q) => quant(mult, q).toFixed(2)).join(" / ")} / ${Math.max(...mult).toFixed(2)} | ${pct(mean(ov.map((x) => (x > 0 ? 1 : 0))))} | ${f4(mean(ov))} | ${Math.max(...ov).toFixed(2)} | ${rs.filter((r) => !r.normal).length} |`);
  }
  out.push("");
  out.push("| tier | lifetime mean (p10 / p50 / p90) | hits per pickaxe | hits/s (Σhits ÷ Σlife) |");
  out.push("|---|---|---|---|");
  for (const t of [...catalog.pickaxes.map((_, i) => i), null]) {
    const rs = t === null ? room.rows : room.rows.filter((r) => r.tier === t);
    if (!rs.length) continue;
    const life = rs.map((r) => r.life / fps);
    out.push(`| ${label(t)} | ${mean(life).toFixed(1)} s (${[0.1, 0.5, 0.9].map((q) => quant(life, q).toFixed(1)).join(" / ")}) | ${mean(rs.map((r) => r.hits)).toFixed(1)} | ${(sum(rs.map((r) => r.hits)) / sum(life)).toFixed(3)} |`);
  }
  // (규칙 9, 명세 22 §5) 막타: 곡괭이당 몫(가격 대비) 평균·분포, 번 것 전체 중 몫, 횟수, 한 번 이상 본 곡괭이 비율
  out.push("");
  out.push("| tier | LAST HIT ÷ price (mean) | p50 / p90 / max | share of all credits | LAST HITs per pickaxe | P(≥ 1 LAST HIT) |");
  out.push("|---|---|---|---|---|---|");
  for (const t of [...catalog.pickaxes.map((_, i) => i), null]) {
    const rs = t === null ? room.rows : room.rows.filter((r) => r.tier === t);
    if (!rs.length) continue;
    const lh = rs.map((r) => r.lastHit / r.price);
    out.push(`| ${label(t)} | ${f4(mean(lh))} | ${[0.5, 0.9].map((q) => quant(lh, q).toFixed(3)).join(" / ")} / ${Math.max(...lh).toFixed(3)} | ${pct(sum(rs.map((r) => r.lastHit)) / Math.max(1, sum(rs.map((r) => r.paid + r.over))))} | ${mean(rs.map((r) => r.lastHits)).toFixed(2)} | ${pct(mean(rs.map((r) => (r.lastHits > 0 ? 1 : 0))))} |`);
  }
  if (isRules10(catalog)) out.push("", ...rules10Tables(catalog, room));
  if (isRules11(catalog)) out.push("", ...rules11Tables(catalog, room), "", ...distributionTargets(catalog, room));
  if (room.feel) out.push("", ...feelTable(catalog, room));
  const s = room.safety;
  out.push("");
  out.push(`player bodies: speed ${((s.speedSum / s.playerTicks) * fps).toFixed(2)} tiles/s · spin ${((s.spinSum / s.playerTicks) * fps).toFixed(2)} rad/s · max step ${s.stepMax.toFixed(3)} tiles/tick`);
  out.push(`safety over ${s.bodyTicks.toLocaleString("en-US")} body-ticks (players + bots): **embedded ${s.embedded}** (centre inside a live block at a tick end) · **tunnelled ${s.tunnelled}** (tick chord > 0.1 tile inside a block live at the tick end; deepest chord ${s.chordDepthMax.toFixed(3)})`);
  const ne = sum(room.exposure);
  out.push(`exposed Diamonds at ${ne} moments (w > 60, every 20 windows): ${room.exposure.map((n, i) => `${i}${i === 4 ? "+" : ""}: ${pct(n / Math.max(1, ne))}`).join(" · ")}`);
  return out;
}

/** (규칙 10) R = T_main/P의 닫힌식 혼합 분포: P(R ≤ r) = mean_i [x_i ≤ r] × (1 − Σ_{m_k > r} p_k) (r < C/P), x_i = 바탕 값 ÷ 가격(실제). */
export function ladderDistribution(catalog: Catalog, tier: number, xs: readonly number[]): { cdfLE: (r: number) => number; quantile: (q: number) => number; atLeast: (r: number) => number } {
  const levels = ladderLevels(catalog, tier);
  const capMult = catalogTotalCapMilli(catalog, tier) / (catalog.pickaxes[tier]!.priceCredits * 1000);
  const sorted = [...xs].sort((a, b) => a - b);
  const fracLE = (r: number) => { let lo = 0, hi = sorted.length; while (lo < hi) { const m = (lo + hi) >> 1; if (sorted[m]! <= r) lo = m + 1; else hi = m; } return lo / Math.max(1, sorted.length); };
  const fracLT = (r: number) => { let lo = 0, hi = sorted.length; while (lo < hi) { const m = (lo + hi) >> 1; if (sorted[m]! < r) lo = m + 1; else hi = m; } return lo / Math.max(1, sorted.length); };
  const cdfLE = (r: number) => (r >= capMult ? 1 : fracLE(r) * (1 - levels.filter((l) => l.mult > r).reduce((a, l) => a + l.p, 0)));
  const atLeast = (r: number) => (r > capMult ? 0 : 1 - fracLT(r) * (1 - levels.filter((l) => l.mult >= r).reduce((a, l) => a + l.p, 0)));
  const candidates = [...new Set([...sorted, ...levels.map((l) => l.mult), capMult])].filter((r) => r <= capMult).sort((a, b) => a - b);
  const quantile = (q: number) => { for (const r of candidates) if (cdfLE(r) >= q) return r; return capMult; };
  return { cdfLE, quantile, atLeast };
}

export const R_THRESHOLDS = [1.1, 1.2, 1.3, 1.5, 2, 3, 5, 10, 20, 40];

/** (규칙 11, 명세 24 §5.2 G1) COMBO · 버프 · 크기 · 정수 정산 표. */
function rules11Tables(catalog: Catalog, room: RoomOut): string[] {
  const out: string[] = [];
  const label = (t: number | null) => (t === null ? "all" : `${catalog.pickaxes[t]!.code} ×${catalog.pickaxes[t]!.priceCredits / catalog.pickaxes[0]!.priceCredits}`);
  const tiers = [...catalog.pickaxes.map((_, i) => i), null];
  const b = catalog.buffs;
  if (catalog.reward.combo) {
    out.push(`#### rules 11 — COMBO ladder (u_t × ${JSON.stringify(catalog.reward.combo.weights)} at s = 2, 3, 4, ≥ 5 · Σ ≤ bonusCap)${b ? ` · growth + ${b.growStepBps} bps per step, ≤ ${b.growMaxStacks} stacks` : ""}`);
    out.push("");
    out.push("| tier | n | COMBO steps (s ≥ 2) / pickaxe | s ≥ 3 / pickaxe | longest s p50 / p99 / max | P(bonusCap reached) | COMBO ÷ price (mean) | COMBO share of (paid + over) | popStacks / pickaxe |");
    out.push("|---|---|---|---|---|---|---|---|---|");
    for (const t of tiers) {
      const rs = t === null ? room.rows : room.rows.filter((r) => r.tier === t);
      if (!rs.length) continue;
      const longest = rs.map((r) => r.longest);
      out.push(`| ${label(t)} | ${rs.length} | ${mean(rs.map((r) => r.steps)).toFixed(2)} | ${mean(rs.map((r) => r.steps3)).toFixed(2)} | ${quant(longest, 0.5)} / ${quant(longest, 0.99)} / ${Math.max(...longest)} | ${pct(mean(rs.map((r) => (r.bonusCapHit ? 1 : 0))))} | ${f4(mean(rs.map((r) => r.bonus / r.price)))} | ${pct(sum(rs.map((r) => r.bonus)) / Math.max(1, sum(rs.map((r) => r.paid + r.over))))} | ${mean(rs.map((r) => Math.min(b?.growMaxStacks ?? 0, r.steps))).toFixed(2)} |`);
    }
  }
  if (b) {
    const it = b.items;
    out.push("");
    out.push(`#### rules 12 — items (last-hit roulette: chance ${JSON.stringify(it.chanceBps)} bps by block, ${it.rouletteTicks}-tick roulette, ≤ ${it.maxPerPickaxe} per pickaxe; weights ${it.table.map((x) => `${x.kind} ${x.weight}`).join(" · ")}) · size cap min(${b.scaleCap.mulBps / 1e4} × tier size, ${b.scaleCap.tiles} tiles)`);
    out.push("");
    out.push(`| tier | items / pickaxe | ${BUFF_KINDS.join(" · ")} / pickaxe | P(≥ 1 item) | P(≥ 1 LIFE) | LIFE share of durability (Σ extra ÷ Σ total) | grace pickaxes | LIFE revivals / pickaxe | 2×2 LAST HITs / pickaxe | max size p50 / p99 / max (no sky) | cap | max size incl. sky |`);
    out.push("|---|---|---|---|---|---|---|---|---|---|---|---|");
    const life = BUFF_KINDS.indexOf("LIFE");
    for (const t of tiers) {
      const rs = t === null ? room.rows : room.rows.filter((r) => r.tier === t);
      if (!rs.length) continue;
      const ms = rs.map((r) => r.maxScale);
      out.push(`| ${label(t)} | ${mean(rs.map((r) => sum(r.buffs))).toFixed(2)} | ${BUFF_KINDS.map((_, i) => mean(rs.map((r) => r.buffs[i]!)).toFixed(2)).join(" · ")} | ${pct(mean(rs.map((r) => (sum(r.buffs) > 0 ? 1 : 0))))} | ${pct(mean(rs.map((r) => (r.buffs[life]! > 0 ? 1 : 0))))} | ${pct(sum(rs.map((r) => r.lifeExtra)) / Math.max(1, sum(rs.map((r) => r.durTotal))))} | ${pct(mean(rs.map((r) => (r.graced ? 1 : 0))))} | ${mean(rs.map((r) => r.revived)).toFixed(3)} | ${mean(rs.map((r) => r.quadLastHits)).toFixed(3)} | ${[0.5, 0.99].map((q) => quant(ms, q).toFixed(2)).join(" / ")} / ${Math.max(...ms).toFixed(2)} | ${t === null ? "-" : catalogScaleCap(catalog, t).toFixed(2)} | ${Math.max(...rs.map((r) => r.maxScaleAll)).toFixed(2)} |`);
    }
    out.push("");
    out.push(`| tier | items / pickaxe by LAST HIT block: ${catalog.blocks.map((x) => x.id).join(" · ")} |`);
    out.push("|---|---|");
    for (const t of tiers) {
      const rs = t === null ? room.rows : room.rows.filter((r) => r.tier === t);
      if (!rs.length) continue;
      out.push(`| ${label(t)} | ${catalog.blocks.map((_, k) => mean(rs.map((r) => r.itemBlocks[k]!)).toFixed(3)).join(" · ")} |`);
    }
    out.push("");
    out.push(`size: **${room.scaleOverCap} body-ticks above catalogScaleCap** outside a sky boost (must be 0; the sky boost grows to max(tier size, ${catalog.skyEvent.grow.scale}) — D125)`);
  }
  out.push("", ...rules12Lines(catalog, room));
  const f = room.fractional;
  out.push("");
  out.push(`settlements ${f.settlements.toLocaleString("en-US")}: **non-integer payout/over ${f.payouts}** · non-integer jackpots ${f.jackpots}${catalog.reward.wholeCredits ? " (reward.wholeCredits — both must be 0)" : " (milli settlements — no wholeCredits)"}`);
  return out;
}

/** (규칙 12, 명세 25 §5.2) 2×2 생성 · LUCKY 뽑힌 종류 분포 · 불변식 위반 줄. */
function rules12Lines(catalog: Catalog, room: RoomOut): string[] {
  const out: string[] = [];
  const q = catalog.generation.quadChanceBps;
  const expected = q ? (1000 * catalog.blocks.reduce((a, b, k) => a + b.batchCount * (q[k] ?? 0) / 1e4, 0)) / (catalog.limits.batchBlocks / catalog.world.width) : 0;
  out.push(`2×2: **${room.quads} made over ${room.genRows.toLocaleString("en-US")} rows = ${((1000 * room.quads) / Math.max(1, room.genRows)).toFixed(2)} per 1,000 rows** (catalog expectation ${expected.toFixed(2)}; quadChanceBps ${q ? JSON.stringify(q) : "none"}) · 2×2 LAST HITs ${sum(room.rows.map((r) => r.quadLastHits))} (×4 prize)`);
  const n = sum(room.luckyKinds);
  const pool = luckyPoolCount(catalog);
  out.push(`LUCKY kinds drawn (${n} spawns): ${catalog.blocks.map((b, k) => (b.luckyWeight > 0 ? `${b.id} ${pct(room.luckyKinds[k]! / Math.max(1, n))} (w ${b.luckyWeight}/${pool})` : null)).filter((x) => x !== null).join(" · ")}`);
  for (const [g, m] of Object.entries(room.luckyMults).sort()) {
    const tot = sum(Object.values(m));
    out.push(`LUCKY ×m ${g} (${tot}): ${Object.entries(m).sort((a, b) => Number(a[0]) - Number(b[0])).map(([bps, c]) => `×${Number(bps) / 10_000} ${pct(c / tot)}`).join(" · ")} · E[m] ${(sum(Object.entries(m).map(([bps, c]) => Number(bps) * c)) / tot / 10_000).toFixed(3)}`);
  }
  out.push(`E[LUCKY] ÷ price by tier (realised / expectation): ${catalog.pickaxes.map((p, t) => { const rs = room.rows.filter((r) => r.tier === t); const P = Math.max(1, sum(rs.map((r) => r.price))); return rs.length ? `${p.code} ${f3(sum(rs.map((r) => r.lucky)) / P)} / **${f3(sum(rs.map((r) => r.luckyExp)) / P)}**` : null; }).filter((x) => x !== null).join(" · ")}`);
  out.push(`invariant violations: **${room.violations}** (item pending window · 2×2 four-cell health · lifetime > timer + R — must be 0)${room.violationSamples.length ? ` e.g. ${room.violationSamples.slice(0, 3).join(" | ")}` : ""}`);
  return out;
}

type TargetSet = "LUCKY SHOT" | "BIG GAME" | "rules-10 ×1 band";
/**
 * (규칙 11, 명세 24 §3.18) 등급 분포 목표. 등급이 3개면 코드로 성격을 찾는다(FE = LUCKY SHOT · BM = BIG GAME; VD STEADY 목표는 규칙 12에서 지웠다),
 * 아니면 가장 싼 등급을 규칙 10 띠(×1 p10 · p50 · p75 0.36~0.44 · 0.65~0.75 · ≤ 0.90, P(≥2×) 1/15~1/30, P(≥3×) 1/50~1/100)로 본다.
 * R = T_main ÷ 가격(잭팟 제외)의 닫힌식 혼합(그 등급 사다리 — ladderDistribution), 수명 = 실현 p50.
 */
function distributionTargets(catalog: Catalog, room: RoomOut): string[] {
  const fps = catalog.physics.fps;
  const three = catalog.pickaxes.length === 3;
  const setOf = (code: string): TargetSet | null => (code === "FE" ? "LUCKY SHOT" : code === "BM" ? "BIG GAME" : null);
  const plan: [number, TargetSet][] = three
    ? catalog.pickaxes.flatMap((p, t): [number, TargetSet][] => { const k = setOf(p.code); return k ? [[t, k]] : []; })
    : [[0, "rules-10 ×1 band"]];
  const inv = (p: number) => (p > 0 ? `1/${(1 / p).toFixed(1)}` : "0");
  const within = (x: number, lo: number, hi: number) => x >= lo && x <= hi;
  const out = [
    `#### distribution targets — ${three ? "3 tiers (spec 24 §3.18)" : "the cheapest tier against the rules-10 ×1 band (spec 24 §3.18: 5 tiers)"}; R = T_main ÷ price (jackpot excluded), closed-form mix over the tier's ladder`,
    "",
    "| tier | target set | metric | target | measured | ok |",
    "|---|---|---|---|---|---|",
  ];
  for (const [t, set] of plan) {
    const rs = room.rows.filter((r) => r.tier === t);
    if (!rs.length) continue;
    const d = ladderDistribution(catalog, t, rs.map((r) => r.x / r.price));
    const q = (x: number) => d.quantile(x);
    const P = (r: number) => d.atLeast(r);
    const life = quant(rs.map((r) => r.life / fps), 0.5);
    const rows: [string, string, string, boolean][] =
      set === "LUCKY SHOT" ? [
        ["p50", "0.60–0.75", f3(q(0.5)), within(q(0.5), 0.6, 0.75)],
        ["P(≥2×)", "1/13–1/9", inv(P(2)), within(P(2), 1 / 13, 1 / 9)],
        ["P(≥3×)", "1/30–1/20", inv(P(3)), within(P(3), 1 / 30, 1 / 20)],
        ["P(≥5×)", "1/100–1/50", inv(P(5)), within(P(5), 1 / 100, 1 / 50)],
        ["lifetime p50", "12–20 s", `${life.toFixed(1)} s`, within(life, 12, 20)],
      ] : set === "BIG GAME" ? [
        ["p50", "0.55–0.70", f3(q(0.5)), within(q(0.5), 0.55, 0.7)],
        ["P(≥5×)", "1/90–1/50", inv(P(5)), within(P(5), 1 / 90, 1 / 50)],
        ["P(≥10×)", "1/250–1/150", inv(P(10)), within(P(10), 1 / 250, 1 / 150)],
      ] : [
        ["p10", "0.36–0.44", f3(q(0.1)), within(q(0.1), 0.36, 0.44)],
        ["p50", "0.65–0.75", f3(q(0.5)), within(q(0.5), 0.65, 0.75)],
        ["p75", "≤ 0.90", f3(q(0.75)), q(0.75) <= 0.9],
        ["P(≥2×)", "1/30–1/15", inv(P(2)), within(P(2), 1 / 30, 1 / 15)],
        ["P(≥3×)", "1/100–1/50", inv(P(3)), within(P(3), 1 / 100, 1 / 50)],
      ];
    for (const [metric, want, got, ok] of rows) out.push(`| ${catalog.pickaxes[t]!.code} | ${set} | ${metric} | ${want} | ${got} | ${ok ? "ok" : "**✗**"} |`);
  }
  return out;
}

/** (--feel) 히스토그램 분위수 (칸 가운데 값). */
function histQuantile(h: readonly number[], bin: number, q: number): number {
  const n = sum(h);
  if (!n) return NaN;
  let c = 0;
  for (let i = 0; i < h.length; i++) { c += h[i]!; if (c >= q * n) return (i + 0.5) * bin; }
  return (h.length - 0.5) * bin;
}

/** (--feel, 명세 24 §3.3) 느낌 표 — 등급마다 튐 높이 · 낙하 속도 · 수명, 가장 싼 등급에 G1 기준. */
function feelTable(catalog: Catalog, room: RoomOut): string[] {
  const feel = room.feel!;
  const fps = catalog.physics.fps;
  const out = [
    "#### feel (--feel, spec 24 §3.3; definitions = _analysis/r4-feedback/physics-probe.mjs, player bodies right after advancePickaxe) — G1 for the cheapest tier: bounce p50 ≥ 1.2 tiles · bounces ≥ 1 tile ≥ 55 % · fall p50 ≥ 2.4 tiles/s · lifetime p50 12–20 s",
    "",
    "| tier | bounces | bounce p50 / p90 (tiles) | bounces ≥ 0.5 / ≥ 1 tile | bounces per s | fall p50 / p90 (tiles/s) | lifetime p50 (s) | G1 |",
    "|---|---|---|---|---|---|---|---|",
  ];
  feel.forEach((h, t) => {
    const n = sum(h.rises);
    const rs = room.rows.filter((r) => r.tier === t);
    if (!n || !rs.length) return;
    const at = (x: number) => sum(h.rises.slice(Math.round(x / RISE_BIN))) / n;
    const life = rs.map((r) => r.life / fps);
    const rise50 = histQuantile(h.rises, RISE_BIN, 0.5);
    const fall50 = histQuantile(h.falls, FALL_BIN, 0.5);
    const lifeP50 = quant(life, 0.5);
    const g1 = t === 0 ? ([rise50 >= 1.2, at(1) >= 0.55, fall50 >= 2.4, lifeP50 >= 12 && lifeP50 <= 20].every(Boolean) ? "ok" : "**✗**") : "-";
    out.push(`| ${catalog.pickaxes[t]!.code} | ${n.toLocaleString("en-US")} | ${rise50.toFixed(2)} / ${histQuantile(h.rises, RISE_BIN, 0.9).toFixed(2)} | ${pct(at(0.5))} / ${pct(at(1))} | ${(n / Math.max(1e-9, sum(life))).toFixed(2)} | ${fall50.toFixed(2)} / ${histQuantile(h.falls, FALL_BIN, 0.9).toFixed(2)} | ${lifeP50.toFixed(1)} | ${g1} |`);
  });
  return out;
}

/** (규칙 10) 방 표: 사다리·잭팟 RTP, R 분포(닫힌식), 잭팟 실현·α 추정. */
function rules10Tables(catalog: Catalog, room: RoomOut): string[] {
  const out: string[] = [];
  const label = (t: number | null) => (t === null ? "all" : `${catalog.pickaxes[t]!.code} ×${catalog.pickaxes[t]!.priceCredits / catalog.pickaxes[0]!.priceCredits}`);
  const kappa = jackpotKappa(catalog);
  out.push(`#### rules 10 — LUCKY PICK ladder at expectation (exact over the level draw) + jackpot at its long-run share x_t (spec 23 §4.4)`);
  out.push("");
  out.push("| tier | n | RTP realised (incl. ladder, J) | RTP X only (LUCKY exp.) | E[ladder top-up] ÷ price | x_t | **RTP (ladder exp. + x_t)** ± SE | realised J ÷ Σprice | P(level) realised | jackpots | Golden hits / pickaxe |");
  out.push("|---|---|---|---|---|---|---|---|---|---|---|");
  for (const t of [...catalog.pickaxes.map((_, i) => i), null]) {
    const rs = t === null ? room.rows : room.rows.filter((r) => r.tier === t);
    if (!rs.length) continue;
    const sp = sum(rs.map((r) => r.price));
    const x = sum(rs.map((r) => jackpotShare(catalog, r.tier) * r.price)) / sp;
    const g1 = ratio(rs, (r) => r.tMainExp + jackpotShare(catalog, r.tier) * r.price);
    const xOnly = ratio(rs, (r) => r.rb);
    out.push(`| ${label(t)} | ${rs.length} | ${f3(ratio(rs, (r) => r.paid + r.over).r)} | ${f3(xOnly.r)} | ${f4(sum(rs.map((r) => r.tMainExp - (r.normal ? r.rb : r.x))) / sp)} | ${f4(x)} | **${f3(g1.r)}** ± ${f3(g1.se)} | ${f4(sum(rs.map((r) => r.jackpot)) / sp)} | ${pct(mean(rs.map((r) => (r.level > 0 ? 1 : 0))))} | ${rs.filter((r) => r.jackpot > 0).length} | ${mean(rs.map((r) => r.goldHits)).toFixed(3)} |`);
  }
  out.push("");
  out.push(`R = T_main ÷ price (jackpot excluded), closed-form mix over the ladder: P(R ≤ r) = P(X ≤ r) × (1 − Σ_{m_k > r} p_k), X realised`);
  out.push("");
  out.push(`| tier | p10 | p50 | p75 | ${R_THRESHOLDS.map((r) => `P(≥${r})`).join(" | ")} |`);
  out.push(`|---|---|---|---|${R_THRESHOLDS.map(() => "---").join("|")}|`);
  for (let t = 0; t < catalog.pickaxes.length; t++) {
    const rs = room.rows.filter((r) => r.tier === t);
    if (!rs.length) continue;
    const d = ladderDistribution(catalog, t, rs.map((r) => r.x / r.price));
    out.push(`| ${label(t)} | ${[0.1, 0.5, 0.75].map((q) => d.quantile(q).toFixed(3)).join(" | ")} | ${R_THRESHOLDS.map((r) => { const p = d.atLeast(r); return p > 0 ? `${pct(p)} (1/${Math.round(1 / p)})` : "0"; }).join(" | ")} |`);
  }
  const sp = sum(room.rows.map((r) => r.price));
  const hw = sum(room.rows.map((r) => r.price * r.goldHits)) / sp;
  const xw = sum(room.rows.map((r) => jackpotShare(catalog, r.tier) * r.price)) / sp;
  out.push("");
  out.push(`jackpot: κ ${kappa} · price-weighted Golden hits per pickaxe h̄_w ${hw.toFixed(3)} · mix contribution x ${f4(xw)} · **α = κ·h̄_w / x = ${xw > 0 ? (kappa * hw / xw).toFixed(2) : "-"}** (α > 1 → contributions are paid out in the long run, spec 23 §4.4) · realised jackpots ${room.rows.filter((r) => r.jackpot > 0).length}, Σ J ÷ Σ price ${f4(sum(room.rows.map((r) => r.jackpot)) / sp)}`);
  return out;
}

function skilledTables(catalog: Catalog, moments: readonly Moment[], rolls: number): string[] {
  const out: string[] = [];
  const nEst = Math.round((rolls * 2) / 3);   // 24 → 16 추정 + 8 측정 (키트와 같음)
  const s5All: number[] = [];
  const s1All: number[] = [];
  const allMeas: number[] = [];
  out.push(`### skilled timer — oracle moments (${rolls} rollouts per moment × tier: first ${nEst} = estimate, last ${rolls - nEst} = measurement; LUCKY at expectation)`);
  out.push("");
  out.push("| tier | moments | random-moment RTP | S5 RTP (κ5 ± SE) | S1 RTP (κ1) | κ bound | κ_board: exposed Diamonds · top half · Gold+ · chipped Gold+ · pre-damaged · same-kind · CHOG | Diamond-only buyer (≥ 1 exposed) ± SE · realised LUCKY | CHOG-only buyer (≥ 1 exposed CHOG) ± SE |");
  out.push("|---|---|---|---|---|---|---|---|---|");
  for (let t = 0; t < catalog.pickaxes.length; t++) {
    const ms = moments.filter((m) => m.tier === t);
    if (!ms.length) continue;
    const recs = ms.map((m) => ({ est: mean(m.rb.slice(0, nEst)), meas: mean(m.rb.slice(nEst)), all: mean(m.rb), v: sd(m.rb) ** 2, K: m.rb.length, tot: mean(m.tot), f: m.f }));
    const mu = mean(recs.map((r) => r.meas));
    const muAll = mean(recs.map((r) => r.all));
    const th5 = quant(recs.map((r) => r.est), 0.95);
    const th1 = quant(recs.map((r) => r.est), 0.99);
    const s5 = recs.filter((r) => r.est >= th5).map((r) => r.meas);
    const s1 = recs.filter((r) => r.est >= th1).map((r) => r.meas);
    s5All.push(...s5); s1All.push(...s1); allMeas.push(...recs.map((r) => r.meas));
    const k5 = mean(s5) / mu;
    const k5se = k5 * Math.sqrt((sd(s5) / mean(s5)) ** 2 / s5.length + (sd(recs.map((r) => r.meas)) / mu) ** 2 / recs.length);
    const varB = sd(recs.map((r) => r.all)) ** 2 - mean(recs.map((r) => r.v / r.K));
    const kb = FEATURE_KEYS.map((key) => {
      const vals = recs.map((r) => r.f[key]);
      const cut = quant(vals, 0.95);
      const med = quant(vals, 0.5);
      let sel = recs.filter((r) => r.f[key] >= cut && r.f[key] > med);
      if (!sel.length) sel = recs.filter((r) => r.f[key] >= cut);
      return mean(sel.map((r) => r.all)) / muAll;
    });
    const dia = recs.filter((r) => r.f.expDia >= 1);
    const dRatio = mean(dia.map((r) => r.all)) / muAll;
    const dSe = dRatio * Math.sqrt((sd(dia.map((r) => r.all)) / mean(dia.map((r) => r.all))) ** 2 / dia.length + (sd(recs.map((r) => r.all)) / muAll) ** 2 / recs.length);
    const dReal = mean(dia.map((r) => r.tot)) / mean(recs.map((r) => r.tot));
    const ch = recs.filter((r) => r.f.expChog >= 1);
    const cRatio = ch.length ? mean(ch.map((r) => r.all)) / muAll : NaN;
    const cSe = ch.length ? cRatio * Math.sqrt((sd(ch.map((r) => r.all)) / mean(ch.map((r) => r.all))) ** 2 / ch.length + (sd(recs.map((r) => r.all)) / muAll) ** 2 / recs.length) : NaN;
    out.push(`| ${catalog.pickaxes[t]!.code} | ${recs.length} | ${f3(mu)} | ${f3(mean(s5))} (${f3(k5)} ± ${f3(k5se)}) | ${f3(mean(s1))} (${f3(mean(s1) / mu)}) | ${f3(1 + (2.063 * Math.sqrt(Math.max(0, varB))) / muAll)} | ${kb.map(f3).join(" · ")} | ${f3(dRatio)} ± ${f3(dSe)} (${dia.length}) · ${f3(dReal)} | ${ch.length ? `${f3(cRatio)} ± ${f3(cSe)} (${ch.length})` : "-"} |`);
  }
  const pooled = mean(s5All) / mean(allMeas);
  const pooledSe = pooled * Math.sqrt((sd(s5All) / mean(s5All)) ** 2 / s5All.length + (sd(allMeas) / mean(allMeas)) ** 2 / allMeas.length);
  const pooled1 = mean(s1All) / mean(allMeas);
  out.push("");
  out.push(`pooled κ5 **${f3(pooled)}** ± ${f3(pooledSe)} (× 0.86 → skilled-timer RTP ${f3(pooled * 0.86)}) · pooled κ1 ${f3(pooled1)} (→ ${f3(pooled1 * 0.86)})`);
  if (isRules10(catalog)) out.push("", ...skilledRules10(catalog, moments, nEst));
  const per = moments.filter((m) => m.tier === 0);
  const hist = [0, 0, 0, 0, 0];
  for (const m of per) hist[Math.min(4, m.f.expDia)]! += 1;
  out.push(`exposed Diamonds at the ${per.length} oracle moments: ${hist.map((n, i) => `${i}${i === 4 ? "+" : ""}: ${pct(n / Math.max(1, per.length))}`).join(" · ")}`);
  return out;
}

/**
 * (규칙 10, 명세 23 §4.3) 숙련자 상한: 순간마다 롤의 (T_main 기대 + κ × 골든 타격 수) ÷ 가격 = "S5 bound with jackpot κ·hG".
 * 잭팟 기대는 통이 어떤 크기든 한 골든 타격에 κ·P 이하이므로 통 상태와 무관한 상한이다. 앞 nEst 롤로 고르고 뒤 롤로 잰다(키트와 같음).
 */
function skilledRules10(catalog: Catalog, moments: readonly Moment[], nEst: number): string[] {
  const out: string[] = [];
  out.push(`#### rules 10 — skilled timer with the LUCKY PICK ladder at expectation and the jackpot bound κ × Golden hits (κ ${jackpotKappa(catalog)}; pool-independent)`);
  out.push("");
  out.push("| tier | moments | random-moment (ladder) | jackpot bound κ·hG (mean) | random-moment (ladder + κ·hG) | **S5 bound** | S1 bound | κ5 | S5 Golden hits |");
  out.push("|---|---|---|---|---|---|---|---|---|");
  const s5All: number[] = [];
  for (let t = 0; t < catalog.pickaxes.length; t++) {
    const ms = moments.filter((m) => m.tier === t);
    if (!ms.length) continue;
    const v = (m: Moment, a: number, b: number) => mean(m.lad.slice(a, b).map((x, i) => x + m.jb[a + i]!));
    const recs = ms.map((m) => ({ est: v(m, 0, nEst), meas: v(m, nEst, m.lad.length), lad: mean(m.lad), jb: mean(m.jb), hG: mean(m.jb) / Math.max(1e-12, jackpotKappa(catalog)) }));
    const mu = mean(recs.map((r) => r.meas));
    const th5 = quant(recs.map((r) => r.est), 0.95);
    const th1 = quant(recs.map((r) => r.est), 0.99);
    const s5 = recs.filter((r) => r.est >= th5);
    const s1 = recs.filter((r) => r.est >= th1);
    s5All.push(...s5.map((r) => r.meas));
    out.push(`| ${catalog.pickaxes[t]!.code} | ${recs.length} | ${f3(mean(recs.map((r) => r.lad)))} | ${f4(mean(recs.map((r) => r.jb)))} | ${f3(mu)} | **${f3(mean(s5.map((r) => r.meas)))}** | ${f3(mean(s1.map((r) => r.meas)))} | ${f3(mean(s5.map((r) => r.meas)) / mu)} | ${jackpotKappa(catalog) > 0 ? mean(s5.map((r) => r.hG)).toFixed(2) : "-"} |`);
  }
  out.push("");
  out.push(`pooled S5 bound (ladder + κ·hG, all tiers) **${f3(mean(s5All))}** (G1 gate: < 0.97, two seed batches averaged)`);
  return out;
}

function dayTable(catalog: Catalog, days: readonly Day[], players: number): string[] {
  const p = mean(days.map((d) => (d.ever ? 1 : 0)));
  const fps = catalog.physics.fps;
  return [
    `### free day — ${players}-player room, 10,000 credits, ×1 until broke (< 1,000), ${days.length} complete days (no truncated last day)`,
    "",
    `winning days (ever above the start) **${pct(p)}** ± ${pct(Math.sqrt((p * (1 - p)) / days.length))} · ${mean(days.map((d) => d.n)).toFixed(1)} pickaxes per day (median ${quant(days.map((d) => d.n), 0.5)}) · ${(mean(days.map((d) => d.ticks)) / fps / 60).toFixed(1)} min on the board · mean best balance ${(mean(days.map((d) => d.maxBal)) / (10 * catalog.pickaxes[0]!.priceCredits * 1000)).toFixed(2)} × start`,
    "",
    `days that see a pickaxe at ≥ r × (settled payout + over ÷ price, rules 10 incl. LUCKY PICK and jackpot): ${[1.1, 1.2, 1.3, 1.5, 2, 3].map((r) => `≥${r}× ${pct(mean(days.map((d) => (d.best >= r - 1e-9 ? 1 : 0))))}`).join(" · ")}`,
  ];
}

// ──────────────────────────────────────────────────────────────────────────
// 실행
// ──────────────────────────────────────────────────────────────────────────
type Task = { kind: "room"; players: number } | { kind: "skilled"; players: number } | { kind: "day"; players: number };
interface Job { o: Options; task: Task; seeds: number[] }

function runJob(job: Job): RoomOut | Moment[] | Day[] {
  const { o, task, seeds } = job;
  const catalog = loadCatalogFor(o.catalog);
  if (task.kind === "room") return runRoom(catalog, task.players, seeds, o.pickaxes, o.seedoff, o.every, o.feel);
  if (task.kind === "skilled") return runSkilled(catalog, task.players, seeds, o.windows, o.every, o.rolls, o.seedoff, o.warmup, o.warmplayers);
  return runDays(catalog, task.players, seeds, o.days, o.seedoff);
}

/** 시드를 워커 n개에 나눠 같은 일을 돌린다. */
function parallel<T>(o: Options, task: Task): Promise<T[]> {
  const all = Array.from({ length: o.seeds }, (_, i) => i + 1);
  const n = Math.max(1, Math.min(o.workers, all.length));
  return Promise.all(Array.from({ length: n }, (_, id) => new Promise<T>((resolve, reject) => {
    const job: Job = { o, task, seeds: all.filter((s) => s % n === id) };
    const worker = new Worker(fileURLToPath(import.meta.url), { workerData: { balanceJob: job } });
    worker.once("message", (m: T) => resolve(m));
    worker.once("error", reject);
  })));
}

function mergeRooms(parts: RoomOut[]): RoomOut {
  const s = newSafety();
  for (const p of parts) {
    for (const k of Object.keys(s) as (keyof Safety)[]) {
      s[k] = k === "chordDepthMax" || k === "stepMax" ? Math.max(s[k], p.safety[k]) : s[k] + p.safety[k];
    }
  }
  const feels = parts.map((p) => p.feel).filter((f): f is FeelHist[] => f !== null);
  const feel = feels.length === 0 ? null : feels[0]!.map((_, t) => ({
    rises: feels[0]![t]!.rises.map((_, i) => sum(feels.map((f) => f[t]!.rises[i]!))),
    falls: feels[0]![t]!.falls.map((_, i) => sum(feels.map((f) => f[t]!.falls[i]!))),
  }));
  return {
    players: parts[0]!.players, rows: parts.flatMap((p) => p.rows), windows: sum(parts.map((p) => p.windows)), safety: s,
    exposure: parts.reduce((a, p) => a.map((x, i) => x + p.exposure[i]!), [0, 0, 0, 0, 0]),
    fractional: {
      payouts: sum(parts.map((p) => p.fractional.payouts)), jackpots: sum(parts.map((p) => p.fractional.jackpots)),
      settlements: sum(parts.map((p) => p.fractional.settlements)),
    },
    scaleOverCap: sum(parts.map((p) => p.scaleOverCap)), feel,
    genRows: sum(parts.map((p) => p.genRows)), quads: sum(parts.map((p) => p.quads)),
    luckyMults: parts.reduce((a, p) => { for (const [g, m] of Object.entries(p.luckyMults)) { const t = (a[g] ??= {}); for (const [k, c] of Object.entries(m)) t[Number(k)] = (t[Number(k)] ?? 0) + c; } return a; }, {} as Record<string, Record<number, number>>),
    luckyKinds: parts.reduce((a, p) => a.map((x, i) => x + p.luckyKinds[i]!), parts[0]!.luckyKinds.map(() => 0)),
    violations: sum(parts.map((p) => p.violations)), violationSamples: parts.flatMap((p) => p.violationSamples).slice(0, 10),
  };
}

async function main(): Promise<number> {
  const o = parseOptions(process.argv.slice(2));
  const catalog = loadCatalogFor(o.catalog);
  const t0 = Date.now();
  const out: string[] = [];
  out.push(`engine balance (rules ${catalog.rulesVersion}) — ${o.catalog}, rulesVersion ${catalog.rulesVersion}, LUCKY shareByTier ${catalog.lucky.shareByTier.join("/")}${catalog.lucky.multByKind ? " + mult ladders" : ""}, REWARD cap ${catalog.reward.rewardCapBps} bps, bots ${catalog.bots.map((b) => `${b.code}×${b.count}`).join(" ")}, mode ${o.mode}, ${o.seeds} seeds (offset ${o.seedoff}), players ${o.players.join(",")}, ${o.workers} workers`);
  let code = 0;
  for (const players of o.players) {
    out.push("");
    if (o.mode === "room" || o.mode === "f9") {
      const room = mergeRooms(await parallel<RoomOut>(o, { kind: "room", players }));
      if (o.mode === "room") out.push(...roomTables(catalog, room));
      else out.push(`### ${players}-player room — ${o.seeds} seeds × ${o.pickaxes} pickaxes per player`, "");
      const f9 = f9Report(catalog, room.rows);
      out.push("", ...f9Table(catalog, f9));
      if (o.mode === "f9" && !f9.ok) code = 1;
    } else if (o.mode === "skilled") {
      const moments = (await parallel<Moment[]>(o, { kind: "skilled", players })).flat();
      out.push(`### ${players}-player room, ${o.windows} windows per seed, every ${o.every} windows${o.warmup > 0 ? ` — after a warm-up of ${o.warmup}…${2 * o.warmup - 1} windows with ${o.warmplayers} players (a board that has moved 120–250 rows, spec 21 §3.7)` : " — fresh boards (the first ~30 rows)"}`, "");
      out.push(...skilledTables(catalog, moments, o.rolls));
    } else {
      const days = (await parallel<Day[]>(o, { kind: "day", players })).flat();
      out.push(...dayTable(catalog, days, players));
    }
  }
  out.push("", `${((Date.now() - t0) / 1000).toFixed(1)} s`);
  if (code !== 0) out.push("", "**F-9 FAILED**");
  console.log(out.join("\n"));
  return code;
}

if (isMainThread) {
  if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
    main().then((code) => { process.exitCode = code; }, (e: unknown) => { console.error(e); process.exit(1); });
  }
} else if ((workerData as { balanceJob?: Job } | null)?.balanceJob) {
  parentPort!.postMessage(runJob((workerData as { balanceJob: Job }).balanceJob));
}
