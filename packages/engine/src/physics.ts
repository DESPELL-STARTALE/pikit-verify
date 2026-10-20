import type { PickaxeHitbox } from "@pikit/protocol";
import type { Rng } from "./rng.js";
import { detSinCos } from "./trig.js";
import type { BlockState, PickaxeState } from "./types.js";

// ──────────────────────────────────────────────────────────────────────────
// 물리 엔진 — PIKIT-GameServer/src/physics/physics.engine.ts + 관통 방지 패치(docs/engine-safe-growth.patch)를 옮긴 것.
// 원본과 다른 점 (결정론):
//  1. Math.random 자리에 주입된 Rng (킥 보정 2곳)
//  2. Math.pow 없음 — 마찰은 곡괭이마다 미리 계산한 frictionPerTick을 곱한다 (카탈로그 값)
//  3. 데미지는 남은 내구도까지만 (플레이어 곡괭이). 유효 피해 = min(공격력, 블록 체력, 남은 내구도)
//  4. TNT는 개정 2에서 없어져 옮기지 않았다
//  5. 크기는 카탈로그 값에서 시작한다. 커지기는 tryGrow(안전한 커지기, 하늘 이벤트 D125 · 규칙 11 성장·GIANT — buffs.ts stepScales)만 한다
//  6. (규칙 11, 명세 24 §3.8) 중력은 몸마다 gravityMulBps 배(10,000 = ×1, LUCKY 버프 SPEED). ×1이면 계산하지 않고 그대로 쓴다(규칙 10과 비트까지 같음)
//
// 몸 모양 (카탈로그 pickaxes[].hitbox, D70):
//  circle   옛 엔진 그대로(원 하나, 회전은 화면용 — 속도에서 만든다). 옛 상수 0.25·0.4를 카탈로그 minBounceVy·maxSpin으로 받는다
//  pickaxe  날 막대들(초승달 날을 꺾은선 캡슐로, D101) + 손잡이 캡슐이 angle로 돈다. 강체 충돌: 접촉점이 무게중심에서 비켜 있으면
//           충격이 회전을 만들고(관성 inertia), 접선 마찰(contactFriction)이 미끄러짐을 회전으로 바꾼다. 날아가는 동안은 머리가 진행 방향을
//           향하도록 돈다(headFirstTorque). (규칙 7, D137) 피해는 조각 구분 없이 겹친 블록마다 공격력 그대로. 관통 방지(서브스텝, 깊은 겹침부터 밀어내기)는 같다.
//           봇(주인 없는 몸)은 등급이 아니라 카탈로그 봇 칸 bots[tier].hitbox(봇 그림에 맞춘 것)를 쓴다 — 봇 상태의 tier = bots 위치 (D104).
// ──────────────────────────────────────────────────────────────────────────

// ── 고속 이동에서 블록 관통(터널링)을 막는 상수 ─────────────────────────────────
// 서브스텝 1회 최대 이동 거리. 블록 절반(0.5)보다 작아서, 중심이 한 서브스텝 안에 블록 한가운데를 넘어갈 수 없다.
// 곡괭이 몸은 이것과 "가장 작은 반지름"(손잡이·날 막대 반지름 중 작은 것 × scale) 중 작은 값이고, 회전으로 움직이는 거리(각속도 상한 × 외접 반지름)도 센다.
export const SUBSTEP_MAX_TRAVEL_TILES = 0.45;
// 서브스텝마다 "가장 깊이 겹친 블록부터" 밀어내는 최대 횟수 (예전: 위쪽 줄부터 틱당 2회 → 큰 곡괭이가 아래로 빠짐).
const MAX_RESOLVE_PASSES = 4;
// 이보다 얕은 겹침은 접촉으로만 본다 (밀어내기 없음, 데미지는 적용).
const CONTACT_EPSILON = 1e-6;
const TWO_PI = Math.PI * 2;
const CIRCLE: PickaxeHitbox = { shape: "circle" };

/** 물리 상수 (카탈로그 physics에서 friction을 뺀 것 — 마찰은 곡괭이별 상수). 길이는 칸, 속도는 칸/틱, 각속도는 rad/틱. */
export interface PhysicsConfig {
  fps: number;              // 틱/초
  bounce: number;           // 반발 계수 (0~1, 블록. 벽은 1)
  gravity: number;          // 중력 가속도 (칸/초²)
  denominator: number;      // 시스템 보정 강도 분모 (작을수록 보정 강함)
  minBounceVy: number;      // 바닥에서 튕긴 뒤 위쪽 속도가 이보다 작으면 위로 킥 (옛 0.25)
  maxSpin: number;          // 각속도 상한 (옛 0.4)
  angularDamping: number;   // 곡괭이 몸: 틱당 각속도 감쇠
  contactFriction: number;  // 곡괭이 몸: 접촉 마찰 μ
  headFirstTorque: number;  // 곡괭이 몸: 머리를 진행 방향으로 돌리는 힘
  spinKick: number;         // 곡괭이 몸: 블록에 튕길 때 각속도가 이보다 작으면 ±spinKick 무작위 회전
}

/** 이번 틱에 블록에 들어간 피해 1건. damage > 0 인 것만 나온다. */
export interface HitEvent {
  block: BlockState;
  damage: number;      // 유효 피해
  destroyed: boolean;  // 이번 피해로 체력이 0이 됨
}

/**
 * 히트박스 조각 하나(세계 좌표): 선분 (ax, ay)–(bx, by) + 반지름 r (= 캡슐, 두 끝이 같으면 원). head = 날 조각(디버그 그리기 색만 — 규칙 7부터 피해는 조각과 무관).
 * 웹은 디버그 그리기에 그대로 쓴다(hitboxPrimitives).
 */
