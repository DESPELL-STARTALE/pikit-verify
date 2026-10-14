// 명세 20 장부 형식 (D196): 고정 벡터(test/fixtures/ledger-vectors.json) + 독립 재계산 + 서명 왕복 + 머클 증명 + 파일·메시지 모양.
// 벡터 값이 바뀌면 ledgerHash가 바뀐다(새 세계) — A2 forge 시험·웹·검증기가 같은 값을 써야 한다.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import { concat, encodeAbiParameters, keccak256 as viemKeccak, toBytes } from "viem";
import {
  BUY_INTENT_TYPE_STRING, BuyIntentMessage, CANCEL_QUEUE_TYPE_STRING, CancelQueueMessage, dataHash, entriesHash, entryHash, GRANT_MAX_MILLI,
  GrantMessage, grantRef, hashBuyIntent, hashCancelQueue, hashLedgerSession, hashWindowList, IntentRequest, IntentResultMsg, IntentView,
  isRootBoundaryEpoch, itemIdOf, LEDGER_SESSION_TYPE_STRING, ledgerDomain, LedgerDecision, LedgerEpochFile, LedgerLeaf, ledgerLeafHash,
  ledgerLeafProof, LedgerLeavesFile, ledgerPrivateKeySigner, ledgerRoot, LedgerRootRecord, ledgerSupplyMilli, listEntryKey, ListMsg, MeView,
  PayoutLeaf, payoutLeafHash, payoutsRoot, recoverBuyIntentSigner, recoverCancelQueueSigner, recoverLedgerSessionSigner, recoverWindowListSigner,
  rootDataPaths, rootThroughWindow, RootView, LatestRootView, INTENT_CODE_MESSAGES, IntentRefusalCode, DailyGrantStatus, sha256Hex, SignedWindowList, signBuyIntent, signWindowList, utcDayOf, verifyLedgerLeafProof,
  verifyMerkleProof, WINDOW_LIST_TYPE_STRING, WindowListMessage, WorldManifest, ZERO_BYTES32,
  type Hex32, type LedgerListEntry,
} from "../src/index.js";

const V = JSON.parse(readFileSync(new URL("../../test/fixtures/ledger-vectors.json", import.meta.url), "utf8"));
const domain = ledgerDomain(V.domain.verifyingContract, V.domain.chainId);
const k = (s: string) => viemKeccak(toBytes(s));

/** EIP-712 digest를 viem typed-data 없이 손으로 (Solidity `_hashTypedDataV4(keccak256(abi.encode(TYPEHASH, ...)))`와 같은 길). */
function eip712Digest(structHash: Hex32): Hex32 {
  return viemKeccak(concat(["0x1901", V.domain.separator, structHash]));
}
const packedHash = (types: string[], values: readonly (number | bigint)[]) =>
  viemKeccak(values.length === 0 ? "0x" : concat(values.map((v, i) => encodeAbiParameters([{ type: types[i]! }], [v as never]))));

