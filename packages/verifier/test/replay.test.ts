// 골든 재생: 기록해 둔 입력 기록(fixtures/golden-1.log.json)이 언제 어디서 돌려도 같은 끝 상태 해시·정산을 내는지 본다.
// (D125) golden-2 = 지갑 7개가 쉬지 않는 바쁜 판 — 하늘 별 DROP·CAUGHT(가로채기 포함)·EXPIRED가 모두 들어간다.
// (규칙 7) golden-3 = BIG POP·LUCKY 몫·1배 넘는 지급(over)이 모두 나오는 짧은 판 — 정산 기록(settleEnd 한 칸)의 over 대조까지 본다.
// (규칙 9) golden-3에 막타(lastHits > 0)도 나와야 한다. 규칙 9는 물리·판을 바꾸지 않아 golden-2 시드 0x62·golden-3 시드 2가 그대로다.
// (규칙 10, 명세 23) HP 사다리 ×1.7이라 golden-1·2·3 값이 바뀐다(물리 무변경 증거는 엔진의 "규칙 9 카탈로그 재생 = 옛 해시" 시험).
//   golden-3에 LUCKY PICK 단계(pickLevelBps > 0)도 나와야 한다. golden-4 = 시험 카탈로그(minPool 1·총상한 1.1×)로 잭팟 균열 + 총상한 클램프.
//   시드는 `_analysis/rules10/kit/golden-seeds.mjs`로 찾는다.
// 엔진 규칙을 일부러 바꿨다면 `UPDATE_GOLDEN=1 pnpm --filter @pikit/verifier test`로 기대값을 다시 쓰고, 바뀐 이유를 커밋에 적는다.
import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";
import { canonicalHash, parseCatalog, type InputLog } from "@pikit/protocol";
import { replay, type ReplayReport } from "../src/index.js";

const fixturesDir = fileURLToPath(new URL("../../test/fixtures/", import.meta.url));
const catalogJson = JSON.parse(readFileSync(fileURLToPath(import.meta.resolve("@pikit/protocol/catalog.example.json")), "utf8")) as unknown;
const A = "0xa11ce00000000000000000000000000000000001";
const B = "0xb0b0000000000000000000000000000000000002";
const C = "0xc0c0000000000000000000000000000000000003";

/**
 * 손으로 짠 입력 기록 (모든 구매는 체인 Purchased — 10진 purchaseId).
 * 묶음 구매, 한 개 구매, 구매 + 취소, 대기열 넘침, 무효 구매(+ 두 번째 무효·늦은 같은 번호 구매 = ALREADY_VOID),
 * 방 닫힘(돌던 곡괭이 비정상 종료 + 대기열 환불), 블록 해시가 있는 윈도.
 */
function buildGoldenLog(): InputLog {
  const h = (n: number) => `0x${n.toString(16).padStart(2, "0").repeat(32)}`;
  return {
    schema: "pikit.inputlog/v0",
    rulesHash: canonicalHash(parseCatalog(catalogJson)),
    chainId: 143,
    shop: "0x5b0b000000000000000000000000000000000005",
    roomId: 1,
    seed: h(0x42),
    firstWindow: 1000,
    lastWindow: 1700,
    windows: [
      { window: 1001, blockHash: h(1), inputs: [{ type: "purchase", ref: "8812", owner: A, tiers: [4, 4, 0] }] },
      { window: 1002, blockHash: h(2), inputs: [{ type: "purchase", ref: "8813", owner: B, tiers: [0] }] },
      { window: 1040, inputs: [{ type: "purchase", ref: "8814", owner: B, tiers: [2, 1] }] },
      { window: 1041, inputs: [{ type: "cancel", owner: B, itemKey: "8814:1" }] },
      { window: 1100, inputs: [
        { type: "purchase", ref: "8815", owner: C, tiers: [0, 0, 0, 0, 0, 0, 0, 0, 0, 0] },
        { type: "purchase", ref: "8816", owner: C, tiers: [1, 1] },
      ] },
      { window: 1101, inputs: [{ type: "voidPurchase", ref: "8815", owner: C }] },
      { window: 1102, inputs: [{ type: "voidPurchase", ref: "8815", owner: C }, { type: "purchase", ref: "8815", owner: C, tiers: [0] }] },
      { window: 1300, blockHash: h(3), inputs: [{ type: "purchase", ref: "8817", owner: B, tiers: [0] }] },
      { window: 1450, inputs: [{ type: "purchase", ref: "8820", owner: A, tiers: [3] }] },
      { window: 1640, inputs: [{ type: "purchase", ref: "8821", owner: C, tiers: [4, 2] }] },
      { window: 1650, blockHash: h(4), inputs: [{ type: "freeze", reason: "ROOM_CLOSED" }] },
    ],
  };
}

