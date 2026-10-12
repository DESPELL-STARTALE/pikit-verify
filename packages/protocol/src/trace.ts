// ──────────────────────────────────────────────────────────────────────────
// 움직임 기록 (방 메시지 `trace`, INTERFACES §1.5). 화면 전용 — 돈·상태 해시와 무관하다.
// 게임 서버는 윈도(확정 블록 1개 = 9틱)를 한꺼번에 돌린다. 상태 스키마에는 윈도 끝 자세만 실리므로
// 서버가 틱마다의 자세(몸마다 x·y·angle·scale)·카메라 scrollY·블록 타격을 윈도마다 한 번 이 메시지로 보낸다.
// 클라이언트는 이것을 30틱/초로 재생한다(apps/web/lib/game/playback.ts).
//
// 크기: 값은 정수로 양자화한다(msgpack 정수는 1~5바이트). 몸 8개 × 36값 ≈ 1 KB / 윈도(0.3초) ≈ 3.5 KB/s.
//   x, scale          = 값 × POS (1/1000칸)
//   y, scroll         = (값 − originY) × POS   (originY = 윈도 시작 scrollY의 내림 — 깊이가 커져도 작은 정수)
//   angle             = [0, 2π)로 접은 값 × ANGLE (1/10000 rad)
//   hits              = 평평한 [틱, x, y, kind, 전 체력 × HP, 후 체력 × HP] × n (y는 절대 줄 번호)
//   credits           = (규칙 7) 플레이어 곡괭이 키 → 평평한 [틱, 밀리크레딧] × n: 그 틱에 그 곡괭이가 번 것(기본 + LUCKY + POP·BIG POP)이
//                       늘어난 만큼. 화면의 "내 타격 +N"(명세 16 §5.2-3)이 이것을 쓴다 — 블록 타격(hits)에는 누가 쳤는지가 없다
// 자세 k(0 ≤ k < ticks) = 방 틱 startTick + k를 돈 직후. 피드 사건의 tick(방 틱)과 같은 축이다.
// ──────────────────────────────────────────────────────────────────────────

export const TRACE_POS = 1000;
export const TRACE_ANGLE = 10000;
export const TRACE_HP = 100;
/**
 * 하늘 이벤트 별의 몸 키 = `sky:<id>` + 이것 (D125, id = 떨어진 윈도 번호). 자세는 곡괭이처럼 **판 좌표**(y − originY),
 * scale = 별 지름, angle = 원 몸 회전. 별은 윈도 중간에 나타나고 끝나므로 보통 spans(부분 구간)를 갖는다.
 */
export const SKY_BODY_SUFFIX = "#sky";
/** hits 한 건의 값 수 */
export const TRACE_HIT_STRIDE = 6;

/** 윈도 하나의 움직임 기록 (선로 형식 — msgpack). */
export interface TraceMsg {
  window: number;
  /** 첫 자세의 방 틱 */
  startTick: number;
  ticks: number;
  originY: number;
  /** 틱마다 카메라 scrollY (양자화) */
  scroll: number[];
  /** 몸 키(플레이어 itemKey, 봇 "bot:i") → [x, y, angle, scale] × ticks (양자화) */
  bodies: Record<string, number[]>;
  /** 윈도 전체에 살아 있지 않았던 몸만: [첫 틱, 마지막 틱] (그 밖의 칸은 가까운 자세로 채워 둔다) */
  spans?: Record<string, [number, number]>;
  hits: number[];
  /** (규칙 7) 플레이어 곡괭이 키 → [방 틱, 밀리크레딧] × n — 그 틱에 번 것이 늘어난 만큼 (늘어난 틱만) */
  credits?: Record<string, number[]>;
}

export interface TraceHit {
  /** 방 틱 */
  tick: number;
  x: number;
  y: number;
  kind: number;
  before: number;
  after: number;
}

export interface TraceBody {
  /** [x, y, angle, scale] × ticks (실수, angle ∈ [0, 2π)) */
  poses: Float64Array;
  /** 살아 있는 틱 범위 (윈도 안 인덱스, 양 끝 포함) */
  from: number;
  to: number;
}

/** 풀어 둔 기록 (화면이 쓰는 형식). */
export interface Trace {
  window: number;
  startTick: number;
  ticks: number;
  scroll: Float64Array;
  bodies: Map<string, TraceBody>;
  hits: TraceHit[];
  /** 플레이어 곡괭이 키 → 그 윈도에 번 것 (틱 순) */
  credits: Map<string, TraceCredit[]>;
}