export interface HitboxPrimitive {
  ax: number;
  ay: number;
  bx: number;
  by: number;
  r: number;
  head: boolean;
}

/** 몸의 위치·각도·크기만 (히트박스 계산에 필요한 것). */
export interface BodyPose {
  x: number;
  y: number;
  angle: number;
  scale: number;
}

/**
 * 몸의 히트박스를 세계 좌표 조각들로 (머리 먼저). circle = 원 하나(전체가 머리), pickaxe = [날 막대들(꺾은선 순서), 손잡이 캡슐].
 * 날 점 (lx, ly) → (x, y) + scale × (cos θ · lx − sin θ · ly, sin θ · lx + cos θ · ly) — 더하기·빼기·곱하기와 detSinCos만 쓴다.
 * 엔진 충돌과 웹 디버그 그리기·그림 맞춤이 같은 함수를 쓴다.
 */
export function hitboxPrimitives(hitbox: PickaxeHitbox, pose: BodyPose): HitboxPrimitive[] {
  const s = pose.scale || 1.0;
  if (hitbox.shape === "circle") return [{ ax: pose.x, ay: pose.y, bx: pose.x, by: pose.y, r: s * 0.5, head: true }];
  const { sin, cos } = detSinCos(pose.angle);
  const out: HitboxPrimitive[] = [];
  const pts = hitbox.blade.pts;
  const r = hitbox.blade.r * s;
  for (let i = 0; i + 1 < pts.length; i++) {
    const [ax, ay] = pts[i]!;
    const [bx, by] = pts[i + 1]!;
    out.push({
      ax: pose.x + (cos * ax - sin * ay) * s, ay: pose.y + (sin * ax + cos * ay) * s,
      bx: pose.x + (cos * bx - sin * by) * s, by: pose.y + (sin * bx + cos * by) * s,
      r, head: true,
    });
  }
  const h = hitbox.headOffset * s;
  const t = (hitbox.headOffset - hitbox.handleLength) * s;
  out.push({ ax: pose.x + cos * t, ay: pose.y + sin * t, bx: pose.x + cos * h, by: pose.y + sin * h, r: hitbox.handleRadius * s, head: false });
  return out;
}

function closestOnSegment(p: HitboxPrimitive, px: number, py: number): [number, number] {
  if (p.ax === p.bx && p.ay === p.by) return [p.ax, p.ay];
  const ex = p.bx - p.ax;
  const ey = p.by - p.ay;
  const len2 = ex * ex + ey * ey;
  let t = ((px - p.ax) * ex + (py - p.ay) * ey) / len2;
  t = t < 0 ? 0 : t > 1 ? 1 : t;
  return [p.ax + ex * t, p.ay + ey * t];
}

interface Penetration { nx: number; ny: number; depth: number }

/** 원 몸 물리가 읽고 쓰는 값만 — 곡괭이 상태 또는 하늘 이벤트의 별(D125)이 같은 원 몸 경로를 쓴다. */
export interface BallBody {
  x: number;
  y: number;
  vx: number;
  vy: number;
  angle: number;
  vAngle: number;
  scale: number;
  frictionPerTick: number;
  gravityMulBps?: number;   // (규칙 11) 몸의 중력 배수 — 곡괭이만 가진다(별은 없음 = ×1)
}
/** 강체 겹침 1건: 법선(몸을 밀어낼 방향), 깊이, 접촉점(세계), 벽인가. */
interface Contact extends Penetration { cx: number; cy: number; wall: boolean }

export class PhysicsEngine {
  public readonly fps: number;
  private readonly bounce: number;
  private readonly denominator: number;
  private readonly frameGravity: number;
  private readonly minBounceVy: number;
  private readonly maxSpin: number;
  private readonly angularDamping: number;
  private readonly contactFriction: number;
  private readonly headFirstTorque: number;
  private readonly spinKick: number;
  private readonly hitboxes: readonly PickaxeHitbox[];
  private readonly botHitboxes: readonly PickaxeHitbox[];

  /** hitboxes[tier] = 그 등급의 히트박스, botHitboxes[i] = 봇 칸 i(catalog.bots[i])의 모양. 없는 칸은 원. */
  constructor(config: PhysicsConfig, hitboxes: readonly PickaxeHitbox[] = [], botHitboxes: readonly PickaxeHitbox[] = []) {
    this.fps = config.fps;
    this.bounce = config.bounce;
    this.denominator = config.denominator;
    this.frameGravity = config.gravity / (config.fps * config.fps);
    this.minBounceVy = config.minBounceVy;
    this.maxSpin = config.maxSpin;
    this.angularDamping = config.angularDamping;
    this.contactFriction = config.contactFriction;
    this.headFirstTorque = config.headFirstTorque;
    this.spinKick = config.spinKick;
    this.hitboxes = hitboxes;
    this.botHitboxes = botHitboxes;
  }

  /** 등급의 히트박스. */
  public hitboxOf(tier: number): PickaxeHitbox {
    return this.hitboxes[tier] ?? CIRCLE;
  }

  /** 몸의 히트박스: 봇(주인 없음)은 봇 칸 모양(tier = bots 위치), 플레이어 곡괭이는 등급 모양. */
  public hitboxFor(pickaxe: Pick<PickaxeState, "tier" | "owner">): PickaxeHitbox {
    return pickaxe.owner === null ? (this.botHitboxes[pickaxe.tier] ?? CIRCLE) : this.hitboxOf(pickaxe.tier);
  }

