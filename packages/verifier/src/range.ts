import { epochOf, epochWindows, SETTLE_STALL } from "@pikit/protocol";
import { lastAnchorWhere, type ChainSource } from "./chain.js";

// ──────────────────────────────────────────────────────────────────────────
// 검증 범위 고르기 (CLI `--epoch` · `--from-snapshot` · `--purchase`). 체인 앵커(anchorCount·anchorAt, 이진 탐색)만 본다 — 로그를 처음부터 읽지 않는다.
//   --epoch N | latest        마지막 에폭. latest = 체인의 마지막 앵커가 덮은 에폭(processedThrough + 1이 그 에폭 끝) — 범위 끝이 앵커 루트로 확인된다
//   --from-snapshot E         에폭 E 끝 스냅숏에서 시작(에폭 E+1부터 재생). E 끝에 앵커가 있어야 한다(스냅숏 루트 = 앵커 루트)
//   --from-snapshot latest    범위 끝에서 하루(288,000블록) + SETTLE_STALL(6,000) 이상 앞선 가장 최근 앵커 에폭. 매일 돌리면 앞날 실행과
//                             SETTLE_STALL만큼 겹쳐, 전날 범위 끝 무렵에 끝난 곡괭이의 정산 시한도 다음 실행이 본다. 그런 앵커가 없으면 처음부터
//   --purchase id             그 구매가 실린 블록 앞의 가장 최근 앵커 에폭에서 시작(없으면 처음부터), 끝은 --epoch(기본 latest)
//   --max-epochs n            한 번에 n 에폭까지만(따라잡기를 나눈다, D163): 끝 = 시작 + n − 1 이하의 마지막 앵커 에폭(없으면 시작 + n − 1)
// ──────────────────────────────────────────────────────────────────────────

/** 하루 = 288,000블록 (0.3초 블록, = PikitShop DEFAULT_SETTLE_TIMEOUT). */
export const DAY_WINDOWS = 288_000;

export interface RangeRequest {
  epoch: number | "latest";
  fromSnapshot?: number | "latest";
  purchase?: string;
  maxEpochs?: number;
}

export interface VerifyRange {
  firstEpoch: number;          // 재생하는 첫 에폭 (1 = 처음부터)
  lastEpoch: number;
  snapshotEpoch: number | null;   // 시작 스냅숏 (firstEpoch − 1), 처음부터면 null
  note: string;                // 사람이 읽는 한 줄 (왜 이 범위인지)
}

export class VerifyRangeError extends Error {}

/** 체인 앵커로 범위를 정한다. 고를 수 없으면 VerifyRangeError (CLI 종료 1). */
export async function resolveRange(chain: ChainSource, req: RangeRequest): Promise<VerifyRange> {
  const head = await chain.head();
  const W0 = head.genesisBlock;
  const endOfAnchor = (p: number) => {
    const w = p + 1;
    const e = epochOf(w, W0);
    if (epochWindows(e, W0).last !== w) throw new VerifyRangeError(`anchor processedThrough ${p} is not an epoch end`);
    return e;
  };

  let lastEpoch: number;
  if (req.epoch === "latest") {
    if (head.anchorCount === 0) throw new VerifyRangeError("no anchor on chain yet — nothing to verify");
    lastEpoch = endOfAnchor((await chain.anchorAt(head.anchorCount - 1)).processedThrough);
  } else {
    lastEpoch = req.epoch;
    if (epochWindows(lastEpoch, W0).last > head.finalized) throw new VerifyRangeError(`epoch ${lastEpoch} ends at window ${epochWindows(lastEpoch, W0).last}, after the finalized head ${head.finalized}`);
  }
  const lastWindow = epochWindows(lastEpoch, W0).last;

  /** 블록·윈도 ≤ bound인 가장 최근 앵커의 에폭 (없으면 null). */
  const anchoredAtOrBefore = async (bound: number) => {
    const a = await lastAnchorWhere(chain, head.anchorCount, (x) => x.processedThrough + 1 <= bound);
    return a ? endOfAnchor(a.processedThrough) : null;
  };

  let snapshotEpoch: number | null = null;
  let note: string;
  if (req.purchase !== undefined) {
    const block = await chain.purchaseBlock(req.purchase);
    if (block === null) throw new VerifyRangeError(`purchase ${req.purchase} is not on chain`);
    if (block + 1 > lastWindow) throw new VerifyRangeError(`purchase ${req.purchase} (block ${block}) enters window ${block + 1}, after epoch ${lastEpoch}`);
    snapshotEpoch = await anchoredAtOrBefore(block);
    note = `purchase ${req.purchase} in block ${block}: ${snapshotEpoch === null ? "no anchor before it, from genesis" : `from the anchored snapshot of epoch ${snapshotEpoch}`}`;
  } else if (req.fromSnapshot === "latest") {
    const bound = lastWindow - DAY_WINDOWS - SETTLE_STALL;
    snapshotEpoch = bound >= W0 ? await anchoredAtOrBefore(bound) : null;
    note = snapshotEpoch === null
      ? "no anchored snapshot a day + SETTLE_STALL before the end — from genesis"
      : `latest anchored snapshot at least ${DAY_WINDOWS} + ${SETTLE_STALL} windows before the end: epoch ${snapshotEpoch}`;
  } else if (req.fromSnapshot !== undefined) {
    const E = req.fromSnapshot;
    const end = epochWindows(E, W0).last;
    const at = await lastAnchorWhere(chain, head.anchorCount, (x) => x.processedThrough + 1 <= end);
    if (!at || at.processedThrough + 1 !== end) {
      throw new VerifyRangeError(`epoch ${E} is not anchored on chain (no anchor with processedThrough ${end - 1})${at ? `; the nearest anchored epoch before it is ${endOfAnchor(at.processedThrough)}` : ""}`);
    }
    snapshotEpoch = E;
    note = `from the anchored snapshot of epoch ${E} (anchor ${at.anchorIndex})`;
  } else {
    note = "from genesis";
  }
  if (snapshotEpoch !== null && snapshotEpoch >= lastEpoch) throw new VerifyRangeError(`start snapshot epoch ${snapshotEpoch} is not before the last epoch ${lastEpoch}`);
  const firstEpoch = snapshotEpoch === null ? 1 : snapshotEpoch + 1;
  if (req.maxEpochs !== undefined && lastEpoch - firstEpoch + 1 > req.maxEpochs) {
    const cap = firstEpoch + req.maxEpochs - 1;
    const anchored = await anchoredAtOrBefore(epochWindows(cap, W0).last);
    const end = anchored !== null && anchored >= firstEpoch ? anchored : cap;
    note += `; capped at ${req.maxEpochs} epochs: through epoch ${end} of ${lastEpoch} (catching up)`;
    lastEpoch = end;
  }
  return { firstEpoch, lastEpoch, snapshotEpoch, note };
}