describe("ledger EIP-712 (domain PIKIT-LEDGER)", () => {
  it("domain separator and type hashes match the vectors and hand computation", () => {
    const sep = viemKeccak(encodeAbiParameters(
      [{ type: "bytes32" }, { type: "bytes32" }, { type: "bytes32" }, { type: "uint256" }, { type: "address" }],
      [k("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)"), k("PIKIT-LEDGER"), k("1"), 143n, V.domain.verifyingContract],
    ));
    assert.equal(sep, V.domain.separator);
    assert.equal(k(BUY_INTENT_TYPE_STRING), V.typeHashes.BuyIntent);
    assert.equal(k(CANCEL_QUEUE_TYPE_STRING), V.typeHashes.CancelQueue);
    assert.equal(k(LEDGER_SESSION_TYPE_STRING), V.typeHashes.LedgerSession);
    assert.equal(k(WINDOW_LIST_TYPE_STRING), V.typeHashes.WindowList);
  });

  it("BuyIntent digest = vector = hand-encoded struct hash", () => {
    const m = BuyIntentMessage.parse(V.buyIntent.message);
    const struct = viemKeccak(encodeAbiParameters(
      [{ type: "bytes32" }, { type: "address" }, { type: "address" }, { type: "uint32" }, { type: "bytes32" }, { type: "bytes32" }, { type: "uint64" }, { type: "uint64" }],
      [V.typeHashes.BuyIntent, m.wallet as Hex32, m.sessionKey as Hex32, m.roomId, m.rulesHash as Hex32,
        packedHash(m.tiers.map(() => "uint8"), m.tiers), BigInt(m.seq), BigInt(m.targetWindow)],
    ));
    assert.equal(hashBuyIntent(domain, m), V.buyIntent.digest);
    assert.equal(eip712Digest(struct), V.buyIntent.digest);
  });

  it("CancelQueue digest = vector = hand-encoded struct hash", () => {
    const m = CancelQueueMessage.parse(V.cancelQueue.message);
    assert.deepEqual(m.items, [itemIdOf(41, 0).toString(), itemIdOf(41, 3).toString()]);
    const struct = viemKeccak(encodeAbiParameters(
      [{ type: "bytes32" }, { type: "address" }, { type: "address" }, { type: "uint32" }, { type: "bytes32" }, { type: "uint64" }, { type: "uint64" }],
      [V.typeHashes.CancelQueue, m.wallet as Hex32, m.sessionKey as Hex32, m.roomId,
        packedHash(m.items.map(() => "uint256"), m.items.map(BigInt)), BigInt(m.seq), BigInt(m.targetWindow)],
    ));
    assert.equal(hashCancelQueue(domain, m), V.cancelQueue.digest);
    assert.equal(eip712Digest(struct), V.cancelQueue.digest);
  });

  it("LedgerSession and WindowList digests = vectors = hand-encoded", () => {
    const s = V.ledgerSession.message;
    const sStruct = viemKeccak(encodeAbiParameters(
      [{ type: "bytes32" }, { type: "address" }, { type: "address" }, { type: "uint64" }],
      [V.typeHashes.LedgerSession, s.wallet, s.sessionKey, BigInt(s.expiresAt)],
    ));
    assert.equal(hashLedgerSession(domain, s), V.ledgerSession.digest);
    assert.equal(eip712Digest(sStruct), V.ledgerSession.digest);
    const l = V.windowList.message;
    const lStruct = viemKeccak(encodeAbiParameters(
      [{ type: "bytes32" }, { type: "uint64" }, { type: "bytes32" }, { type: "uint32" }],
      [V.typeHashes.WindowList, BigInt(l.window), l.entriesHash, l.count],
    ));
    assert.equal(hashWindowList(domain, l), V.windowList.digest);
    assert.equal(eip712Digest(lStruct), V.windowList.digest);
  });

  it("signatures are deterministic and recover the right keys", async () => {
    const session = ledgerPrivateKeySigner(V.keys.session);
    const announce = ledgerPrivateKeySigner(V.keys.announce);
    assert.equal(await signBuyIntent(session.sign, domain, V.buyIntent.message), V.buyIntent.signature);
    assert.equal(await signWindowList(announce.sign, domain, V.windowList.message), V.windowList.signature);
    assert.equal(await recoverBuyIntentSigner(domain, V.buyIntent.message, V.buyIntent.signature), V.addresses.session);
    assert.equal(await recoverCancelQueueSigner(domain, V.cancelQueue.message, V.cancelQueue.signature), V.addresses.session);
    assert.equal(await recoverLedgerSessionSigner(domain, V.ledgerSession.message, V.ledgerSession.signature), V.addresses.wallet);
    assert.equal(await recoverWindowListSigner(domain, V.windowList.message, V.windowList.signature), V.addresses.announce);
  });

  it("a different domain (chain, contract) or field changes the digest and the recovered signer", async () => {
    const testnet = ledgerDomain(V.domain.verifyingContract, 10143);
    const other = ledgerDomain("0x1ed6e00000000000000000000000000000000008", 143);
    assert.notEqual(hashBuyIntent(testnet, V.buyIntent.message), V.buyIntent.digest);
    assert.notEqual(hashBuyIntent(other, V.buyIntent.message), V.buyIntent.digest);
    const moved = { ...V.buyIntent.message, targetWindow: V.buyIntent.message.targetWindow + 1 };
    assert.notEqual(hashBuyIntent(domain, moved), V.buyIntent.digest);
    assert.notEqual(await recoverBuyIntentSigner(domain, moved, V.buyIntent.signature), V.addresses.session);
    const reordered = { ...V.buyIntent.message, tiers: [4, 2, 0] };
    assert.notEqual(hashBuyIntent(domain, reordered), V.buyIntent.digest);
  });

  it("message shapes reject bad values", () => {
    const b = V.buyIntent.message;
    assert.equal(BuyIntentMessage.safeParse({ ...b, tiers: [] }).success, false);
    assert.equal(BuyIntentMessage.safeParse({ ...b, tiers: Array(11).fill(0) }).success, false);
    assert.equal(BuyIntentMessage.safeParse({ ...b, tiers: [32] }).success, false);
    assert.equal(BuyIntentMessage.safeParse({ ...b, seq: "18446744073709551616" }).success, false, "uint64 overflow");
    assert.equal(BuyIntentMessage.safeParse({ ...b, wallet: b.wallet.toUpperCase().replace("0X", "0x") }).success, false, "lowercase only");
    assert.equal(BuyIntentMessage.safeParse({ ...b, extra: 1 }).success, false, "strict");
    assert.equal(CancelQueueMessage.safeParse({ ...V.cancelQueue.message, items: [] }).success, false);
    assert.equal(WindowListMessage.safeParse({ ...V.windowList.message, count: -1 }).success, false);
    assert.equal(GrantMessage.safeParse({ ...V.grant.message, reason: "WEEKLY" }).success, false);
    assert.throws(() => ledgerDomain(V.domain.verifyingContract, 0));
  });
});

