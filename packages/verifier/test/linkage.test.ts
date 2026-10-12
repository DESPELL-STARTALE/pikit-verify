// 입력 = 체인 사건 연결 규칙 (H-1, D111, linkage.ts): 동결 시작 블록, 방-윈도 상한과 넘김 순서, 대조 결과 코드, 그리고 상한·동결이 실제로 걸리는 묶음.
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { keccak256, MAX_INPUTS_PER_ROOM_WINDOW, SeedChain, T_FREEZE, type EpochWindowInputs, type Hex32, type InputLink } from "@pikit/protocol";
import { InputScheduler } from "@pikit/engine";
import { checkInputLinkage, freezeStarts, LINKAGE_CHECK, StaticChainSource, verifyEpochs, WorldProducer, type LinkedInput } from "../src/index.js";
import { loadNormal } from "./demo-bundle.js";

const TX = `0x${"7a".repeat(32)}` as Hex32;
const W0 = 1000;
const SHOP = "0x5b0b000000000000000000000000000000000005";
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

type Tamper = (w: number, x: Map<number, LinkedInput[]>) => Map<number, LinkedInput[]>;

/** 방 하나 세계: plan(p, w)가 윈도 w 전에 체인 사건을 적고, 에폭 끝마다 after(p, w)를 부른다. 묶음 = 검증기 입력. */
function oneRoom(windows: number, plan: (p: WorldProducer, w: number) => void, o: { cap?: number; tamper?: Tamper; after?: (p: WorldProducer, w: number) => void } = {}) {
  const catalog = loadNormal();
  const p = new WorldProducer({
    chainId: 143, shop: SHOP, genesisBlock: W0, seeds: new SeedChain(keccak256(new TextEncoder().encode("link")), 128, 16),
    rooms: [{ roomId: 1, createdWindow: W0, catalog }], blockHash: (w) => keccak256(new TextEncoder().encode(`b${w}`)),
    ...(o.cap ? { cap: o.cap } : {}), ...(o.tamper ? { tamper: o.tamper } : {}),
  });
  for (let w = W0; w < W0 + windows; w++) {
    plan(p, w);
    p.step();
    if ((w - W0 + 1) % 200 === 0) o.after?.(p, w);
  }
  return {
    bundle: { world: p.manifest(), chain: new StaticChainSource(p.chainSnapshot()), epochs: p.epochLogs(), catalogs: new Map<string, unknown>([[p.manifest().rooms[0]!.catalogHash, catalog]]) },
    logs: p.epochLogs(),
  };
}

describe("bundles where the cap and a freeze actually apply", () => {
  const flood = (p: WorldProducer, w: number) => {
    if (w - 1 === W0 + 10) for (let i = 0; i < MAX_INPUTS_PER_ROOM_WINDOW + 5; i++) p.purchase({ block: w - 1, roomId: 1, buyer: owner(i), tiers: [0] });
  };

  it(`${MAX_INPUTS_PER_ROOM_WINDOW + 5} purchases in one block: ${MAX_INPUTS_PER_ROOM_WINDOW} at b + 1, 5 carried to b + 2 in log order — verifiable; ignoring the cap fails (WINDOW)`, async () => {
    const honest = oneRoom(200, flood);
    assert.deepEqual(honest.logs[0]!.windows.map((x) => [x.window, x.rooms[0]!.inputs.length]), [[W0 + 11, MAX_INPUTS_PER_ROOM_WINDOW], [W0 + 12, 5]]);
    const ok = await verifyEpochs(honest.bundle);
    assert.ok(ok.ok, JSON.stringify(ok.checks.filter((c) => !c.ok)));
    assert.equal(ok.linkage.matched, MAX_INPUTS_PER_ROOM_WINDOW + 5);
    // 운영자가 상한 없이(1,000) 모두 b + 1에 넣으면 — 세계·기록은 그 입력으로 서로 맞아도 넘친 5개가 WINDOW
    const greedy = await verifyEpochs(oneRoom(200, flood, { cap: 1000 }).bundle);
    assert.deepEqual(greedy.checks.filter((c) => !c.ok).map((c) => c.name), [LINKAGE_CHECK]);
    assert.deepEqual(greedy.linkage.mismatches.map((m) => [m.code, m.expected?.window, m.actual?.window]), Array(5).fill(["WINDOW", W0 + 12, W0 + 11]));
  });

  it("no anchor for T_FREEZE blocks: a freeze at window F + 1 (F = W0 + T_FREEZE + 1), then the late anchor's PurchasesVoided at its block + 1 — moved or dropped freezes fail", async () => {
    const F = W0 + T_FREEZE + 1;
    const windows = Math.ceil((T_FREEZE + 402) / 200) * 200;   // 늦은 앵커가 실린 에폭 다음 에폭 끝까지
    const late = { posted: -1 };
    const plan = (p: WorldProducer, w: number) => {
      if (w - 1 === F - 100) p.purchase({ block: w - 1, roomId: 1, buyer: owner(1), tiers: [0, 0, 0] });
      if (late.posted >= 0 && w - 1 === late.posted) p.voidRange({ block: late.posted, fromId: "0", toId: "1" });
    };
    const after = (p: WorldProducer, w: number) => {
      if (w > F && late.posted < 0) late.posted = p.anchor(w + 1).postedBlock;   // 동결 뒤 첫 에폭 끝에 늦은 앵커 (구매 0을 무효로)
    };
    const run = (tamper?: Tamper) => {
      late.posted = -1;
      return oneRoom(windows, plan, { after, ...(tamper ? { tamper } : {}) });
    };
    const honest = run();
    const entries = honest.logs.flatMap((l) => l.windows).flatMap((x) => x.rooms[0]!.inputs.map((input, i) => ({ window: x.window, type: input.type, link: x.rooms[0]!.links[i]! })));
    assert.deepEqual(entries.map((e) => [e.type, e.window]), [["purchase", F - 99], ["freeze", F + 1], ["voidPurchase", late.posted + 1]]);
    assert.deepEqual(entries[1]!.link, { block: F, logIndex: -1, pos: 0, txHash: null });
    const ok = await verifyEpochs(honest.bundle);
    assert.ok(ok.ok, JSON.stringify(ok.checks.filter((c) => !c.ok)));

    const moved = await verifyEpochs(run((w, x) => {
      const room = x.get(1) ?? [];
      if (w === F + 1) x.set(1, room.filter((i) => i.input.type !== "freeze"));
      if (w === F + 2) x.set(1, [{ roomId: 1, input: { type: "freeze", reason: "FREEZE" }, link: link(F, -1) }, ...room]);
      return x;
    }).bundle);
    assert.deepEqual(moved.linkage.mismatches.map((m) => m.code), ["WINDOW"], "동결을 한 윈도 늦추면 (돌던 곡괭이가 더 캔다)");
    const dropped = await verifyEpochs(run((w, x) => {
      if (w === F + 1) x.set(1, (x.get(1) ?? []).filter((i) => i.input.type !== "freeze"));
      return x;
    }).bundle);
    assert.deepEqual(dropped.linkage.mismatches.map((m) => m.code), ["MISSING"]);
  });
});
