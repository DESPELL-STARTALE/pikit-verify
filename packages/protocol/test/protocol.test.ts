import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import {
  canonicalHash, canonicalJson, type Catalog, catalogBaseCeilingMilli, catalogLuckyCeilingMilli, catalogOverCapMilli, catalogRewardCapMilli,
  FeedEvent, MAX_OVER_MULTIPLE, Payout, SETTLE_KIND_ONCHAIN, SettledEvent, SettlementRecord, HistoryItem, InputLog, JoinOptions, parseCatalog, PickaxeHistoryRecord, PickaxeLiveState,
  isBigPayout, pikitFairnessAbi, pikitShopAbi, PurchasedEvent, QueueState, shortPlayerId,
  BatchView, MeView, RELAY_CODE_MESSAGES, RelayRefusalCode, relayCodeMessage,
} from "../src/index.js";

const exampleUrl = new URL("../../catalog.example.json", import.meta.url);
const example = JSON.parse(readFileSync(exampleUrl, "utf8")) as unknown;

describe("catalog", () => {
  it("catalog.example.json passes the schema", () => {
    const c = parseCatalog(example);
    assert.equal(c.pickaxes.length, 5);
    assert.equal(c.blocks.reduce((s, b) => s + b.batchCount, 0), 2000);
  });

  it("rejects a batch whose kind counts do not add up", () => {
    const bad = structuredClone(example) as { blocks: { batchCount: number }[] };
    bad.blocks[0]!.batchCount += 1;
    assert.throws(() => parseCatalog(bad), /batchCount/);
  });

  it("frictionPerTick table matches (0.75^(1.3/fps))^(1/weight) within 1e-15 (rules 7 time scale 1.3: per-tick friction^1.3)", () => {
    // 규칙표를 만들 때의 확인용 계산(엔진 밖). Math.pow 결과는 V8 버전마다 마지막 비트가 다를 수 있어 오차를 허용한다.
    // physics.friction은 참고값(0.75^1.3을 6자리로 적음) — 표는 규칙 6 표(0.75)를 1.3제곱한 것이다(명세 16 §6.1)
    const c = parseCatalog(example);
    assert.ok(Math.abs(c.physics.friction - Math.pow(0.75, 1.3)) < 1e-6);
    const frame = Math.pow(0.75, 1.3 / c.physics.fps);
    for (const p of [...c.pickaxes, ...c.bots]) {
      const expected = Math.pow(frame, 1 / p.weight);
      assert.ok(Math.abs(p.frictionPerTick - expected) < 1e-15, `${p.code}: ${p.frictionPerTick} vs ${expected}`);
    }
  });
});

