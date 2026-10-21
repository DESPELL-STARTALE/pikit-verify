// 장부 + 엔진 작은 세계 (계획 §4.2 A3): 지갑 3개 · 400윈도(에폭 2개, 에폭마다 루트) · 진짜 서명.
//   만드는 쪽(game-server 흉내) → 공개 파일(ledger/<e>.json · ledger/leaves/<k>.json) → 다시 돌기(LedgerReplayer, 검증기 흉내)로 같은 루트 10칸.
//   두 번 만들면 파일 바이트·루트가 같다 · 불변식(가)(나)(다)가 매 윈도 · 기존 checkInputLinkage가 '입력 = 명단'을 그대로 확인한다 ·
//   잎 파일에서 이어 돌아도 같은 루트 · 위조(결정·잎·명단 순서·ANNOUNCE 키·같은 날 GRANT 두 번)는 잡힌다.
import assert from "node:assert/strict";
import { before, describe, it } from "node:test";
import { addRoom, createRoom, lazyWindowRng, runWorldWindow, type LinkedInput, type World } from "@pikit/engine";
import {
  epochWindows, hexToBytes, itemIdOf, keccak256, parseCatalog,
  type Catalog, type LedgerFileList, type EpochWindowInputs, type LedgerLeavesFile, type LedgerListEntry, type LedgerRootFields, type LedgerSessionRecord,
} from "@pikit/protocol";
import {
  authenticateEntries, buildLedgerEpochFile, buildLedgerLeavesFile, checkInputLinkage, checkLeavesFile, checkLedgerInvariants, compareLedgerRoot,
  fileSha256, LedgerListError, LedgerReplayer, LedgerState, ledgerFileList, ledgerFileText, ledgerInputEvents, ledgerRootFields, ledgerWindow,
  linkRooms, parseLedgerEpochFile, parseLedgerLeavesFile, roomsStateRoot, sessionKeyOf, sessionsUsed, worldStateHashes,
  type LedgerContext, type WindowApplication,
} from "../../src/index.js";
import { ANNOUNCE, buy, cancel, CHAIN_ID, DAY0, grant, LEDGER, loadNormal, makeContext, player, prng, sessionRecord, signedList, ts, W0 } from "./helpers.js";

const EPOCHS = 2;
const ZERO_HASH = `0x${"00".repeat(32)}`;
const LAST = epochWindows(EPOCHS, W0).last;

/** 곡괭이가 빨리 끝나게 타이머만 줄인 카탈로그 (450틱 ≈ 50윈도). */
function fastCatalog(): Catalog {
  const c = structuredClone(loadNormal());
  c.limits.timerTicks = 450;
  c.limits.stuckTicks = 300;
  return parseCatalog(c);
}

const cat = fastCatalog();
const ctx: LedgerContext = makeContext(cat);
const RULES = ctx.rooms[0]!.rulesHash;
const PLAYERS = [player(1), player(2), player(3)];
const seedBytes = (e: number) => hexToBytes(keccak256(new TextEncoder().encode(`ledger-world-seed-${e}`)));
const blockHash = (w: number) => hexToBytes(keccak256(new TextEncoder().encode(`block-${w}`)));
const ledgerBytes = hexToBytes(LEDGER);
const rngFor = (w: number) => (roomId: number) => lazyWindowRng(() => seedBytes(Math.floor((w - W0) / 200) + 1), CHAIN_ID, ledgerBytes, roomId, w, () => blockHash(w));

function newWorld(): World {
  const world: World = { rooms: [] };
  addRoom(world, { roomId: 1, catalog: cat, state: createRoom(cat, rngFor(W0)(1), 1, W0) });
  return world;
}
const engineStep = (world: World, w: number) => (inputs: Map<number, LinkedInput[]>) =>
  runWorldWindow(world, w, new Map([...inputs].map(([r, l]) => [r, l.map((x) => x.input)])), rngFor(w));

