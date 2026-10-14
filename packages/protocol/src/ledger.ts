import { concat, encodeAbiParameters, hashTypedData, keccak256 as viemKeccak256, recoverTypedDataAddress, toBytes, type TypedDataDomain } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { z } from "zod";
import { Address, Bytes32, BlockNumber, DecimalString, U32 } from "./primitives.js";
import { EPOCH_BLOCKS, merkleProof, merkleRoot, verifyMerkleProof, type Hex32 } from "./crypto.js";

// ──────────────────────────────────────────────────────────────────────────
// 명세 20 장부 (개정 7, PikitLedger — 계획 docs/plans/spec20-implementation.md §2.3·§2.7·§2.10, D192·D196)
//
// 이 파일은 **ledgerHash 안**이다(A3 `emit-ledger-info.mjs`가 이 파일과 값으로 가져오는 protocol 파일 닫힘을 해시한다).
// 고치면 ledgerVersionHash가 바뀌어 새 컨트랙트(새 세계)가 필요하다 — 엔진 해시 파일과 같은 무게.
// 그래서 여기에는 서명 형식·다이제스트·잎·루트·상수만 두고, 파일 zod 모양은 `ledger-files.ts`(해시 밖)에 둔다.
// 엔진 해시 파일(catalog·crypto·eip712·input-log·timers·canonical·primitives)은 고치지 않는다 — 가져다 쓰기만 한다.
//
// JSON 표기(이 저장소 관례): 주소·해시는 소문자 0x, uint64 이상의 **금액·seq·기한**은 10진 문자열(DecimalString),
// 윈도·방·날 번호는 JSON 숫자(BlockNumber·U32). 해시·서명할 때 bigint로 바꾼다.
// ──────────────────────────────────────────────────────────────────────────

// ── 상수 (계획 §4.2 A1) ────────────────────────────────────────────────────

/** 루트 주기 기본값: 60에폭(= 12,000블록) 끝마다 루트 하나. settler 설정 `ROOT_EVERY_EPOCHS`의 기본값 — 컨트랙트는 주기를 강제하지 않는다. */
export const ROOT_EVERY_EPOCHS_DEFAULT = 60;
/** 루트가 경계 윈도 + 이만큼 블록 안에 체인에 없으면 경보 `root-late`, api 신선도 문 계산에도 쓴다. */
export const ROOT_GRACE_BLOCKS = 3_000;
/** 명단 w는 제안(Proposed) 머리가 w − LIST_CLOSE_LEAD 이상일 때 닫는다. */
export const LIST_CLOSE_LEAD = 2;
/** 웹 기본 targetWindow = 마지막으로 받은 명단 창 + 이만큼 (A5 실측으로 조정). */
export const TARGET_LEAD_DEFAULT = 3;
/** api는 closedThrough < targetWindow ≤ closedThrough + TARGET_MAX_AHEAD 인 의향서만 받는다. */
export const TARGET_MAX_AHEAD = 20;
/** GRANT 1건 상한 (밀리크레딧) = 2,400,000 cr × 1,000 — × 2 날 홀더 최대(D185). */
export const GRANT_MAX_MILLI = 2_400_000_000n;
/** LedgerSession 기한 상한 (api가 강제): 7일. */
export const LEDGER_SESSION_MAX_SECONDS = 7 * 24 * 3600;
/** PikitLedger.ANNOUNCER_DELAY: setAnnouncer는 block.number + 20 창부터 효력. */
export const ANNOUNCER_DELAY = 20;
/** 의향서 한 장의 곡괭이(tiers)·취소 항목(items) 수 상한. */
export const MAX_INTENT_ITEMS = 10;
/** 하루 = 86,400초 (GRANT day = floor(블록 timestamp ÷ 86,400), UTC). */
export const SECONDS_PER_DAY = 86_400;

/** 장부 화폐. 무료 크레딧 = 0 (CHOG 모드에서 1을 더한다). */
export const LEDGER_CURRENCY_FREE = 0;

/** 명단 항목 종류 (entryHash의 uint8 kind). */
export const LEDGER_ENTRY_KIND = { BUY: 0, CANCEL: 1, GRANT: 2 } as const;
export type LedgerEntryKind = keyof typeof LEDGER_ENTRY_KIND;
export const LedgerEntryKind = z.enum(["BUY", "CANCEL", "GRANT"]);

