import {
  addRoom, carryAfter, createRoom, engineVersionHash, freezeStarts, lazyWindowRng, linkedInputs, regenerateBatch, runWorldWindow,
  type LinkedInput, type RoomState, type World,
} from "@pikit/engine";
import {
  canonicalHash, catalogOverCapMilli, catalogRewardCapMilli, chainInputLog, EpochInputLog, epochLogEntries, epochOf, epochWindows, hexToBytes, INPUT_LOG_GENESIS_HEAD, MAX_INPUTS_PER_ROOM_WINDOW,
  onchainRulesHash, parseCatalog, seedChainLinks, seedParent, T_FREEZE, WorldManifest,
  type AnchorRecord, type Catalog, type EngineInput, type Hex32, type SettlementRecord,
} from "@pikit/protocol";
import { ChainDisagreement, lastAnchorWhere, type AnchorStub, type ChainCatalog, type ChainFacts, type ChainSource, type VoidOverPaidRecord } from "./chain.js";
import { checkInputLinkage, describeLinkMismatch, type LinkageReport } from "./linkage.js";
import { boardBatchRoot, commitBatch, roomsStateRoot, worldStateHashes, type CommittedBatch, type StateHashes } from "./roots.js";
import { checkSettlements, describeSettlementMismatch, replayPayout, type ReplayPayout, type SettlementReport } from "./settlements.js";

// ──────────────────────────────────────────────────────────────────────────
// 에폭 검증 (verify --epoch N): 공개 기록(세계 목록 + 카탈로그 + 에폭 입력 기록)과 체인 값(앵커, 블록 해시, 구매·취소·무효 구간, 정산)만으로
//   1) 엔진 빌드·카탈로그가 체인 rulesHash와 같은지 (Q5, rulesHashes 필수) — 엔진이 다르면 체인을 읽기 전에 멈춘다.
//      그 규칙의 체인 가격·REWARD 상한·over 상한(catalogOf)이 카탈로그 값과 같은지 (M-2: PRICE_MISMATCH·CAP_MISMATCH, D162)
//   2) 시드 사슬: S_e가 S_0까지 keccak으로 내려가는지 (S_{i−1} = keccak256(S_i))
//   3) 입력 = 체인 사건 (H-1, D111, linkage.ts): 체인의 Purchased·CancelRequested·PurchasesVoided·동결 시작마다 정확히 하나의 입력이
//      정해진 윈도(블록 b → b + 1, 방-윈도 상한이면 순서대로 다음 윈도)에 같은 값으로 있고, 체인에 없는 입력은 없는지 — 어긋나면 실패
//   4) 입력 기록 해시 사슬이 끊기지 않고 파일 머리·앵커 inputLogRoot와 같은지 (Q4)
//   5) 세계를 윈도마다 다시 돌려(방 roomId 순) 앵커의 roomsStateRoot·boardBatchRoot와 같은지.
//      앵커 P(processedThrough)는 "이벤트가 모두 들어간 마지막 블록"이라 윈도 P + 1 뒤의 세계와 비교한다(D57)
//   6) 끝난 2,000블록 묶음마다 구성·순서가 시드 + 블록 해시로 다시 만들어지는지 (묶음 생성 검사)
//   7) 체인 정산(Settled = settleEnd)·VoidOverPaid마다 재생한 엔진 정산과 kind·payout·over가 정확히 같은지, 시한 지난 미지급·무효로 사라진
//      over가 없는지 (checkSettlements — 체인은 상한만 강제한다, settlements.ts)
//   8) 참조한 에폭 파일(과 스냅숏)이 모두 공개돼 있는지 — 하나라도 없으면 실패 (명세 17 P0-16 a)
// 를 확인한다.
//
// 스냅숏 시작 (firstEpoch > 1, 명세 17 P0-16 c): 에폭 E = firstEpoch − 1 끝의 공개 스냅숏(game-server `snapshots/<E>.json`)에서 재생을 시작한다.
//   믿는 뿌리 = 체인 앵커 k (processedThrough + 1 = 스냅숏 processedWindow). 스냅숏 세계의 roomsStateRoot = 앵커 k의 roomsStateRoot,
//   스냅숏 inputLogHead = 앵커 k의 inputLogRoot여야 하고, 시드 S_{E+1}은 S_0(체인 seedRoot)까지 keccak으로 이어져야 한다.
//   그 뒤 에폭 E+1…N은 처음부터 검증할 때와 같다(앵커 k+1…의 세 루트, 입력 = 체인 사건, 정산).
//   증명하는 것과 못 하는 것은 docs/VERIFY.md §3. 체인 값은 블록 [P_k + 1 − T_FREEZE, …]만 읽는다(처음부터 읽지 않는다).
// 체인 값은 ChainSource로 받는다: RpcChainSource(rpc-source.ts, 운영자를 믿지 않음, RPC 2곳 교차 확인) 또는 StaticChainSource(파일 = 운영자가 준 값).
// ──────────────────────────────────────────────────────────────────────────

/** game-server가 공개하는 에폭 끝 세계 스냅숏 (`<INPUT_LOG_DIR>/snapshots/<epoch>.json`). world = 엔진 객체 JSON 그대로. */
export interface WorldSnapshotFile {
  epoch: number;
  processedWindow: number;
  inputLogHead: string;
  world: { rooms: { roomId: number; state: unknown }[] };
}

