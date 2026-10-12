import { z } from "zod";
import { Bytes32, BlockNumber, U32 } from "./primitives.js";

// ──────────────────────────────────────────────────────────────────────────
// 공정성 기록 — 에폭 시드 약속·공개(앵커), 2,000블록 묶음 약속 (설계 §4.2, §4.5, §6.2, 부록 B)
// ──────────────────────────────────────────────────────────────────────────

/** 출시 때 체인에 올리는 시드 사슬의 뿌리. S_{i−1} = keccak256(S_i), 체인에는 S_0만. */
export const SeedChainCommitment = z.object({
  chainId: z.number().int().positive(),
  fairness: z.string().regex(/^0x[0-9a-f]{40}$/),
  seedRoot: Bytes32,          // S_0
  firstWindow: BlockNumber,   // W0: e(w) = 1 + floor((w − W0) / 200)
  epochLength: z.literal(200),
}).strict();
export type SeedChainCommitment = z.infer<typeof SeedChainCommitment>;

/**
 * 앵커 1건 = 에폭 시드 공개 + 처리 완료 블록(생존 신호) + 각종 루트.
 * PikitFairness.anchor(epoch, seed, processedThrough, processedPurchases, roomsStateRoot, inputLogRoot, boardBatchRoot) 인자와 같은 모양.
 */
export const EpochAnchor = z.object({
  epoch: U32,
  seed: Bytes32,                    // 지난 에폭 시드 S_e (공개)
  processedThrough: BlockNumber,    // 처리 완료 블록 P (uint64)
  processedPurchases: z.number().int().nonnegative(),   // 블록 ≤ P인 구매 수 (컨트랙트가 상점 기록으로 검사)
  roomsStateRoot: Bytes32,
  inputLogRoot: Bytes32,
  boardBatchRoot: Bytes32,
}).strict();
export type EpochAnchor = z.infer<typeof EpochAnchor>;

/** 끝난 2,000칸 묶음 (방 ρ, 묶음 j). hash = H_j = boardBatchHash(j, kinds) (D40). 앵커 boardBatchRoot의 잎 재료. */
export const BoardBatchCommitment = z.object({
  roomId: U32,
  batchIndex: z.number().int().nonnegative(),
  kinds: z.array(z.number().int().min(0).max(255)).length(2000),
  rowWindows: z.array(BlockNumber).length(200),
  hash: Bytes32,
  anchoredEpoch: U32.optional(),
}).strict();
export type BoardBatchCommitment = z.infer<typeof BoardBatchCommitment>;
