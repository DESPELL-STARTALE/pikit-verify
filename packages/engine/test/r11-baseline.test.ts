// (규칙 12, 명세 25 §5.3-1) 고정 기준 — 5세계(규칙 11) 빌드가 기록한 결과(test/fixtures/r11-baseline.json, 기록기 test/tools/record-r11-baseline.mjs)를
// 규칙 12 엔진이 같은 카탈로그의 새 꼴(luckyWeight = 행운 가능 종류의 batchCount, buffs·bots[].bounce·quadChanceBps 없음)에서 비트까지 다시 낸다:
// 끝난 곡괭이 결과 전부 · 사건(스폰/LUCKY PICK · POP/BIG_POP · LAST HIT · 잭팟 · 정산 · 하늘 · 무효) 목록 해시 · 100윈도마다 상태 해시(v12 직렬화 —
// 새 칸 quad · item*을 읽지 않는 시험 사본) · 판 생성만 3묶음의 묶음 종류 해시. 손대지 않은 물리(봇 반발 없음 = physics.bounce) · 판(4칸 확률 없음 =
// 수를 뽑지 않음) · 기본 보상 · LUCKY(가중 = batchCount) · 막타 · 잭팟 · COMBO 정산이 같다는 증명이다.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { parseCatalog, type Catalog, type EngineInput } from "@pikit/protocol";
import { createRoom, generateBlockRows, runWindow, windowRngFactory, type CompletedBatch, type RoomState, type WindowResult } from "../src/index.js";
import { serializeRoomV12 } from "./serialize-v12.js";

type Packed = [0, number, string, number[]] | [1, number, string] | [2, number, string] | [3, "FREEZE" | "ROOM_CLOSED"];
interface Run {
  name: string;
  seed: string;
  roomId: number;
  chainId: number;
  shop: string;
  firstWindow: number;
  lastWindow: number;
  jackpotPatch: Record<string, unknown> | null;
  wallets: string[];
  inputs: [number, Packed[]][];
  expect: {
    ended: unknown[];
    lists: Record<string, { count: number; sha256: string }>;
    checkpoints: [number, string][];
    batchKindsSoFar: string;
    generatedRowCount: number;
    tick: number;
    board: { batches: string[]; health: string };
  };
}
interface Fixture { recordedWith: { commit: string; stateTag: string }; catalog: Record<string, unknown> & { jackpot: Record<string, unknown> }; runs: Run[] }

const fixture = JSON.parse(readFileSync(new URL("../../test/fixtures/r11-baseline.json", import.meta.url), "utf8")) as Fixture;
const sha256 = (bytes: Uint8Array) => `0x${createHash("sha256").update(bytes).digest("hex")}`;
const hexBytes = (h: string) => Uint8Array.from(Buffer.from(h.slice(2), "hex"));
const ZERO = new Uint8Array(32);
const CHECKPOINT = 100;
const BOARD_BATCHES = 3;
const LISTS = ["spawned", "events", "lastHits", "jackpots", "payouts", "sky", "voided", "batches"] as const;

function catalogOf(run: Run): Catalog {
  const raw = run.jackpotPatch ? { ...fixture.catalog, jackpot: { ...fixture.catalog.jackpot, ...run.jackpotPatch } } : fixture.catalog;
  return parseCatalog(structuredClone(raw));
}

function unpack(run: Run, i: Packed): EngineInput {
  switch (i[0]) {
    case 0: return { type: "purchase", ref: i[2], owner: run.wallets[i[1]]!, tiers: i[3] };
    case 1: return { type: "cancel", owner: run.wallets[i[1]]!, itemKey: i[2] };
    case 2: return { type: "voidPurchase", ref: i[2], owner: run.wallets[i[1]]! };
    case 3: return { type: "freeze", reason: i[1] };
  }
}

const digest = (list: readonly unknown[]) => ({ count: list.length, sha256: sha256(Buffer.from(JSON.stringify(list))) });
const batchDigest = (b: CompletedBatch) => ({ batchIndex: b.batchIndex, kinds: sha256(Uint8Array.from(b.kinds)), rowWindows: sha256(Buffer.from(JSON.stringify(b.rowWindows))) });

test("고정 기준 파일은 5세계 빌드(규칙 11 · 상태 v12)가 쓴 것이고, 새 꼴 카탈로그에 규칙 12 칸이 없다", () => {
  assert.equal(fixture.recordedWith.commit, "2f401a40");
  assert.equal(fixture.recordedWith.stateTag, "PIKIT/state/v12");
  const c = catalogOf(fixture.runs[0]!);
  assert.equal(c.rulesVersion, 11);
  assert.equal(c.buffs, undefined);
  assert.equal(c.generation.quadChanceBps, undefined);
  assert.ok(c.bots.every((b) => b.bounce === undefined));
  // luckyWeight = 규칙 11의 행운 가능 종류(CHOG 두 종류 제외)의 batchCount
  c.blocks.forEach((b) => assert.equal(b.luckyWeight, b.id === "chog" || b.id === "chog_gold" ? 0 : b.batchCount, b.id));
  assert.ok(fixture.runs.length >= 3 && fixture.runs.some((r) => r.seed === `0x${"62".repeat(32)}`));
});