export interface EpochBundle {
  world: unknown;                                   // WorldManifest JSON
  catalogs: ReadonlyMap<string, unknown>;           // catalogHash → 카탈로그 JSON
  /** EpochInputLog JSON, 에폭 firstEpoch… 순서. null = 그 파일이 공개돼 있지 않음 (실패). */
  epochs: readonly (unknown | null)[];
  chain: ChainSource;
  /** epochs[0]의 에폭 (기본 1). 1보다 크면 snapshot = 에폭 firstEpoch − 1 끝의 공개 스냅숏 (null = 없음, 실패). */
  firstEpoch?: number;
  snapshot?: unknown | null;
  /** verify --purchase: 이 구매의 곡괭이들을 보고서에 따로 적는다. */
  purchase?: string;
  /**
   * 검증하는 사람이 운영자 파일 밖에서 얻은 값 (M-4, D162 — CLI --shop / --trust). shop은 world.json과 같아야 하고(아니면 실패),
   * 준 칸은 체인·이 빌드와 같아야 한다. 없으면 world.json의 shop을 그대로 쓴다(라이브러리 시험용 — CLI는 늘 준다).
   */
  trust?: TrustPins;
  /** --since-state: 앞 실행이 검증하고 넘긴 시작 앵커 — 스냅숏 시작 앵커가 정확히 이것이어야 한다 (H-1, D163). */
  resume?: { anchorIndex: number; roomsStateRoot: string };
}

/** 운영자 파일 밖에서 고정한 신뢰 뿌리. shop 필수, 나머지는 주면 대조한다. */
export interface TrustPins {
  shop: string;
  chainId?: number;
  fairness?: string;
  seedRoot?: string;
  engineVersionHash?: string;
}

/** 이 실행이 믿은 뿌리 — 보고서 맨 위에 찍는다 (M-4). null = 이 실행이 그 값을 읽기 전에 멈췄다(또는 체인 파일에 없음). */
export interface TrustRoots {
  chainId: number | null;
  shop: string;
  shopPinned: boolean;                // --shop/--trust로 고정했는가 (false = world.json의 값)
  fairness: string | null;
  seedRoot: string | null;
  genesisBlock: number | null;
  engineVersionHash: string;
  rooms: { roomId: number; catalogHash: string; rulesHash: string }[];
}

export interface Check {
  name: string;
  ok: boolean;
  detail?: string;
}

export interface AnchorCheck {
  anchorIndex: number;
  processedThrough: number;
  inputLogRoot: { expected: string; actual: string };
  roomsStateRoot: { expected: string; actual: string };
  boardBatchRoot: { expected: string; actual: string; batches: number };
}

/** verify --purchase: 그 구매의 곡괭이마다 재생 정산과 체인 기록. */
export interface PurchaseItemReport {
  key: string;
  replayed: { kind: string; payoutMilli: number; overMilli: number; window: number } | null;   // null = 재생 범위 안에서 아직 안 끝남(또는 무효)
  settled: SettlementRecord | null;
  voidOverPaid: VoidOverPaidRecord | null;
  status: "MATCH" | "FAIL" | "UNSETTLED" | "NOT_ENDED" | "VOIDED";   // VOIDED = 무효 구매, over 0 (체인 refundUnprocessed 100%만)
  detail?: string;
}

export interface EpochVerifyReport {
  ok: boolean;
  firstEpoch: number;
  epochs: number;                 // 마지막 에폭 N
  windows: { first: number; last: number };
  start: { epoch: number; processedWindow: number; anchorIndex: number; roomsStateRoot: string } | null;   // 스냅숏 시작이면 그 스냅숏과 믿은 앵커
  engineVersionHash: string;
  trust: TrustRoots;
  checks: Check[];
  anchors: AnchorCheck[];
  batches: { roomId: number; batchIndex: number; window: number; hash: string }[];
  stateHashes: StateHashes;
  head: string;
  replayedThrough: number;        // 실제로 재생한 마지막 윈도 (실패로 멈추면 그 앞)
  payouts: number;                // 재생한 엔진 정산 수
  settlements: SettlementReport;  // 체인 정산 대조 (mismatches = 실패 E12, unsettled = 경고)
  linkage: LinkageReport;         // 입력 = 체인 사건 대조 (mismatches·problems = 실패, H-1)
  chainThroughBlock: number;      // 체인 값이 빠짐없이 담은 마지막 블록 (체인을 읽지 못했으면 −1)
  purchase?: { purchaseId: string; items: PurchaseItemReport[] };
}

/** 이 검증기의 엔진 빌드 해시 (세계 목록의 engineVersionHash와 같아야 재생할 수 있다). */
export function localEngineVersionHash(): string {
  return engineVersionHash();
}

class Fail extends Error {}

/** 체인 읽기 오류(RPC 장애·잘못된 체인 파일)는 검사 실패가 아니라 그대로 던진다 — 오류 글에 RPC URL이 있을 수 있어 보고서에 넣지 않는다. */
class ChainReadError extends Error {
  constructor(readonly original: unknown) { super("chain read failed"); }
}
async function chainRead<T>(p: Promise<T>): Promise<T> {
  try {
    return await p;
  } catch (e) {
    if (e instanceof ChainDisagreement) throw e;
    throw new ChainReadError(e);
  }
}

const NO_LINKAGE: LinkageReport = { checked: 0, matched: 0, pending: 0, mismatches: [], problems: [], carryOut: [] };
const NO_SETTLEMENTS: SettlementReport = { checked: 0, matched: 0, mismatches: [], unsettled: [], skipped: 0 };

