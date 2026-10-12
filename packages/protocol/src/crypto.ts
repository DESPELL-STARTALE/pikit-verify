import { hmac } from "@noble/hashes/hmac";
import { sha256 as nobleSha256 } from "@noble/hashes/sha2";
import { SimpleMerkleTree } from "@openzeppelin/merkle-tree";
import { concat, encodeAbiParameters, encodePacked, keccak256 as viemKeccak256, toBytes, toHex } from "viem";
import { canonicalJson } from "./canonical.js";

// ──────────────────────────────────────────────────────────────────────────
// 해시·약속의 정확한 바이트 (INTERFACES §8 Q4·Q5 결정, DECISIONS D40·D41)
//  - keccak256: viem(내부적으로 @noble/hashes) — 컨트랙트(Solidity keccak256)와 같은 값
//  - HMAC-SHA256: @noble/hashes — 순수 JS라 Node·브라우저에서 같은 값(엔진에 주입)
//  - Merkle: OpenZeppelin MerkleProof와 호환되는 정렬 쌍(sorted-pair) keccak256 트리 (@openzeppelin/merkle-tree SimpleMerkleTree)
// 모든 해시 값은 소문자 0x 문자열(Bytes32)로 주고받는다.
// ──────────────────────────────────────────────────────────────────────────

export type Hex32 = `0x${string}`;

export const ZERO_BYTES32: Hex32 = `0x${"00".repeat(32)}`;

/** keccak256(bytes) → 0x 소문자. 입력은 바이트 또는 0x hex(바이트로 해석). */
export function keccak256(data: Uint8Array | `0x${string}`): Hex32 {
  return viemKeccak256(data);
}

/** HMAC-SHA256(key, message) → 32바이트. 엔진의 `HmacSha256` 자리에 그대로 주입한다. */
export function hmacSha256(key: Uint8Array, message: Uint8Array): Uint8Array {
  return hmac(nobleSha256, key, message);
}

/** SHA-256(bytes) → 0x 소문자 (상태 해시). */
export function sha256Hex(data: Uint8Array): Hex32 {
  return toHex(nobleSha256(data));
}

/** 0x hex → 바이트 (짝수 길이, 대소문자 모두 허용). */
export function hexToBytes(hex: string): Uint8Array {
  if (!/^0x([0-9a-fA-F]{2})*$/.test(hex)) throw new Error(`hexToBytes: bad hex ${hex}`);
  return toBytes(hex as `0x${string}`);
}

export function bytesToHex(bytes: Uint8Array): Hex32 {
  return toHex(bytes);
}

// ── 시드 사슬 (설계 §4.2, 부록 B) ────────────────────────────────────────────

/** 에폭 길이 (블록). e(w) = 1 + floor((w − W0) / 200). */
export const EPOCH_BLOCKS = 200;

/** 윈도 w가 속한 에폭. W0 = IPikitFairness.genesisBlock(). w < W0는 에폭 0(시드 S_0 자체는 쓰지 않는다)이라 오류. */
export function epochOf(window: number, genesisBlock: number): number {
  if (!Number.isSafeInteger(window) || window < genesisBlock) throw new Error(`epochOf: window ${window} < genesis ${genesisBlock}`);
  return 1 + Math.floor((window - genesisBlock) / EPOCH_BLOCKS);
}

/** 에폭 e의 첫·마지막 윈도. */
export function epochWindows(epoch: number, genesisBlock: number): { first: number; last: number } {
  if (!Number.isSafeInteger(epoch) || epoch < 1) throw new Error(`epochWindows: epoch must be ≥ 1 (got ${epoch})`);
  const first = genesisBlock + (epoch - 1) * EPOCH_BLOCKS;
  return { first, last: first + EPOCH_BLOCKS - 1 };
}

/** 사슬 한 걸음 내려가기: S_{i−1} = keccak256(S_i). */
export function seedParent(seed: Hex32): Hex32 {
  return keccak256(seed);
}