  /** 곡괭이의 히트박스 조각 (세계 좌표, 머리 먼저). */
  public primitivesOf(pickaxe: PickaxeState): HitboxPrimitive[] {
    return hitboxPrimitives(this.hitboxFor(pickaxe), pickaxe);
  }

  // ──────────────────────────────────────────────────────────────────────────
  // 곡괭이 한 틱 (속도 → 서브스텝 이동·벽·겹침 해소 → 데미지)
  // ──────────────────────────────────────────────────────────────────────────
  /** 곡괭이 한 틱을 처리하고, 이번 틱에 들어간 피해를 반환한다.
   *  1) 중력·마찰·속도 제한·회전을 갱신한다.
   *  2) 이동(곡괭이 몸은 회전도)을 서브스텝으로 나누고, 서브스텝마다 벽 보정과 "가장 깊은 겹침부터" 밀어내기를 한다.
   *  3) 이번 틱에 한 번이라도 겹친 블록마다 데미지를 정확히 1번 준다("틱당 블록당 1회"). 순서는 처음 겹친 순서.
   *     (규칙 7) 곡괭이 몸도 어느 조각이 겹쳤든 공격력 그대로. */
  public advancePickaxe(pickaxe: PickaxeState, blocks: BlockState[], worldWidth: number, rng: Rng): HitEvent[] {
    const hitbox = this.hitboxFor(pickaxe);
    if (hitbox.shape === "pickaxe") return this.advanceRigid(pickaxe, hitbox, blocks, worldWidth, rng);

    this.applyPickaxeVelocity(pickaxe);

    const speed = Math.sqrt(pickaxe.vx * pickaxe.vx + pickaxe.vy * pickaxe.vy);
    const substeps = Math.max(1, Math.ceil(speed / SUBSTEP_MAX_TRAVEL_TILES));
    const touched = new Set<BlockState>();   // 삽입 순서 = 순회 순서 (사양상 결정적)
    for (let s = 0; s < substeps; s++) {
      const prevX = pickaxe.x;
      const prevY = pickaxe.y;
      pickaxe.x += pickaxe.vx / substeps;
      pickaxe.y += pickaxe.vy / substeps;
      this.checkPickaxeWallCollision(pickaxe, worldWidth);
      this.pushCircleOutOfBlocks(pickaxe, blocks, worldWidth, prevX, prevY, touched, rng);
    }

    const hits: HitEvent[] = [];
    for (const block of touched) {
      const hit = this.strikeBlock(pickaxe, block, pickaxe.attack);
      if (hit) hits.push(hit);
    }
    return hits;
  }

  /** (규칙 11) 이 몸의 틱당 중력 = frameGravity × gravityMulBps / 10⁴. 배수가 없거나 ×1이면 frameGravity 그대로(곱하지 않는다). */
  private gravityOf(body: BallBody): number {
    const m = body.gravityMulBps;
    return m === undefined || m === 10000 ? this.frameGravity : (this.frameGravity * m) / 10000;
  }

  /** 중력, 마찰, 속도 제한, 회전 갱신. 위치 이동은 advancePickaxe의 서브스텝에서 한다. (원 몸) */
  private applyPickaxeVelocity(pickaxe: BallBody): void {
    const frictionPerTick = pickaxe.frictionPerTick;
    // 속도 변화 (중력과 공기 저항 먼저 계산). 원본: Math.pow(frameFriction, 1 / weight) → 미리 계산한 상수
    pickaxe.vy += this.gravityOf(pickaxe);
    pickaxe.vx *= frictionPerTick;
    pickaxe.vy *= frictionPerTick;
    this.capSpeed(pickaxe);

    // 회전 갱신: 낙하/측면 이동이 있을수록 회전량이 증가한다 (원 몸의 회전은 화면용).
    // 원본은 Math.pow(frameFriction, 1 / max(0.5, weight)) — 카탈로그가 weight ≥ 0.5를 강제하므로 frictionPerTick과 같다.
    pickaxe.vAngle += (pickaxe.vx * 0.12) + (pickaxe.vy * 0.02);
    pickaxe.vAngle *= frictionPerTick;
    pickaxe.vAngle = Math.max(-this.maxSpin, Math.min(pickaxe.vAngle, this.maxSpin));
    pickaxe.angle += pickaxe.vAngle;
    pickaxe.angle -= TWO_PI * Math.round(pickaxe.angle / TWO_PI);
  }

  /** 속도 제한 — 합성 길이 클램핑(방향 보존). 관통 방지는 서브스텝이 맡고, 이 제한은 화면 속도감 상한이다. */
  private capSpeed(body: BallBody): void {
    const maxSpeed = (body.scale || 1.0) * 0.45;
    const speed = Math.sqrt(body.vx * body.vx + body.vy * body.vy);
    if (speed > maxSpeed) {
      const ratio = maxSpeed / speed;
      body.vx *= ratio;
      body.vy *= ratio;
    }
  }

  // ──────────────────────────────────────────────────────────────────────────
  // 벽 충돌 보정
  // ──────────────────────────────────────────────────────────────────────────
  /** 곡괭이의 맵 양쪽 벽(X축) 충돌 및 반전 처리. 지름이 폭보다 커도 좌우를 번갈아 순간이동하지 않도록 반지름을 폭/2로 자른다. (원 몸) */
  public checkPickaxeWallCollision(pickaxe: BallBody, worldWidth: number): void {
    const r = Math.min((pickaxe.scale || 1.0) * 0.5, worldWidth * 0.5);

    if (pickaxe.x - r < 0) {
      pickaxe.vx *= -1;
      pickaxe.x = r;
    } else if (pickaxe.x + r > worldWidth) {
      pickaxe.vx *= -1;
      pickaxe.x = worldWidth - r;
    }
  }

