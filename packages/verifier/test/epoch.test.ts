// verify --epoch N: 시드 사슬, 입력 = 체인 사건(H-1), 입력 기록 해시 사슬, 세계 재생과 앵커 루트, 묶음 생성 검사, 체인 정산 대조 (D37~D43, D82, D111).
import assert from "node:assert/strict";
import { before, describe, it } from "node:test";
import { SETTLE_STALL } from "@pikit/protocol";
import { FILES_CHECK, LINKAGE_CHECK, PINNED_SHOP_CHECK, SETTLE_CHECK, StaticChainSource, verifyEpochs, type EpochBundle, type EpochVerifyReport, type LinkMismatchCode } from "../src/index.js";
import { buildDemoBundle, EPOCHS, INPUT_CHEATS, LAST_EPOCH_SETTLE_LIMIT, PAYOUT_CHEATS, W0, type Cheat, type DemoBundle, type PayoutCheat } from "./demo-bundle.js";

type Json = Record<string, unknown> & { [k: string]: any };   // eslint 없음: 시험에서 JSON을 고쳐 보기 위한 느슨한 타입

function asBundle(d: DemoBundle, patch?: (x: { world: Json; chain: Json; epochs: (Json | null)[] }) => void): EpochBundle {
  const world = structuredClone(d.world) as Json;
  const chain = structuredClone(d.chain) as Json;
  const epochs = structuredClone(d.epochs) as (Json | null)[];
  patch?.({ world, chain, epochs });
  return { world, catalogs: d.catalogs, epochs, chain: new StaticChainSource(chain) };
}

const W0_OF = (r: EpochVerifyReport) => r.windows.first;
const failed = (r: EpochVerifyReport) => r.checks.filter((c) => !c.ok).map((c) => c.name);

