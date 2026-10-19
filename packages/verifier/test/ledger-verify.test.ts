// 개정 7 공개 검증 verifyLedger (B5, 계획 §2.11·§4.2): 정직한 묶음은 루트 3개를 모두 통과, 위조마다 정확히 그 검사가 실패한다.
// 묶음은 ledger-fixture.ts (A3 ledgerWindow로 만든 game-server 흉내 — 방 1 · 지갑 4(스마트 지갑 1) · 에폭 4 · 루트 3 · ANNOUNCE 교체 1번).
import assert from "node:assert/strict";
import { before, describe, it } from "node:test";
import { keccak256 } from "@pikit/protocol";
import {
  announcerKeyAt, LEDGER_CHECK, LEDGER_VERSION_HASH, nextVerifyState, resumePoint, rootCheckName, START_CHECK, StaticLedgerSource, verifyLedger, VerifyRangeError, VerifyState,
  type LedgerChainFile, type LedgerChainSource, type LedgerVerifyInput, type LedgerVerifyReport,
} from "../src/index.js";
import { player } from "./ledger/helpers.js";
import { ANNOUNCE2, LEDGER, mutateJson, produce, ROTATE_FROM, SMART, W0, type Fixture } from "./ledger-fixture.js";

let F: Fixture;
before(async () => { F = await produce(); });

interface RunOpts {
  files?: ReadonlyMap<string, Uint8Array>;
  chain?: LedgerChainFile;
  source?: LedgerChainSource;
  world?: unknown;
  range?: LedgerVerifyInput["range"];
  trust?: LedgerVerifyInput["trust"] | null;
  resume?: LedgerVerifyInput["resume"];
}

function run(o: RunOpts = {}): Promise<LedgerVerifyReport> {
  const files = o.files ?? F.files;
  return verifyLedger({
    world: o.world ?? F.world, catalogs: F.catalogs, chain: o.source ?? new StaticLedgerSource(o.chain ?? F.chain),
    read: async (paths) => paths.map((p) => files.get(p) ?? null),
    ...(o.trust === null ? {} : { trust: o.trust ?? { contract: LEDGER } }),
    range: o.range ?? { last: "latest", from: "genesis" },
    ...(o.resume ? { resume: o.resume } : {}),
  });
}

const failed = (r: LedgerVerifyReport) => r.checks.filter((c) => !c.ok).map((c) => c.name);
const chainWith = (f: (c: LedgerChainFile) => void): LedgerChainFile => {
  const c = structuredClone(F.chain);
  f(c);
  return c;
};

