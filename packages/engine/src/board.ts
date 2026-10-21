import { bandOf, catalogFixedRows, catalogQuadChanceBps, clearOfFixedRows, type Catalog } from "@pikit/protocol";
import type { Rng, RngFactory } from "./rng.js";
import type { BlockState, CompletedBatch, RoomState } from "./types.js";

// ──────────────────────────────────────────────────────────────────────────
// 판(블록 링버퍼)과 2,000블록 묶음 생성 — 동기식, 시드로만 결정 (설계 §6.2, provable-fairness-design.md §5.4)
//  - 묶음 j = 줄 [j·R, (j+1)·R), R = batchBlocks / width (2,000 / 10 = 200줄)
//  - 묶음 시작 때 종류별 개수는 카탈로그의 batchCount 그대로
//  - (규칙 7, 명세 16 §7.1 — 띠 배치) kind ≥ generation.bandedFromKind 종류 k는 묶음을 c_k = batchCount개의 띠로 나눠
//    띠마다 정확히 1개를 놓는다. 띠 i = [start_i, end_i), start_i = i·⌊R/c⌋ + min(i, R mod c), 길이 ⌊R/c⌋ (+1, 앞의 R mod c개 띠).
//    놓는 줄은 띠의 안쪽 줄 [start + margin, end − margin) 중 하나를 차례 표본으로: 안쪽 줄 r에서 확률 1 / (안쪽에 남은 줄 수)
//    (마지막 안쪽 줄은 반드시). 칸은 그 줄의 빈 칸 중 고르게. "지금 채울 띠" = 이 묶음에서 그 종류를 이미 놓은 개수 → 새 상태 없음.
//  - 줄 y의 스트림은 `row|y` 하나. 뽑는 순서: 띠 종류를 큰 번호부터(규칙 8: Golden CHOG → CHOG Ore → 다이아 → … → 에메랄드) 각각 (안쪽 줄이면) u 하나로 놓을지,
//    놓으면 u 하나로 빈 칸(왼쪽부터 번호). 그다음 남은 칸마다(왼쪽부터) u 하나로 흔한 종류(0 … bandedFromKind − 1)의 비복원 추첨
//    ("남은 구성에서 floor(u × 남은 개수)번째").
//  - 같은 희귀 종류는 최소 3줄 간격 → 화면 15줄에 다이아 최대 3개. 묶음 구성은 정확(모든 종류 batchCount 그대로).
//  - (규칙 8, 명세 21 §3.6) kind ≥ generation.fixedFromKind 종류(CHOG 두 종류)는 띠 안의 고정 줄(protocol catalogFixedRows)에 놓는다 —
//    그 줄에서는 놓을지 뽑지 않고 u 하나로 빈 칸만 고른다. CHOG Ore는 띠의 첫 4분의 1 줄(16~17줄마다 정확히 1개), Golden CHOG는 Ore 줄에서 가장 먼 줄.
//    fixedClearKinds 종류(다이아)는 고정 줄 ± fixedClearRows 줄을 건너뛴다: 차례 표본의 "남은 줄 수"도 놓을 수 있는 줄만 센다(마지막 놓을 수 있는 줄은 반드시).
// 참조 구현: _analysis/sim-rules7-2026-10-12/patches/gen7.mjs (그대로 옮김). 검증기의 묶음 생성 검사(regenerateBatch)가 같은 drawRow를 쓴다.
//  - (규칙 12, 명세 25 §3.4.2) 2×2: generation.quadChanceBps[k] > 0인 고정 종류 k는 고정 줄에서 놓을 때 먼저 u_q 하나 — u_q × 10⁴ < chance면
//    짝 자리(나란히 빈 두 칸 x, x + 1 — 고정 종류가 그 줄에서 먼저라 늘 width − 1개) 중 ⌊u × 짝 수⌋번째에 k 둘(놓기 1번), 아니면 지금처럼 1칸.
//    바로 아래 줄(rr + 1)은 띠 종류보다 먼저 같은 두 칸을 k로 채운다(개수에 세지 않음). chance가 없거나 0이면 u_q를 뽑지 않는다(규칙 11 판과 비트까지 같음).
//    종류 배열의 무늬(고정 줄에 같은 고정 종류 둘 + 바로 아래 둘)가 2×2다 — 묶음 해시·regenerateBatch 형식 그대로. 고정 종류 k의 칸 수 = batchCount + 3 × (그 묶음의
//    k 2×2 수), 흔한 종류는 2×2 하나마다 3칸 덜 뽑힌다(묶음 끝에 남는다). 생성은 칸에 quad(1 · 2 위, 3 · 4 아래)와 묶음 체력(시작 4 × hp)을 붙인다.
// ──────────────────────────────────────────────────────────────────────────