describe("verify --epoch N (demo bundle: 2 rooms, 7 epochs)", () => {
  let demo: DemoBundle;
  let report: EpochVerifyReport;
  before(async () => {
    demo = buildDemoBundle();
    report = await verifyEpochs(asBundle(demo));
  });

  it("passes every check; covers anchors, completed batches and on-chain settlements", () => {
    assert.deepEqual(failed(report), []);
    assert.ok(report.ok);
    assert.equal(report.epochs, EPOCHS);
    assert.equal(report.anchors.length, EPOCHS);
    assert.equal(report.replayedThrough, report.windows.last);
    assert.ok(report.anchors.every((a) => (a.processedThrough + 2 - W0_OF(report)) % 200 === 0), "P + 1 = 에폭 마지막 윈도");
    assert.ok(report.batches.length >= 1, `끝난 묶음이 있어야 함 (${report.batches.length})`);
    assert.ok(report.anchors.some((a) => a.boardBatchRoot.batches > 0));
    assert.ok(report.checks.some((c) => c.name.startsWith("room 2 batch") && c.ok));
    assert.ok(report.checks.some((c) => c.name.includes("on-chain rulesHash") && c.ok));
    assert.ok(report.checks.some((c) => c.name === SETTLE_CHECK && c.ok));
    assert.equal(report.stateHashes.rooms.length, 2);
  });

  it("matches every on-chain settlement; the lagging tail of the last epoch is reported as unsettled (warning, not failure)", () => {
    const s = report.settlements;
    assert.ok(s.checked > 20, `대조한 정산 ${s.checked}`);
    assert.equal(s.matched, s.checked);
    assert.deepEqual(s.mismatches, []);
    assert.ok(s.unsettled.length > 0, "마지막 에폭은 일부만 정산했다");
    assert.ok(s.unsettled.every((p) => p.purchaseId !== demo.voidPurchaseId), "무효 구매는 unsettled가 아니다");
    assert.ok(report.payouts >= s.matched + s.unsettled.length);
    const chain = demo.chain as Json;
    const lastBlock = Math.max(...chain.settlements.map((x: Json) => x.blockNumber));
    assert.equal(chain.settlements.filter((x: Json) => x.blockNumber === lastBlock).length, LAST_EPOCH_SETTLE_LIMIT);
    // 규칙 7: 곡괭이마다 settleEnd 한 칸 (REWARD·REFUND, over는 같은 기록에)
    const kinds = [...new Set(chain.settlements.map((x: Json) => String(x.kind)))].sort();
    assert.deepEqual(kinds, ["REFUND", "REWARD"]);
    const keys = chain.settlements.map((x: Json) => `${x.purchaseId}:${x.itemIndex}`);
    assert.equal(new Set(keys).size, keys.length, "곡괭이마다 정산 기록 하나");
    assert.ok(chain.settlements.every((x: Json) => x.overMilli === "0" || x.kind === "REWARD"));
  });

  it("fails (E12) on a wrong amount, a wrong kind, a settlement for a VOID item and one for an item the replay never paid", async () => {
    const r = await verifyEpochs(asBundle(demo, ({ chain }) => {
      const reward = chain.settlements.find((x: Json) => x.kind === "REWARD");
      reward.payoutMilli = String(BigInt(reward.payoutMilli) + 1n);
      const refund = chain.settlements.find((x: Json) => x.kind === "REFUND");
      refund.kind = "REWARD";
      const at = chain.settlements[0].blockNumber;
      chain.settlements.push({ ...chain.settlements[0], purchaseId: demo.voidPurchaseId, itemIndex: 0, kind: "REFUND", payoutMilli: "3000000", blockNumber: at });
      chain.settlements.push({ ...chain.settlements[0], purchaseId: "999999", itemIndex: 0, blockNumber: at });
    }));
    assert.deepEqual(failed(r), [SETTLE_CHECK]);
    assert.deepEqual(r.settlements.mismatches.map((m) => m.reason).sort(), ["AMOUNT", "KIND", "NOT_PAID", "VOID_PURCHASE"]);
    assert.ok(r.settlements.mismatches.every((m) => m.code === "E12"));
  });

  it("(rules 7 §10) fails on a tampered overMilli (AMOUNT) and on a replayed end left without settleEnd past end window + SETTLE_STALL (OVERDUE)", async () => {
    const over = await verifyEpochs(asBundle(demo, ({ chain }) => {
      const reward = chain.settlements.find((x: Json) => x.kind === "REWARD");
      reward.overMilli = String(BigInt(reward.overMilli) + 1n);
    }));
    assert.deepEqual(failed(over), [SETTLE_CHECK]);
    assert.deepEqual(over.settlements.mismatches.map((m) => m.reason), ["AMOUNT"]);
    let dropped = "";
    const late = await verifyEpochs(asBundle(demo, ({ chain }) => {
      const s = chain.settlements.shift();
      dropped = `${s.purchaseId}:${s.itemIndex}`;
      chain.throughBlock = W0 + EPOCHS * 200 + SETTLE_STALL;   // 체인 값이 시한 뒤까지 (사건은 그대로)
    }));
    assert.deepEqual(failed(late), [SETTLE_CHECK]);
    const overdue = late.settlements.mismatches.filter((m) => m.reason === "OVERDUE");
    assert.ok(overdue.some((m) => m.key === dropped && m.onchain === null), dropped);
    assert.ok(late.settlements.mismatches.every((m) => m.reason === "OVERDUE"));
  });

  it("detects an edited input (hash chain head and anchor inputLogRoot)", async () => {
    const r = await verifyEpochs(asBundle(demo, ({ epochs }) => {
      const w = epochs[1]!.windows[0];
      w.rooms[0].inputs[0].tiers = [0, 0, 0, 0];
    }));
    assert.ok(!r.ok);
    assert.ok(failed(r).some((n) => n.includes("head = recomputed chain head")), failed(r).join(" | "));
  });

  it("detects a seed that is not on the committed chain", async () => {
    const r = await verifyEpochs(asBundle(demo, ({ chain, epochs }) => {
      const bad = `0x${"12".repeat(32)}`;
      chain.anchors.find((x: Json) => x.epoch === 4).seed = bad;
      epochs[3]!.seed = bad;
    }));
    assert.ok(failed(r).some((n) => n.includes("keccak^(1)(S_4) = S_3")), failed(r).join(" | "));
  });

  it("detects a wrong roomsStateRoot / boardBatchRoot in an anchor", async () => {
    const r = await verifyEpochs(asBundle(demo, ({ chain }) => {
      chain.anchors[2].roomsStateRoot = `0x${"aa".repeat(32)}`;
      const withBatch = chain.anchors.find((x: Json) => !/^0x0*$/.test(x.boardBatchRoot));
      withBatch.boardBatchRoot = `0x${"bb".repeat(32)}`;
    }));
    const f = failed(r);
    assert.ok(f.includes("anchor 2: roomsStateRoot"), f.join(" | "));
    assert.ok(f.some((n) => /^anchor \d+: boardBatchRoot/.test(n)), f.join(" | "));
  });

  it("a different block hash changes the replay (randomness is bound to chain data)", async () => {
    // 한 윈도만 바꾸면 그 윈도에 방이 멈춰 있어(무작위를 안 씀) 아무것도 안 바뀔 수 있다 → 앵커 사이 구간 전체를 바꾼다
    const r = await verifyEpochs(asBundle(demo, ({ chain }) => { for (let w = 1100; w < 1200; w++) if (chain.blockHashes[String(w)]) chain.blockHashes[String(w)] = `0x${"dd".repeat(32)}`; }));
    assert.ok(!r.ok);
    assert.ok(failed(r).some((n) => n.includes("roomsStateRoot") || n.includes("batch")), failed(r).join(" | "));
  });

  it("detects an engine build mismatch", async () => {
    const other = await verifyEpochs(asBundle(demo, ({ world }) => { world.engineVersionHash = `0x${"ee".repeat(32)}`; }));
    assert.deepEqual(failed(other), ["engine build = world.engineVersionHash"]);
    assert.equal(other.replayedThrough, -1);
    assert.equal(other.settlements.checked, 0, "재생하지 못했으면 체인 정산은 범위 밖으로 건너뛴다");
  });
});

