import { z } from "zod";
import { Address, Bytes32, BlockNumber, DecimalString, U32 } from "./primitives.js";

// ──────────────────────────────────────────────────────────────────────────
// 검증 묶음 (verifier-cli `verify --epoch N`의 입력)
//  - WorldManifest: 운영자가 공개하는 방 목록·카탈로그·시드 약속(체인의 seedRoot·genesisBlock과 대조)
//  - ChainSnapshot: 체인에서 읽은 값(앵커, 블록 해시, 정산, 구매·취소·무효 구간). RPC에서 직접 읽거나(RpcChainSource, 운영자를 믿지 않음)
//    파일로 받는다(StaticChainSource, 운영자가 준 값을 믿는 것)
// ──────────────────────────────────────────────────────────────────────────

export const WORLD_MANIFEST_SCHEMA_ID = "pikit.world/v1" as const;

export const WorldRoom = z.object({
  roomId: U32,
  createdWindow: BlockNumber,           // createRoom을 부른 윈도(그 윈도의 키로 판·봇을 만든다, 입력 없음)
  catalogHash: Bytes32,                 // canonicalHash(카탈로그) — 카탈로그 파일 이름
}).strict();
export type WorldRoom = z.infer<typeof WorldRoom>;

export const WorldManifest = z.object({
  schema: z.literal(WORLD_MANIFEST_SCHEMA_ID),
  chainId: z.number().int().positive(),
  shop: Address,
  genesisBlock: BlockNumber,            // W0
  seedRoot: Bytes32,                    // S_0
  engineVersionHash: Bytes32,           // 이 기록을 만든 엔진 (검증자 엔진과 같아야 한다)
  ledgerVersionHash: Bytes32.optional(), // 명세 20 장부 규칙 해시 (PikitLedger.ledgerHash와 같아야 한다, D196). 개정 7 세계(shop = PikitLedger 주소)에만
  rooms: z.array(WorldRoom).min(1),
}).strict().superRefine((m, ctx) => {
  let prev = -1;
  for (const r of m.rooms) {
    if (r.roomId <= prev) ctx.addIssue({ code: "custom", message: "rooms must be strictly ascending by roomId" });
    if (r.createdWindow < m.genesisBlock) ctx.addIssue({ code: "custom", message: `room ${r.roomId}: createdWindow < genesisBlock` });
    prev = r.roomId;
  }
});
export type WorldManifest = z.infer<typeof WorldManifest>;

/**
 * 체인 앵커 1건 = PikitFairness `Anchored(anchorIndex, processedThrough, processedPurchases, epoch, seed, roomsStateRoot,
 * inputLogRoot, boardBatchRoot)` 이벤트 + 실린 블록.
 */
export const AnchorRecord = z.object({
  anchorIndex: z.number().int().nonnegative(),
  postedBlock: BlockNumber,
  processedThrough: BlockNumber,
  processedPurchases: z.number().int().nonnegative(),   // purchaseId < 이 값인 구매는 처리됨 (= 블록 ≤ processedThrough인 구매 수)
  epoch: U32,
  seed: Bytes32,
  roomsStateRoot: Bytes32,
  inputLogRoot: Bytes32,
  boardBatchRoot: Bytes32,
}).strict();
export type AnchorRecord = z.infer<typeof AnchorRecord>;

/**
 * 체인 구매 1건 = PikitShop `Purchased(purchaseId, buyer, roomId, rulesHash, seq, tiers, priceCredits)` + 로그 자리 (D111).
 * 검증기는 이것으로 purchase 입력(ref = purchaseId, owner = buyer, tiers)과 그 윈도를 직접 만든다.
 */
export const PurchaseRecord = z.object({
  purchaseId: DecimalString,
  buyer: Address,
  roomId: U32,
  rulesHash: Bytes32,               // 그 구매가 따른 체인 규칙 = keccak256(catalogHash ‖ engineVersionHash) (D41) — 재생 카탈로그와 같아야 한다
  tiers: z.array(z.number().int().min(0).max(31)).min(1).max(10),
  blockNumber: BlockNumber,
  logIndex: z.number().int().nonnegative(),
  txHash: Bytes32,
}).strict();
export type PurchaseRecord = z.infer<typeof PurchaseRecord>;

/** 체인 취소 1건 = PikitShop `CancelRequested(wallet, roomId, items)` + 로그 자리. items = (purchaseId << 8) | itemIndex (10진). */
export const CancelRecord = z.object({
  wallet: Address,
  roomId: U32,
  items: z.array(DecimalString).min(1).max(10),
  blockNumber: BlockNumber,
  logIndex: z.number().int().nonnegative(),
  txHash: Bytes32,
}).strict();
export type CancelRecord = z.infer<typeof CancelRecord>;

/** 무효 구간 1건 = PikitFairness `PurchasesVoided(fromId, toId)`(늦은 앵커와 같은 tx) + 로그 자리. 구매 [fromId, toId)가 무효. */
export const VoidRangeRecord = z.object({
  fromId: DecimalString,
  toId: DecimalString,
  blockNumber: BlockNumber,
  logIndex: z.number().int().nonnegative(),
  txHash: Bytes32,
}).strict().refine((v) => BigInt(v.fromId) < BigInt(v.toId), { message: "fromId < toId" });
export type VoidRangeRecord = z.infer<typeof VoidRangeRecord>;
