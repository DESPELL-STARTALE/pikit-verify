// 원본: PIKIT-GameServer test/physics-engine.test.ts + 관통 방지 패치의 테스트(_analysis/sim-buffs/patch/physics-engine.test.ts, 크기 키우기·드릴 시험은 D99에서 삭제).
// 곡괭이 테스트는 모두 옮겼다. TNT 테스트 6개는 개정 2에서 TNT가 없어져 옮기지 않았다.
// 바뀐 것: 킥 보정에 주입된 Rng를 넘긴다, 마찰은 곡괭이별 frictionPerTick, 반환값은 BlockDestroyEvent 대신 HitEvent.
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { PhysicsEngine, type BlockState, type PickaxeState } from "../src/index.js";
import { createPickaxe, fixedRng } from "./helpers.js";

// ──────────────────────────────────────────────────────────────────────────
// 헬퍼
// ──────────────────────────────────────────────────────────────────────────
/** 10x30 링 버퍼 블록 배열 생성 (worldWidth=10, worldHeight=15, 링 버퍼 행=30) */
function createBlockGrid(worldWidth: number, worldHeight: number): BlockState[] {
  const ringBufferRows = worldHeight * 2;
  const blocks: BlockState[] = [];
  for (let row = 0; row < ringBufferRows; row++) {
    for (let col = 0; col < worldWidth; col++) blocks.push({ kind: 0, x: col, y: row, health: 100 });
  }
  return blocks;
}

/** 모든 블록이 비어 있는(health 0) 링 버퍼 + 지정한 칸만 살린다 */
function createSparseGrid(worldWidth: number, worldHeight: number, alive: [number, number, number][]): BlockState[] {
  const blocks = createBlockGrid(worldWidth, worldHeight);
  blocks.forEach((b) => { b.health = 0; });
  for (const [col, row, hp] of alive) blocks[row * worldWidth + col]!.health = hp;
  return blocks;
}

/** 곡괭이 중심이 살아 있는 블록 안에 있는가 (관통 판정) */
function centreInsideAliveBlock(p: PickaxeState, blocks: BlockState[], worldWidth: number): boolean {
  const rows = Math.floor(blocks.length / worldWidth);
  const x = Math.floor(p.x), y = Math.floor(p.y);
  if (x < 0 || x >= worldWidth) return false;
  const b = blocks[((y % rows + rows) % rows) * worldWidth + x]!;
  return b.health > 0 && b.y === y;
}