describe("shipped catalog (rules 7, D137: gate removed, value ladder + LUCKY, 5-point blades, physics ×1.3, banded generation)", () => {
  const load = (name: string) => JSON.parse(readFileSync(new URL(`../../catalogs/${name}.json`, import.meta.url), "utf8")) as unknown;
  // DECISIONS D125의 카탈로그 해시 (D104 표 + 하늘 이벤트 skyEvent, rulesVersion 6)
  const PUBLISHED_NORMAL = "0x7deb695907afcaa8b1d877bca19af0e399a82a7e939abd21f570ac6aae1bb632";
  // 규칙 7 날 5점 재맞춤 (명세 16 §5.2): 외날 FE·FC·VD, 양날 WB·BM, 봇. 손잡이는 모두 같다, handleDamage는 없다(어디로 맞아도 공격력)
  const handle = { shape: "pickaxe", headOffset: 0.24, handleLength: 0.66, handleRadius: 0.08, inertia: 0.1 } as const;
  const single = { ...handle, blade: { pts: [[0.287, -0.148], [0.277, -0.04], [0.45, 0], [0.114, 0.344], [-0.149, 0.381]], r: 0.05 } };
  const double = { ...handle, blade: { pts: [[0.015, -0.326], [0.177, -0.21], [0.398, 0], [0.211, 0.182], [0.025, 0.306]], r: 0.102 } };
  const bot = { ...handle, blade: { pts: [[0.188, -0.402], [0.284, -0.242], [0.444, 0], [0.261, 0.264], [0.034, 0.442]], r: 0.056 } };

  it("one room (D104): only NORMAL ships — LITE / HARDCORE catalogs are gone", () => {
    assert.throws(() => readFileSync(new URL("../../catalogs/lite.json", import.meta.url)), /ENOENT/);
    assert.throws(() => readFileSync(new URL("../../catalogs/hardcore.json", import.meta.url)), /ENOENT/);
  });

  it("NORMAL parses (rules 7, D137): no gate, 5-point blades, the bot slot, LUCKY + banded generation, and matches the published table byte-for-byte", () => {
    const c = parseCatalog(load("normal"));
    assert.equal(c.rulesVersion, 7);
    assert.equal((c as unknown as Record<string, unknown>).gate, undefined, "황금 입구 삭제");
    assert.deepEqual(c.reward, { rewardCapBps: 9000 });
    assert.deepEqual(c.lucky, { share: 0.08 });
    assert.deepEqual(c.generation, { bandedFromKind: 6, bandMargin: 1 });
    // 봇 = 예전 Blood Moon 몸(지름 2, 무게 4, 공격력 135.7) + 봇 날 — 등급 ×20(공격력 1,220)과 떨어져 있다 (D104)
    assert.deepEqual(c.bots, [{ code: "BOT", count: 3, attack: 135.7, scale: 2, weight: 4, frictionPerTick: 0.9968882956338715, hitbox: bot }]);
    for (const t of c.pickaxes) assert.deepEqual(t.hitbox, t.tier <= 2 ? single : double, t.code);
    assert.equal(canonicalHash(c), PUBLISHED_NORMAL);
  });

  it("rules 7 economy (spec 16 §4.1 + §4.8 LUCKY calibration): value ladder, per-tier β, POP, BIG POP; example catalog = NORMAL", () => {
    const n = parseCatalog(load("normal"));
    const m = [1, 2, 5, 10, 20];
    assert.deepEqual(n.pickaxes.map((p) => p.code), ["FE", "FC", "VD", "WB", "BM"]);
    assert.deepEqual(n.pickaxes.map((p) => p.priceCredits), m.map((x) => 1000 * x));
    assert.deepEqual(n.pickaxes.map((p) => p.attack), m.map((x) => 61 * x));
    assert.deepEqual(n.pickaxes.map((p) => p.durability), m.map((x) => 1108 * x));
    assert.deepEqual(n.pickaxes.map((p) => p.scale), [1, 1.25, 1.5, 1.75, 2], "크기 사다리는 그대로");
    assert.deepEqual(n.blocks.map((b) => b.value), [1, 1, 1.5, 2, 2.5, 3, 3.5, 4, 4.5, 5], "공개 블록 값 (다이아 ×5)");
    assert.deepEqual(n.pickaxes.map((p) => p.beta), [0.202904, 0.180148, 0.164396, 0.150839, 0.141684]);
    assert.deepEqual(n.pickaxes.map((p) => p.popPrize), [305, 620, 1359, 2450, 4317]);
    assert.deepEqual(n.pickaxes.map((p) => p.bigPopPrize), m.map((x) => 200 * x), "BIG POP = 가격의 20%");
    assert.deepEqual(n.pickaxes.map((p) => p.bonusCap), n.pickaxes.map((p) => p.popPrize + p.bigPopPrize));
    assert.deepEqual(n.physics, {
      fps: 30, bounce: 0.75, gravity: 2.7603333333333335, friction: 0.687986, denominator: 4.615384615384615, minBounceVy: 0.325, maxSpin: 0.52,
      angularDamping: 0.9354933117266963, contactFriction: 0.4, headFirstTorque: 0.325, spinKick: 0.078,
    }, "시간 배율 1.3 (명세 16 §6.1)");
    assert.deepEqual(n.pickaxes.map((p) => p.frictionPerTick), [0.9876111583347639, 0.9920406758278139, 0.9944747768864999, 0.9959343580610697, 0.9968882956338715]);
    assert.equal(n.world.cameraLerp, 0.12800245492246298);
    assert.equal(canonicalHash(parseCatalog(example)), canonicalHash(n));
  });

  it("sky event (D125) stays, time-scaled 1.3× (spec 16 §6.1)", () => {
    const c = parseCatalog(load("normal"));
    assert.deepEqual(c.skyEvent, {
      minPlayers: 5, chancePerWindow: 0.002, cooldownWindows: 300,
      item: { diameter: 0.5, weight: 1, frictionPerTick: c.pickaxes[0]!.frictionPerTick, startVy: 0.13, vxJitter: 0.052, aboveRows: 2, catchRadius: 0.6, lifeTicks: 69 },
      grow: { scale: 2.5, stepPerTick: 0.13, durationTicks: 138 },
    });
    const noSky = structuredClone(load("normal")) as Record<string, unknown>;
    delete noSky.skyEvent;
    assert.throws(() => parseCatalog(noSky), /skyEvent/, "규칙 7은 하늘 절이 늘 있다(상태 v9 하나)");
  });

  it("sky event schema (D125): rejects bad values and unknown keys", () => {
    type Sky = Record<string, unknown> & { item: Record<string, unknown>; grow: Record<string, unknown> };
    const c = load("normal") as { skyEvent: Sky };
    const bad = (f: (s: Sky) => void, re: RegExp) => {
      const x = structuredClone(c);
      f(x.skyEvent);
      assert.throws(() => parseCatalog(x), re);
    };
    bad((s) => { s.minPlayers = 0; }, /minPlayers/);
    bad((s) => { s.chancePerWindow = 0; }, /chancePerWindow/);
    bad((s) => { s.chancePerWindow = 1; }, /chancePerWindow/);
    bad((s) => { s.cooldownWindows = -1; }, /cooldownWindows/);
    bad((s) => { s.item.diameter = 1; }, /diameter/);
    bad((s) => { s.item.lifeTicks = 0; }, /lifeTicks/);
    bad((s) => { s.item.catchRadius = 0; }, /catchRadius/);
    bad((s) => { s.grow.scale = 8.5; }, /grow\.scale exceeds/);
    bad((s) => { s.grow.durationTicks = 0; }, /durationTicks/);
    bad((s) => { s.bonus = 1; }, /bonus/);
    bad((s) => { s.item.payout = 1; }, /payout/);
    bad((s) => { s.grow.attackMul = 2; }, /attackMul/);
    const ok = structuredClone(c);
    ok.skyEvent.grow.scale = 8;
    parseCatalog(ok);
  });

  it("rules 7 caps (spec 16 §4.1, §8.1-8): REWARD cap = 0.9 × price, over cap = base ceiling + LUCKY ceiling + bonus cap − REWARD cap ≤ 100 × price", () => {
    const c = parseCatalog(load("normal"));
    assert.deepEqual(c.pickaxes.map((_, t) => catalogRewardCapMilli(c, t)), [900_000, 1_800_000, 4_500_000, 9_000_000, 18_000_000]);
    assert.deepEqual(c.pickaxes.map((_, t) => catalogBaseCeilingMilli(c, t)), c.pickaxes.map((p) => Math.floor(p.beta * 5 * p.durability * 1000)));
    // LUCKY 천장 = share × 2,000 ÷ 18 (다이아) × 가격 — 가격의 8.89배
    assert.deepEqual(c.pickaxes.map((_, t) => catalogLuckyCeilingMilli(c, t)), c.pickaxes.map((p) => Math.floor(((0.08 * 2000) / 18) * p.priceCredits * 1000)));
    for (const p of c.pickaxes) {
      const over = catalogOverCapMilli(c, p.tier);
      assert.equal(over, catalogBaseCeilingMilli(c, p.tier) + catalogLuckyCeilingMilli(c, p.tier) + p.bonusCap * 1000 - catalogRewardCapMilli(c, p.tier));
      assert.ok(over <= MAX_OVER_MULTIPLE * p.priceCredits * 1000, `${p.code} over cap ≤ 100 × price`);
      const most = (catalogRewardCapMilli(c, p.tier) + over) / (p.priceCredits * 1000);
      assert.ok(most > 10 && most < 11, `${p.code}: most one pickaxe can pay = ${most.toFixed(2)} × price (LUCKY ×10)`);
    }
    // 스키마: rewardCapBps ≤ 9,700, over 상한 ≤ 100 × 가격, bonusCap = POP + BIG POP
    const raw = load("normal") as { reward: { rewardCapBps: number }; pickaxes: Record<string, unknown>[]; lucky: { share: number } };
    const bad = (f: (x: typeof raw) => void, re: RegExp) => { const x = structuredClone(raw); f(x); assert.throws(() => parseCatalog(x), re); };
    bad((x) => { x.reward.rewardCapBps = 9701; }, /rewardCapBps/);
    bad((x) => { x.pickaxes[0]!.bonusCap = 1; }, /bonusCap must equal/);
    bad((x) => { x.lucky.share = 1; x.pickaxes[0]!.beta = 50; }, /over-price cap/);
    bad((x) => { (x.pickaxes[0]!.hitbox as Record<string, unknown>).handleDamage = 0; }, /handleDamage|Unrecognized/);
  });

  it("generation (spec 16 §7.1): band length ≥ 2 × margin + 1, banded kinds < width", () => {
    const raw = load("normal") as { generation: { bandedFromKind: number; bandMargin: number } };
    const bad = (f: (x: typeof raw) => void, re: RegExp) => { const x = structuredClone(raw); f(x); assert.throws(() => parseCatalog(x), re); };
    bad((x) => { x.generation.bandMargin = 2; }, /band too short/);     // 에메랄드 ⌊200 / 60⌋ = 3 < 5
    bad((x) => { x.generation.bandedFromKind = 10; }, /bandedFromKind/);
    bad((x) => { x.generation.bandedFromKind = 0; }, /band too short|fewer than world\.width/);
    const ok = structuredClone(raw);
    ok.generation.bandedFromKind = 9;
    parseCatalog(ok);
  });

  it("bot slot (D104): every field is required; bots no longer point at a tier", () => {
    const raw = load("normal") as { bots: Record<string, unknown>[] };
    for (const k of ["code", "count", "attack", "scale", "weight", "frictionPerTick", "hitbox"]) {
      const { [k]: _drop, ...rest } = raw.bots[0]!;
      assert.throws(() => parseCatalog({ ...raw, bots: [rest] }), Error, `missing ${k}`);
    }
    assert.throws(() => parseCatalog({ ...raw, bots: [{ ...raw.bots[0], tier: 4 }] }), /tier|Unrecognized/);
    assert.throws(() => parseCatalog({ ...raw, bots: [{ ...raw.bots[0], scale: 9 }] }), /bots\[0\]\.scale/);
  });
});

