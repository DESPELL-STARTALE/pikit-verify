import {
  createRoom, earnedMilli, engineVersionHash, runWindow, serializeRoom, windowRngFactory,
  type BonusEvent, type EnginePayout, type PickaxeResult, type RoomState,
} from "@pikit/engine";
import { canonicalHash, hexToBytes, InputLog, parseCatalog, sha256Hex, type Catalog, type EngineInput } from "@pikit/protocol";

// ──────────────────────────────────────────────────────────────────────────
// 재생기 v0 — 카탈로그 + 입력 기록(시드 포함)을 공개 엔진으로 다시 돌려 끝 상태 해시와 곡괭이별 정산 값을 낸다.
// 재생 결과의 정산(payouts, 곡괭이마다 1건)은 검증 CLI가 보여 준다. 개정 7(명세 20)에서 지급은 장부 잎(ledgerRoot)이 묶는다 — ledger-verify.ts.
// "누구나 재생할 수 있다"의 최소 구현. 게임 서버·감시 봇·검증 CLI가 같은 함수를 쓴다.
// 윈도 난수(windowRngFactory)는 엔진에 있다(engineVersionHash가 덮는다, D161).
// v0 한계: 시드 사슬(S_{i−1} = keccak256(S_i))과 실제 블록 해시 대신 입력 기록의 시드 하나와 기록된 blockHash(없으면 0)를 쓴다.
// ──────────────────────────────────────────────────────────────────────────

/** 이 검증기의 엔진 빌드 해시 (세계 목록의 engineVersionHash와 같아야 재생할 수 있다). */
export function localEngineVersionHash(): string {
  return engineVersionHash();
}

/** 재생에서 나온 정산 1건 (엔진 EnginePayout + 방 번호 + 키에서 읽은 구매 번호·항목 순번). */
export interface ReplayPayout extends EnginePayout {
  roomId: number;
  purchaseId: string;   // 10진 문자열 (purchaseId)
  itemIndex: number;
}

/** 곡괭이 키 "<purchaseId>:<itemIndex>"를 나눈다. 형식이 틀리면 오류(구매가 아닌 키). */
function parseItemKey(key: string): { purchaseId: string; itemIndex: number } {
  const m = /^(0|[1-9][0-9]*):([0-9])$/.exec(key);
  if (!m) throw new Error(`not a purchase item key: ${key}`);
  return { purchaseId: m[1]!, itemIndex: Number(m[2]) };
}

function replayPayout(roomId: number, p: EnginePayout): ReplayPayout {
  return { ...p, roomId, ...parseItemKey(p.key) };
}

export interface PickaxePayout {
  key: string;
  owner: string;
  tier: string;
  status: "ENDED" | "ACTIVE";
  endReason: PickaxeResult["endReason"] | null;
  endWindow: number | null;   // 끝난 윈도 (진행 중이면 null)
  priceMilli: number;
  baseMilli: number;
  luckyKind: number;          // LUCKY 종류 (판에 놓일 때 뽑음)
  luckyMilli: number;         // LUCKY 몫
  bonusMilli: number;         // POP + BIG POP
  paidMilli: number;          // 끝났으면 정산 payoutMilli(VOID는 0), 진행 중이면 지금까지 번 값(base + lucky + bonus)
  overMilli: number;          // 끝났으면 정산 overMilli(REWARD만, 그 밖 0), 진행 중이면 0
  pop: boolean;
  bigPop: boolean;
  events: BonusEvent[];       // 보너스 사건 (POP·BIG_POP, 상금과 실제 지급)
}

export interface ReplayReport {
  rulesHash: string;
  finalStateHash: string;
  windows: number;            // 처리한 윈도 수
  activeWindows: number;      // 실제로 틱을 돈 윈도 수 (D94부터 멈춤 규칙이 없어 windows와 같다)
  ticks: number;
  pickaxes: PickaxePayout[];
  payouts: ReplayPayout[];    // 엔진 정산 전부 (생긴 순서, 곡괭이마다 1건 {kind, payoutMilli, overMilli, window = 끝 윈도}) 
  rejectedInputs: number;
  sky: ReplaySkyEvent[];      // (D125) 하늘 별 사건 전부 (생긴 순서). 카탈로그에 skyEvent가 없으면 빈 배열
}