  // ──────────────────────────────────────────────────────────────────────────
  // 미생성 영역 진입 방지 (Y축 하단 clamp)
  // ──────────────────────────────────────────────────────────────────────────
  /** 곡괭이가 미생성 row 영역으로 진입하는 것을 차단한다. (외접 반지름 scale/2 만큼 마진을 둬 collision 좌표계와 정합) */
  public clampPickaxeToGeneratedDepth(pickaxe: BallBody, generatedRowCount: number): void {
    const r = (pickaxe.scale || 1.0) * 0.5;
    const maxAllowedY = generatedRowCount - r;
    if (pickaxe.y <= maxAllowedY) return;

    pickaxe.y = maxAllowedY;
    if (pickaxe.vy > 0) pickaxe.vy = 0;
  }

  // ──────────────────────────────────────────────────────────────────────────
  // 블록 충돌 처리 (깊은 겹침부터 밀어내기 + 반탄력 + 데미지) — 원 몸
  // ──────────────────────────────────────────────────────────────────────────
  /** 원을 블록 밖으로 밀어낸다: 매 회 "가장 깊이 겹친 블록" 하나를 골라 그 법선으로 겹친 만큼 밀고 반탄력을 준다(최대 MAX_RESOLVE_PASSES회).
   *  겹친 블록은 모두 touched에 기록한다(데미지 대상) — 마지막 회 뒤 위치의 겹침도 기록한다. */
  private pushCircleOutOfBlocks(
    body: BallBody,
    blocks: BlockState[],
    worldWidth: number,
    prevX: number,
    prevY: number,
    touched: Set<BlockState>,
    rng: Rng,
  ): void {
    const r = (body.scale || 1.0) * 0.5;
    for (let pass = 0; pass < MAX_RESOLVE_PASSES; pass++) {
      const deepest = this.findDeepestPenetration(body, r, blocks, worldWidth, prevX, prevY, touched);
      if (!deepest) return;
      body.x = Math.min(Math.max(body.x + deepest.nx * deepest.depth, Math.min(r, worldWidth * 0.5)), Math.max(worldWidth - r, worldWidth * 0.5));
      body.y += deepest.ny * deepest.depth;
      this.applyBounceImpulse(body, deepest.nx, deepest.ny, rng);
    }
    this.findDeepestPenetration(body, r, blocks, worldWidth, prevX, prevY, touched);
  }

  /** 원과 겹친 활성 블록 중 침투 깊이가 가장 큰 것(법선·깊이)을 찾는다. 겹친 블록은 touched에 모두 넣는다.
   *  순회 순서는 y(위→아래), x(왼→오른) 고정. 깊이 동률이면 먼저 만난 블록. */
  private findDeepestPenetration(
    body: BallBody,
    r: number,
    blocks: BlockState[],
    worldWidth: number,
    prevX: number,
    prevY: number,
    touched: Set<BlockState>,
  ): Penetration | null {
    const sx = Math.max(0, Math.floor(body.x - r));
    const ex = Math.min(worldWidth - 1, Math.floor(body.x + r));
    const sy = Math.floor(body.y - r);
    const ey = Math.floor(body.y + r);
    let deepest: Penetration | null = null;

    for (let y = sy; y <= ey; y++) {
      for (let x = sx; x <= ex; x++) {
        const block = getActiveBlockFromRingBuffer(blocks, worldWidth, x, y);
        if (!block) continue;
        const p = this.measureCircleBlockPenetration(body, r, block, prevX, prevY);
        if (!p) continue;
        touched.add(block);
        if (p.depth > CONTACT_EPSILON && (!deepest || p.depth > deepest.depth)) deepest = p;
      }
    }
    return deepest;
  }

  /** 원-블록(AABB) 침투. 중심이 블록 밖이면 최근접점 법선. 중심이 블록 안이면(예전 코드는 이 경우를 건너뛰어 관통) 직전 위치가 있던 쪽 면으로,
   *  직전 위치도 안이었다면 가장 가까운 면으로 내보낸다. 겹치지 않으면 null. */
  private measureCircleBlockPenetration(body: BallBody, r: number, block: BlockState, prevX: number, prevY: number): Penetration | null {
    const cx = Math.max(block.x, Math.min(body.x, block.x + 1));
    const cy = Math.max(block.y, Math.min(body.y, block.y + 1));
    const dx = body.x - cx;
    const dy = body.y - cy;
    const distSquare = dx * dx + dy * dy;
    if (distSquare > 0) {
      if (r * r <= distSquare) return null;
      const dist = Math.sqrt(distSquare);
      return { nx: dx / dist, ny: dy / dist, depth: r - dist };
    }
    const faces: (Penetration & { entered: boolean })[] = [
      { nx: 0, ny: -1, depth: body.y - block.y + r, entered: prevY <= block.y },
      { nx: 0, ny: 1, depth: block.y + 1 - body.y + r, entered: prevY >= block.y + 1 },
      { nx: -1, ny: 0, depth: body.x - block.x + r, entered: prevX <= block.x },
      { nx: 1, ny: 0, depth: block.x + 1 - body.x + r, entered: prevX >= block.x + 1 },
    ];
    const entered = faces.filter((f) => f.entered);
    const candidates = entered.length > 0 ? entered : faces;
    let best = candidates[0]!;
    for (const f of candidates) if (f.depth < best.depth) best = f;
    return { nx: best.nx, ny: best.ny, depth: best.depth };
  }