/** GRANT reason (Grant ref의 uint8 reason). */
export const GRANT_REASON = { DAILY: 1 } as const;
export type GrantReason = keyof typeof GRANT_REASON;
export const GrantReason = z.enum(["DAILY"]);

/** 지급 잎 kind (uint8) — 엔진 EnginePayout.kind. */
export const PAYOUT_KIND_CODE = { REWARD: 0, REFUND: 1 } as const;
export const LedgerPayoutKind = z.enum(["REWARD", "REFUND"]);
export type LedgerPayoutKind = z.infer<typeof LedgerPayoutKind>;

/** 지급 잎 cause (uint8) — 엔진 EnginePayout.cause, 이 순서가 코드다. */
export const PAYOUT_CAUSE_CODE = { END: 0, ABNORMAL_END: 1, CANCEL: 2, OVERFLOW: 3, QUEUE_REFUND: 4 } as const;
export const LedgerPayoutCause = z.enum(["END", "ABNORMAL_END", "CANCEL", "OVERFLOW", "QUEUE_REFUND"]);
export type LedgerPayoutCause = z.infer<typeof LedgerPayoutCause>;

// ── 도메인과 EIP-712 타입 (§2.3) ───────────────────────────────────────────

export const LEDGER_DOMAIN_NAME = "PIKIT-LEDGER";
export const LEDGER_DOMAIN_VERSION = "1";

/** 서명 도메인 { name: "PIKIT-LEDGER", version: "1", chainId, verifyingContract: PikitLedger }. 옛 `PIKIT`(상점) 서명은 여기서 무효. */
export function ledgerDomain(ledger: string, chainId: number): TypedDataDomain {
  if (!Number.isSafeInteger(chainId) || chainId <= 0) throw new Error(`ledgerDomain: bad chainId ${chainId}`);
  return { name: LEDGER_DOMAIN_NAME, version: LEDGER_DOMAIN_VERSION, chainId, verifyingContract: Address.parse(ledger) as `0x${string}` };
}

export const BUY_INTENT_TYPES = {
  BuyIntent: [
    { name: "wallet", type: "address" },
    { name: "sessionKey", type: "address" },
    { name: "roomId", type: "uint32" },
    { name: "rulesHash", type: "bytes32" },
    { name: "tiers", type: "uint8[]" },
    { name: "seq", type: "uint64" },
    { name: "targetWindow", type: "uint64" },
  ],
} as const;

export const CANCEL_QUEUE_TYPES = {
  CancelQueue: [
    { name: "wallet", type: "address" },
    { name: "sessionKey", type: "address" },
    { name: "roomId", type: "uint32" },
    { name: "items", type: "uint256[]" },
    { name: "seq", type: "uint64" },
    { name: "targetWindow", type: "uint64" },
  ],
} as const;

export const LEDGER_SESSION_TYPES = {
  LedgerSession: [
    { name: "wallet", type: "address" },
    { name: "sessionKey", type: "address" },
    { name: "expiresAt", type: "uint64" },
  ],
} as const;

export const WINDOW_LIST_TYPES = {
  WindowList: [
    { name: "window", type: "uint64" },
    { name: "entriesHash", type: "bytes32" },
    { name: "count", type: "uint32" },
  ],
} as const;

/** EIP-712 encodeType 문자열 (Solidity 쪽 TYPEHASH = keccak256(이 문자열)). */
export const BUY_INTENT_TYPE_STRING = "BuyIntent(address wallet,address sessionKey,uint32 roomId,bytes32 rulesHash,uint8[] tiers,uint64 seq,uint64 targetWindow)";
export const CANCEL_QUEUE_TYPE_STRING = "CancelQueue(address wallet,address sessionKey,uint32 roomId,uint256[] items,uint64 seq,uint64 targetWindow)";
export const LEDGER_SESSION_TYPE_STRING = "LedgerSession(address wallet,address sessionKey,uint64 expiresAt)";
export const WINDOW_LIST_TYPE_STRING = "WindowList(uint64 window,bytes32 entriesHash,uint32 count)";

