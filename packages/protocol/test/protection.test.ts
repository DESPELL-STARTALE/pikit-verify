import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { DailyClaimRequest, DailyCreditsView, DailyGrantStatus, protectionRefusal, TicketsView, type ProtectionState } from "../src/index.js";

const ok: ProtectionState = { breakForever: false, breakUntilMs: null };
const now = 1_800_000_000_000;

describe("protectionRefusal (server-side purchase / daily-claim gate)", () => {
  it("a break (timed or forever) blocks, nothing else does", () => {
    assert.equal(protectionRefusal(ok, now), null);
    assert.equal(protectionRefusal({ ...ok, breakForever: true }, now)?.code, "ON_BREAK");
    assert.equal(protectionRefusal({ ...ok, breakUntilMs: now + 1 }, now)?.code, "ON_BREAK");
    assert.equal(protectionRefusal({ ...ok, breakUntilMs: now }, now), null);
  });
  it("relay refusal codes are gone with the relay (spec 20, D4); grant statuses are the ledger ones", () => {
    assert.equal(DailyGrantStatus.safeParse("REQUESTED").success, false);
    assert.equal(DailyGrantStatus.safeParse("SENT").success, false);
    assert.deepEqual(DailyGrantStatus.options, ["PENDING", "LISTED", "APPLIED", "REJECTED", "SKIPPED"]);
  });
});

describe("daily credits and tickets REST shapes (D103)", () => {
  const view = {
    day: "2026-10-10", claimed: true, grantedCredits: 10_000, targetCredits: 10_000, baseCredits: 10_000, nftHolder: false, nftHolderCredits: 100_000, snapshot: { block: 1, at: "2026-10-10T00:00:00.000Z", nftCount: 0, chogBalance: "0" }, chogCredits: 0, chogUnit: 100_000, chogCreditsPerUnit: 10_000, chogCapCredits: 500_000,
    streakDays: 1, bonus: null, promoMilli: "0", unsettledMilli: 0, reason: null, grantStatus: "PENDING", nextClaimAt: "2026-10-11T00:00:00.000Z",
  };
  it("DailyCreditsView parses a claim and refuses unknown fields", () => {
    assert.deepEqual(DailyCreditsView.parse(view), view);
    assert.equal(DailyCreditsView.safeParse({ ...view, withdrawableMilli: "0" }).success, false);
    assert.equal(DailyCreditsView.safeParse({ ...view, day: "2026-10-10T00:00" }).success, false);
    assert.equal(DailyCreditsView.parse({ ...view, claimed: false, grantedCredits: 0, reason: "FREE_CREDITS_EXHAUSTED", grantStatus: null }).reason, "FREE_CREDITS_EXHAUSTED");
  });
  it("DailyClaimRequest takes an optional Turnstile token only", () => {
    assert.deepEqual(DailyClaimRequest.parse({}), {});
    assert.equal(DailyClaimRequest.parse({ turnstileToken: "x" }).turnstileToken, "x");
    assert.equal(DailyClaimRequest.safeParse({ amount: 5 }).success, false);
  });
  it("TicketsView caps the week at 7 tickets", () => {
    const t = {
      weekStart: "2026-10-05", weekTickets: 7, ticketMinPickaxes: 10, monthStart: "2026-10-01", monthPlayDays: 9, todayPickaxes: 12,
      eligibility: { nft: false, nftCount: 0, token: true, tokenDays: 7, tokenMin: "50000", eligible: true },
    };
    assert.deepEqual(TicketsView.parse(t), t);
    assert.equal(TicketsView.safeParse({ ...t, weekTickets: 8 }).success, false);
  });
});

describe("weekly gold hall is gone (rules 7, D137)", () => {
  it("no GoldHallView export", async () => {
    const mod = (await import("../src/index.js")) as Record<string, unknown>;
    assert.equal(mod.GoldHallView, undefined);
  });
});
