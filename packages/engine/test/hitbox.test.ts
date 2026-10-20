// 곡괭이 모양 히트박스 (physics.ts advanceRigid · capsuleBlockContact · hitboxPrimitives, D70~D71, 날 막대 D101):
// 모양·회전, 봇 전용 모양, 날 5점(규칙 7), 겹침 법선, 겹침이 남지 않음, 비켜 맞으면 돈다, 어느 조각이든 공격력 그대로(규칙 7), 벽,
// 머리 쪽으로 도는 힘, 결정론.
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { parseCatalog, type Catalog, type PickaxeHitbox } from "@pikit/protocol";
import {
  bodyHitbox, capsuleBlockContact, detSinCos, hitboxPrimitives, PhysicsEngine, physicsFor, type BlockState, type HitboxPrimitive, type PickaxeState,
} from "../src/index.js";
import { createPickaxe, fixedRng, loadCatalog } from "./helpers.js";

const shipped = loadCatalog();
const HB = shipped.pickaxes[0]!.hitbox as Extract<PickaxeHitbox, { shape: "pickaxe" }>;
const W = 10;
const OWNER = "0x1111111111111111111111111111111111111111";
const near = (a: number, b: number, eps = 1e-9) => Math.abs(a - b) <= eps;

/** 곡괭이 몸 물리 (출시 손잡이 값), 필요하면 일부만 바꿔서. */
function engineWith(physics: Partial<Catalog["physics"]> = {}, hitbox: Partial<typeof HB> = {}): PhysicsEngine {
  const h = { ...HB, ...hitbox };
  return new PhysicsEngine({ ...shipped.physics, ...physics }, [h, h, h, h, h], [h, h, h, h, h]);   // 시험 몸은 주인 없음(봇 칸 0) — 같은 모양
}
const QUIET = { headFirstTorque: 0, spinKick: 0, contactFriction: 0 };   // 충돌 응답만 보이게

/** width × 30줄 빈 링버퍼 + 지정한 칸 [x, y, hp]. */
function grid(alive: [number, number, number][] = []): BlockState[] {
  const blocks: BlockState[] = [];
  for (let y = 0; y < 30; y++) for (let x = 0; x < W; x++) blocks.push({ kind: 0, x, y, health: 0 });
  for (const [x, y, hp] of alive) blocks[y * W + x]!.health = hp;
  return blocks;
}

function body(x: number, y: number, o: Partial<PickaxeState> = {}): PickaxeState {
  return createPickaxe(x, y, { attack: 50, vy: 0, frictionPerTick: 1, ...o });
}

const prim = (ax: number, ay: number, bx: number, by: number, r: number): HitboxPrimitive => ({ ax, ay, bx, by, r, head: false });
const block = (x: number, y: number): BlockState => ({ kind: 0, x, y, health: 100 });
/** 날 끝 (축 위의 날 꼭짓점 (0.5 − r, 0))의 세계 좌표 = 머리 조각 끝점 중 축 방향으로 가장 먼 점. */
function tip(engine: PhysicsEngine, p: PickaxeState): { x: number; y: number } {
  const { sin, cos } = detSinCos(p.angle);
  let best = { x: p.x, y: p.y };
  let reach = -Infinity;
  for (const q of engine.primitivesOf(p)) {
    if (!q.head) continue;
    for (const [x, y] of [[q.ax, q.ay], [q.bx, q.by]] as const) {
      const a = (x - p.x) * cos + (y - p.y) * sin;
      if (a > reach) { reach = a; best = { x, y }; }
    }
  }
  return best;
}
/** 손잡이 캡슐 (조각 목록의 마지막). */
const handleOf = (engine: PhysicsEngine, p: PickaxeState): HitboxPrimitive => engine.primitivesOf(p).at(-1)!;
/** 출시 카탈로그의 모든 곡괭이 모양 (등급 + 봇). */
const shippedShapes = (): Extract<PickaxeHitbox, { shape: "pickaxe" }>[] =>
  [...shipped.pickaxes.map((t) => t.hitbox), ...shipped.bots.map((b) => b.hitbox)] as Extract<PickaxeHitbox, { shape: "pickaxe" }>[];

