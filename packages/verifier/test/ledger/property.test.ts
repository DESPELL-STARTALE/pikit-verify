// 장부 속성 시험 (계획 §2.4 불변식 가·나·다, D199): 무작위 명단 + 가짜 엔진(정산)으로 수천 항목을 돌린다. 서명은 인증 결과를 직접 줘서 건너뛴다.
//   (다) 잔액·판돈 ≥ 0 · (가) 지갑마다 판돈 = 열린 곡괭이 가격 합 · (나) 공급 = 받은 GRANT − 손실
//   결정성: 같은 입력이면 같은 결정·루트 · 순서와 상관없는 것(지갑이 서로 다른 항목의 섞기, 잎 순서)은 같은 루트 ·
//   규칙이 순서를 정하는 것(한 지갑 안 seq 순서)을 바꾸면 결정이 달라진다(잡힌다).
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { GRANT_MAX_MILLI, type LedgerListEntry } from "@pikit/protocol";
import type { EnginePayout } from "@pikit/engine";
import { applyPayouts, applyWindowList, checkLedgerInvariants, LedgerState, type EntryAuth, type WindowApplication } from "../../src/index.js";
import { DAY0, makeContext, prng, ts, W0 } from "./helpers.js";

const ctx = makeContext(undefined, [1, 2]);
const RULES = ctx.rooms[0]!.rulesHash;
const WALLETS = Array.from({ length: 6 }, (_, i) => `0x${(0xa0 + i).toString(16)}${"0".repeat(38)}`);
const PRICES = ctx.rooms[0]!.catalog.pickaxes.map((p) => p.priceCredits * 1000);

interface Gen { entries: LedgerListEntry[]; auth: EntryAuth[] }
let refN = 0;
const ref = () => `0x${(++refN).toString(16).padStart(64, "0")}`;

/** 창 w의 무작위 명단 (지갑마다 seq 커서를 들고 다닌다). */
function genList(rnd: () => number, w: number, seqs: Map<string, number>, opts: { dayOf: (w: number) => number }): Gen {
  const entries: LedgerListEntry[] = [];
  const auth: EntryAuth[] = [];
  const n = Math.floor(rnd() * 8);
  for (let i = 0; i < n; i++) {
    const wallet = WALLETS[Math.floor(rnd() * WALLETS.length)]!;
    const r = rnd();
    if (r < 0.15) {
      const amount = rnd() < 0.05 ? GRANT_MAX_MILLI + 1n : BigInt(Math.floor(rnd() * 60_000)) * 1000n;
      entries.push({ kind: "GRANT", ref: ref(), grant: { wallet, amountMilli: String(amount), day: opts.dayOf(w) - (rnd() < 0.3 ? 1 : 0), reason: "DAILY" } });
      auth.push(null);
      continue;
    }
    // seq: 대개 다음 번호, 가끔 같은 번호(다시 냄)·건너뜀
    const last = seqs.get(wallet) ?? 0;
    const seq = rnd() < 0.1 ? last : last + 1 + (rnd() < 0.1 ? 3 : 0);
    seqs.set(wallet, Math.max(last, seq));
    const a: EntryAuth = { signatureOk: rnd() > 0.04, sessionExpiresAt: rnd() < 0.04 ? null : BigInt(ts(w) + (rnd() < 0.05 ? -1 : 1000)) };
    const target = rnd() < 0.05 ? w + 1 : w;
    const roomId = rnd() < 0.03 ? 9 : rnd() < 0.5 ? 1 : 2;
    if (r < 0.8) {
      const k = 1 + Math.floor(rnd() * (rnd() < 0.05 ? 12 : 4));
      const tiers = Array.from({ length: k }, () => Math.floor(rnd() * (rnd() < 0.03 ? 7 : 5)));
      entries.push({ kind: "BUY", ref: ref(), signature: "0x", intent: { wallet, sessionKey: wallet, roomId, rulesHash: rnd() < 0.03 ? `0x${"ee".repeat(32)}` : RULES, tiers, seq: String(seq), targetWindow: target } });
    } else {
      const items = Array.from({ length: 1 + Math.floor(rnd() * 3) }, () => String((BigInt(Math.floor(rnd() * 50)) << 8n) | BigInt(Math.floor(rnd() * 4))));
      entries.push({ kind: "CANCEL", ref: ref(), signature: "0x", intent: { wallet, sessionKey: wallet, roomId, items, seq: String(seq), targetWindow: target } });
    }
    auth.push(a);
  }
  return { entries, auth };
}

