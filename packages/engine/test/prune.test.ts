// 상태 정리 (prune.ts): 오래 도는 방이 끝없이 커지지 않는다, 정리는 결정론적이다, 남은 원소의 바이트는 그대로다.
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  cloneRoom, createRoom, PRUNE_PERIOD_WINDOWS, pruneRoom, RETAIN_WINDOWS, runWindow, serializeRoom,
  type RoomState,
} from "../src/index.js";
import { fuzzPlan, loadCatalog, runPlan, seedFrom, sha256Hex, windowFactory, roomHash } from "./helpers.js";

const catalog = loadCatalog();
const LAST = RETAIN_WINDOWS * 2 + 1100;   // 정리가 여러 번 실제로 지우는 길이

function run(seedNo: number, restoreEvery = 0): { state: RoomState; ended: number; maxResults: number } {
  const seed = seedFrom(seedNo);
  const plan = fuzzPlan(catalog, seed, LAST, false);
  let state = createRoom(catalog, windowFactory(seed, 1, 0), 1, 0);
  let ended = 0;
  let maxResults = 0;
  for (let w = 1; w <= LAST; w++) {
    if (restoreEvery > 0 && w % restoreEvery === 0) { state = cloneRoom(state); }
    ended += runWindow(state, catalog, w, plan.get(w) ?? [], windowFactory(seed, 1, w)).ended.length;
    maxResults = Math.max(maxResults, state.results.length);
  }
  return { state, ended, maxResults };
}

describe("state pruning (every 200 windows, keep the last 4,000)", () => {
  it("drops old results / rejected inputs and counts them; nothing younger than the retention window is dropped", () => {
    const { state, ended } = run(901);
    assert.ok(state.prunedResults > 0, "실제로 지웠어야 함");
    assert.equal(state.prunedResults + state.results.length, ended, "지운 개수 + 남은 개수 = 끝난 곡괭이 전부");
    const lastPrune = Math.floor(LAST / PRUNE_PERIOD_WINDOWS) * PRUNE_PERIOD_WINDOWS;
    const cutoff = lastPrune - RETAIN_WINDOWS;
    assert.ok(state.results.every((r) => r.endWindow >= cutoff));
    assert.ok(state.results[0]!.endWindow < cutoff + PRUNE_PERIOD_WINDOWS + 200, "보관 기간보다 크게 남지 않는다");
  });

  it("idle owner slots are dropped (they come back with the same effect), busy or cooling-down ones are kept", () => {
    const state = createRoom(catalog, windowFactory(seedFrom(905), 1, 0), 1, 0);
    state.owners = [
      { owner: "0xa", queue: [], activeKey: null, nextSpawnWindow: 120 },        // 쉬는 칸 → 지움
      { owner: "0xb", queue: [], activeKey: null, nextSpawnWindow: 201 },        // 다음 윈도까지 스폰 금지 → 남김
      { owner: "0xc", queue: [], activeKey: "1:0", nextSpawnWindow: 0 },         // 살아 있는 곡괭이 → 남김
    ];
    assert.equal(pruneRoom(state, 200).owners, 1);
    assert.deepEqual(state.owners.map((s) => s.owner), ["0xb", "0xc"]);
  });

  it("is deterministic and restart-safe across prune boundaries (JSON snapshots every 333 windows)", () => {
    const a = run(902);
    const b = run(902, 333);
    assert.equal(roomHash(b.state), roomHash(a.state));
    assert.equal(runPlan(catalog, seedFrom(902), fuzzPlan(catalog, seedFrom(902), LAST, false), LAST).hash, roomHash(a.state));
  });

  it("only removes a prefix: the retained elements keep exactly their bytes", () => {
    const seed = seedFrom(903);
    const plan = fuzzPlan(catalog, seed, 4400, false);
    const state = createRoom(catalog, windowFactory(seed, 1, 0), 1, 0);
    for (let w = 1; w < 4400; w++) runWindow(state, catalog, w, plan.get(w) ?? [], windowFactory(seed, 1, w));
    const room = cloneRoom(state);
    const r = pruneRoom(room, 4400);
    assert.ok(r.results > 0);
    assert.deepEqual(room.results, state.results.slice(r.results));
    // 정리한 상태에 지운 원소를 다시 붙이면 원래 상태와 같은 바이트 (정리 개수만 다름)
    const back = cloneRoom(room);
    back.results = [...state.results.slice(0, r.results), ...back.results];
    back.rejected = [...state.rejected.slice(0, r.rejected), ...back.rejected];
    back.owners = state.owners;
    back.prunedResults = state.prunedResults;
    back.prunedRejected = state.prunedRejected;
    assert.equal(sha256Hex(serializeRoom(back)), sha256Hex(serializeRoom(state)));
  });

  it("long-running rooms stay bounded (the retained tail does not grow with run length)", () => {
    const { maxResults, ended } = run(904);
    assert.ok(ended > maxResults * 1.5, `끝난 곡괭이 ${ended} vs 최대 보관 ${maxResults}`);
  });
});
