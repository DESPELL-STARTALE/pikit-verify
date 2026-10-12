import { z } from "zod";
import { Address, AnchorRecord, Bytes32, ChainSnapshot, DecimalString, SettlementRecord, U32 } from "@pikit/protocol";

// ──────────────────────────────────────────────────────────────────────────
// 검증기가 체인에서 읽는 값 (ChainFacts)과 그 출처 (ChainSource).
//   ChainFacts = protocol ChainSnapshot(pikit.chain/v3) + 개정 6 VoidOverPaid + 사건을 읽기 시작한 블록(fromBlock, 스냅숏 시작)
//              + 방마다 체인 규칙(roomOf, I-5) + 그 규칙의 체인 가격·상한표(catalogOf, M-2 — D162).
//   protocol은 동결(wave A)이라 더한 칸은 여기서 정의한다. voidOverPaid·fromBlock은 옛 v3 파일에 없어도 된다(빈 목록·genesis).
//   roomRules·catalogs는 필수다 — 없으면 가격을 대조할 수 없다(읽기 오류).
// 출처 두 가지:
//   RpcChainSource (rpc-source.ts) — 체인에서 바로(RPC 1~2곳, 2곳이면 모든 값 교차 확인). 운영자를 믿지 않는다.
//   StaticChainSource (여기)       — 파일. 운영자가 준 값을 믿는 것이다.
// ──────────────────────────────────────────────────────────────────────────

/** PikitShop `VoidOverPaid(purchaseId, itemIndex, buyer, overMilli)` (개정 6 payOverAfterVoid) + 실린 블록·tx. */
export const VoidOverPaidRecord = SettlementRecord.omit({ kind: true, payoutMilli: true });
export type VoidOverPaidRecord = ReturnType<typeof VoidOverPaidRecord.parse>;

/**
 * PikitShop.roomOf(roomId) — 방에 걸린 체인 규칙. nextRulesHash = 예약된 규칙(없으면 null). createdBlock = 방을 만든 블록(고정, 개정 6-b L-3) —
 * 세계 목록의 createdWindow는 max(W0, createdBlock)이어야 한다. 체인에 없는 방은 목록에 없다.
 */
export const ChainRoomRules = z.object({
  roomId: U32,
  rulesHash: Bytes32,
  nextRulesHash: Bytes32.nullable(),
  createdBlock: z.number().int().nonnegative(),
});
export type ChainRoomRules = z.infer<typeof ChainRoomRules>;

/** PikitShop.catalogOf(rulesHash) — 체인이 실제로 쓰는 등급 순서의 가격(크레딧)·REWARD 상한·over 상한(밀리크레딧). 등록 안 된 규칙이면 빈 배열. */
export const ChainCatalog = z.object({
  rulesHash: Bytes32,
  tierPrices: z.array(DecimalString),
  tierCapsMilli: z.array(DecimalString),
  tierOverCapsMilli: z.array(DecimalString),
});
export type ChainCatalog = z.infer<typeof ChainCatalog>;

export const ChainFacts = ChainSnapshot.extend({
  /** 사건(구매·취소·무효·정산·앵커·VoidOverPaid)을 빠짐없이 담은 첫 블록. 없으면 genesisBlock (처음부터). */
  fromBlock: AnchorRecord.shape.postedBlock.optional(),
  voidOverPaid: VoidOverPaidRecord.array().default([]),
  roomRules: ChainRoomRules.array(),
  catalogs: ChainCatalog.array(),
  /** PikitShop.fairness() — RPC로 읽었을 때만 (파일에는 없어도 된다). 보고서 첫 줄의 신뢰 뿌리 (M-4). */
  fairness: Address.optional(),
});
export type ChainFacts = ReturnType<typeof ChainFacts.parse>;

/** RPC 두 곳이 같은 체인 값을 다르게 답했다 (검증 실패). what = 어느 값인지, a·b = 두 곳의 값(짧게, URL 없음). */
export class ChainDisagreement extends Error {
  constructor(readonly what: string, readonly a: string, readonly b: string) {
    super(`RPC endpoints disagree on ${what}: rpc#1 ${a} vs rpc#2 ${b}`);
    this.name = "ChainDisagreement";
  }
}

