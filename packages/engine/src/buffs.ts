import { catalogBuffKind, catalogItemWins, catalogScaleCap, type BuffKind, type BuffSpec, type Catalog } from "@pikit/protocol";
import type { PhysicsEngine } from "./physics.js";
import { streamU53 } from "./reward.js";
import type { RngFactory } from "./rng.js";
import { skyGrowScale } from "./sky.js";
import { detSinCos } from "./trig.js";
import type { BlockState, PickaxeState, RoomState } from "./types.js";

// ──────────────────────────────────────────────────────────────────────────
// (규칙 11, 명세 24 §3.8 · §4.2) COMBO 성장 · (규칙 12, 명세 25 §3.3) 막타 룰렛 아이템 — catalog.buffs가 없으면 아무것도 하지 않는다.
//  - 성장: COMBO 단계(같은 종류 새 블록 연속 s ≥ 2 — reward.ts)마다 popStacks + 1 (≤ growMaxStacks), 무작위 없음, 수명 내내
//  - 아이템 뽑기(rollItem): 플레이어 곡괭이의 막타(LAST HIT, reward.ts 3)마다 — 대기 중인 룰렛이 없고(itemUntil = 0) buffCount < items.maxPerPickaxe일 때만.
//      스트림 `item|<키>|<h>`(h = 그 막타의 순번 = 막타 뒤 lastHits − 1): 첫 수 u53 → 당첨 ⟺ catalogItemWins(블록 종류) (u53 × 10⁴ < chanceBps × 2⁵³),
//      당첨이면 둘째 수 → 종류(catalogBuffKind — 누적 가중 (u53 × Σw) >> 53), DASH면 셋째 수 × 2π = 각도. 꽝은 상태·사건 없음(스트림만 쓴다).
//      당첨: buffCount + 1 · itemUntil = 틱 + rouletteTicks · itemKind = 표 위치 · itemAngle. 사건 RoomBuffEvent(뽑은 틱 · 막타 칸 · 블록 종류).
//  - 적용(resolveItems): 틱 끝 expireBuffs 뒤, 끝 판정 앞 — tick ≥ itemUntil인 곡괭이에 규칙 11 식 그대로:
//      GIANT  giantUntil = 틱 + ticks → 크기 목표 × scaleBps/10⁴     SPEED  gravityMulBps = gravityBps, speedUntil = 틱 + ticks
//      DASH   속도 벡터 = speed × (cos θ, sin θ) (그 순간 한 번)       LIFE   내구도 총·남은 += ⌊D × durabilityBps / 10⁴⌋ (D = 등급 내구도)
//    그다음 itemUntil = 0 · itemKind = −1 · itemAngle = 0. 대기 중(itemUntil > 0)인 곡괭이는 끝나지 않는다(room.ts 유예) — LIFE면 되살아난다.
//  - 끝: 틱 끝(곡괭이 물리·보상 뒤, 정산 앞)에 tick ≥ until이면 지운다 — GIANT는 크기 목표를 다시, SPEED는 배수 ×1
//  - 크기: 목표 = max(몸 지름, min(catalogScaleCap, 몸 지름 × (10⁴ + popStacks × growStepBps)/10⁴ × (GIANT면 scaleBps/10⁴))).
//      지름은 하늘 효과(D125)와 한 길(stepScales)로 따라간다: 틱마다 stepPerTick만큼, 커질 때는 tryGrow가 받아 줄 때만(박힘·관통 없음).
//  - 봇·대기열 곡괭이는 COMBO·성장·아이템이 없다(봇은 creditHits에서 걸러지고, 대기열 항목은 판에 없다).
// 무작위는 커밋된 시드 + 블록 해시의 윈도 스트림뿐이다(D08·D111). 돈을 바꾸는 아이템은 LIFE 하나다(타격 수 + ≤ maxPerPickaxe × durabilityBps).
// ──────────────────────────────────────────────────────────────────────────

const TWO_PI = Math.PI * 2;
/** 중력 배수 ×1 (bps). */
export const GRAVITY_MUL_ONE_BPS = 10_000;

/**
 * (규칙 12, 명세 25 §3.3.2 · §4.3) 윈도 안에서 난 아이템 당첨 1건 (일어난 순서 — 같은 타격의 막타·COMBO 사건 뒤). 게임 서버가 피드 `BUFF`로 바꾼다.
 * tick = 뽑은 틱 t₀(룰렛은 t₀ + rouletteTicks에 멈추고 그때 적용). n = 그 곡괭이의 아이템 순번(0부터 = 당첨 전 buffCount),
 * h = 막타 순번(스트림 `item|<키>|<h>`), (x, y) = 막타 칸(2×2면 앵커), blockKind = 그 블록 종류.
 */