/** 입력 = 체인 사건 검사의 이름 (CLI·시험이 찾는다). */
export const LINKAGE_CHECK =
  `inputs = chain events (block b → window b + 1 in (block, log index) order, ≤ ${MAX_INPUTS_PER_ROOM_WINDOW} per room-window carried over, same fields)`;

/** 정산 대조 검사의 이름 (CLI·시험이 찾는다). */
export const SETTLE_CHECK =
  "settlements: every replayed end has exactly one on-chain settleEnd (or VoidOverPaid) with the same kind, payout and over, in time (E12)";

/** RPC 두 곳 교차 확인 검사의 이름 (다르면 그 자리에서 멈추고 첫 차이를 detail에). */
export const AGREE_CHECK = "the RPC endpoints agree on every chain fact read";

/** 고정한 상점 주소 검사의 이름 (M-4). */
export const PINNED_SHOP_CHECK = "world.shop = the shop you pinned (--shop / --trust)";

/** 에폭 파일이 모두 공개돼 있는지 검사의 이름. */
export const FILES_CHECK = "every referenced epoch file (and the start snapshot) is published";

/**
 * 체인 catalogOf(rulesHash) ↔ 재생 카탈로그 (M-2). 등급마다 가격(크레딧) = priceCredits, REWARD 상한 = catalogRewardCapMilli(가격 × rewardCapBps),
 * over 상한 = catalogOverCapMilli. 체인에 그 규칙이 없으면(배열이 비면) 모든 등급이 다르다.
 */
export function catalogDiff(catalog: Catalog, chain: ChainCatalog | undefined): { prices: string[]; caps: string[] } {
  const prices: string[] = [];
  const caps: string[] = [];
  const n = catalog.pickaxes.length;
  if (!chain) return { prices: ["catalogOf(rulesHash) not read"], caps: ["catalogOf(rulesHash) not read"] };
  for (const [what, arr, out] of [["prices", chain.tierPrices, prices], ["caps", chain.tierCapsMilli, caps], ["over caps", chain.tierOverCapsMilli, caps]] as const) {
    if (arr.length !== n) out.push(`chain has ${arr.length} tier ${what}, catalog ${n} tiers`);
  }
  catalog.pickaxes.forEach((p, t) => {
    const price = chain.tierPrices[t];
    if (price !== undefined && price !== String(p.priceCredits)) prices.push(`${p.code}: chain ${price} vs catalog ${p.priceCredits} credits`);
    const cap = chain.tierCapsMilli[t];
    if (cap !== undefined && cap !== String(catalogRewardCapMilli(catalog, t))) caps.push(`${p.code} REWARD cap: chain ${cap} vs catalog ${catalogRewardCapMilli(catalog, t)} milli`);
    const over = chain.tierOverCapsMilli[t];
    if (over !== undefined && over !== String(catalogOverCapMilli(catalog, t))) caps.push(`${p.code} over cap: chain ${over} vs catalog ${catalogOverCapMilli(catalog, t)} milli`);
  });
  return { prices, caps };
}

/** 스냅숏 JSON을 모양만 확인해 읽는다 (상태 내용은 앵커 루트와 대조해 확인한다). */
function parseSnapshot(x: unknown): WorldSnapshotFile {
  const s = x as WorldSnapshotFile;
  const ok = s && typeof s === "object" && Number.isSafeInteger(s.epoch) && Number.isSafeInteger(s.processedWindow) && typeof s.inputLogHead === "string"
    && /^0x[0-9a-f]{64}$/.test(s.inputLogHead) && s.world && Array.isArray(s.world.rooms)
    && s.world.rooms.every((r) => r && Number.isSafeInteger(r.roomId) && r.state && typeof r.state === "object");
  if (!ok) throw new Fail("snapshot file has the shape { epoch, processedWindow, inputLogHead, world: { rooms: [{ roomId, state }] } }");
  return s;
}

/** 스냅숏 세계에서 살아 있거나 대기열에 있는 플레이어 곡괭이 키 (그 정산은 재생 범위 안에서 나와야 한다). */
function aliveKeys(rooms: readonly { state: RoomState }[]): Set<string> {
  const out = new Set<string>();
  for (const { state } of rooms) {
    for (const p of state.pickaxes) if (p.owner !== null) out.add(p.key);
    for (const o of state.owners) for (const q of o.queue) out.add(q.key);
  }
  return out;
}

