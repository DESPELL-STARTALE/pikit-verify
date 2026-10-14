// 해시·서명 형식의 테스트 벡터. 컨트랙트(Foundry)·웹·감시 봇이 같은 값을 내야 한다 — 값이 바뀌면 INTERFACES §9에 적는다.
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { describe, it } from "node:test";
import { encodeAbiParameters, keccak256 as viemKeccak, recoverMessageAddress, toBytes } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import {
  boardBatchHash, canonicalHash, chainInputLog, compareInputLinks, createSessionSiweMessage, epochLogEntries, EpochInputLog, epochOf, epochWindows,
  hashCancelIntent, hashCreditIntent, hashSessionGrant, hmacSha256, idValueLeaf, INPUT_LOG_GENESIS_HEAD, inputEntryHash, InputLink, inputLinkKey, itemIdOf, itemKeyFromId,
  itemKeyOf, merkleProof, merkleRoot, onchainRulesHash, parseItemKey, parseSessionDelegation, pikitDomain, privateKeySigner,
  recoverCancelIntentSigner, recoverCreditIntentSigner, recoverSessionGrantSigner, SeedChain, seedChainLinks, sessionKeyResource,
  sessionKeyStatement, signCancelIntent, signCreditIntent, signSessionGrant, verifyMerkleProof, ZERO_BYTES32,
  type CancelIntentMessage, type CreditIntentMessage, type Hex32, type SessionGrantMessage,
} from "../src/index.js";

const hex = (b: Uint8Array) => `0x${Buffer.from(b).toString("hex")}` as Hex32;
const SHOP = "0x5b0b000000000000000000000000000000000005";
const WALLET_KEY = `0x${"11".repeat(32)}` as const;
const SESSION_KEY = `0x${"22".repeat(32)}` as const;

describe("seed chain", () => {
  const top = `0x${"ab".repeat(32)}` as Hex32;

  it("S_{i−1} = keccak256(S_i) down to S_0, with checkpoints", () => {
    const chain = new SeedChain(top, 10, 3);
    let s = top;
    const expected: Hex32[] = [];
    for (let i = 10; i >= 0; i--) { expected[i] = s; s = viemKeccak(s); }
    for (let e = 0; e <= 10; e++) assert.equal(chain.seedOf(e), expected[e], `epoch ${e}`);
    assert.equal(chain.root(), expected[0]);
    assert.ok(seedChainLinks(chain.seedOf(7), 7, chain.root(), 0));
    assert.ok(seedChainLinks(chain.seedOf(7), 7, chain.seedOf(4), 4));
    assert.ok(!seedChainLinks(chain.seedOf(7), 6, chain.root(), 0), "wrong epoch number must fail");
    assert.throws(() => chain.seedOf(11));
  });

  it("e(w) = 1 + floor((w − W0) / 200)", () => {
    assert.equal(epochOf(1000, 1000), 1);
    assert.equal(epochOf(1199, 1000), 1);
    assert.equal(epochOf(1200, 1000), 2);
    assert.deepEqual(epochWindows(2, 1000), { first: 1200, last: 1399 });
    assert.throws(() => epochOf(999, 1000));
  });

  it("HMAC-SHA256 (noble) equals node:crypto", () => {
    const key = new Uint8Array(32).fill(7);
    const msg = new TextEncoder().encode("PIKIT/win/v2");
    assert.equal(hex(hmacSha256(key, msg)), hex(new Uint8Array(createHmac("sha256", key).update(msg).digest())));
  });
});

describe("batch hash H_j (Q4)", () => {
  it("= keccak256(abi.encodePacked(uint32 j, uint8[2000] kinds)), array elements padded to 32 bytes", () => {
    const kinds = Array.from({ length: 2000 }, (_, i) => i % 10);
    const bytes = new Uint8Array(4 + 2000 * 32);
    new DataView(bytes.buffer).setUint32(0, 7, false);
    kinds.forEach((k, i) => { bytes[4 + i * 32 + 31] = k; });
    assert.equal(boardBatchHash(7, kinds), viemKeccak(bytes));
    // 테스트 벡터 (Foundry: keccak256(abi.encodePacked(uint32(7), kinds)) with kinds[i] = i % 10)
    assert.equal(boardBatchHash(7, kinds), "0x20537442f494329de45ad306ded62d2d75504396c28244780985b2a92642593e");
    assert.throws(() => boardBatchHash(0, []));
  });
});