interface Produced {
  files: Map<string, string>;          // 경로 → 공개 바이트(텍스트)
  roots: LedgerRootFields[];
  snapshots: Map<number, string>;      // 에폭 → 세계 JSON
  epochInputs: Map<number, EpochWindowInputs[]>;
  decisions: string[];
  windowsWithPayouts: number;
  ended: number;
}

/** 만드는 쪽 (game-server 흉내): 명단 → ledgerWindow → 파일·루트. */
async function produce(): Promise<Produced> {
  const rnd = prng(42);
  const state = new LedgerState();
  const world = newWorld();
  const sessions = new Map<string, LedgerSessionRecord>();
  for (const p of PLAYERS) {
    const r = await sessionRecord(p);
    sessions.set(sessionKeyOf(r.session.wallet, r.session.sessionKey), r);
  }
  const seq = PLAYERS.map(() => 0);
  const bought: { p: number; purchaseId: string; n: number }[] = [];
  const out: Produced = { files: new Map(), roots: [], snapshots: new Map(), epochInputs: new Map(), decisions: [], windowsWithPayouts: 0, ended: 0 };
  let lists: LedgerFileList[] = [];
  let windowsIn: EpochWindowInputs[] = [];
  const stamps = new Map<number, number>();
  let payouts: ReturnType<typeof ledgerWindow>["payouts"] = [];
  let granted = 0n;
  let loss = 0n;
  let fromEpoch = 1;

  for (let w = W0 + 1; w <= LAST; w++) {
    const entries: LedgerListEntry[] = [];
    if (w === W0 + 1) for (const [i, amt] of [30_000, 50_000, 20_000].entries()) entries.push(grant(PLAYERS[i]!.wallet.address, BigInt(amt) * 1000n, DAY0));
    if (w === W0 + 2) entries.push(grant(PLAYERS[0]!.wallet.address, 5_000_000n, DAY0));   // 같은 날 두 번 → GRANT_ALREADY
    if (w % 3 === 0 && rnd() < 0.8) {
      const i = Math.floor(rnd() * 3);
      const p = PLAYERS[i]!;
      const tiers = Array.from({ length: 1 + Math.floor(rnd() * 3) }, () => Math.floor(rnd() * 3));
      entries.push(await buy(p, { rulesHash: RULES, tiers, seq: ++seq[i]!, target: w }));
    }
    if (w % 17 === 0 && bought.length > 0) {
      const b = bought[Math.floor(rnd() * bought.length)]!;
      entries.push(await cancel(PLAYERS[b.p]!, { items: Array.from({ length: b.n }, (_, k) => itemIdOf(b.purchaseId, k)), seq: ++seq[b.p]!, target: w }));
    }
    if (w === W0 + 50) entries.push(await buy(PLAYERS[1]!, { rulesHash: RULES, tiers: [0], seq: seq[1]! + 1, target: w - 1 }));   // 늦음 → TARGET_MISMATCH
    if (w === W0 + 60) entries.push(await buy(PLAYERS[2]!, { rulesHash: RULES, tiers: [2, 2], seq: ++seq[2]!, target: w }));      // 40,000 cr → INSUFFICIENT_CREDITS
    if (w === W0 + 70) entries.push(await buy(PLAYERS[0]!, { rulesHash: RULES, tiers: [0], seq: seq[0]!, target: w }));            // 같은 seq → SEQ_USED
    if (w === W0 + 210) entries.push(grant(PLAYERS[1]!.wallet.address, 1_000_000n, DAY0));                                          // 이미 받은 날 → GRANT_ALREADY

    let listIn = null;
    let signed = null;
    if (entries.length > 0) {
      signed = await signedList(w, entries);
      listIn = { list: signed, auth: await authenticateEntries(ctx, entries, [...sessions.values()]), blockTimestamp: ts(w) };
      stamps.set(w, ts(w));
    }
    const r = ledgerWindow(state, ctx, w, listIn, engineStep(world, w));
    if (signed && r.application) {
      lists.push(ledgerFileList(signed, r.application.decisions));
      r.application.decisions.forEach((d, i) => {
        out.decisions.push(`${w}:${entries[i]!.kind}:${d.status}:${d.reason ?? d.purchaseId ?? ""}`);
        const e = entries[i]!;
        if (e.kind === "BUY" && d.purchaseId !== null) bought.push({ p: PLAYERS.findIndex((p) => p.wallet.address === e.intent.wallet), purchaseId: d.purchaseId, n: e.intent.tiers.length });
      });
      granted += r.application.grantedMilli;
    }
    const rooms = [...r.inputs].filter(([, l]) => l.length > 0).map(([roomId, l]) => ({ roomId, inputs: l.map((x) => x.input), links: l.map((x) => x.link) }));
    if (rooms.length > 0) windowsIn.push({ window: w, rooms });
    payouts.push(...r.payouts);
    if (r.payouts.length > 0) out.windowsWithPayouts += 1;
    out.ended += r.payouts.length;
    for (const p of r.payouts) loss += BigInt(p.priceMilli) - BigInt(p.payoutMilli) - BigInt(p.overMilli);
    assert.deepEqual(checkLedgerInvariants(state, { world, expectedSupplyMilli: granted - loss }), [], `window ${w}`);

    const e = Math.floor((w - W0) / 200) + 1;
    if (w === epochWindows(e, W0).last) {
      const used = sessionsUsed(lists.flatMap((l) => l.entries), (wa, sk) => sessions.get(sessionKeyOf(wa, sk)));
      const file = buildLedgerEpochFile({ ctx, epoch: e, genesisBlock: W0, lists, sessions: used, blockTimestamps: stamps });
      out.files.set(`ledger/${e}.json`, ledgerFileText(file));
      out.files.set(`${e}.json`, JSON.stringify({ epoch: e, windows: windowsIn }));   // 입력 기록 자리표시 (dataHash 재료)
      out.epochInputs.set(e, windowsIn);
      out.snapshots.set(e, JSON.stringify(world));
      out.files.set(`snapshots/${e}.json`, out.snapshots.get(e)!);
      const k = e - 1;
      out.files.set(`ledger/leaves/${k}.json`, ledgerFileText(buildLedgerLeavesFile({ chainId: CHAIN_ID, ledger: LEDGER, rootIndex: k, epoch: e, genesisBlock: W0, state })));
      out.roots.push(ledgerRootFields({
        epoch: e, genesisBlock: W0, seed: keccak256(seedBytes(e)), roomsStateRoot: roomsStateRoot(worldStateHashes(world)), inputLogRoot: fileSha256(out.files.get(`${e}.json`)!),
        boardBatchRoot: ZERO_HASH, state, payouts, fromEpoch, rootIndex: k, files: shaMap(out.files),
      }));
      fromEpoch = e + 1;
      lists = [];
      windowsIn = [];
      stamps.clear();
      payouts = [];
    }
  }
  return out;
}