const typeHash = (s: string): Hex32 => viemKeccak256(toBytes(s));
export const BUY_INTENT_TYPEHASH = typeHash(BUY_INTENT_TYPE_STRING);
export const CANCEL_QUEUE_TYPEHASH = typeHash(CANCEL_QUEUE_TYPE_STRING);
export const LEDGER_SESSION_TYPEHASH = typeHash(LEDGER_SESSION_TYPE_STRING);
export const WINDOW_LIST_TYPEHASH = typeHash(WINDOW_LIST_TYPE_STRING);

// ── 메시지 모양 (zod) ──────────────────────────────────────────────────────

const U64_MAX = (1n << 64n) - 1n;
const U128_MAX = (1n << 128n) - 1n;
const DecU64 = DecimalString.refine((s) => BigInt(s) <= U64_MAX, { message: "uint64 overflow" });
const DecU128 = DecimalString.refine((s) => BigInt(s) <= U128_MAX, { message: "uint128 overflow" });
const Tier = z.number().int().min(0).max(31);

/** 65바이트 secp256k1 서명 (0x + 130 hex, 소문자). 세션 키·ANNOUNCE 키 서명. */
export const LedgerSignature = z.string().regex(/^0x[0-9a-f]{130}$/, "65-byte signature (lowercase hex)");

/**
 * 구매 의향서 (세션 키 서명). 다이제스트 = 의향서 번호 = 엔진 연결 txHash = 명단 항목 ref.
 * seq: 지갑마다 lastSeq보다 커야 소비된다(≥ 1). 늦으면 **같은 seq**에 새 targetWindow로 다시 서명한다(둘 중 하나만 들어간다).
 * targetWindow = 이 의향서가 들어가야 할 명단 창(그 창이 아니면 장부가 거절).
 */
export const BuyIntentMessage = z.object({
  wallet: Address,
  sessionKey: Address,
  roomId: U32,
  rulesHash: Bytes32,
  tiers: z.array(Tier).min(1).max(MAX_INTENT_ITEMS),
  seq: DecU64,
  targetWindow: BlockNumber,
}).strict();
export type BuyIntentMessage = z.infer<typeof BuyIntentMessage>;

/** 대기열 취소 의향서 (세션 키 서명). items[i] = itemIdOf(purchaseId, itemIndex) = (purchaseId << 8) | itemIndex (10진). */
export const CancelQueueMessage = z.object({
  wallet: Address,
  sessionKey: Address,
  roomId: U32,
  items: z.array(DecimalString).min(1).max(MAX_INTENT_ITEMS),
  seq: DecU64,
  targetWindow: BlockNumber,
}).strict();
export type CancelQueueMessage = z.infer<typeof CancelQueueMessage>;

/** 세션 키 허가 (지갑 서명, 체인 등록 없음, 지출 상한 없음). expiresAt = unix 초(블록 timestamp와 비교). */
export const LedgerSessionMessage = z.object({
  wallet: Address,
  sessionKey: Address,
  expiresAt: DecU64,
}).strict();
export type LedgerSessionMessage = z.infer<typeof LedgerSessionMessage>;

/** 윈도 w 명단 (ANNOUNCE 키 서명). 빈 명단(count 0)은 서명하지 않는다. */
export const WindowListMessage = z.object({
  window: BlockNumber,
  entriesHash: Bytes32,
  count: U32,
}).strict();
export type WindowListMessage = z.infer<typeof WindowListMessage>;

/** 오늘 받기 지급 (명단의 ANNOUNCE 서명이 승인). day = 1970-01-01부터 날 수(UTC). */
export const GrantMessage = z.object({
  wallet: Address,
  amountMilli: DecU128,
  day: U32,
  reason: GrantReason,
}).strict();
export type GrantMessage = z.infer<typeof GrantMessage>;

// ── typed data · 다이제스트 · 서명 · 복구 ──────────────────────────────────

const addr = (a: string) => a as `0x${string}`;

