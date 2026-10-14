// A1 고정 벡터(packages/protocol/test/fixtures/ledger-vectors.json, D196)를 장부 규칙으로: 명단 모양·ANNOUNCE 서명·세션·결정·잎·지급 잎·dataHash 순서.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";
import { ledgerPrivateKeySigner, signWindowList, type LedgerLeaf, type LedgerListEntry, type PayoutLeaf, type SignedWindowList } from "@pikit/protocol";
import type { EnginePayout } from "@pikit/engine";
import {
  applyPayouts, applyWindowList, authenticateEntries, checkListStructure, computeEntriesHash, contextDomain, LedgerState, ledgerRootFields, listSigner,
  payoutLeafOf, rootDataFiles, type LedgerContext,
} from "../../src/index.js";
import { brief, loadNormal } from "./helpers.js";

type Json = Record<string, any>;
const V: Json = JSON.parse(readFileSync(fileURLToPath(new URL("../../../../protocol/test/fixtures/ledger-vectors.json", import.meta.url)), "utf8"));

const ctx: LedgerContext = {
  chainId: V.domain.chainId, ledger: V.domain.verifyingContract,
  rooms: [{ roomId: 1, createdWindow: 12_000_000, catalog: loadNormal(), rulesHash: V.buyIntent.message.rulesHash }],
};
const grantEntry: LedgerListEntry = { kind: "GRANT", ref: V.grant.ref, grant: V.grant.message };
const buyEntry: LedgerListEntry = { kind: "BUY", ref: V.buyIntent.digest, intent: V.buyIntent.message, signature: V.buyIntent.signature };
const cancelEntry: LedgerListEntry = { kind: "CANCEL", ref: V.cancelQueue.digest, intent: V.cancelQueue.message, signature: V.cancelQueue.signature };
const vectorList: SignedWindowList = {
  ...V.windowList.message, signer: V.addresses.announce, signature: V.windowList.signature, entries: [grantEntry, buyEntry, cancelEntry],
};
const session = { session: V.ledgerSession.message, signature: V.ledgerSession.signature, erc1271Block: null };
/** 블록 timestamp: GRANT 날(20739) 01:00 UTC — 세션 기한(1,792,000,000) 안. */
const TS = V.grant.message.day * 86_400 + 3600;

