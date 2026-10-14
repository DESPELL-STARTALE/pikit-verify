// 개정 7 장부 세계 시험 묶음 (B5): game-server를 흉내 내 공개 파일 나무 + 체인 값(`pikit.ledger-chain/v1`)을 만든다.
//   방 1개 · 지갑 3개(EOA) + 스마트 지갑 1개(ERC-1271 세션) · 에폭 4개(800윈도) · 루트 3개(에폭 1 · 2 · 3–4) · ANNOUNCE 키 교체 1번(에폭 2 가운데).
//   명단 → A3 ledgerWindow(같은 함수) → 엔진 → 입력 기록 v3(해시 사슬) · 장부 파일 · 경계 스냅숏 · 잎 파일 · 루트 10칸(dataHash = 공개 바이트).
// 검증기 시험(ledger-verify.test)·RPC 시험(ledger-rpc.test)·CLI 데모 묶음(ledger-demo-bundle.ts)이 함께 쓴다. 결과는 늘 같다(고정 키 + RFC 6979).
import { addRoom, createRoom, engineVersionHash, lazyWindowRng, runWorldWindow, type LinkedInput, type World, type WorldWindowResult } from "@pikit/engine";
import {
  canonicalHash, chainInputLog, EPOCH_INPUT_LOG_SCHEMA_ID, EpochInputLog, epochLogEntries, epochWindows, hashLedgerSession, hexToBytes, INPUT_LOG_GENESIS_HEAD,
  itemIdOf, keccak256, ledgerPrivateKeySigner, parseCatalog, rootThroughWindow, seedParent, WORLD_MANIFEST_SCHEMA_ID,
  type Catalog, type EpochWindowInputs, type Hex32, type LedgerFileList, type LedgerListEntry, type LedgerRootRecord, type LedgerSessionRecord, type PayoutLeaf,
} from "@pikit/protocol";
import {
  authenticateEntries, boardBatchRoot, buildLedgerEpochFile, buildLedgerLeavesFile, commitBatch, fileSha256, LEDGER_CHAIN_SCHEMA_ID, LEDGER_VERSION_HASH,
  ledgerFileList, ledgerFileText, ledgerRootFields, ledgerWindow, LedgerState, roomsStateRoot, sessionKeyOf, sessionsUsed, worldStateHashes,
  type CommittedBatch, type LedgerChainFile,
} from "../src/index.js";
import { ANNOUNCE, buy, cancel, CHAIN_ID, DAY0, domain, grant, KEY, LEDGER, loadNormal, makeContext, player, prng, sessionRecord, signedList, ts, W0, type Player } from "./ledger/helpers.js";

export { CHAIN_ID, LEDGER, W0 };
export const EPOCHS = 4;
/** 루트 경계 에폭 (루트 k = ROOT_EPOCHS[k]). */
export const ROOT_EPOCHS = [1, 2, 4] as const;
export const LAST = epochWindows(EPOCHS, W0).last;
/** ANNOUNCE 키 교체: 블록 ROTATE_BLOCK의 setAnnouncer → 창 ROTATE_FROM부터 새 키. */
export const ROTATE_BLOCK = W0 + 250;
export const ROTATE_FROM = ROTATE_BLOCK + 20;
export const ANNOUNCE2 = ledgerPrivateKeySigner(KEY(0xa12));
export const ZERO_ADDRESS = `0x${"00".repeat(20)}`;
/** 스마트 지갑 (ERC-1271) — 세션 허가 서명은 임의 바이트, 체인이 isValidSignature로 받아 준다. */
export const SMART = "0x5a00000000000000000000000000000000000c0d";
export const SMART_SIG = `0x${"ab".repeat(70)}`;
export const SMART_BLOCK = W0 - 10;
const SEED_TOP_EPOCH = 10;

