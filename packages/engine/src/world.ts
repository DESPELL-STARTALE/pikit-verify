import type { Catalog, EngineInput } from "@pikit/protocol";
import { runWindow, type WindowResult } from "./room.js";
import type { RngFactory } from "./rng.js";
import type { RoomState } from "./types.js";

// ──────────────────────────────────────────────────────────────────────────
// 세계(World) = 방 여러 개 (D37). 윈도 w의 처리 순서는 모든 서버·검증기가 같다: 방들을 roomId 오름차순으로 runWindow.
// 개정 3: 잔액은 체인(PikitVault)에 있다. 공유 장부·바우처 입력은 없고, 방마다 곡괭이별 정산 값(WindowResult.payouts)만 낸다.
// ──────────────────────────────────────────────────────────────────────────

export interface WorldRoom {
  roomId: number;
  catalog: Catalog;
  state: RoomState;
}

export interface World {
  rooms: WorldRoom[];   // roomId 오름차순 (addRoom이 지킨다)
}

export interface WorldWindowResult {
  window: number;
  rooms: { roomId: number; result: WindowResult }[];
}

export function addRoom(world: World, room: WorldRoom): void {
  if (world.rooms.some((r) => r.roomId === room.roomId)) throw new Error(`addRoom: room ${room.roomId} exists`);
  if (room.state.roomId !== room.roomId) throw new Error("addRoom: state.roomId mismatch");
  world.rooms.push(room);
  world.rooms.sort((a, b) => a.roomId - b.roomId);
}

/**
 * 윈도 w를 세계 전체에 적용한다. 방이 그 윈도 이후에 만들어졌으면(state.window ≥ w) 건너뛴다.
 * rngFor(roomId) = 그 방의 윈도 w 스트림 팩토리(K(ρ, w)).
 */
export function runWorldWindow(
  world: World, window: number, roomInputs: ReadonlyMap<number, readonly EngineInput[]>, rngFor: (roomId: number) => RngFactory,
): WorldWindowResult {
  for (const roomId of roomInputs.keys()) {
    if (!world.rooms.some((r) => r.roomId === roomId)) throw new Error(`runWorldWindow: inputs for unknown room ${roomId}`);
  }
  const rooms: WorldWindowResult["rooms"] = [];
  for (const r of world.rooms) {
    if (r.state.window >= window) {
      if ((roomInputs.get(r.roomId) ?? []).length > 0) throw new Error(`runWorldWindow: room ${r.roomId} already past window ${window}`);
      continue;
    }
    rooms.push({ roomId: r.roomId, result: runWindow(r.state, r.catalog, window, roomInputs.get(r.roomId) ?? [], rngFor(r.roomId)) });
  }
  return { window, rooms };
}
