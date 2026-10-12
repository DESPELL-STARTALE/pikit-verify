import type { RoomState } from "./types.js";

// ──────────────────────────────────────────────────────────────────────────
// 상태 정리 (DECISIONS D68, docs/determinism.md §6). 오래 도는 방의 상태가 끝없이 커지지 않게, 추가만 되는 기록의 오래된 앞부분을 지운다.
// 이것은 규칙의 일부다: 모든 서버·검증기가 같은 윈도에서 같은 것을 지우므로 상태 해시가 어디서나 같다.
//  - 언제: 윈도 번호 w가 PRUNE_PERIOD_WINDOWS(200 = 에폭 길이)의 배수일 때, 그 윈도의 입력보다 먼저 (runWindow 맨 앞)
//  - 무엇: 기록 윈도 < w − RETAIN_WINDOWS 인 것
//      방   results(끝난 곡괭이, endWindow 기준), rejected(효과 없는 입력), 쉬는 지갑 칸(살아 있는 곡괭이·대기열 없음, nextSpawnWindow ≤ w)
//  - 지운 개수는 prunedResults·prunedRejected에 더한다 → "절대 순번 = 지운 개수 + 배열 위치"로 새 줄을 찾을 수 있다
//  - 남은 원소의 직렬화는 바뀌지 않는다(같은 바이트). 상태 해시 = 살아 있는 상태 + 보관 기간 안의 기록 + 지운 개수
// 보관 기간 4,000윈도는 무효 구매 경계(덮는 앵커 없이 2,001블록, D50④)의 2배다.
// voidedRefs는 지우지 않는다(무효 구매는 예외 상황에서만 생기고, 같은 ref가 다시 오면 거절해야 한다).
// 히스토리·피드는 DB(게임 서버)와 윈도 결과에 있으므로 엔진 상태에서 지워도 잃는 것이 없다.
// ──────────────────────────────────────────────────────────────────────────

export const PRUNE_PERIOD_WINDOWS = 200;
export const RETAIN_WINDOWS = 4000;

/** 이 윈도 맨 앞에서 정리하나. */
export function pruneDue(window: number): boolean {
  return window % PRUNE_PERIOD_WINDOWS === 0;
}

/** 배열 앞에서 조건이 참인 원소 개수 (기록은 윈도 순서로 쌓이므로 앞부분만 오래됐다). */
function leadingCount<T>(a: readonly T[], old: (x: T) => boolean): number {
  let n = 0;
  while (n < a.length && old(a[n]!)) n++;
  return n;
}

/** 방 상태 정리 (윈도 w 맨 앞). 지운 개수를 돌려준다. */
export function pruneRoom(state: RoomState, window: number): { results: number; rejected: number; owners: number } {
  const cutoff = window - RETAIN_WINDOWS;
  const results = leadingCount(state.results, (r) => r.endWindow < cutoff);
  const rejected = leadingCount(state.rejected, (r) => r.window < cutoff);
  if (results > 0) { state.results.splice(0, results); state.prunedResults += results; }
  if (rejected > 0) { state.rejected.splice(0, rejected); state.prunedRejected += rejected; }
  // 쉬는 지갑 칸: 지워도 다음 구매 때 같은 값(nextSpawnWindow ≤ w ⇒ 바로 스폰 가능)으로 다시 생긴다 — 규칙 결과가 같다
  const before = state.owners.length;
  state.owners = state.owners.filter((s) => s.activeKey !== null || s.queue.length > 0 || s.nextSpawnWindow > window);
  return { results, rejected, owners: before - state.owners.length };
}