describe("ledger list entries", () => {
  it("grantRef = keccak256(abi.encode(string tag, address, uint128, uint32, uint8))", () => {
    const g = V.grant.message;
    const ref = viemKeccak(encodeAbiParameters(
      [{ type: "string" }, { type: "address" }, { type: "uint128" }, { type: "uint32" }, { type: "uint8" }],
      ["PIKIT/grant/v1", g.wallet, BigInt(g.amountMilli), g.day, 1],
    ));
    assert.equal(grantRef(g), V.grant.ref);
    assert.equal(ref, V.grant.ref);
    assert.notEqual(grantRef({ ...g, day: g.day + 1 }), V.grant.ref);
  });

  it("entryHash and entriesHash match vectors and the packed concatenation", () => {
    for (const e of V.entries) {
      assert.equal(entryHash(e.kind, e.roomId, e.ref), e.entryHash);
      const kind = { BUY: 0, CANCEL: 1, GRANT: 2 }[e.kind as "BUY"]!;
      assert.equal(viemKeccak(encodeAbiParameters([{ type: "uint8" }, { type: "uint32" }, { type: "bytes32" }], [kind, e.roomId, e.ref])), e.entryHash);
    }
    const hashes = V.entries.map((e: { entryHash: Hex32 }) => e.entryHash);
    assert.equal(entriesHash(hashes), V.entriesHash);
    assert.equal(viemKeccak(concat(hashes)), V.entriesHash);
    assert.equal(entriesHash([]), V.emptyEntriesHash);
    assert.equal(V.emptyEntriesHash, viemKeccak("0x"));
    assert.notEqual(entriesHash([hashes[1], hashes[0], hashes[2]]), V.entriesHash, "order matters");
    assert.equal(V.windowList.message.entriesHash, V.entriesHash);
    assert.throws(() => entryHash("GRANT", 1, V.grant.ref), /roomId must be 0/);
  });

  it("listEntryKey picks (kind, roomId, ref); GRANT room is 0", () => {
    const entries: LedgerListEntry[] = [
      { kind: "GRANT", ref: V.grant.ref, grant: V.grant.message },
      { kind: "BUY", ref: V.buyIntent.digest, intent: V.buyIntent.message, signature: V.buyIntent.signature },
      { kind: "CANCEL", ref: V.cancelQueue.digest, intent: V.cancelQueue.message, signature: V.cancelQueue.signature },
    ];
    const hashes = entries.map((e) => { const x = listEntryKey(e); return entryHash(x.kind, x.roomId, x.ref); });
    assert.equal(entriesHash(hashes), V.entriesHash);
  });
});