const shaMap = (files: Map<string, string>) => new Map([...files].map(([p, t]) => [p, fileSha256(t)]));

interface ReplayOpts {
  files: Map<string, string>;
  from?: { epoch: number; world: string; leaves: LedgerLeavesFile };
  announcer?: string;
}

/** 검증기 쪽: 공개 파일만으로 다시 돈다 → 루트마다 10칸·잎 파일 대조. */
async function replay(o: ReplayOpts) {
  const first = o.from ? o.from.epoch + 1 : 1;
  const world: World = o.from ? (JSON.parse(o.from.world) as World) : newWorld();
  if (o.from) for (const r of world.rooms) r.catalog = cat;
  const state = o.from ? LedgerState.fromLeaves(o.from.leaves.leaves, o.from.leaves.nextPurchaseId) : new LedgerState();
  const rep = new LedgerReplayer(ctx, state);
  const roots: LedgerRootFields[] = [];
  const leafProblems: string[] = [];
  const linkage: number[] = [];
  for (let e = first; e <= EPOCHS; e++) {
    await rep.addEpochFile(parseLedgerEpochFile(JSON.parse(o.files.get(`ledger/${e}.json`)!)), { announcerAt: () => o.announcer ?? ANNOUNCE.address });
    const { first: a, last: b } = epochWindows(e, W0);
    for (let w = Math.max(a, W0 + 1); w <= b; w++) rep.window(w, engineStep(world, w));
    // 입력 = 명단: 엔진 연결 대조(기존 checkInputLinkage)를 장부 기록으로
    const apps: readonly WindowApplication[] = rep.periodApplications();
    const lk = checkInputLinkage({ rooms: linkRooms(ctx), events: ledgerInputEvents(apps), windows: (JSON.parse(o.files.get(`${e}.json`)!) as { windows: EpochWindowInputs[] }).windows, first: a, last: b });
    linkage.push(lk.mismatches.length + lk.problems.length);
    const k = e - 1;
    roots.push(rep.rootFields({
      epoch: e, genesisBlock: W0, seed: keccak256(seedBytes(e)), roomsStateRoot: roomsStateRoot(worldStateHashes(world)), inputLogRoot: fileSha256(o.files.get(`${e}.json`)!),
      boardBatchRoot: ZERO_HASH, fromEpoch: first === e ? first : e, rootIndex: k, files: shaMap(o.files),
    }));
    leafProblems.push(...checkLeavesFile(parseLedgerLeavesFile(JSON.parse(o.files.get(`ledger/leaves/${k}.json`)!)), rep.state, { rootIndex: k, epoch: e, genesisBlock: W0 }));
    rep.takePeriod();
  }
  return { rep, roots, leafProblems, linkage, invariants: checkLedgerInvariants(rep.state, { world, expectedSupplyMilli: rep.expectedSupplyMilli() }) };
}