/** (규칙 12) 2×2 묶음 체력 = 칸 hp × 이 수 (보상은 피해 비례라 다 캐면 4배 — 명세 25 §3.4.4). */
export const QUAD_HP_MULT = 4;

/** 빈 링버퍼 (width × height × multiplier 칸). */
export function createRingBuffer(catalog: Catalog): BlockState[] {
  const { width, height, ringBufferRowMultiplier } = catalog.world;
  const size = width * height * ringBufferRowMultiplier;
  const blocks: BlockState[] = [];
  for (let i = 0; i < size; i++) blocks.push({ kind: 0, x: 0, y: 0, health: 0, quad: 0 });
  return blocks;
}

/**
 * 줄을 rowCount개 더 만든다 (generatedRowCount부터). 줄 y의 링버퍼 슬롯 = (y mod 줄 수) × width + x.
 * window = 지금 처리 중인 윈도(이 줄들의 w(y)). 묶음 하나가 다 차면 CompletedBatch로 돌려준다(묶음 해시 H_j의 재료).
 * (규칙 12) 2×2: 위 두 칸(quad 1 · 2)은 체력 4 × hp, 아래 두 칸(3 · 4)은 그 순간 앵커의 체력(아래 줄이 생기기 전에 맞은 묶음도 네 칸이 같다).
 *   줄이 링버퍼의 옛 줄을 덮을 때 그 옛 줄에 2×2 위 칸이 있었으면 바로 아래 두 칸도 지운다(체력 0) — 2×2는 링버퍼에 통째로 있거나 없다(quadAnchor 불변식).
 */
export function generateBlockRows(state: RoomState, catalog: Catalog, rowCount: number, rng: RngFactory, window: number): CompletedBatch[] {
  const width = catalog.world.width;
  const rows = Math.floor(state.blocks.length / width);
  const rowsPerBatch = catalog.limits.batchBlocks / width;
  const completed: CompletedBatch[] = [];
  for (let n = 0; n < rowCount; n++) {
    const y = state.generatedRowCount;
    const batch = Math.floor(y / rowsPerBatch);
    if (batch !== state.batchIndex) {
      state.batchIndex = batch;
      state.batchRemaining = catalog.blocks.map((b) => b.batchCount);
      state.batchKinds = [];
      state.batchRowWindows = [];
    }
    const rr = y - batch * rowsPerBatch;
    const prev = rr === 0 ? null : state.batchKinds.slice(state.batchKinds.length - width);
    const kinds = drawRow(catalog, state.batchRemaining, rr, rng(`row|${y}`), prev);
    const quads = quadMarks(catalog, rr, kinds, prev);
    const slotBase = (((y % rows) + rows) % rows) * width;
    const belowBase = ((((y + 1) % rows) + rows) % rows) * width;
    const aboveBase = ((((y - 1) % rows) + rows) % rows) * width;
    for (let x = 0; x < width; x++) {
      // 덮이는 옛 줄의 2×2 위 칸 → 그 아래 칸도 지운다 (아래 줄 y − rows + 1은 아직 링버퍼에 있다)
      const old = state.blocks[slotBase + x]!;
      if ((old.quad === 1 || old.quad === 2) && old.y === y - rows) {
        const below = state.blocks[belowBase + x]!;
        if (below.y === old.y + 1 && below.quad === old.quad + 2) below.health = 0;
      }
      const kind = kinds[x]!;
      const q = quads[x]!;
      const hp = catalog.blocks[kind]!.hp;
      let health = hp;
      if (q === 1 || q === 2) health = QUAD_HP_MULT * hp;
      else if (q === 3 || q === 4) health = state.blocks[aboveBase + (q === 3 ? x : x - 1)]!.health;   // 앵커 = 바로 윗줄 (x 또는 x − 1)
      state.blocks[slotBase + x] = { kind, x, y, health, quad: q };
      state.batchKinds.push(kind);
    }
    state.batchRowWindows.push(window);
    state.generatedRowCount += 1;
    if (state.batchRowWindows.length === rowsPerBatch) {
      completed.push({ batchIndex: batch, kinds: state.batchKinds, rowWindows: state.batchRowWindows });
      state.batchKinds = [];
      state.batchRowWindows = [];
    }
  }
  return completed;
}

