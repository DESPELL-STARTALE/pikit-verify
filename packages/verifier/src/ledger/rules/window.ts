import type { LinkedInput } from "@pikit/engine";
import type { PayoutLeaf } from "@pikit/protocol";
import { applyPayouts, applyWindowList, type RoomPayout, type WindowApplication } from "./apply.js";
import type { EntryAuth } from "./auth.js";
import type { LedgerContext } from "./context.js";
import { windowEngineInputs } from "./link.js";
import type { LedgerListLike } from "./list.js";
import type { LedgerState } from "./state.js";

// ──────────────────────────────────────────────────────────────────────────
// 윈도 하나의 순서 (ledgerHash 안, 계획 §2.4): ① 명단 w 적용 → ② 엔진 입력(연결) → ③ 엔진 한 윈도(부르는 쪽: runWorldWindow) → ④ 정산을 장부에.
// game-server(B2b)와 검증기(B5)가 이 함수로 윈도를 돈다 — 순서가 결과를 정하므로 여기(해시 안)에 둔다.
// 방 만들기(createdWindow에 addRoom)·난수·블록 해시는 부르는 쪽이 runEngine 안에서 한다.
// ──────────────────────────────────────────────────────────────────────────

/** 엔진 한 윈도: 입력(방마다) → 방마다 정산. runWorldWindow의 결과 모양(rooms[].result.payouts) 그대로. */
export type LedgerEngineStep = (inputs: Map<number, LinkedInput[]>) => { rooms: readonly { roomId: number; result: { payouts: readonly RoomPayout["payout"][] } }[] };

export interface LedgerWindowListInput {
  list: LedgerListLike;
  auth: readonly EntryAuth[];
  blockTimestamp: number;
}

export interface LedgerWindowResult {
  window: number;
  application: WindowApplication | null;
  inputs: Map<number, LinkedInput[]>;
  payouts: PayoutLeaf[];
}

/** 윈도 w (명단이 없으면 list = null — 엔진만 돈다). 상태를 그 자리에서 고친다. */
export function ledgerWindow(
  state: LedgerState, ctx: LedgerContext, window: number, list: LedgerWindowListInput | null, runEngine: LedgerEngineStep,
): LedgerWindowResult {
  if (list && list.list.window !== window) throw new Error(`ledgerWindow: list ${list.list.window} given for window ${window}`);
  const application = list ? applyWindowList(state, ctx, list.list, list.auth, list.blockTimestamp) : null;
  const inputs = windowEngineInputs(ctx, application);
  const res = runEngine(inputs);
  const payouts = applyPayouts(state, res.rooms.flatMap((r) => r.result.payouts.map((payout) => ({ roomId: r.roomId, payout }))));
  return { window, application, inputs, payouts };
}