export function buyIntentTypedData(domain: TypedDataDomain, m: BuyIntentMessage) {
  const p = BuyIntentMessage.parse(m);
  return {
    domain, types: BUY_INTENT_TYPES, primaryType: "BuyIntent" as const,
    message: {
      wallet: addr(p.wallet), sessionKey: addr(p.sessionKey), roomId: p.roomId, rulesHash: addr(p.rulesHash),
      tiers: p.tiers, seq: BigInt(p.seq), targetWindow: BigInt(p.targetWindow),
    },
  };
}

export function cancelQueueTypedData(domain: TypedDataDomain, m: CancelQueueMessage) {
  const p = CancelQueueMessage.parse(m);
  return {
    domain, types: CANCEL_QUEUE_TYPES, primaryType: "CancelQueue" as const,
    message: {
      wallet: addr(p.wallet), sessionKey: addr(p.sessionKey), roomId: p.roomId, items: p.items.map((s) => BigInt(s)),
      seq: BigInt(p.seq), targetWindow: BigInt(p.targetWindow),
    },
  };
}

export function ledgerSessionTypedData(domain: TypedDataDomain, m: LedgerSessionMessage) {
  const p = LedgerSessionMessage.parse(m);
  return {
    domain, types: LEDGER_SESSION_TYPES, primaryType: "LedgerSession" as const,
    message: { wallet: addr(p.wallet), sessionKey: addr(p.sessionKey), expiresAt: BigInt(p.expiresAt) },
  };
}

export function windowListTypedData(domain: TypedDataDomain, m: WindowListMessage) {
  const p = WindowListMessage.parse(m);
  return {
    domain, types: WINDOW_LIST_TYPES, primaryType: "WindowList" as const,
    message: { window: BigInt(p.window), entriesHash: addr(p.entriesHash), count: p.count },
  };
}

export type LedgerTypedData =
  | ReturnType<typeof buyIntentTypedData> | ReturnType<typeof cancelQueueTypedData>
  | ReturnType<typeof ledgerSessionTypedData> | ReturnType<typeof windowListTypedData>;

/** typed data에 서명하는 함수 (지갑 eth_signTypedData_v4 · 로컬 키 어댑터가 같은 모양). */
export type LedgerTypedDataSigner = (typedData: LedgerTypedData) => Promise<`0x${string}`>;

/** 개인키(세션 키·ANNOUNCE 키·시험)로 typed data에 서명하는 함수. */
export function ledgerPrivateKeySigner(privateKey: `0x${string}`): { address: string; sign: LedgerTypedDataSigner } {
  const account = privateKeyToAccount(privateKey);
  return {
    address: account.address.toLowerCase(),
    sign: (typed) => account.signTypedData(typed as Parameters<typeof account.signTypedData>[0]),
  };
}

export function hashBuyIntent(domain: TypedDataDomain, m: BuyIntentMessage): Hex32 {
  return hashTypedData(buyIntentTypedData(domain, m));
}
export function hashCancelQueue(domain: TypedDataDomain, m: CancelQueueMessage): Hex32 {
  return hashTypedData(cancelQueueTypedData(domain, m));
}
export function hashLedgerSession(domain: TypedDataDomain, m: LedgerSessionMessage): Hex32 {
  return hashTypedData(ledgerSessionTypedData(domain, m));
}
export function hashWindowList(domain: TypedDataDomain, m: WindowListMessage): Hex32 {
  return hashTypedData(windowListTypedData(domain, m));
}

export function signBuyIntent(sign: LedgerTypedDataSigner, domain: TypedDataDomain, m: BuyIntentMessage): Promise<`0x${string}`> {
  return sign(buyIntentTypedData(domain, m));
}
export function signCancelQueue(sign: LedgerTypedDataSigner, domain: TypedDataDomain, m: CancelQueueMessage): Promise<`0x${string}`> {
  return sign(cancelQueueTypedData(domain, m));
}
export function signLedgerSession(sign: LedgerTypedDataSigner, domain: TypedDataDomain, m: LedgerSessionMessage): Promise<`0x${string}`> {
  return sign(ledgerSessionTypedData(domain, m));
}
export function signWindowList(sign: LedgerTypedDataSigner, domain: TypedDataDomain, m: WindowListMessage): Promise<`0x${string}`> {
  return sign(windowListTypedData(domain, m));
}

const lower = (a: string) => a.toLowerCase();

