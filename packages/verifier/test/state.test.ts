// 감시자 이어 받기 (리뷰 rev6 H-1, D163): nextVerifyState · openFromWindow · resolveRange maxEpochs · verifyEpochs resume 검사.
import assert from "node:assert/strict";
import { before, describe, it } from "node:test";
import { epochWindows, SETTLE_STALL } from "@pikit/protocol";
import {
  nextVerifyState, openFromWindow, resolveRange, StaticChainSource, VERIFY_STATE_SCHEMA_ID, verifyEpochs, VerifyState, type EpochVerifyReport,
} from "../src/index.js";
import { buildDemoBundle, EPOCHS, SHOP, W0, type DemoBundle } from "./demo-bundle.js";

type Json = Record<string, any>;
const ROOT = (i: number) => `0x${(i + 1).toString(16).padStart(64, "0")}`;

/** 앵커가 에폭 5개마다(1,000블록) 있는 범위의 성공 보고서 (verifyEpochs가 내는 칸만). */
function report(o: { firstEpoch: number; lastEpoch: number; head: number; unsettled?: number[]; start?: number | null }): EpochVerifyReport {
  const anchors = [];
  for (let e = 5; e <= o.lastEpoch; e += 5) {
    if (e < o.firstEpoch) continue;
    const i = e / 5 - 1;
    anchors.push({ anchorIndex: i, processedThrough: epochWindows(e, W0).last - 1, roomsStateRoot: { expected: ROOT(i), actual: ROOT(i) } });
  }
  const s = o.start ?? null;
  return {
    ok: true, firstEpoch: o.firstEpoch, epochs: o.lastEpoch, windows: { first: epochWindows(o.firstEpoch, W0).first, last: epochWindows(o.lastEpoch, W0).last },
    start: s === null ? null : { epoch: s, processedWindow: epochWindows(s, W0).last, anchorIndex: s / 5 - 1, roomsStateRoot: ROOT(s / 5 - 1) },
    engineVersionHash: `0x${"ee".repeat(32)}`,
    trust: { chainId: 143, shop: SHOP, shopPinned: true, fairness: null, seedRoot: `0x${"5e".repeat(32)}`, genesisBlock: W0, engineVersionHash: `0x${"ee".repeat(32)}`, rooms: [] },
    checks: [], anchors, batches: [], stateHashes: { rooms: [] }, head: `0x${"00".repeat(32)}`, replayedThrough: epochWindows(o.lastEpoch, W0).last, payouts: 0,
    settlements: { checked: 0, matched: 0, mismatches: [], skipped: 0, unsettled: (o.unsettled ?? []).map((w) => ({ window: w }) as never) },
    linkage: { checked: 0, matched: 0, pending: 0, mismatches: [], problems: [], carryOut: [] }, chainThroughBlock: o.head,
  } as unknown as EpochVerifyReport;
}

