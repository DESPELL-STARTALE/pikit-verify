// 장부 규칙 (D199): 거절 이유마다 하나 · seq 소비 · GRANT 날짜·상한·하루 1번 · 방-윈도 100 (취소 항목 수 포함) · 거절은 상태를 바꾸지 않음 · 정산.
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { GRANT_MAX_MILLI, LedgerDecision, MAX_INPUTS_PER_ROOM_WINDOW, itemIdOf, type EnginePayoutLike, type LedgerListEntry, type LedgerSessionRecord } from "./types.js";
import {
  applyPayouts, applyWindowList, authenticateEntries, checkListStructure, LedgerInvariantError, LedgerListError, LedgerState, ledgerWindow,
  type EntryAuth, type LedgerContext,
} from "../../src/index.js";
import { brief, buy, cancel, DAY0, grant, loadNormal, makeContext, player, sessionRecord, signedList, T0, ts, W0 } from "./helpers.js";

const ctx = makeContext();
const RULES = ctx.rooms[0]!.rulesHash;
const A = player(1);
const B = player(2);
const W = W0 + 5;

/** 진짜 서명으로: 모양 검사 → 인증 → 적용. */
async function run(state: LedgerState, entries: LedgerListEntry[], sessions: LedgerSessionRecord[], window = W, c: LedgerContext = ctx) {
  const list = await signedList(window, entries);
  checkListStructure(c, list);
  const auth = await authenticateEntries(c, list.entries, sessions);
  const app = applyWindowList(state, c, list, auth, ts(window));
  for (const d of app.decisions) LedgerDecision.parse(d);
  return app;
}

/** A에게 크레딧을 준 상태 (seq 0, lastGrantDay = DAY0). */
async function funded(amountCredits = 100_000) {
  const s = new LedgerState();
  await run(s, [grant(A.wallet.address, BigInt(amountCredits) * 1000n, DAY0)], []);
  return s;
}

describe("ledger rules — GRANT", () => {
  it("credits the wallet and records the day; one per UTC day; yesterday allowed, tomorrow and older not", async () => {
    const s = new LedgerState();
    const app = await run(s, [
      grant(A.wallet.address, 20_000_000n, DAY0 - 1),   // 어제 (blockDay − 1) → 받음
      grant(A.wallet.address, 20_000_000n, DAY0 - 1),   // 같은 날 두 번 → GRANT_ALREADY
      grant(A.wallet.address, 20_000_000n, DAY0),       // 오늘 → 받음
      grant(A.wallet.address, 20_000_000n, DAY0 - 1),   // 더 이른 날 → GRANT_ALREADY
      grant(B.wallet.address, 20_000_000n, DAY0 + 1),   // 내일 → GRANT_DAY
      grant(B.wallet.address, 20_000_000n, DAY0 - 2),   // 그저께 → GRANT_DAY
    ], []);
    assert.deepEqual(app.decisions.map(brief), ["APPLIED", "GRANT_ALREADY", "APPLIED", "GRANT_ALREADY", "GRANT_DAY", "GRANT_DAY"]);
    assert.equal(s.get(A.wallet.address).balanceMilli, 40_000_000n);
    assert.equal(s.get(A.wallet.address).lastGrantDay, DAY0);
    assert.equal(app.grantedMilli, 40_000_000n);
    assert.equal(s.get(B.wallet.address).balanceMilli, 0n);
    assert.deepEqual(s.wallets(), [A.wallet.address]);
  });

  it("the UTC day comes from the block timestamp of the list window", async () => {
    const s = new LedgerState();
    // 블록 W0 + 86,400 → T0 + 86,400초 = 다음 날. DAY0은 이제 어제라 받고, DAY0 − 1은 그저께라 거절.
    const w = W0 + 86_400;
    const app = await run(s, [grant(A.wallet.address, 1000n, DAY0 - 1), grant(B.wallet.address, 1000n, DAY0)], [], w);
    assert.deepEqual(app.decisions.map(brief), ["GRANT_DAY", "APPLIED"]);
  });

  it("amount must be 1 … GRANT_MAX_MILLI", async () => {
    const s = new LedgerState();
    const app = await run(s, [grant(A.wallet.address, 0n, DAY0), grant(A.wallet.address, GRANT_MAX_MILLI + 1n, DAY0), grant(A.wallet.address, GRANT_MAX_MILLI, DAY0)], []);
    assert.deepEqual(app.decisions.map(brief), ["GRANT_TOO_LARGE", "GRANT_TOO_LARGE", "APPLIED"]);
    assert.equal(s.get(A.wallet.address).balanceMilli, GRANT_MAX_MILLI);
  });
});

