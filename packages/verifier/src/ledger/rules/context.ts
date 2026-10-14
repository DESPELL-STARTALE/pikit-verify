import { ledgerDomain, type Catalog } from "@pikit/protocol";
import type { TypedDataDomain } from "viem";

// ──────────────────────────────────────────────────────────────────────────
// 장부 규칙이 믿는 세계 값 (ledgerHash 안). 모두 체인 불변값 또는 world.json(체인과 대조된 값)에서 온다:
//   chainId · ledger(PikitLedger 주소 = EIP-712 verifyingContract) · 방마다 createdWindow·카탈로그·체인 rulesHash.
// ──────────────────────────────────────────────────────────────────────────

export interface LedgerRoom {
  roomId: number;
  /** 방이 생긴 윈도 (PikitLedger는 모든 방이 genesisBlock W0). 입력은 윈도 createdWindow + 1부터. */
  createdWindow: number;
  /** 가격 = Σ catalog.pickaxes[tier].priceCredits × 1,000. 등급 검사도 이 카탈로그(엔진과 같은 판정). */
  catalog: Catalog;
  /** 체인 rulesHash = keccak256(catalogHash ‖ engineVersionHash) — 의향서의 rulesHash가 이 값이어야 한다. 소문자 0x. */
  rulesHash: string;
}

export interface LedgerContext {
  chainId: number;
  /** PikitLedger 주소 (소문자). */
  ledger: string;
  rooms: readonly LedgerRoom[];
}

/** 이 세계의 서명 도메인 { "PIKIT-LEDGER", "1", chainId, PikitLedger }. */
export function contextDomain(ctx: LedgerContext): TypedDataDomain {
  return ledgerDomain(ctx.ledger, ctx.chainId);
}

export function roomOf(ctx: LedgerContext, roomId: number): LedgerRoom | undefined {
  return ctx.rooms.find((r) => r.roomId === roomId);
}
