import { z } from "zod";
import { Address, Bytes32, epochOf, SETTLE_STALL } from "@pikit/protocol";
import type { EpochVerifyReport } from "./epoch.js";

// ──────────────────────────────────────────────────────────────────────────
// 감시자 이어 받기 (리뷰 rev6 H-1, D163) — `verify --since-state <파일> --write-state <파일>`.
// 매일(이제 매시간) 실행이 "끝에서 하루 + 30분 앞 스냅숏"처럼 시계로 시작점을 고르면, 늦거나 실패한 실행 뒤의 구간을 아무도 다시 안 본다.
// 대신 성공한 실행이 다음 실행의 시작점을 남긴다:
//   openFromWindow = 이 실행이 끝까지 판정하지 못한 첫 윈도 = min(체인 값 머리 − SETTLE_STALL, 시한 전 미정산(경고)의 끝 윈도, 재생 끝 + 1).
//     그 윈도 이후에 끝난 곡괭이는 정산 시한이 아직 안 지났거나(체인 머리 ≤ 끝 + 6,000) 무효 over 시한(max(끝, 무효 블록) + 6,000)을 기다린다.
//   resume = 범위 안에서 검증한 앵커 중 processedThrough + 1 ≤ openFromWindow − 1인 마지막 것(그 스냅숏에서 다시 시작하면 열린 곡괭이를
//     모두 다시 재생한다). 없으면 이 실행의 시작 앵커(앞 실행이 이미 그렇게 골랐다), 그것도 없으면 처음부터(null).
// 다음 실행은 resume의 스냅숏에서 시작하고(그 앵커 번호·roomsStateRoot가 같아야 한다), 끝은 체인의 마지막 앵커(따라잡기)다.
// 실패한 실행은 상태를 쓰지 않는다 — 다음 실행이 같은 곳에서 다시 시작해 또 실패한다(조용히 건너뛰지 않는다).
// ──────────────────────────────────────────────────────────────────────────

export const VERIFY_STATE_SCHEMA_ID = "pikit.verify-state/v1";

export const VerifyState = z.object({
  schema: z.literal(VERIFY_STATE_SCHEMA_ID),
  chainId: z.number().int().positive(),
  shop: Address,
  engineVersionHash: Bytes32,
  /** 검증을 마친 마지막 에폭 (범위 끝). */
  lastEpoch: z.number().int().positive(),
  /** 다음 실행의 시작 스냅숏: 그 에폭 끝 앵커. null = 처음부터. */
  resume: z.object({ epoch: z.number().int().positive(), anchorIndex: z.number().int().nonnegative(), roomsStateRoot: Bytes32 }).nullable(),
  openFromWindow: z.number().int(),
  chainThroughBlock: z.number().int().nonnegative(),
}).strict();
export type VerifyState = z.infer<typeof VerifyState>;

/** 이 실행이 끝까지 판정하지 못한 첫 윈도 (그 뒤에 끝난 곡괭이는 다음 실행이 다시 재생해야 한다). */
export function openFromWindow(report: Pick<EpochVerifyReport, "chainThroughBlock" | "replayedThrough" | "settlements">): number {
  return Math.min(report.chainThroughBlock - SETTLE_STALL, report.replayedThrough + 1, ...report.settlements.unsettled.map((p) => p.window));
}

/** 성공한 실행의 보고서 → 다음 실행이 이어 받을 상태. 실패한 보고서로는 만들지 않는다. */
export function nextVerifyState(report: EpochVerifyReport): VerifyState {
  if (!report.ok) throw new Error("nextVerifyState: the run failed — keep the previous state (the next run starts from the same place)");
  const t = report.trust;
  if (t.chainId === null || t.genesisBlock === null) throw new Error("nextVerifyState: the run did not read the chain");
  const open = openFromWindow(report);
  const candidate = [...report.anchors]
    .filter((a) => a.processedThrough + 1 <= open - 1)
    .sort((a, b) => a.anchorIndex - b.anchorIndex)
    .pop();
  const resume = candidate
    ? { epoch: epochOf(candidate.processedThrough + 1, t.genesisBlock), anchorIndex: candidate.anchorIndex, roomsStateRoot: candidate.roomsStateRoot.expected }
    : report.start
      ? { epoch: report.start.epoch, anchorIndex: report.start.anchorIndex, roomsStateRoot: report.start.roomsStateRoot }
      : null;
  return VerifyState.parse({
    schema: VERIFY_STATE_SCHEMA_ID, chainId: t.chainId, shop: t.shop, engineVersionHash: t.engineVersionHash,
    lastEpoch: report.epochs, resume, openFromWindow: open, chainThroughBlock: report.chainThroughBlock,
  });
}