/** 서명자 주소(소문자). 잘못된 서명 바이트면 오류를 던진다 — 장부 규칙은 오류를 "서명 틀림"으로 다룬다. */
export async function recoverBuyIntentSigner(domain: TypedDataDomain, m: BuyIntentMessage, signature: `0x${string}`): Promise<string> {
  return lower(await recoverTypedDataAddress({ ...buyIntentTypedData(domain, m), signature }));
}
export async function recoverCancelQueueSigner(domain: TypedDataDomain, m: CancelQueueMessage, signature: `0x${string}`): Promise<string> {
  return lower(await recoverTypedDataAddress({ ...cancelQueueTypedData(domain, m), signature }));
}
/** EOA 지갑의 세션 허가 서명 복구. 스마트 지갑(ERC-1271/6492)은 RPC `verifyTypedData`로 확인하고 그 블록을 erc1271Block으로 남긴다. */
export async function recoverLedgerSessionSigner(domain: TypedDataDomain, m: LedgerSessionMessage, signature: `0x${string}`): Promise<string> {
  return lower(await recoverTypedDataAddress({ ...ledgerSessionTypedData(domain, m), signature }));
}
export async function recoverWindowListSigner(domain: TypedDataDomain, m: WindowListMessage, signature: `0x${string}`): Promise<string> {
  return lower(await recoverTypedDataAddress({ ...windowListTypedData(domain, m), signature }));
}

// ── 명단 항목 · entriesHash ────────────────────────────────────────────────

/** Grant ref = keccak256(abi.encode(string "PIKIT/grant/v1", address wallet, uint128 amountMilli, uint32 day, uint8 reason)). */
export const GRANT_REF_TAG = "PIKIT/grant/v1";

export function grantRef(g: GrantMessage): Hex32 {
  const p = GrantMessage.parse(g);
  return viemKeccak256(encodeAbiParameters(
    [{ type: "string" }, { type: "address" }, { type: "uint128" }, { type: "uint32" }, { type: "uint8" }],
    [GRANT_REF_TAG, addr(p.wallet), BigInt(p.amountMilli), p.day, GRANT_REASON[p.reason]],
  ));
}

/**
 * 항목 해시 = keccak256(abi.encode(uint8 kind, uint32 roomId, bytes32 ref)).
 * BUY·CANCEL: roomId = 의향서의 방, ref = 의향서 다이제스트. GRANT: roomId = 0(방 없음), ref = grantRef.
 */
export function entryHash(kind: LedgerEntryKind, roomId: number, ref: Hex32): Hex32 {
  U32.parse(roomId);
  Bytes32.parse(ref);
  if (kind === "GRANT" && roomId !== 0) throw new Error("entryHash: GRANT roomId must be 0");
  return viemKeccak256(encodeAbiParameters(
    [{ type: "uint8" }, { type: "uint32" }, { type: "bytes32" }],
    [LEDGER_ENTRY_KIND[kind], roomId, ref],
  ));
}

/** entriesHash = keccak256(entryHash_0 ‖ … ‖ entryHash_{n−1}) (abi.encodePacked(bytes32[])). 빈 목록 = keccak256(0x). */
export function entriesHash(entryHashes: readonly Hex32[]): Hex32 {
  return viemKeccak256(entryHashes.length === 0 ? "0x" : concat([...entryHashes]));
}

// ── 장부 잎 · 지급 잎 · 루트 (§2.10) ────────────────────────────────────────

/**
 * 지갑 잎 (루트 경계의 장부 상태 한 줄). 잎 파일·`ledgerRoot` 재료.
 * withdrawTotalMilli는 CHOG 대비 칸(무료 모드에서 늘 "0"), currency는 늘 0.
 */
export const LedgerLeaf = z.object({
  wallet: Address,
  currency: z.literal(LEDGER_CURRENCY_FREE),
  balanceMilli: DecU128,
  openStakeMilli: DecU128,
  withdrawTotalMilli: DecU128,
  lastSeq: DecU64,
  lastGrantDay: U32,
}).strict();
export type LedgerLeaf = z.infer<typeof LedgerLeaf>;

