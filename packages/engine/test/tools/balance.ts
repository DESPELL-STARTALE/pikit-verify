// 밸런스 대조 (규칙 7, D137 — docs/specs/16-rules7.md §8.7, 결과 docs/rules7-balance.md · 규칙 9: 막타 표, E에 막타 포함): 실제 엔진(createRoom/runWindow, 봇 포함)을
// 시드 여러 개로 돌려 잰다. 측정 정의는 스크래치 키트 `_analysis/sim-rules7-2026-10-12/`(r7.mjs·calib.mjs)와 같다.
//   pnpm --filter @pikit/engine balance -- [--seeds=40] [--pickaxes=60] [--players=1,3,8] [--workers=3] [--seedoff=0] [--catalog=normal|<json 경로>]
//     (기본) 방: 플레이어 n명(쉬지 않음, 앞 곡괭이가 끝난 다음 윈도에 무작위 등급 1개) + 카탈로그 봇. 방 크기마다 등급별 RTP·POP·BIG POP·배수 분포·
//            초과분(over)·수명·초당 타격, 틱 끝 박힘(중심이 살아 있는 블록 안)·관통(한 틱 이동 선분이 살아 있는 블록을 지남), 노출 다이아 분포
//     --skilled [--windows=600] [--every=20] [--rolls=24] [--warmup=0] [--warmplayers=8]  오라클 순간(w > 60, every 윈도마다)에서 등급마다 rolls번 "지금 사면" 굴림(롤 시드만 다름 =
//            앞으로의 줄·튕김·스폰·LUCKY). 앞 16번 = 추정, 뒤 8번 = 측정 → κ5·κ1·κ 상한·κ_board, "다이아 노출 때만 사기", 노출 다이아 분포
//     --day [--days=10]  무료 하루(10,000 크레딧, ×1만 파산(< 1,000)까지). 시드마다 하루를 days개 **끝까지** 돈다(잘린 마지막 날 없음 — 명세 §8.7)
//     --f9  등급마다 rewardCapBps/1e4 + E[over]/price ≤ 0.98, over 상한 ≤ 100 × 가격, rewardCapBps ≤ 9700 (명세 §4.5). 넘으면 종료 1 (기본 3인 방)
// LUCKY: 행운 종류 X는 물리와 무관하게 뽑히므로(`lucky|<키>`) 곡괭이의 종류별 피해 d_k를 알면 X에 대한 기대값을 정확히 낼 수 있다(명세 §4.8):
//   E_X[LUCKY] = share × 가격 × (뽑힐 수 있는 종류에 준 피해 ÷ D), E_X[over] = Σ_k odds_k × max(0, 기본 + 보너스 + rate_k × d_k − REWARD 상한)
//   (k = luckyEligible 종류, odds_k = batchCount_k ÷ LUCKY 풀 — 규칙 8에서 CHOG 두 종류는 뽑히지 않는다, 명세 21).
// 종류는 id로 찾는다(다이아 = "diamond", 금 = "gold", CHOG = "chog"·"chog_gold") — 번호를 박아 두지 않는다.
//   "LUCKY 기대값" 열·κ·F-9는 이 값을 쓴다(평균은 실현 값과 같고 분산만 작다 — 드문 행운 다이아 하나가 표본 평균을 흔들지 않게). 분포 열은 실현 값.
//   d_k는 PhysicsEngine.advancePickaxe가 돌려주는 피해 목록을 감싸 센다(엔진 코드는 그대로, 이 도구 프로세스 안에서만).
// 결과: 표(마크다운)를 stdout에.
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { isMainThread, parentPort, Worker, workerData } from "node:worker_threads";
import { luckyPoolCount, MAX_OVER_MULTIPLE, MAX_REWARD_CAP_BPS, parseCatalog, type Catalog, type EngineInput } from "@pikit/protocol";
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
}