describe("hitbox geometry", () => {
  it("angle 0 puts the blade at +x (body-frame points × scale), π/2 at +y (screen down); the handle comes last and runs from the butt to headOffset", () => {
    const prims = hitboxPrimitives(HB, { x: 5, y: 5, angle: 0, scale: 2 });
    const pts = HB.blade.pts;
    assert.equal(prims.length, pts.length);   // 날 막대 (점 − 1)개 + 손잡이
    prims.slice(0, -1).forEach((q, i) => {
      assert.ok(q.head && near(q.r, HB.blade.r * 2));
      assert.ok(near(q.ax, 5 + pts[i]![0] * 2) && near(q.ay, 5 + pts[i]![1] * 2) && near(q.bx, 5 + pts[i + 1]![0] * 2) && near(q.by, 5 + pts[i + 1]![1] * 2));
    });
    const handle = prims.at(-1)!;
    assert.ok(!handle.head && near(handle.r, HB.handleRadius * 2));
    assert.ok(near(handle.ax, 5 + (HB.headOffset - HB.handleLength) * 2) && near(handle.bx, 5 + HB.headOffset * 2) && near(handle.ay, 5) && near(handle.by, 5));
    // π/2: 몸 x축이 화면 아래(+y), 몸 y축이 화면 왼쪽(−x)
    const down = hitboxPrimitives(HB, { x: 5, y: 5, angle: Math.PI / 2, scale: 1 })[0]!;
    assert.ok(near(down.ax, 5 - pts[0]![1], 1e-12) && near(down.ay, 5 + pts[0]![0], 1e-12));
  });

  it("every shipped shape (FE·FC·VD single blade, WB·BM double blade, bot) reaches exactly +0.5 along the axis with the handle butt at −0.5", () => {
    for (const h of shippedShapes()) {
      let min = Infinity;
      let max = -Infinity;
      for (const q of hitboxPrimitives(h, { x: 0, y: 0, angle: 0, scale: 1 })) {
        min = Math.min(min, q.ax - q.r, q.bx - q.r);
        max = Math.max(max, q.ax + q.r, q.bx + q.r);
      }
      assert.ok(near(min, -0.5, 1e-12) && near(max, 0.5, 1e-12), `${JSON.stringify(h.blade)}: ${min} … ${max}`);
    }
  });

  it("bots use their own catalog slot (bots[i].hitbox, bot state tier = slot i — D104); players use the tier shape (engine and bodyHitbox agree)", () => {
    const engine = physicsFor(shipped);
    assert.deepEqual(engine.hitboxFor({ tier: 0, owner: null }), shipped.bots[0]!.hitbox, "봇 tier 0 = 봇 칸 0");
    assert.deepEqual(engine.hitboxFor({ tier: 0, owner: OWNER }), shipped.pickaxes[0]!.hitbox, "플레이어 tier 0 = FE");
    assert.deepEqual(engine.hitboxFor({ tier: 2, owner: OWNER }), shipped.pickaxes[2]!.hitbox);
    assert.deepEqual(engine.hitboxFor({ tier: 2, owner: null }), { shape: "circle" }, "없는 봇 칸은 원");
    assert.deepEqual(bodyHitbox(shipped, 0, true), shipped.bots[0]!.hitbox);
    assert.deepEqual(bodyHitbox(shipped, 0, false), shipped.pickaxes[0]!.hitbox);
    assert.equal(bodyHitbox(shipped, 1, true), undefined);
    assert.equal(bodyHitbox(shipped, 99, false), undefined);
    const bot = createPickaxe(5, 5, { tier: 0, owner: null, scale: 2 });
    assert.deepEqual(engine.primitivesOf(bot), hitboxPrimitives(shipped.bots[0]!.hitbox, bot));
  });

  it("(rules 7) 5-point blades (spec 16 §5.2): every point |p| + r ≤ 0.5, tip point exactly (0.5 − r, 0), r 0.05 / 0.102 / 0.056", () => {
    const single = { pts: [[0.287, -0.148], [0.277, -0.04], [0.45, 0], [0.114, 0.344], [-0.149, 0.381]], r: 0.05 };
    const double = { pts: [[0.015, -0.326], [0.177, -0.21], [0.398, 0], [0.211, 0.182], [0.025, 0.306]], r: 0.102 };
    const bot = { pts: [[0.188, -0.402], [0.284, -0.242], [0.444, 0], [0.261, 0.264], [0.034, 0.442]], r: 0.056 };
    assert.deepEqual(shipped.pickaxes.map((t) => (t.hitbox as typeof HB).blade), [single, single, double], "FE·VD 외날, BM 양날");
    assert.deepEqual((shipped.bots[0]!.hitbox as typeof HB).blade, bot);
    for (const h of shippedShapes()) {
      const { pts, r } = h.blade;
      assert.equal(pts.length, 5);
      for (const [x, y] of pts) assert.ok(Math.sqrt(x * x + y * y) + r <= 0.5 + 1e-12, `(${x}, ${y}) r ${r}`);
      assert.equal(pts.filter(([x, y]) => y === 0 && near(x, 0.5 - r, 1e-12)).length, 1, "끝점 (0.5 − r, 0) 하나");
      assert.deepEqual(pts[2], [0.5 - r, 0].map((v) => Number(v.toFixed(3))), "가운데 점이 끝점");
      assert.equal(hitboxPrimitives(h, { x: 0, y: 0, angle: 0, scale: 1 }).filter((q) => q.head).length, 4, "날 캡슐 4개 + 손잡이");
    }
  });

  it("the shape always fits inside the scale circle (so the diameter cap, walls and spawn rules still hold) and scales as a whole", () => {
    for (let i = 0; i < 360; i++) {
      for (const scale of [1, 2.5, 5]) {
        for (const h of shippedShapes()) {
          for (const p of hitboxPrimitives(h, { x: 0, y: 0, angle: (i / 180) * Math.PI, scale })) {
            for (const [px, py] of [[p.ax, p.ay], [p.bx, p.by]] as const) assert.ok(Math.sqrt(px * px + py * py) + p.r <= scale * 0.5 + 1e-12);
          }
        }
      }
    }
    const small = hitboxPrimitives(HB, { x: 0, y: 0, angle: 0.3, scale: 1 });
    const big = hitboxPrimitives(HB, { x: 0, y: 0, angle: 0.3, scale: 2.5 });
    small.forEach((p, i) => { assert.ok(near(big[i]!.r, p.r * 2.5) && near(big[i]!.ax, p.ax * 2.5, 1e-12) && near(big[i]!.by, p.by * 2.5, 1e-12)); });
  });

  it("circle hitbox is one head primitive of radius scale / 2 at the centre (old engine)", () => {
    assert.deepEqual(hitboxPrimitives({ shape: "circle" }, { x: 3, y: 4, angle: 1, scale: 2 }), [{ ax: 3, ay: 4, bx: 3, by: 4, r: 1, head: true }]);
  });

  it("catalog schema refuses a pickaxe hitbox that does not fit the scale circle, has its centre off the handle or its blade tip off the axis", () => {
    const raw = JSON.parse(JSON.stringify(shipped)) as Catalog;
    const withHitbox = (h: object) => ({ ...raw, pickaxes: raw.pickaxes.map((t) => ({ ...t, hitbox: { ...HB, ...h } })) });
    const pts = HB.blade.pts;
    assert.throws(() => parseCatalog(withHitbox({ blade: { pts: [[0.4, -0.3], ...pts.slice(1)], r: HB.blade.r } })), /fit/);
    assert.throws(() => parseCatalog(withHitbox({ blade: { pts: [pts[0], [0.4, 0], pts[3]], r: HB.blade.r } })), /tip/);
    assert.throws(() => parseCatalog(withHitbox({ blade: { pts: [[0.48, 0]], r: 0.02 } })));
    assert.throws(() => parseCatalog(withHitbox({ blade: { pts, r: 0.01 } })));
    assert.throws(() => parseCatalog(withHitbox({ headRadius: 0.26 })), "옛 머리 원 칸은 없다");
    assert.throws(() => parseCatalog({ ...raw, bots: raw.bots.map((b) => ({ ...b, hitbox: { ...b.hitbox, blade: { pts, r: 0.2 } } })) }), /fit|tip/);
    assert.throws(() => parseCatalog(withHitbox({ handleLength: 0.8 })), /fit/);
    assert.throws(() => parseCatalog(withHitbox({ headOffset: 0.7, handleLength: 0.66 })), /fit|centre/);
    assert.throws(() => parseCatalog(withHitbox({ handleRadius: 0.01 })));
    assert.throws(() => parseCatalog(withHitbox({ handleDamage: 0 })), "규칙 7: 손잡이 피해 칸은 없다");
    assert.doesNotThrow(() => parseCatalog({ ...raw, pickaxes: raw.pickaxes.map((t) => ({ ...t, hitbox: { shape: "circle" } })) }));
  });
});

