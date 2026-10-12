import { serializeRoom, type CompletedBatch, type RoomState } from "@pikit/engine";
import { boardBatchHash, idValueLeaf, merkleRoot, sha256Hex, type Hex32 } from "@pikit/protocol";

// ──────────────────────────────────────────────────────────────────────────
// 앵커 루트 계산 — 게임 서버·settler(만드는 쪽)와 검증기·감시 봇(확인하는 쪽)이 같은 함수를 쓴다 (D40)
//  - roomsStateRoot  = Merkle{ keccak256(abi.encode(uint256 roomId, bytes32 SHA-256(serializeRoom))) … } (방 잎만)
//  - boardBatchRoot  = Merkle{ keccak256(abi.encode(uint256 roomId, bytes32 H_j)) } (직전 앵커 뒤에 끝난 묶음들, 없으면 0)
// 개정 3: 잔액은 체인(개정 5: PikitShop)에 있다 — 공유 장부 잎·부채 루트는 없다.
// ──────────────────────────────────────────────────────────────────────────

// 윈도 난수 lazyWindowRng는 엔진에 있다(packages/engine/src/window-rng.ts — engineVersionHash가 덮는다, D161). 쓰는 쪽은 @pikit/engine에서 가져온다.

export interface StateHashes {
  rooms: { roomId: number; stateHash: Hex32 }[];
}

/** 방마다 상태 해시 = SHA-256(serializeRoom). 방 순서는 입력 순서(세계는 roomId 오름차순). */
export function worldStateHashes(world: { rooms: readonly { roomId: number; state: RoomState }[] }): StateHashes {
  return { rooms: world.rooms.map((r) => ({ roomId: r.roomId, stateHash: sha256Hex(serializeRoom(r.state)) })) };
}

/** 앵커 roomsStateRoot = Merkle{ idValueLeaf(roomId, stateHash) } (방 잎만). */
export function roomsStateRoot(h: StateHashes): Hex32 {
  return merkleRoot(h.rooms.map((r) => idValueLeaf(r.roomId, r.stateHash)));
}

export interface CommittedBatch extends CompletedBatch {
  roomId: number;
  window: number;   // 묶음이 끝난 윈도
  hash: Hex32;      // H_j
}

export function commitBatch(roomId: number, window: number, b: CompletedBatch): CommittedBatch {
  return { ...b, roomId, window, hash: boardBatchHash(b.batchIndex, b.kinds) };
}

export function boardBatchRoot(batches: readonly CommittedBatch[]): Hex32 {
  return merkleRoot(batches.map((b) => idValueLeaf(b.roomId, b.hash)));
}