describe("inputs = chain events (H-1, D111): every Purchased / CancelRequested / PurchasesVoided has exactly one input at its window", () => {
  let demo: DemoBundle;
  let report: EpochVerifyReport;
  before(async () => {
    demo = buildDemoBundle();
    report = await verifyEpochs(asBundle(demo));
  });

  it("(a) the honest bundle: each chain event is linked to one input at window b + 1 with the same fields", () => {
    const chain = demo.chain as Json;
    const items = chain.purchases.length + chain.cancels.reduce((s: number, c: Json) => s + c.items.length, 0) + 2;   // + 무효 구간 구매 2 (방 2 · 방 1 무효 over)
    assert.ok(report.checks.some((c) => c.name === LINKAGE_CHECK && c.ok));
    assert.equal(report.linkage.checked, items);
    assert.equal(report.linkage.matched, items);
    assert.deepEqual(report.linkage.mismatches, []);
    assert.deepEqual(report.linkage.problems, []);
    assert.equal(report.linkage.pending, 0);
    const first = (demo.epochs[0] as Json).windows[0];
    assert.equal(first.window, W0 + 1, "블록 W0의 구매 → 윈도 W0 + 1");
    assert.deepEqual(first.rooms[0].links[0], { block: W0, logIndex: 0, pos: 0, txHash: chain.purchases[0].txHash });
  });

  const expectOnly = async (cheat: Cheat, code: LinkMismatchCode) => {
    const r = await verifyEpochs(asBundle(buildDemoBundle(cheat)));
    assert.deepEqual(failed(r), [LINKAGE_CHECK], `${cheat}: only the linkage check fails — the operator's world, log, anchors and settlements agree with each other`);
    assert.deepEqual([...new Set(r.linkage.mismatches.map((m) => m.code))], [code], JSON.stringify(r.linkage.mismatches.slice(0, 3)));
    assert.ok(r.anchors.length === EPOCHS && r.settlements.mismatches.length === 0, "앵커·정산은 운영자의 세계와 맞는다");
    return r;
  };

  it("(b) fails on a purchase applied one window late (H-1 ①): WINDOW", async () => {
    const r = await expectOnly("delay", "WINDOW");
    const m = r.linkage.mismatches[0]!;
    assert.deepEqual([m.expected?.window, m.actual?.window, m.link.block], [W0 + 1, W0 + 2, W0]);
  });

  it("(c) fails on a re-tiered purchase (×1 logged as ×20, H-1 ②): FIELDS", async () => {
    const r = await expectOnly("retier", "FIELDS");
    const m = r.linkage.mismatches[0]!;
    assert.deepEqual([(m.expected?.input as Json).tiers, (m.actual?.input as Json).tiers], [[0], [4]]);
  });

  it("(d) fails on a dropped cancel (H-1 ③): MISSING", async () => {
    const r = await expectOnly("dropcancel", "MISSING");
    assert.equal(r.linkage.mismatches[0]!.expected?.input.type, "cancel");
  });

  it("fails on an input with no chain event behind it: EXTRA", async () => {
    await expectOnly("extra", "EXTRA");
  });

  it("every input cheat is caught", () => assert.deepEqual([...INPUT_CHEATS].sort(), ["delay", "dropcancel", "extra", "retier"]));

  it("fails when the chain data does not cover the replayed windows, or belongs to another shop", async () => {
    const short = await verifyEpochs(asBundle(demo, ({ chain }) => { chain.throughBlock = W0 + EPOCHS * 200 - 3; }));
    assert.ok(failed(short).some((n) => n.startsWith("chain data covers the replayed windows")), failed(short).join(" | "));
    const shop = await verifyEpochs(asBundle(demo, ({ chain }) => { chain.shop = `0x${"5c".repeat(20)}`; }));
    assert.deepEqual(failed(shop), ["world.shop = chain shop"]);
  });

  it("fails when a purchase was bought under other rules than the replayed catalog, or a void range points at an unknown purchase", async () => {
    const r = await verifyEpochs(asBundle(demo, ({ chain }) => {
      chain.purchases[1].rulesHash = `0x${"77".repeat(32)}`;
      chain.voids.push({ fromId: "999990", toId: "999991", blockNumber: W0 + 600, logIndex: 0, txHash: `0x${"99".repeat(32)}` });
    }));
    assert.deepEqual(failed(r), [LINKAGE_CHECK]);
    assert.deepEqual(r.linkage.problems.map((p) => p.code).sort(), ["RULES", "UNKNOWN_PURCHASE"]);
  });

  it("rulesHashes are mandatory (chain snapshot v3): a chain file without them is a read error", async () => {
    await assert.rejects(verifyEpochs(asBundle(demo, ({ chain }) => { delete chain.rulesHashes; })));
  });
});

