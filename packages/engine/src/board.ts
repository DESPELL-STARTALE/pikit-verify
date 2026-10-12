import type { Catalog } from "@pikit/protocol";
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
//  - 줄 y의 스트림은 `row|y` 하나. 뽑는 순서: 띠 종류를 큰 번호부터(다이아 → … → 에메랄드) 각각 (안쪽 줄이면) u 하나로 놓을지,
//    놓으면 u 하나로 빈 칸(왼쪽부터 번호). 그다음 남은 칸마다(왼쪽부터) u 하나로 흔한 종류(0 … bandedFromKind − 1)의 비복원 추첨
//    ("남은 구성에서 floor(u × 남은 개수)번째").
//  - 같은 희귀 종류는 최소 3줄 간격 → 화면 15줄에 다이아 최대 3개. 묶음 구성은 정확(모든 종류 batchCount 그대로).
// 참조 구현: _analysis/sim-rules7-2026-10-12/patches/gen7.mjs (그대로 옮김). 검증기의 묶음 생성 검사(regenerateBatch)가 같은 drawRow를 쓴다.
// ──────────────────────────────────────────────────────────────────────────

/** 빈 링버퍼 (width × height × multiplier 칸). */
export function createRingBuffer(catalog: Catalog): BlockState[] {
  const { width, height, ringBufferRowMultiplier } = catalog.world;
  const size = width * height * ringBufferRowMultiplier;
  const blocks: BlockState[] = [];
  for (let i = 0; i < size; i++) blocks.push({ kind: 0, x: 0, y: 0, health: 0 });
  return blocks;
}

/**
 * 줄을 rowCount개 더 만든다 (generatedRowCount부터). 줄 y의 링버퍼 슬롯 = (y mod 줄 수) × width + x.
 * window = 지금 처리 중인 윈도(이 줄들의 w(y)). 묶음 하나가 다 차면 CompletedBatch로 돌려준다(묶음 해시 H_j의 재료).
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
    const kinds = drawRow(catalog, state.batchRemaining, y - batch * rowsPerBatch, rng(`row|${y}`));
    const slotBase = (((y % rows) + rows) % rows) * width;
    for (let x = 0; x < width; x++) {
      const kind = kinds[x]!;
      state.blocks[slotBase + x] = { kind, x, y, health: catalog.blocks[kind]!.hp };
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
  for (let i = 0; i < rowsPerBatch; i++) {
    const w = rowWindows[i]!;
    let f = factories.get(w);
    if (!f) { f = rngForWindow(w); factories.set(w, f); }
    kinds.push(...drawRow(catalog, remaining, i, f(`row|${batchIndex * rowsPerBatch + i}`)));
  }
  return kinds;
}

/** n줄을 c개의 띠로 나눴을 때 띠 i = [start, end) (앞의 n mod c개 띠가 한 줄 더 길다). */
export function bandOf(i: number, c: number, n: number): [number, number] {
  const base = Math.floor(n / c);
  const extra = n - base * c;
  const start = i * base + Math.min(i, extra);
  return [start, start + base + (i < extra ? 1 : 0)];
}

/**
 * 줄 하나 (묶음 안 줄 번호 rr): 띠 종류 먼저(큰 번호 → bandedFromKind), 그다음 흔한 종류를 비복원으로. remaining을 줄인다.
 */
export function drawRow(catalog: Catalog, remaining: number[], rr: number, stream: Rng): number[] {
  const width = catalog.world.width;
  const n = catalog.limits.batchBlocks / width;
  const { bandedFromKind, bandMargin } = catalog.generation;
  const row: number[] = new Array<number>(width).fill(-1);
  for (let k = catalog.blocks.length - 1; k >= bandedFromKind; k--) {
    const c = catalog.blocks[k]!.batchCount;
    const placed = c - remaining[k]!;
    if (placed >= c) continue;
    const [start, end] = bandOf(placed, c, n);
    const lo = start + bandMargin;
    const hi = end - bandMargin;   // 안쪽 줄 [lo, hi)
    if (rr < lo || rr >= hi) continue;
    const left = hi - rr;
    if (!(stream.next() * left < 1)) continue;   // 확률 1 / left (마지막 안쪽 줄은 늘 놓음)
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