/** 곡괭이가 빨리 끝나게 타이머를 줄이고(450틱 ≈ 50윈도) 블록 묶음을 320블록(32줄)으로 줄인 카탈로그 — 800윈도 안에 묶음이 여럿 끝난다. */
export function fastCatalog(): Catalog {
  const c = structuredClone(loadNormal());
  c.limits.timerTicks = 450;
  c.limits.stuckTicks = 300;
  c.limits.batchBlocks = 320;
  // 12종류(규칙 8: CHOG Ore·Golden CHOG 포함) 합 320 — 띠 종류(6 이상)는 ⌊32 / c⌋ ≥ 3
  [110, 72, 48, 32, 21, 14, 8, 7, 3, 3, 1, 1].forEach((n, k) => { c.blocks[k]!.batchCount = n; });
  return parseCatalog(c);
}

export const blockHashHex = (w: number) => keccak256(new TextEncoder().encode(`block-${w}`));

/** 시드 사슬 S_SEED_TOP_EPOCH → … → S_0 (seedRoot). */
export function seedOf(e: number): Hex32 {
  let s = keccak256(new TextEncoder().encode("ledger-demo-seed-top"));
  for (let i = SEED_TOP_EPOCH; i > e; i--) s = seedParent(s);
  return s;
}

export interface Fixture {
  /** 공개 파일 (에폭 디렉터리 기준 경로 → 바이트): `<e>.json`, `ledger/<e>.json`, `snapshots/<e>.json`, `ledger/leaves/<k>.json`. */
  files: Map<string, Uint8Array>;
  world: Record<string, unknown>;
  catalogs: Map<string, unknown>;
  chain: LedgerChainFile;
  decisions: string[];
}

const enc = (x: unknown) => new TextEncoder().encode(typeof x === "string" ? x : JSON.stringify(x));