describe("a void that lands after the verified range (first anchor after an outage, review rev6 I-1, D162)", () => {
  it("the voided purchase's pickaxe ended inside the range and its over was paid by VoidOverPaid: no false VOID_OVER_EXTRA / OVERDUE", async () => {
    const d = buildDemoBundle(undefined, EPOCHS, { voidOverBlock: W0 + 805 });   // 에폭 4 끝(W0 + 799) 뒤의 PurchasesVoided
    const chain = d.chain as Json;
    const v = chain.voids.find((x: Json) => x.fromId === d.voidOverPurchaseId);
    assert.equal(v.blockNumber, W0 + 805);
    assert.deepEqual(chain.voidOverPaid.map((x: Json) => x.purchaseId), [d.voidOverPurchaseId], "the settler paid the over after the void");
    const four = (c: Json) => ({ ...asBundle(d), epochs: structuredClone(d.epochs.slice(0, 4)), chain: new StaticChainSource(c) });
    const r = await verifyEpochs(four(chain));
    assert.equal(r.windows.last, W0 + 799, "the range ends before the void's window");
    assert.deepEqual(failed(r), []);
    assert.ok(r.settlements.matched > 0 && r.settlements.mismatches.length === 0);
    // 체인 머리가 시한을 넘긴 뒤 읽어도 정상 종료는 OVERDUE가 아니다(무효 구매 — 환불 100% + VoidOverPaid)
    const late = await verifyEpochs(four({ ...structuredClone(chain), throughBlock: W0 + 799 + SETTLE_STALL + 100 }));
    assert.deepEqual(failed(late), []);
    // 그래도 그 over를 안 줬으면 시한 뒤 VOID_OVER로 실패한다
    const withheld = await verifyEpochs(four({ ...structuredClone(chain), voidOverPaid: [], throughBlock: W0 + 805 + SETTLE_STALL + 1 }));
    assert.deepEqual(withheld.settlements.mismatches.map((m) => m.reason), ["VOID_OVER"]);
  });
});