/**
 * 묶음 생성 검사(검증기용): 묶음 j의 줄마다 그 줄을 만든 윈도의 스트림(`row|y`)으로 같은 drawRow를 다시 해서 2,000개 종류를 만든다.
 * rngForWindow(w) = 윈도 w의 스트림 팩토리(시드 S_{e(w)} + 블록 해시). 결과가 기록된 kinds와 같아야 한다.
 */
export function regenerateBatch(catalog: Catalog, batchIndex: number, rowWindows: readonly number[], rngForWindow: (window: number) => RngFactory): number[] {
  const width = catalog.world.width;
  const rowsPerBatch = catalog.limits.batchBlocks / width;
  if (rowWindows.length !== rowsPerBatch) throw new Error(`regenerateBatch: need ${rowsPerBatch} row windows`);
  const remaining = catalog.blocks.map((b) => b.batchCount);
  const kinds: number[] = [];
  const factories = new Map<number, RngFactory>();
  let prev: number[] | null = null;
  for (let i = 0; i < rowsPerBatch; i++) {
    const w = rowWindows[i]!;
    let f = factories.get(w);
    if (!f) { f = rngForWindow(w); factories.set(w, f); }
    prev = drawRow(catalog, remaining, i, f(`row|${batchIndex * rowsPerBatch + i}`), prev);
    kinds.push(...prev);
  }
  return kinds;
}

/** n줄을 c개의 띠로 나눴을 때 띠 i = [start, end) — protocol(스키마 검사·고정 줄 계산)과 같은 함수를 그대로 내보낸다. */
export { bandOf };

/**
 * 줄 하나 (묶음 안 줄 번호 rr): 띠 종류 먼저(큰 번호 → bandedFromKind), 그다음 흔한 종류를 비복원으로. remaining을 줄인다.
 * (규칙 12) prev = 같은 묶음의 바로 윗줄 종류(rr = 0이면 null) — 윗줄이 고정 종류 k의 2×2 위 줄이면 그 두 칸 아래를 먼저 k로 채운다.
 */