describe("canonical JSON", () => {
  it("is independent of key order and whitespace", () => {
    const a = { b: 1, a: [1, { y: 2, x: "é" }] };
    const b = JSON.parse('{ "a": [1, {"x":"é", "y":2}], "b": 1 }') as unknown;
    assert.equal(canonicalJson(a), '{"a":[1,{"x":"é","y":2}],"b":1}');
    assert.equal(canonicalHash(a), canonicalHash(b));
  });

  it("rejects non-finite numbers", () => {
    assert.throws(() => canonicalJson({ x: Number.NaN }));
  });

  it("gives the example catalog a stable rulesHash", () => {
    const h = canonicalHash(parseCatalog(example));
    assert.match(h, /^0x[0-9a-f]{64}$/);
    assert.equal(h, canonicalHash(JSON.parse(JSON.stringify(example))));
  });
});

describe("purchase / intent shapes", () => {
  const addr = `0x${"ab".repeat(20)}`;
  const h32 = `0x${"11".repeat(32)}`;

  it("accepts a revision-5 Purchased event (no creditsToUse / paidWei / promo, D105)", () => {
    const e = {
      chainId: 143, shop: addr, blockNumber: 52103441, blockHash: h32, txHash: h32, logIndex: 0, purchaseId: "8812",
      buyer: addr, roomId: 1, rulesHash: h32, seq: "42", tiers: [4, 4, 4, 4, 4], priceCredits: "75000",
    };
    PurchasedEvent.parse(e);
    assert.throws(() => PurchasedEvent.parse({ ...e, promo: true }), "the promo flag is gone (strict)");
    assert.throws(() => PurchasedEvent.parse({ ...e, paidWei: "0", creditsToUse: "75000" }));
  });

  it("join options use chainRoomId (Colyseus reserves roomId)", () => {
    JoinOptions.parse({ chainRoomId: 1, rulesVersion: 1 });
    assert.throws(() => JoinOptions.parse({ roomId: 1 }));
  });

  it("history item: queued rows have null end fields and wall-clock createdAt", () => {
    HistoryItem.parse({
      itemKey: "8812:0", owner: addr, roomId: 1, tier: 0, priceCredits: 3000, rulesVersion: 1, status: "QUEUED",
      enqueuedWindow: 100, spawnWindow: null, spawnTick: null, endWindow: null, endTick: null, endReason: null,
      hits: 0, distinctBlocks: 0, blocksBroken: 0, durabilityUsed: 0, durabilityTotal: null, pop: false, events: [],
      bigPop: false, luckyKind: -1, baseMilli: 0, luckyMilli: 0, bonusMilli: 0, paidMilli: null, overMilli: 0, pnlMilli: null,
      createdAt: "2026-10-06T00:00:00.000Z", spawnedAt: null, endedAt: null, settlement: null,
    });
  });

  it("contract ABIs come from the Foundry artifacts (abi/*.json = abi.generated.ts)", async () => {
    const { readFileSync } = await import("node:fs");
    const json = (n: string) => JSON.parse(readFileSync(new URL(`../../abi/${n}.json`, import.meta.url), "utf8"));
    assert.deepEqual(json("PikitShop"), pikitShopAbi);
    const { existsSync } = await import("node:fs");
    assert.ok(!existsSync(new URL("../../abi/PikitVault.json", import.meta.url)), "개정 5(D105): PikitVault는 PikitShop에 합쳐졌다");
    assert.deepEqual(json("PikitFairness"), pikitFairnessAbi);
    const names = (abi: readonly { type: string; name?: string }[]) => new Set(abi.map((x) => x.name));
    for (const n of ["refundUnprocessed", "refundUnsettled", "settleTimeout", "purchaseOf", "Purchased", "Refunded", "UnsettledRefunded", "purchaseStatus", "salesOpen", "nextSeq"]) assert.ok(names(pikitShopAbi).has(n), n);
    for (const n of ["buyWithCredits", "cancelQueued", "registerSessionKey", "settleEnd", "settleEndMany", "payOverAfterVoid", "Settled", "VoidOverPaid", "IntentUsed", "CancelRequested"]) assert.ok(names(pikitShopAbi).has(n), n);
    for (const n of ["anchor", "commitBatches", "revealSeed", "Anchored", "purchaseCursor", "processingLag"]) assert.ok(names(pikitFairnessAbi).has(n), n);
    // D97·D138: 정산 멈춤, 놓친 묶음 건너뛰기, 가디언 교체 예고, 시간당 over 한도(변경은 예고 뒤), 무효 뒤 over
    for (const n of ["isVoidOverPaid", "overLimitMilli", "proposeOverLimit", "cancelOverLimitProposal", "pendingOverLimitMilli", "OVER_LIMIT_DELAY", "stallCursor", "SETTLE_STALL", "proposeGuardian", "cancelGuardianProposal", "acceptGuardian", "SettlementStalled", "OverLimitReached", "OverAboveCap", "OverOnRefund", "MAX_ROOM_ID", "RenounceDisabled"]) {
      assert.ok(names(pikitShopAbi).has(n), n);
    }
    // D138 (개정 6, 감사 F-1): 따로 보내는 잭팟 정산 길은 없다 — 끝 결정은 settleEnd 한 호출
    for (const n of ["settle", "settleMany", "isJackpotSettled", "jackpotLimitMilli", "setJackpotLimit", "JackpotLimitReached", "JackpotAlreadySettled", "JACKPOT_WINDOW", "MAX_JACKPOT_MULTIPLE", "setOverLimit"]) {
      assert.ok(!names(pikitShopAbi).has(n), `${n} removed`);
    }
    for (const n of ["SALES_LAG", "LateAnchorTooShort", "RenounceDisabled"]) assert.ok(names(pikitFairnessAbi).has(n), n);
    // D105: 프로모 잔액은 계산대에 있다
    for (const n of ["balanceOf", "totalBalanceMilli", "grantPromo", "promoBudgetMilli", "increasePromoBudget", "decreasePromoBudget", "PromoBudgetIncreased", "PromoBudgetDecreased", "promoGrantUsed", "promoter", "setPromoter", "PromoGranted", "InsufficientBalance"]) {
      assert.ok(names(pikitShopAbi).has(n), n);
    }
    // D107: 예산은 증감만(덮어쓰기는 오래된 읽기로 그사이 지급을 되살린다)
    for (const n of ["setPromoBudget", "PromoBudgetSet"]) assert.ok(!names(pikitShopAbi).has(n), `${n} removed`);
    // D105: MON 길·하우스 준비금이 없다 (지운 것은 다시 생기지 않는다)
    for (const n of ["buy", "quote", "withdraw", "fundHouse", "houseState", "vault", "reserveJackpots", "setReserveJackpots", "ReserveTooLow", "CREDIT_WEI", "IncorrectPayment", "InvalidSeq"]) {
      assert.ok(!names(pikitShopAbi).has(n), `${n} removed`);
    }
    const shopAbi: readonly { type: string; name?: string; stateMutability?: string; inputs?: readonly { name: string; components?: readonly { name: string }[] }[] }[] = pikitShopAbi;
    assert.ok(shopAbi.every((x) => x.stateMutability !== "payable"), "nothing payable");
    assert.ok(shopAbi.every((x) => x.type !== "receive" && x.type !== "fallback"), "no receive/fallback");
    const intent = shopAbi.find((x) => x.name === "buyWithCredits")!.inputs![0]!;
    assert.deepEqual(intent.components!.map((c) => c.name), ["wallet", "sessionKey", "roomId", "rulesHash", "tiers", "nonce", "deadline"], "CreditIntent has no promo flag");
    for (const n of ["skipMissedBatches", "canSkipBatches", "salesStartBlock", "resumeBlock", "SKIP_LEAD", "BatchesSkipped"]) assert.ok(names(pikitFairnessAbi).has(n), n);
    const end = pikitShopAbi.find((x) => x.type === "function" && x.name === "settleEnd")!;
    assert.deepEqual(end.inputs.map((i) => i.name), ["purchaseId", "itemIndex", "kind", "payoutMilli", "overMilli"]);
    assert.equal(end.inputs.find((i) => i.name === "kind")!.type, "uint8", "SettleKind는 uint8 (0 Reward, 1 Refund — 개정 6에 Jackpot 없음)");
    const settled = pikitShopAbi.find((x) => x.type === "event" && x.name === "Settled")!;
    assert.deepEqual(settled.inputs.map((i) => i.name), ["purchaseId", "itemIndex", "buyer", "kind", "payoutMilli", "overMilli"]);
  });

  it("rejects an input log with unordered windows", () => {
    assert.throws(() => InputLog.parse({
      schema: "pikit.inputlog/v0", rulesHash: h32, chainId: 143, shop: addr, roomId: 1, seed: h32, firstWindow: 0, lastWindow: 10,
      windows: [{ window: 5, inputs: [] }, { window: 3, inputs: [] }],
    }));
  });
});