  /** 반탄력 — 블록을 향해 진입하는 경우에만 적용 (멀어지는 중이면 스킵). 시스템 보정 2가지는 원본과 같고, 무작위만 Rng에서 뽑는다. (원 몸) */
  private applyBounceImpulse(pickaxe: BallBody, nx: number, ny: number, rng: Rng): void {
    const vDotN = pickaxe.vx * nx + pickaxe.vy * ny;
    if (vDotN >= 0) return;
    const impulse = (1 + this.bounce) * vDotN;
    pickaxe.vx -= impulse * nx;
    pickaxe.vy -= impulse * ny;
    this.applyKicks(pickaxe, ny, rng);
  }

  /** 시스템 보정 2가지 (원·곡괭이 몸 공통, 블록에 닿아 튕긴 직후):
   *  ① x축 속도가 0에 가까우면 무작위로 옆으로 튕기기 ② 바닥(ny < 0)에서 튕긴 위쪽 속도가 minBounceVy보다 작으면 최소 점프력. */
  private applyKicks(body: BallBody, ny: number, rng: Rng): void {
    if (Math.abs(body.vx) < 0.10) {
      body.vx += (rng.next() - 0.50) * 0.30 / this.denominator; // -0.15 ~ +0.15 (분모 전)
    }
    if (ny < 0 && body.vy > -this.minBounceVy) {
      body.vy -= (rng.next() * 0.10 + 0.10) / this.denominator; // 0.1 ~ 0.2 (분모 전)
    }
  }

  // ──────────────────────────────────────────────────────────────────────────
  // 곡괭이 몸 (날 막대들 + 손잡이 캡슐, 강체)
  // ──────────────────────────────────────────────────────────────────────────
  /** 곡괭이 몸 한 틱. 순서는 원 몸과 같다(속도·회전 → 서브스텝 이동·회전·겹침 해소 → 피해). */
  private advanceRigid(
    body: PickaxeState, hitbox: Extract<PickaxeHitbox, { shape: "pickaxe" }>, blocks: BlockState[], worldWidth: number, rng: Rng,
  ): HitEvent[] {
    this.applyRigidVelocity(body);

    // 서브스텝: (이동 + 각속도 상한 × 외접 반지름) ≤ min(0.45, 가장 작은 반지름) — 어떤 점도 한 서브스텝에 그만큼보다 멀리 가지 않는다
    const s = body.scale || 1.0;
    const limit = Math.min(SUBSTEP_MAX_TRAVEL_TILES, Math.min(hitbox.handleRadius, hitbox.blade.r) * s);
    const speed = Math.sqrt(body.vx * body.vx + body.vy * body.vy);
    const substeps = Math.max(1, Math.ceil((speed + this.maxSpin * s * 0.5) / limit));
    // 처음 겹친 순서대로 피해 (규칙 7: 날·손잡이 구분 없이 공격력 그대로)
    const touched = new Set<BlockState>();
    for (let k = 0; k < substeps; k++) {
      body.x += body.vx / substeps;
      body.y += body.vy / substeps;
      body.angle += body.vAngle / substeps;
      this.resolveRigid(hitbox, body, blocks, worldWidth, touched, rng);
    }
    body.angle -= TWO_PI * Math.round(body.angle / TWO_PI);

    const hits: HitEvent[] = [];
    for (const block of touched) {
      const hit = this.strikeBlock(body, block, body.attack);
      if (hit) hits.push(hit);
    }
    return hits;
  }

  /** 중력·공기 저항·속도 제한(원과 같음), 각속도 감쇠, 머리를 진행 방향으로 돌리는 힘, 각속도 상한. */
  private applyRigidVelocity(body: PickaxeState): void {
    body.vy += this.gravityOf(body);
    body.vx *= body.frictionPerTick;
    body.vy *= body.frictionPerTick;
    this.capSpeed(body);
    body.vAngle *= this.angularDamping;
    if (this.headFirstTorque > 0) {
      // 머리 방향 u = (cos θ, sin θ), u × v = |v| sin(진행 방향 − θ) → 머리가 진행 방향 쪽으로 돈다 (화살·셔틀콕처럼 무거운 쪽이 앞)
      const { sin, cos } = detSinCos(body.angle);
      body.vAngle += this.headFirstTorque * (cos * body.vy - sin * body.vx);
    }
    body.vAngle = this.clampSpin(body.vAngle);
  }

  private clampSpin(w: number): number {
    return Math.max(-this.maxSpin, Math.min(w, this.maxSpin));
  }

  /**
   * 곡괭이 몸을 벽·블록 밖으로 민다: 매 회 모든 조각(머리 → 손잡이)과 벽·블록의 겹침 중 가장 깊은 것 하나를 골라 그 법선으로 밀고
   * 접촉점에 충격(회전 포함)과 시스템 보정을 준다(최대 4회). 겹친 블록은 모두 touched에 기록한다 — 마지막 회 뒤 위치의 겹침도.
   */
  private resolveRigid(
    hitbox: PickaxeHitbox,
    body: PickaxeState,
    blocks: BlockState[],
    worldWidth: number,
    touched: Set<BlockState>,
    rng: Rng,
  ): void {
    for (let pass = 0; pass <= MAX_RESOLVE_PASSES; pass++) {
      const prims = hitboxPrimitives(hitbox, body);
      const deepest = this.findDeepestRigidContact(prims, blocks, worldWidth, touched);
      if (!deepest || pass === MAX_RESOLVE_PASSES) return;
      body.x += deepest.nx * deepest.depth;
      body.y += deepest.ny * deepest.depth;
      this.applyRigidImpulse(hitbox, body, deepest, rng);
    }
  }