describe("trust roots pinned outside the operator's files (review rev6 M-4, D162)", () => {
  let demo: DemoBundle;
  before(() => { demo = buildDemoBundle(); });
  const SHOP = "0x5b0b000000000000000000000000000000000005";

  it("the report carries the trust roots; a pinned shop equal to world.shop passes", async () => {
    const r = await verifyEpochs({ ...asBundle(demo), trust: { shop: SHOP.toUpperCase().replace("0X", "0x"), chainId: 143 } });
    assert.deepEqual(failed(r), []);
    assert.equal(r.trust.shop, SHOP);
    assert.equal(r.trust.shopPinned, true);
    assert.equal(r.trust.chainId, 143);
    assert.equal(r.trust.fairness, null, "a chain file has no fairness address");
    assert.match(r.trust.seedRoot!, /^0x[0-9a-f]{64}$/);
    assert.deepEqual(r.trust.rooms.map((x) => x.roomId), [1, 2]);
    const unpinned = await verifyEpochs(asBundle(demo));
    assert.equal(unpinned.trust.shopPinned, false);
  });

  it("a decoy world (world.json names another shop than the one pinned) fails first and reads no chain value", async () => {
    let reads = 0;
    const b = asBundle(demo);
    const chain = b.chain;
    b.chain = { ...chain, head: () => { reads += 1; return chain.head(); }, snapshot: (n) => { reads += 1; return chain.snapshot(n); } } as typeof chain;
    const r = await verifyEpochs({ ...b, trust: { shop: `0x${"5c".repeat(20)}` } });
    assert.deepEqual(failed(r), [PINNED_SHOP_CHECK]);
    assert.equal(reads, 0);
    assert.equal(r.trust.chainId, null);
  });

  it("pinned chainId / seedRoot / fairness / engine hash that differ fail their own check", async () => {
    for (const [pin, name] of [
      [{ chainId: 10143 }, "pinned chainId = chain"],
      [{ seedRoot: `0x${"5f".repeat(32)}` }, "pinned seedRoot = chain seedRoot"],
      [{ fairness: `0x${"fa".repeat(20)}` }, "pinned fairness = chain PikitShop.fairness()"],
      [{ engineVersionHash: `0x${"ee".repeat(32)}` }, "pinned engineVersionHash = this build"],
    ] as const) {
      const r = await verifyEpochs({ ...asBundle(demo), trust: { shop: SHOP, ...pin } });
      assert.deepEqual(failed(r), [name]);
    }
  });
});