describe("ledger world (3 wallets, 400 windows, engine)", () => {
  let P: Produced;
  before(async () => { P = await produce(); });

  it("the run exercises buys, cancels, ends, refunds and the scripted rejections", () => {
    const kinds = (re: RegExp) => P.decisions.filter((d) => re.test(d)).length;
    // 규칙 12: 곡괭이 회수가 낮아 지갑이 빨리 마른다 (같은 3지갑에서 ≈ 40건 적용, 나머지는 INSUFFICIENT_CREDITS)
    assert.ok(kinds(/BUY:APPLIED/) >= 30, `buys ${kinds(/BUY:APPLIED/)}`);
    assert.ok(kinds(/CANCEL:APPLIED/) >= 5);
    for (const r of ["TARGET_MISMATCH", "INSUFFICIENT_CREDITS", "SEQ_USED", "GRANT_ALREADY"]) assert.ok(P.decisions.some((d) => d.endsWith(`:${r}`)), r);
    assert.ok(P.ended >= 30, `ended ${P.ended}`);
    assert.equal(P.roots.length, EPOCHS);
  });

  it("producing twice gives the same files byte for byte and the same root fields", async () => {
    const again = await produce();
    assert.deepEqual([...again.files.keys()], [...P.files.keys()]);
    for (const [path, text] of P.files) assert.equal(again.files.get(path), text, path);
    assert.deepEqual(again.roots, P.roots);
  });

  it("replaying the public files from genesis gives every root's 10 fields, the same leaves files, inputs = signed lists, invariants", async () => {
    const r = await replay({ files: P.files });
    r.roots.forEach((f, k) => assert.deepEqual(compareLedgerRoot(f, P.roots[k]!), [], `root ${k}`));
    assert.deepEqual(r.leafProblems, []);
    assert.deepEqual(r.rep.decisionMismatches, []);
    assert.deepEqual(r.rep.listProblems, []);
    assert.deepEqual(r.linkage, [0, 0]);
    assert.deepEqual(r.invariants, []);
  });

  it("resuming from root 0 (its leaves file + the epoch-1 snapshot) gives root 1", async () => {
    const leaves = parseLedgerLeavesFile(JSON.parse(P.files.get("ledger/leaves/0.json")!));
    const r = await replay({ files: P.files, from: { epoch: 1, world: P.snapshots.get(1)!, leaves } });
    assert.deepEqual(compareLedgerRoot(r.roots[0]!, P.roots[1]!), []);
    assert.deepEqual(r.leafProblems, []);
  });

  describe("forgeries are caught", () => {
    const mutate = (path: string, f: (x: any) => void) => {
      const files = new Map(P.files);
      const x = JSON.parse(files.get(path)!);
      f(x);
      files.set(path, JSON.stringify(x));
      return files;
    };
    const firstBuy = (x: any) => x.lists.find((l: any) => l.entries.some((e: any) => e.kind === "BUY" && l.decisions[l.entries.indexOf(e)].status === "APPLIED"));

    it("a decision changed in the ledger file → decision mismatch", async () => {
      const files = mutate("ledger/1.json", (x) => {
        const l = firstBuy(x);
        const i = l.entries.findIndex((e: any) => e.kind === "BUY");
        l.decisions[i] = { status: "REJECTED", reason: "INSUFFICIENT_CREDITS", purchaseId: null };
      });
      const r = await replay({ files });
      assert.equal(r.rep.decisionMismatches.length, 1);
    });

    it("the second GRANT of the same UTC day marked APPLIED in the file → decision mismatch (GRANT_ALREADY in the replay)", async () => {
      const files = mutate("ledger/1.json", (x) => {
        const l = x.lists.find((y: any) => y.window === W0 + 2);
        l.decisions[0] = { status: "APPLIED", reason: null, purchaseId: null };
      });
      const r = await replay({ files });
      assert.deepEqual(r.rep.decisionMismatches.map((m) => [m.window, m.replay.reason]), [[W0 + 2, "GRANT_ALREADY"]]);
    });

    it("a leaf balance changed → leaves file check fails and dataHash differs", async () => {
      const files = mutate("ledger/leaves/0.json", (x) => { x.leaves[0].balanceMilli = String(BigInt(x.leaves[0].balanceMilli) + 1000n); });
      const r = await replay({ files });
      assert.ok(r.leafProblems.some((p) => /leaf .*file .*≠ replay/.test(p)));
      assert.deepEqual(compareLedgerRoot(r.roots[0]!, P.roots[0]!).map((s) => s.split(":")[0]), ["dataHash"]);
    });

    it("list entries reordered → the list no longer matches its signed entriesHash", async () => {
      const files = mutate("ledger/1.json", (x) => { const l = x.lists[0]; l.entries.reverse(); l.decisions.reverse(); });
      await assert.rejects(replay({ files }), LedgerListError);
    });

    it("a list signed by another key than the window's announcer → list problem", async () => {
      const r = await replay({ files: P.files, announcer: player(77).wallet.address });
      const lists = (JSON.parse(P.files.get("ledger/1.json")!).lists.length as number) + (JSON.parse(P.files.get("ledger/2.json")!).lists.length as number);
      assert.equal(r.rep.listProblems.length, lists);
    });

    it("a session signature from the wrong wallet → its intents are SESSION_MISSING in the replay (mismatch with the file)", async () => {
      const files = mutate("ledger/1.json", (x) => { x.sessions[0].signature = x.sessions[1].signature; });
      const r = await replay({ files });
      // 그 지갑의 의향서가 SESSION_MISSING이 되고, 뒤따라 purchaseId가 밀려 다른 결정도 어긋난다
      assert.ok(r.rep.decisionMismatches.some((m) => m.replay.reason === "SESSION_MISSING" && m.file.status === "APPLIED"));
    });

    it("a root posted with another payoutsRoot or supply (payout amount changed) → those fields differ", () => {
      const root = P.roots[0]!;
      const forged = { ...root, payoutsRoot: keccak256(new TextEncoder().encode("x")), supplyMilli: String(BigInt(root.supplyMilli) + 1n) };
      assert.deepEqual(compareLedgerRoot(root, forged).map((x) => x.split(":")[0]), ["payoutsRoot", "supplyMilli"]);
    });
  });
});
