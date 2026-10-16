// 테스트 공용 도우미 — Node API는 여기(테스트)에서만 쓴다. 엔진 본체는 주입받은 함수만 쓴다.
import { createHash, createHmac } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { parseCatalog, type Catalog, type EngineInput } from "@pikit/protocol";
import {
  createRoom, createStreamFactory, generateBlockRows, runWindow, serializeRoom, windowKeyMessage, Xoshiro128ss,
  type CompletedBatch, type EnginePayout, type HmacSha256, type PickaxeResult, type PickaxeState, type RngFactory, type RoomSkyEvent, type RoomState,
  type WindowResult,
} from "../src/index.js";

export const hmacSha256: HmacSha256 = (key, message) => new Uint8Array(createHmac("sha256", key).update(message).digest());

export function sha256Hex(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

export function loadCatalog(): Catalog {
  const path = fileURLToPath(import.meta.resolve("@pikit/protocol/catalog.example.json"));
  return parseCatalog(JSON.parse(readFileSync(path, "utf8")));
}

/** 시드(32바이트)와 윈도 번호로 그 윈도의 스트림 팩토리를 만든다 (체인 ID 143, 상점·블록 해시 0). */
export function windowFactory(seed: Uint8Array, roomId: number, window: number): RngFactory {
  const key = hmacSha256(seed, windowKeyMessage(143, new Uint8Array(20), roomId, window, new Uint8Array(32)));
  return createStreamFactory(hmacSha256, key);
}

export function seedFrom(n: number): Uint8Array {
  return new Uint8Array(createHash("sha256").update(`pikit-test-seed-${n}`).digest());
}

/** 고정 바이트로 만든 단순 Rng (물리 단위 시험용). */
export function fixedRng(n = 1): Xoshiro128ss {
  const bytes = new Uint8Array(16);
  bytes[3] = n; bytes[7] = 2; bytes[11] = 3; bytes[15] = 4;
  return Xoshiro128ss.fromBytes(bytes);
}

export const OWNERS = ["0x1111111111111111111111111111111111111111", "0x2222222222222222222222222222222222222222", "0x3333333333333333333333333333333333333333"];

export interface ScenarioRun {
  state: RoomState;
  hash: string;
  results: PickaxeResult[];
  payouts: EnginePayout[];   // 모든 윈도의 정산 (생긴 순서)
}

/** 입력 계획(윈도 → 입력들)을 시드로 돌린다. */
export function runPlan(catalog: Catalog, seed: Uint8Array, plan: Map<number, EngineInput[]>, lastWindow: number, roomId = 1): ScenarioRun {
  const state = createRoom(catalog, windowFactory(seed, roomId, 0), roomId, 0);
  const payouts: EnginePayout[] = [];
  for (let w = 1; w <= lastWindow; w++) payouts.push(...runWindow(state, catalog, w, plan.get(w) ?? [], windowFactory(seed, roomId, w)).payouts);
  return { state, hash: roomHash(state), results: state.results, payouts };
}

/** 바쁜 판 결과 (D125 하늘 이벤트 시험용). */
export interface BusyRun extends ScenarioRun {
  sky: RoomSkyEvent[];
}

/**
 * 바쁜 판: 지갑 n개(`0x1111…`, `0x2222…`, …)가 앞 곡괭이가 끝나면 바로 다음 1개를 산다(등급 = (ref + i) % 5).
 * 스크래치 시뮬 `hashcheck.mjs`의 8지갑 판과 같은 계획이다(seed 99, 3,000윈도 → 명세 §8-1·3의 고정 해시).
 * onWindow는 윈도마다 (상태, 결과)로 불린다 (불변식 검사).
 */
export function busyBoard(
  catalog: Catalog, seedNo: number, windows: number, wallets = 8, onWindow?: (state: RoomState, res: WindowResult) => void,
): BusyRun {
  const seed = seedFrom(seedNo);
  const state = createRoom(catalog, windowFactory(seed, 1, 0), 1, 0);
  const owners = Array.from({ length: wallets }, (_, i) => `0x${String(i + 1).repeat(40).slice(0, 40)}`);
  const payouts: EnginePayout[] = [];
  const sky: RoomSkyEvent[] = [];
  let ref = 1;
  for (let w = 1; w <= windows; w++) {
    const inputs: EngineInput[] = [];
    owners.forEach((owner, i) => {
      const slot = state.owners.find((x) => x.owner === owner);
      if (!slot || (slot.activeKey === null && slot.queue.length === 0)) inputs.push({ type: "purchase", ref: String(ref++), owner, tiers: [(ref + i) % 5] });
    });
    const res = runWindow(state, catalog, w, inputs, windowFactory(seed, 1, w));
    payouts.push(...res.payouts);
    sky.push(...res.sky);
    onWindow?.(state, res);
  }
  return { state, hash: roomHash(state), results: state.results, payouts, sky };
}

/** 판 생성만 돌린 결과 (규칙 7 띠 생성 시험용). kindAt(y, x) = 줄 y 칸 x의 종류. */
export interface GeneratedRows {
  rows: number;
  kindAt: (y: number, x: number) => number;
  batches: CompletedBatch[];
  factoryFor: (window: number) => RngFactory;
  hash: string;   // SHA-256(모든 줄의 종류 바이트)
}

/**
 * 판 생성기만 batches × rowsPerBatch 줄 돌린다 (줄 하나 = 윈도 하나, 줄이 링버퍼에서 지워지지 않게 큰 링).
 * 스크래치 `_analysis/sim-rules7-2026-10-12/genchk.mjs`와 같은 방식.
 */
export function generateRows(catalog: Catalog, seedNo: number, batches: number): GeneratedRows {
  const width = catalog.world.width;
  const rowsPerBatch = catalog.limits.batchBlocks / width;
  const rows = rowsPerBatch * batches;
  const seed = seedFrom(seedNo);
  const factoryFor = (w: number) => windowFactory(seed, 1, w);
  const state = {
    blocks: Array.from({ length: width * rows }, () => ({ kind: 0, x: 0, y: 0, health: 0 })),
    generatedRowCount: 0, batchIndex: -1, batchRemaining: [], batchKinds: [], batchRowWindows: [],
  } as unknown as RoomState;
  const completed: CompletedBatch[] = [];
  for (let y = 0; y < rows; y++) completed.push(...generateBlockRows(state, catalog, 1, factoryFor(y), y));
  const kinds = new Uint8Array(state.blocks.map((b) => b.kind));
  return { rows, kindAt: (y, x) => kinds[y * width + x]!, batches: completed, factoryFor, hash: sha256Hex(kinds) };
}

/** 방 상태 해시 (테스트 비교용) = SHA-256(serializeRoom). */
export function roomHash(state: RoomState): string {
  return sha256Hex(serializeRoom(state));
}

/** 시드에서 뽑은 무작위 구매 계획 (계획 자체도 결정론). 지갑 3개가 1~4개씩, 가끔 취소. 잔액은 체인 몫이라 엔진은 보지 않는다. */
export function fuzzPlan(catalog: Catalog, seed: Uint8Array, lastWindow: number, withFreeze: boolean): Map<number, EngineInput[]> {
  const r = Xoshiro128ss.fromBytes(new Uint8Array(createHash("sha256").update(seed).update("plan").digest()));
  const plan = new Map<number, EngineInput[]>();
  const push = (w: number, input: EngineInput) => { const a = plan.get(w) ?? []; a.push(input); plan.set(w, a); };
  let ref = 1;
  for (let w = 1; w <= lastWindow; w++) {
    for (const owner of OWNERS) {
      if (r.next() < 0.02) {
        const n = 1 + Math.floor(r.next() * 4);
        const tiers = Array.from({ length: n }, () => Math.floor(r.next() * catalog.pickaxes.length));
        push(w, { type: "purchase", ref: String(ref++), owner, tiers });
      }
      if (r.next() < 0.003) push(w, { type: "cancel", owner, itemKey: `${Math.max(1, ref - 1)}:1` });
    }
    if (withFreeze && w === Math.floor(lastWindow * 0.7)) push(w, { type: "freeze", reason: "FREEZE" });
  }
  return plan;
}

/** 물리 단위 시험용 곡괭이 (원본 테스트의 createPickaxe). 기본은 봇(주인 없음 = 내구도 제한 없음). */
export function createPickaxe(x: number, y: number, o: Partial<PickaxeState> & { weight?: number } = {}): PickaxeState {
  const weight = o.weight ?? 1;
  const scale = o.scale ?? 1.0;
  const attack = o.attack ?? 10;
  return {
    key: "test", owner: null, tier: o.tier ?? 0, priceMilli: 0,
    x, y, vx: o.vx ?? 0, vy: o.vy ?? 0.1, angle: o.angle ?? 0, vAngle: o.vAngle ?? 0,
    scale, attack,
    // 테스트 안에서만 Math.pow로 마찰 상수를 만든다 (원본 물리와 같은 값)
    frictionPerTick: o.frictionPerTick ?? Math.pow(Math.pow(0.75, 1 / 30), 1 / weight),
    durabilityTotal: o.durabilityTotal ?? 0, durabilityLeft: o.durabilityLeft ?? 0,
    spawnTick: 0, lastDamageTick: 0,
    luckyKind: o.luckyKind ?? -1,
    baseMilli: 0, carryMilli: 0, luckyMilli: 0, luckyCarryMilli: 0, bonusMilli: 0, touched: [], popPrevKind: -1, popDone: false, bigDone: false,
    streakKind: -1, streakLen: 0, bonusEvents: [], lastHitMilli: 0, lastHits: 0, hits: 0, blocksBroken: 0,
    ...(o.owner !== undefined ? { owner: o.owner } : {}),
  };
}