describe("ledger vectors (A1 fixture)", () => {
  it("the vector list is well formed and signed by the vector announce key", async () => {
    checkListStructure(ctx, vectorList);
    assert.equal(computeEntriesHash(ctx, vectorList.entries), V.entriesHash);
    assert.equal(await listSigner(ctx, vectorList), V.addresses.announce);
  });

  it("golden decisions: GRANT applied · BUY for window 12345678 is TARGET_MISMATCH in list 12345679 · CANCEL applied", async () => {
    const s = new LedgerState();
    const auth = await authenticateEntries(ctx, vectorList.entries, [session]);
    assert.deepEqual(auth, [null, { signatureOk: true, sessionExpiresAt: 1_792_000_000n }, { signatureOk: true, sessionExpiresAt: 1_792_000_000n }]);
    const app = applyWindowList(s, ctx, vectorList, auth, TS);
    assert.deepEqual(app.decisions.map(brief), ["APPLIED", "TARGET_MISMATCH", "APPLIED"]);
    assert.deepEqual(app.cancels.map((c) => [c.items, c.blockNumber, c.logIndex, c.txHash]), [[["10496", "10499"], 12_345_678, 2, V.cancelQueue.digest]]);
    assert.deepEqual(s.leaves(), [{
      wallet: V.addresses.wallet, currency: 0, balanceMilli: "20000000", openStakeMilli: "0", withdrawTotalMilli: "0", lastSeq: "8", lastGrantDay: 20739,
    }]);
  });

  it("golden: the BUY in its own window (list re-signed with the vector announce key) — ×1+×5+×20 = 26,000 cr > 20,000 granted → INSUFFICIENT_CREDITS, seq 7 consumed", async () => {
    const announce = ledgerPrivateKeySigner(V.keys.announce);
    const entries = [grantEntry, buyEntry];
    const head = { window: 12_345_678, entriesHash: computeEntriesHash(ctx, entries), count: 2 };
    const list: SignedWindowList = { ...head, signer: announce.address, signature: await signWindowList(announce.sign, contextDomain(ctx), head), entries };
    checkListStructure(ctx, list);
    const s = new LedgerState();
    const app = applyWindowList(s, ctx, list, await authenticateEntries(ctx, entries, [session]), TS);
    assert.deepEqual(app.decisions.map(brief), ["APPLIED", "INSUFFICIENT_CREDITS"]);
    assert.equal(s.get(V.addresses.wallet).lastSeq, 7n);
    // 같은 지갑의 취소(seq 8)는 다음 창에서 받는다 → 고정 루트
    const next = applyWindowList(s, ctx, vectorList, await authenticateEntries(ctx, vectorList.entries, [session]), TS + 1);
    assert.deepEqual(next.decisions.map(brief), ["GRANT_ALREADY", "TARGET_MISMATCH", "APPLIED"]);
    assert.equal(s.root(), "0x3ab7e41c600388bbd3f5911692a6959b067e8bbfc8d3df6f6f4d879ad21ea19b");
  });

  it("vector leaves → state → the vector ledgerRoot and supply (order-independent)", () => {
    const leaves: LedgerLeaf[] = V.leaves.map((x: Json) => x.leaf);
    const s = LedgerState.fromLeaves([...leaves].reverse(), "43");
    assert.equal(s.root(), V.ledgerRoot);
    assert.equal(s.supplyMilli().toString(), V.supplyMilli);
    assert.deepEqual(s.leaves(), [...leaves].sort((a, b) => (a.wallet < b.wallet ? -1 : 1)));
  });

  it("engine payouts → vector payout leaves and payoutsRoot", () => {
    const vl: PayoutLeaf[] = V.payouts.map((x: Json) => x.leaf);
    const payouts: EnginePayout[] = vl.map((l) => ({
      key: `${l.purchaseId}:${l.itemIndex}`, owner: l.owner, tier: 0, priceMilli: Number(l.priceMilli), kind: l.kind, cause: l.cause,
      payoutMilli: Number(l.payoutMilli), overMilli: Number(l.overMilli), window: l.window, tick: 0,
    }));
    assert.deepEqual(payouts.map(payoutLeafOf), vl);
    const s = new LedgerState();
    s.account(V.addresses.wallet).openStakeMilli = 6_000_000n;
    const leaves = applyPayouts(s, payouts.map((payout) => ({ roomId: 1, payout })));
    const fields = ledgerRootFields({
      epoch: 60, genesisBlock: 1000, seed: `0x${"11".repeat(32)}`, roomsStateRoot: `0x${"22".repeat(32)}`, inputLogRoot: `0x${"33".repeat(32)}`,
      boardBatchRoot: `0x${"44".repeat(32)}`, state: s, payouts: leaves, fromEpoch: 59, rootIndex: 0,
      files: new Map((V.dataFiles as { path: string; sha256: string }[]).map((f) => [f.path, f.sha256])),
    });
    assert.equal(fields.payoutsRoot, V.payoutsRoot);
    assert.equal(fields.dataHash, V.dataHash);
    assert.equal(fields.throughWindow, 1000 + 60 * 200 - 1);
    assert.equal(fields.supplyMilli, String(1_000_000 + 4_500_000 + 12_345));
  });

  it("dataHash file order = rootDataPaths (epoch files and ledger files alternate, then the snapshot, then the leaves); a missing file throws", () => {
    const files = new Map((V.dataFiles as { path: string; sha256: string }[]).map((f) => [f.path, f.sha256]));
    assert.deepEqual(rootDataFiles(59, 60, 0, files).map((f) => f.path), V.dataFiles.map((f: Json) => f.path));
    files.delete("ledger/60.json");
    assert.throws(() => rootDataFiles(59, 60, 0, files), /missing files ledger\/60\.json/);
  });
});
