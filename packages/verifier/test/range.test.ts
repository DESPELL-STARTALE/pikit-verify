// resolveRange: --epoch latest · --from-snapshot E|latest · --purchase id를 체인 앵커(anchorCount·anchorAt 이진 탐색)로 정한다.
import assert from "node:assert/strict";
import { before, describe, it } from "node:test";
import { SETTLE_STALL } from "@pikit/protocol";
import { DAY_WINDOWS, resolveRange, StaticChainSource, VerifyRangeError } from "../src/index.js";
import { buildDemoBundle, EPOCHS, W0, type DemoBundle } from "./demo-bundle.js";

type Json = Record<string, any>;

describe("resolveRange", () => {
  let demo: DemoBundle;
  let chain: StaticChainSource;
  before(() => {
    demo = buildDemoBundle();
    chain = new StaticChainSource(demo.chain);
  });

  it("--epoch latest = the epoch of the last anchor; without a start flag it replays from genesis", async () => {
    assert.deepEqual(await resolveRange(chain, { epoch: "latest" }), { firstEpoch: 1, lastEpoch: EPOCHS, snapshotEpoch: null, note: "from genesis" });
  });

  it("--from-snapshot E needs an anchor at the end of E; otherwise it names the nearest anchored epoch", async () => {
    assert.deepEqual((await resolveRange(chain, { epoch: 7, fromSnapshot: 3 })).firstEpoch, 4);
    const sparse = new StaticChainSource({ ...(structuredClone(demo.chain) as Json), anchors: (demo.chain as Json).anchors.filter((a: Json) => a.anchorIndex % 2 === 0) });
    await assert.rejects(resolveRange(sparse, { epoch: 7, fromSnapshot: 4 }), (e: unknown) => e instanceof VerifyRangeError && /epoch 4 is not anchored.*nearest anchored epoch before it is 3/.test(e.message));
    await assert.rejects(resolveRange(chain, { epoch: 3, fromSnapshot: 3 }), /not before the last epoch/);
  });

  it("--from-snapshot latest = the last anchored epoch a day + SETTLE_STALL before the end (genesis when the world is younger)", async () => {
    const young = await resolveRange(chain, { epoch: "latest", fromSnapshot: "latest" });
    assert.deepEqual([young.firstEpoch, young.snapshotEpoch], [1, null]);
    // 하루 넘게 산 세계를 흉내: 앵커들의 블록을 하루만큼 늘린다 (에폭 끝 = W0 + 200e − 1)
    const day = DAY_WINDOWS / 200;
    const anchors = Array.from({ length: 2 * day }, (_, i) => ({ anchorIndex: i, postedBlock: W0 + 200 * (i + 1) + 29, processedThrough: W0 + 200 * (i + 1) - 2 }));
    const long = { head: async () => ({ finalized: W0 + 400 * day + 100, anchorCount: anchors.length, genesisBlock: W0 }), anchorAt: async (i: number) => anchors[i]! };
    const r = await resolveRange(long as never, { epoch: "latest", fromSnapshot: "latest" });
    const lastWindow = W0 + 200 * 2 * day - 1;
    assert.equal(r.lastEpoch, 2 * day);
    assert.ok(W0 + 200 * r.snapshotEpoch! - 1 <= lastWindow - DAY_WINDOWS - SETTLE_STALL, "at least a day + SETTLE_STALL before the end");
    assert.ok(W0 + 200 * (r.snapshotEpoch! + 1) - 1 > lastWindow - DAY_WINDOWS - SETTLE_STALL, "and the latest such epoch");
  });

  it("--purchase id starts from the last anchored snapshot before its block", async () => {
    const r = await resolveRange(chain, { epoch: "latest", purchase: demo.voidOverPurchaseId });
    assert.deepEqual([r.firstEpoch, r.lastEpoch, r.snapshotEpoch], [4, EPOCHS, 3], r.note);
    const first = await resolveRange(chain, { epoch: "latest", purchase: "0" });
    assert.equal(first.snapshotEpoch, null);
    await assert.rejects(resolveRange(chain, { epoch: "latest", purchase: "99999" }), /not on chain/);
  });
});