/** verify --epoch N (또는 스냅숏 시작 firstEpoch…N). 첫 실패에서 멈추지 않고 가능한 검사를 모두 모아 돌려준다(재생이 불가능한 실패는 거기서 멈춤). */
export async function verifyEpochs(bundle: EpochBundle): Promise<EpochVerifyReport> {
  const checks: Check[] = [];
  const check = (name: string, ok: boolean, detail?: string) => { checks.push(detail === undefined ? { name, ok } : { name, ok, detail }); return ok; };
  const must = (name: string, ok: boolean, detail?: string) => { if (!check(name, ok, detail)) throw new Fail(name); };

  const world = WorldManifest.parse(bundle.world);
  const firstEpoch = bundle.firstEpoch ?? 1;
  if (!Number.isSafeInteger(firstEpoch) || firstEpoch < 1) throw new Error(`verifyEpochs: firstEpoch must be ≥ 1 (got ${firstEpoch})`);
  const n = bundle.epochs.length;
  const lastEpoch = firstEpoch + n - 1;
  const range = n > 0 ? { first: epochWindows(firstEpoch, world.genesisBlock).first, last: epochWindows(lastEpoch, world.genesisBlock).last } : { first: 0, last: -1 };
  const engineHash = engineVersionHash();
  const anchorsOut: AnchorCheck[] = [];
  const batchesOut: CommittedBatch[] = [];
  const payouts: ReplayPayout[] = [];
  const voidedPurchases = new Set<string>();
  let replayedThrough = -1;
  let head: Hex32 = INPUT_LOG_GENESIS_HEAD;
  let linkage = NO_LINKAGE;
  let settlements = NO_SETTLEMENTS;
  let chain: ChainFacts | null = null;
  let start: EpochVerifyReport["start"] = null;
  let trusted: AnchorRecord | null = null;
  let alive = new Set<string>();
  const sim: World = { rooms: [] };

  const pins = bundle.trust;
  const trust: TrustRoots = {
    chainId: null, shop: pins ? pins.shop.toLowerCase() : world.shop, shopPinned: pins !== undefined, fairness: null, seedRoot: null, genesisBlock: null,
    engineVersionHash: engineHash,
    rooms: world.rooms.map((r) => ({ roomId: r.roomId, catalogHash: r.catalogHash, rulesHash: onchainRulesHash(r.catalogHash as Hex32, engineHash as Hex32) })),
  };

  try {
    // ── 0) 신뢰 뿌리: 상점 주소는 운영자 파일(world.json)이 아니라 검증하는 사람이 고른 값 (M-4) — 체인을 읽기 전에
    if (pins) {
      must(PINNED_SHOP_CHECK, world.shop === trust.shop, `world.json ${world.shop} vs pinned ${trust.shop}`);
      if (pins.engineVersionHash !== undefined) must("pinned engineVersionHash = this build", pins.engineVersionHash.toLowerCase() === engineHash, `pinned ${pins.engineVersionHash} vs build ${engineHash}`);
    }
    // ── 1) 엔진 (체인을 읽기 전에: 규칙 버전이 다른 세계에 RPC를 쓰지 않는다)
    must("engine build = world.engineVersionHash", world.engineVersionHash === engineHash, `world ${world.engineVersionHash} vs local ${engineHash}`);

    // ── 8) 파일이 모두 있는가 (없는 파일이 하나라도 있으면 그 범위는 아무도 검증할 수 없다 — 실패)
    const missing = bundle.epochs.flatMap((e, i) => (e === null || e === undefined ? [`${firstEpoch + i}.json`] : []));
    if (firstEpoch > 1 && (bundle.snapshot === null || bundle.snapshot === undefined)) missing.unshift(`snapshots/${firstEpoch - 1}.json`);
    must(FILES_CHECK, missing.length === 0, `missing: ${missing.slice(0, 10).join(", ")}${missing.length > 10 ? ` … (${missing.length})` : ""}`);
    const logs = bundle.epochs.map((e) => EpochInputLog.parse(e));
    const snap = firstEpoch > 1 ? parseSnapshot(bundle.snapshot) : null;

    // ── 스냅숏 시작: 믿는 앵커 k를 체인에서 찾는다 (anchorAt 이진 탐색) + 동결 판정에 필요한 그 앞 앵커들
    let stubs: AnchorStub[] = [];
    let trustedStub: AnchorStub | null = null;
    if (snap) {
      const E = firstEpoch - 1;
      must(`start snapshot is epoch ${E} ending at window ${epochWindows(E, world.genesisBlock).last}`,
        snap.epoch === E && snap.processedWindow === epochWindows(E, world.genesisBlock).last, `file says epoch ${snap.epoch}, window ${snap.processedWindow}`);
      const h = await chainRead(bundle.chain.head());
      trustedStub = await chainRead(lastAnchorWhere(bundle.chain, h.anchorCount, (a) => a.processedThrough + 1 <= snap.processedWindow));
      must(`start snapshot ${E} is anchored on chain (an anchor with processedThrough = ${snap.processedWindow - 1})`,
        trustedStub !== null && trustedStub.processedThrough + 1 === snap.processedWindow,
        trustedStub ? `nearest anchor ${trustedStub.anchorIndex} has processedThrough ${trustedStub.processedThrough}` : "no anchor at or before it");
      // P(x) for x ≥ P_k: 앵커 k 앞에서 postedBlock ≤ P_k인 마지막 앵커까지 (그보다 앞 앵커는 P가 더 작아 최댓값을 바꾸지 않는다)
      for (let i = trustedStub!.anchorIndex - 1; i >= 0; i--) {
        const a = await chainRead(bundle.chain.anchorAt(i));
        stubs.push(a);
        if (a.postedBlock <= trustedStub!.processedThrough) break;
      }
      stubs = stubs.reverse();
    }

    chain = await chainRead(bundle.chain.snapshot({
      throughWindow: range.last, rooms: world.rooms.map((r) => r.roomId), fromWindow: range.first,
      ...(trustedStub ? { eventsFrom: Math.max(world.genesisBlock, trustedStub.processedThrough + 1 - T_FREEZE) } : {}),
    }));
    const facts = chain;
    Object.assign(trust, { chainId: facts.chainId, fairness: facts.fairness ?? null, seedRoot: facts.seedRoot, genesisBlock: facts.genesisBlock });
    if (pins?.chainId !== undefined) must("pinned chainId = chain", pins.chainId === facts.chainId, `pinned ${pins.chainId} vs chain ${facts.chainId}`);
    if (pins?.seedRoot !== undefined) must("pinned seedRoot = chain seedRoot", pins.seedRoot.toLowerCase() === facts.seedRoot, `pinned ${pins.seedRoot} vs chain ${facts.seedRoot}`);
    if (pins?.fairness !== undefined) {
      must("pinned fairness = chain PikitShop.fairness()", pins.fairness.toLowerCase() === facts.fairness, `pinned ${pins.fairness} vs chain ${facts.fairness ?? "not read (chain file)"}`);
    }

    // ── 1) 카탈로그·체인 약속
    must("world.seedRoot = chain seedRoot (S_0)", world.seedRoot === facts.seedRoot);
    must("world.genesisBlock = chain genesisBlock (W0)", world.genesisBlock === facts.genesisBlock);
    must("chainId matches", world.chainId === facts.chainId);
    must("world.shop = chain shop", world.shop === facts.shop, `world ${world.shop} vs chain ${facts.shop}`);
    const catalogs = new Map<number, Catalog>();
    const rulesOf = new Map<number, Hex32>();
    for (const r of world.rooms) {
      const raw = bundle.catalogs.get(r.catalogHash);
      must(`room ${r.roomId}: catalog ${r.catalogHash.slice(0, 10)}… present`, raw !== undefined);
      const c = parseCatalog(raw);
      must(`room ${r.roomId}: canonicalHash(catalog) = catalogHash`, canonicalHash(c) === r.catalogHash);
      const onchain = onchainRulesHash(r.catalogHash as Hex32, engineHash as Hex32);
      // 방마다 그 방의 체인 규칙(roomOf: 지금 규칙 또는 예약된 규칙)과 대조한다 — 모든 방 규칙의 합집합이 아니다 (I-5, D162)
      const rr = facts.roomRules.find((x) => x.roomId === r.roomId);
      must(`room ${r.roomId}: keccak256(catalogHash ‖ engineVersionHash) = this room's on-chain rulesHash (roomOf)`,
        rr !== undefined && (rr.rulesHash === onchain || rr.nextRulesHash === onchain),
        rr ? `replay ${onchain} vs chain room ${r.roomId} ${rr.rulesHash}${rr.nextRulesHash ? ` (next ${rr.nextRulesHash})` : ""}` : `room ${r.roomId} does not exist on chain`);
      // L-3 (개정 6-b, D162): 방의 첫 윈도는 운영자가 고르지 않는다 — 체인이 정한 max(W0, roomOf.createdBlock)
      const chainCreated = Math.max(facts.genesisBlock, rr!.createdBlock);
      must(`room ${r.roomId}: world createdWindow = max(W0, roomOf.createdBlock)`, r.createdWindow === chainCreated,
        `world.json ${r.createdWindow} vs chain ${chainCreated} (createdBlock ${rr!.createdBlock})`);
      catalogs.set(r.roomId, c);
      rulesOf.set(r.roomId, onchain);
      // 체인이 실제로 받는 가격·지급 상한 = 재생하는 카탈로그 (M-2, D162). rulesHash는 카탈로그(가격 포함)를 묶지만 announceCatalog의
      // tierPrices·상한 배열은 따로 받는다 — 같은 rulesHash로 두 배 가격인 상점이 배포될 수 있다(리뷰 PoC R6-06).
      const cc = facts.catalogs.find((x) => x.rulesHash === onchain);
      const diff = catalogDiff(c, cc);
      check(`room ${r.roomId}: chain tier prices (catalogOf) = catalog prices`, diff.prices.length === 0, `PRICE_MISMATCH ${diff.prices.join("; ")}`);
      check(`room ${r.roomId}: chain tier caps (catalogOf) = catalog REWARD and over caps`, diff.caps.length === 0, `CAP_MISMATCH ${diff.caps.join("; ")}`);
    }

    // ── 스냅숏 세계 = 믿는 앵커의 루트
    if (snap && trustedStub) {
      trusted = facts.anchors.find((a) => a.anchorIndex === trustedStub.anchorIndex) ?? null;
      must(`anchor ${trustedStub.anchorIndex}: Anchored event read from the chain`, trusted !== null);
      const expectRooms = world.rooms.filter((r) => r.createdWindow <= snap.processedWindow).map((r) => r.roomId);
      must(`start snapshot has exactly the rooms of the world at window ${snap.processedWindow}`,
        snap.world.rooms.map((r) => r.roomId).join(",") === expectRooms.join(","), `snapshot ${snap.world.rooms.map((r) => r.roomId).join(",")} vs world ${expectRooms.join(",")}`);
      for (const r of snap.world.rooms) addRoom(sim, { roomId: r.roomId, catalog: catalogs.get(r.roomId)!, state: r.state as RoomState });
      must(`start snapshot ${snap.epoch}: roomsStateRoot = anchor ${trusted!.anchorIndex} roomsStateRoot`, roomsStateRoot(worldStateHashes(sim)) === trusted!.roomsStateRoot);
      must(`start snapshot ${snap.epoch}: inputLogHead = anchor ${trusted!.anchorIndex} inputLogRoot`, snap.inputLogHead === trusted!.inputLogRoot);
      head = snap.inputLogHead as Hex32;
      alive = aliveKeys(sim.rooms);
      for (const { state } of sim.rooms) for (const ref of state.voidedRefs) voidedPurchases.add(ref);
      start = { epoch: snap.epoch, processedWindow: snap.processedWindow, anchorIndex: trusted!.anchorIndex, roomsStateRoot: trusted!.roomsStateRoot };
      if (bundle.resume) {
        must(`start anchor ${trusted!.anchorIndex} = the anchor the previous run resumed from (verify-state)`,
          trusted!.anchorIndex === bundle.resume.anchorIndex && trusted!.roomsStateRoot === bundle.resume.roomsStateRoot,
          `state: anchor ${bundle.resume.anchorIndex} root ${bundle.resume.roomsStateRoot}; chain: anchor ${trusted!.anchorIndex} root ${trusted!.roomsStateRoot}`);
      }
    }

    // ── 3) 입력 = 체인 사건 (H-1). 체인 값이 블록 range.last − 1까지 빠짐없어야 "빠진 입력"을 잡는다
    if (n > 0) {
      must(
        `chain data covers the replayed windows (events through block ${range.last - 1})`, facts.throughBlock >= range.last - 1,
        `chain data ends at block ${facts.throughBlock}`,
      );
      const rooms = world.rooms.map((r) => ({ roomId: r.roomId, createdWindow: r.createdWindow, rulesHash: rulesOf.get(r.roomId)! }));
      const purchaseById = new Map(facts.purchases.map((p) => [p.purchaseId, p]));
      const purchaseOf = (id: string) => purchaseById.get(id);
      // 스냅숏 시작: 블록 ≤ P_k의 사건은 스냅숏 앞에서 들어갔다 — 방-윈도 상한 때문에 아직 못 들어간 것(carry)만 넘어온다
      const P = trusted ? trusted.processedThrough : world.genesisBlock - 1;
      const pre = <T extends { blockNumber: number }>(xs: readonly T[]) => xs.filter((x) => x.blockNumber <= P);
      const post = <T extends { blockNumber: number }>(xs: readonly T[]) => xs.filter((x) => x.blockNumber > P);
      let carry: LinkedInput[] = [];
      if (trusted) {
        const { items } = linkedInputs({ purchases: pre(facts.purchases), cancels: pre(facts.cancels), voids: pre(facts.voids), freezeBlocks: [] }, rooms, purchaseOf);
        carry = carryAfter(items, rooms, P + 1);
      }
      linkage = checkInputLinkage({
        rooms,
        events: {
          purchases: post(facts.purchases), cancels: post(facts.cancels), voids: post(facts.voids),
          freezeBlocks: freezeStarts([...stubs, ...facts.anchors], facts.genesisBlock, P + 1, facts.throughBlock),
        },
        purchaseOf, carry, windows: logs.flatMap((l) => l.windows), first: range.first, last: range.last,
      });
      check(
        LINKAGE_CHECK, linkage.mismatches.length === 0 && linkage.problems.length === 0,
        [...linkage.problems.map((p) => `${p.code} ${p.detail}`), ...linkage.mismatches.map(describeLinkMismatch)].slice(0, 5).join("; "),
      );
    }

    // ── 2) 에폭 파일 순서와 시드 사슬 (스냅숏 시작이면 S_{E+1}이 S_0까지 keccak E+1번으로 이어진다)
    const seeds = new Map<number, Hex32>();
    let known: { seed: Hex32; epoch: number } = { seed: world.seedRoot as Hex32, epoch: 0 };
    logs.forEach((log, i) => {
      const e = firstEpoch + i;
      const win = epochWindows(e, world.genesisBlock);
      must(`epoch ${e}: file is epoch ${e} with windows [${win.first}, ${win.last}]`, log.epoch === e && log.firstWindow === win.first && log.lastWindow === win.last);
      must(`epoch ${e}: chainId/shop match the world`, log.chainId === world.chainId && log.shop === world.shop);
      const fromChain = facts.anchors.find((a) => a.epoch === e && !isZero(a.seed))?.seed;
      const seed = (fromChain ?? log.seed) as Hex32 | undefined;
      must(`epoch ${e}: seed S_${e} revealed`, seed !== undefined);
      must(`epoch ${e}: keccak^(${e - known.epoch})(S_${e}) = S_${known.epoch}`, seedChainLinks(seed!, e, known.seed, known.epoch));
      if (fromChain && log.seed) must(`epoch ${e}: file seed = anchored seed`, fromChain === log.seed);
      seeds.set(e, seed!);
      known = { seed: seed!, epoch: e };
    });

    // ── 3·4·5) 해시 사슬 + 세계 재생 + 앵커 루트 + 묶음
    const shop = hexToBytes(world.shop);
    const seedBytes = new Map<number, Uint8Array>();
    /** S_e. 범위 앞 에폭(스냅숏 앞에서 시작한 묶음 줄)은 범위 첫 시드에서 keccak으로 내려가 얻는다. */
    const seedHex = (e: number): Hex32 => {
      let s = seeds.get(e);
      if (s) return s;
      let at = firstEpoch;
      s = seeds.get(at)!;
      while (at > e) { at -= 1; s = seeds.get(at) ?? seedParent(s); seeds.set(at, s); }
      return s;
    };
    const seedOf = (w: number) => () => {
      const e = epochOf(w, world.genesisBlock);
      let b = seedBytes.get(e);
      if (!b) { b = hexToBytes(seedHex(e)); seedBytes.set(e, b); }
      return b;
    };
    const hashes: Record<string, string> = { ...facts.blockHashes };
    const blockHashOf = (w: number) => () => {
      const h = hashes[String(w)];
      if (!h) throw new Fail(`block hash of window ${w} missing from chain data`);
      return hexToBytes(h);
    };
    const rngFor = (w: number) => (roomId: number) => lazyWindowRng(seedOf(w), world.chainId, shop, roomId, w, blockHashOf(w));
    const regenCheck = (roomId: number, b: CommittedBatch) => {
      const regen = regenerateBatch(catalogs.get(roomId)!, b.batchIndex, b.rowWindows, (rw) => rngFor(rw)(roomId));
      check(`room ${roomId} batch ${b.batchIndex}: regenerated from seeds + block hashes`, regen.every((k, i) => k === b.kinds[i]));
    };
    const deferred: CommittedBatch[] = [];   // 줄 윈도가 범위 앞인 묶음 (그 블록 해시를 나중에 한꺼번에 읽는다)
    // 앵커 루트는 윈도 P + 1(= 이벤트가 모두 들어간 마지막 블록 P 다음 윈도) 뒤의 세계와 비교한다
    const anchorsAt = new Map<number, AnchorRecord[]>();
    for (const a of facts.anchors) {
      const w = a.processedThrough + 1;
      if (w >= range.first && w <= range.last) anchorsAt.set(w, [...(anchorsAt.get(w) ?? []), a]);
    }
    const sortedAnchors = [...facts.anchors].sort((a, b) => a.anchorIndex - b.anchorIndex);
    let pendingBatches: CommittedBatch[] = [];

    for (const log of logs) {
      must(`epoch ${log.epoch}: prevHead continues the chain`, log.prevHead === head, `${log.prevHead} vs ${head}`);
      const entries = epochLogEntries(log);
      for (const entry of entries) head = chainInputLog(head, entry);
      must(`epoch ${log.epoch}: head = recomputed chain head`, log.head === head, `${log.head} vs ${head}`);
      let replayHead: Hex32 = log.prevHead as Hex32;
      const byWindow = new Map(log.windows.map((w) => [w.window, w]));

      for (let w = log.firstWindow; w <= log.lastWindow; w++) {
        for (const r of world.rooms) {
          if (r.createdWindow === w) addRoom(sim, { roomId: r.roomId, catalog: catalogs.get(r.roomId)!, state: createRoom(catalogs.get(r.roomId)!, rngFor(w)(r.roomId), r.roomId, w) });
        }
        const wi = byWindow.get(w);
        const roomInputs = new Map<number, EngineInput[]>((wi?.rooms ?? []).map((x) => [x.roomId, x.inputs]));
        for (const [roomId] of roomInputs) {
          const room = world.rooms.find((r) => r.roomId === roomId);
          if (room === undefined || room.createdWindow >= w) must(`window ${w}: inputs for room ${roomId} only after its creation`, false);
        }
        if (wi) for (const entry of epochLogEntries({ windows: [wi] })) replayHead = chainInputLog(replayHead, entry);

        const res = runWorldWindow(sim, w, roomInputs, rngFor(w));
        for (const { roomId, result } of res.rooms) {
          for (const b of result.batches) {
            const committed = commitBatch(roomId, w, b);
            batchesOut.push(committed);
            pendingBatches.push(committed);
            if (b.rowWindows.every((rw) => hashes[String(rw)] !== undefined)) regenCheck(roomId, committed);
            else deferred.push(committed);
          }
          for (const p of result.payouts) payouts.push(replayPayout(roomId, p));
          for (const v of result.voided) voidedPurchases.add(v.ref);
        }
        replayedThrough = w;

        for (const a of anchorsAt.get(w) ?? []) {
          const hs = worldStateHashes(sim);
          const prev = sortedAnchors.filter((x) => x.anchorIndex < a.anchorIndex).pop();
          const since = pendingBatches.filter((b) => b.window > (prev ? prev.processedThrough + 1 : -1) && b.window <= w);
          const ac: AnchorCheck = {
            anchorIndex: a.anchorIndex, processedThrough: a.processedThrough,
            inputLogRoot: { expected: a.inputLogRoot, actual: replayHead },
            roomsStateRoot: { expected: a.roomsStateRoot, actual: roomsStateRoot(hs) },
            boardBatchRoot: { expected: a.boardBatchRoot, actual: boardBatchRoot(since), batches: since.length },
          };
          check(`anchor ${a.anchorIndex}: inputLogRoot`, ac.inputLogRoot.expected === ac.inputLogRoot.actual);
          check(`anchor ${a.anchorIndex}: roomsStateRoot`, ac.roomsStateRoot.expected === ac.roomsStateRoot.actual);
          check(`anchor ${a.anchorIndex}: boardBatchRoot (${since.length} batches)`, ac.boardBatchRoot.expected === ac.boardBatchRoot.actual);
          anchorsOut.push(ac);
          pendingBatches = pendingBatches.filter((b) => b.window > w);
        }
      }
    }

    // ── 6') 스냅숏 앞에서 시작한 묶음: 그 줄 윈도의 블록 해시를 체인에서 더 읽어 다시 뽑는다
    if (deferred.length > 0) {
      const want = [...new Set(deferred.flatMap((b) => b.rowWindows).filter((rw) => hashes[String(rw)] === undefined))];
      Object.assign(hashes, await chainRead(bundle.chain.blockHashes(want)));
      for (const b of deferred) {
        try {
          regenCheck(b.roomId, b);
        } catch (e) {
          if (!(e instanceof Fail)) throw e;
          check(`room ${b.roomId} batch ${b.batchIndex}: regenerated from seeds + block hashes`, false, e.message);
        }
      }
    }
  } catch (e) {
    if (e instanceof ChainReadError) throw e.original;
    if (e instanceof ChainDisagreement) check(AGREE_CHECK, false, e.message);
    else if (!(e instanceof Fail)) check("replay", false, (e as Error).message);
  }

  // ── 7) 체인 정산 ↔ 재생 정산 (재생한 범위 안). 처리된 구매 경계 = 재생 범위 안 가장 최근 앵커의 processedPurchases
  if (chain) {
    const facts = chain;
    const covering = facts.anchors.filter((a) => a.processedThrough + 1 <= replayedThrough).sort((a, b) => a.anchorIndex - b.anchorIndex).pop();
    // I-1 (D162): 체인 무효 구간은 재생 범위 뒤 블록에 실렸어도(장애 뒤 첫 늦은 앵커의 PurchasesVoided는 윈도 A + 1에 들어가 범위 끝
    // P_A + 1 뒤다) 체인에서는 이미 무효다 — 그 구매는 settleEnd가 막히고 over는 VoidOverPaid로 간다. 재생한 정산의 구매가 체인 무효 구간
    // (블록 ≤ 체인 값 머리)에 있으면 무효 구매로 대조한다(정직한 VoidOverPaid가 VOID_OVER_EXTRA, 정상 종료가 OVERDUE로 틀리게 실패하지 않게).
    const voidOf = (id: string) => facts.voids.find((r) => r.blockNumber <= facts.throughBlock && BigInt(r.fromId) <= BigInt(id) && BigInt(id) < BigInt(r.toId));
    for (const p of payouts) if (!voidedPurchases.has(p.purchaseId) && voidOf(p.purchaseId)) voidedPurchases.add(p.purchaseId);
    const voidBlocks = new Map<string, number>();
    for (const id of voidedPurchases) {
      const v = voidOf(id);
      if (v) voidBlocks.set(id, v.blockNumber);
    }
    settlements = checkSettlements(payouts, facts.settlements, {
      throughBlock: replayedThrough,
      chainThroughBlock: facts.throughBlock,
      voidedPurchases, voidBlocks, voidOverPaid: facts.voidOverPaid,
      ...(covering ? { processedPurchases: covering.processedPurchases } : {}),
      ...(trusted ? { before: { processedPurchases: trusted.processedPurchases, alive } } : {}),
    });
    check(SETTLE_CHECK, settlements.mismatches.length === 0, settlements.mismatches.slice(0, 5).map(describeSettlementMismatch).join("; "));
  }

  const report: EpochVerifyReport = {
    ok: checks.every((c) => c.ok),
    firstEpoch,
    epochs: lastEpoch,
    windows: range,
    start,
    engineVersionHash: engineHash,
    trust,
    checks,
    anchors: anchorsOut,
    batches: batchesOut.map((b) => ({ roomId: b.roomId, batchIndex: b.batchIndex, window: b.window, hash: b.hash })),
    stateHashes: worldStateHashes(sim),
    head,
    replayedThrough,
    payouts: payouts.length,
    settlements,
    linkage,
    chainThroughBlock: chain?.throughBlock ?? -1,
  };
  if (bundle.purchase !== undefined) report.purchase = purchaseReport(bundle.purchase, chain, payouts, settlements, voidedPurchases.has(bundle.purchase));
  return report;
}