/**
 * S_e가 알려진 S_k(k < e, 보통 체인의 lastRevealedSeed 또는 S_0)로 내려가는지 확인한다.
 * keccak^(e − k)(S_e) == S_k. 컨트랙트 `anchor`의 InvalidSeedChain 검사와 같다.
 */
export function seedChainLinks(seed: Hex32, epoch: number, knownSeed: Hex32, knownEpoch: number): boolean {
  if (epoch < knownEpoch) return false;
  let s = seed.toLowerCase() as Hex32;
  for (let i = epoch; i > knownEpoch; i--) s = seedParent(s);
  return s === knownSeed.toLowerCase();
}

/**
 * 운영자 쪽 시드 사슬: S_N(봉인 저장소의 맨 위 값)과 길이 N에서 S_e를 꺼낸다.
 * 매번 N − e번 해시하지 않도록 `checkpointEvery`마다 중간값을 들고 있다(시작 때 N번 한 번만 해시).
 * S_0 = root()는 출시 때 컨트랙트에 넣는 값이다.
 */
export class SeedChain {
  private readonly checkpoints = new Map<number, Hex32>();

  constructor(top: Hex32, readonly length: number, private readonly checkpointEvery = 1024) {
    if (!/^0x[0-9a-fA-F]{64}$/.test(top)) throw new Error("SeedChain: top must be 32 bytes hex");
    if (!Number.isSafeInteger(length) || length < 1) throw new Error("SeedChain: length must be ≥ 1");
    let s = top.toLowerCase() as Hex32;
    for (let i = length; i >= 0; i--) {
      if (i % checkpointEvery === 0 || i === length) this.checkpoints.set(i, s);
      if (i > 0) s = seedParent(s);
    }
  }

  /** S_0 (체인의 seedRoot). */
  root(): Hex32 {
    return this.checkpoints.get(0)!;
  }

  /** S_e (0 ≤ e ≤ N). */
  seedOf(epoch: number): Hex32 {
    if (!Number.isSafeInteger(epoch) || epoch < 0 || epoch > this.length) throw new Error(`SeedChain: epoch ${epoch} outside [0, ${this.length}]`);
    let from = Math.min(this.length, Math.ceil(epoch / this.checkpointEvery) * this.checkpointEvery);
    if (!this.checkpoints.has(from)) from = this.length;
    let s = this.checkpoints.get(from)!;
    for (let i = from; i > epoch; i--) s = seedParent(s);
    return s;
  }
}

// ── 입력 기록 해시 사슬 (Q4) ─────────────────────────────────────────────────

/** 사슬의 시작 머리 h_0 (첫 에폭 파일의 prevHead). */
export const INPUT_LOG_GENESIS_HEAD: Hex32 = ZERO_BYTES32;

/** keccak256(canonicalJSON(entry)). entry는 `InputLogEntry`(window, roomId, index, input) 모양. */
export function inputEntryHash(entry: unknown): Hex32 {
  return keccak256(new TextEncoder().encode(canonicalJson(entry)));
}

/** h_i = keccak256(h_{i−1} ‖ keccak256(canonicalJSON(input_i))). */
export function chainInputLog(prevHead: Hex32, entry: unknown): Hex32 {
  return keccak256(concat([prevHead, inputEntryHash(entry)]));
}

// ── Merkle 트리 (Q4: OpenZeppelin 호환 정렬 쌍 keccak256) ─────────────────────

/** 잎 목록의 루트. 잎이 없으면 0x00…(앵커의 "없음"). 잎 순서는 결과에 영향이 없다(정렬해서 만든다). */
export function merkleRoot(leaves: readonly Hex32[]): Hex32 {
  if (leaves.length === 0) return ZERO_BYTES32;
  return SimpleMerkleTree.of([...leaves]).root as Hex32;
}

/** 잎 하나의 증명 (OpenZeppelin `MerkleProof.verify(proof, root, leaf)`로 검증된다). */
export function merkleProof(leaves: readonly Hex32[], leaf: Hex32): Hex32[] {
  const tree = SimpleMerkleTree.of([...leaves]);
  return tree.getProof(leaf) as Hex32[];
}

