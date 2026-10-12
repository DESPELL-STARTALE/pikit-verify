import type { Catalog, SkyEventRules } from "@pikit/protocol";
import type { PhysicsEngine } from "./physics.js";
import type { RngFactory } from "./rng.js";
import type { PickaxeState, RoomState, SkyItem, SkyState } from "./types.js";

// ──────────────────────────────────────────────────────────────────────────
// 하늘 이벤트 "✨ 별" (D125, 규칙 6, 명세 docs/specs/07-sky-event.md §2·§3)
//  - 판 위 플레이어 곡괭이가 minPlayers개 이상이고 쿨다운이 끝났으면 윈도마다 스트림 `sky`의 u₁ < chancePerWindow로 별 1개가 떨어진다.
//    떨어지는 자리 = 판 위 플레이어 곡괭이 하나를 고르게 골라(u₂) 그 aboveRows칸 위(막히면 위·옆 빈자리), 처음 vx = (u₃ − ½) × vxJitter.
//  - 별 = 작은 원 몸(원 몸 물리 그대로, 블록 피해 없음, 다른 몸과 충돌 없음, 킥은 스트림 `skykick|<id>`).
//  - 틱마다(곡괭이 물리·정산 뒤) 별 한 걸음 → 곡괭이 **중심**에서 catchRadius 안에 별 중심이 들어온 플레이어 곡괭이 중 가장 가까운 것
//    (같으면 배열 앞)이 잡는다 → 커지기 효과. 봇은 세지도·잡지도·커지지도 않는다.
//  - lifeTicks 안에 안 잡히면 사라진다. 잡히거나 사라지면 nextWindow = 그 윈도 + 1 + cooldownWindows.
//  - 효과 GROW: untilTick까지 목표 지름 max(등급 지름, grow.scale)로 틱당 stepPerTick씩(tryGrow가 받아 줄 때만), 그 뒤 같은 폭으로 줄인다.
//  - 돈은 바꾸지 않는다 — 공격력·내구도·POP·정산·상한 그대로. 커진 몸은 같은 내구도를 더 빨리 쓸 뿐이다.
// 무작위는 커밋된 시드 + 블록 해시의 윈도 스트림(`sky`·`skykick|<id>`)뿐이다(D111) — 새 엔진 입력은 없다.
// ──────────────────────────────────────────────────────────────────────────

/** 윈도 하나의 하늘 사건 (일어난 순서). DROP = 고른(겨눈) 곡괭이, CAUGHT = 잡은 곡괭이, EXPIRED = 주인 없음. x·y = 사건 때 별 자리. */
export interface RoomSkyEvent {
  kind: "DROP" | "CAUGHT" | "EXPIRED";
  id: number;
  window: number;
  tick: number;
  x: number;
  y: number;
  key: string | null;
  owner: string | null;
  tier: number | null;
}

/** 새 방의 하늘 상태 (카탈로그에 skyEvent가 있을 때만 만든다). */
export function createSkyState(): SkyState {
  return { item: null, nextWindow: 0, boosts: [] };
}

/** 효과 중 목표 지름 = max(등급 지름, grow.scale). */
export function skyGrowScale(rules: SkyEventRules, base: number): number {
  return Math.max(base, rules.grow.scale);
}

/** 판 위 플레이어 곡괭이 (배열 순서 = 판에 들어온 순). 봇은 owner = null이라 빠진다. */
function boardPlayers(state: RoomState): PickaxeState[] {
  return state.pickaxes.filter((p) => p.owner !== null);
}

/** 별을 놓을 x 후보 (이 순서): x₀, x₀ ∓ 0.5, x₀ ∓ 1, x₀ ∓ 1.5, x₀ ∓ 2 중 [lo, hi] 안의 것. */
function dropXs(x0: number, lo: number, hi: number): number[] {
  const xs: number[] = [x0];
  for (let k = 1; k <= 4; k++) {
    for (const x of [x0 - 0.5 * k, x0 + 0.5 * k]) if (x >= lo && x <= hi) xs.push(x);
  }
  return xs;
}

/**
 * 윈도 2.5단계 (스폰 뒤, 틱 전): 조건이 되면 `sky` 스트림에서 뽑아 별을 떨어뜨린다. 뽑기는 u₁ → (맞으면) u₂ → u₃ 세 번이 전부다.
 * 조건이 안 되면 스트림을 만들지도 않는다. 빈자리가 하나도 없으면 이번 윈도는 안 떨어진다(쿨다운도 시작 안 함).
 */