describe("capsule / circle vs block: contact normals", () => {
  it("circle above a block → straight up, depth = r − gap", () => {
    const c = capsuleBlockContact(prim(2.5, 4.8, 2.5, 4.8, 0.3), block(2, 5))!;
    assert.ok(near(c.nx, 0) && near(c.ny, -1) && near(c.depth, 0.1, 1e-12) && near(c.cy, 5));
  });

  it("horizontal handle lying across the top of a block → up; across the left side → left", () => {
    const top = capsuleBlockContact(prim(1.6, 4.95, 3.4, 4.95, 0.1), block(2, 5))!;
    assert.ok(near(top.nx, 0) && near(top.ny, -1) && near(top.depth, 0.05, 1e-12));
    const side = capsuleBlockContact(prim(1.95, 4.2, 1.95, 5.8, 0.1), block(2, 5))!;
    assert.ok(near(side.nx, -1) && near(side.ny, 0) && near(side.depth, 0.05, 1e-12));
  });

  it("near a block corner the normal points from the corner to the closest point of the segment", () => {
    const c = capsuleBlockContact(prim(1.9, 4.9, 1.5, 4.5, 0.2), block(2, 5))!;
    const d = Math.SQRT2 * 0.1;
    assert.ok(near(c.nx, -Math.SQRT1_2, 1e-12) && near(c.ny, -Math.SQRT1_2, 1e-12) && near(c.depth, 0.2 - d, 1e-12));
    assert.ok(near(c.cx, 2) && near(c.cy, 5), "접촉점 = 블록 모서리");
  });

  it("a segment through the block is pushed out along the shortest separating axis (and never along a longer one)", () => {
    const c = capsuleBlockContact(prim(1.5, 5.15, 3.5, 5.15, 0.05), block(2, 5))!;
    assert.ok(near(c.nx, 0) && near(c.ny, -1) && near(c.depth, 0.2, 1e-12), JSON.stringify(c));
    const d = capsuleBlockContact(prim(2.9, 4.5, 2.9, 6.5, 0.05), block(2, 5))!;
    assert.ok(near(d.nx, 1) && near(d.ny, 0) && near(d.depth, 0.15, 1e-12), JSON.stringify(d));
  });

  it("no contact when the gap is at least the radius", () => {
    assert.equal(capsuleBlockContact(prim(1.5, 4.5, 1.7, 4.7, 0.2), block(2, 5)), null);
    assert.equal(capsuleBlockContact(prim(2.5, 4.65, 2.5, 4.65, 0.3), block(2, 5)), null);
  });
});