describe("input log hash chain (Q4)", () => {
  it("h_i = keccak256(h_{i−1} ‖ keccak256(canonicalJSON(entry))), key order irrelevant", () => {
    const entry = { window: 5, roomId: 1, index: 0, input: { type: "cancel", owner: `0x${"aa".repeat(20)}`, itemKey: "1:0" } };
    const reordered = { input: { itemKey: "1:0", owner: `0x${"aa".repeat(20)}`, type: "cancel" }, index: 0, roomId: 1, window: 5 };
    const canon = '{"index":0,"input":{"itemKey":"1:0","owner":"0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","type":"cancel"},"roomId":1,"window":5}';
    assert.equal(inputEntryHash(entry), viemKeccak(new TextEncoder().encode(canon)));
    assert.equal(inputEntryHash(entry), inputEntryHash(reordered));
    const h1 = chainInputLog(INPUT_LOG_GENESIS_HEAD, entry);
    const manual = viemKeccak(new Uint8Array([...new Uint8Array(32), ...Buffer.from(inputEntryHash(entry).slice(2), "hex")]));
    assert.equal(h1, manual);
  });

  it("epoch log v3 parses and flattens rooms (ascending) per window, each input with its chain link (D111)", () => {
    const owner = `0x${"aa".repeat(20)}`;
    const tx = `0x${"7a".repeat(32)}`;
    const freeze = { block: 1000, logIndex: -1, pos: 0, txHash: null };
    const log = EpochInputLog.parse({
      schema: "pikit.inputlog/v3", chainId: 143, shop: SHOP, epoch: 1, firstWindow: 1000, lastWindow: 1199,
      prevHead: ZERO_BYTES32, head: ZERO_BYTES32,
      windows: [{
        window: 1001,
        rooms: [
          {
            roomId: 1, inputs: [{ type: "freeze", reason: "FREEZE" }, { type: "purchase", ref: "9", owner, tiers: [0] }, { type: "cancel", owner, itemKey: "8:1" }],
            links: [freeze, { block: 1000, logIndex: 3, pos: 0, txHash: tx }, { block: 1000, logIndex: 5, pos: 1, txHash: tx }],
          },
          { roomId: 2, inputs: [{ type: "voidPurchase", ref: "9", owner }], links: [{ block: 1000, logIndex: 7, pos: 2, txHash: tx }] },
        ],
      }],
    });
    const entries = epochLogEntries(log);
    assert.deepEqual(entries.map((e) => [e.roomId, e.input.type, inputLinkKey(e.link)]), [[1, "freeze", "1000:-1:0"], [1, "purchase", "1000:3:0"], [1, "cancel", "1000:5:1"], [2, "voidPurchase", "1000:7:2"]]);
    assert.ok(compareInputLinks(entries[0]!.link, entries[1]!.link) < 0 && compareInputLinks(entries[2]!.link, entries[1]!.link) > 0, "(block, logIndex, pos) 순서, 동결(−1)이 그 블록 로그보다 앞");
    // 연결이 사슬 줄에 들어간다: 연결만 바꿔도 머리가 바뀐다
    const moved = { ...entries[1]!, link: { ...entries[1]!.link, block: 999 } };
    assert.notEqual(inputEntryHash(entries[1]), inputEntryHash(moved));
    const rooms = log.windows[0]!.rooms;
    assert.throws(() => EpochInputLog.parse({ ...log, windows: [{ window: 1001, rooms: [rooms[1], rooms[0]] }] }), "방 순서");
    assert.throws(() => EpochInputLog.parse({ ...log, windows: [{ window: 1001, rooms: [{ ...rooms[0], links: rooms[0]!.links.slice(1) }] }] }), "입력마다 연결 하나");
    assert.throws(() => EpochInputLog.parse({ ...log, windows: [{ window: 1001, rooms: [{ roomId: 1, inputs: [{ type: "freeze", reason: "FREEZE" }] }] }] }), "연결 없는 v2 줄");
    assert.throws(() => InputLink.parse({ block: 1000, logIndex: -1, pos: 0, txHash: tx }), "동결(−1)에는 tx가 없다");
    assert.throws(() => InputLink.parse({ block: 1000, logIndex: 4, pos: 0, txHash: null }), "로그에는 tx가 있다");
    assert.throws(() => EpochInputLog.parse({ ...log, schema: "pikit.inputlog/v2" }), "옛 형식 v2는 읽지 않는다");
    // 옛 공유 장부 입력·크레딧 의향서 증거·creditsToUse는 더 이상 형식이 아니다(개정 3)
    assert.throws(() => EpochInputLog.parse({ ...log, windows: [{ window: 1001, ledger: [], rooms }] }));
    assert.throws(() => EpochInputLog.parse({ ...log, windows: [{ window: 1001, rooms: [{ roomId: 1, inputs: [{ type: "purchase", ref: "L7", owner, tiers: [0] }], links: [rooms[0]!.links[1]] }] }] }));
  });
});

