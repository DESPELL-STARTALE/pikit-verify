import { InputScheduler, linkedInputs, type ChainInputEvents, type LinkedInput, type LinkRoom } from "@pikit/engine";
import type { LedgerContext } from "./context.js";
import type { WindowApplication } from "./apply.js";
import { LedgerInvariantError } from "./state.js";

// ──────────────────────────────────────────────────────────────────────────
// 받은 항목 → 엔진 입력 (ledgerHash 안, 계획 §2.1). 엔진 연결 규칙(`linkedInputs`·`InputScheduler`, engineVersionHash 안)을 **그대로** 쓴다:
//   PurchaseRecord·CancelRecord의 블록 = w − 1 → 윈도 w, (블록, 로그 번호 = 명단 순번, 순번) 순, 방-윈도 100개.
//   장부가 방-윈도 100개를 지키므로(ROOM_WINDOW_FULL) 넘김(carry)이 생기지 않는다 — 생기면 LedgerInvariantError.
// 무효·동결 입력은 만들지 않는다(voids: [], freezeBlocks: []).
// ──────────────────────────────────────────────────────────────────────────

/** 엔진 연결용 방 목록 (createdWindow·체인 rulesHash). */
export function linkRooms(ctx: LedgerContext): LinkRoom[] {
  return ctx.rooms.map((r) => ({ roomId: r.roomId, createdWindow: r.createdWindow, rulesHash: r.rulesHash.toLowerCase() }));
}

/** 받은 항목들 → 엔진이 받는 '체인 사건' 모양 (검증기의 checkInputLinkage에 그대로 넘긴다). */
export function ledgerInputEvents(apps: readonly WindowApplication[]): ChainInputEvents {
  return { purchases: apps.flatMap((a) => a.purchases), cancels: apps.flatMap((a) => a.cancels), voids: [], freezeBlocks: [] };
}

/** 윈도 w의 엔진 입력 (방마다 연결 순서). app = 명단 w를 적용한 결과(없으면 빈 맵). */
export function windowEngineInputs(ctx: LedgerContext, app: WindowApplication | null): Map<number, LinkedInput[]> {
  if (!app || (app.purchases.length === 0 && app.cancels.length === 0)) return new Map();
  const w = app.window;
  const rooms = linkRooms(ctx);
  const { items, problems } = linkedInputs(ledgerInputEvents([app]), rooms);
  if (problems.length > 0) throw new LedgerInvariantError(`window ${w}: ${problems.map((p) => `${p.code} ${p.detail}`).join("; ")}`);
  const scheduler = new InputScheduler();
  scheduler.add(items);
  const out = scheduler.take(w, rooms.filter((r) => r.createdWindow < w).map((r) => r.roomId));
  const left = scheduler.pending();
  if (left.length > 0) throw new LedgerInvariantError(`window ${w}: ${left.length} inputs would carry over (room-window cap)`);
  return out;
}