describe("verifyLedger: honest world (3 roots, ANNOUNCE rotation, a smart-wallet session)", () => {
  it("from genesis: every root passes, every check ✔, the ledger summary shows the scripted rejections and the ERC-1271 session", async () => {
    const r = await run();
    assert.deepEqual(failed(r), []);
    assert.equal(r.ok, true);
    assert.deepEqual(r.roots, { first: 0, last: 2, latest: 2 });
    assert.deepEqual(r.epochs, { first: 1, last: 4, latest: 4 });
    assert.deepEqual(r.rootResults.map((x) => [x.rootIndex, x.fromEpoch, x.epoch, x.ok]), [[0, 1, 1, true], [1, 2, 2, true], [2, 3, 4, true]]);
    for (const reason of ["TARGET_MISMATCH", "INSUFFICIENT_CREDITS", "SEQ_USED", "GRANT_ALREADY"]) assert.ok((r.ledger.rejected[reason] ?? 0) >= 1, reason);
    assert.ok(r.ledger.applied > 50, `applied ${r.ledger.applied}`);
    assert.ok(r.ledger.erc1271Sessions >= 1, "the smart-wallet session is checked over RPC (once per root whose files carry it)");
    assert.ok(r.linkage.checked > 50 && r.linkage.matched === r.linkage.checked, JSON.stringify(r.linkage));
    assert.ok(r.ledger.payouts > 20, `payouts ${r.ledger.payouts}`);
    assert.ok(r.batches >= 1, "a board batch completed and was regenerated from seeds + block hashes");
    assert.equal(r.verified?.rootIndex, 2);
    assert.equal(r.trust.ledgerHash, LEDGER_VERSION_HASH);
    assert.equal(r.start, null);
    // 스마트 지갑도 샀다 (ERC-1271 세션이 장부에 받아들여졌다)
    assert.ok(F.decisions.some((d) => d.includes(":BUY:APPLIED:")) && F.decisions.length > 60);
    assert.ok(r.checks.some((c) => c.name === rootCheckName(1, "announce") && c.ok), "the rotation inside root 1 is followed window by window");
  });

  it("(rules 10) report only: each room's jackpot pool at the last verified boundary (replayed engine state), contributed = pool + paid", async () => {
    const r = await run();
    assert.deepEqual(r.jackpotPools.map((j) => j.roomId), r.trust.rooms.map((x) => x.roomId));
    for (const j of r.jackpotPools) {
      assert.equal(j.contributedMilli, j.poolMilli + j.paidMilli, `room ${j.roomId}`);
      assert.ok(j.wins >= 0 && j.cracksInRange <= j.wins && Number.isSafeInteger(j.poolMilli));
    }
  });

  it("--root latest alone: root 2 from the boundary of root 1 (snapshot + leaves file)", async () => {
    const r = await run({ range: { last: "latest" } });
    assert.deepEqual(failed(r), []);
    assert.deepEqual(r.start, { root: 1, epoch: 2, throughWindow: W0 + 399 });
    assert.deepEqual(r.rootResults.map((x) => x.rootIndex), [2]);
    for (const c of Object.values(START_CHECK).filter((n) => n !== START_CHECK.resume)) assert.ok(r.checks.some((x) => x.name === c && x.ok), c);
  });

  it("--root 0 alone is from genesis; --from-snapshot 0 --root 2 verifies roots 1 and 2; --max-roots caps", async () => {
    assert.deepEqual((await run({ range: { last: 0 } })).rootResults.map((x) => x.rootIndex), [0]);
    assert.deepEqual((await run({ range: { last: 2, from: 0 } })).rootResults.map((x) => x.rootIndex), [1, 2]);
    const capped = await run({ range: { last: "latest", from: "genesis", maxRoots: 2 } });
    assert.deepEqual([capped.ok, capped.rootResults.map((x) => x.rootIndex), capped.roots], [true, [0, 1], { first: 0, last: 1, latest: 2 }]);
    await assert.rejects(run({ range: { last: 3 } }), VerifyRangeError);
    await assert.rejects(run({ range: { last: 1, from: 1 } }), VerifyRangeError);
  });

  it("resume through 3 roots: state after root 0 → roots 1…2 → up to date (no file read, state unchanged)", async () => {
    const first = await run({ range: { last: 0, from: "genesis" } });
    const s0 = nextVerifyState(first);
    assert.deepEqual([s0.lastRoot, s0.epoch, s0.contract, s0.schema], [0, 1, LEDGER, "pikit.verify-state/v2"]);
    const second = await run({ range: { last: "latest" }, resume: resumePoint(VerifyState.parse(JSON.parse(JSON.stringify(s0)))) });
    assert.deepEqual(failed(second), []);
    assert.deepEqual(second.rootResults.map((x) => x.rootIndex), [1, 2]);
    assert.ok(second.checks.some((c) => c.name === START_CHECK.resume && c.ok));
    const s2 = nextVerifyState(second);
    assert.equal(s2.lastRoot, 2);
    let reads = 0;
    const third = await verifyLedger({
      world: F.world, catalogs: F.catalogs, chain: new StaticLedgerSource(F.chain), trust: { contract: LEDGER }, range: { last: "latest" }, resume: resumePoint(s2),
      read: async (p) => { reads += p.length; return p.map(() => null); },
    });
    assert.deepEqual([third.ok, third.upToDate, reads, third.roots], [true, true, 0, { first: 3, last: 2, latest: 2 }]);
    assert.throws(() => nextVerifyState(third), /verified no root/);
  });

  it("a state whose root fields differ from the chain fails at the start (another world)", async () => {
    const s0 = nextVerifyState(await run({ range: { last: 0, from: "genesis" } }));
    const r = await run({ range: { last: "latest" }, resume: { ...resumePoint(s0), ledgerRoot: keccak256(new TextEncoder().encode("x")) } });
    assert.deepEqual(failed(r), [START_CHECK.resume]);
    assert.throws(() => nextVerifyState(r), /failed/);
  });
});

