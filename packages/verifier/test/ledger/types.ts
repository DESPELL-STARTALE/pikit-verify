// 시험이 쓰는 protocol·engine 이름 (한 곳에서 가져온다).
export { GRANT_MAX_MILLI, itemIdOf, LedgerDecision, MAX_INPUTS_PER_ROOM_WINDOW } from "@pikit/protocol";
export type { LedgerListEntry, LedgerSessionRecord } from "@pikit/protocol";
import type { EnginePayout } from "@pikit/engine";
export type EnginePayoutLike = EnginePayout;