describe("ledger leaves and roots", () => {
  it("wallet leaf = double keccak of abi.encode, vectors match", () => {
    for (const { leaf, hash } of V.leaves) {
      const inner = viemKeccak(encodeAbiParameters(
        [{ type: "address" }, { type: "uint8" }, { type: "uint128" }, { type: "uint128" }, { type: "uint128" }, { type: "uint64" }, { type: "uint32" }],
        [leaf.wallet, leaf.currency, BigInt(leaf.balanceMilli), BigInt(leaf.openStakeMilli), BigInt(leaf.withdrawTotalMilli), BigInt(leaf.lastSeq), leaf.lastGrantDay],
      ));
      assert.equal(viemKeccak(inner), hash);
      assert.equal(ledgerLeafHash(leaf), hash);
    }
  });

  it("ledgerRoot is order-independent, proofs verify (OZ MerkleProof compatible), supply sums", () => {
    const leaves: LedgerLeaf[] = V.leaves.map((x: { leaf: LedgerLeaf }) => x.leaf);
    assert.equal(ledgerRoot(leaves), V.ledgerRoot);
    assert.equal(ledgerRoot([...leaves].reverse()), V.ledgerRoot);
    assert.equal(ledgerRoot([]), ZERO_BYTES32);
    assert.deepEqual(ledgerLeafProof(leaves, leaves[0]!), V.leafProof0);
    for (const l of leaves) {
      const proof = ledgerLeafProof(leaves, l);
      assert.ok(verifyLedgerLeafProof(V.ledgerRoot, l, proof));
      assert.ok(verifyMerkleProof(V.ledgerRoot, ledgerLeafHash(l), proof));
    }
    const forged = { ...leaves[0]!, balanceMilli: "17500001" };
    assert.equal(verifyLedgerLeafProof(V.ledgerRoot, forged, V.leafProof0), false);
    assert.equal(ledgerSupplyMilli(leaves).toString(), V.supplyMilli);
    assert.equal(LedgerLeaf.safeParse({ ...leaves[0]!, currency: 1 }).success, false, "free mode is currency 0 only");
    assert.equal(LedgerLeaf.safeParse({ ...leaves[0]!, balanceMilli: (1n << 128n).toString() }).success, false);
  });

  it("payout leaf = double keccak of abi.encode, payoutsRoot vector", () => {
    for (const { leaf, hash } of V.payouts) {
      const inner = viemKeccak(encodeAbiParameters(
        [{ type: "uint256" }, { type: "uint8" }, { type: "address" }, { type: "uint8" }, { type: "uint8" }, { type: "uint128" }, { type: "uint128" }, { type: "uint128" }, { type: "uint64" }],
        [BigInt(leaf.purchaseId), leaf.itemIndex, leaf.owner, leaf.kind === "REWARD" ? 0 : 1,
          ["END", "ABNORMAL_END", "CANCEL", "OVERFLOW", "QUEUE_REFUND"].indexOf(leaf.cause), BigInt(leaf.priceMilli), BigInt(leaf.payoutMilli), BigInt(leaf.overMilli), BigInt(leaf.window)],
      ));
      assert.equal(viemKeccak(inner), hash);
      assert.equal(payoutLeafHash(leaf), hash);
    }
    assert.equal(payoutsRoot(V.payouts.map((x: { leaf: PayoutLeaf }) => x.leaf)), V.payoutsRoot);
    assert.equal(payoutsRoot([]), ZERO_BYTES32);
    assert.equal(PayoutLeaf.safeParse({ ...V.payouts[0].leaf, cause: "VOID" }).success, false);
  });

  it("dataHash = keccak(Σ keccak(path) ‖ sha256) in rootDataPaths order", () => {
    const paths = rootDataPaths(59, 60, 0);
    assert.deepEqual(paths, ["59.json", "ledger/59.json", "60.json", "ledger/60.json", "snapshots/60.json", "ledger/leaves/0.json"]);
    assert.deepEqual(V.dataFiles.map((f: { path: string }) => f.path), paths);
    for (const f of V.dataFiles) assert.equal(f.sha256, sha256Hex(new TextEncoder().encode(`file:${f.path}`)));
    const manual = viemKeccak(concat(V.dataFiles.flatMap((f: { path: string; sha256: Hex32 }) => [k(f.path), f.sha256])));
    assert.equal(dataHash(V.dataFiles), V.dataHash);
    assert.equal(manual, V.dataHash);
    assert.notEqual(dataHash([...V.dataFiles].reverse()), V.dataHash, "order matters");
    assert.equal(dataHash([]), viemKeccak("0x"));
    assert.throws(() => dataHash([{ path: "/abs.json", sha256: ZERO_BYTES32 }]));
    assert.throws(() => rootDataPaths(3, 2, 0));
    assert.throws(() => rootDataPaths(0, 2, 0));
  });

  it("time helpers: through window, boundary epochs, UTC day", () => {
    assert.equal(rootThroughWindow(60, 1000), 1000 + 60 * 200 - 1);
    assert.equal(rootThroughWindow(1, 1000), 1199);
    assert.throws(() => rootThroughWindow(0, 1000));
    assert.ok(isRootBoundaryEpoch(60));
    assert.ok(!isRootBoundaryEpoch(59));
    assert.ok(isRootBoundaryEpoch(2, 2));
    assert.ok(!isRootBoundaryEpoch(0));
    assert.equal(utcDayOf(0), 0);
    assert.equal(utcDayOf(86_399), 0);
    assert.equal(utcDayOf(86_400), 1);
    assert.equal(utcDayOf(1_791_849_600), 20739);   // 2026-10-13 00:00 UTC
    assert.equal(GRANT_MAX_MILLI, 2_400_000_000n);
  });
});

