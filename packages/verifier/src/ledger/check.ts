import type { RoomState } from "@pikit/engine";
import { rootThroughWindow, type LedgerLeavesFile, type LedgerRootFields } from "@pikit/protocol";
import { diffRootFields } from "./rules/root.js";
import type { LedgerState } from "./rules/state.js";

// ──────────────────────────────────────────────────────────────────────────
// 장부 대조·불변식 (ledgerHash 밖 — 검사만 하고 결과를 정하지 않는다). 계획 §2.4 불변식·§2.11 검사 9·10.
//   (가) 지갑마다 openStake = 엔진 상태에서 살아 있거나 대기 중인 그 지갑 곡괭이 가격 합
//   (나) Σ(balance + openStake) = 시작 공급 + Σ 받은 GRANT − Σ(끝난 곡괭이 가격 − payout − over)
//   (다) balance·openStake ≥ 0
// ──────────────────────────────────────────────────────────────────────────

/** 엔진 세계에서 지갑마다 열린 판돈 (돌고 있는 플레이어 곡괭이 + 대기열 칸의 가격 합). */
export function openStakeFromWorld(world: { rooms: readonly { state: RoomState }[] }): Map<string, bigint> {
  const out = new Map<string, bigint>();
  const add = (w: string, v: number) => out.set(w.toLowerCase(), (out.get(w.toLowerCase()) ?? 0n) + BigInt(v));
  for (const { state } of world.rooms) {
    for (const p of state.pickaxes) if (p.owner !== null) add(p.owner, p.priceMilli);
    for (const o of state.owners) for (const q of o.queue) add(o.owner, q.priceMilli);
  }
  return out;
}

export interface LedgerInvariantInputs {
  /** (가)를 볼 엔진 세계 (같은 윈도 끝). */
  world?: { rooms: readonly { state: RoomState }[] };
  /** (나): 기대 공급 = 시작 공급 + 받은 GRANT − 손실. */
  expectedSupplyMilli?: bigint;
}

/** 불변식 위반 목록 (없으면 빈 배열). */
export function checkLedgerInvariants(state: LedgerState, o: LedgerInvariantInputs = {}): string[] {
  const out: string[] = [];
  for (const l of state.leaves()) {
    if (BigInt(l.balanceMilli) < 0n) out.push(`${l.wallet}: balance ${l.balanceMilli} < 0`);
    if (BigInt(l.openStakeMilli) < 0n) out.push(`${l.wallet}: open stake ${l.openStakeMilli} < 0`);
  }
  if (o.world) {
    const engine = openStakeFromWorld(o.world);
    const wallets = new Set([...engine.keys(), ...state.wallets()]);
    for (const w of [...wallets].sort()) {
      const a = state.get(w).openStakeMilli;
      const b = engine.get(w) ?? 0n;
      if (a !== b) out.push(`${w}: ledger open stake ${a} ≠ engine alive/queued price sum ${b}`);
    }
  }
  if (o.expectedSupplyMilli !== undefined && state.supplyMilli() !== o.expectedSupplyMilli) {
    out.push(`supply ${state.supplyMilli()} ≠ expected ${o.expectedSupplyMilli} (start + grants − losses)`);
  }
  return out;
}

/** 잎 파일 ↔ 재생 상태 (+ 경계 위치). 다른 점 목록. */
export function checkLeavesFile(file: LedgerLeavesFile, state: LedgerState, at: { rootIndex: number; epoch: number; genesisBlock: number }): string[] {
  const out: string[] = [];
  if (file.rootIndex !== at.rootIndex) out.push(`rootIndex ${file.rootIndex} ≠ ${at.rootIndex}`);
  if (file.epoch !== at.epoch) out.push(`epoch ${file.epoch} ≠ ${at.epoch}`);
  if (file.throughWindow !== rootThroughWindow(at.epoch, at.genesisBlock)) out.push(`throughWindow ${file.throughWindow} ≠ ${rootThroughWindow(at.epoch, at.genesisBlock)}`);
  if (file.nextPurchaseId !== state.nextPurchaseId.toString()) out.push(`nextPurchaseId ${file.nextPurchaseId} ≠ replay ${state.nextPurchaseId}`);
  const mine = state.leaves();
  const theirs = new Map(file.leaves.map((l) => [l.wallet, l]));
  for (const l of mine) {
    const f = theirs.get(l.wallet);
    if (!f) out.push(`leaf ${l.wallet} missing from the file`);
    else if (JSON.stringify(f) !== JSON.stringify(l)) out.push(`leaf ${l.wallet}: file ${JSON.stringify(f)} ≠ replay ${JSON.stringify(l)}`);
    theirs.delete(l.wallet);
  }
  for (const w of theirs.keys()) out.push(`leaf ${w} in the file but not in the replay`);
  if (file.ledgerRoot !== state.root()) out.push(`file ledgerRoot ${file.ledgerRoot} ≠ replay ${state.root()}`);
  if (file.supplyMilli !== state.supplyMilli().toString()) out.push(`file supplyMilli ${file.supplyMilli} ≠ replay ${state.supplyMilli()}`);
  return out;
}

/** 다시 계산한 루트 칸 ↔ 체인 `RootPosted` (LedgerRootRecord도 그대로 넘길 수 있다). 다른 칸을 사람이 읽는 줄로. */
export function compareLedgerRoot(recomputed: LedgerRootFields, onchain: LedgerRootFields): string[] {
  return diffRootFields(recomputed, onchain).map((d) => `${d.field}: replay ${d.expected} ≠ chain ${d.actual}`);
}