/**
 * 지갑 7개가 1·1000·2000번째 윈도에 10개씩 사는 바쁜 판 (D125 golden-2). 시드는 별이 사라지는 경우까지 들어가게 골랐다
 * (규칙 7 물리로 다시 골라 0x61 → 0x6d, 규칙 8(D215) 판 구성으로 0x62, CHOG 고정 줄(D215 개정)·규칙 9(D228)·규칙 10(HP ×1.7 — 값은 바뀜)에서도 0x62: 0x61부터 찾아 DROP·CAUGHT(가로채기·제 별)·EXPIRED가
 * 모두 나오는 첫 시드 — `_analysis/sim-rules8-chog-2026-10-14/golden-seeds.mjs`).
 */
function buildGolden2Log(): InputLog {
  const h = (n: number) => `0x${n.toString(16).padStart(2, "0").repeat(32)}`;
  const wallets = Array.from({ length: 7 }, (_, i) => `0x${"abcdef7"[i]!.repeat(4)}${"0".repeat(35)}${i + 1}`);
  return {
    schema: "pikit.inputlog/v0",
    rulesHash: canonicalHash(parseCatalog(catalogJson)),
    chainId: 143,
    shop: "0x5b0b000000000000000000000000000000000005",
    roomId: 2,
    seed: h(0x62),
    firstWindow: 5000,
    lastWindow: 8000,
    windows: [5001, 6000, 7000].map((window, b) => ({
      window,
      blockHash: h(0x10 + b),
      inputs: wallets.map((owner, i) => ({ type: "purchase" as const, ref: String(9000 + b * 10 + i), owner, tiers: Array.from({ length: 10 }, (_, j) => (i + j + b) % 5) })),
    })),
  };
}

/**
 * 지갑 3개가 같은 윈도에 FE·CU·AG를 하나씩 사는 300윈도 판 (규칙 7 golden-3).
 * 시드는 BIG POP·LUCKY 몫(luckyMilli > 0)·over(1배 넘는 지급, overMilli > 0)가 모두 나오는 첫 시드로 골랐다
 * (1부터 찾아 규칙 7은 2, 규칙 8(D215)은 1, CHOG 고정 줄(D215 개정)은 2, 규칙 9(D228, 막타 조건 추가)도 2, 규칙 10(HP ×1.7 + LUCKY PICK 단계 조건)은 1
 * — `_analysis/rules10/kit/golden-seeds.mjs`).
 */
function buildGolden3Log(): InputLog {
  const h = (n: number) => `0x${n.toString(16).padStart(2, "0").repeat(32)}`;
  const wallets = [1, 2, 3].map((i) => `0xd1a0${"0".repeat(35)}${i}`);
  return {
    schema: "pikit.inputlog/v0",
    rulesHash: canonicalHash(parseCatalog(catalogJson)),
    chainId: 143,
    shop: "0x5b0b000000000000000000000000000000000005",
    roomId: 3,
    seed: h(1),
    firstWindow: 20000,
    lastWindow: 20300,
    windows: [{ window: 20001, blockHash: h(0x70), inputs: wallets.map((owner, i) => ({ type: "purchase" as const, ref: String(7000 + i), owner, tiers: [0, 1, 2] })) }],
  };
}