describe("room creation window from the chain (review rev6 L-3, rev 6-b roomOf.createdBlock, D162)", () => {
  let demo: DemoBundle;
  before(() => { demo = buildDemoBundle(); });

  it("world.json createdWindow must equal max(W0, roomOf.createdBlock); a forged later first window fails before replay", async () => {
    const ok = await verifyEpochs(asBundle(demo));
    assert.ok(ok.checks.some((c) => c.name === "room 2: world createdWindow = max(W0, roomOf.createdBlock)" && c.ok));
    const forged = await verifyEpochs(asBundle(demo, ({ world }) => { world.rooms[1].createdWindow += 10; }));
    assert.deepEqual(failed(forged), ["room 2: world createdWindow = max(W0, roomOf.createdBlock)"]);
    assert.match(forged.checks.find((c) => !c.ok)!.detail!, new RegExp(`world\\.json ${W0 + 60} vs chain ${W0 + 50}`));
    // 방이 W0 전에 만들어졌으면 W0
    const early = await verifyEpochs(asBundle(demo, ({ chain }) => { chain.roomRules[0].createdBlock = W0 - 500; }));
    assert.deepEqual(failed(early), []);
  });
});

describe("rules per room (review rev6 I-5, D162)", () => {
  let demo: DemoBundle;
  before(() => { demo = buildDemoBundle(); });
  const RULES = "room 2: keccak256(catalogHash ‖ engineVersionHash) = this room's on-chain rulesHash (roomOf)";

  it("each room is compared with its own roomOf rules, not with the union of every room's rules", async () => {
    const ok = await verifyEpochs(asBundle(demo));
    assert.ok(ok.checks.some((c) => c.name === RULES && c.ok));
    // 방 2가 체인에서 방 1의 규칙으로 돌아도 합집합에는 두 규칙이 다 있다 — 옛 검사는 통과했다
    const swapped = await verifyEpochs(asBundle(demo, ({ chain }) => { chain.roomRules[1].rulesHash = chain.roomRules[0].rulesHash; }));
    assert.deepEqual(failed(swapped), [RULES]);
    assert.match(swapped.checks.find((c) => !c.ok)!.detail!, /^replay 0x[0-9a-f]{64} vs chain room 2 0x/);
  });

  it("a room missing on chain fails; the room's scheduled next rules are accepted", async () => {
    const gone = await verifyEpochs(asBundle(demo, ({ chain }) => { chain.roomRules = chain.roomRules.filter((r: Json) => r.roomId !== 2); }));
    assert.deepEqual(failed(gone), [RULES]);
    assert.match(gone.checks.find((c) => !c.ok)!.detail!, /room 2 does not exist on chain/);
    const next = await verifyEpochs(asBundle(demo, ({ chain }) => {
      const r2 = chain.roomRules[1];
      r2.nextRulesHash = r2.rulesHash;
      r2.rulesHash = `0x${"77".repeat(32)}`;
    }));
    assert.deepEqual(failed(next), []);
  });
});