describe("bonus table in the catalog", () => {
  it("the example catalog: POP + BIG POP only (no patterns, no escalation — rules 7) and 3 bots", () => {
    const c = parseCatalog(example) as unknown as Record<string, unknown> & { reward: Record<string, unknown>; bots: { count: number }[] };
    assert.equal(c.reward.patterns, undefined);
    assert.equal(c.reward.streakEscalation, undefined);
    assert.equal(c.bots.reduce((s, b) => s + b.count, 0), 3, "오너 결정 2026-10-06: 봇 3개");
    const x = structuredClone(example) as { reward: Record<string, unknown> };
    x.reward.patterns = [];
    assert.throws(() => parseCatalog(x), /patterns|Unrecognized/, "패턴 칸은 지웠다(원칙 2)");
  });
});

describe("feed / queue / live state", () => {
  const addr = `0x${"ab".repeat(20)}`;
  const feed = {
    seq: 12, kind: "BIG_POP", roomId: 1, playerShortId: shortPlayerId(addr), itemKey: "8812:0", tier: 4, amountMilli: 4000000,
    streakCount: 3, endReason: null, tick: 4410, blockNumber: 52103441,
  };

  it("shortPlayerId keeps 4 + 4 hex digits and never the full address", () => {
    assert.equal(shortPlayerId(`0x1234${"0".repeat(32)}ABCD`), "0x1234…abcd");
    assert.throws(() => shortPlayerId("0x1234"));
    assert.throws(() => FeedEvent.parse({ ...feed, playerShortId: addr }), "전체 주소는 피드에 못 들어간다");
  });

  it("FeedEvent (rules 7): POP · BIG_POP; endReason only on end events; no JACKPOT / PATTERN / STREAK; sky events carry skyId", () => {
    FeedEvent.parse(feed);
    FeedEvent.parse({ ...feed, kind: "POP", streakCount: 2 });
    FeedEvent.parse({ ...feed, kind: "BIG_PAYOUT", endReason: "DURABILITY", amountMilli: 18000000, overMilli: 6000000 });
    assert.throws(() => FeedEvent.parse({ ...feed, kind: "PICKAXE_END", overMilli: 0 }), "끝 사건에는 endReason");
    assert.throws(() => FeedEvent.parse({ ...feed, kind: "PICKAXE_END", endReason: "DURABILITY" }), "끝 사건에는 overMilli(0 포함)");
    assert.throws(() => FeedEvent.parse({ ...feed, overMilli: 0 }), "overMilli는 끝 사건에만");
    for (const kind of ["JACKPOT", "PATTERN", "STREAK", "BUFF"]) assert.throws(() => FeedEvent.parse({ ...feed, kind }), kind);
    assert.throws(() => FeedEvent.parse({ ...feed, patternId: null }), "patternId 칸은 없다(strict)");
    assert.throws(() => FeedEvent.parse({ ...feed, prize: "GOLD" }), "prize 칸은 없다(strict)");
    FeedEvent.parse({ ...feed, kind: "SKY_DROP", amountMilli: 0, skyId: 52103441 });
    FeedEvent.parse({ ...feed, kind: "SKY_CATCH", amountMilli: 0, skyId: 52103441 });
    assert.throws(() => FeedEvent.parse({ ...feed, kind: "SKY_CATCH", amountMilli: 0 }), "SKY_CATCH에는 skyId가 있다");
    assert.throws(() => FeedEvent.parse({ ...feed, kind: "POP", skyId: 7 }), "skyId는 하늘 사건에만");
    assert.throws(() => FeedEvent.parse({ ...feed, kind: "SKY_DROP", amountMilli: 0, skyId: -1 }), "skyId는 u32");
  });

  it("BIG_PAYOUT only for a true win: paid > price (D46 revised — no celebration of partial losses)", () => {
    assert.equal(isBigPayout(3_000_001, 3_000_000), true);
    assert.equal(isBigPayout(3_000_000, 3_000_000), false, "break-even is not a win");
    assert.equal(isBigPayout(2_910_000, 3_000_000), false, "0.97× (old cap) is a loss");
    assert.equal(isBigPayout(2_700_000, 3_000_000), false, "0.9× was BIG_PAYOUT before, now a loss");
    assert.equal(isBigPayout(0, 3_000_000), false);
  });

  it("QueueState rejects more items than queueMax", () => {
    const item = { itemKey: "8812:1", tier: 4, priceMilli: 15000000 };
    const q = { roomId: 1, playerShortId: shortPlayerId(addr), activeItemKey: "8812:0", items: [item], queueMax: 1, nextSpawnWindow: 100 };
    QueueState.parse(q);
    assert.throws(() => QueueState.parse({ ...q, items: [item, { ...item, itemKey: "8812:2" }] }));
  });

  it("PickaxeLiveState carries no server-only fields", () => {
    const live = {
      itemKey: "8812:0", playerShortId: null, tier: 4, x: 3.2, y: 40.5, angle: 1.1, scale: 2,
      durabilityLeftBps: 10000, earnedMilli: 0, bonusMilli: 0, streakCount: 0, popTargetKind: -1, luckyKind: -1,
    };
    PickaxeLiveState.parse(live);
    PickaxeLiveState.parse({ ...live, luckyKind: 9 });
    assert.throws(() => PickaxeLiveState.parse({ ...live, luckyKind: undefined }), "luckyKind는 꼭 있다");
    PickaxeLiveState.parse({ ...live, popTargetKind: 3 });
    assert.throws(() => PickaxeLiveState.parse({ ...live, popTargetKind: -2 }));
    assert.throws(() => PickaxeLiveState.parse({ ...live, vx: 0.1 }), "속도는 화면 형식에 없다(strict)");
    assert.throws(() => PickaxeLiveState.parse({ ...live, buffs: [], twin: null }), "버프·쌍둥이 칸은 없다(D99)");
  });

  it("PickaxeHistoryRecord carries the bonus event summary, LUCKY and the settleEnd split (payout + over)", () => {
    const rec = {
      itemKey: "8812:0", owner: addr, roomId: 1, tier: 4, priceCredits: 20000, rulesVersion: 7, spawnWindow: 10, spawnTick: 0,
      endWindow: 200, endTick: 1500, endReason: "DURABILITY", hits: 40, distinctBlocks: 30, blocksBroken: 12, durabilityUsed: 22160,
      durabilityTotal: 22160, pop: true, bigPop: true, luckyKind: 9, baseMilli: 11000000, luckyMilli: 5000000, bonusMilli: 8317000,
      paidMilli: 18000000, overMilli: 6317000, pnlMilli: 4317000,
      events: [
        { kind: "POP", tick: 77, window: 19, blockKind: 3, streakCount: 2, prizeMilli: 4317000, paidMilli: 4317000 },
        { kind: "BIG_POP", tick: 90, window: 21, blockKind: 3, streakCount: 3, prizeMilli: 4000000, paidMilli: 4000000 },
      ],
    };
    PickaxeHistoryRecord.parse(rec);
    assert.throws(() => PickaxeHistoryRecord.parse({ ...rec, gatePrize: null }), "입구 칸은 없다");
    assert.throws(() => PickaxeHistoryRecord.parse({ ...rec, jackpotMilli: 0 }), "jackpot 칸은 없다");
    assert.throws(() => PickaxeHistoryRecord.parse({ ...rec, events: [{ ...rec.events[0], kind: "STREAK" }] }));
  });

  it("Payout / SettledEvent / SettlementRecord (rules 7 settleEnd): one row per pickaxe, over only on REWARD", () => {
    const pay = {
      itemKey: "8812:0", purchaseId: "8812", itemIndex: 0, owner: addr, roomId: 1, tier: 0, priceMilli: 1_000_000,
      kind: "REWARD", cause: "END", payoutMilli: 900_000, overMilli: 120_500, window: 99,
    };
    Payout.parse(pay);
    Payout.parse({ ...pay, kind: "REFUND", cause: "ABNORMAL_END", payoutMilli: 1_000_000, overMilli: 0 });
    assert.throws(() => Payout.parse({ ...pay, kind: "REFUND", cause: "ABNORMAL_END" }), "over는 REWARD에만");
    assert.throws(() => Payout.parse({ ...pay, kind: "JACKPOT", cause: "GATE" }), "JACKPOT·GATE는 없다");
    assert.throws(() => Payout.parse({ ...pay, cause: "CANCEL" }), "REWARD ⇔ END");
    assert.deepEqual(SETTLE_KIND_ONCHAIN, { REWARD: 0, REFUND: 1 });
    const h32 = `0x${"11".repeat(32)}`;
    const ev = { chainId: 143, blockNumber: 5, blockHash: h32, txHash: h32, logIndex: 0, purchaseId: "8812", itemIndex: 0, buyer: addr, kind: "REWARD", payoutMilli: "900000", overMilli: "120500" };
    SettledEvent.parse(ev);
    assert.throws(() => SettledEvent.parse({ ...ev, kind: "REFUND" }), "over는 REWARD에만");
    assert.throws(() => SettledEvent.parse({ ...ev, overMilli: undefined }), "overMilli는 늘 보낸다(0 포함)");
    SettlementRecord.parse({ purchaseId: "8812", itemIndex: 0, buyer: addr, kind: "REFUND", payoutMilli: "5", overMilli: "0", blockNumber: 5, txHash: h32 });
  });
});