/** 만드는 쪽 (game-server 흉내). */
export async function produce(): Promise<Fixture> {
  const cat = fastCatalog();
  const ctx = makeContext(cat);
  const RULES = ctx.rooms[0]!.rulesHash;
  const catalogHash = canonicalHash(cat);
  const rnd = prng(7);
  const players: Player[] = [player(1), player(2), player(3)];
  const smart: Player = { wallet: { address: SMART, sign: async () => { throw new Error("a contract wallet does not sign"); } }, session: ledgerPrivateKeySigner(KEY(0x2004)) };
  const all = [...players, smart];
  const sessions = new Map<string, LedgerSessionRecord>();
  for (const p of players) {
    const r = await sessionRecord(p);
    sessions.set(sessionKeyOf(r.session.wallet, r.session.sessionKey), r);
  }
  const smartSession = { wallet: SMART, sessionKey: smart.session.address, expiresAt: String(ts(W0) + 7 * 86_400) };
  sessions.set(sessionKeyOf(SMART, smart.session.address), { session: smartSession, signature: SMART_SIG, erc1271Block: SMART_BLOCK });

  const ledgerBytes = hexToBytes(LEDGER);
  const rngFor = (w: number) => (roomId: number) =>
    lazyWindowRng(() => hexToBytes(seedOf(Math.floor((w - W0) / 200) + 1)), CHAIN_ID, ledgerBytes, roomId, w, () => hexToBytes(blockHashHex(w)));
  const sim: World = { rooms: [] };
  const state = new LedgerState();
  const files = new Map<string, Uint8Array>();
  const roots: LedgerRootRecord[] = [];
  const decisions: string[] = [];
  const seq = all.map(() => 0);
  const bought: { p: number; purchaseId: string; n: number }[] = [];
  let lists: LedgerFileList[] = [];
  let windowsIn: EpochWindowInputs[] = [];
  const stamps = new Map<number, number>();
  let payouts: PayoutLeaf[] = [];
  let batches: CommittedBatch[] = [];
  let head = INPUT_LOG_GENESIS_HEAD;
  let fromEpoch = 1;

  for (let w = W0; w <= LAST; w++) {
    if (w === W0) addRoom(sim, { roomId: 1, catalog: cat, state: createRoom(cat, rngFor(w)(1), 1, w) });
    const entries: LedgerListEntry[] = [];
    if (w === W0 + 1) for (const [i, amt] of [150_000, 200_000, 60_000, 180_000].entries()) entries.push(grant(all[i]!.wallet.address, BigInt(amt) * 1000n, DAY0));
    if (w === W0 + 2) entries.push(grant(players[0]!.wallet.address, 5_000_000n, DAY0));   // 같은 날 두 번 → GRANT_ALREADY
    if (w > W0 + 2 && w % 4 === 0 && rnd() < 0.7) {
      const i = Math.floor(rnd() * all.length);
      const tiers = Array.from({ length: 1 + Math.floor(rnd() * 3) }, () => Math.floor(rnd() * 3));
      entries.push(await buy(all[i]!, { rulesHash: RULES, tiers, seq: ++seq[i]!, target: w }));
    }
    if (w % 17 === 0 && bought.length > 0) {
      const b = bought[Math.floor(rnd() * bought.length)]!;
      entries.push(await cancel(all[b.p]!, { items: Array.from({ length: b.n }, (_, k) => itemIdOf(b.purchaseId, k)), seq: ++seq[b.p]!, target: w }));
    }
    if (w === W0 + 50) entries.push(await buy(players[1]!, { rulesHash: RULES, tiers: [0], seq: seq[1]! + 1, target: w - 1 }));   // 늦음 → TARGET_MISMATCH
    if (w === W0 + 60) entries.push(await buy(players[2]!, { rulesHash: RULES, tiers: [4, 4], seq: ++seq[2]!, target: w }));      // → INSUFFICIENT_CREDITS
    if (w === W0 + 70) entries.push(await buy(players[0]!, { rulesHash: RULES, tiers: [0], seq: seq[0]!, target: w }));            // 같은 seq → SEQ_USED

    let listIn = null;
    let signed = null;
    if (entries.length > 0) {
      signed = await signedList(w, entries, w >= ROTATE_FROM ? ANNOUNCE2 : ANNOUNCE);
      listIn = { list: signed, auth: await authenticateEntries(ctx, entries, [...sessions.values()]), blockTimestamp: ts(w) };
      stamps.set(w, ts(w));
    }
    let res: WorldWindowResult | null = null;
    const r = ledgerWindow(state, ctx, w, listIn, (inputs: Map<number, LinkedInput[]>) => {
      res = runWorldWindow(sim, w, new Map([...inputs].map(([roomId, l]) => [roomId, l.map((x) => x.input)])), rngFor(w));
      return res;
    });
    for (const { roomId, result } of (res as WorldWindowResult | null)?.rooms ?? []) for (const b of result.batches) batches.push(commitBatch(roomId, w, b));
    if (signed && r.application) {
      lists.push(ledgerFileList(signed, r.application.decisions));
      r.application.decisions.forEach((d, i) => {
        decisions.push(`${w}:${entries[i]!.kind}:${d.status}:${d.reason ?? d.purchaseId ?? ""}`);
        const e = entries[i]!;
        if (e.kind === "BUY" && d.purchaseId !== null) bought.push({ p: all.findIndex((p) => p.wallet.address === e.intent.wallet), purchaseId: d.purchaseId, n: e.intent.tiers.length });
      });
    }
    const rooms = [...r.inputs].filter(([, l]) => l.length > 0).map(([roomId, l]) => ({ roomId, inputs: l.map((x) => x.input), links: l.map((x) => x.link) }));
    if (rooms.length > 0) windowsIn.push({ window: w, rooms });
    payouts.push(...r.payouts);

    const e = Math.floor((w - W0) / 200) + 1;
    const win = epochWindows(e, W0);
    if (w !== win.last) continue;
    // 에폭 끝: 입력 기록 v3 · 장부 파일 · 경계 스냅숏
    const prevHead = head;
    for (const entry of epochLogEntries({ windows: windowsIn })) head = chainInputLog(head, entry);
    const log = EpochInputLog.parse({
      schema: EPOCH_INPUT_LOG_SCHEMA_ID, chainId: CHAIN_ID, shop: LEDGER, epoch: e, firstWindow: win.first, lastWindow: win.last, prevHead, head, seed: seedOf(e), windows: windowsIn,
    });
    files.set(`${e}.json`, enc(log));
    const used = sessionsUsed(lists.flatMap((l) => l.entries), (wa, sk) => sessions.get(sessionKeyOf(wa, sk)));
    files.set(`ledger/${e}.json`, enc(ledgerFileText(buildLedgerEpochFile({ ctx, epoch: e, genesisBlock: W0, lists, sessions: used, blockTimestamps: stamps }))));
    files.set(`snapshots/${e}.json`, enc({ epoch: e, processedWindow: win.last, inputLogHead: head, world: { rooms: sim.rooms.map((x) => ({ roomId: x.roomId, state: x.state })) } }));
    lists = [];
    windowsIn = [];
    stamps.clear();
    const k = (ROOT_EPOCHS as readonly number[]).indexOf(e);
    if (k < 0) continue;
    // 루트 경계: 잎 파일 + 10칸 (dataHash = 공개 바이트의 sha256)
    files.set(`ledger/leaves/${k}.json`, enc(ledgerFileText(buildLedgerLeavesFile({ chainId: CHAIN_ID, ledger: LEDGER, rootIndex: k, epoch: e, genesisBlock: W0, state }))));
    const fields = ledgerRootFields({
      epoch: e, genesisBlock: W0, seed: seedOf(e), roomsStateRoot: roomsStateRoot(worldStateHashes(sim)), inputLogRoot: head, boardBatchRoot: boardBatchRoot(batches),
      state, payouts, fromEpoch, rootIndex: k, files: new Map([...files].map(([p, b]) => [p, fileSha256(b)])),
    });
    roots.push({ ...fields, rootIndex: k, postedBlock: rootThroughWindow(e, W0) + 300, txHash: keccak256(new TextEncoder().encode(`root-tx-${k}`)) });
    fromEpoch = e + 1;
    payouts = [];
    batches = [];
  }

  const blockHashes: Record<string, string> = {};
  const blockTimestamps: Record<string, number> = {};
  for (let w = W0 - 200; w <= LAST + 2_000; w++) {
    blockHashes[String(w)] = blockHashHex(w);
    blockTimestamps[String(w)] = ts(w);
  }
  const chain: LedgerChainFile = {
    schema: LEDGER_CHAIN_SCHEMA_ID, chainId: CHAIN_ID, ledger: LEDGER, seedRoot: seedOf(0), genesisBlock: W0, rulesHash: RULES, ledgerHash: LEDGER_VERSION_HASH,
    roomIds: [1], epochBlocks: 200, announcerDelay: 20, finalized: roots[roots.length - 1]!.postedBlock + 1_000, roots,
    announcerChanges: [
      { previous: ZERO_ADDRESS, next: ANNOUNCE.address, fromWindow: W0, blockNumber: W0 - 100, logIndex: 0 },
      { previous: ANNOUNCE.address, next: ANNOUNCE2.address, fromWindow: ROTATE_FROM, blockNumber: ROTATE_BLOCK, logIndex: 0 },
    ],
    blockHashes, blockTimestamps,
    erc1271: [{ wallet: SMART, hash: hashLedgerSession(domain(), smartSession), signature: SMART_SIG, blockNumber: SMART_BLOCK, valid: true }],
  };
  const world = {
    schema: WORLD_MANIFEST_SCHEMA_ID, chainId: CHAIN_ID, shop: LEDGER, genesisBlock: W0, seedRoot: seedOf(0), engineVersionHash: engineVersionHash(),
    ledgerVersionHash: LEDGER_VERSION_HASH, rooms: [{ roomId: 1, createdWindow: W0, catalogHash }],
  };
  return { files, world, catalogs: new Map([[catalogHash, JSON.parse(JSON.stringify(cat)) as unknown]]), chain, decisions };
}

/** 파일 하나를 JSON으로 고친다 (위조 시험). 바뀐 파일 묶음을 돌려준다 — 원본은 그대로. */
export function mutateJson(files: ReadonlyMap<string, Uint8Array>, path: string, f: (x: any) => void): Map<string, Uint8Array> {
  const out = new Map(files);
  const x = JSON.parse(new TextDecoder().decode(files.get(path)!));
  f(x);
  out.set(path, enc(x));
  return out;
}
