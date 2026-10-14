// RpcLedgerSource (개정 7 체인 값을 RPC에서 바로, B5): 가짜 JSON-RPC(fake-ledger-chain.ts)로 PikitLedger view·RootPosted·AnnouncerChanged·
// 블록·ERC-1271을 읽어 verifyLedger가 통과하고, 두 곳이 다르면 ChainDisagreement(실패 검사), 429는 오류(전송 — CLI 종료 3)로 끝난다.
import assert from "node:assert/strict";
import { before, describe, it } from "node:test";
import { encodeAbiParameters, getAddress, HttpRequestError, keccak256, toHex, type Hex } from "viem";
import {
  AGREE_CHECK, ChainDisagreement, ERC6492_SUFFIX, rootCheckName, RpcLedgerSource, unwrapErc6492, verifyLedger, type LedgerChainFile, type LedgerVerifyReport, type RpcLedgerSourceOptions,
} from "../src/index.js";
import { FakeLedgerChain } from "./fake-ledger-chain.js";
import { LEDGER, produce, SMART, W0, type Fixture } from "./ledger-fixture.js";

let F: Fixture;
before(async () => { F = await produce(); });

const options = (fake: FakeLedgerChain | ((url: string) => FakeLedgerChain), o: Partial<RpcLedgerSourceOptions> = {}): RpcLedgerSourceOptions => ({
  rpcUrls: ["https://rpc.example/KEY"], ledger: getAddress(LEDGER),
  transport: (url) => (typeof fake === "function" ? fake(url) : fake).transport, maxRps: 100_000, backoffBaseMs: 1, ...o,
});
const verify = (src: RpcLedgerSource, files = F.files) => verifyLedger({
  world: F.world, catalogs: F.catalogs, chain: src, read: async (p) => p.map((x) => files.get(x) ?? null), trust: { contract: LEDGER }, range: { last: "latest", from: "genesis" },
});
const failed = (r: LedgerVerifyReport) => r.checks.filter((c) => !c.ok).map((c) => c.name);
const tweak = (f: (c: LedgerChainFile) => void) => { const c = structuredClone(F.chain); f(c); return new FakeLedgerChain(c); };