export function maybeDropSkyItem(
  state: RoomState, catalog: Catalog, window: number, rng: RngFactory, physics: PhysicsEngine, out: RoomSkyEvent[],
): void {
  const rules = catalog.skyEvent;
  const sky = state.sky;
  if (!rules || !sky || sky.item !== null || window < sky.nextWindow) return;
  const players = boardPlayers(state);
  if (players.length < rules.minPlayers) return;
  const s = rng("sky");
  if (!(s.next() < rules.chancePerWindow)) return;
  const u2 = s.next();
  const u3 = s.next();
  const it = rules.item;
  const width = catalog.world.width;
  const d = it.diameter;
  const target = players[Math.floor(u2 * players.length)]!;
  const x0 = Math.min(width - d, Math.max(d, target.x));
  const y0 = target.y - it.aboveRows;
  // 놓을 자리: 위로 0.5칸씩 (j = 0…8), 각 줄에서 x 후보 순서대로 — 처음 빈 곳
  const xs = dropXs(x0, d, width - d);
  let placed: [number, number] | null = null;
  for (let j = 0; j <= 8 && placed === null; j++) {
    const y = y0 - 0.5 * j;
    for (const x of xs) {
      if (!physics.ballOverlaps(x, y, d, state.blocks, width)) {
        placed = [x, y];
        break;
      }
    }
  }
  if (placed === null) return;
  const item: SkyItem = {
    id: window, x: placed[0], y: placed[1], vx: (u3 - 0.5) * it.vxJitter, vy: it.startVy, angle: 0, vAngle: 0,
    scale: d, frictionPerTick: it.frictionPerTick, dropTick: state.tick, ticks: 0,
  };
  sky.item = item;
  out.push({ kind: "DROP", id: item.id, window, tick: state.tick, x: item.x, y: item.y, key: target.key, owner: target.owner, tier: target.tier });
}

/**
 * 틱 안 (곡괭이 물리 앞): 효과 받는 곡괭이의 지름을 목표 쪽으로 한 걸음. 커질 때는 tryGrow(겹침·밀림 검사)가 받아 줄 때만,
 * 줄일 때는 늘 허용. 효과가 끝났고 등급 지름으로 돌아왔으면 그 항목을 지운다.
 */
export function stepSkyBoosts(state: RoomState, catalog: Catalog, physics: PhysicsEngine): void {
  const rules = catalog.skyEvent;
  const sky = state.sky;
  if (!rules || !sky || sky.boosts.length === 0) return;
  const tick = state.tick;
  const keep = [];
  for (const b of sky.boosts) {
    const p = state.pickaxes.find((q) => q.key === b.key);
    if (!p) continue;   // (방어) 끝난 곡괭이 — settle이 이미 지운다
    const base = catalog.pickaxes[p.tier]!.scale;
    const target = tick < b.untilTick ? skyGrowScale(rules, base) : base;
    if (p.scale < target) physics.tryGrow(p, Math.min(target, p.scale + rules.grow.stepPerTick), state.blocks, catalog.world.width);
    else if (p.scale > target) p.scale = Math.max(target, p.scale - rules.grow.stepPerTick);
    if (!(tick >= b.untilTick && p.scale === base)) keep.push(b);
  }
  sky.boosts = keep;
}

/**
 * 틱 안 (곡괭이 물리·끝 정산 뒤 = 이번 틱에 끝난 곡괭이는 못 잡는다): 별 한 걸음 → 잡기 → 시간 끝.
 * 잡기: 판 위 플레이어 곡괭이마다 c = catchRadius − |별 중심 − 곡괭이 중심|, c > 0 중 가장 큰 것(같으면 배열 앞).
 */
export function stepSkyItem(
  state: RoomState, catalog: Catalog, window: number, rng: RngFactory, physics: PhysicsEngine, out: RoomSkyEvent[],
): void {
  const rules = catalog.skyEvent;
  const sky = state.sky;
  const item = sky?.item;
  if (!rules || !sky || !item) return;
  const tick = state.tick;
  physics.advanceBall(item, state.blocks, catalog.world.width, rng(`skykick|${item.id}`));
  physics.clampPickaxeToGeneratedDepth(item, state.generatedRowCount);
  item.ticks += 1;
  if (!Number.isFinite(item.x) || !Number.isFinite(item.y) || !Number.isFinite(item.vx) || !Number.isFinite(item.vy)) {
    throw new Error(`engine: non-finite sky item state (${item.id})`);
  }

  let best: PickaxeState | null = null;
  let bestC = 0;
  for (const p of state.pickaxes) {
    if (p.owner === null) continue;   // 봇은 못 잡는다
    const dx = item.x - p.x;
    const dy = item.y - p.y;
    const c = rules.item.catchRadius - Math.sqrt(dx * dx + dy * dy);
    if (c > bestC) {
      best = p;
      bestC = c;
    }
  }
  if (best !== null) {
    const until = tick + rules.grow.durationTicks;
    const had = sky.boosts.find((b) => b.key === best.key);
    if (had) had.untilTick = until;
    else sky.boosts.push({ key: best.key, untilTick: until });
    out.push({ kind: "CAUGHT", id: item.id, window, tick, x: item.x, y: item.y, key: best.key, owner: best.owner, tier: best.tier });
    sky.item = null;
    sky.nextWindow = window + 1 + rules.cooldownWindows;
    return;
  }
  if (item.ticks >= rules.item.lifeTicks) {
    out.push({ kind: "EXPIRED", id: item.id, window, tick, x: item.x, y: item.y, key: null, owner: null, tier: null });
    sky.item = null;
    sky.nextWindow = window + 1 + rules.cooldownWindows;
  }
}

/** 곡괭이가 어떤 이유로든 끝나면(settle — 내구도·타이머·멈춤·동결·무효) 그 효과 항목도 지운다. */
export function dropSkyBoost(state: RoomState, key: string): void {
  if (state.sky.boosts.length > 0) state.sky.boosts = state.sky.boosts.filter((b) => b.key !== key);
}