describe("golden replay", () => {
  const logPath = `${fixturesDir}golden-1.log.json`;
  const expectedPath = `${fixturesDir}golden-1.expected.json`;

  if (process.env.UPDATE_GOLDEN === "1" || !existsSync(logPath)) {
    mkdirSync(fixturesDir, { recursive: true });
    const log = buildGoldenLog();
    writeFileSync(logPath, `${JSON.stringify(log, null, 2)}\n`);
    writeFileSync(expectedPath, `${JSON.stringify(replay(catalogJson, log), null, 2)}\n`);
  }
  const recordedLog = JSON.parse(readFileSync(logPath, "utf8")) as unknown;
  const expected = JSON.parse(readFileSync(expectedPath, "utf8")) as ReturnType<typeof replay>;

  it("the recorded fixture is exactly the hand-built log (fixture not edited by hand)", () => {
    assert.deepEqual(recordedLog, buildGoldenLog());
  });

  it("replays to the recorded final state hash and per-pickaxe payouts", () => {
    const report = replay(catalogJson, recordedLog);
    assert.ok(report.pickaxes.filter((p) => p.status === "ENDED").length >= 4, "골든 시나리오에 끝난 곡괭이가 있어야 함");
    const causes = new Set(report.payouts.map((p) => p.cause));
    for (const c of ["END", "ABNORMAL_END", "CANCEL", "OVERFLOW", "QUEUE_REFUND"]) assert.ok(causes.has(c as never), `정산 종류 ${c}가 있어야 함`);
    assert.ok(!report.payouts.some((p) => p.purchaseId === "8815"), "무효 구매는 정산이 없다");
    assert.ok(report.pickaxes.some((p) => p.endReason === "VOID"));
    assert.ok(report.pickaxes.some((p) => p.events.length > 0), "보너스 사건이 있어야 함");
    for (const p of report.payouts) assert.equal(p.key, `${p.purchaseId}:${p.itemIndex}`);
    assert.strictEqual(report.finalStateHash, expected.finalStateHash);
    assert.deepEqual(report, expected);
  });

  it("is independent of JSON key order / whitespace of the input files", () => {
    const shuffled = JSON.parse(JSON.stringify(recordedLog, Object.keys(recordedLog as object).reverse())) as unknown;
    const reformatted = JSON.parse(JSON.stringify(recordedLog, null, 7)) as unknown;
    assert.strictEqual(replay(catalogJson, reformatted).finalStateHash, expected.finalStateHash);
    assert.strictEqual(replay(catalogJson, { ...(shuffled as object), ...(recordedLog as object) }).finalStateHash, expected.finalStateHash);
  });

  it("any change to an input changes the hash (tampering is visible)", () => {
    const tampered = structuredClone(buildGoldenLog());
    tampered.windows[0]!.inputs[0] = { type: "purchase", ref: "8812", owner: A, tiers: [4, 4, 1] };
    assert.notStrictEqual(replay(catalogJson, tampered).finalStateHash, expected.finalStateHash);
    const otherBlockHash = structuredClone(buildGoldenLog());
    otherBlockHash.windows[0]!.blockHash = `0x${"ff".repeat(32)}`;
    assert.notStrictEqual(replay(catalogJson, otherBlockHash).finalStateHash, expected.finalStateHash);
  });

  it("refuses a log recorded under a different catalog (rulesHash)", () => {
    const changed = structuredClone(catalogJson) as { reward: { rewardCapBps: number } };
    changed.reward.rewardCapBps -= 1;
    assert.throws(() => replay(changed, recordedLog), /rulesHash mismatch/);
  });

  it("(D125) golden-1 has 3 wallets → never ≥ 5 on the board → no sky events", () => {
    assert.deepEqual(expected.sky, []);
  });
});