export function parseOptions(argv: string[]): Options {
  const o: Options = { mode: "room", seeds: 40, seedoff: 0, pickaxes: 60, players: [], workers: 3, catalog: "normal", windows: 600, every: 20, rolls: 24, days: 10, warmup: 0, warmplayers: 8 };
  for (const a of argv) {
    if (a === "--") continue;   // pnpm run이 넘기는 구분자
    const m = /^--([a-z0-9]+)(?:=(.*))?$/.exec(a);
    if (!m) throw new Error(`balance: unknown argument ${a}`);
    const [, k, v] = m;
    if (k === "skilled" || k === "day" || k === "f9") o.mode = k === "skilled" ? "skilled" : k;
    else if (k === "catalog") o.catalog = v ?? "";
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

const ownerOf = (i: number) => `0x${String(i + 1).repeat(40).slice(0, 40)}`;
// 숙련자 주소는 ownerOf(i)가 만들 수 없는 값 (옛 0x5555…는 ownerOf(4)와 같았다 — D125 명세 §10)
const SKILLED = "0xffffffffffffffffffffffffffffffffffff5555";
const tierPicker = (seed: Uint8Array) => Xoshiro128ss.fromBytes(new Uint8Array(createHash("sha256").update(seed).update("balance-tiers").digest()));

/** 블록 id → kind (없으면 −1). 다이아·금·CHOG를 번호 대신 id로 찾는다 (규칙 8에서 다이아가 마지막 종류가 아니다) */
export function kindOfId(catalog: Catalog, id: string): number {
  return catalog.blocks.findIndex((b) => b.id === id);
}
/** CHOG 블록 kind들 (규칙 8, 명세 21) */
export function chogKinds(catalog: Catalog): number[] {
  return ["chog", "chog_gold"].map((id) => kindOfId(catalog, id)).filter((k) => k >= 0);
}

// ──────────────────────────────────────────────────────────────────────────
// 곡괭이 1개의 기록. 종류별 피해·타격: 플레이어 곡괭이 키 → [d_0 … d_9, 타격_0 … 타격_9]
// ──────────────────────────────────────────────────────────────────────────
const DAMAGE = new Map<string, number[]>();
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
    return hits;
  } as typeof advance;
}

/** 끝난 플레이어 곡괭이 1개 (밀리크레딧). rb·overRb = LUCKY 종류에 대한 기대값(정상 종료만, 그 밖은 실제 값). */
export interface Row {
  tier: number;
  price: number;
  paid: number;
  over: number;
  rb: number;
  overRb: number;
  diaHits: number;
  pop: boolean;
  big: boolean;
  life: number;   // 틱
  hits: number;
  normal: boolean;
  lastHit: number;   // (규칙 9) 막타 몫 (밀리, 실제 값 — LUCKY와 무관)
  lastHits: number;  // (규칙 9) 막타 횟수
}