describe("ledger rules — BUY / CANCEL", () => {
  it("BUY debits the catalog price, opens the stake, numbers purchases and builds engine records (block w − 1, log = list index, tx = digest)", async () => {
    const s = await funded();
    const sess = [await sessionRecord(A)];
    const e1 = await buy(A, { rulesHash: RULES, tiers: [0, 1, 2], seq: 1, target: W });
    const e2 = await buy(A, { rulesHash: RULES, tiers: [1], seq: 2, target: W });
    const app = await run(s, [grant(B.wallet.address, 1000n, DAY0), e1, e2], sess);
    assert.deepEqual(app.decisions.map(brief), ["APPLIED", "APPLIED#0", "APPLIED#1"]);
    const a = s.get(A.wallet.address);
    assert.equal(a.balanceMilli, 100_000_000n - 21_000_000n - 5_000_000n);   // (규칙 12) 1,000 + 5,000 + 15,000 = 21,000 cr
    assert.equal(a.openStakeMilli, 26_000_000n);
    assert.equal(a.lastSeq, 2n);
    assert.equal(s.nextPurchaseId, 2n);
    assert.deepEqual(app.purchases[0], {
      purchaseId: "0", buyer: A.wallet.address, rulesHash: RULES, tiers: [0, 1, 2], roomId: 1, blockNumber: W - 1, logIndex: 1, txHash: e1.ref,
    });
    assert.equal(app.purchases[1]!.logIndex, 2);
  });

  it("CANCEL passes items through to the engine and leaves balances alone", async () => {
    const s = await funded();
    const sess = [await sessionRecord(A)];
    const c = await cancel(A, { items: [itemIdOf(0, 0), itemIdOf(0, 3)], seq: 5, target: W });
    const app = await run(s, [c], sess);
    assert.deepEqual(app.decisions.map(brief), ["APPLIED"]);
    assert.deepEqual(app.cancels, [{ wallet: A.wallet.address, items: ["0", "3"], roomId: 1, blockNumber: W - 1, logIndex: 0, txHash: c.ref }]);
    assert.equal(s.get(A.wallet.address).balanceMilli, 100_000_000n);
    assert.equal(s.get(A.wallet.address).lastSeq, 5n);
  });

  it("one rejection per reason, in rule order", async () => {
    const s = await funded(30_000);
    const sess = [await sessionRecord(A), await sessionRecord(B, T0, B.wallet)];
    const cases: [string, LedgerListEntry][] = [
      ["BAD_SIGNATURE", await buy(A, { rulesHash: RULES, tiers: [0], seq: 1, target: W, signer: B.session })],
      ["SESSION_MISSING", await buy(player(9), { rulesHash: RULES, tiers: [0], seq: 1, target: W })],
      ["SESSION_EXPIRED", await buy(B, { rulesHash: RULES, tiers: [0], seq: 1, target: W })],
      ["TARGET_MISMATCH", await buy(A, { rulesHash: RULES, tiers: [0], seq: 1, target: W + 1 })],
      ["UNKNOWN_ROOM", await buy(A, { roomId: 2, rulesHash: RULES, tiers: [0], seq: 2, target: W })],
      ["RULES_MISMATCH", await buy(A, { rulesHash: `0x${"ab".repeat(32)}`, tiers: [0], seq: 3, target: W })],
      ["BAD_TIERS", await buy(A, { rulesHash: RULES, tiers: [7], seq: 4, target: W })],
      ["INSUFFICIENT_CREDITS", await buy(A, { rulesHash: RULES, tiers: [2, 2, 2], seq: 5, target: W })],
      ["SEQ_USED", await buy(A, { rulesHash: RULES, tiers: [0], seq: 5, target: W })],
      ["BAD_TIERS", await cancel(A, { items: [itemIdOf(0, 0), itemIdOf(0, 0)], seq: 6, target: W })],
      ["BAD_TIERS", await cancel(A, { items: [(0n << 8n) | 10n], seq: 7, target: W })],
    ];
    const app = await run(s, cases.map(([, e]) => e), sess);
    assert.deepEqual(app.decisions.map(brief), cases.map(([r]) => r));
    assert.equal(s.get(A.wallet.address).balanceMilli, 30_000_000n);
    assert.equal(s.get(A.wallet.address).openStakeMilli, 0n);
    assert.equal(s.get(A.wallet.address).lastSeq, 7n);
    assert.equal(s.nextPurchaseId, 0n);
    assert.equal(app.purchases.length + app.cancels.length, 0);
  });

  it("room not yet open (createdWindow ≥ w) is UNKNOWN_ROOM", async () => {
    const s = await funded();
    const sess = [await sessionRecord(A)];
    const app = await run(s, [await buy(A, { rulesHash: RULES, tiers: [0], seq: 1, target: W0 })], sess, W0);
    assert.deepEqual(app.decisions.map(brief), ["UNKNOWN_ROOM"]);
    assert.equal(s.get(A.wallet.address).lastSeq, 1n);
  });

  it("session expiry is inclusive: ts(w) = expiresAt is valid, expiresAt − 1 is not", async () => {
    const s = await funded();
    const ok = await run(s, [await buy(A, { rulesHash: RULES, tiers: [0], seq: 1, target: W })], [await sessionRecord(A, ts(W))]);
    const late = await run(s, [await buy(A, { rulesHash: RULES, tiers: [0], seq: 2, target: W })], [await sessionRecord(A, ts(W) - 1)]);
    assert.deepEqual([...ok.decisions, ...late.decisions].map(brief), ["APPLIED#0", "SESSION_EXPIRED"]);
  });

  it("a session signed by another wallet is missing; an ERC-1271 session (erc1271Block set) is taken on the record (the verifier re-checks it by RPC)", async () => {
    const s = await funded();
    const forged = await sessionRecord(A, T0 + 3600, B.wallet);
    const r1 = await run(s, [await buy(A, { rulesHash: RULES, tiers: [0], seq: 1, target: W })], [forged]);
    const sc: LedgerSessionRecord = { ...forged, signature: "0x1234", erc1271Block: W0 - 10 };
    const r2 = await run(s, [await buy(A, { rulesHash: RULES, tiers: [0], seq: 1, target: W })], [sc]);
    assert.deepEqual([...r1.decisions, ...r2.decisions].map(brief), ["SESSION_MISSING", "APPLIED#0"]);
  });

  it("maxTiersPerBuy of the room catalog bounds BUY (same check as the engine)", async () => {
    const cat = structuredClone(loadNormal());
    cat.limits.maxTiersPerBuy = 2;
    const c2 = makeContext(cat);
    const s = await funded();
    const sess = [await sessionRecord(A)];
    const app = await run(s, [
      await buy(A, { rulesHash: c2.rooms[0]!.rulesHash, tiers: [0, 0, 0], seq: 1, target: W }),
      await buy(A, { rulesHash: c2.rooms[0]!.rulesHash, tiers: [0, 0], seq: 2, target: W }),
    ], sess, W, c2);
    assert.deepEqual(app.decisions.map(brief), ["BAD_TIERS", "APPLIED#0"]);
  });
});