describe("golden replay 2 — busy board with sky stars (D125)", () => {
  const logPath = `${fixturesDir}golden-2.log.json`;
  const expectedPath = `${fixturesDir}golden-2.expected.json`;
  if (process.env.UPDATE_GOLDEN === "1" || !existsSync(logPath)) {
    const log = buildGolden2Log();
    writeFileSync(logPath, `${JSON.stringify(log, null, 2)}\n`);
    writeFileSync(expectedPath, `${JSON.stringify(replay(catalogJson, log), null, 2)}\n`);
  }
  const recordedLog = JSON.parse(readFileSync(logPath, "utf8")) as unknown;
  const expected = JSON.parse(readFileSync(expectedPath, "utf8")) as ReturnType<typeof replay>;

  it("the recorded fixture is exactly the hand-built log", () => {
    assert.deepEqual(recordedLog, buildGolden2Log());
  });

  it("replays to the recorded final hash, payouts and sky events (DROP, CAUGHT incl. an interception, EXPIRED)", () => {
    const report = replay(catalogJson, recordedLog);
    const kinds = new Set(report.sky.map((e) => e.kind));
    for (const k of ["DROP", "CAUGHT", "EXPIRED"] as const) assert.ok(kinds.has(k), `하늘 사건 ${k}가 있어야 함`);
    const dropKey = new Map(report.sky.filter((e) => e.kind === "DROP").map((e) => [e.id, e.key]));
    assert.ok(report.sky.some((e) => e.kind === "CAUGHT" && dropKey.get(e.id) !== e.key), "고른 곡괭이가 아닌 곡괭이가 잡은 경우(가로채기)가 있어야 함");
    assert.ok(report.sky.some((e) => e.kind === "CAUGHT" && dropKey.get(e.id) === e.key));
    for (const e of report.sky) {
      if (e.kind === "EXPIRED") assert.equal(e.owner, null);
      else assert.ok(e.owner && /^0x[0-9a-f]{40}$/.test(e.owner));
    }
    assert.strictEqual(report.finalStateHash, expected.finalStateHash);
    assert.deepEqual(report, expected);
  });

  it("a different block hash moves the stars (they come from the window seed only)", () => {
    const other = structuredClone(buildGolden2Log());
    other.windows[0]!.blockHash = `0x${"ee".repeat(32)}`;
    const r = replay(catalogJson, other);
    assert.notDeepEqual(r.sky, expected.sky);
  });
});

describe("golden replay 3 — BIG POP, LUCKY, LAST HIT and over (rules 7, re-seeded for rules 8, LAST HIT rules 9)", () => {
  const logPath = `${fixturesDir}golden-3.log.json`;
  const expectedPath = `${fixturesDir}golden-3.expected.json`;
  if (process.env.UPDATE_GOLDEN === "1" || !existsSync(logPath)) {
    const log = buildGolden3Log();
    writeFileSync(logPath, `${JSON.stringify(log, null, 2)}\n`);
    writeFileSync(expectedPath, `${JSON.stringify(replay(catalogJson, log), null, 2)}\n`);
  }
  const recordedLog = JSON.parse(readFileSync(logPath, "utf8")) as unknown;
  const expected = JSON.parse(readFileSync(expectedPath, "utf8")) as ReturnType<typeof replay>;
  const report = replay(catalogJson, recordedLog);

  it("the recorded fixture is exactly the hand-built log", () => {
    assert.deepEqual(recordedLog, buildGolden3Log());
  });

  it("replays to the recorded final hash; has a BIG POP, a LUCKY share, a LAST HIT and an over-price end, one settlement per pickaxe", () => {
    assert.ok(report.pickaxes.some((p) => p.bigPop && p.events.some((e) => e.kind === "BIG_POP")), "BIG POP이 있어야 함");
    assert.ok(report.pickaxes.some((p) => p.luckyMilli > 0), "LUCKY 몫이 있어야 함");
    assert.ok(report.pickaxes.some((p) => p.lastHits > 0 && p.lastHitMilli > 0), "막타가 있어야 함 (규칙 9)");
    const over = report.payouts.filter((p) => p.overMilli > 0);
    assert.ok(over.length > 0, "over > 0 정산이 있어야 함");
    assert.ok(over.every((p) => p.kind === "REWARD" && p.cause === "END"), "over는 정상 종료 REWARD에만");
    for (const pay of report.payouts.filter((p) => p.cause === "END")) {
      const p = report.pickaxes.find((x) => x.key === pay.key)!;
      // (규칙 10) payout + over = 번 값 X(네 몫) + 사다리 보충 + 잭팟 (X < 총상한 40× — 이 판에서 클램프 없음)
      assert.equal(pay.payoutMilli + pay.overMilli, p.baseMilli + p.luckyMilli + p.bonusMilli + p.lastHitMilli + p.pickMilli + p.jackpotMilli, `정상 종료 ${pay.key}: payout + over = X + pick + J`);
      assert.deepEqual([p.paidMilli, p.overMilli, p.endWindow], [pay.payoutMilli, pay.overMilli, pay.window]);
    }
    const keys = report.payouts.map((p) => p.key);
    assert.equal(new Set(keys).size, keys.length, "곡괭이마다 정산 하나");
    assert.strictEqual(report.finalStateHash, expected.finalStateHash);
    assert.deepEqual(report, expected);
  });

  it("(rules 10) has a LUCKY PICK level; the floor holds: payout + over ≥ ⌊P × m⌋, pickMilli = T_main − min(X, cap); luckyPicks = the spawns with a level", () => {
    const leveled = report.pickaxes.filter((p) => p.pickLevelBps > 0);
    assert.ok(leveled.length > 0, "LUCKY PICK 단계가 있어야 함 (규칙 10)");
    assert.deepEqual(report.luckyPicks.map((e) => e.key).sort(), leveled.map((p) => p.key).sort(), "단계가 있는 곡괭이 = luckyPicks 사건");
    for (const e of report.luckyPicks) assert.ok(e.pickLevelBps > 10_000 && e.window > 20000 && e.window <= 20300, `${e.key}`);
    for (const p of report.pickaxes.filter((x) => x.status === "ENDED" && x.endReason !== "VOID")) {
      const pay = report.payouts.find((x) => x.key === p.key)!;
      const T = pay.payoutMilli + pay.overMilli;
      assert.ok(T >= Math.floor((p.priceMilli * p.pickLevelBps) / 10_000) || pay.kind === "REFUND", `${p.key}: 바닥`);
      assert.ok(p.pickMilli >= 0 && p.jackpotMilli === 0, `${p.key}: 보충 ≥ 0, 시험 판에는 잭팟 없음 (통 < Q_min)`);
    }
    assert.ok(report.jackpot.poolMilli > 0 && report.jackpot.poolMilli < 20_000_000, "통 < Q_min (출시 카탈로그): 기여만 쌓임");
    assert.deepEqual([report.jackpots, report.jackpot.contributedMilli], [[], report.jackpot.poolMilli]);
  });
});