/** 앵커 한 건의 체인 저장 값 (PikitFairness.anchorAt(i)) — 범위를 고르고(스냅숏·latest) 동결 판정에 쓴다. */
export interface AnchorStub {
  anchorIndex: number;
  postedBlock: number;
  processedThrough: number;
}

/**
 * 검증기가 체인 출처에 바라는 범위.
 *   blockHashes: 윈도 [fromWindow ?? genesis, throughWindow]의 블록 해시
 *   사건:        블록 [eventsFrom ?? genesis, ≥ throughWindow − 1]
 */
export interface ChainNeed {
  throughWindow: number;
  rooms: readonly number[];
  fromWindow?: number;
  eventsFrom?: number;
}

/** 체인 값의 출처. */
export interface ChainSource {
  /** 확정 머리(읽기 기준 블록)와 그때의 앵커 수. */
  head(): Promise<{ finalized: number; anchorCount: number; genesisBlock: number }>;
  /** 앵커 i (0 ≤ i < anchorCount). */
  anchorAt(index: number): Promise<AnchorStub>;
  /** 구매가 실린 블록 (없으면 null). */
  purchaseBlock(purchaseId: string): Promise<number | null>;
  snapshot(need: ChainNeed): Promise<ChainFacts>;
  /** 범위 밖 윈도의 블록 해시 (스냅숏 앞에서 시작한 묶음 줄). */
  blockHashes(windows: readonly number[]): Promise<Record<string, string>>;
}

/** 파일로 받은 체인 값. 운영자가 준 값을 그대로 믿는 것이다 — 누구나 확인하려면 RpcChainSource를 쓴다. */
export class StaticChainSource implements ChainSource {
  private parsed: ChainFacts | null = null;
  constructor(private readonly data: unknown) {}

  private facts(): ChainFacts {
    this.parsed ??= ChainFacts.parse(this.data);
    return this.parsed;
  }

  private sortedAnchors(): AnchorRecord[] {
    return [...this.facts().anchors].sort((a, b) => a.anchorIndex - b.anchorIndex);
  }

  async head(): Promise<{ finalized: number; anchorCount: number; genesisBlock: number }> {
    const f = this.facts();
    return { finalized: f.throughBlock, anchorCount: f.anchors.length, genesisBlock: f.genesisBlock };
  }

  async anchorAt(index: number): Promise<AnchorStub> {
    const a = this.sortedAnchors()[index];
    if (!a) throw new Error(`chain file: no anchor ${index}`);
    return { anchorIndex: a.anchorIndex, postedBlock: a.postedBlock, processedThrough: a.processedThrough };
  }

  async purchaseBlock(purchaseId: string): Promise<number | null> {
    return this.facts().purchases.find((p) => p.purchaseId === purchaseId)?.blockNumber ?? null;
  }

  async snapshot(): Promise<ChainFacts> {
    return this.facts();
  }

  async blockHashes(windows: readonly number[]): Promise<Record<string, string>> {
    const all = this.facts().blockHashes;
    return Object.fromEntries(windows.filter((w) => all[String(w)] !== undefined).map((w) => [String(w), all[String(w)]!]));
  }
}

/** processedThrough가 단조 증가하는 앵커들에서 조건을 만족하는 가장 큰 번호 (없으면 −1). 이진 탐색 — 앵커가 수천 개여도 eth_call 십여 번. */
export async function lastAnchorWhere(chain: ChainSource, count: number, ok: (a: AnchorStub) => boolean): Promise<AnchorStub | null> {
  let lo = 0;
  let hi = count - 1;
  let best: AnchorStub | null = null;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const a = await chain.anchorAt(mid);
    if (ok(a)) { best = a; lo = mid + 1; } else hi = mid - 1;
  }
  return best;
}
