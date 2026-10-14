import { z } from "zod";
import { Address, BlockNumber, Bytes32, U32 } from "@pikit/protocol";
import type { LedgerVerifyReport, ResumePoint } from "./ledger-verify.js";

// ──────────────────────────────────────────────────────────────────────────
// 감시자 이어 받기 v2 (리뷰 rev6 H-1·D163 → 개정 7, 계획 §2.11, D205) — `verify --since-state <파일> --write-state <파일>`.
// 상태 = 마지막으로 검증한 루트 번호와 그 칸들. 다음 실행은 그 루트 경계(스냅숏 + 잎 파일)에서 시작해 체인 마지막 루트까지(--max-roots씩).
// 시작 경계의 체인 루트 칸이 상태와 같아야 한다(다른 PikitLedger·다른 세계면 실패). 개정 6의 openFromWindow(정산 시한 기다림)는 없다 —
// 장부 세계의 정산은 체인 tx가 아니라 루트 안에서 끝난다.
// 실패한 실행은 상태를 쓰지 않는다 — 다음 실행이 같은 곳에서 다시 시작해 또 실패한다(조용히 건너뛰지 않는다).
// ──────────────────────────────────────────────────────────────────────────

export const VERIFY_STATE_SCHEMA_ID = "pikit.verify-state/v2";

export const VerifyState = z.object({
  schema: z.literal(VERIFY_STATE_SCHEMA_ID),
  chainId: z.number().int().positive(),
  contract: Address,
  engineVersionHash: Bytes32,
  ledgerHash: Bytes32,
  /** 검증을 마친 마지막 루트 번호 (컨트랙트 rootAt 순번, 0부터). */
  lastRoot: z.number().int().nonnegative(),
  /** 그 루트의 epoch · throughWindow · 칸 (다음 시작 경계 대조). */
  epoch: U32.min(1),
  throughWindow: BlockNumber,
  roomsStateRoot: Bytes32,
  inputLogRoot: Bytes32,
  ledgerRoot: Bytes32,
}).strict();
export type VerifyState = z.infer<typeof VerifyState>;

/** 성공한 실행의 보고서 → 다음 실행이 이어 받을 상태. 실패했거나 루트를 하나도 검증하지 않았으면 던진다. */
export function nextVerifyState(report: LedgerVerifyReport): VerifyState {
  if (!report.ok) throw new Error("nextVerifyState: the run failed — keep the previous state (the next run starts from the same place)");
  const t = report.trust;
  const v = report.verified;
  if (t.chainId === null || t.ledgerHash === null || v === null) throw new Error("nextVerifyState: the run verified no root");
  return VerifyState.parse({
    schema: VERIFY_STATE_SCHEMA_ID, chainId: t.chainId, contract: t.contract, engineVersionHash: t.engineVersionHash, ledgerHash: t.ledgerHash,
    lastRoot: v.rootIndex, epoch: v.epoch, throughWindow: v.throughWindow, roomsStateRoot: v.roomsStateRoot, inputLogRoot: v.inputLogRoot, ledgerRoot: v.ledgerRoot,
  });
}

/** 상태 → verifyLedger의 이어 받기 점. */
export function resumePoint(s: VerifyState): ResumePoint {
  return { lastRoot: s.lastRoot, epoch: s.epoch, roomsStateRoot: s.roomsStateRoot, inputLogRoot: s.inputLogRoot, ledgerRoot: s.ledgerRoot };
}