/** verify --purchase: 그 구매의 곡괭이마다 재생 정산 ↔ 체인 기록. */
function purchaseReport(
  purchaseId: string, chain: ChainFacts | null, payouts: readonly ReplayPayout[], s: SettlementReport, voided: boolean,
): EpochVerifyReport["purchase"] {
  const record = chain?.purchases.find((p) => p.purchaseId === purchaseId);
  const count = record?.tiers.length ?? Math.max(0, ...payouts.filter((p) => p.purchaseId === purchaseId).map((p) => p.itemIndex + 1));
  const items: PurchaseItemReport[] = [];
  for (let i = 0; i < count; i++) {
    const key = `${purchaseId}:${i}`;
    const p = payouts.find((x) => x.key === key);
    const settled = chain?.settlements.find((x) => x.purchaseId === purchaseId && x.itemIndex === i) ?? null;
    const voidOverPaid = chain?.voidOverPaid.find((x) => x.purchaseId === purchaseId && x.itemIndex === i) ?? null;
    const fail = s.mismatches.find((m) => m.key === key);
    const status: PurchaseItemReport["status"] = fail ? "FAIL" : settled || voidOverPaid ? "MATCH" : voided && (!p || p.overMilli === 0) ? "VOIDED" : !p ? "NOT_ENDED" : "UNSETTLED";
    items.push({
      key, settled, voidOverPaid, status,
      replayed: p ? { kind: p.kind, payoutMilli: p.payoutMilli, overMilli: p.overMilli, window: p.window } : null,
      ...(fail ? { detail: describeSettlementMismatch(fail) } : {}),
    });
  }
  return { purchaseId, items };
}

function isZero(h: string): boolean {
  return /^0x0*$/.test(h);
}