/** OZ StandardMerkleTree 방식 이중 해시: keccak256(bytes.concat(keccak256(abi.encode(...)))). */
function doubleHash(encoded: `0x${string}`): Hex32 {
  return viemKeccak256(viemKeccak256(encoded));
}

/** 잎 = keccak256(bytes.concat(keccak256(abi.encode(address wallet, uint8 currency, uint128 balanceMilli, uint128 openStakeMilli, uint128 withdrawTotalMilli, uint64 lastSeq, uint32 lastGrantDay)))). */
export function ledgerLeafHash(leaf: LedgerLeaf): Hex32 {
  const p = LedgerLeaf.parse(leaf);
  return doubleHash(encodeAbiParameters(
    [{ type: "address" }, { type: "uint8" }, { type: "uint128" }, { type: "uint128" }, { type: "uint128" }, { type: "uint64" }, { type: "uint32" }],
    [addr(p.wallet), p.currency, BigInt(p.balanceMilli), BigInt(p.openStakeMilli), BigInt(p.withdrawTotalMilli), BigInt(p.lastSeq), p.lastGrantDay],
  ));
}

/** ledgerRoot = merkleRoot(잎 해시) — OZ 정렬 쌍(`MerkleProof.verify` 호환), 빈 장부 = 0x00…. 잎 순서는 결과에 영향이 없다. */
export function ledgerRoot(leaves: readonly LedgerLeaf[]): Hex32 {
  return merkleRoot(leaves.map(ledgerLeafHash));
}

/** 지갑 잎 하나의 증명 (CHOG 청구·`verify proof`용). */
export function ledgerLeafProof(leaves: readonly LedgerLeaf[], leaf: LedgerLeaf): Hex32[] {
  return merkleProof(leaves.map(ledgerLeafHash), ledgerLeafHash(leaf));
}

export function verifyLedgerLeafProof(root: Hex32, leaf: LedgerLeaf, proof: readonly Hex32[]): boolean {
  return verifyMerkleProof(root, ledgerLeafHash(leaf), proof);
}

/** supplyMilli = Σ(balance + openStake + withdrawTotal) (무료 모드에서 withdrawTotal = 0 → Σ(balance + openStake)). */
export function ledgerSupplyMilli(leaves: readonly LedgerLeaf[]): bigint {
  let s = 0n;
  for (const l of leaves) s += BigInt(l.balanceMilli) + BigInt(l.openStakeMilli) + BigInt(l.withdrawTotalMilli);
  return s;
}

/** 지급 잎 (엔진 정산 1건 = 플레이어 곡괭이 1개). 루트 범위 안에서 끝난 곡괭이 전부가 `payoutsRoot`에 들어간다. */
export const PayoutLeaf = z.object({
  purchaseId: DecimalString,
  itemIndex: z.number().int().min(0).max(9),
  owner: Address,
  kind: LedgerPayoutKind,
  cause: LedgerPayoutCause,
  priceMilli: DecU128,
  payoutMilli: DecU128,
  overMilli: DecU128,
  window: BlockNumber,
}).strict();
export type PayoutLeaf = z.infer<typeof PayoutLeaf>;

/** 지급 잎 = 이중 해시 (uint256 purchaseId, uint8 itemIndex, address owner, uint8 kind, uint8 cause, uint128 priceMilli, uint128 payoutMilli, uint128 overMilli, uint64 window). */
export function payoutLeafHash(leaf: PayoutLeaf): Hex32 {
  const p = PayoutLeaf.parse(leaf);
  return doubleHash(encodeAbiParameters(
    [{ type: "uint256" }, { type: "uint8" }, { type: "address" }, { type: "uint8" }, { type: "uint8" }, { type: "uint128" }, { type: "uint128" }, { type: "uint128" }, { type: "uint64" }],
    [BigInt(p.purchaseId), p.itemIndex, addr(p.owner), PAYOUT_KIND_CODE[p.kind], PAYOUT_CAUSE_CODE[p.cause],
      BigInt(p.priceMilli), BigInt(p.payoutMilli), BigInt(p.overMilli), BigInt(p.window)],
  ));
}

/** payoutsRoot = merkleRoot(지급 잎 해시), 없으면 0x00…. */
export function payoutsRoot(leaves: readonly PayoutLeaf[]): Hex32 {
  return merkleRoot(leaves.map(payoutLeafHash));
}