export interface RoomBuffEvent {
  key: string;
  owner: string;
  tier: number;
  window: number;
  tick: number;
  kind: BuffKind;
  n: number;
  h: number;
  x: number;
  y: number;
  blockKind: number;
}

/** GIANT 칸 (표에 없으면 undefined). */
function giantSpec(catalog: Catalog): Extract<BuffSpec, { kind: "GIANT" }> | undefined {
  for (const b of catalog.buffs?.items.table ?? []) if (b.kind === "GIANT") return b;
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
 * (규칙 12) 막타 1건의 아이템 뽑기 (호출자 = creditHits: 주인 있는 곡괭이의 막타 직후 — p.lastHits는 이미 이 막타를 센 값).
 * buffs가 없거나 대기 중인 룰렛이 있거나(itemUntil > 0) buffCount ≥ maxPerPickaxe면 null(스트림을 열지 않는다).
 * 꽝(확률 실패)·빈 표도 null(상태 그대로). 당첨이면 결과를 정해 두고(적용은 resolveItems가 t₀ + rouletteTicks에) 사건을 돌려준다.
 * block = 막타 블록(2×2면 앵커 — physics HitEvent.block).
 */
export function rollItem(
  catalog: Catalog, p: PickaxeState, block: Pick<BlockState, "kind" | "x" | "y">, rng: RngFactory, at: { window: number; tick: number },
): RoomBuffEvent | null {
  const b = catalog.buffs;
  if (!b || p.owner === null || p.itemUntil > 0 || p.buffCount >= b.items.maxPerPickaxe) return null;
  const h = p.lastHits - 1;
  const stream = rng(`item|${p.key}|${h}`);
  if (!catalogItemWins(catalog, block.kind, streamU53(stream))) return null;
  const spec = catalogBuffKind(catalog, streamU53(stream));
  if (!spec) return null;
  const n = p.buffCount;
  p.buffCount = n + 1;
  p.itemUntil = at.tick + b.items.rouletteTicks;
  p.itemKind = b.items.table.indexOf(spec);
  p.itemAngle = spec.kind === "DASH" ? stream.next() * TWO_PI : 0;
  return {
    key: p.key, owner: p.owner, tier: p.tier, window: at.window, tick: at.tick, kind: spec.kind, n, h, x: block.x, y: block.y, blockKind: block.kind,
  };
}

/**
 * (규칙 12, 명세 25 §3.3.3) 룰렛이 멈추는 틱: tick ≥ itemUntil > 0인 플레이어 곡괭이마다 정해 둔 아이템을 규칙 11 식 그대로 적용하고 대기를 지운다.
 * 틱 순서: expireBuffs 뒤, 끝 판정 앞 (그래서 LIFE는 내구도 0인 곡괭이를 되살린다). 적용은 사건을 따로 내지 않는다(뽑기 사건 + rouletteTicks로 정해진다).
 */
export function resolveItems(state: RoomState, catalog: Catalog, tick: number): void {
  const b = catalog.buffs;
  if (!b) return;
  for (const p of state.pickaxes) {
    if (p.owner === null || p.itemUntil <= 0 || tick < p.itemUntil) continue;
    const spec = b.items.table[p.itemKind];
    if (!spec) throw new Error(`resolveItems: no item ${p.itemKind} for ${p.key}`);
    switch (spec.kind) {
      case "GIANT":
        p.giantUntil = tick + spec.ticks;
        p.scaleTarget = scaleTargetOf(catalog, p);
        break;
      case "DASH": {
        const { sin, cos } = detSinCos(p.itemAngle);
        p.vx = spec.speed * cos;
        p.vy = spec.speed * sin;
        break;
      }
      case "SPEED":
        p.gravityMulBps = spec.gravityBps;
        p.speedUntil = tick + spec.ticks;
        break;
      case "LIFE": {
        const add = Math.floor((catalog.pickaxes[p.tier]!.durability * spec.durabilityBps) / 10000);
        p.durabilityTotal += add;
        p.durabilityLeft += add;
        break;
      }
    }
    p.itemUntil = 0;
    p.itemKind = -1;
    p.itemAngle = 0;
  }
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
