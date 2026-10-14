import {
  addRoom, createRoom, engineVersionHash, lazyWindowRng, regenerateBatch, runWorldWindow, type RoomState, type World, type WorldWindowResult,
} from "@pikit/engine";
import {
  canonicalHash, chainInputLog, EPOCH_BLOCKS, EpochInputLog, epochLogEntries, epochWindows, hashLedgerSession, hexToBytes, INPUT_LOG_GENESIS_HEAD,
  onchainRulesHash, parseCatalog, rootDataPaths, rootThroughWindow, seedChainLinks, seedParent, WorldManifest,
  type Catalog, type Hex32, type LedgerEpochFile, type LedgerLeavesFile, type LedgerRootRecord,
} from "@pikit/protocol";
import { AGREE_CHECK, ChainDisagreement } from "./agree.js";
import { announcerKeyAt, type LedgerChainSource, type LedgerWorldFacts } from "./ledger-chain.js";
import {
  checkLeavesFile, checkLedgerInvariants, compareLedgerRoot, contextDomain, fileSha256, LEDGER_VERSION_HASH, LedgerListError, LedgerReplayer, LedgerState,
  ledgerInputEvents, linkRooms, parseLedgerEpochFile, parseLedgerLeavesFile, type DecisionMismatch, type LedgerContext,
} from "./ledger/index.js";
import { checkInputLinkage, describeLinkMismatch } from "./linkage.js";
import { boardBatchRoot, commitBatch, roomsStateRoot, worldStateHashes, type CommittedBatch } from "./roots.js";

// ──────────────────────────────────────────────────────────────────────────
// 개정 7 공개 검증 (명세 20 §2.11, 계획 §2.11·§4.2 B5, D205): 체인 PikitLedger의 루트마다 공개 파일만으로 명단 → 장부 → 엔진을 다시 돌려
// 루트 10칸을 다시 만들고 체인 `RootPosted`와 대조한다. 루트 k는 에폭 (직전 루트 epoch, 이 루트 epoch]를 덮는다.
//
//  0) 신뢰 뿌리 (체인을 읽기 전): world.shop = 고정한 PikitLedger, world.engineVersionHash = 이 빌드 엔진, world.ledgerVersionHash = 이 빌드 장부 규칙.
//     체인: ledgerHash = LEDGER_VERSION_HASH, 방마다 keccak256(catalogHash ‖ engineVersionHash) = rulesHash, chainId·seedRoot·genesisBlock·방 목록
//     = world.json, EPOCH_BLOCKS = 200, 고정한 chainId·ledgerHash·rulesHash(--trust)도. 가격·상한은 이 카탈로그(rulesHash가 묶는다)와 장부 규칙이 정한다
//  1) 범위 파일(rootDataPaths)이 모두 있고 → 루트의 dataHash (마지막 단계에서 다시 계산)
//  2) 시드: S_epoch(루트 칸)가 앞 루트의 시드(처음이면 seedRoot)까지 keccak으로 이어지고, 범위 에폭 시드는 거기서 내려간다(파일 seed는 같아야)
//  3) 명단 서명자 = 그 창의 ANNOUNCE 키 (`AnnouncerChanged`의 fromWindow로 정함, announcerKeyAt) — A3 LedgerReplayer.listProblems
//  4) 명단 항목 = 서명된 entriesHash (ref·count·순서) — LedgerListError
//  5) 의향서·세션: 세션 키 서명·EOA 지갑 서명은 장부 규칙(재생 결정)이, ERC-1271 세션은 여기서 RPC로 erc1271Block에서 `isValidSignature`.
//     명단 창의 블록 timestamp(파일) = 체인 블록 timestamp (기한·GRANT 날 재료)
//  6) 장부 재생 결정 = 파일 결정 · 범위 밖 명단 없음
//  7) 입력 = 명단: 기존 checkInputLinkage(events = ledgerInputEvents(받은 항목)), 입력 기록 해시 사슬(prevHead·head)
//  8) 엔진 재생(같은 ledgerWindow 순서) → roomsStateRoot·inputLogRoot·boardBatchRoot(범위 안에서 끝난 묶음) + 묶음 생성 검사
//  9) 잎 파일 = 재생 잎, 루트 10칸(ledgerRoot·payoutsRoot·supplyMilli·dataHash 포함) = 체인
// 10) 불변식 (가)(나)(다) — checkLedgerInvariants
// 11) RPC 2곳이 모든 체인 값에 동의 (RpcLedgerSource, ChainDisagreement)
// 시작: 처음부터(genesis) 또는 루트 j 경계(`snapshots/<epoch_j>.json` + `ledger/leaves/<j>.json` — 스냅숏 = 루트 j의 roomsStateRoot·inputLogRoot,
//   잎 = 루트 j의 ledgerRoot·supplyMilli). 루트 하나라도 실패하면 거기서 멈춘다(그 뒤 루트는 검증하지 않음).
// 증명하지 못하는 것(VERIFY.md §8.6): 명단이 블록 전에 나왔는지 · 오늘 받기 자격 · 검열.
// ──────────────────────────────────────────────────────────────────────────

/** 운영자 파일 밖에서 고정한 신뢰 뿌리 (CLI --contract / --trust). contract 필수, 나머지는 주면 대조. */
export interface LedgerTrustPins {
  contract: string;
  chainId?: number;
  ledgerHash?: string;
  rulesHash?: string;
}

/** 이 실행이 믿은 뿌리 — 보고서 맨 위. null = 체인을 읽기 전에 멈춤. */
export interface LedgerTrustRoots {
  chainId: number | null;
  contract: string;
  contractPinned: boolean;
  seedRoot: string | null;
  genesisBlock: number | null;
  rulesHash: string | null;
  ledgerHash: string | null;
  engineVersionHash: string;
  ledgerVersionHash: string;
  rooms: { roomId: number; catalogHash: string; rulesHash: string }[];
  /** 기준 블록에서 마지막으로 정한 ANNOUNCE 키 (참고). */
  announcer: string | null;
}