describe("nextVerifyState (H-1): where the next run must start", () => {
  it("open = head − SETTLE_STALL: resume = the last verified anchor at or before it, so every pickaxe that could still be unpaid is replayed again", () => {
    const head = epochWindows(100, W0).last + 150;
    const s = nextVerifyState(report({ firstEpoch: 51, lastEpoch: 100, head, start: 50 }));
    assert.equal(s.schema, VERIFY_STATE_SCHEMA_ID);
    assert.equal(s.openFromWindow, head - SETTLE_STALL);
    assert.equal(s.lastEpoch, 100);
    assert.ok(s.resume && epochWindows(s.resume.epoch, W0).last <= s.openFromWindow - 1, "the resume snapshot is before every open pickaxe end");
    assert.ok(epochWindows(s.resume!.epoch + 5, W0).last > s.openFromWindow - 1, "and the latest such anchor");
    assert.deepEqual(s.resume, { epoch: 70, anchorIndex: 13, roomsStateRoot: ROOT(13) });
  });

  it("an unsettled pickaxe (deadline not yet passed, e.g. a void over) pulls the resume point back before its end window", () => {
    const head = epochWindows(100, W0).last + 150;
    const early = epochWindows(57, W0).first + 3;
    const s = nextVerifyState(report({ firstEpoch: 51, lastEpoch: 100, head, start: 50, unsettled: [early] }));
    assert.equal(s.openFromWindow, early);
    assert.deepEqual(s.resume, { epoch: 55, anchorIndex: 10, roomsStateRoot: ROOT(10) });
  });

  it("nothing in the range is final yet → keep this run's start anchor; from genesis → null", () => {
    const head = epochWindows(53, W0).last + 150;   // 끝에서 30분 안에 시작 스냅숏이 있다
    assert.deepEqual(nextVerifyState(report({ firstEpoch: 51, lastEpoch: 53, head, start: 50 })).resume, { epoch: 50, anchorIndex: 9, roomsStateRoot: ROOT(9) });
    assert.equal(nextVerifyState(report({ firstEpoch: 1, lastEpoch: 3, head: epochWindows(3, W0).last + 10 })).resume, null);
  });

  it("a failed run never produces a state (the next run starts from the same place and fails again)", () => {
    const r = report({ firstEpoch: 51, lastEpoch: 100, head: 999_999, start: 50 });
    r.ok = false;
    assert.throws(() => nextVerifyState(r), /the run failed/);
  });

  it("openFromWindow = min(head − SETTLE_STALL, replayed end + 1, unsettled ends); the state schema is strict", () => {
    assert.equal(openFromWindow({ chainThroughBlock: 50_000, replayedThrough: 30_000, settlements: { unsettled: [] } } as never), 30_001);
    assert.equal(openFromWindow({ chainThroughBlock: 50_000, replayedThrough: 49_000, settlements: { unsettled: [{ window: 40_000 }] } } as never), 40_000);
    const s = nextVerifyState(report({ firstEpoch: 51, lastEpoch: 100, head: epochWindows(100, W0).last + 150, start: 50 }));
    assert.throws(() => VerifyState.parse({ ...s, extra: 1 }));
    assert.deepEqual(VerifyState.parse(JSON.parse(JSON.stringify(s))), s);
  });
});

describe("resolveRange maxEpochs (catch-up in steps)", () => {
  let demo: DemoBundle;
  before(() => { demo = buildDemoBundle(); });

  it("caps the range at the last anchored epoch within n epochs of the start", async () => {
    const chain = new StaticChainSource(demo.chain);
    const r = await resolveRange(chain, { epoch: "latest", maxEpochs: 3 });
    assert.deepEqual([r.firstEpoch, r.lastEpoch], [1, 3]);
    assert.match(r.note, /capped at 3 epochs: through epoch 3 of 7/);
    const sparse = new StaticChainSource({ ...(structuredClone(demo.chain) as Json), anchors: (demo.chain as Json).anchors.filter((a: Json) => a.anchorIndex !== 4) });
    assert.equal((await resolveRange(sparse, { epoch: "latest", fromSnapshot: 2, maxEpochs: 3 })).lastEpoch, 4, "epoch 5 has no anchor → the anchored epoch 4");
    assert.equal((await resolveRange(chain, { epoch: "latest", maxEpochs: 50 })).lastEpoch, EPOCHS, "no cap needed");
  });
});

describe("verifyEpochs resume (verify-state)", () => {
  let demo: DemoBundle;
  before(() => { demo = buildDemoBundle(); });
  const bundle = (resume: { anchorIndex: number; roomsStateRoot: string }) => ({
    world: demo.world, catalogs: demo.catalogs, epochs: demo.epochs.slice(3), chain: new StaticChainSource(demo.chain), firstEpoch: 4, snapshot: structuredClone(demo.snapshots[2]), resume,
  });

  it("the start anchor must be exactly the anchor the state names (index and roomsStateRoot)", async () => {
    const a = (demo.chain as Json).anchors.find((x: Json) => x.anchorIndex === 2);
    const ok = await verifyEpochs(bundle({ anchorIndex: 2, roomsStateRoot: a.roomsStateRoot }));
    assert.deepEqual(ok.checks.filter((c) => !c.ok), []);
    assert.equal(ok.start?.roomsStateRoot, a.roomsStateRoot);
    const bad = await verifyEpochs(bundle({ anchorIndex: 2, roomsStateRoot: `0x${"0b".repeat(32)}` }));
    assert.deepEqual(bad.checks.filter((c) => !c.ok).map((c) => c.name), ["start anchor 2 = the anchor the previous run resumed from (verify-state)"]);
  });
});