  /** 조각들과 벽·활성 블록의 겹침 중 가장 깊은 것. 블록 순회는 조각 순서(머리 → 손잡이), 그 안에서 y(위→아래), x(왼→오른). 동률이면 먼저 만난 것. */
  private findDeepestRigidContact(
    prims: HitboxPrimitive[],
    blocks: BlockState[],
    worldWidth: number,
    touched: Set<BlockState>,
  ): Contact | null {
    let deepest: Contact | null = null;
    const consider = (c: Contact | null): void => {
      if (c && c.depth > CONTACT_EPSILON && (!deepest || c.depth > deepest.depth)) deepest = c;
    };
    for (const p of prims) {
      const minX = Math.min(p.ax, p.bx) - p.r;
      const maxX = Math.max(p.ax, p.bx) + p.r;
      // 벽 (x = 0, x = 폭): 반발 1, 접촉점 = 조각의 가장 바깥 끝
      if (minX < 0) consider({ nx: 1, ny: 0, depth: 0 - minX, cx: 0, cy: p.ax <= p.bx ? p.ay : p.by, wall: true });
      if (maxX > worldWidth) consider({ nx: -1, ny: 0, depth: maxX - worldWidth, cx: worldWidth, cy: p.ax >= p.bx ? p.ay : p.by, wall: true });

      const sx = Math.max(0, Math.floor(minX));
      const ex = Math.min(worldWidth - 1, Math.floor(maxX));
      const sy = Math.floor(Math.min(p.ay, p.by) - p.r);
      const ey = Math.floor(Math.max(p.ay, p.by) + p.r);
      for (let y = sy; y <= ey; y++) {
        for (let x = sx; x <= ex; x++) {
          const block = getActiveBlockFromRingBuffer(blocks, worldWidth, x, y);
          if (!block) continue;
          const c = capsuleBlockContact(p, block);
          if (!c) continue;
          touched.add(block);
          consider(c);
        }
      }
    }
    return deepest;
  }

  /**
   * 강체 충격 (질량 1, 관성 I = inertia × scale²). 접촉점 속도 v_c = v + ω × r가 법선 쪽으로 다가올 때만:
   *   법선 충격 jn = −(1 + e)(v_c·n) / (1 + (r×n)²/I)   (e = 블록 bounce, 벽 1)
   *   접선 충격 jt = −(v_c·t) / (1 + (r×t)²/I), |jt| ≤ μ·jn   (μ = contactFriction, 벽은 0)
   *   v += jn·n + jt·t,  ω += ((r×n)·jn + (r×t)·jt) / I,  ω는 maxSpin 안
   * 블록이면 그다음 시스템 보정(옆 킥·최소 튕김)을 원 몸과 같은 규칙·같은 스트림 순서로, 그리고 회전 킥(|ω| < spinKick이면 ±spinKick).
   */
  private applyRigidImpulse(hitbox: Extract<PickaxeHitbox, { shape: "pickaxe" }> | PickaxeHitbox, body: PickaxeState, c: Contact, rng: Rng): void {
    if (hitbox.shape !== "pickaxe") return;
    const s = body.scale || 1.0;
    const invI = 1 / (hitbox.inertia * s * s);
    const rx = c.cx - body.x;
    const ry = c.cy - body.y;
    const vcx = body.vx - body.vAngle * ry;
    const vcy = body.vy + body.vAngle * rx;
    const vn = vcx * c.nx + vcy * c.ny;
    if (vn >= 0) return;
    const rn = rx * c.ny - ry * c.nx;
    const e = c.wall ? 1 : this.bounce;
    const jn = (0 - (1 + e) * vn) / (1 + rn * rn * invI);
    const tx = 0 - c.ny;
    const ty = c.nx;
    const vt = vcx * tx + vcy * ty;
    const rt = rx * ty - ry * tx;
    const mu = c.wall ? 0 : this.contactFriction;
    let jt = (0 - vt) / (1 + rt * rt * invI);
    const jtMax = mu * jn;
    jt = jt > jtMax ? jtMax : jt < 0 - jtMax ? 0 - jtMax : jt;
    body.vx += jn * c.nx + jt * tx;
    body.vy += jn * c.ny + jt * ty;
    body.vAngle = this.clampSpin(body.vAngle + (rn * jn + rt * jt) * invI);
    if (c.wall) return;
    this.applyKicks(body, c.ny, rng);
    // ③ (곡괭이 몸만) 거의 돌지 않으면 무작위로 돌린다 — 손잡이 끝으로 선 채(머리 위) 통통 튀기만 하는 자세를 깨고, 튕김마다 자세를 섞는다
    if (Math.abs(body.vAngle) < this.spinKick) body.vAngle = this.clampSpin(body.vAngle + (rng.next() - 0.5) * 2 * this.spinKick);
  }