export interface VerifyCheck {
  name: string;
  ok: boolean;
  detail?: string;
}

/** 범위: 마지막 루트(번호 | latest), 시작(genesis | 루트 j 경계 | 없음 = 바로 앞 루트 = 루트 하나), 한 번에 검증할 루트 수 상한. */
export interface RootRangeRequest {
  last: number | "latest";
  from?: number | "genesis";
  maxRoots?: number;
}

/** 이어 받기 (--since-state): 앞 실행이 검증한 마지막 루트와 그 칸 — 시작 경계의 체인 루트가 이것과 같아야 한다. */
export interface ResumePoint {
  lastRoot: number;
  epoch: number;
  roomsStateRoot: string;
  inputLogRoot: string;
  ledgerRoot: string;
}

export interface RootRange {
  firstRoot: number;
  lastRoot: number;
  latestRoot: number;
  /** 시작 경계 루트 (null = 처음부터). */
  startRoot: number | null;
  firstEpoch: number;
  lastEpoch: number;
  latestEpoch: number;
  note: string;
}

export interface RootResult {
  rootIndex: number;
  fromEpoch: number;
  epoch: number;
  throughWindow: number;
  postedBlock: number;
  ok: boolean;
  /** 체인과 다른 루트 칸 이름. */
  mismatchedFields: string[];
}

export interface LedgerSummary {
  lists: number;
  entries: number;
  applied: number;
  rejected: Record<string, number>;
  grantedMilli: string;
  sessions: number;
  erc1271Sessions: number;
  payouts: number;
}

/** 검증을 끝까지 통과한 마지막 루트 (다음 실행의 시작 경계). */
export interface VerifiedRoot {
  rootIndex: number;
  epoch: number;
  throughWindow: number;
  roomsStateRoot: string;
  inputLogRoot: string;
  ledgerRoot: string;
}

export interface LedgerVerifyReport {
  ok: boolean;
  /** --since-state: 체인에 새 루트가 없다 (검증할 것 없음). */
  upToDate: boolean;
  trust: LedgerTrustRoots;
  roots: { first: number; last: number; latest: number } | null;
  epochs: { first: number; last: number; latest: number } | null;
  windows: { first: number; last: number } | null;
  start: { root: number; epoch: number; throughWindow: number } | null;
  checks: VerifyCheck[];
  rootResults: RootResult[];
  ledger: LedgerSummary;
  linkage: { checked: number; matched: number; mismatches: number };
  batches: number;
  /** 체인 기준 블록 (확정 머리). 체인을 읽지 못했으면 −1. */
  chainThroughBlock: number;
  /** 없는 공개 파일 (루트와 그 루트가 실린 블록 — CLI가 체인 끝 경합을 가른다). */
  missing: { path: string; rootIndex: number; postedBlock: number }[];
  disagreement?: { what: string; rpc1: string; rpc2: string };
  verified: VerifiedRoot | null;
}

export interface LedgerVerifyInput {
  world: unknown;
  catalogs: ReadonlyMap<string, unknown>;
  chain: LedgerChainSource;
  /** 공개 파일 (에폭 디렉터리 기준 경로, 받은 바이트 그대로 — dataHash 재료). 없는 파일은 null. */
  read: (paths: readonly string[]) => Promise<(Uint8Array | null)[]>;
  trust?: LedgerTrustPins;
  range: RootRangeRequest;
  resume?: ResumePoint;
  /** 범위를 정한 뒤 (파일을 읽기 전에) 한 번. */
  onRange?: (r: RootRange) => void;
  /** 진행 한 줄 (루트마다). */
  onProgress?: (line: string) => void;
}

/** 범위를 고를 수 없음 (체인에 루트가 없음·없는 루트 번호) — CLI 종료 1. */
export class VerifyRangeError extends Error {}

/** 검사 이름 (CLI·시험·감시가 찾는다). */
export const LEDGER_CHECK = {
  pinned: "trust: world.shop = the PikitLedger you pinned (--contract / --trust)",
  engine: "trust: engine build = world.engineVersionHash",
  ledgerBuild: "trust: ledger rules build (LEDGER_VERSION_HASH) = world.ledgerVersionHash",
  chainLedgerHash: "trust: chain ledgerHash = this build's ledger rules (LEDGER_VERSION_HASH)",
  chainRulesHash: "trust: chain rulesHash = keccak256(catalogHash ‖ engineVersionHash) of every room",
  world: "trust: world.json chainId · seedRoot · genesisBlock · rooms (all created at W0) = chain",
  epochBlocks: `trust: chain EPOCH_BLOCKS = ${EPOCH_BLOCKS}`,
  catalogs: "trust: every room's catalog is published and canonicalHash(catalog) = catalogHash",
} as const;

/** 루트마다의 검사 (이름 = `root <k>: <검사>`). */
export const ROOT_CHECK = {
  files: "every public file of the range is published (input logs, ledger files, boundary snapshot, leaves file)",
  formats: "public files have their formats (pikit.inputlog/v3, pikit.ledger/v1, snapshot, pikit.ledger-leaves/v1) and epochs",
  seed: "seed chain: S_epoch hashes down to the previous root's seed (seedRoot at genesis)",
  log: "input log hash chain (prevHead continues, head recomputed)",
  announce: "list signatures = the ANNOUNCE key of each window (AnnouncerChanged)",
  entries: "list entries = the signed entriesHash (ref, count, order)",
  auth: "intent auth: smart-wallet sessions pass ERC-1271 isValidSignature at erc1271Block",
  timestamps: "list block timestamps = chain block timestamps",
  replay: "ledger + engine replay",
  decisions: "ledger decisions = replay (applied/rejected, reason, purchaseId)",
  unplayed: "every list lies inside the root's windows",
  linkage: "inputs = signed lists (window w ← list w in list order, same fields)",
  batches: "board batches regenerated from seeds + block hashes",
  invariants: "ledger invariants (open stake = engine, supply = start + grants − losses, balance ≥ 0)",
  leaves: "leaves file = replayed ledger",
  snapshot: "boundary snapshot = replayed world (epoch, window, rooms' state hashes, input log head)",
  fields: "root fields = chain RootPosted (epoch, seed, throughWindow, roomsStateRoot, inputLogRoot, boardBatchRoot, ledgerRoot, payoutsRoot, supplyMilli, dataHash)",
} as const;