/** 가짜 엔진: 받은 구매의 곡괭이를 열어 두고, 무작위로 끝내거나(REWARD ≤ 0.9 가격 + over) 취소된 칸을 REFUND한다. */
class FakeEngine {
  readonly open = new Map<string, { owner: string; price: number }>();
  constructor(private readonly rnd: () => number) {}
  window(w: number, app: WindowApplication | null): EnginePayout[] {
    const out: EnginePayout[] = [];
    const end = (key: string, kind: "REWARD" | "REFUND", cause: EnginePayout["cause"], payout: number, over: number) => {
      const it = this.open.get(key)!;
      this.open.delete(key);
      out.push({ key, owner: it.owner, tier: 0, priceMilli: it.price, kind, cause, payoutMilli: payout, overMilli: over, window: w, tick: 0 });
    };
    for (const p of app?.purchases ?? []) p.tiers.forEach((t, i) => this.open.set(`${p.purchaseId}:${i}`, { owner: p.buyer, price: PRICES[t]! }));
    for (const c of app?.cancels ?? []) {
      for (const item of c.items) {
        const key = `${BigInt(item) >> 8n}:${BigInt(item) & 0xffn}`;
        const it = this.open.get(key);
        if (it && it.owner === c.wallet && this.rnd() < 0.7) end(key, "REFUND", "CANCEL", it.price, 0);
      }
    }
    for (const [key, it] of [...this.open]) {
      if (this.rnd() < 0.05) {
        const payout = Math.floor(it.price * 0.9 * this.rnd());
        end(key, "REWARD", "END", payout, this.rnd() < 0.2 ? Math.floor(it.price * 3 * this.rnd()) : 0);
      }
    }
    return out;
  }
  stakeOf(): Map<string, bigint> {
    const m = new Map<string, bigint>();
    for (const it of this.open.values()) m.set(it.owner, (m.get(it.owner) ?? 0n) + BigInt(it.price));
    return m;
  }
}

function simulate(seed: number, windows = 300, o: { engine?: boolean; shuffle?: "disjoint" | null } = {}) {
  const rnd = prng(seed);
  const shuffleRnd = prng(seed ^ 0x5eed);
  refN = seed * 1_000_000;
  const state = new LedgerState();
  const engine = new FakeEngine(prng(seed + 1));
  const seqs = new Map<string, number>();
  const decisions: string[] = [];
  let granted = 0n;
  let loss = 0n;
  for (let w = W0 + 1; w <= W0 + windows; w++) {
    let { entries, auth } = genList(rnd, w, seqs, { dayOf: (x) => Math.floor(ts(x) / 86_400) });
    if (o.shuffle === "disjoint") ({ entries, auth } = disjointShuffle(shuffleRnd, entries, auth));
    const app = entries.length > 0 ? applyWindowList(state, ctx, { window: w, entriesHash: "0x", count: entries.length, entries }, auth, ts(w)) : null;
    if (app) {
      granted += app.grantedMilli;
      decisions.push(...app.decisions.map((d) => `${w}:${d.status}:${d.reason}:${d.purchaseId}`));
    }
    if (o.engine !== false) {
      const payouts = engine.window(w, app);
      applyPayouts(state, payouts.map((payout) => ({ roomId: 1, payout })));
      for (const p of payouts) loss += BigInt(p.priceMilli - p.payoutMilli - p.overMilli);
      // 불변식 (가)(나)(다) 매 윈도
      const problems = checkLedgerInvariants(state, { expectedSupplyMilli: granted - loss });
      const stake = engine.stakeOf();
      for (const wallet of new Set([...stake.keys(), ...state.wallets()])) {
        if ((stake.get(wallet) ?? 0n) !== state.get(wallet).openStakeMilli) problems.push(`${wallet}: stake ${state.get(wallet).openStakeMilli} vs open items ${stake.get(wallet) ?? 0n}`);
      }
      assert.deepEqual(problems, [], `seed ${seed} window ${w}`);
    }
  }
  return { state, decisions };
}

/** 지갑마다의 순서는 지키고 지갑끼리는 섞는다 (GRANT도 그 지갑 줄에 넣는다). */
function disjointShuffle(rnd: () => number, entries: LedgerListEntry[], auth: EntryAuth[]): Gen {
  const lanes = new Map<string, number[]>();
  entries.forEach((e, i) => {
    const w = e.kind === "GRANT" ? e.grant.wallet : e.intent.wallet;
    lanes.set(w, [...(lanes.get(w) ?? []), i]);
  });
  const order: number[] = [];
  const queues = [...lanes.values()];
  while (queues.some((q) => q.length > 0)) {
    const live = queues.filter((q) => q.length > 0);
    order.push(live[Math.floor(rnd() * live.length)]!.shift()!);
  }
  return { entries: order.map((i) => entries[i]!), auth: order.map((i) => auth[i]!) };
}