describe("RpcLedgerSource: PikitLedger values straight from the RPC", () => {
  it("world(): immutables, the finalized pin, rootCount and the ANNOUNCE key at the pin (all lower-cased)", async () => {
    const w = await new RpcLedgerSource(options(new FakeLedgerChain(F.chain))).world();
    assert.deepEqual(
      [w.chainId, w.ledger, w.genesisBlock, w.seedRoot, w.rulesHash, w.ledgerHash, w.roomIds, w.epochBlocks, w.announcerDelay, w.finalized, w.rootCount, w.announcerFromWindow],
      [143, LEDGER, W0, F.chain.seedRoot, F.chain.rulesHash, F.chain.ledgerHash, [1], 200, 20, F.chain.finalized, 3, F.chain.announcerChanges[1]!.fromWindow],
    );
    assert.equal(w.announcer, F.chain.announcerChanges[1]!.next);
  });

  it("root(k) = rootAt(k) + the RootPosted log of that one block: the 10 fields, tx and block", async () => {
    const fake = new FakeLedgerChain(F.chain);
    const src = new RpcLedgerSource(options(fake));
    for (const r of F.chain.roots) assert.deepEqual(await src.root(r.rootIndex), r);
    const logReads = fake.requests.filter((x) => x.method === "eth_getLogs").map((x) => (x.params[0] as { fromBlock: string; toBlock: string }));
    assert.ok(logReads.every((x) => x.fromBlock === x.toBlock), "one block per root — no scan from genesis");
  });

  it("verifyLedger over RPC (two endpoints cross-checked): every root passes; block reads ≈ one per two windows + the list windows' own blocks", async () => {
    const fake = new FakeLedgerChain(F.chain);
    const r = await verify(new RpcLedgerSource(options(fake, { rpcUrls: ["https://a.example/KEY", "https://b.example/KEY"] })));
    assert.deepEqual(failed(r), []);
    assert.equal(r.rootResults.length, 3);
    const reads = fake.blockReads();
    const windows = 4 * 200;
    assert.ok(reads.length / 2 < windows * 0.85, `block reads per endpoint ${reads.length / 2} for ${windows} windows`);
  });

  it("a getLogs range limit is halved and remembered", async () => {
    const fake = new FakeLedgerChain(F.chain);
    fake.maxRange = 25;
    const src = new RpcLedgerSource(options(fake));
    assert.deepEqual((await src.announcerChanges(W0 - 200, W0 + 300)).map((a) => a.next), F.chain.announcerChanges.map((a) => a.next));
    assert.ok(fake.rangeRejected > 0);
    assert.ok(src.logChunk <= 25);
  });

  it("two endpoints that disagree on a root → ChainDisagreement, reported as the failed agreement check (not a crash)", async () => {
    const honest = new FakeLedgerChain(F.chain);
    const liar = tweak((c) => { c.roots[1]!.payoutsRoot = keccak256(toHex("forged")); });
    const src = new RpcLedgerSource(options((url) => (url.includes("b.example") ? liar : honest), { rpcUrls: ["https://a.example/KEY", "https://b.example/KEY"] }));
    await assert.rejects(src.root(1), ChainDisagreement);
    const r = await verify(new RpcLedgerSource(options((url) => (url.includes("b.example") ? liar : honest), { rpcUrls: ["https://a.example/KEY", "https://b.example/KEY"] })));
    assert.deepEqual(failed(r), [AGREE_CHECK]);
    assert.match(r.disagreement!.what, /^root 1 \(rootAt \+ RootPosted\)/);
  });

  it("ERC-1271: the wallet's isValidSignature at erc1271Block decides; another block, a revert or no code is invalid", async () => {
    const src = new RpcLedgerSource(options(new FakeLedgerChain(F.chain)));
    const a = F.chain.erc1271[0]!;
    assert.equal(await src.isValidSignature(SMART, a.hash, a.signature, a.blockNumber), true);
    assert.equal(await src.isValidSignature(SMART, a.hash, a.signature, a.blockNumber + 1), false);
    assert.equal(await src.isValidSignature("0x00000000000000000000000000000000000000ee", a.hash, a.signature, a.blockNumber), false);
    await assert.rejects(src.isValidSignature(SMART, a.hash, a.signature, F.chain.finalized + 1), /after the finalized block/);
    const r = await verify(new RpcLedgerSource(options(tweak((c) => { c.erc1271[0]!.valid = false; }))));
    assert.deepEqual(failed(r), [rootCheckName(0, "auth")]);
  });

  it("ERC-6492: a wrapped signature is checked with its inner signature", () => {
    const inner = "0x1234" as Hex;
    const wrapped = `${encodeAbiParameters([{ type: "address" }, { type: "bytes" }, { type: "bytes" }], [getAddress(SMART), "0xdeadbeef", inner])}${ERC6492_SUFFIX}`;
    assert.equal(unwrapErc6492(wrapped), inner);
    assert.equal(unwrapErc6492("0xABCD"), "0xabcd");
  });

  it("HTTP 429 beyond the retry budget is thrown (a transport error for the CLI, exit 3) — not a failed check", async () => {
    const fake = new FakeLedgerChain(F.chain);
    fake.fail429 = 1_000;
    const src = new RpcLedgerSource(options(fake, { maxRetries: 2, backoffBaseMs: 1, retryBudgetMs: 50 }));
    await assert.rejects(verify(src), (e: unknown) => e instanceof HttpRequestError || (e as { cause?: unknown }).cause instanceof HttpRequestError || /429|Too Many/.test(String((e as Error).message)));
  });
});