// ── 파일·메시지 모양 ─────────────────────────────────────────────────────────

function sampleList() {
  return {
    window: V.windowList.message.window,
    entriesHash: V.entriesHash,
    count: 3,
    signer: V.addresses.announce,
    signature: V.windowList.signature,
    entries: [
      { kind: "GRANT", ref: V.grant.ref, grant: V.grant.message },
      { kind: "BUY", ref: V.buyIntent.digest, intent: V.buyIntent.message, signature: V.buyIntent.signature },
      { kind: "CANCEL", ref: V.cancelQueue.digest, intent: V.cancelQueue.message, signature: V.cancelQueue.signature },
    ],
  };
}

describe("ledger file shapes", () => {
  it("SignedWindowList round-trips and checks count", () => {
    const l = sampleList();
    const parsed = SignedWindowList.parse(JSON.parse(JSON.stringify(l)));
    assert.deepEqual(parsed, l);
    assert.equal(SignedWindowList.safeParse({ ...l, count: 2 }).success, false);
    assert.equal(SignedWindowList.safeParse({ ...l, count: 0, entries: [] }).success, false, "empty lists are not signed");
    assert.equal(SignedWindowList.safeParse({ ...l, entries: [{ ...l.entries[1], kind: "GRANT" }, l.entries[0], l.entries[2]] }).success, false);
  });

  it("LedgerEpochFile round-trips; decisions, ordering and timestamps are checked", () => {
    const list = { ...sampleList(), decisions: [
      { status: "APPLIED", reason: null, purchaseId: null },
      { status: "APPLIED", reason: null, purchaseId: "42" },
      { status: "REJECTED", reason: "SEQ_USED", purchaseId: null },
    ] };
    const file = {
      schema: "pikit.ledger/v1", chainId: 143, ledger: V.domain.verifyingContract, epoch: 61728,
      firstWindow: 12345600, lastWindow: 12345799,
      sessions: [{ session: V.ledgerSession.message, signature: V.ledgerSession.signature, erc1271Block: null }],
      lists: [list],
      blockTimestamps: { [String(list.window)]: 1_791_892_900 },
    };
    const parsed = LedgerEpochFile.parse(JSON.parse(JSON.stringify(file)));
    assert.deepEqual(parsed, file);
    assert.equal(LedgerEpochFile.safeParse({ ...file, blockTimestamps: {} }).success, false, "timestamp required for each list");
    assert.equal(LedgerEpochFile.safeParse({ ...file, lists: [list, list] }).success, false, "strictly increasing windows");
    assert.equal(LedgerEpochFile.safeParse({ ...file, lists: [{ ...list, window: 1 }] }).success, false, "window in range");
    assert.equal(LedgerEpochFile.safeParse({ ...file, sessions: [file.sessions[0], file.sessions[0]] }).success, false, "unique sessions");
    assert.equal(LedgerEpochFile.safeParse({ ...file, lists: [{ ...list, decisions: list.decisions.slice(0, 2) }] }).success, false, "one decision per entry");
    const grantWithId = { ...list, decisions: [{ status: "APPLIED", reason: null, purchaseId: "1" }, ...list.decisions.slice(1)] };
    assert.equal(LedgerEpochFile.safeParse({ ...file, lists: [grantWithId] }).success, false, "only BUY has purchaseId");
    assert.equal(LedgerDecision.safeParse({ status: "REJECTED", reason: null, purchaseId: null }).success, false);
    assert.equal(LedgerDecision.safeParse({ status: "APPLIED", reason: "SEQ_USED", purchaseId: null }).success, false);
  });

  it("LedgerLeavesFile round-trips and wants ascending unique wallets", () => {
    const leaves = V.leaves.map((x: { leaf: LedgerLeaf }) => x.leaf).sort((a: LedgerLeaf, b: LedgerLeaf) => (a.wallet < b.wallet ? -1 : 1));
    const file = {
      schema: "pikit.ledger-leaves/v1", chainId: 143, ledger: V.domain.verifyingContract, rootIndex: 0, epoch: 60,
      throughWindow: rootThroughWindow(60, 1000), nextPurchaseId: "43", ledgerRoot: V.ledgerRoot, supplyMilli: V.supplyMilli, leaves,
    };
    assert.deepEqual(LedgerLeavesFile.parse(JSON.parse(JSON.stringify(file))), file);
    assert.equal(ledgerRoot(file.leaves), file.ledgerRoot);
    assert.equal(LedgerLeavesFile.safeParse({ ...file, leaves: [...leaves].reverse() }).success, false);
    assert.equal(LedgerLeavesFile.safeParse({ ...file, leaves: [leaves[0], leaves[0]] }).success, false);
  });

  it("LedgerRootRecord / RootView carry the 10 root fields", () => {
    const fields = {
      epoch: 60, seed: `0x${"ab".repeat(32)}`, throughWindow: rootThroughWindow(60, 1000), roomsStateRoot: ZERO_BYTES32, inputLogRoot: ZERO_BYTES32,
      boardBatchRoot: ZERO_BYTES32, ledgerRoot: V.ledgerRoot, payoutsRoot: V.payoutsRoot, supplyMilli: V.supplyMilli, dataHash: V.dataHash,
    };
    assert.equal(Object.keys(fields).length, 10);
    LedgerRootRecord.parse({ ...fields, rootIndex: 0, postedBlock: 13_000, txHash: ZERO_BYTES32 });
    RootView.parse({ ...fields, rootIndex: 0, status: "READY", txHash: null, postedBlock: null });
    assert.equal(RootView.safeParse({ ...fields, rootIndex: 0, status: "DONE", txHash: null, postedBlock: null }).success, false);
  });

  it("WorldManifest takes an optional ledgerVersionHash (additive)", () => {
    const base = { schema: "pikit.world/v1", chainId: 143, shop: V.domain.verifyingContract, genesisBlock: 1000, seedRoot: ZERO_BYTES32,
      engineVersionHash: ZERO_BYTES32, rooms: [{ roomId: 1, createdWindow: 1000, catalogHash: ZERO_BYTES32 }] };
    WorldManifest.parse(base);
    WorldManifest.parse({ ...base, ledgerVersionHash: V.ledgerRoot });
  });
});