describe("ledger properties", () => {
  it("invariants (가)(나)(다) hold after every window across 25 random worlds; something is applied and something rejected", () => {
    let applied = 0;
    let rejected = 0;
    const reasons = new Set<string>();
    for (let seed = 1; seed <= 25; seed++) {
      const { decisions } = simulate(seed);
      for (const d of decisions) {
        const [, status, reason] = d.split(":");
        if (status === "APPLIED") applied += 1;
        else { rejected += 1; reasons.add(reason!); }
      }
    }
    assert.ok(applied > 1000 && rejected > 300, `applied ${applied}, rejected ${rejected}`);
    for (const r of ["BAD_SIGNATURE", "SESSION_MISSING", "SESSION_EXPIRED", "TARGET_MISMATCH", "SEQ_USED", "UNKNOWN_ROOM", "RULES_MISMATCH", "BAD_TIERS", "INSUFFICIENT_CREDITS", "GRANT_ALREADY", "GRANT_TOO_LARGE"]) {
      assert.ok(reasons.has(r), `random worlds never produced ${r}`);
    }
  });

  it("deterministic: the same input gives the same decisions, leaves and root", () => {
    for (const seed of [3, 11, 19]) {
      const a = simulate(seed);
      const b = simulate(seed);
      assert.deepEqual(a.decisions, b.decisions);
      assert.deepEqual(a.state.leaves(), b.state.leaves());
      assert.equal(a.state.root(), b.state.root());
    }
  });

  it("order the rules do not depend on does not change the root: entries of different wallets shuffled (per-wallet order kept), leaf order", () => {
    for (const seed of [5, 7, 13, 21]) {
      const a = simulate(seed, 300, { engine: false });
      const b = simulate(seed, 300, { engine: false, shuffle: "disjoint" });
      assert.equal(a.state.root(), b.state.root(), `seed ${seed}`);
      assert.equal(a.state.nextPurchaseId, b.state.nextPurchaseId);
      const leaves = a.state.leaves();
      assert.equal(LedgerState.fromLeaves([...leaves].reverse(), a.state.nextPurchaseId).root(), a.state.root());
    }
  });

  it("order the rules do depend on is caught: swapping one wallet's seq order changes the decisions", () => {
    const s1 = new LedgerState();
    const s2 = new LedgerState();
    const wallet = WALLETS[0]!;
    s1.account(wallet).balanceMilli = s2.account(wallet).balanceMilli = 10_000_000n;
    const mk = (seq: number): LedgerListEntry => ({ kind: "BUY", ref: ref(), signature: "0x", intent: { wallet, sessionKey: wallet, roomId: 1, rulesHash: RULES, tiers: [0], seq: String(seq), targetWindow: W0 + 1 } });
    const ok: EntryAuth = { signatureOk: true, sessionExpiresAt: 1n << 40n };
    const [e1, e2] = [mk(1), mk(2)];
    const d1 = applyWindowList(s1, ctx, { window: W0 + 1, entriesHash: "0x", count: 2, entries: [e1, e2] }, [ok, ok], ts(W0 + 1)).decisions;
    const d2 = applyWindowList(s2, ctx, { window: W0 + 1, entriesHash: "0x", count: 2, entries: [e2, e1] }, [ok, ok], ts(W0 + 1)).decisions;
    assert.deepEqual(d1.map((d) => d.status), ["APPLIED", "APPLIED"]);
    assert.deepEqual(d2.map((d) => d.reason), [null, "SEQ_USED"]);
    assert.notEqual(s1.root(), s2.root());
  });

  it("GRANT once per UTC day holds over a multi-day run", () => {
    const s = new LedgerState();
    const wallet = WALLETS[1]!;
    const days = new Map<number, number>();
    for (let k = 0; k < 400; k++) {
      const w = W0 + 1 + k * 997;   // ≈ 11.5 시간마다 (블록 1초)
      const day = Math.floor(ts(w) / 86_400);
      const entries: LedgerListEntry[] = [day - 1, day, day].map((d) => ({ kind: "GRANT", ref: ref(), grant: { wallet, amountMilli: "1000", day: d, reason: "DAILY" } }));
      const app = applyWindowList(s, ctx, { window: w, entriesHash: "0x", count: 3, entries }, [null, null, null], ts(w));
      app.decisions.forEach((d, i) => {
        const g = entries[i] as Extract<LedgerListEntry, { kind: "GRANT" }>;
        if (d.status === "APPLIED") days.set(g.grant.day, (days.get(g.grant.day) ?? 0) + 1);
      });
    }
    assert.ok([...days.values()].every((n) => n === 1));
    assert.equal(s.get(wallet).balanceMilli, BigInt(days.size) * 1000n);
    assert.ok(days.size >= Math.floor((400 * 997) / 86_400) && days.has(DAY0));
  });
});
