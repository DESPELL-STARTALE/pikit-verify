// 입력 = 체인 사건 연결 규칙 (H-1, D111, linkage.ts): 동결 시작 블록, 방-윈도 상한과 넘김 순서, 대조 결과 코드. (개정 6 묶음 시험 — 상한·동결이 걸리는 verifyEpochs 묶음 — 은 D4에서 그 검증기와 함께 지웠다; 개정 7의 입력 대조는 ledger-verify.test.ts)
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { T_FREEZE, type EpochWindowInputs, type Hex32, type InputLink } from "@pikit/protocol";
import { InputScheduler } from "@pikit/engine";
import { checkInputLinkage, freezeStarts, type LinkedInput } from "../src/index.js";

const TX = `0x${"7a".repeat(32)}` as Hex32;
const W0 = 1000;
const owner = (i: number) => `0x${(0xc000 + i).toString(16).padStart(40, "0")}`;
const link = (block: number, logIndex: number, pos = 0): InputLink => ({ block, logIndex, pos, txHash: logIndex === -1 ? null : TX });
const purchase = (roomId: number, ref: number, block: number, logIndex: number): LinkedInput =>
  ({ roomId, input: { type: "purchase", ref: String(ref), owner: owner(ref), tiers: [0] }, link: link(block, logIndex) });

describe("freezeStarts: the first block whose processing lag exceeds T_FREEZE", () => {
  it("no anchor → genesis + T_FREEZE + 1; an anchor in time pushes it back; a late anchor that leaves lag above T_FREEZE starts nothing new", () => {
    assert.deepEqual(freezeStarts([], W0, W0, W0 + 20_000), [W0 + T_FREEZE + 1]);
    const onTime = [{ postedBlock: W0 + 5_000, processedThrough: W0 + 4_000 }];
    assert.deepEqual(freezeStarts(onTime, W0, W0, W0 + 20_000), [W0 + 4_000 + T_FREEZE + 1]);
    // 늦은 앵커가 지연을 T_FREEZE 아래로 내리면 동결이 끝나고, 다시 넘으면 새 동결이 시작된다
    const late = [{ postedBlock: W0 + 13_000, processedThrough: W0 + 12_500 }];
    assert.deepEqual(freezeStarts(late, W0, W0, W0 + 30_000), [W0 + T_FREEZE + 1, W0 + 12_500 + T_FREEZE + 1]);
    // 늦은 앵커가 실려도 지연이 그대로 T_FREEZE 위면 같은 동결이 이어진다
    const stillFrozen = [{ postedBlock: W0 + 13_000, processedThrough: W0 + 500 }];
    assert.deepEqual(freezeStarts(stillFrozen, W0, W0, W0 + 14_000), [W0 + T_FREEZE + 1]);
    // 구간 안에서만 (구간 앞에서 이미 동결이면 새 시작 아님)
    assert.deepEqual(freezeStarts([], W0, W0 + T_FREEZE + 5, W0 + T_FREEZE + 9), []);
    assert.deepEqual(freezeStarts([], W0, W0 + T_FREEZE + 1, W0 + T_FREEZE + 1), [W0 + T_FREEZE + 1]);
  });
});

describe("InputScheduler: per room (block, log index, pos) order, ≤ cap per window, the rest carried in order", () => {
  it("takes at most cap inputs per room and window, carries the rest in key order, never before block + 1", () => {
    const s = new InputScheduler(3);
    s.add([purchase(1, 5, 100, 9), purchase(1, 1, 100, 2), purchase(1, 2, 100, 3), purchase(1, 3, 100, 4), purchase(1, 4, 100, 5), purchase(2, 9, 100, 1)]);
    s.add([purchase(1, 6, 101, 0)]);
    assert.deepEqual(s.take(100, [1, 2]).size, 0, "블록 100의 사건은 윈도 101부터");
    const w101 = s.take(101, [1, 2]);
    assert.deepEqual(w101.get(1)!.map((x) => x.link.logIndex), [2, 3, 4], "로그 번호 순서로 상한 3개");
    assert.deepEqual(w101.get(2)!.length, 1, "상한은 방마다");
    assert.deepEqual(s.take(102, [1, 2]).get(1)!.map((x) => `${x.link.block}:${x.link.logIndex}`), ["100:5", "100:9", "101:0"], "밀린 것이 먼저, 순서 그대로");
    assert.deepEqual(s.pending(), []);
    assert.throws(() => s.add([purchase(1, 7, 100, 1)]), /not after the last placed input/, "이미 지나간 윈도의 사건은 받지 않는다");
    assert.throws(() => new InputScheduler(0));
  });
});