describe("ledger REST and room messages", () => {
  it("IntentRequest BUY/CANCEL with optional session grant", () => {
    const buy = { kind: "BUY", intent: V.buyIntent.message, signature: V.buyIntent.signature,
      session: { session: V.ledgerSession.message, signature: V.ledgerSession.signature } };
    assert.deepEqual(IntentRequest.parse(JSON.parse(JSON.stringify(buy))), buy);
    IntentRequest.parse({ kind: "CANCEL", intent: V.cancelQueue.message, signature: V.cancelQueue.signature });
    assert.equal(IntentRequest.safeParse({ kind: "CANCEL", intent: V.buyIntent.message, signature: V.buyIntent.signature }).success, false);
    assert.equal(IntentRequest.safeParse({ kind: "GRANT", intent: V.buyIntent.message, signature: V.buyIntent.signature }).success, false);
    // 1271 허가 서명은 65바이트가 아닐 수 있다
    IntentRequest.parse({ ...buy, session: { session: V.ledgerSession.message, signature: `0x${"ab".repeat(200)}` } });
  });

  it("IntentView and IntentResultMsg", () => {
    IntentView.parse({ digest: V.buyIntent.digest, kind: "BUY", wallet: V.addresses.wallet, seq: "7", targetWindow: 12345678, status: "APPLIED",
      reason: null, purchaseId: "42", listWindow: 12345678, listIndex: 1, createdAt: "2026-10-13T00:00:00.000Z" });
    IntentResultMsg.parse({ digest: V.buyIntent.digest, kind: "BUY", status: "REJECTED", reason: "INSUFFICIENT_CREDITS", purchaseId: null, listWindow: 1, listIndex: 0 });
    assert.equal(IntentResultMsg.safeParse({ digest: V.buyIntent.digest, kind: "BUY", status: "REJECTED", reason: null, purchaseId: null, listWindow: 1, listIndex: 0 }).success, false);
  });

  it("ListMsg: signed list carries entries; empty list has no signature", () => {
    const entries = V.entries.map((e: { kind: string; roomId: number; ref: string }) => ({ kind: e.kind, roomId: e.roomId, ref: e.ref }));
    const msg = { window: V.windowList.message.window, count: 3, entriesHash: V.entriesHash, signer: V.addresses.announce, signature: V.windowList.signature, entries };
    ListMsg.parse(msg);
    assert.equal(entriesHash(entries.map((e: { kind: "BUY"; roomId: number; ref: Hex32 }) => entryHash(e.kind, e.roomId, e.ref))), msg.entriesHash);
    ListMsg.parse({ window: 5, count: 0, entriesHash: null, signer: null, signature: null, entries: [] });
    assert.equal(ListMsg.safeParse({ window: 5, count: 0, entriesHash: V.entriesHash, signer: null, signature: null, entries: [] }).success, false);
    assert.equal(ListMsg.safeParse({ ...msg, count: 2 }).success, false);
  });

  it("MeView accepts the additive ledger fields", () => {
    const me = {
      address: V.addresses.wallet, playerShortId: "ab12cd", nickname: null,
      balances: { promoMilli: "0", blockNumber: 0 }, pending: { settlingMilli: 0, activeEarnedMilli: 0 },
      activePickaxes: [], queues: [], sessionKey: null, nextIntentNonce: "0", batch: null,
    };
    const parsedBase = MeView.safeParse(me);
    if (!parsedBase.success) return assert.fail(`base MeView: ${parsedBase.error.message}`);
    MeView.parse({ ...me,
      ledger: { balanceMilli: "1000", openStakeMilli: "0", reservedMilli: "0", lastSeq: "3", pendingSeqMax: null, lastGrantDay: 20739, updatedWindow: 12345678 },
      ledgerSession: { sessionKey: V.addresses.session, expiresAt: "1792000000", smartWallet: false },
    });
  });
});