export const rootCheckName = (k: number, what: keyof typeof ROOT_CHECK) => `root ${k}: ${ROOT_CHECK[what]}`;
/** 시작 경계 검사 (`start: …`). */
export const START_CHECK = {
  files: "start: boundary snapshot and leaves file of the start root are published",
  snapshot: "start: boundary snapshot = start root's roomsStateRoot and inputLogRoot",
  leaves: "start: leaves file = start root's ledgerRoot and supplyMilli",
  resume: "start: chain root = the root the previous run verified (verify-state)",
} as const;

/** game-server 경계 스냅숏 (`snapshots/<epoch>.json`). world = 엔진 객체 JSON 그대로. */
interface SnapshotFile {
  epoch: number;
  processedWindow: number;
  inputLogHead: string;
  world: { rooms: { roomId: number; state: unknown }[] };
}

function parseSnapshot(x: unknown): SnapshotFile {
  const s = x as SnapshotFile;
  const ok = s && typeof s === "object" && Number.isSafeInteger(s.epoch) && Number.isSafeInteger(s.processedWindow) && typeof s.inputLogHead === "string"
    && /^0x[0-9a-f]{64}$/.test(s.inputLogHead) && s.world && Array.isArray(s.world.rooms)
    && s.world.rooms.every((r) => r && Number.isSafeInteger(r.roomId) && r.state && typeof r.state === "object");
  if (!ok) throw new Error("snapshot file has the shape { epoch, processedWindow, inputLogHead, world: { rooms: [{ roomId, state }] } }");
  return s;
}

class Fail extends Error {}

/** 체인·파일 읽기 오류(RPC 장애·HTTP 5xx 등)는 검사 실패가 아니라 그대로 던진다 (CLI 전송 오류 분류). 없는 파일은 null이라 여기 오지 않는다. */
class ChainReadError extends Error {
  constructor(readonly original: unknown) { super("read failed"); }
}
async function chainRead<T>(p: Promise<T>): Promise<T> {
  try {
    return await p;
  } catch (e) {
    if (e instanceof ChainDisagreement || e instanceof VerifyRangeError) throw e;
    throw new ChainReadError(e);
  }
}

/** 공개 파일 읽기 — 오류는 그대로 위로 (검사 실패가 아니다). */
async function fileRead(p: Promise<(Uint8Array | null)[]>): Promise<(Uint8Array | null)[]> {
  try {
    return await p;
  } catch (e) {
    throw new ChainReadError(e);
  }
}

const json = (b: Uint8Array) => JSON.parse(new TextDecoder().decode(b)) as unknown;
const brief = (d: { status: string; reason: string | null; purchaseId: string | null }) =>
  d.status === "APPLIED" ? (d.purchaseId === null ? "APPLIED" : `APPLIED#${d.purchaseId}`) : d.reason!;
const describeDecision = (m: DecisionMismatch) => `list ${m.window} entry ${m.index}: file ${brief(m.file)} vs replay ${brief(m.replay)}`;
const list = (xs: readonly string[], n = 5) => `${xs.slice(0, n).join("; ")}${xs.length > n ? ` … (${xs.length})` : ""}`;

/** 범위 고르기 (체인 rootCount·rootAt만 — 로그를 처음부터 읽지 않는다). upToDate = 이어 받기인데 새 루트가 없음. */
export async function resolveRootRange(
  facts: LedgerWorldFacts, root: (k: number) => Promise<LedgerRootRecord>, req: RootRangeRequest, resume?: ResumePoint,
): Promise<RootRange & { upToDate: boolean }> {
  if (facts.rootCount === 0) throw new VerifyRangeError("no root on chain yet — nothing to verify");
  const latestRoot = facts.rootCount - 1;
  let lastRoot = req.last === "latest" ? latestRoot : req.last;
  if (lastRoot > latestRoot) throw new VerifyRangeError(`root ${lastRoot} is not on chain yet (the last root at block ${facts.finalized} is ${latestRoot})`);
  let startRoot: number | null;
  let note: string;
  if (resume) {
    if (resume.lastRoot > latestRoot) throw new VerifyRangeError(`--since-state says root ${resume.lastRoot} was verified, but the chain has roots 0…${latestRoot} — another PikitLedger?`);
    if (resume.lastRoot >= lastRoot) {
      const latestEpoch = (await root(latestRoot)).epoch;
      return {
        upToDate: true, firstRoot: resume.lastRoot + 1, lastRoot: resume.lastRoot, latestRoot, startRoot: resume.lastRoot, firstEpoch: resume.epoch + 1,
        lastEpoch: resume.epoch, latestEpoch, note: `up to date: root ${lastRoot} is ${req.last === "latest" ? "the last root" : "the requested root"}, already verified (state: through root ${resume.lastRoot})`,
      };
    }
    startRoot = resume.lastRoot;
    note = `resuming after root ${startRoot} (verify-state)`;
  } else if (req.from === "genesis") {
    startRoot = null;
    note = "from genesis";
  } else if (typeof req.from === "number") {
    if (req.from >= lastRoot) throw new VerifyRangeError(`--from-snapshot ${req.from} is not before root ${lastRoot}`);
    startRoot = req.from;
    note = `from the boundary of root ${startRoot} (its snapshot + leaves file)`;
  } else {
    startRoot = lastRoot >= 1 ? lastRoot - 1 : null;
    note = startRoot === null ? "root 0 from genesis" : `root ${lastRoot} alone, from the boundary of root ${startRoot}`;
  }
  const firstRoot = startRoot === null ? 0 : startRoot + 1;
  if (req.maxRoots !== undefined && lastRoot - firstRoot + 1 > req.maxRoots) {
    const end = firstRoot + req.maxRoots - 1;
    note += `; capped at ${req.maxRoots} roots: through root ${end} of ${lastRoot} (catching up)`;
    lastRoot = end;
  }
  const firstEpoch = startRoot === null ? 1 : (await root(startRoot)).epoch + 1;
  const lastEpoch = (await root(lastRoot)).epoch;
  const latestEpoch = (await root(latestRoot)).epoch;
  return { upToDate: false, firstRoot, lastRoot, latestRoot, startRoot, firstEpoch, lastEpoch, latestEpoch, note };
}

