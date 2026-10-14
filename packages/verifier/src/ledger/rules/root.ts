import { dataHash, payoutsRoot, rootDataPaths, rootThroughWindow, type DataFileDigest, type Hex32 } from "@pikit/protocol";
import type { LedgerRootFields, PayoutLeaf } from "@pikit/protocol";
import type { LedgerState } from "./state.js";

// ──────────────────────────────────────────────────────────────────────────
// 루트 k의 10칸 (ledgerHash 안, 계획 §2.7·§2.10). 경계 에폭 끝(throughWindow = W0 + 200·epoch − 1)의 상태로 만든다.
//   seed·roomsStateRoot·inputLogRoot·boardBatchRoot = 지금 앵커 계산 그대로(부르는 쪽이 roots.ts·입력 기록에서)
//   ledgerRoot·supplyMilli = 경계 장부 상태 · payoutsRoot = 범위(직전 루트 throughWindow 뒤 ~ 이 throughWindow) 안의 지급 잎 전부
//   dataHash = keccak(⨁ keccak(utf8 path) ‖ sha256) — 경로 순서는 rootDataPaths(fromEpoch, epoch, k) 그대로(A1, D196). 하나라도 없으면 던진다.
// ──────────────────────────────────────────────────────────────────────────

export interface RootFieldInputs {
  epoch: number;
  genesisBlock: number;
  seed: string;
  roomsStateRoot: string;
  inputLogRoot: string;
  boardBatchRoot: string;
  state: LedgerState;
  /** 범위 안 지급 잎 (생긴 순서 — 루트는 순서와 상관없다). */
  payouts: readonly PayoutLeaf[];
  /** 범위 첫 에폭 = 직전 루트 epoch + 1 (첫 루트는 1). */
  fromEpoch: number;
  /** 컨트랙트 루트 순번 k (0부터). */
  rootIndex: number;
  /** 공개 파일 경로 → sha256 (경로는 에폭 디렉터리 기준). rootDataPaths의 경로가 모두 있어야 한다(다른 경로는 무시). */
  files: ReadonlyMap<string, string>;
}

/** 루트 k의 dataHash 재료 (rootDataPaths 순서). 빠진 경로가 있으면 던진다. */
export function rootDataFiles(fromEpoch: number, toEpoch: number, rootIndex: number, files: ReadonlyMap<string, string>): DataFileDigest[] {
  const paths = rootDataPaths(fromEpoch, toEpoch, rootIndex);
  const missing = paths.filter((p) => !files.has(p));
  if (missing.length > 0) throw new Error(`root ${rootIndex}: missing files ${missing.slice(0, 5).join(", ")}${missing.length > 5 ? ` … (${missing.length})` : ""}`);
  return paths.map((path) => ({ path, sha256: files.get(path)!.toLowerCase() as Hex32 }));
}

export function ledgerRootFields(i: RootFieldInputs): LedgerRootFields {
  const low = (h: string) => h.toLowerCase();
  return {
    epoch: i.epoch,
    seed: low(i.seed),
    throughWindow: rootThroughWindow(i.epoch, i.genesisBlock),
    roomsStateRoot: low(i.roomsStateRoot),
    inputLogRoot: low(i.inputLogRoot),
    boardBatchRoot: low(i.boardBatchRoot),
    ledgerRoot: i.state.root(),
    payoutsRoot: payoutsRoot(i.payouts),
    supplyMilli: i.state.supplyMilli().toString(),
    dataHash: dataHash(rootDataFiles(i.fromEpoch, i.epoch, i.rootIndex, i.files)),
  };
}

/** 루트 칸 이름 (비교 순서). */
export const ROOT_FIELD_NAMES = [
  "epoch", "seed", "throughWindow", "roomsStateRoot", "inputLogRoot", "boardBatchRoot", "ledgerRoot", "payoutsRoot", "supplyMilli", "dataHash",
] as const satisfies readonly (keyof LedgerRootFields)[];

/** 다시 계산한 칸 ↔ 체인 루트: 다른 칸 목록 (같으면 빈 배열). 해시는 대소문자 무시. */
export function diffRootFields(expected: LedgerRootFields, actual: LedgerRootFields): { field: (typeof ROOT_FIELD_NAMES)[number]; expected: string; actual: string }[] {
  const norm = (v: string | number) => String(v).toLowerCase();
  return ROOT_FIELD_NAMES.filter((f) => norm(expected[f]) !== norm(actual[f])).map((f) => ({ field: f, expected: String(expected[f]), actual: String(actual[f]) }));
}
