import { catalogBuffKind, catalogScaleCap, type BuffKind, type Catalog } from "@pikit/protocol";
import type { PhysicsEngine } from "./physics.js";
import { streamU53 } from "./reward.js";
import type { RngFactory } from "./rng.js";
import { skyGrowScale } from "./sky.js";
import { detSinCos } from "./trig.js";
import type { PickaxeState, RoomState } from "./types.js";

// ──────────────────────────────────────────────────────────────────────────
// (규칙 11, 명세 24 §3.8 · §4.2) COMBO 성장 · LUCKY 버프 — catalog.buffs가 없으면 아무것도 하지 않는다(규칙 10과 비트까지 같음).
//  - 성장: COMBO 단계(같은 종류 새 블록 연속 s ≥ 2 — reward.ts)마다 popStacks + 1 (≤ growMaxStacks), 무작위 없음, 수명 내내
//  - LUCKY 버프: 새 LUCKY 블록(내 LUCKY 종류이고 이 곡괭이가 처음 닿은 칸)마다 1개, 곡괭이당 ≤ lucky.maxPerPickaxe.
//      스트림 `buff|<키>|<n>`(n = buffCount, 0부터): 첫 수 = 종류(catalogBuffKind — 누적 가중 (u53 × Σw) >> 53), 둘째 수 = DASH 각도(× 2π)
//      GIANT  giantUntil = 틱 + ticks → 크기 목표 × scaleBps/10⁴     SPEED  gravityMulBps = gravityBps, speedUntil = 틱 + ticks
//      DASH   속도 벡터 = speed × (cos θ, sin θ) (그 순간 한 번)       LIFE   내구도 총·남은 += ⌊D × durabilityBps / 10⁴⌋ (D = 등급 내구도)
//  - 끝: 틱 끝(곡괭이 물리·보상 뒤, 정산 앞)에 tick ≥ until이면 지운다 — GIANT는 크기 목표를 다시, SPEED는 배수 ×1
//  - 크기: 목표 = max(몸 지름, min(catalogScaleCap, 몸 지름 × (10⁴ + popStacks × growStepBps)/10⁴ × (GIANT면 scaleBps/10⁴))).
//      지름은 하늘 효과(D125)와 한 길(stepScales)로 따라간다: 틱마다 stepPerTick만큼, 커질 때는 tryGrow가 받아 줄 때만(박힘·관통 없음).
//  - 봇·대기열 곡괭이는 COMBO·성장·버프가 없다(봇은 creditHits에서 걸러지고, 대기열 항목은 판에 없다).
// 무작위는 커밋된 시드 + 블록 해시의 윈도 스트림뿐이다(D08·D111). 돈을 바꾸는 버프는 LIFE 하나다(타격 수 + ≤ maxPerPickaxe × durabilityBps).
// ──────────────────────────────────────────────────────────────────────────

const TWO_PI = Math.PI * 2;
/** 중력 배수 ×1 (bps). */
export const GRAVITY_MUL_ONE_BPS = 10_000;

/**
 * (규칙 11) 윈도 안에서 난 LUCKY 버프 1건 (일어난 순서). 게임 서버가 피드 `BUFF`(buffKind)로 바꾼다.
 * n = 그 곡괭이의 버프 순번(0부터) = 뽑은 스트림 `buff|<키>|<n>`의 n. tick = 뽑은 틱(새 LUCKY 블록을 친 틱).
 */
export interface RoomBuffEvent {
  key: string;
  owner: string;
  tier: number;
  window: number;
  tick: number;
  kind: BuffKind;
  n: number;
}

/** GIANT 칸 (표에 없으면 undefined). */
function giantSpec(catalog: Catalog): Extract<NonNullable<Catalog["buffs"]>["lucky"]["table"][number], { kind: "GIANT" }> | undefined {
  for (const b of catalog.buffs?.lucky.table ?? []) if (b.kind === "GIANT") return b;
  return undefined;
}

/**
 * 플레이어 곡괭이의 버프 크기 목표 (위 머리말의 식). buffs가 없거나 성장·GIANT가 없으면 몸 지름 그대로(계산하지 않는다).
 * 상한(catalogScaleCap)이 몸 지름보다 작게 잡힌 카탈로그에서도 몸 지름 아래로는 줄이지 않는다.
 */
export function scaleTargetOf(catalog: Catalog, p: Pick<PickaxeState, "tier" | "popStacks" | "giantUntil">): number {
  const tier = catalog.pickaxes[p.tier];
  if (!tier) throw new Error(`scaleTargetOf: unknown tier ${p.tier}`);
  const base = tier.scale;
  const b = catalog.buffs;
  if (!b || (p.popStacks === 0 && p.giantUntil === 0)) return base;
  let s = (base * (10000 + p.popStacks * b.growStepBps)) / 10000;
  const giant = p.giantUntil > 0 ? giantSpec(catalog) : undefined;
  if (giant) s = (s * giant.scaleBps) / 10000;
  return Math.max(base, Math.min(catalogScaleCap(catalog, p.tier), s));
}