describe("Merkle (OpenZeppelin sorted pairs)", () => {
  it("two leaves: root = keccak256(min ‖ max); proofs verify; empty = 0", () => {
    const a = idValueLeaf(1, `0x${"01".repeat(32)}`);
    const b = idValueLeaf(2, `0x${"02".repeat(32)}`);
    const [lo, hi] = [a, b].sort();
    assert.equal(merkleRoot([a, b]), viemKeccak(`0x${lo!.slice(2)}${hi!.slice(2)}`));
    assert.equal(merkleRoot([b, a]), merkleRoot([a, b]));
    const leaves = Array.from({ length: 5 }, (_, i) => idValueLeaf(i + 1, `0x${(i + 1).toString(16).padStart(64, "0")}`));
    const root = merkleRoot(leaves);
    for (const l of leaves) assert.ok(verifyMerkleProof(root, l, merkleProof(leaves, l)));
    assert.equal(merkleRoot([]), ZERO_BYTES32);
  });

  it("room leaf = keccak256(abi.encode(uint256, bytes32))", () => {
    const v = `0x${"ee".repeat(32)}` as Hex32;
    const enc2 = new Uint8Array(64).fill(0);
    enc2[31] = 3; enc2.set(Buffer.from("ee".repeat(32), "hex"), 32);
    assert.equal(idValueLeaf(3, v), viemKeccak(enc2));
  });

  it("on-chain rulesHash = keccak256(catalogHash ‖ engineVersionHash) (Q5)", () => {
    const c = canonicalHash({ a: 1 }) as Hex32;
    const e = `0x${"cd".repeat(32)}` as Hex32;
    assert.equal(onchainRulesHash(c, e), viemKeccak(`0x${c.slice(2)}${e.slice(2)}`));
  });
});