describe("batch lock (spec 08, D113)", () => {
  const item = {
    index: 0, itemKey: "77:0", tier: 0, priceMilli: 1_000_000, phase: "WAITING", endCause: null, payoutMilli: null, overMilli: 0, endedAt: null,
  };
  const batch = {
    id: "r12", relayId: 12, nonce: "5", purchaseId: "77", roomId: 1, createdAt: "2026-10-11T00:00:00.000Z",
    items: [item, { ...item, index: 1, itemKey: "77:1", tier: 2, priceMilli: 5_000_000, phase: "ENDED", endCause: "END", payoutMilli: 812_000, endedAt: "2026-10-11T00:01:00.000Z" }],
  };

  it("BatchView: items in index order, id r<relay>|p<purchase>, phases and endCause; MeView.batch is required and nullable", () => {
    BatchView.parse(batch);
    BatchView.parse({ ...batch, id: "p77", relayId: null, nonce: null });
    BatchView.parse({ ...batch, purchaseId: null, items: [{ ...item, itemKey: null, phase: "SENDING" }] });
    assert.throws(() => BatchView.parse({ ...batch, id: "x12" }), "id는 r 또는 p로 시작");
    assert.throws(() => BatchView.parse({ ...batch, id: "r012" }), "앞자리 0 없음");
    assert.throws(() => BatchView.parse({ ...batch, items: [batch.items[1], batch.items[0]] }), "칸은 index 순서");
    assert.throws(() => BatchView.parse({ ...batch, items: [] }), "빈 묶음은 없다(null)");
    assert.throws(() => BatchView.parse({ ...batch, items: Array.from({ length: 11 }, (_, i) => ({ ...item, index: i })) }), "최대 10칸");
    assert.throws(() => BatchView.parse({ ...batch, items: [{ ...item, phase: "SPAWNING" }] }), "SPAWNING은 화면만");
    assert.throws(() => BatchView.parse({ ...batch, items: [{ ...item, endCause: "GATE" }] }), "GATE는 끝 원인이 아니다");
    for (const cause of ["END", "ABNORMAL_END", "CANCEL", "OVERFLOW", "QUEUE_REFUND"]) BatchView.parse({ ...batch, items: [{ ...item, endCause: cause }] });

    const addr = `0x${"ab".repeat(20)}`;
    const me = {
      address: addr, playerShortId: shortPlayerId(addr), nickname: null, balances: { promoMilli: "0", blockNumber: 1 },
      pending: { settlingMilli: 0, activeEarnedMilli: 0 }, activePickaxes: [], queues: [], sessionKey: null, nextIntentNonce: "0",
    };
    MeView.parse({ ...me, batch: null });
    MeView.parse({ ...me, batch });
    assert.throws(() => MeView.parse(me), "batch 칸은 꼭 있다(없으면 null)");
  });

  it("RelayRefusalCode BATCH_OPEN has a fixed user message (M-1)", () => {
    assert.equal(RelayRefusalCode.parse("BATCH_OPEN"), "BATCH_OPEN");
    assert.equal(relayCodeMessage("BATCH_OPEN"), RELAY_CODE_MESSAGES.BATCH_OPEN);
    assert.match(RELAY_CODE_MESSAGES.BATCH_OPEN, /previous batch/);
  });
});