describe("chain prices and caps = the replayed catalog (review rev6 M-2, D162)", () => {
  let demo: DemoBundle;
  before(() => { demo = buildDemoBundle(); });
  const priceChecks = (r: EpochVerifyReport) => r.checks.filter((c) => c.name.includes("chain tier prices"));

  it("honest chain: catalogOf prices, REWARD caps and over caps equal the catalog for every room", async () => {
    const r = await verifyEpochs(asBundle(demo));
    assert.equal(priceChecks(r).length, 2);
    assert.ok(r.checks.filter((c) => c.name.includes("chain tier")).every((c) => c.ok));
  });

  it("PoC R6-06: same rulesHash, every price doubled on chain (caps unchanged) → PRICE_MISMATCH for each room, nothing else", async () => {
    const r = await verifyEpochs(asBundle(demo, ({ chain }) => {
      for (const c of chain.catalogs) c.tierPrices = c.tierPrices.map((p: string) => String(2 * Number(p)));
    }));
    assert.deepEqual(failed(r), ["room 1: chain tier prices (catalogOf) = catalog prices", "room 2: chain tier prices (catalogOf) = catalog prices"]);
    assert.match(r.checks.find((c) => !c.ok)!.detail!, /^PRICE_MISMATCH .*chain 2000 vs catalog 1000 credits/);
    assert.equal(r.ok, false);
  });

  it("a raised REWARD cap or a lowered over cap on chain → CAP_MISMATCH; a missing tier or an unregistered catalog fails both", async () => {
    const caps = await verifyEpochs(asBundle(demo, ({ chain }) => {
      chain.catalogs[0].tierCapsMilli[1] = String(Number(chain.catalogs[0].tierCapsMilli[1]) + 1);
      chain.catalogs[0].tierOverCapsMilli[4] = "0";
    }));
    assert.ok(failed(caps).every((n) => n.includes("chain tier caps")), failed(caps).join(" | "));
    assert.match(caps.checks.find((c) => !c.ok)!.detail!, /^CAP_MISMATCH .*REWARD cap: chain .*; .*over cap: chain 0 vs/);
    const gone = await verifyEpochs(asBundle(demo, ({ chain }) => { chain.catalogs = chain.catalogs.map((c: Json) => ({ ...c, tierPrices: [], tierCapsMilli: [], tierOverCapsMilli: [] })); }));
    assert.equal(failed(gone).length, 4, failed(gone).join(" | "));
  });

  it("the catalog table is mandatory: a chain file without catalogs is a read error", async () => {
    await assert.rejects(verifyEpochs(asBundle(demo, ({ chain }) => { delete chain.catalogs; })));
  });
});

describe("forged payout records (audit F-1 ②): each one is a hard failure of exactly one check", () => {
  const expect: Record<PayoutCheat, { check: string; reason?: string }> = {
    nosettle: { check: SETTLE_CHECK, reason: "OVERDUE" },
    overzero: { check: SETTLE_CHECK, reason: "AMOUNT" },
    voidover: { check: SETTLE_CHECK, reason: "VOID_OVER" },
    missingfile: { check: FILES_CHECK },
  };
  for (const cheat of PAYOUT_CHEATS) {
    it(`${cheat}: fails ${expect[cheat].reason ?? "the file check"} only`, async () => {
      const d = buildDemoBundle(cheat);
      const r = await verifyEpochs(asBundle(d));
      assert.deepEqual(failed(r), [expect[cheat].check]);
      if (expect[cheat].reason) {
        assert.deepEqual(r.settlements.mismatches.map((m) => [m.key, m.reason]), [[d.forgedKey, expect[cheat].reason]]);
        assert.ok(r.settlements.mismatches[0]!.replayed!.overMilli > 0, "the forged item had an over");
      } else {
        assert.match(r.checks.find((c) => !c.ok)!.detail ?? "", /missing: 4\.json/);
      }
    });
  }

  it("the honest bundle pays the void over with VoidOverPaid (rev 6 payOverAfterVoid) and passes; --purchase shows it", async () => {
    const d = buildDemoBundle();
    const chain = d.chain as Json;
    assert.deepEqual(chain.voidOverPaid.map((v: Json) => `${v.purchaseId}:${v.itemIndex}`), [`${d.voidOverPurchaseId}:0`]);
    const r = await verifyEpochs({ ...asBundle(d), purchase: d.voidOverPurchaseId });
    assert.deepEqual(failed(r), []);
    assert.deepEqual(r.purchase!.items.map((i) => [i.key, i.status, i.voidOverPaid?.overMilli]), [[`${d.voidOverPurchaseId}:0`, "MATCH", String(r.purchase!.items[0]!.replayed!.overMilli)]]);
  });
});