  // ──────────────────────────────────────────────────────────────────────────
  // 하늘 이벤트 (D125): 별 = 피해 없는 원 몸, 곡괭이 안전한 커지기
  // ──────────────────────────────────────────────────────────────────────────
  /**
   * 별 한 틱: 원 몸 경로(속도 → 서브스텝 이동·벽·깊은 겹침부터 밀어내기·반발·옆 킥·최소 튕김)와 똑같은데 블록에 피해를 주지 않는다
   * (닿은 블록 집합은 버린다). 킥 무작위는 rng(스트림 `skykick|<id>`)에서 뽑는다.
   */
  public advanceBall(body: BallBody, blocks: BlockState[], worldWidth: number, rng: Rng): void {
    this.applyPickaxeVelocity(body);
    const speed = Math.sqrt(body.vx * body.vx + body.vy * body.vy);
    const substeps = Math.max(1, Math.ceil(speed / SUBSTEP_MAX_TRAVEL_TILES));
    const ignored = new Set<BlockState>();
    for (let s = 0; s < substeps; s++) {
      const prevX = body.x;
      const prevY = body.y;
      body.x += body.vx / substeps;
      body.y += body.vy / substeps;
      this.checkPickaxeWallCollision(body, worldWidth);
      this.pushCircleOutOfBlocks(body, blocks, worldWidth, prevX, prevY, ignored, rng);
    }
  }

  /** 지름 scale 원이 (x, y)에서 벽 밖으로 나가거나 살아 있는 블록과 CONTACT_EPSILON보다 깊이 겹치나 (별 놓을 자리 찾기). */
  public ballOverlaps(x: number, y: number, scale: number, blocks: BlockState[], worldWidth: number): boolean {
    const r = scale * 0.5;
    if (x - r < 0 || x + r > worldWidth) return true;
    const probe: BallBody = { x, y, vx: 0, vy: 0, angle: 0, vAngle: 0, scale, frictionPerTick: 1 };
    return this.findDeepestPenetration(probe, r, blocks, worldWidth, x, y, new Set<BlockState>()) !== null;
  }

  /**
   * 곡괭이를 nextScale로 키워 본다 (옛 docs/engine-safe-growth.patch 규칙을 강체 몸으로): 복사본 자세를 새 크기로 놓고
   * 벽·블록 겹침을 가장 깊은 것부터 최대 MAX_RESOLVE_PASSES번 **위치만** 민다(충격·난수·touched·피해 없음).
   * 그 뒤에도 겹치거나, 밀린 거리가 이번 크기 증가량 + CONTACT_EPSILON보다 크면 실패(false, 아무것도 안 바꿈).
   * 성공하면 x·y·scale만 바꾼다(속도·각도 그대로). 틀에 끼면 못 커지는 것은 의도다 — 다음 틱에 다시 해 본다.
   * 이렇게 해야 커지는 순간 몸이 블록 안으로 파고들거나(박힘) 블록을 건너뛰지(관통) 않는다(옛 PUMP 버그).
   */
  public tryGrow(pickaxe: PickaxeState, nextScale: number, blocks: BlockState[], worldWidth: number): boolean {
    const hitbox = this.hitboxFor(pickaxe);
    const trial = { x: pickaxe.x, y: pickaxe.y, angle: pickaxe.angle, scale: nextScale };
    const scratch = new Set<BlockState>();
    for (let pass = 0; pass <= MAX_RESOLVE_PASSES; pass++) {
      const deepest = this.findDeepestRigidContact(hitboxPrimitives(hitbox, trial), blocks, worldWidth, scratch);
      if (!deepest) break;
      if (pass === MAX_RESOLVE_PASSES) return false;
      trial.x += deepest.nx * deepest.depth;
      trial.y += deepest.ny * deepest.depth;
    }
    const dx = trial.x - pickaxe.x;
    const dy = trial.y - pickaxe.y;
    if (Math.sqrt(dx * dx + dy * dy) > nextScale - pickaxe.scale + CONTACT_EPSILON) return false;
    pickaxe.x = trial.x;
    pickaxe.y = trial.y;
    pickaxe.scale = nextScale;
    return true;
  }

  // ──────────────────────────────────────────────────────────────────────────
  // 피해
  // ──────────────────────────────────────────────────────────────────────────
  /** 곡괭이 데미지 1회 (접촉은 틱당 블록당 1번). 유효 피해 = min(공격력, 블록 체력, 남은 내구도[플레이어]).
   *  attack = 때리는 조각의 공격력. 피해가 0이면 null. */
  public strikeBlock(pickaxe: PickaxeState, block: BlockState, attack: number): HitEvent | null {
    const cap = pickaxe.owner === null ? attack : Math.min(attack, pickaxe.durabilityLeft);
    const damage = Math.min(cap, block.health);
    if (!(damage > 0)) return null;
    block.health = damage === block.health ? 0 : block.health - damage;
    if (pickaxe.owner !== null) {
      pickaxe.durabilityLeft = damage === pickaxe.durabilityLeft ? 0 : pickaxe.durabilityLeft - damage;
    }
    return { block, damage, destroyed: block.health <= 0 };
  }
}

// ──────────────────────────────────────────────────────────────────────────
// 캡슐(원) – 블록(AABB) 겹침
// ──────────────────────────────────────────────────────────────────────────
/**
 * 캡슐(선분 A–B, 반지름 r; A = B면 원)과 블록 [x, x+1]×[y, y+1]의 겹침. 겹치지 않으면 null.
 *  선분이 블록 밖: 두 볼록 도형의 최근접점은 한쪽의 꼭짓점에서 생긴다 → 선분 끝 2개 ↔ 블록, 블록 모서리 4개 ↔ 선분 중 가장 가까운 쌍.
 *                 법선 = 블록 위 점 → 선분 위 점, 깊이 = r − 거리, 접촉점 = 블록 위 점
 *  선분이 블록을 지남: 분리축(x, y, 선분 법선)마다 양쪽으로 밀어낼 거리 중 가장 작은 것. 접촉점 = 그 법선 반대쪽으로 가장 깊은 선분 점 − 법선 × r
 */