describe("verifyLedger: forgeries fail exactly where they should", () => {
  it("a leaf balance changed in the leaves file → leaves file ✘ and the root's dataHash ✘", async () => {
    const files = mutateJson(F.files, "ledger/leaves/0.json", (x) => { x.leaves[0].balanceMilli = String(BigInt(x.leaves[0].balanceMilli) + 1000n); });
    const r = await run({ files });
    assert.deepEqual(failed(r), [rootCheckName(0, "leaves"), rootCheckName(0, "fields")]);
    assert.deepEqual(r.rootResults[0]!.mismatchedFields, ["dataHash"]);
    assert.equal(r.verified, null);
  });

  it("list entries reordered → the list does not match its signed entriesHash", async () => {
    const files = mutateJson(F.files, "ledger/1.json", (x) => {
      const l = x.lists.find((y: any) => y.entries.length > 1);
      l.entries.reverse();
      l.decisions.reverse();
    });
    assert.deepEqual(failed(await run({ files })), [rootCheckName(0, "entries")]);
  });

  it("a session signature from the wrong wallet → its intents are SESSION_MISSING in the replay (decisions ✘)", async () => {
    const files = mutateJson(F.files, "ledger/1.json", (x) => {
      const eoa = x.sessions.filter((s: any) => s.erc1271Block === null);
      eoa[0].signature = eoa[1].signature;
    });
    const r = await run({ files });
    assert.ok(failed(r).includes(rootCheckName(0, "decisions")), failed(r).join(" | "));
    assert.match(r.checks.find((c) => c.name === rootCheckName(0, "decisions"))!.detail!, /file APPLIED#\d+ vs replay SESSION_MISSING/);
  });

  it("a public file missing → files ✘ (no silent skip), the path and its root are reported", async () => {
    const files = new Map(F.files);
    files.delete("ledger/2.json");
    const r = await run({ files });
    assert.deepEqual(failed(r), [rootCheckName(1, "files")]);
    assert.deepEqual(r.missing.map((m) => [m.path, m.rootIndex]), [["ledger/2.json", 1]]);
    assert.equal(r.verified?.rootIndex, 0, "root 0 passed before the failure");
  });

  it("lists signed by another key than the window's ANNOUNCE key → list signatures ✘", async () => {
    const other = player(77).wallet.address;
    const r = await run({ chain: chainWith((c) => { c.announcerChanges[0]!.next = other; c.announcerChanges[1]!.previous = other; }) });
    assert.deepEqual(failed(r), [rootCheckName(0, "announce")]);
    // 교체가 늦게 효력을 얻었다고 체인이 말하면, 그 사이 새 키로 서명한 명단이 틀린 키다
    const late = await run({ chain: chainWith((c) => { c.announcerChanges[1]!.fromWindow = ROTATE_FROM + 60; }), range: { last: 1, from: 0 } });
    assert.deepEqual(failed(late), [rootCheckName(1, "announce")]);
    assert.match(late.checks.find((c) => !c.ok)!.detail!, new RegExp(`signed by ${ANNOUNCE2.address}`));
  });

  it("the second GRANT of the same UTC day marked APPLIED in the file → decisions ✘ (GRANT_ALREADY in the replay)", async () => {
    const files = mutateJson(F.files, "ledger/1.json", (x) => {
      const l = x.lists.find((y: any) => y.window === W0 + 2);
      l.decisions[0] = { status: "APPLIED", reason: null, purchaseId: null };
    });
    const r = await run({ files });
    assert.ok(failed(r).includes(rootCheckName(0, "decisions")));
    assert.match(r.checks.find((c) => c.name === rootCheckName(0, "decisions"))!.detail!, new RegExp(`list ${W0 + 2} entry 0: file APPLIED vs replay GRANT_ALREADY`));
  });

  it("a root posted with another payoutsRoot or supply (payout amounts changed) → root fields ✘ naming them", async () => {
    const r = await run({ chain: chainWith((c) => { c.roots[1]!.payoutsRoot = keccak256(new TextEncoder().encode("p")); c.roots[1]!.supplyMilli = "1"; }) });
    assert.deepEqual(failed(r), [rootCheckName(1, "fields")]);
    assert.deepEqual(r.rootResults[1]!.mismatchedFields, ["payoutsRoot", "supplyMilli"]);
  });

  it("the smart wallet's ERC-1271 check fails at erc1271Block → intent auth ✘", async () => {
    const r = await run({ chain: chainWith((c) => { c.erc1271[0]!.valid = false; }) });
    assert.deepEqual(failed(r), [rootCheckName(0, "auth")]);
    assert.match(r.checks.find((c) => !c.ok)!.detail!, new RegExp(`session ${SMART}`));
  });

  it("a list window's block timestamp in the file differs from the chain → list timestamps ✘", async () => {
    const lf = JSON.parse(new TextDecoder().decode(F.files.get("ledger/1.json")!));
    const w = lf.lists[3].window as number;
    const r = await run({ chain: chainWith((c) => { c.blockTimestamps[String(w)] = c.blockTimestamps[String(w)]! + 86_400; }) });
    assert.deepEqual(failed(r), [rootCheckName(0, "timestamps")]);
  });

  it("an input dropped from the input log → inputs = signed lists ✘ (MISSING) and the hash chain no longer reaches the root", async () => {
    const files = mutateJson(F.files, "1.json", (x) => { x.windows.shift(); });
    const r = await run({ files });
    assert.deepEqual(failed(r), [rootCheckName(0, "log"), rootCheckName(0, "linkage"), rootCheckName(0, "snapshot"), rootCheckName(0, "fields")]);
    assert.match(r.checks.find((c) => c.name === rootCheckName(0, "linkage"))!.detail!, /MISSING/);
    assert.ok(r.rootResults[0]!.mismatchedFields.includes("inputLogRoot"));
  });

  it("a tampered boundary snapshot → the next run cannot start from it (start snapshot ✘); this run's root catches it too", async () => {
    const files = mutateJson(F.files, "snapshots/2.json", (x) => { x.world.rooms[0].state.tick += 1; });
    assert.deepEqual(failed(await run({ files, range: { last: 2 } })), [START_CHECK.snapshot]);
    assert.deepEqual(failed(await run({ files, range: { last: 1 } })), [rootCheckName(1, "snapshot"), rootCheckName(1, "fields")]);
  });

  it("a list outside the file's epoch range cannot sneak in: an extra list window → the ledger file does not parse", async () => {
    const files = mutateJson(F.files, "ledger/1.json", (x) => { x.lists.push({ ...x.lists[0], window: W0 + 999 }); });
    assert.deepEqual(failed(await run({ files })), [rootCheckName(0, "formats")]);
  });
});

describe("verifyLedger: trust roots", () => {
  const unreadable: LedgerChainSource = new Proxy({} as LedgerChainSource, { get: () => () => { throw new Error("the chain must not be read"); } });

  it("world.shop ≠ the pinned PikitLedger → fails before any chain read", async () => {
    const r = await run({ source: unreadable, trust: { contract: "0x00000000000000000000000000000000000000ff" } });
    assert.deepEqual(failed(r), [LEDGER_CHECK.pinned]);
  });

  it("world.json without the ledger rules hash (a rev 6 world) or another one → fails before the chain", async () => {
    const { ledgerVersionHash: _, ...rev6 } = F.world;
    assert.deepEqual(failed(await run({ source: unreadable, world: rev6 })), [LEDGER_CHECK.ledgerBuild]);
  });

  it("chain ledgerHash ≠ this build's LEDGER_VERSION_HASH, chain rulesHash ≠ catalog ‖ engine, world ≠ chain → each fails", async () => {
    const other = keccak256(new TextEncoder().encode("other"));
    assert.deepEqual(failed(await run({ chain: chainWith((c) => { c.ledgerHash = other; }) })), [LEDGER_CHECK.chainLedgerHash]);
    assert.deepEqual(failed(await run({ chain: chainWith((c) => { c.rulesHash = other; }) })), [LEDGER_CHECK.chainRulesHash]);
    assert.deepEqual(failed(await run({ chain: chainWith((c) => { c.genesisBlock = W0 + 1; }) })), [LEDGER_CHECK.world]);
    assert.deepEqual(failed(await run({ chain: chainWith((c) => { c.epochBlocks = 100; }) })), [LEDGER_CHECK.epochBlocks]);
  });

  it("--trust pins chainId, ledgerHash and rulesHash: each must equal the chain", async () => {
    const other = keccak256(new TextEncoder().encode("other"));
    assert.equal((await run({ trust: { contract: LEDGER, chainId: 143, ledgerHash: LEDGER_VERSION_HASH, rulesHash: F.chain.rulesHash } })).ok, true);
    assert.deepEqual(failed(await run({ trust: { contract: LEDGER, chainId: 10143 } })), ["trust: pinned chainId = chain"]);
    assert.deepEqual(failed(await run({ trust: { contract: LEDGER, ledgerHash: other } })), ["trust: pinned ledgerHash = chain ledgerHash"]);
    assert.deepEqual(failed(await run({ trust: { contract: LEDGER, rulesHash: other } })), ["trust: pinned rulesHash = chain rulesHash"]);
  });

  it("a chain without roots is a range error, not a pass", async () => {
    await assert.rejects(run({ chain: chainWith((c) => { c.roots = []; }) }), /no root on chain yet/);
  });
});

describe("announcerKeyAt (D197: the key for window w = next of the last AnnouncerChanged with fromWindow ≤ w)", () => {
  const A = "0x000000000000000000000000000000000000000a";
  const B = "0x000000000000000000000000000000000000000b";
  const C = "0x000000000000000000000000000000000000000c";
  it("no change in the scanned blocks → the base key; changes → previous before, next from fromWindow on", () => {
    assert.equal(announcerKeyAt([], A, 500), A);
    const ch = [{ previous: A, next: B, fromWindow: 120, blockNumber: 100, logIndex: 0 }, { previous: B, next: C, fromWindow: 140, blockNumber: 120, logIndex: 3 }];
    assert.deepEqual([119, 120, 139, 140, 999].map((w) => announcerKeyAt(ch, "0x00000000000000000000000000000000000000ee", w)), [A, B, B, C, C]);
  });
});