function rowOf(catalog: Catalog, r: PickaxeResult): Row {
  const normal = r.endReason === "DURABILITY";
  const kinds = catalog.blocks.length;
  const d = DAMAGE.get(r.key) ?? new Array<number>(2 * kinds).fill(0);
  DAMAGE.delete(r.key);
  const pool = luckyPoolCount(catalog);
  let eligible = 0;
  catalog.blocks.forEach((b, k) => { if (b.luckyEligible) eligible += d[k]!; });
  const luckyExp = r.durabilityTotal > 0 ? (catalog.lucky.share * r.priceMilli * eligible) / r.durabilityTotal : 0;
  const B = r.baseMilli + r.bonusMilli + r.lastHitMilli;   // LUCKY를 뺀 E (규칙 9: 막타 포함 — 빠뜨리면 F-9가 over를 적게 센다)
  const cap = rewardCapMilli(catalog, r.tier);
  let overRb = 0;
  if (normal) {
    catalog.blocks.forEach((b, k) => {
      if (b.luckyEligible) overRb += (b.batchCount / pool) * Math.max(0, B + luckyRateMilli(catalog, r.tier, k) * d[k]! - cap);
    });
  }
  const dia = kindOfId(catalog, "diamond");
  return {
    tier: r.tier, price: r.priceMilli, paid: r.paidMilli, over: r.overMilli,
    rb: normal ? B + luckyExp : r.paidMilli, overRb: normal ? overRb : 0, diaHits: dia >= 0 ? d[kinds + dia]! : 0,
    pop: r.pop, big: r.bigPop, life: r.endTick + 1 - r.spawnTick, hits: r.hits, normal, lastHit: r.lastHitMilli, lastHits: r.lastHits,
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
const newSafety = (): Safety => ({ bodyTicks: 0, embedded: 0, tunnelled: 0, chordDepthMax: 0, stepMax: 0, playerTicks: 0, speedSum: 0, spinSum: 0 });

/** 칸 안 깊이 (가장 가까운 변까지 거리, 칸 밖이면 0). */
function depthIn(state: RoomState, W: number, x: number, y: number): number {
  const bx = Math.floor(x);
  const by = Math.floor(y);
  if (!getActiveBlockFromRingBuffer(state.blocks, W, bx, by)) return 0;
  return Math.min(x - bx, bx + 1 - x, y - by, by + 1 - y);
}

function tapTicks(catalog: Catalog, state: RoomState, s: Safety): Catalog {
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

// ──────────────────────────────────────────────────────────────────────────
// 방 (플레이어 n명이 쉬지 않고 무작위 등급)
// ──────────────────────────────────────────────────────────────────────────
export interface RoomOut {
  players: number;
  rows: Row[];
  windows: number;
  safety: Safety;
  exposure: number[];   // 노출 다이아 수 0, 1, 2, 3, 4+ (w > 60, every 윈도마다)
}

/** 시드마다 플레이어 n명이 각자 pickaxes개를 끝낼 때까지 돈다 (키트 r7.mjs tiers 모드와 같은 구매 규칙). */
export function runRoom(catalog: Catalog, players: number, seeds: readonly number[], pickaxes: number, seedoff = 0, every = 20): RoomOut {
  const owners = Array.from({ length: players }, (_, i) => ownerOf(i));
  const playerOf = new Map(owners.map((w, i) => [w, i]));
  tapDamage(catalog.blocks.length);
  const out: RoomOut = { players, rows: [], windows: 0, safety: newSafety(), exposure: [0, 0, 0, 0, 0] };
  for (const sd of seeds) {
    const seed = seedFrom(10_000 + seedoff + sd);
    const pick = tierPicker(seed);
    const state = createRoom(catalog, windowFactory(seed, 1, 0), 1, 0);
    const tapped = tapTicks(catalog, state, out.safety);
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
      for (const r of res.ended) {
        const pi = playerOf.get(r.owner);
        if (pi === undefined || done[pi]! >= pickaxes) continue;
        out.rows.push(rowOf(catalog, r));
        done[pi]! += 1;
      }
    }
  }
  return out;
}

// ──────────────────────────────────────────────────────────────────────────
// 무료 하루 (×1만, 10,000 크레딧으로 시작해 1,000 아래가 되면 끝)
// ──────────────────────────────────────────────────────────────────────────
export interface Day { n: number; ever: boolean; maxBal: number; ticks: number }

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
    let day: Day = { n: 0, ever: false, maxBal: start, ticks: 0 };
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
        day.n += 1;
        day.ticks += r.endTick + 1 - r.spawnTick;
        if (bal > day.maxBal) day.maxBal = bal;
        if (bal > start) day.ever = true;
        if (bal < price) {
          out.push(day);
          finished += 1;
          day = { n: 0, ever: false, maxBal: start, ticks: 0 };
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
          const m: Moment = { tier, f, rb: [], tot: [], over: [] };
          for (let k = 0; k < rolls; k++) {
            const rollSeed = new Uint8Array(createHash("sha256").update(seed).update(`roll|${w}|${tier}|${k}`).digest());
            const r = rollout(catalog, state, w, tier, rollSeed);
            const row = rowOf(catalog, r);
            m.rb.push(row.rb / row.price);
            m.tot.push((row.paid + row.over) / row.price);
            m.over.push(row.over / row.price);
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
export interface F9Tier { tier: number; code: string; n: number; capShare: number; eOver: number; eOverSe: number; sum: number; overCapMilli: number; overCapLimitMilli: number; ok: boolean }
export interface F9Result { tiers: F9Tier[]; rewardCapBps: number; ok: boolean }

/** 등급마다 rewardCapBps/1e4 + E[over]/price ≤ 0.98, over 상한 ≤ 100 × 가격, rewardCapBps ≤ 9700. */
export function f9Report(catalog: Catalog, rows: readonly Row[]): F9Result {
  const bps = catalog.reward.rewardCapBps;
  const tiers = catalog.pickaxes.map((p, t): F9Tier => {
    // E[over]: LUCKY 종류에 대한 정확한 기대(overRb, 곡괭이의 종류별 피해로 계산 — 분산이 작다)
    const os = rows.filter((r) => r.tier === t).map((r) => r.overRb / r.price);
    const capShare = bps / 1e4;
    const eOver = mean(os);
    const oc = overCapMilli(catalog, t);
    const limit = MAX_OVER_MULTIPLE * p.priceCredits * 1000;
    return {
      tier: t, code: p.code, n: os.length, capShare, eOver, eOverSe: sd(os) / Math.sqrt(Math.max(1, os.length)), sum: capShare + eOver,
      overCapMilli: oc, overCapLimitMilli: limit, ok: os.length > 0 && capShare + eOver <= F9_BOUND && oc <= limit,
    };
  });
  return { tiers, rewardCapBps: bps, ok: bps <= MAX_REWARD_CAP_BPS && tiers.every((t) => t.ok) };
}

function f9Table(catalog: Catalog, f: F9Result): string[] {
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
  const s = room.safety;
  out.push("");
  out.push(`player bodies: speed ${((s.speedSum / s.playerTicks) * fps).toFixed(2)} tiles/s · spin ${((s.spinSum / s.playerTicks) * fps).toFixed(2)} rad/s · max step ${s.stepMax.toFixed(3)} tiles/tick`);
  out.push(`safety over ${s.bodyTicks.toLocaleString("en-US")} body-ticks (players + bots): **embedded ${s.embedded}** (centre inside a live block at a tick end) · **tunnelled ${s.tunnelled}** (tick chord > 0.1 tile inside a block live at the tick end; deepest chord ${s.chordDepthMax.toFixed(3)})`);
  const ne = sum(room.exposure);
  out.push(`exposed Diamonds at ${ne} moments (w > 60, every 20 windows): ${room.exposure.map((n, i) => `${i}${i === 4 ? "+" : ""}: ${pct(n / Math.max(1, ne))}`).join(" · ")}`);
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
  const per = moments.filter((m) => m.tier === 0);
  const hist = [0, 0, 0, 0, 0];
  for (const m of per) hist[Math.min(4, m.f.expDia)]! += 1;
  out.push(`exposed Diamonds at the ${per.length} oracle moments: ${hist.map((n, i) => `${i}${i === 4 ? "+" : ""}: ${pct(n / Math.max(1, per.length))}`).join(" · ")}`);
  return out;
}

function dayTable(catalog: Catalog, days: readonly Day[], players: number): string[] {
  const p = mean(days.map((d) => (d.ever ? 1 : 0)));
  const fps = catalog.physics.fps;
  return [
    `### free day — ${players}-player room, 10,000 credits, ×1 until broke (< 1,000), ${days.length} complete days (no truncated last day)`,
    "",
    `winning days (ever above the start) **${pct(p)}** ± ${pct(Math.sqrt((p * (1 - p)) / days.length))} · ${mean(days.map((d) => d.n)).toFixed(1)} pickaxes per day (median ${quant(days.map((d) => d.n), 0.5)}) · ${(mean(days.map((d) => d.ticks)) / fps / 60).toFixed(1)} min on the board · mean best balance ${(mean(days.map((d) => d.maxBal)) / (10 * catalog.pickaxes[0]!.priceCredits * 1000)).toFixed(2)} × start`,
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
  if (task.kind === "room") return runRoom(catalog, task.players, seeds, o.pickaxes, o.seedoff, o.every);
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
  return {
    players: parts[0]!.players, rows: parts.flatMap((p) => p.rows), windows: sum(parts.map((p) => p.windows)), safety: s,
    exposure: parts.reduce((a, p) => a.map((x, i) => x + p.exposure[i]!), [0, 0, 0, 0, 0]),
  };
}

async function main(): Promise<number> {
  const o = parseOptions(process.argv.slice(2));
  const catalog = loadCatalogFor(o.catalog);
  const t0 = Date.now();
  const out: string[] = [];
  out.push(`engine balance (rules ${catalog.rulesVersion}) — ${o.catalog}, rulesVersion ${catalog.rulesVersion}, LUCKY share ${catalog.lucky.share}, REWARD cap ${catalog.reward.rewardCapBps} bps, bots ${catalog.bots.map((b) => `${b.code}×${b.count}`).join(" ")}, mode ${o.mode}, ${o.seeds} seeds (offset ${o.seedoff}), players ${o.players.join(",")}, ${o.workers} workers`);
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