describe("PhysicsEngine", () => {
  const engine = new PhysicsEngine({ fps: 30, bounce: 0.75, gravity: 9.80 / 6, denominator: 6, minBounceVy: 0.25, maxSpin: 0.4, angularDamping: 1, contactFriction: 0, headFirstTorque: 0, spinKick: 0 });
  const rng = fixedRng();

  // ──────────────────────────────────────────────────────────────────────────
  // advancePickaxe — 이동 (빈 격자)
  // ──────────────────────────────────────────────────────────────────────────
  describe("advancePickaxe: 이동", () => {
    it("중력에 의해 vy가 증가한다", () => {
      const p = createPickaxe(5, 3, { vy: 0 });
      engine.advancePickaxe(p, createSparseGrid(10, 15, []), 10, rng);
      assert.ok(p.vy > 0, "중력에 의해 vy가 증가해야 함");
    });

    it("마찰에 의해 vx가 감소한다", () => {
      const p = createPickaxe(5, 3, { vx: 0.3, vy: 0 });
      engine.advancePickaxe(p, createSparseGrid(10, 15, []), 10, rng);
      assert.ok(Math.abs(p.vx) < 0.3, "마찰에 의해 vx가 감소해야 함");
    });

    it("좌표가 속도에 따라 이동한다", () => {
      const p = createPickaxe(5, 3, { vx: 0.1, vy: 0.2 });
      engine.advancePickaxe(p, createSparseGrid(10, 15, []), 10, rng);
      assert.ok(p.x > 5 && p.y > 3, "좌표가 속도 방향으로 이동해야 함");
    });

    it("합성 속도가 MAX_SPEED를 초과하지 않는다 (방향 보존)", () => {
      const p = createPickaxe(5, 3, { vx: 30, vy: 10, scale: 1.0 });
      engine.advancePickaxe(p, createSparseGrid(10, 15, []), 10, rng);
      const maxSpeed = 1.0 * 0.45;
      const speed = Math.sqrt(p.vx * p.vx + p.vy * p.vy);
      assert.ok(speed <= maxSpeed + 1e-9, `합성 속도(${speed})가 maxSpeed(${maxSpeed})를 초과`);
      const ratio = p.vx / p.vy;
      assert.ok(Math.abs(ratio - 3.0) < 0.01, `방향 비율이 보존되지 않음 (vx/vy=${ratio.toFixed(4)}, 기대≈3.0)`);
    });
  });

  // ──────────────────────────────────────────────────────────────────────────
  // checkPickaxeWallCollision
  // ──────────────────────────────────────────────────────────────────────────
  describe("checkPickaxeWallCollision", () => {
    it("왼쪽 벽 충돌 시 vx가 반전된다", () => {
      const p = createPickaxe(-0.1, 5, { vx: -0.1, scale: 1.0 });
      engine.checkPickaxeWallCollision(p, 10);
      assert.ok(p.vx > 0, "왼쪽 벽 충돌 후 vx가 양수여야 함");
      assert.ok(p.x >= 0.5, "왼쪽 벽 보정 후 x >= scale");
    });

    it("오른쪽 벽 충돌 시 vx가 반전된다", () => {
      const p = createPickaxe(10.1, 5, { vx: 0.1, scale: 1.0 });
      engine.checkPickaxeWallCollision(p, 10);
      assert.ok(p.vx < 0, "오른쪽 벽 충돌 후 vx가 음수여야 함");
      assert.ok(p.x <= 9.5, "오른쪽 벽 보정 후 x <= worldWidth - scale");
    });

    it("벽에 닿지 않으면 변화 없다", () => {
      const p = createPickaxe(5, 5, { vx: 0.1, scale: 1.0 });
      const oldVx = p.vx;
      engine.checkPickaxeWallCollision(p, 10);
      assert.strictEqual(p.vx, oldVx);
    });

    it("지름이 폭보다 커도 좌우로 번갈아 순간이동하지 않는다", () => {
      const p = createPickaxe(5, 5, { vx: 0.1, scale: 12 });
      engine.checkPickaxeWallCollision(p, 10);
      const x1 = p.x;
      engine.checkPickaxeWallCollision(p, 10);
      assert.strictEqual(p.x, x1);
      assert.strictEqual(p.x, 5);
    });
  });

  // ──────────────────────────────────────────────────────────────────────────
  // advancePickaxe — 블록 충돌·데미지
  // ──────────────────────────────────────────────────────────────────────────
  describe("advancePickaxe: 블록 충돌", () => {
    it("충돌 후 곡괭이가 블록 밖으로 밀려나고 튕긴다", () => {
      const blocks = createSparseGrid(10, 15, [[5, 5, 1000]]);
      const p = createPickaxe(5.5, 4.4, { vy: 0.3, scale: 1.0, attack: 1 });
      engine.advancePickaxe(p, blocks, 10, rng);
      assert.ok(p.y <= 4.5 + 1e-9, `블록 위로 보정되어야 함 (y=${p.y})`);
      assert.ok(p.vy < 0, "반탄력으로 vy가 음수여야 함");
    });

    it("블록에 충돌하면 틱당 한 번 데미지를 적용한다", () => {
      const blocks = createSparseGrid(10, 15, [[5, 5, 20]]);
      const p = createPickaxe(5.5, 4.4, { attack: 10, scale: 1.0, vy: 0.1 });
      engine.advancePickaxe(p, blocks, 10, rng);
      assert.strictEqual(blocks[5 * 10 + 5]!.health, 10);
    });

    it("블록 체력이 0 이하가 되면 destroyed 히트를 반환한다", () => {
      const blocks = createSparseGrid(10, 15, [[5, 5, 5]]);
      const p = createPickaxe(5.5, 4.4, { attack: 10, scale: 1.0, vy: 0.1 });
      const hits = engine.advancePickaxe(p, blocks, 10, rng);
      assert.strictEqual(hits.length, 1);
      assert.strictEqual(hits[0]!.block, blocks[5 * 10 + 5]);
      assert.strictEqual(hits[0]!.destroyed, true);
      assert.strictEqual(hits[0]!.damage, 5, "유효 피해는 남은 체력까지만");
      assert.strictEqual(blocks[5 * 10 + 5]!.health, 0);
    });

    it("이미 파괴된 블록(health=0)은 무시한다", () => {
      const blocks = createSparseGrid(10, 15, []);
      const p = createPickaxe(5.5, 5.5, { attack: 10, scale: 1.0 });
      const hits = engine.advancePickaxe(p, blocks, 10, rng);
      assert.strictEqual(hits.length, 0);
    });

    it("약한 블록(HP < attack)을 부수면서도 반탄력이 적용된다 (드릴 아님)", () => {
      const blocks = createSparseGrid(10, 15, [[5, 5, 5]]);
      const p = createPickaxe(5.5, 4.4, { attack: 100, scale: 1.0, vy: 0.3 });
      const hits = engine.advancePickaxe(p, blocks, 10, rng);
      assert.strictEqual(hits.filter((h) => h.destroyed).length, 1, "약한 블록은 같은 틱에 파괴되어야 함");
      assert.ok(p.vy < 0, `반탄력으로 vy가 양→음 반전되어야 함 (실제 vy=${p.vy})`);
    });

  });

  // ──────────────────────────────────────────────────────────────────────────
  // advancePickaxe — 관통(터널링) 회귀 테스트
  // ──────────────────────────────────────────────────────────────────────────
  describe("advancePickaxe: 관통 방지", () => {
    it("큰 곡괭이가 최고 속도로 얇은 블록 줄에 떨어져도 블록 아래로 빠지지 않는다", () => {
      const row: [number, number, number][] = [];
      for (let c = 0; c < 10; c++) row.push([c, 8, 1e9]);
      const blocks = createSparseGrid(10, 15, row);
      const p = createPickaxe(5, 4, { scale: 4, vy: 5, attack: 1 });
      for (let t = 0; t < 60; t++) {
        engine.advancePickaxe(p, blocks, 10, rng);
        assert.ok(p.y < 8, `틱 ${t}: 중심이 블록 줄(y=8) 아래로 빠짐 (y=${p.y})`);
      }
    });

    it("중심이 블록 안에 들어간 상태면 들어온 쪽(직전 위치 쪽)으로 나간다", () => {
      const blocks = createSparseGrid(10, 15, [[5, 5, 1e9]]);
      const p = createPickaxe(5.5, 4.2, { scale: 2, vy: 0.9, attack: 1 });
      engine.advancePickaxe(p, blocks, 10, rng);
      assert.ok(p.y < 5, `위에서 들어왔으면 위로 나가야 함 (y=${p.y})`);
    });
  });

  // ──────────────────────────────────────────────────────────────────────────
  // 새로 추가: 내구도 (보상 천장의 근거)
  // ──────────────────────────────────────────────────────────────────────────
  describe("내구도", () => {
    it("플레이어 곡괭이의 피해는 남은 내구도까지만 들어간다", () => {
      const blocks = createSparseGrid(10, 15, [[5, 5, 1000]]);
      const p = createPickaxe(5.5, 4.4, { attack: 100, vy: 0.3, owner: "0x1111111111111111111111111111111111111111", durabilityTotal: 30, durabilityLeft: 30 });
      const hits = engine.advancePickaxe(p, blocks, 10, rng);
      assert.strictEqual(hits[0]!.damage, 30);
      assert.strictEqual(p.durabilityLeft, 0);
      assert.strictEqual(blocks[5 * 10 + 5]!.health, 970);
      const again = engine.advancePickaxe(p, blocks, 10, rng);
      assert.strictEqual(again.length, 0, "내구도가 0이면 더 피해를 주지 못한다");
    });
  });
});