export function drawRow(catalog: Catalog, remaining: number[], rr: number, stream: Rng, prev: readonly number[] | null): number[] {
  const width = catalog.world.width;
  const n = catalog.limits.batchBlocks / width;
  const { bandedFromKind, bandMargin, fixedFromKind, fixedClearKinds } = catalog.generation;
  const fixed = catalogFixedRows(catalog);
  const row: number[] = new Array<number>(width).fill(-1);
  // (규칙 12) 2×2 아래 줄: 윗줄(rr − 1)이 k의 고정 줄이고 거기 k가 나란히 둘이면 같은 두 칸 아래도 k (개수에 세지 않음, 무작위 없음)
  if (prev !== null) {
    for (let k = fixedFromKind; k < catalog.blocks.length; k++) {
      if (!fixed[k]!.includes(rr - 1)) continue;
      for (let x = 0; x + 1 < width; x++) if (prev[x] === k && prev[x + 1] === k) { row[x] = k; row[x + 1] = k; }
    }
  }
  for (let k = catalog.blocks.length - 1; k >= bandedFromKind; k--) {
    const c = catalog.blocks[k]!.batchCount;
    const placed = c - remaining[k]!;
    if (placed >= c) continue;
    if (k >= fixedFromKind) {
      if (rr !== fixed[k]![placed]) continue;   // (규칙 8) 고정 줄: 놓을지 뽑지 않는다
      const chance = catalogQuadChanceBps(catalog, k);
      if (chance > 0 && stream.next() * 10000 < chance) {
        // (규칙 12) 2×2 위 줄: 짝 자리(나란히 빈 두 칸) 중 하나에 k 둘 — 놓기는 1번
        const pairs: number[] = [];
        for (let x = 0; x + 1 < width; x++) if (row[x] === -1 && row[x + 1] === -1) pairs.push(x);
        const x = pairs[Math.floor(stream.next() * pairs.length)]!;
        row[x] = k;
        row[x + 1] = k;
        remaining[k] = remaining[k]! - 1;
        continue;
      }
    } else {
      const [start, end] = bandOf(placed, c, n);
      const lo = start + bandMargin;
      const hi = end - bandMargin;   // 안쪽 줄 [lo, hi)
      if (rr < lo || rr >= hi) continue;
      const spaced = fixedClearKinds.includes(k);
      if (spaced && !clearOfFixedRows(catalog, rr, fixed)) continue;   // (규칙 8) 고정 줄 가까이는 건너뜀
      let left = 0;
      for (let r = rr; r < hi; r++) if (!spaced || clearOfFixedRows(catalog, r, fixed)) left += 1;
      if (!(stream.next() * left < 1)) continue;   // 확률 1 / left (마지막으로 놓을 수 있는 안쪽 줄은 늘 놓음)
    }
    const free: number[] = [];
    for (let x = 0; x < width; x++) if (row[x] === -1) free.push(x);
    const x = free[Math.floor(stream.next() * free.length)]!;
    row[x] = k;
    remaining[k] = remaining[k]! - 1;
  }
  const common = remaining.slice(0, bandedFromKind);
  for (let x = 0; x < width; x++) {
    if (row[x] !== -1) continue;
    row[x] = drawKind(common, stream.next());
  }
  for (let k = 0; k < bandedFromKind; k++) remaining[k] = common[k]!;
  return row;
}

/**
 * (규칙 12) 줄의 2×2 표시 (칸마다 0 · 1~4) — 종류 배열의 무늬에서 읽는다: 고정 줄 rr에 같은 고정 종류 k가 나란히 둘 → 1 · 2,
 * 윗줄(rr − 1)이 k의 고정 줄이고 윗줄과 이 줄의 같은 두 칸이 모두 k → 3 · 4. 고정 줄에는 k가 원래 1칸뿐이라 모호하지 않다(drawRow).
 */
export function quadMarks(catalog: Catalog, rr: number, row: readonly number[], prev: readonly number[] | null): number[] {
  const width = row.length;
  const marks = new Array<number>(width).fill(0);
  const { fixedFromKind } = catalog.generation;
  if (fixedFromKind >= catalog.blocks.length || !catalog.generation.quadChanceBps) return marks;
  const fixed = catalogFixedRows(catalog);
  for (let k = fixedFromKind; k < catalog.blocks.length; k++) {
    const top = fixed[k]!.includes(rr);
    const bottom = prev !== null && fixed[k]!.includes(rr - 1);
    if (!top && !bottom) continue;
    for (let x = 0; x + 1 < width; x++) {
      if (row[x] !== k || row[x + 1] !== k) continue;
      if (top) { marks[x] = 1; marks[x + 1] = 2; }
      else if (prev![x] === k && prev![x + 1] === k) { marks[x] = 3; marks[x + 1] = 4; }
    }
  }
  return marks;
}

/** 남은 구성에서 u 위치의 종류를 꺼내고 개수를 1 줄인다. */
function drawKind(remaining: number[], u: number): number {
  let total = 0;
  for (const c of remaining) total += c;
  if (total <= 0) throw new Error("board: batch exhausted (batchBlocks must be a multiple of width)");
  let index = Math.floor(u * total);
  for (let k = 0; k < remaining.length; k++) {
    const c = remaining[k]!;
    if (index < c) {
      remaining[k] = c - 1;
      return k;
    }
    index -= c;
  }
  throw new Error("board: draw out of range");
}