/** COMBO 단계 하나의 성장: popStacks < growMaxStacks면 +1 하고 크기 목표를 다시 잡는다. buffs가 없거나 봇이면 없음. */
export function growOnCombo(catalog: Catalog, p: PickaxeState): void {
  const b = catalog.buffs;
  if (!b || p.owner === null || p.popStacks >= b.growMaxStacks) return;
  p.popStacks += 1;
  p.scaleTarget = scaleTargetOf(catalog, p);
}

/**
 * 새 LUCKY 블록 1개의 버프 뽑기·적용 (호출자 = creditHits: 주인 있음 ∧ 처음 닿은 칸 ∧ 블록 종류 = luckyKind일 때만).
 * buffCount ≥ maxPerPickaxe거나 buffs·표가 없으면 null(순번을 쓰지 않는다). 사건을 돌려준다.
 */
export function drawLuckyBuff(catalog: Catalog, p: PickaxeState, rng: RngFactory, at: { window: number; tick: number }): RoomBuffEvent | null {
  const b = catalog.buffs;
  if (!b || p.owner === null || p.buffCount >= b.lucky.maxPerPickaxe) return null;
  const n = p.buffCount;
  const stream = rng(`buff|${p.key}|${n}`);
  const spec = catalogBuffKind(catalog, streamU53(stream));
  if (!spec) return null;
  p.buffCount = n + 1;
  switch (spec.kind) {
    case "GIANT":
      p.giantUntil = at.tick + spec.ticks;
      p.scaleTarget = scaleTargetOf(catalog, p);
      break;
    case "DASH": {
      const { sin, cos } = detSinCos(stream.next() * TWO_PI);
      p.vx = spec.speed * cos;
      p.vy = spec.speed * sin;
      break;
    }
    case "SPEED":
      p.gravityMulBps = spec.gravityBps;
      p.speedUntil = at.tick + spec.ticks;
      break;
    case "LIFE": {
      const add = Math.floor((catalog.pickaxes[p.tier]!.durability * spec.durabilityBps) / 10000);
      p.durabilityTotal += add;
      p.durabilityLeft += add;
      break;
    }
  }
  return { key: p.key, owner: p.owner, tier: p.tier, window: at.window, tick: at.tick, kind: spec.kind, n };
}

/** 틱 끝(곡괭이 물리·보상 뒤, 정산 앞): tick ≥ until인 GIANT·SPEED를 지운다. GIANT는 크기 목표를 다시, SPEED는 중력 ×1. */
export function expireBuffs(state: RoomState, catalog: Catalog, tick: number): void {
  for (const p of state.pickaxes) {
    if (p.owner === null) continue;
    if (p.giantUntil > 0 && tick >= p.giantUntil) {
      p.giantUntil = 0;
      p.scaleTarget = scaleTargetOf(catalog, p);
    }
    if (p.speedUntil > 0 && tick >= p.speedUntil) {
      p.speedUntil = 0;
      p.gravityMulBps = GRAVITY_MUL_ONE_BPS;
    }
  }
}

/**
 * 틱 안 (곡괭이 물리 앞): 플레이어 곡괭이마다 지름을 목표 쪽으로 한 걸음 — 하늘 효과(D125)와 버프 크기가 한 길이다.
 *  목표 = scaleTarget, 하늘 효과 중(tick < untilTick)이면 max(scaleTarget, max(몸 지름, grow.scale)).
 *  커질 때는 tryGrow(겹침·밀림 검사)가 받아 줄 때만 min(목표, 지름 + stepPerTick), 줄 때는 늘 max(목표, 지름 − stepPerTick).
 *  하늘 효과 항목은 끝났고(tick ≥ untilTick) 지름이 scaleTarget 이하로 돌아오면 지운다(곡괭이가 없으면 지운다).
 * 몸끼리는 충돌하지 않아(블록·벽만) 곡괭이 순서가 결과를 바꾸지 않는다 — 규칙 10 카탈로그(scaleTarget = 몸 지름)에서는 옛 stepSkyBoosts와 비트까지 같다.
 */
export function stepScales(state: RoomState, catalog: Catalog, physics: PhysicsEngine): void {
  const rules = catalog.skyEvent;
  const sky = state.sky;
  const tick = state.tick;
  const step = rules.grow.stepPerTick;
  for (const p of state.pickaxes) {
    if (p.owner === null) continue;
    let target = p.scaleTarget;
    if (sky.boosts.length > 0) {
      const boost = sky.boosts.find((b) => b.key === p.key);
      if (boost && tick < boost.untilTick) target = Math.max(target, skyGrowScale(rules, catalog.pickaxes[p.tier]!.scale));
    }
    if (p.scale < target) physics.tryGrow(p, Math.min(target, p.scale + step), state.blocks, catalog.world.width);
    else if (p.scale > target) p.scale = Math.max(target, p.scale - step);
  }
  if (sky.boosts.length > 0) {
    sky.boosts = sky.boosts.filter((b) => {
      const p = state.pickaxes.find((q) => q.key === b.key);
      return p !== undefined && !(tick >= b.untilTick && p.scale <= p.scaleTarget);
    });
  }
}