for (const run of fixture.runs) {
  test(`고정 기준 = 규칙 12 엔진 — ${run.name}, ${run.lastWindow - run.firstWindow}윈도`, () => {
    const catalog = catalogOf(run);
    const seed = hexBytes(run.seed);
    const shop = hexBytes(run.shop);
    const inputsAt = new Map(run.inputs.map(([w, list]) => [w, list.map((i) => unpack(run, i))]));
    const state: RoomState = createRoom(catalog, windowRngFactory(seed, run.chainId, shop, run.roomId, run.firstWindow, ZERO), run.roomId, run.firstWindow);
    const got: Record<(typeof LISTS)[number] | "ended", unknown[]> = { ended: [], spawned: [], events: [], lastHits: [], jackpots: [], payouts: [], sky: [], voided: [], batches: [] };
    const checkpoints: [number, string][] = [];
    for (let w = run.firstWindow + 1; w <= run.lastWindow; w++) {
      const res: WindowResult = runWindow(state, catalog, w, inputsAt.get(w) ?? [], windowRngFactory(seed, run.chainId, shop, run.roomId, w, ZERO));
      assert.equal(res.buffs.length, 0, `w${w}: no items without catalog.buffs`);
      got.ended.push(...res.ended);
      got.spawned.push(...res.spawned.map((s) => ({ window: w, ...s })));
      got.events.push(...res.events);
      got.lastHits.push(...res.lastHits);
      got.jackpots.push(...res.jackpots);
      got.payouts.push(...res.payouts);
      got.sky.push(...res.sky);
      got.voided.push(...res.voided);
      got.batches.push(...res.batches.map(batchDigest));
      if ((w - run.firstWindow) % CHECKPOINT === 0) checkpoints.push([w, sha256(serializeRoomV12(state))]);
    }
    assert.ok(state.blocks.every((b) => b.quad === 0), "no 2×2 without quadChanceBps");
    // 규칙 12 사다리 (luckyMultBps)는 덧붙은 필드 — 사다리 없는 기준 카탈로그에서는 언제나 ×1 이고, 나머지는 그대로다
    assert.ok((got.ended as Array<{ luckyMultBps: number }>).every((e) => e.luckyMultBps === 10_000), "no ladder → luckyMultBps ×1");
    const endedR11 = (got.ended as Array<{ luckyMultBps: number }>).map(({ luckyMultBps: _m, ...rest }) => rest);
    assert.deepEqual(JSON.parse(JSON.stringify(endedR11)), run.expect.ended, "ended pickaxe results");
    assert.ok((got.spawned as Array<{ luckyMultBps: number }>).every((e) => e.luckyMultBps === 10_000), "no ladder → spawn luckyMultBps ×1");
    got.spawned = (got.spawned as Array<{ luckyMultBps: number }>).map(({ luckyMultBps: _m, ...rest }) => rest);
    for (const k of LISTS) assert.deepEqual(digest(got[k]), run.expect.lists[k], k);
    assert.deepEqual(checkpoints, run.expect.checkpoints, "state checkpoints (v12)");
    assert.equal(sha256(Uint8Array.from(state.batchKinds)), run.expect.batchKindsSoFar);
    assert.equal(state.generatedRowCount, run.expect.generatedRowCount);
    assert.equal(state.tick, run.expect.tick);

    // 판 생성만 3묶음 (줄 y = 윈도 y, 방 번호 9 — 기록기 boardOnly와 같다)
    const width = catalog.world.width;
    const rows = (catalog.limits.batchBlocks / width) * BOARD_BATCHES;
    const board = {
      blocks: Array.from({ length: width * rows }, () => ({ kind: 0, x: 0, y: 0, health: 0, quad: 0 })),
      generatedRowCount: 0, batchIndex: -1, batchRemaining: [], batchKinds: [], batchRowWindows: [],
    } as unknown as RoomState;
    const batches: string[] = [];
    for (let y = 0; y < rows; y++) {
      for (const b of generateBlockRows(board, catalog, 1, windowRngFactory(seed, run.chainId, shop, 9, y, ZERO), y)) batches.push(sha256(Uint8Array.from(b.kinds)));
    }
    assert.deepEqual({ batches, health: sha256(Buffer.from(JSON.stringify(board.blocks.map((b) => b.health)))) }, run.expect.board, "board-only batches");
  });
}