export function capsuleBlockContact(p: HitboxPrimitive, block: BlockState): Contact | null {
  const x0 = block.x;
  const x1 = block.x + 1;
  const y0 = block.y;
  const y1 = block.y + 1;
  if (!segmentIntersectsBox(p, x0, x1, y0, y1)) {
    // 가장 가까운 쌍 (선분 점 s, 블록 점 q)
    let best = Infinity;
    let sx = 0, sy = 0, qx = 0, qy = 0;
    const tryPair = (ax: number, ay: number, bx: number, by: number): void => {
      const dx = ax - bx;
      const dy = ay - by;
      const d2 = dx * dx + dy * dy;
      if (d2 < best) { best = d2; sx = ax; sy = ay; qx = bx; qy = by; }
    };
    tryPair(p.ax, p.ay, clamp(p.ax, x0, x1), clamp(p.ay, y0, y1));
    if (p.bx !== p.ax || p.by !== p.ay) {
      tryPair(p.bx, p.by, clamp(p.bx, x0, x1), clamp(p.by, y0, y1));
      for (const [cx, cy] of [[x0, y0], [x1, y0], [x0, y1], [x1, y1]] as const) {
        const [ox, oy] = closestOnSegment(p, cx, cy);
        tryPair(ox, oy, cx, cy);
      }
    }
    if (best >= p.r * p.r) return null;
    if (best > 0) {
      const d = Math.sqrt(best);
      return { nx: (sx - qx) / d, ny: (sy - qy) / d, depth: p.r - d, cx: qx, cy: qy, wall: false };
    }
    // 거리 0 (선분이 블록 경계에 딱 닿음) → 아래 분리축 처리
  }
  return separatingAxisContact(p, x0, x1, y0, y1);
}

function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

/** 선분이 닫힌 상자와 만나나 (Liang–Barsky 자르기). 점(A = B)이면 점이 상자 안인가. */
function segmentIntersectsBox(p: HitboxPrimitive, x0: number, x1: number, y0: number, y1: number): boolean {
  let t0 = 0;
  let t1 = 1;
  const dx = p.bx - p.ax;
  const dy = p.by - p.ay;
  const clip = (q: number, r: number): boolean => {   // q·t ≤ r 꼴의 반평면
    if (q === 0) return r >= 0;
    const t = r / q;
    if (q < 0) { if (t > t1) return false; if (t > t0) t0 = t; } else { if (t < t0) return false; if (t < t1) t1 = t; }
    return true;
  };
  return clip(0 - dx, p.ax - x0) && clip(dx, x1 - p.ax) && clip(0 - dy, p.ay - y0) && clip(dy, y1 - p.ay);
}

/** 선분이 상자를 지나는(또는 경계에 닿은) 캡슐: 분리축 x, y, 선분 법선에서 가장 짧은 밀어내기. */
function separatingAxisContact(p: HitboxPrimitive, x0: number, x1: number, y0: number, y1: number): Contact {
  const axes: [number, number][] = [[1, 0], [0, 1]];
  const ex = p.bx - p.ax;
  const ey = p.by - p.ay;
  const len = Math.sqrt(ex * ex + ey * ey);
  if (len > 0) axes.push([(0 - ey) / len, ex / len]);
  let bestDepth = Infinity;
  let nx = 0;
  let ny = -1;
  for (const [axx, axy] of axes) {
    const sa = p.ax * axx + p.ay * axy;
    const sb = p.bx * axx + p.by * axy;
    const sMin = Math.min(sa, sb) - p.r;
    const sMax = Math.max(sa, sb) + p.r;
    const c0 = x0 * axx + y0 * axy, c1 = x1 * axx + y0 * axy, c2 = x0 * axx + y1 * axy, c3 = x1 * axx + y1 * axy;
    const bMin = Math.min(c0, c1, c2, c3);
    const bMax = Math.max(c0, c1, c2, c3);
    const pushNeg = sMax - bMin;   // 몸을 −축으로
    const pushPos = bMax - sMin;   // 몸을 +축으로
    if (pushNeg < bestDepth) { bestDepth = pushNeg; nx = 0 - axx; ny = 0 - axy; }
    if (pushPos < bestDepth) { bestDepth = pushPos; nx = axx; ny = axy; }
  }
  // 접촉점: 법선 반대쪽(블록 쪽)으로 가장 깊은 선분 끝(같으면 가운데) − 법선 × r
  const da = p.ax * nx + p.ay * ny;
  const db = p.bx * nx + p.by * ny;
  const px = da < db ? p.ax : db < da ? p.bx : (p.ax + p.bx) * 0.5;
  const py = da < db ? p.ay : db < da ? p.by : (p.ay + p.by) * 0.5;
  return { nx, ny, depth: bestDepth, cx: px - nx * p.r, cy: py - ny * p.r, wall: false };
}

// ──────────────────────────────────────────────────────────────────────────
// 링버퍼 조회
// ──────────────────────────────────────────────────────────────────────────
/** 링 버퍼에서 좌표 (x, y)에 해당하는 활성 블록을 반환한다 (좌표 무효, 비활성, 옛 줄이 남은 슬롯이면 null). */
export function getActiveBlockFromRingBuffer(blocks: BlockState[], worldWidth: number, x: number, y: number): BlockState | null {
  if (x < 0 || x >= worldWidth) return null;
  const bh = Math.floor(blocks.length / worldWidth);
  if (bh === 0) return null;
  const index = ((y % bh + bh) % bh) * worldWidth + x;
  const block = blocks[index];
  if (!block) return null;
  return block.health > 0 && block.y === y ? block : null;
}