describe("ledger rules — seq", () => {
  it("consumes the seq only once auth, session, expiry and target hold and seq > lastSeq; then any later rejection keeps it consumed", async () => {
    const s = await funded(1_000);
    const sess = [await sessionRecord(A)];
    const seqAfter = async (e: LedgerListEntry) => { await run(s, [e], sess); return s.get(A.wallet.address).lastSeq; };
    assert.equal(await seqAfter(await buy(A, { rulesHash: RULES, tiers: [0], seq: 3, target: W, signer: B.session })), 0n, "BAD_SIGNATURE keeps the seq");
    assert.equal(await seqAfter(await buy(A, { rulesHash: RULES, tiers: [0], seq: 3, target: W + 9 })), 0n, "TARGET_MISMATCH keeps the seq");
    assert.equal(await seqAfter(await buy(A, { rulesHash: RULES, tiers: [1], seq: 3, target: W })), 3n, "INSUFFICIENT_CREDITS consumes it");
    // 늦은 의향서를 같은 seq로 다시 서명해도 둘째 것은 SEQ_USED (중복 구매 불가) · 낮은 seq도
    const again = await run(s, [await buy(A, { rulesHash: RULES, tiers: [0], seq: 3, target: W }), await buy(A, { rulesHash: RULES, tiers: [0], seq: 2, target: W })], sess);
    assert.deepEqual(again.decisions.map(brief), ["SEQ_USED", "SEQ_USED"]);
    // 틈은 된다 (seq는 단조 증가만)
    const gap = await run(s, [await buy(A, { rulesHash: RULES, tiers: [0], seq: 10, target: W })], sess);
    assert.deepEqual(gap.decisions.map(brief), ["APPLIED#0"]);
    assert.equal(s.get(A.wallet.address).lastSeq, 10n);
  });

  it("within one list a wallet's entries must be in ascending seq (a later lower seq is SEQ_USED)", async () => {
    const s = await funded();
    const sess = [await sessionRecord(A)];
    const app = await run(s, [await buy(A, { rulesHash: RULES, tiers: [0], seq: 2, target: W }), await buy(A, { rulesHash: RULES, tiers: [0], seq: 1, target: W })], sess);
    assert.deepEqual(app.decisions.map(brief), ["APPLIED#0", "SEQ_USED"]);
  });
});