/**
 * (규칙 10) golden-4 시험 카탈로그 = 출시 카탈로그 + 총상한 1.1×(좋은 곡괭이가 클램프됨) + ×1.1 단계 하나(20 %)
 * + 잭팟 chog_gold, 기여 1 bps 모든 등급(통이 Q_min 근처에 머물러 q = κ·P ÷ 통이 크다), κ 49 ppm, minPoolCredits 1 (κ × 최고가 20,000 < 1 × 10⁶).
 * `_analysis/rules10/kit/golden-seeds.mjs` golden4Catalog()와 같아야 한다.
 */
function buildGolden4Catalog(): unknown {
  const c = structuredClone(catalogJson) as { reward: object; pickaxes: unknown[]; luckyPick?: unknown; jackpot?: unknown };
  c.reward = { ...c.reward, totalCapBps: 11_000 };
  c.luckyPick = { levels: [{ multBps: 11_000, per10m: 2_000_000 }] };
  c.jackpot = { kindId: "chog_gold", contributionBpsByTier: c.pickaxes.map(() => 1), kappaPpm: 49, minPoolCredits: 1 };
  return c;
}

/** 지갑 8개가 두 윈도에 10개씩 사는 판 (규칙 10 golden-4). 시드는 균열 ≥ 1과 총상한 클램프 ≥ 1이 나오는 첫 시드. */
function buildGolden4Log(): InputLog {
  const h = (n: number) => `0x${n.toString(16).padStart(2, "0").repeat(32)}`;
  const wallets = [1, 2, 3, 4, 5, 6, 7, 8].map((i) => `0x4a4a${"0".repeat(35)}${i}`);
  return {
    schema: "pikit.inputlog/v0",
    rulesHash: canonicalHash(parseCatalog(buildGolden4Catalog())),
    chainId: 143,
    shop: "0x5b0b000000000000000000000000000000000005",
    roomId: 4,
    seed: h(GOLDEN4_SEED),
    firstWindow: 30000,
    lastWindow: 32000,
    windows: [30001, 31000].map((window, b) => ({
      window,
      blockHash: h(0x40 + b),
      inputs: wallets.map((owner, i) => ({ type: "purchase" as const, ref: String(4000 + b * 10 + i), owner, tiers: Array.from({ length: 10 }, (_, j) => (i + j + b) % 5) })),
    })),
  };
}
const GOLDEN4_SEED = 1;