describe("snapshot start (spec 17 P0-16 c): replay from an anchored epoch snapshot instead of genesis", () => {
  let demo: DemoBundle;
  before(() => { demo = buildDemoBundle(); });
  const fromSnapshot = (d: DemoBundle, E: number, patch?: (snap: Json) => void): EpochBundle => {
    const snap = structuredClone(d.snapshots[E - 1]) as Json;
    patch?.(snap);
    return { ...asBundle(d), firstEpoch: E + 1, epochs: structuredClone(d.epochs.slice(E)) as Json[], snapshot: snap };
  };

  it("passes from every anchored epoch; trusts the anchor whose processedThrough + 1 = the snapshot window, then checks every later anchor", async () => {
    for (let E = 1; E < EPOCHS; E++) {
      const r = await verifyEpochs(fromSnapshot(demo, E));
      assert.deepEqual(failed(r), [], `from snapshot ${E}`);
      const anchor = (demo.chain as Json).anchors.find((a: Json) => a.anchorIndex === E - 1);
      assert.deepEqual(r.start, { epoch: E, processedWindow: W0 + 200 * E - 1, anchorIndex: E - 1, roomsStateRoot: anchor.roomsStateRoot });
      assert.equal(r.anchors.length, EPOCHS - E);
      assert.equal(r.firstEpoch, E + 1);
      assert.equal(r.windows.first, W0 + 200 * E);
      assert.equal(r.settlements.mismatches.length, 0);
      assert.ok(r.checks.some((c) => c.name.startsWith(`start snapshot ${E}: roomsStateRoot`) && c.ok));
    }
  });

  it("ends on the same state as a full replay from genesis", async () => {
    const full = await verifyEpochs(asBundle(demo));
    const part = await verifyEpochs(fromSnapshot(demo, 3));
    assert.deepEqual(part.stateHashes, full.stateHashes);
    assert.equal(part.head, full.head);
  });

  it("refuses a snapshot whose state or input log head is not the anchored one", async () => {
    const state = await verifyEpochs(fromSnapshot(demo, 2, (s) => { s.world.rooms[0].state.tick += 1; }));
    assert.deepEqual(failed(state), ["start snapshot 2: roomsStateRoot = anchor 1 roomsStateRoot"]);
    const head = await verifyEpochs(fromSnapshot(demo, 2, (s) => { s.inputLogHead = `0x${"ab".repeat(32)}`; }));
    assert.deepEqual(failed(head), ["start snapshot 2: inputLogHead = anchor 1 inputLogRoot"]);
    const rooms = await verifyEpochs(fromSnapshot(demo, 2, (s) => { s.world.rooms.pop(); }));
    assert.match(failed(rooms)[0]!, /^start snapshot has exactly the rooms/);
    const other = await verifyEpochs(fromSnapshot(demo, 2, (s) => { s.epoch = 3; }));
    assert.match(failed(other)[0]!, /^start snapshot is epoch 2/);
  });

  it("fails when the snapshot epoch is not anchored on chain, or the snapshot file is missing", async () => {
    const unanchored = await verifyEpochs({
      ...fromSnapshot(demo, 3),
      chain: new StaticChainSource({ ...(structuredClone(demo.chain) as Json), anchors: (demo.chain as Json).anchors.filter((a: Json) => a.anchorIndex !== 2) }),
    });
    assert.match(failed(unanchored)[0]!, /^start snapshot 3 is anchored on chain/);
    const missing = await verifyEpochs({ ...fromSnapshot(demo, 3), snapshot: null });
    assert.deepEqual(failed(missing), [FILES_CHECK]);
  });

  it("still catches a forged payout after the snapshot (void over unpaid, epoch 4, from snapshot 3)", async () => {
    const d = buildDemoBundle("voidover");
    const r = await verifyEpochs(fromSnapshot(d, 3));
    assert.deepEqual(failed(r), [SETTLE_CHECK]);
    assert.deepEqual(r.settlements.mismatches.map((m) => m.reason), ["VOID_OVER"]);
  });
});