describe("ledger rules — room-window capacity", () => {
  // 서명 없이 (인증 결과를 직접 준다) — 용량 판정만 본다
  const okAuth: EntryAuth = { signatureOk: true, sessionExpiresAt: 1n << 62n };
  const fakeBuy = (wallet: string, roomId: number, seq: number): LedgerListEntry => ({
    kind: "BUY", ref: `0x${seq.toString(16).padStart(64, "0")}`, signature: `0x${"00".repeat(65)}`,
    intent: { wallet, sessionKey: wallet, roomId, rulesHash: RULES, tiers: [0], seq: String(seq), targetWindow: W },
  });
  const fakeCancel = (wallet: string, n: number, seq: number): LedgerListEntry => ({
    kind: "CANCEL", ref: `0x${(seq + 1_000_000).toString(16).padStart(64, "0")}`, signature: `0x${"00".repeat(65)}`,
    intent: { wallet, sessionKey: wallet, roomId: 1, items: Array.from({ length: n }, (_, i) => String(itemIdOf(7, i))), seq: String(seq), targetWindow: W },
  });

  it(`counts BUY as 1 and CANCEL as its item count, ≤ ${MAX_INPUTS_PER_ROOM_WINDOW} per room; other rooms and GRANTs do not count`, () => {
    const c2 = makeContext(loadNormal(), [1, 2]);
    const s = new LedgerState();
    const wallet = A.wallet.address;
    s.account(wallet).balanceMilli = 10n ** 12n;
    const entries: LedgerListEntry[] = [grant(B.wallet.address, 1000n, DAY0)];
    for (let i = 1; i <= 98; i++) entries.push(fakeBuy(wallet, 1, i));
    entries.push(fakeCancel(wallet, 3, 99));     // 98 + 3 > 100 → 꽉 참 (seq는 소비)
    entries.push(fakeCancel(wallet, 2, 100));    // 98 + 2 = 100 → 받음
    entries.push(fakeBuy(wallet, 1, 101));       // 101번째 → 꽉 참
    entries.push(fakeBuy(wallet, 2, 102));       // 방 2는 따로
    const auth = entries.map((e) => (e.kind === "GRANT" ? null : okAuth));
    const app = applyWindowList(s, c2, { window: W, entriesHash: "0x", count: entries.length, entries }, auth, ts(W));
    const tail = app.decisions.slice(-4).map(brief);
    assert.deepEqual(tail, ["ROOM_WINDOW_FULL", "APPLIED", "ROOM_WINDOW_FULL", "APPLIED#98"]);
    assert.equal(app.decisions.filter((d) => d.status === "APPLIED").length, 1 + 98 + 1 + 1);
    assert.equal(s.get(wallet).lastSeq, 102n);
  });
});