describe("checkInputLinkage: mismatch codes", () => {
  const rooms = [{ roomId: 1, createdWindow: W0 }];
  const ev = {
    purchases: [{ purchaseId: "0", buyer: owner(0), roomId: 1, rulesHash: TX, tiers: [0, 1], blockNumber: W0 + 1, logIndex: 0, txHash: TX }],
    cancels: [{ wallet: owner(0), roomId: 1, items: [((0n << 8n) | 1n).toString()], blockNumber: W0 + 2, logIndex: 4, txHash: TX }],
    voids: [], freezeBlocks: [],
  };
  const honest: EpochWindowInputs[] = [
    { window: W0 + 2, rooms: [{ roomId: 1, inputs: [{ type: "purchase", ref: "0", owner: owner(0), tiers: [0, 1] }], links: [link(W0 + 1, 0)] }] },
    { window: W0 + 3, rooms: [{ roomId: 1, inputs: [{ type: "cancel", owner: owner(0), itemKey: "0:1" }], links: [link(W0 + 2, 4)] }] },
  ];
  const run = (windows: EpochWindowInputs[]) => checkInputLinkage({ rooms, events: ev, windows, first: W0, last: W0 + 10 });

  it("matches the honest log", () => {
    const r = run(honest);
    assert.deepEqual([r.checked, r.matched, r.mismatches.length, r.problems.length], [2, 2, 0, 0]);
  });

  it("reports MISSING, WINDOW, FIELDS, EXTRA, DUPLICATE and ORDER", () => {
    assert.deepEqual(run([honest[0]!]).mismatches.map((m) => m.code), ["MISSING"]);
    assert.deepEqual(run([honest[0]!, { ...honest[1]!, window: W0 + 4 }]).mismatches.map((m) => m.code), ["WINDOW"]);
    const retier = structuredClone(honest);
    (retier[0]!.rooms[0]!.inputs[0] as { tiers: number[] }).tiers = [4, 4];
    assert.deepEqual(run(retier).mismatches.map((m) => m.code), ["FIELDS"]);
    const extra = structuredClone(honest);
    extra[1]!.rooms[0]!.inputs.push({ type: "freeze", reason: "ROOM_CLOSED" });
    extra[1]!.rooms[0]!.links.push(link(W0 + 2, -1));
    assert.deepEqual(run(extra).mismatches.map((m) => m.code), ["EXTRA"], "체인 사건 없는 동결(ROOM_CLOSED)은 넣을 수 없다");
    const dup = structuredClone(honest);
    dup[1]!.rooms[0]!.inputs.push(dup[1]!.rooms[0]!.inputs[0]!);
    dup[1]!.rooms[0]!.links.push(dup[1]!.rooms[0]!.links[0]!);
    assert.deepEqual(run(dup).mismatches.map((m) => m.code), ["DUPLICATE"]);
    // 같은 윈도 안 순서: 체인 순서(로그 번호)를 뒤집으면 ORDER
    const two = { ...ev, purchases: [...ev.purchases, { ...ev.purchases[0]!, purchaseId: "1", buyer: owner(1), logIndex: 1 }], cancels: [] };
    const swapped: EpochWindowInputs[] = [{
      window: W0 + 2,
      rooms: [{ roomId: 1, inputs: [{ type: "purchase", ref: "1", owner: owner(1), tiers: [0, 1] }, { type: "purchase", ref: "0", owner: owner(0), tiers: [0, 1] }], links: [link(W0 + 1, 1), link(W0 + 1, 0)] }],
    }];
    assert.deepEqual(checkInputLinkage({ rooms, events: two, windows: swapped, first: W0, last: W0 + 10 }).mismatches.map((m) => m.code), ["ORDER"]);
  });

  it("reports events outside the world or before the room existed as problems", () => {
    const r = checkInputLinkage({
      rooms: [{ roomId: 1, createdWindow: W0 + 5 }], first: W0, last: W0 + 10, windows: [],
      events: { ...ev, purchases: [ev.purchases[0]!, { ...ev.purchases[0]!, purchaseId: "1", roomId: 9 }], cancels: [] },
    });
    assert.deepEqual(r.problems.map((p) => p.code).sort(), ["BEFORE_ROOM", "OUTSIDE_WORLD"]);
  });

  it("carries the backlog across ranges: carryOut of one range is the carry of the next", () => {
    const many = { ...ev, cancels: [], purchases: Array.from({ length: 7 }, (_, i) => ({ ...ev.purchases[0]!, purchaseId: String(i), buyer: owner(i), logIndex: i })) };
    const placed = (from: number, ids: number[]): EpochWindowInputs => ({
      window: from, rooms: [{ roomId: 1, inputs: ids.map((i) => ({ type: "purchase" as const, ref: String(i), owner: owner(i), tiers: [0, 1] })), links: ids.map((i) => link(W0 + 1, i)) }],
    });
    const first = checkInputLinkage({ rooms, events: many, windows: [placed(W0 + 2, [0, 1, 2])], first: W0, last: W0 + 2, cap: 3 });
    assert.deepEqual([first.mismatches.length, first.pending], [0, 4]);
    const next = checkInputLinkage({
      rooms, events: { ...many, purchases: [] }, carry: first.carryOut, windows: [placed(W0 + 3, [3, 4, 5]), placed(W0 + 4, [6])], first: W0 + 3, last: W0 + 10, cap: 3,
    });
    assert.deepEqual([next.checked, next.matched, next.mismatches.length], [4, 4, 0]);
  });
});