describe("golden replay 4 — jackpot crack and total-cap clamp (rules 10, test catalog)", () => {
  const logPath = `${fixturesDir}golden-4.log.json`;
  const catalogPath = `${fixturesDir}golden-4.catalog.json`;
  const expectedPath = `${fixturesDir}golden-4.expected.json`;
  const cat4 = buildGolden4Catalog();
  if (process.env.UPDATE_GOLDEN === "1" || !existsSync(logPath)) {
    const log = buildGolden4Log();
    writeFileSync(catalogPath, `${JSON.stringify(cat4, null, 2)}\n`);
    writeFileSync(logPath, `${JSON.stringify(log, null, 2)}\n`);
    writeFileSync(expectedPath, `${JSON.stringify(replay(cat4, log), null, 2)}\n`);
  }
  const recordedLog = JSON.parse(readFileSync(logPath, "utf8")) as unknown;
  const expected = JSON.parse(readFileSync(expectedPath, "utf8")) as ReplayReport;
  const report = replay(cat4, recordedLog);
  const cap = (p: { priceMilli: number }) => Math.floor((p.priceMilli * 11_000) / 10_000);

  it("the recorded fixtures are exactly the hand-built log and test catalog", () => {
    assert.deepEqual(recordedLog, buildGolden4Log());
    assert.deepEqual(JSON.parse(readFileSync(catalogPath, "utf8")), cat4);
  });

  it("replays to the recorded final hash and events", () => {
    assert.strictEqual(report.finalStateHash, expected.finalStateHash);
    assert.deepEqual(report, expected);
  });

  it("a crack pays the whole pool to one pickaxe (amount = pool before, pool after 0), at most once per pickaxe; the pool adds up", () => {
    assert.ok(report.jackpots.length >= 1, "균열이 있어야 함");
    const keys = report.jackpots.map((j) => j.key);
    assert.equal(new Set(keys).size, keys.length, "곡괭이당 잭팟 1번");
    for (const j of report.jackpots) {
      assert.equal(j.poolAfterMilli, 0);
      assert.ok(j.amountMilli >= 1000, "통 ≥ Q_min(1 크레딧)일 때만 균열");
      assert.equal(j.blockKind, 11, "골든 CHOG");
      const p = report.pickaxes.find((x) => x.key === j.key)!;
      assert.equal(p.jackpotMilli, j.amountMilli);
      assert.ok(/^0x4a4a/.test(j.owner) && p.owner === j.owner, "봇은 뽑지 않는다");
    }
    const paid = report.jackpots.reduce((s, j) => s + j.amountMilli, 0);
    assert.equal(report.jackpot.wins, report.jackpots.length);
    assert.equal(report.jackpot.paidMilli, paid);
    assert.equal(report.jackpot.contributedMilli, report.jackpot.poolMilli + report.jackpot.paidMilli, "contributed = pool + paid");
  });

  it("settlement T = min(cap, max(X, floor)) + J; a clamp exists; J rides outside the cap", () => {
    let clamped = 0;
    for (const pay of report.payouts.filter((x) => x.kind === "REWARD" && x.cause === "END")) {
      const p = report.pickaxes.find((x) => x.key === pay.key)!;
      const X = p.baseMilli + p.luckyMilli + p.bonusMilli + p.lastHitMilli;
      const F = Math.floor((p.priceMilli * p.pickLevelBps) / 10_000);
      const main = Math.min(cap(p), Math.max(X, F));
      assert.equal(pay.payoutMilli + pay.overMilli, main + p.jackpotMilli, `${p.key}: T`);
      assert.equal(p.pickMilli, main - Math.min(X, cap(p)), `${p.key}: pickMilli`);
      assert.equal(pay.payoutMilli, Math.min(main + p.jackpotMilli, Math.floor((p.priceMilli * 9000) / 10_000)), `${p.key}: REWARD 상한 0.9 나눔`);
      if (X > cap(p)) clamped += 1;
    }
    assert.ok(clamped >= 1, "총상한 클램프가 있어야 함");
  });
});