/** 하늘 별 사건 하나 (D125) — 누가 별을 잡았는지도 같은 시드·블록 해시로 누구나 다시 얻는다. key·owner = DROP은 겨눈 곡괭이, CAUGHT는 잡은 곡괭이. */
export interface ReplaySkyEvent {
  kind: "DROP" | "CAUGHT" | "EXPIRED";
  id: number;
  window: number;
  tick: number;
  key: string | null;
  owner: string | null;
}

/** 방 상태 해시 = SHA-256(serializeRoom). 앵커 roomsStateRoot의 잎 값이자 v0 재생의 끝 상태 해시. */
export function roomStateHash(state: RoomState): string {
  return sha256Hex(serializeRoom(state));
}

/** 카탈로그 JSON과 입력 기록 JSON(파싱 전 값)으로 재생한다. 형식·rulesHash가 틀리면 오류. */
export function replay(catalogJson: unknown, inputLogJson: unknown): ReplayReport {
  const catalog: Catalog = parseCatalog(catalogJson);
  const log = InputLog.parse(inputLogJson);
  const rulesHash = canonicalHash(catalog);
  if (rulesHash !== log.rulesHash) throw new Error(`rulesHash mismatch: catalog ${rulesHash} ≠ log ${log.rulesHash}`);

  const seed = hexToBytes(log.seed);
  const shop = hexToBytes(log.shop);
  const zeroHash = new Uint8Array(32);
  const byWindow = new Map<number, { inputs: EngineInput[]; blockHash: Uint8Array }>();
  for (const w of log.windows) byWindow.set(w.window, { inputs: w.inputs, blockHash: w.blockHash ? hexToBytes(w.blockHash) : zeroHash });

  const state = createRoom(catalog, windowRngFactory(seed, log.chainId, shop, log.roomId, log.firstWindow, zeroHash), log.roomId, log.firstWindow);
  let windows = 0;
  let activeWindows = 0;
  const ended: PickaxeResult[] = [];   // 윈도 결과에서 모은다 (엔진 상태의 results는 정리 규칙이 앞부분을 지운다)
  const payouts: ReplayPayout[] = [];
  const sky: ReplaySkyEvent[] = [];
  for (let w = log.firstWindow + 1; w <= log.lastWindow; w++) {
    const entry = byWindow.get(w);
    const rng = windowRngFactory(seed, log.chainId, shop, log.roomId, w, entry?.blockHash ?? zeroHash);
    const result = runWindow(state, catalog, w, entry?.inputs ?? [], rng);
    ended.push(...result.ended);
    for (const p of result.payouts) payouts.push(replayPayout(log.roomId, p));
    for (const e of result.sky) sky.push({ kind: e.kind, id: e.id, window: e.window, tick: e.tick, key: e.key, owner: e.owner });
    windows += 1;
    if (result.ticksRun > 0) activeWindows += 1;
  }

  const code = (tier: number) => catalog.pickaxes[tier]?.code ?? String(tier);
  const pickaxes: PickaxePayout[] = [
    ...ended.map((r): PickaxePayout => ({
      key: r.key, owner: r.owner, tier: code(r.tier), status: "ENDED", endReason: r.endReason, endWindow: r.endWindow, priceMilli: r.priceMilli,
      baseMilli: r.baseMilli, luckyKind: r.luckyKind, luckyMilli: r.luckyMilli, bonusMilli: r.bonusMilli, paidMilli: r.paidMilli, overMilli: r.overMilli,
      pop: r.pop, bigPop: r.bigPop, events: r.events,
    })),
    ...state.pickaxes.filter((p) => p.owner !== null).map((p): PickaxePayout => ({
      key: p.key, owner: p.owner!, tier: code(p.tier), status: "ACTIVE", endReason: null, endWindow: null, priceMilli: p.priceMilli,
      baseMilli: p.baseMilli, luckyKind: p.luckyKind, luckyMilli: p.luckyMilli, bonusMilli: p.bonusMilli, paidMilli: earnedMilli(p), overMilli: 0,
      pop: p.popDone, bigPop: p.bigDone, events: p.bonusEvents.map((e) => ({ ...e })),
    })),
  ];

  return {
    rulesHash,
    finalStateHash: roomStateHash(state),
    windows,
    activeWindows,
    ticks: state.tick,
    pickaxes,
    payouts,
    rejectedInputs: state.prunedRejected + state.rejected.length,
    sky,
  };
}