describe("ledger vectors are self-consistent with GrantMessage bounds", () => {
  it("grant amount bound is a rule (A3), not a shape — the shape only caps uint128", () => {
    assert.ok(GrantMessage.safeParse({ ...V.grant.message, amountMilli: (GRANT_MAX_MILLI + 1n).toString() }).success);
    assert.equal(GrantMessage.safeParse({ ...V.grant.message, amountMilli: (1n << 128n).toString() }).success, false);
  });
});

describe("B3 follow-up additions (D202)", () => {
  it("IntentRefusalCode has ROOM_WINDOW_FULL and UNKNOWN_ROOM with fixed messages; every code has a message", () => {
    for (const c of IntentRefusalCode.options) assert.ok(INTENT_CODE_MESSAGES[c], c);
    assert.match(INTENT_CODE_MESSAGES.ROOM_WINDOW_FULL, /100 inputs/);
    IntentRefusalCode.parse("UNKNOWN_ROOM");
    DailyGrantStatus.parse("PENDING");
    DailyGrantStatus.parse("LISTED");
  });

  it("LatestRootView: null root before the first root, freshness and domain", () => {
    const ledger = { address: V.domain.verifyingContract, chainId: 143, genesisBlock: 1000, rootEveryEpochs: 60 };
    LatestRootView.parse({ root: null, freshness: { closedThrough: null, sinceWindow: 999, ageBlocks: null, maxAgeBlocks: 15000, salesOpen: false }, ledger });
    const root = {
      epoch: 60, seed: `0x${"ab".repeat(32)}`, throughWindow: rootThroughWindow(60, 1000), roomsStateRoot: ZERO_BYTES32, inputLogRoot: ZERO_BYTES32,
      boardBatchRoot: ZERO_BYTES32, ledgerRoot: V.ledgerRoot, payoutsRoot: V.payoutsRoot, supplyMilli: V.supplyMilli, dataHash: V.dataHash,
      rootIndex: 0, status: "POSTED", txHash: ZERO_BYTES32, postedBlock: 13_300,
    };
    LatestRootView.parse({ root, freshness: { closedThrough: 13_500, sinceWindow: root.throughWindow, ageBlocks: 501, maxAgeBlocks: 15000, salesOpen: true }, ledger });
    LatestRootView.parse({ root: null, freshness: { closedThrough: 5, sinceWindow: -1, ageBlocks: 6, maxAgeBlocks: 15000, salesOpen: true }, ledger: { ...ledger, genesisBlock: 0 } });
    assert.equal(LatestRootView.safeParse({ root: null, freshness: { closedThrough: null, sinceWindow: 999, ageBlocks: null, maxAgeBlocks: 1, salesOpen: false }, ledger: { ...ledger, extra: 1 } }).success, false);
  });
});