/** 곡괭이 하나가 한 틱에 번 것 (밀리크레딧, > 0). */
export interface TraceCredit {
  tick: number;
  milli: number;
}

export interface TracePose {
  x: number;
  y: number;
  angle: number;
  scale: number;
}

const TWO_PI = Math.PI * 2;

export function wrapAngle(a: number): number {
  const r = a % TWO_PI;
  return r < 0 ? r + TWO_PI : r;
}

const q = (v: number, k: number) => Math.round(v * k);

/** 서버: 틱 자세 하나를 양자화해 배열 끝에 붙인다. */
export function pushTracePose(out: number[], p: TracePose, originY: number): void {
  out.push(q(p.x, TRACE_POS), q(p.y - originY, TRACE_POS), q(wrapAngle(p.angle), TRACE_ANGLE) % q(TWO_PI, TRACE_ANGLE), q(p.scale, TRACE_POS));
}

export function pushTraceHit(out: number[], h: TraceHit): void {
  out.push(h.tick, h.x, h.y, h.kind, q(h.before, TRACE_HP), q(h.after, TRACE_HP));
}

const isInt = (v: unknown): v is number => typeof v === "number" && Number.isSafeInteger(v);
const intArray = (v: unknown): v is number[] => Array.isArray(v) && v.every(isInt);

/** 클라이언트: 선로 형식 → 풀어 둔 기록. 모양이 틀리면 null (재생기는 그 윈도를 버리고 다음 윈도에서 다시 맞춘다). */
export function decodeTrace(raw: unknown): Trace | null {
  if (!raw || typeof raw !== "object") return null;
  const m = raw as Partial<TraceMsg>;
  if (!isInt(m.window) || !isInt(m.startTick) || !isInt(m.ticks) || m.ticks < 1 || typeof m.originY !== "number") return null;
  const n = m.ticks;
  const originY = m.originY;
  if (!intArray(m.scroll) || m.scroll.length !== n || !intArray(m.hits) || m.hits.length % TRACE_HIT_STRIDE !== 0) return null;
  if (!m.bodies || typeof m.bodies !== "object") return null;

  const scroll = new Float64Array(n);
  for (let i = 0; i < n; i++) scroll[i] = m.scroll[i]! / TRACE_POS + originY;

  const bodies = new Map<string, TraceBody>();
  for (const [key, arr] of Object.entries(m.bodies)) {
    if (!intArray(arr) || arr.length !== n * 4) return null;
    const poses = new Float64Array(n * 4);
    for (let i = 0; i < n; i++) {
      poses[i * 4] = arr[i * 4]! / TRACE_POS;
      poses[i * 4 + 1] = arr[i * 4 + 1]! / TRACE_POS + originY;
      poses[i * 4 + 2] = arr[i * 4 + 2]! / TRACE_ANGLE;
      poses[i * 4 + 3] = arr[i * 4 + 3]! / TRACE_POS;
    }
    const span = m.spans?.[key];
    const from = span && isInt(span[0]) ? Math.max(0, Math.min(n - 1, span[0])) : 0;
    const to = span && isInt(span[1]) ? Math.max(from, Math.min(n - 1, span[1])) : n - 1;
    bodies.set(key, { poses, from, to });
  }

  const hits: TraceHit[] = [];
  for (let i = 0; i < m.hits.length; i += TRACE_HIT_STRIDE) {
    const h = m.hits;
    hits.push({ tick: h[i]!, x: h[i + 1]!, y: h[i + 2]!, kind: h[i + 3]!, before: h[i + 4]! / TRACE_HP, after: h[i + 5]! / TRACE_HP });
  }
  const credits = new Map<string, TraceCredit[]>();
  if (m.credits !== undefined) {
    if (!m.credits || typeof m.credits !== "object") return null;
    for (const [key, arr] of Object.entries(m.credits)) {
      if (!intArray(arr) || arr.length % 2 !== 0) return null;
      const list: TraceCredit[] = [];
      for (let i = 0; i < arr.length; i += 2) list.push({ tick: arr[i]!, milli: arr[i + 1]! });
      credits.set(key, list);
    }
  }
  return { window: m.window, startTick: m.startTick, ticks: n, scroll, bodies, hits, credits };
}