/** 개정 7 공개 검증 (위 머리말). 첫 실패 루트에서 멈춘다. 체인 읽기 오류는 던진다(전송 오류 — CLI 종료 3), RPC 불일치는 실패 검사. */
export async function verifyLedger(i: LedgerVerifyInput): Promise<LedgerVerifyReport> {
  const checks: VerifyCheck[] = [];
  const check = (name: string, ok: boolean, detail?: string) => { checks.push(ok || detail === undefined ? { name, ok } : { name, ok, detail }); return ok; };
  const must = (name: string, ok: boolean, detail?: string) => { if (!check(name, ok, detail)) throw new Fail(name); };

  const world = WorldManifest.parse(i.world);
  const W0 = world.genesisBlock;
  const engineHash = engineVersionHash();
  const pins = i.trust;
  const trust: LedgerTrustRoots = {
    chainId: null, contract: pins ? pins.contract.toLowerCase() : world.shop, contractPinned: pins !== undefined, seedRoot: null, genesisBlock: null,
    rulesHash: null, ledgerHash: null, engineVersionHash: engineHash, ledgerVersionHash: LEDGER_VERSION_HASH, announcer: null,
    rooms: world.rooms.map((r) => ({ roomId: r.roomId, catalogHash: r.catalogHash, rulesHash: onchainRulesHash(r.catalogHash as Hex32, engineHash as Hex32) })),
  };
  const report: LedgerVerifyReport = {
    ok: false, upToDate: false, trust, roots: null, epochs: null, windows: null, start: null, checks, rootResults: [],
    ledger: { lists: 0, entries: 0, applied: 0, rejected: {}, grantedMilli: "0", sessions: 0, erc1271Sessions: 0, payouts: 0 },
    linkage: { checked: 0, matched: 0, mismatches: 0 }, batches: 0, chainThroughBlock: -1, missing: [], verified: null,
  };

  try {
    // ── 0) 신뢰 뿌리: 체인을 읽기 전에 (규칙·주소가 다른 세계에 RPC를 쓰지 않는다)
    if (pins) must(LEDGER_CHECK.pinned, world.shop === trust.contract, `world.json ${world.shop} vs pinned ${trust.contract}`);
    must(LEDGER_CHECK.engine, world.engineVersionHash === engineHash, `world ${world.engineVersionHash} vs this build ${engineHash}`);
    must(LEDGER_CHECK.ledgerBuild, world.ledgerVersionHash === LEDGER_VERSION_HASH, `world ${world.ledgerVersionHash ?? "none (not a rev 7 world)"} vs this build ${LEDGER_VERSION_HASH}`);
    const catalogs = new Map<number, Catalog>();
    const badCatalogs: string[] = [];
    for (const r of world.rooms) {
      const raw = i.catalogs.get(r.catalogHash);
      if (raw === undefined) { badCatalogs.push(`room ${r.roomId}: catalogs/${r.catalogHash}.json missing`); continue; }
      const c = parseCatalog(raw);
      if (canonicalHash(c) !== r.catalogHash) badCatalogs.push(`room ${r.roomId}: canonicalHash ${canonicalHash(c)} ≠ ${r.catalogHash}`);
      catalogs.set(r.roomId, c);
    }
    must(LEDGER_CHECK.catalogs, badCatalogs.length === 0, list(badCatalogs));

    const facts = await chainRead(i.chain.world());
    report.chainThroughBlock = facts.finalized;
    Object.assign(trust, {
      chainId: facts.chainId, seedRoot: facts.seedRoot, genesisBlock: facts.genesisBlock, rulesHash: facts.rulesHash, ledgerHash: facts.ledgerHash, announcer: facts.announcer,
    });
    must(LEDGER_CHECK.chainLedgerHash, facts.ledgerHash === LEDGER_VERSION_HASH, `chain ${facts.ledgerHash} vs this build ${LEDGER_VERSION_HASH}`);
    const wrongRules = trust.rooms.filter((r) => r.rulesHash !== facts.rulesHash).map((r) => `room ${r.roomId}: replay ${r.rulesHash} vs chain ${facts.rulesHash}`);
    must(LEDGER_CHECK.chainRulesHash, wrongRules.length === 0, list(wrongRules));
    if (pins?.chainId !== undefined) must("trust: pinned chainId = chain", pins.chainId === facts.chainId, `pinned ${pins.chainId} vs chain ${facts.chainId}`);
    if (pins?.ledgerHash !== undefined) must("trust: pinned ledgerHash = chain ledgerHash", pins.ledgerHash.toLowerCase() === facts.ledgerHash, `pinned ${pins.ledgerHash} vs chain ${facts.ledgerHash}`);
    if (pins?.rulesHash !== undefined) must("trust: pinned rulesHash = chain rulesHash", pins.rulesHash.toLowerCase() === facts.rulesHash, `pinned ${pins.rulesHash} vs chain ${facts.rulesHash}`);
    const worldDiff: string[] = [];
    if (world.chainId !== facts.chainId) worldDiff.push(`chainId ${world.chainId} vs ${facts.chainId}`);
    if (world.seedRoot !== facts.seedRoot) worldDiff.push(`seedRoot ${world.seedRoot} vs ${facts.seedRoot}`);
    if (world.genesisBlock !== facts.genesisBlock) worldDiff.push(`genesisBlock ${world.genesisBlock} vs ${facts.genesisBlock}`);
    if (world.rooms.map((r) => r.roomId).join(",") !== facts.roomIds.join(",")) worldDiff.push(`rooms ${world.rooms.map((r) => r.roomId).join(",")} vs ${facts.roomIds.join(",")}`);
    for (const r of world.rooms) if (r.createdWindow !== facts.genesisBlock) worldDiff.push(`room ${r.roomId} createdWindow ${r.createdWindow} ≠ W0 ${facts.genesisBlock}`);
    must(LEDGER_CHECK.world, worldDiff.length === 0, list(worldDiff));
    must(LEDGER_CHECK.epochBlocks, facts.epochBlocks === EPOCH_BLOCKS, `chain ${facts.epochBlocks}`);

    const ctx: LedgerContext = {
      chainId: world.chainId, ledger: world.shop,
      rooms: world.rooms.map((r) => ({ roomId: r.roomId, createdWindow: r.createdWindow, catalog: catalogs.get(r.roomId)!, rulesHash: facts.rulesHash })),
    };

    // ── 범위
    const rootCache = new Map<number, Promise<LedgerRootRecord>>();
    const rootAt = (k: number) => {
      let p = rootCache.get(k);
      if (!p) rootCache.set(k, p = chainRead(i.chain.root(k)));
      return p;
    };
    const range = await resolveRootRange(facts, rootAt, i.range, i.resume);
    report.roots = { first: range.firstRoot, last: range.lastRoot, latest: range.latestRoot };
    report.epochs = { first: range.firstEpoch, last: range.lastEpoch, latest: range.latestEpoch };
    if (range.upToDate) {
      report.upToDate = true;
      report.ok = checks.every((c) => c.ok);
      return report;
    }
    report.windows = { first: epochWindows(range.firstEpoch, W0).first, last: rootThroughWindow(range.lastEpoch, W0) };
    i.onRange?.(range);

    // ── 시작: 처음부터 또는 루트 j 경계 (스냅숏 + 잎 파일)
    const sim: World = { rooms: [] };
    let state = new LedgerState();
    let head: Hex32 = INPUT_LOG_GENESIS_HEAD;
    let known: { seed: Hex32; epoch: number } = { seed: facts.seedRoot as Hex32, epoch: 0 };
    let prevEpoch = 0;
    if (range.startRoot !== null) {
      const j = range.startRoot;
      const R = await rootAt(j);
      if (i.resume) {
        must(START_CHECK.resume, R.epoch === i.resume.epoch && R.roomsStateRoot === i.resume.roomsStateRoot && R.inputLogRoot === i.resume.inputLogRoot && R.ledgerRoot === i.resume.ledgerRoot,
          `state: root ${i.resume.lastRoot} epoch ${i.resume.epoch} ledgerRoot ${i.resume.ledgerRoot}; chain: epoch ${R.epoch} ledgerRoot ${R.ledgerRoot}`);
      }
      const paths = [`snapshots/${R.epoch}.json`, `ledger/leaves/${j}.json`];
      const [snapBytes, leavesBytes] = await fileRead(i.read(paths));
      const missing = paths.filter((_, n) => [snapBytes, leavesBytes][n] === null);
      report.missing.push(...missing.map((path) => ({ path, rootIndex: j, postedBlock: R.postedBlock })));
      must(START_CHECK.files, missing.length === 0, `missing: ${missing.join(", ")}`);
      let snap: SnapshotFile;
      let leaves: LedgerLeavesFile;
      try {
        snap = parseSnapshot(json(snapBytes!));
        leaves = parseLedgerLeavesFile(json(leavesBytes!));
      } catch (e) {
        return fail(START_CHECK.files, `unreadable: ${(e as Error).message.split("\n")[0]}`);
      }
      const snapProblems: string[] = [];
      if (snap.epoch !== R.epoch || snap.processedWindow !== R.throughWindow) snapProblems.push(`snapshot is epoch ${snap.epoch} window ${snap.processedWindow}, root ${j} is epoch ${R.epoch} window ${R.throughWindow}`);
      if (snap.world.rooms.map((r) => r.roomId).join(",") !== world.rooms.map((r) => r.roomId).join(",")) snapProblems.push("snapshot rooms ≠ world rooms");
      else for (const r of snap.world.rooms) addRoom(sim, { roomId: r.roomId, catalog: catalogs.get(r.roomId)!, state: r.state as RoomState });
      if (snapProblems.length === 0 && roomsStateRoot(worldStateHashes(sim)) !== R.roomsStateRoot) snapProblems.push(`roomsStateRoot ${roomsStateRoot(worldStateHashes(sim))} ≠ chain ${R.roomsStateRoot}`);
      if (snap.inputLogHead !== R.inputLogRoot) snapProblems.push(`inputLogHead ${snap.inputLogHead} ≠ chain inputLogRoot ${R.inputLogRoot}`);
      must(START_CHECK.snapshot, snapProblems.length === 0, list(snapProblems));
      const leafProblems: string[] = [];
      try {
        state = LedgerState.fromLeaves(leaves.leaves, leaves.nextPurchaseId);
      } catch (e) {
        leafProblems.push((e as Error).message);
      }
      if (leaves.chainId !== world.chainId || leaves.ledger !== world.shop || leaves.rootIndex !== j || leaves.epoch !== R.epoch || leaves.throughWindow !== R.throughWindow) {
        leafProblems.push(`file is ${leaves.chainId}/${leaves.ledger} root ${leaves.rootIndex} epoch ${leaves.epoch} window ${leaves.throughWindow}`);
      }
      if (state.root() !== R.ledgerRoot || leaves.ledgerRoot !== R.ledgerRoot) leafProblems.push(`ledgerRoot of the leaves ${state.root()} (file says ${leaves.ledgerRoot}) ≠ chain ${R.ledgerRoot}`);
      if (state.supplyMilli().toString() !== R.supplyMilli || leaves.supplyMilli !== R.supplyMilli) leafProblems.push(`supply ${state.supplyMilli()} (file ${leaves.supplyMilli}) ≠ chain ${R.supplyMilli}`);
      must(START_CHECK.leaves, leafProblems.length === 0, list(leafProblems));
      head = snap.inputLogHead as Hex32;
      known = { seed: R.seed as Hex32, epoch: R.epoch };
      prevEpoch = R.epoch;
      report.start = { root: j, epoch: R.epoch, throughWindow: R.throughWindow };
    }

    const rep = new LedgerReplayer(ctx, state);
    const ledgerBytes = hexToBytes(world.shop);
    const hashes: Record<string, string> = {};
    const seeds = new Map<number, Hex32>();
    const seedBytes = new Map<number, Uint8Array>();
    /** S_e. 범위 앞 에폭(스냅숏 앞에서 시작한 묶음 줄)은 아는 가장 앞 시드에서 keccak으로 내려가 얻는다. */
    const seedHex = (e: number): Hex32 => {
      let s = seeds.get(e);
      if (s) return s;
      let at = Math.min(...seeds.keys());
      s = seeds.get(at)!;
      while (at > e) { at -= 1; s = seedParent(s); seeds.set(at, s); }
      return s;
    };
    const seedOf = (w: number) => () => {
      const e = Math.floor((w - W0) / EPOCH_BLOCKS) + 1;
      let b = seedBytes.get(e);
      if (!b) { b = hexToBytes(seedHex(e)); seedBytes.set(e, b); }
      return b;
    };
    const blockHashOf = (w: number) => () => {
      const h = hashes[String(w)];
      if (!h) throw new Fail(`block hash of window ${w} missing from chain data`);
      return hexToBytes(h);
    };
    const rngFor = (w: number) => (roomId: number) => lazyWindowRng(seedOf(w), world.chainId, ledgerBytes, roomId, w, blockHashOf(w));
    const regenOk = (b: CommittedBatch) => {
      const regen = regenerateBatch(catalogs.get(b.roomId)!, b.batchIndex, b.rowWindows, (rw) => rngFor(rw)(b.roomId));
      return regen.every((x, n) => x === b.kinds[n]);
    };
    let seenDecisions = 0;
    let seenListProblems = 0;

    // ── 루트마다
    for (let k = range.firstRoot; k <= range.lastRoot; k++) {
      const R = await rootAt(k);
      const a = prevEpoch + 1;
      const b = R.epoch;
      const Wa = epochWindows(a, W0).first;
      const Wb = rootThroughWindow(b, W0);
      const result: RootResult = { rootIndex: k, fromEpoch: a, epoch: b, throughWindow: Wb, postedBlock: R.postedBlock, ok: false, mismatchedFields: [] };
      report.rootResults.push(result);
      const before = checks.length;
      i.onProgress?.(`root ${k}: epochs ${a} … ${b} (windows ${Wa} … ${Wb})`);
      const rc = (what: keyof typeof ROOT_CHECK, ok: boolean, detail?: string) => check(rootCheckName(k, what), ok, detail);
      const rm = (what: keyof typeof ROOT_CHECK, ok: boolean, detail?: string) => must(rootCheckName(k, what), ok, detail);
      if (b < a || R.throughWindow !== Wb) rm("fields", false, `chain root ${k}: epoch ${b} after epoch ${prevEpoch}, throughWindow ${R.throughWindow} (expected ${Wb})`);

      // 1) 파일 (받은 바이트 그대로 sha256)
      const paths = rootDataPaths(a, b, k);
      const bytes = await fileRead(i.read(paths));
      const missing = paths.filter((_, n) => bytes[n] === null);
      report.missing.push(...missing.map((path) => ({ path, rootIndex: k, postedBlock: R.postedBlock })));
      rm("files", missing.length === 0, `missing: ${list(missing, 10)}`);
      const sha = new Map(paths.map((p, n) => [p, fileSha256(bytes[n]!)]));
      const at = (p: string) => bytes[paths.indexOf(p)]!;

      const logs: EpochInputLog[] = [];
      const ledgerFiles: LedgerEpochFile[] = [];
      let snap: SnapshotFile;
      let leaves: LedgerLeavesFile;
      const formats: string[] = [];
      try {
        for (let e = a; e <= b; e++) {
          const w = epochWindows(e, W0);
          const log = EpochInputLog.parse(json(at(`${e}.json`)));
          if (log.epoch !== e || log.firstWindow !== w.first || log.lastWindow !== w.last) formats.push(`${e}.json is epoch ${log.epoch} [${log.firstWindow}, ${log.lastWindow}]`);
          if (log.chainId !== world.chainId || log.shop !== world.shop) formats.push(`${e}.json is for ${log.chainId}/${log.shop}`);
          logs.push(log);
          const lf = parseLedgerEpochFile(json(at(`ledger/${e}.json`)));
          if (lf.epoch !== e || lf.firstWindow !== w.first || lf.lastWindow !== w.last) formats.push(`ledger/${e}.json is epoch ${lf.epoch} [${lf.firstWindow}, ${lf.lastWindow}]`);
          if (lf.chainId !== world.chainId || lf.ledger !== world.shop) formats.push(`ledger/${e}.json is for ${lf.chainId}/${lf.ledger}`);
          ledgerFiles.push(lf);
        }
        snap = parseSnapshot(json(at(`snapshots/${b}.json`)));
        leaves = parseLedgerLeavesFile(json(at(`ledger/leaves/${k}.json`)));
      } catch (e) {
        return fail(rootCheckName(k, "formats"), (e as Error).message.split("\n")[0]!);
      }
      rm("formats", formats.length === 0, list(formats));

      // 2) 시드
      seeds.clear();
      seedBytes.clear();
      seeds.set(b, R.seed as Hex32);
      for (let e = b; e > a; e--) seeds.set(e - 1, seedParent(seeds.get(e)!));
      const seedProblems = seedChainLinks(R.seed as Hex32, b, known.seed, known.epoch) ? [] : [`keccak^${b - known.epoch}(S_${b} = ${R.seed}) ≠ S_${known.epoch} ${known.seed}`];
      for (const l of logs) if (l.seed !== undefined && l.seed !== seeds.get(l.epoch)) seedProblems.push(`${l.epoch}.json seed ${l.seed} ≠ S_${l.epoch} ${seeds.get(l.epoch)}`);
      rm("seed", seedProblems.length === 0, list(seedProblems));

      // 7') 입력 기록 해시 사슬
      const logProblems: string[] = [];
      for (const log of logs) {
        if (log.prevHead !== head) logProblems.push(`epoch ${log.epoch}: prevHead ${log.prevHead} ≠ ${head}`);
        for (const entry of epochLogEntries(log)) head = chainInputLog(head, entry);
        if (log.head !== head) logProblems.push(`epoch ${log.epoch}: head ${log.head} ≠ recomputed ${head}`);
      }
      rc("log", logProblems.length === 0, list(logProblems));

      // 3·4) 명단: ANNOUNCE 키(창마다), 모양(entriesHash)
      const changes = await chainRead(i.chain.announcerChanges(Math.max(0, Wa - facts.announcerDelay), Wb));
      let base = facts.announcer;
      if (changes.length === 0 && facts.announcerFromWindow > Wa) {
        // 이 범위 뒤에 교체가 있었다 → 범위의 키 = 그 뒤 첫 교체의 previous
        for (let from = Wb + 1; from <= facts.finalized; from += 12_000) {
          const later = await chainRead(i.chain.announcerChanges(from, Math.min(facts.finalized, from + 11_999)));
          if (later.length > 0) { base = later[0]!.previous; break; }
        }
      }
      const announcerAt = (w: number) => announcerKeyAt(changes, base, w);
      try {
        for (const lf of ledgerFiles) await rep.addEpochFile(lf, { announcerAt });
      } catch (e) {
        if (e instanceof LedgerListError) return fail(rootCheckName(k, "entries"), e.message);
        throw e;
      }
      rc("entries", true);
      const listProblems = rep.listProblems.slice(seenListProblems);
      seenListProblems = rep.listProblems.length;
      rc("announce", listProblems.length === 0, list(listProblems));

      // 5) ERC-1271 세션 (erc1271Block에서 RPC로) · 명단 창 timestamp = 체인
      const sessions = new Map<string, LedgerEpochFile["sessions"][number]>();
      for (const lf of ledgerFiles) for (const s of lf.sessions) sessions.set(`${s.session.wallet}:${s.session.sessionKey}:${s.signature}:${s.erc1271Block}`, s);
      const smart = [...sessions.values()].filter((s) => s.erc1271Block !== null);
      report.ledger.sessions += sessions.size;
      report.ledger.erc1271Sessions += smart.length;
      const authProblems: string[] = [];
      for (const s of smart) {
        const hash = hashLedgerSession(contextDomain(ctx), s.session);
        if (!(await chainRead(i.chain.isValidSignature(s.session.wallet, hash, s.signature, s.erc1271Block!)))) {
          authProblems.push(`session ${s.session.wallet} → ${s.session.sessionKey}: isValidSignature is not 0x1626ba7e at block ${s.erc1271Block}`);
        }
      }
      rc("auth", authProblems.length === 0, list(authProblems));
      const tsWindows = [...new Set(ledgerFiles.flatMap((lf) => Object.keys(lf.blockTimestamps).map(Number)))].sort((x, y) => x - y);
      const blocks = await chainRead(i.chain.blocks(Wa, Wb, tsWindows));
      Object.assign(hashes, blocks.hashes);
      const tsProblems: string[] = [];
      for (const lf of ledgerFiles) {
        for (const [w, t] of Object.entries(lf.blockTimestamps)) {
          const c = blocks.timestamps[w];
          if (c !== t) tsProblems.push(`window ${w}: file ${t} vs chain ${c ?? "not read"}`);
        }
      }
      rc("timestamps", tsProblems.length === 0, list(tsProblems));

      // 6·8) 장부 + 엔진 (ledgerWindow 순서), 묶음
      const batches: CommittedBatch[] = [];
      const deferred: CommittedBatch[] = [];
      try {
        for (let w = Wa; w <= Wb; w++) {
          for (const r of world.rooms) {
            if (r.createdWindow === w) addRoom(sim, { roomId: r.roomId, catalog: catalogs.get(r.roomId)!, state: createRoom(catalogs.get(r.roomId)!, rngFor(w)(r.roomId), r.roomId, w) });
          }
          let res: WorldWindowResult | null = null;
          rep.window(w, (inputs) => {
            res = runWorldWindow(sim, w, new Map([...inputs].map(([roomId, l]) => [roomId, l.map((x) => x.input)])), rngFor(w));
            return res;
          });
          for (const { roomId, result } of (res as WorldWindowResult | null)?.rooms ?? []) {
            for (const bt of result.batches) {
              const c = commitBatch(roomId, w, bt);
              batches.push(c);
              if (c.rowWindows.some((rw) => hashes[String(rw)] === undefined)) deferred.push(c);
            }
          }
        }
      } catch (e) {
        if (e instanceof Fail) throw e;
        return fail(rootCheckName(k, "replay"), (e as Error).message);
      }
      if (deferred.length > 0) {
        Object.assign(hashes, await chainRead(i.chain.blockHashesAt([...new Set(deferred.flatMap((x) => x.rowWindows).filter((rw) => hashes[String(rw)] === undefined))])));
      }
      const badBatches: string[] = [];
      for (const bt of batches) {
        try {
          if (!regenOk(bt)) badBatches.push(`room ${bt.roomId} batch ${bt.batchIndex}`);
        } catch (e) {
          badBatches.push(`room ${bt.roomId} batch ${bt.batchIndex}: ${(e as Error).message}`);
        }
      }
      rc("batches", badBatches.length === 0, list(badBatches));
      report.batches += batches.length;

      const decisions = rep.decisionMismatches.slice(seenDecisions);
      seenDecisions = rep.decisionMismatches.length;
      rc("decisions", decisions.length === 0, list(decisions.map(describeDecision)));
      const unplayed = rep.unplayedLists();
      rc("unplayed", unplayed.length === 0, `lists ${unplayed.slice(0, 10).join(", ")} were never played`);

      // 7) 입력 = 명단
      const period = rep.periodApplications();
      const lk = checkInputLinkage({ rooms: linkRooms(ctx), events: ledgerInputEvents(period), windows: logs.flatMap((l) => l.windows), first: Wa, last: Wb });
      report.linkage.checked += lk.checked;
      report.linkage.matched += lk.matched;
      report.linkage.mismatches += lk.mismatches.length + lk.problems.length;
      rc("linkage", lk.mismatches.length === 0 && lk.problems.length === 0 && lk.pending === 0,
        list([...lk.problems.map((p) => `${p.code} ${p.detail}`), ...lk.mismatches.map(describeLinkMismatch), ...(lk.pending > 0 ? [`${lk.pending} inputs carried past the root`] : [])]));
      for (const app of period) {
        report.ledger.lists += 1;
        report.ledger.entries += app.decisions.length;
        for (const d of app.decisions) {
          if (d.status === "APPLIED") report.ledger.applied += 1;
          else report.ledger.rejected[d.reason!] = (report.ledger.rejected[d.reason!] ?? 0) + 1;
        }
      }
      report.ledger.grantedMilli = rep.grantedMilli.toString();
      report.ledger.payouts += rep.periodPayouts().length;

      // 10) 불변식 · 9) 잎 파일 · 루트 10칸
      const inv = checkLedgerInvariants(rep.state, { world: sim, expectedSupplyMilli: rep.expectedSupplyMilli() });
      rc("invariants", inv.length === 0, list(inv));
      const leafProblems = checkLeavesFile(leaves, rep.state, { rootIndex: k, epoch: b, genesisBlock: W0 });
      if (leaves.chainId !== world.chainId || leaves.ledger !== world.shop) leafProblems.push(`file is for ${leaves.chainId}/${leaves.ledger}`);
      rc("leaves", leafProblems.length === 0, list(leafProblems));
      // 경계 스냅숏 = 재생한 세계 (다음 실행이 여기서 시작한다 — dataHash가 바이트를 묶지만 내용도 지금 본다)
      const snapProblems: string[] = [];
      if (snap.epoch !== b || snap.processedWindow !== Wb) snapProblems.push(`file is epoch ${snap.epoch} window ${snap.processedWindow}`);
      if (snap.inputLogHead !== head) snapProblems.push(`inputLogHead ${snap.inputLogHead} ≠ ${head}`);
      const mine = worldStateHashes(sim).rooms;
      const theirs = worldStateHashes({ rooms: snap.world.rooms.map((r) => ({ roomId: r.roomId, state: r.state as RoomState })) }).rooms;
      if (JSON.stringify(mine) !== JSON.stringify(theirs)) snapProblems.push("rooms' state hashes differ from the replay");
      rc("snapshot", snapProblems.length === 0, list(snapProblems));
      const prevThrough = Wa - 1;
      const fields = rep.rootFields({
        epoch: b, genesisBlock: W0, seed: R.seed, roomsStateRoot: roomsStateRoot(worldStateHashes(sim)), inputLogRoot: head,
        boardBatchRoot: boardBatchRoot(batches.filter((x) => x.window > prevThrough && x.window <= Wb)), fromEpoch: a, rootIndex: k, files: sha,
      });
      rep.takePeriod();
      const diffs = compareLedgerRoot(fields, R);
      result.mismatchedFields = diffs.map((d) => d.split(":")[0]!);
      rc("fields", diffs.length === 0, diffs.join("; "));

      result.ok = checks.slice(before).every((c) => c.ok);
      if (!result.ok) throw new Fail(`root ${k}`);
      report.verified = { rootIndex: k, epoch: b, throughWindow: Wb, roomsStateRoot: R.roomsStateRoot, inputLogRoot: R.inputLogRoot, ledgerRoot: R.ledgerRoot };
      known = { seed: R.seed as Hex32, epoch: b };
      prevEpoch = b;
    }
  } catch (e) {
    if (e instanceof ChainReadError) throw e.original;
    if (e instanceof VerifyRangeError) throw e;
    if (e instanceof ChainDisagreement) {
      check(AGREE_CHECK, false, e.message);
      report.disagreement = { what: e.what, rpc1: e.a, rpc2: e.b };
    } else if (!(e instanceof Fail)) {
      check("replay", false, (e as Error).message);
    }
  }
  report.ok = checks.length > 0 && checks.every((c) => c.ok);
  return report;

  function fail(name: string, detail: string): LedgerVerifyReport {
    check(name, false, detail);
    report.ok = false;
    return report;
  }
}