describe("EIP-712 (개정 3: SessionGrant · CreditIntent · CancelIntent, domain PIKIT)", () => {
  const walletAccount = privateKeyToAccount(WALLET_KEY);
  const wallet = walletAccount.address.toLowerCase();
  const session = privateKeySigner(SESSION_KEY);
  const domain = pikitDomain(SHOP);
  const rulesHash = `0x${"5e".repeat(32)}`;
  const intent: CreditIntentMessage = {
    wallet, sessionKey: session.address, roomId: "1", rulesHash, tiers: [0, 4], nonce: "7", deadline: "120",
  };
  const cancel: CancelIntentMessage = {
    wallet, sessionKey: session.address, roomId: "1", items: [itemIdOf(12, 3).toString()], nonce: "8", deadline: "120",
  };
  const grant: SessionGrantMessage = { wallet, sessionKey: session.address, expiresAt: "1790000000", spendLimitCredits: "1000000" };
  const k = (s: string) => viemKeccak(toBytes(s));
  const domainSep = (chainId: bigint, shop: string) => viemKeccak(encodeAbiParameters(
    ["bytes32", "bytes32", "bytes32", "uint256", "address"].map((type) => ({ type })),
    [k("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)"), k("PIKIT"), k("1"), chainId, shop as `0x${string}`],
  ));
  const digestOf = (structHash: string) => viemKeccak(`0x1901${domainSep(143n, SHOP).slice(2)}${structHash.slice(2)}`);

  it("session key signs intents, wallet signs the grant; signers recover; any field change breaks it", async () => {
    const sig = await signCreditIntent(session.sign, domain, intent);
    assert.equal(await recoverCreditIntentSigner(domain, intent, sig), session.address);
    for (const changed of [
      { ...intent, tiers: [4, 0] }, { ...intent, nonce: "8" }, { ...intent, deadline: "121" },
      { ...intent, roomId: "2" }, { ...intent, rulesHash: `0x${"5f".repeat(32)}` }, { ...intent, wallet: `0x${"ab".repeat(20)}` },
    ]) assert.notEqual(await recoverCreditIntentSigner(domain, changed, sig), session.address);
    const csig = await signCancelIntent(session.sign, domain, cancel);
    assert.equal(await recoverCancelIntentSigner(domain, cancel, csig), session.address);
    const gsig = await signSessionGrant((t) => walletAccount.signTypedData(t as Parameters<typeof walletAccount.signTypedData>[0]), domain, grant);
    assert.equal(await recoverSessionGrantSigner(domain, grant, gsig), wallet);
    // 다른 체인·다른 상점이면 다른 다이제스트 (리플레이 방지)
    assert.notEqual(hashCreditIntent(pikitDomain(SHOP, 10143), intent), hashCreditIntent(domain, intent));
    assert.notEqual(hashCreditIntent(pikitDomain(`0x${"5c".repeat(20)}`), intent), hashCreditIntent(domain, intent));
  });

  it("digests equal hand-rolled EIP-712 encodings (arrays → keccak of 32-byte words) — same as PikitShop.hash*", () => {
    const tiersHash = viemKeccak(encodeAbiParameters(intent.tiers.map(() => ({ type: "uint256" })), intent.tiers.map(BigInt)));
    const credit = viemKeccak(encodeAbiParameters(
      ["bytes32", "address", "address", "uint256", "bytes32", "bytes32", "uint256", "uint256"].map((type) => ({ type })),
      [k("CreditIntent(address wallet,address sessionKey,uint256 roomId,bytes32 rulesHash,uint8[] tiers,uint256 nonce,uint256 deadline)"),
        intent.wallet, intent.sessionKey, 1n, rulesHash, tiersHash, 7n, 120n],
    ));
    assert.equal(hashCreditIntent(domain, intent), digestOf(credit));
    const itemsHash = viemKeccak(encodeAbiParameters([{ type: "uint256" }], [itemIdOf(12, 3)]));
    const cancelStruct = viemKeccak(encodeAbiParameters(
      ["bytes32", "address", "address", "uint256", "bytes32", "uint256", "uint256"].map((type) => ({ type })),
      [k("CancelIntent(address wallet,address sessionKey,uint256 roomId,uint256[] items,uint256 nonce,uint256 deadline)"),
        cancel.wallet, cancel.sessionKey, 1n, itemsHash, 8n, 120n],
    ));
    assert.equal(hashCancelIntent(domain, cancel), digestOf(cancelStruct));
    const grantStruct = viemKeccak(encodeAbiParameters(
      ["bytes32", "address", "address", "uint64", "uint64"].map((type) => ({ type })),
      [k("SessionGrant(address wallet,address sessionKey,uint64 expiresAt,uint64 spendLimitCredits)"), grant.wallet, grant.sessionKey, 1_790_000_000n, 1_000_000n],
    ));
    assert.equal(hashSessionGrant(domain, grant), digestOf(grantStruct));
  });

  it("item ids and keys: (purchaseId << 8) | index ↔ \"<purchaseId>:<index>\"", () => {
    assert.equal(itemIdOf(12, 3), 12n * 256n + 3n);
    assert.equal(itemKeyFromId(itemIdOf(12, 3)), "12:3");
    assert.equal(itemKeyOf(12n, 3), "12:3");
    assert.deepEqual(parseItemKey("12:3"), { purchaseId: "12", itemIndex: 3 });
    assert.equal(parseItemKey("L7:0"), null);
    assert.throws(() => itemIdOf(1, 10));
  });
});

describe("SIWE session delegation (Q2)", () => {
  it("message carries the urn resource and statement; parse returns wallet, key, expiry; wallet signature recovers", async () => {
    const walletAccount = privateKeyToAccount(WALLET_KEY);
    const sessionAddr = privateKeyToAccount(SESSION_KEY).address;
    const exp = 1_790_000_000;
    const message = createSessionSiweMessage({
      domain: "pikit.gg", uri: "https://pikit.gg", wallet: walletAccount.address, sessionKey: sessionAddr, expiresAtUnix: exp,
      nonce: "abcdefgh12345678", issuedAtUnix: exp - 86_400,
    });
    assert.ok(message.includes(`- ${sessionKeyResource(sessionAddr, exp)}`));
    assert.ok(message.includes(sessionKeyStatement(sessionAddr, exp)));
    assert.equal(sessionKeyStatement(sessionAddr, exp), `Authorize session key ${sessionAddr.toLowerCase()} for in-game credit purchases until 2026-09-21T14:13:20Z`);
    const claim = parseSessionDelegation(message);
    assert.deepEqual(claim, { wallet: walletAccount.address.toLowerCase(), sessionKey: sessionAddr.toLowerCase(), expiresAtUnix: exp, chainId: 143, domain: "pikit.gg", nonce: "abcdefgh12345678" });
    const sig = await walletAccount.signMessage({ message });
    assert.equal((await recoverMessageAddress({ message, signature: sig })).toLowerCase(), claim.wallet);
    assert.throws(() => parseSessionDelegation(message.replace("in-game credit purchases", "anything")), /statement/);
  });
});