describe("ledger rules — rejections never change state (except the consumed seq)", () => {
  it("every rejection leaves balances, stakes, grant days and nextPurchaseId as they were", async () => {
    const s = await funded(5_000);
    const sess = [await sessionRecord(A)];
    const snap = () => JSON.stringify({ l: s.leaves().map((l) => ({ ...l, lastSeq: "-" })), n: String(s.nextPurchaseId) });
    const before = snap();
    const entries = [
      await buy(A, { rulesHash: RULES, tiers: [0], seq: 1, target: W, signer: B.session }),
      await buy(A, { rulesHash: RULES, tiers: [2], seq: 2, target: W }),
      await buy(A, { rulesHash: `0x${"cd".repeat(32)}`, tiers: [0], seq: 3, target: W }),
      await buy(A, { rulesHash: RULES, tiers: [9], seq: 4, target: W }),
      await buy(A, { roomId: 7, rulesHash: RULES, tiers: [0], seq: 5, target: W }),
      grant(A.wallet.address, 1000n, DAY0),
      grant(A.wallet.address, 0n, DAY0 + 1),
    ];
    const app = await run(s, entries, sess);
    assert.ok(app.decisions.every((d) => d.status === "REJECTED"), app.decisions.map(brief).join(","));
    assert.equal(snap(), before);
  });
});

describe("ledger rules — list structure", () => {
  it("rejects a list whose ref, entriesHash or count does not match its body (an error, not a decision)", async () => {
    const e = await buy(A, { rulesHash: RULES, tiers: [0], seq: 1, target: W });
    const good = await signedList(W, [grant(A.wallet.address, 1000n, DAY0), e]);
    checkListStructure(ctx, good);
    assert.throws(() => checkListStructure(ctx, { ...good, entries: [good.entries[1]!, good.entries[0]!] }), LedgerListError, "order swapped");
    assert.throws(() => checkListStructure(ctx, { ...good, count: 3 }), LedgerListError);
    const tampered = { ...e, intent: { ...(e as Extract<LedgerListEntry, { kind: "BUY" }>).intent, tiers: [2] } } as LedgerListEntry;
    assert.throws(() => checkListStructure(ctx, { ...good, entries: [good.entries[0]!, tampered] }), /ref .* ≠ intent digest/);
    const regrant = { ...good.entries[0]!, grant: { wallet: A.wallet.address, amountMilli: "2000", day: DAY0, reason: "DAILY" } } as LedgerListEntry;
    assert.throws(() => checkListStructure(ctx, { ...good, entries: [regrant, e] }), /grantRef/);
  });

  it("ledgerWindow refuses a list for another window", async () => {
    const s = new LedgerState();
    const list = await signedList(W, [grant(A.wallet.address, 1000n, DAY0)]);
    assert.throws(() => ledgerWindow(s, ctx, W + 1, { list, auth: [null], blockTimestamp: ts(W) }, () => ({ rooms: [] })), /given for window/);
  });
});

describe("ledger rules — payouts", () => {
  const pay = (o: Partial<EnginePayoutLike> & { key: string; owner: string }): { roomId: number; payout: EnginePayoutLike } => ({
    roomId: 1, payout: { tier: 0, priceMilli: 1_000_000, kind: "REWARD", cause: "END", payoutMilli: 800_000, overMilli: 0, window: W + 50, tick: 3, ...o },
  });

  it("closes the stake and credits payout + over; leaves the payout leaf", () => {
    const s = new LedgerState(2n);
    const a = s.account(A.wallet.address);
    a.openStakeMilli = 3_000_000n;
    const leaves = applyPayouts(s, [
      pay({ key: "0:0", owner: A.wallet.address, payoutMilli: 900_000, overMilli: 2_500_000 }),
      pay({ key: "1:1", owner: A.wallet.address, priceMilli: 2_000_000, kind: "REFUND", cause: "CANCEL", payoutMilli: 2_000_000 }),
    ]);
    assert.equal(s.get(A.wallet.address).openStakeMilli, 0n);
    assert.equal(s.get(A.wallet.address).balanceMilli, 900_000n + 2_500_000n + 2_000_000n);
    assert.deepEqual(leaves[1], {
      purchaseId: "1", itemIndex: 1, owner: A.wallet.address, kind: "REFUND", cause: "CANCEL", priceMilli: "2000000", payoutMilli: "2000000", overMilli: "0", window: W + 50,
    });
  });

  it("a payout above the open stake (engine and ledger disagree) is an invariant error, not a decision", () => {
    const s = new LedgerState();
    assert.throws(() => applyPayouts(s, [pay({ key: "0:0", owner: A.wallet.address })]), LedgerInvariantError);
    s.account(A.wallet.address).openStakeMilli = 1_000_000n;
    assert.throws(() => applyPayouts(s, [pay({ key: "zz", owner: A.wallet.address })]), LedgerInvariantError);
  });
});