export function verifyMerkleProof(root: Hex32, leaf: Hex32, proof: readonly Hex32[]): boolean {
  return SimpleMerkleTree.verify(root, leaf, [...proof]);
}

/** 방 상태·묶음 잎 = keccak256(abi.encode(uint256 id, bytes32 value)). */
export function idValueLeaf(id: bigint | number, value: Hex32): Hex32 {
  return keccak256(encodeAbiParameters([{ type: "uint256" }, { type: "bytes32" }], [BigInt(id), value]));
}

// ── 2,000블록 묶음 해시 (Q4) ─────────────────────────────────────────────────

export const BOARD_BATCH_BLOCKS = 2000;

/**
 * H_j = keccak256(abi.encodePacked(uint32 batchIndex, uint8[2000] kinds)).
 * 주의: Solidity의 abi.encodePacked는 배열 원소를 32바이트로 채운다 → 4 + 2,000 × 32바이트.
 * packed 인코딩에는 배열 길이가 들어가지 않으므로 같은 공식이 카탈로그의 batchBlocks(출시 값 2,000)마다 그대로 쓰인다.
 */
export function boardBatchHash(batchIndex: number, kinds: readonly number[]): Hex32 {
  if (kinds.length === 0) throw new Error("boardBatchHash: empty batch");
  return keccak256(encodePacked(["uint32", "uint8[]"], [batchIndex, [...kinds]]));
}

/**
 * 묶음 사전 약속 (PikitFairness.commitBatches(first, hashes), DECISIONS D55·D95). 컨트랙트의 묶음 j = 블록 [W0 + 2000j, W0 + 2000j + 1999].
 * 앵커는 약속된 묶음 안으로만 나아가므로 settler는 묶음이 시작되기 전에(실제로는 최대 2시간 앞서 여러 개를 한 tx로) 이 값을 올린다.
 * 값은 저장되지 않고 BatchCommitted 로그에만 있다. 줄 내용(시드·블록 해시로 뽑음)은 미리 알 수 없으므로 사전 약속은
 * "그 구간에 쓸 방별 규칙"만 묶는다:
 *   hash = keccak256(abi.encode(keccak256("PIKIT/batch-pre/v1"), uint256 j, bytes32 roomsRulesRoot))
 *   roomsRulesRoot = Merkle{ keccak256(abi.encode(uint256 roomId, bytes32 onchainRulesHash)) } (묶음 첫 블록에 활성인 방별 규칙,
 *   roomsRulesAt(schedule, batchStartBlock(j)) → roomsRulesRoot())
 * 끝난 묶음의 실제 줄은 방마다 H_j(boardBatchHash)로 앵커의 boardBatchRoot에 실린다.
 */
export function batchPreCommitment(batchIndex: number, roomsRulesRootHash: Hex32): Hex32 {
  return keccak256(encodeAbiParameters(
    [{ type: "bytes32" }, { type: "uint256" }, { type: "bytes32" }],
    [viemKeccak256(toBytes("PIKIT/batch-pre/v1")), BigInt(batchIndex), roomsRulesRootHash],
  ));
}

/** 방별 체인 rulesHash의 Merkle 루트 (batchPreCommitment 재료). */
export function roomsRulesRoot(rooms: readonly { roomId: number; rulesHash: Hex32 }[]): Hex32 {
  return merkleRoot(rooms.map((r) => idValueLeaf(r.roomId, r.rulesHash)));
}

// ── 규칙 해시 (Q5) ───────────────────────────────────────────────────────────

/** 체인 rulesHash = keccak256(catalogHash ‖ engineVersionHash). catalogHash = canonicalHash(catalog). */
export function onchainRulesHash(catalogHash: Hex32, engineVersionHash: Hex32): Hex32 {
  return keccak256(concat([catalogHash, engineVersionHash]));
}