// ── 공개 파일 목록 해시 dataHash (§2.10) ──────────────────────────────────────

/** 루트 k가 덮는 공개 파일 하나: 경로(에폭 디렉터리 기준 상대 경로, `/` 구분)와 파일 바이트의 sha256. */
export interface DataFileDigest {
  path: string;
  sha256: Hex32;
}

/**
 * dataHash = keccak256( keccak256(utf8(path_0)) ‖ sha256_0 ‖ keccak256(utf8(path_1)) ‖ sha256_1 ‖ … ) — 주어진 순서 그대로.
 * 순서는 `rootDataPaths`가 정한다. 빈 목록 = keccak256(0x).
 */
export function dataHash(files: readonly DataFileDigest[]): Hex32 {
  const parts: `0x${string}`[] = [];
  for (const f of files) {
    if (f.path.length === 0 || f.path.startsWith("/") || f.path.includes("\\")) throw new Error(`dataHash: bad path ${JSON.stringify(f.path)}`);
    Bytes32.parse(f.sha256);
    parts.push(viemKeccak256(toBytes(f.path)), f.sha256);
  }
  return viemKeccak256(parts.length === 0 ? "0x" : concat(parts));
}

/**
 * 루트 k(에폭 fromEpoch..toEpoch를 덮음)의 dataHash 경로 순서:
 *   에폭 e = fromEpoch..toEpoch 오름차순으로 `<e>.json`, `ledger/<e>.json` (에폭마다 둘씩 번갈아),
 *   그다음 `snapshots/<toEpoch>.json`, 마지막 `ledger/leaves/<k>.json`.
 * fromEpoch = 직전 루트의 epoch + 1 (첫 루트는 1). k = 컨트랙트 루트 번호(rootCount 순번, 0부터).
 */
export function rootDataPaths(fromEpoch: number, toEpoch: number, rootIndex: number): string[] {
  if (!Number.isSafeInteger(fromEpoch) || fromEpoch < 1 || !Number.isSafeInteger(toEpoch) || toEpoch < fromEpoch) {
    throw new Error(`rootDataPaths: bad epoch range ${fromEpoch}..${toEpoch}`);
  }
  if (!Number.isSafeInteger(rootIndex) || rootIndex < 0) throw new Error(`rootDataPaths: bad root index ${rootIndex}`);
  const out: string[] = [];
  for (let e = fromEpoch; e <= toEpoch; e++) out.push(`${e}.json`, `ledger/${e}.json`);
  out.push(`snapshots/${toEpoch}.json`, `ledger/leaves/${rootIndex}.json`);
  return out;
}

// ── 시간 · 경계 ────────────────────────────────────────────────────────────

/** 에폭 e의 마지막 윈도 = genesisBlock + e·200 − 1 (PikitLedger.postRoot의 throughWindow 검사와 같다). */
export function rootThroughWindow(epoch: number, genesisBlock: number): number {
  if (!Number.isSafeInteger(epoch) || epoch < 1) throw new Error(`rootThroughWindow: epoch must be ≥ 1 (got ${epoch})`);
  return genesisBlock + epoch * EPOCH_BLOCKS - 1;
}

/** 정기 루트 경계 에폭인가 (epoch % every == 0). 종료(drain) 루트는 아무 에폭 끝이어도 된다 — 컨트랙트는 주기를 보지 않는다. */
export function isRootBoundaryEpoch(epoch: number, everyEpochs: number = ROOT_EVERY_EPOCHS_DEFAULT): boolean {
  if (!Number.isSafeInteger(everyEpochs) || everyEpochs < 1) throw new Error(`isRootBoundaryEpoch: bad period ${everyEpochs}`);
  return Number.isSafeInteger(epoch) && epoch >= 1 && epoch % everyEpochs === 0;
}

/** UTC 날 번호 = floor(unix 초 ÷ 86,400) (GRANT day, lastGrantDay). */
export function utcDayOf(unixSeconds: number | bigint): number {
  const s = BigInt(unixSeconds);
  if (s < 0n) throw new Error("utcDayOf: negative timestamp");
  return Number(s / BigInt(SECONDS_PER_DAY));
}