describe("pickaxe body dynamics", () => {
  it("drops onto a floor from many angles and never stays inside a block (overlap ≤ 0.05 at tick end, centre and head always outside)", () => {
    const engine = engineWith();
    const floor: [number, number, number][] = [];
    for (let x = 0; x < W; x++) for (const y of [14, 15]) floor.push([x, y, 1e12]);
    let worst = 0;
    for (let i = 0; i < 24; i++) {
      const blocks = grid(floor);
      const p = body(1 + (i % 8), 3 + (i % 3), { angle: (i / 12) * Math.PI, vx: ((i % 5) - 2) * 0.05, vAngle: ((i % 7) - 3) * 0.05, scale: 1 + (i % 4) * 0.5 });
      for (let t = 0; t < 400; t++) {
        engine.advancePickaxe(p, blocks, W, fixedRng(i + 1));
        assert.ok(p.y < 14, "중심이 바닥 위");
        assert.ok(tip(engine, p).y < 14 + 1e-9, "날 끝이 바닥 위");
        for (const q of engine.primitivesOf(p)) {
          for (const b of blocks) {
            if (b.health <= 0 || Math.abs(b.y + 0.5 - p.y) > 4) continue;
            const c = capsuleBlockContact(q, b);
            if (c) worst = Math.max(worst, c.depth);
          }
          assert.ok(Math.min(q.ax, q.bx) - q.r >= -1e-9 && Math.max(q.ax, q.bx) + q.r <= W + 1e-9, "벽 안");
        }
      }
    }
    assert.ok(worst <= 0.05, `틱 끝 겹침 최대 ${worst}`);
  });

  it("an off-centre impact makes it spin: head lands on a block, the handle side keeps falling (and the mirror image spins the other way)", () => {
    const engine = engineWith(QUIET);
    // 각도 0: 머리 +x. 날 끝 바로 아래 블록 하나(날의 아래 뿔(몸 y +0.42)은 왼쪽 빈 칸 위) → 머리는 서고 손잡이(−x)는 내려간다 → 화면에서 반시계(각속도 < 0)
    const p = body(4.6, 7.6, { angle: 0, vy: 0.2 });
    let blocks = grid([[Math.floor(tip(engine, p).x), 8, 1e12]]);
    for (let t = 0; t < 6 && p.vAngle === 0; t++) engine.advancePickaxe(p, blocks, W, fixedRng());
    assert.ok(p.vAngle < 0, `반시계로 돌아야 함 (vAngle ${p.vAngle})`);
    const q = body(5.5, 7.6, { angle: Math.PI, vy: 0.2 });
    blocks = grid([[Math.floor(tip(engine, q).x), 8, 1e12]]);
    for (let t = 0; t < 6 && q.vAngle === 0; t++) engine.advancePickaxe(q, blocks, W, fixedRng());
    assert.ok(q.vAngle > 0, `거울상은 시계로 (vAngle ${q.vAngle})`);
  });

  it("a centred, flat landing does not spin (impulses through the centre of mass)", () => {
    const engine = engineWith(QUIET);
    const floor: [number, number, number][] = [];
    for (let x = 0; x < W; x++) floor.push([x, 8, 1e12]);
    const p = body(5, 7.4, { angle: Math.PI / 2, vy: 0.2 });   // 머리가 아래로 수직 → 접촉점이 중심 바로 아래
    const blocks = grid(floor);
    for (let t = 0; t < 4; t++) engine.advancePickaxe(p, blocks, W, fixedRng());
    assert.ok(Math.abs(p.vAngle) < 1e-12, `vAngle ${p.vAngle}`);
    assert.ok(p.vy < 0, "튕겨 올라간다");
  });

  it("(rules 7) a handle-only hit deals the full attack, like a blade hit", () => {
    // 각도 0, 손잡이 끝(−x)만 블록에 닿도록: 손잡이 끝 바로 아래 블록, 날 아래는 비어 있음
    for (const engine of [engineWith(QUIET), physicsFor(shipped)]) {
      const p = body(5.3, 7.95, { angle: 0, vy: 0.1, owner: OWNER, durabilityTotal: 1000, durabilityLeft: 1000 });
      const bx = Math.floor(handleOf(engine, p).ax);
      for (const q of engine.primitivesOf(p)) if (q.head) assert.ok(Math.min(q.ax, q.bx) - q.r > bx + 1, "날은 모두 다른 칸 위");
      const blocks = grid([[bx, 8, 1000]]);
      const handle = handleOf(engine, p);
      assert.ok(capsuleBlockContact(handle, blocks[8 * W + bx]!), "시작 자세에서 손잡이가 블록에 닿는다");
      const hits = engine.advancePickaxe(p, blocks, W, fixedRng());
      assert.ok(p.vy < 0.1, "손잡이가 닿아 튕겼다");
      assert.equal(hits.length, 1);
      assert.equal(hits[0]!.damage, 50, "손잡이 피해 = 공격력 그대로");
      assert.equal(blocks[8 * W + bx]!.health, 1000 - 50);
      assert.equal(p.durabilityLeft, 1000 - 50);
    }
    const engine = engineWith(QUIET);
    const p = body(4.5, 7.6, { angle: Math.PI / 2, vy: 0.2, owner: OWNER, durabilityTotal: 1000, durabilityLeft: 1000 });
    const hits = engine.advancePickaxe(p, grid([[4, 8, 1000]]), W, fixedRng());
    assert.equal(hits[0]!.damage, 50, "날은 공격력 그대로");
  });

  it("walls: a horizontal pickaxe flying into a wall bounces back and stays inside", () => {
    const engine = engineWith(QUIET);
    const p = body(0.8, 5, { angle: 0, vx: -0.4, vy: 0 });
    for (let t = 0; t < 10; t++) {
      engine.advancePickaxe(p, grid(), W, fixedRng());
      for (const q of engine.primitivesOf(p)) assert.ok(Math.min(q.ax, q.bx) - q.r >= -1e-9);
    }
    assert.ok(p.vx > 0, "튕겨 나온다");
  });

  it("head-first torque turns a falling pickaxe's head toward its direction of travel", () => {
    const engine = engineWith({ spinKick: 0 });
    const p = body(5, 3, { angle: 0, vy: 0.2 });
    engine.advancePickaxe(p, grid(), W, fixedRng());
    assert.ok(p.vAngle > 0, "머리(+x)가 아래(+y)로 돈다");
    for (let t = 0; t < 150; t++) engine.advancePickaxe(p, grid(), W, fixedRng());
    const { sin } = detSinCos(p.angle);
    assert.ok(sin > 0.95, `머리가 아래를 향한다 (sin θ = ${sin})`);
  });

  it("spin kick breaks a still bounce (random spin from the kick stream, only when spin is below spinKick)", () => {
    const floor: [number, number, number][] = [];
    for (let x = 0; x < W; x++) floor.push([x, 8, 1e12]);
    const still = body(5, 7.4, { angle: Math.PI / 2, vy: 0.2 });
    engineWith({ headFirstTorque: 0, contactFriction: 0 }).advancePickaxe(still, grid(floor), W, fixedRng());
    const quiet = body(5, 7.4, { angle: Math.PI / 2, vy: 0.2 });
    engineWith(QUIET).advancePickaxe(quiet, grid(floor), W, fixedRng());
    assert.equal(quiet.vAngle, 0);
    assert.ok(still.vAngle !== 0 && Math.abs(still.vAngle) <= shipped.physics.spinKick, `vAngle ${still.vAngle}`);
  });

  it("is deterministic: same start → identical state bytes after 500 ticks", () => {
    const run = () => {
      const engine = physicsFor(shipped);
      const floor: [number, number, number][] = [];
      for (let x = 0; x < W; x++) for (let y = 10; y < 20; y++) floor.push([x, y, 300]);
      const blocks = grid(floor);
      const p = body(3.3, 2, { angle: 1.1, vx: 0.07, vAngle: 0.1, owner: OWNER, durabilityTotal: 1e9, durabilityLeft: 1e9, attack: 61 });
      const rng = fixedRng(9);
      for (let t = 0; t < 500; t++) engine.advancePickaxe(p, blocks, W, rng);
      return JSON.stringify([p.x, p.y, p.vx, p.vy, p.angle, p.vAngle, p.durabilityLeft, blocks.map((b) => b.health)]);
    };
    assert.equal(run(), run());
  });
});
