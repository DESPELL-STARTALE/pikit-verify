// ──────────────────────────────────────────────────────────────────────────
// 컨트랙트 ABI — Foundry 산출물에서 만든 것(abi.generated.ts, abi/*.json). 컨트랙트가 진실이다(DECISIONS D53).
// 손으로 적은 시그니처는 두지 않는다. 컨트랙트를 바꾸면 `pnpm --filter @pikit/protocol abi:export`로 다시 만들고,
// `pnpm lint`가 산출물과 다른지 검사한다(contracts/out이 있을 때).
// ──────────────────────────────────────────────────────────────────────────

export { pikitFairnessAbi, pikitShopAbi } from "./abi.generated.js";

/** PikitShop.purchaseStatus(id)가 돌려주는 enum 순서 (IPikitShop.PurchaseStatus). */
export const ONCHAIN_PURCHASE_STATUS = ["PENDING", "PROCESSED", "VOID", "REFUNDED"] as const;
