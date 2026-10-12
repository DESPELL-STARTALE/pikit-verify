import { hashTypedData, recoverTypedDataAddress, type TypedDataDomain } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { z } from "zod";
import { Address, Bytes32, DecimalString } from "./primitives.js";

// ──────────────────────────────────────────────────────────────────────────
// EIP-712 서명 형식 (개정 3, DECISIONS D78·D79). 모두 같은 도메인 PIKIT(상점 컨트랙트)이다.
//  - SessionGrant (지갑 서명, 로그인 세션마다 1번, 가스 없음): 세션 키를 체인에 등록할 때 쓴다(registerSessionKey).
//  - CreditIntent / CancelIntent (세션 키 서명): 서버 relayer가 buyWithCredits / cancelQueued로 대신 제출한다.
//    relayer는 필드를 바꿀 수 없다(바꾸면 서명이 틀림). nonce는 지갑별 비순차(비트맵, 두 의향서가 함께 씀), deadline = 블록 번호.
// 서명 = 65바이트 secp256k1 ECDSA(r ‖ s ‖ v). 지갑·viem·Solidity ECDSA.recover가 같은 다이제스트를 쓴다.
// 큰 정수는 JSON에서 10진 문자열(DecimalString), 서명·해시할 때 bigint로 바꾼다.
// 옛 Receipt·Confirm(3단계 확인)·ClaimVoucher(바우처 청구)는 없앴다(개정 3).
// ──────────────────────────────────────────────────────────────────────────

/** Monad 메인넷. 테스트넷은 10143 (도메인 chainId만 바꾼다). */
export const PIKIT_CHAIN_ID = 143;

/** 서명 도메인: { name: "PIKIT", version: "1", chainId, verifyingContract: PikitShop }. */
export function pikitDomain(shop: string, chainId: number = PIKIT_CHAIN_ID): TypedDataDomain {
  return { name: "PIKIT", version: "1", chainId, verifyingContract: Address.parse(shop) as `0x${string}` };
}

export const CREDIT_INTENT_TYPES = {
  CreditIntent: [
    { name: "wallet", type: "address" },
    { name: "sessionKey", type: "address" },
    { name: "roomId", type: "uint256" },
    { name: "rulesHash", type: "bytes32" },
    { name: "tiers", type: "uint8[]" },
    { name: "nonce", type: "uint256" },
    { name: "deadline", type: "uint256" },
  ],
} as const;

export const CANCEL_INTENT_TYPES = {
  CancelIntent: [
    { name: "wallet", type: "address" },
    { name: "sessionKey", type: "address" },
    { name: "roomId", type: "uint256" },
    { name: "items", type: "uint256[]" },
    { name: "nonce", type: "uint256" },
    { name: "deadline", type: "uint256" },
  ],
} as const;

export const SESSION_GRANT_TYPES = {
  SessionGrant: [
    { name: "wallet", type: "address" },
    { name: "sessionKey", type: "address" },
    { name: "expiresAt", type: "uint64" },
    { name: "spendLimitCredits", type: "uint64" },
  ],
} as const;

/** 컨트랙트 상수와 같다: 세션 허가는 최대 7일, 의향서 한 장의 곡괭이는 1~10개. */
export const MAX_SESSION_SECONDS = 7 * 24 * 3600;

// ── 메시지 형식 (JSON 모양, zod) ─────────────────────────────────────────────

/**
 * 크레딧 구매 의향서 (세션 키 서명). 지갑의 체인 크레딧 잔액(프로모 전용, 개정 5·D105 — promo 칸은 없어졌다)으로 산다.
 * rulesHash = 그 방의 체인 activeRules(roomId). deadline = 마지막 유효 블록 번호.
 */
export const CreditIntentMessage = z.object({
  wallet: Address,
  sessionKey: Address,
  roomId: DecimalString,
  rulesHash: Bytes32,
  tiers: z.array(z.number().int().min(0).max(31)).min(1).max(10),
  nonce: DecimalString,
  deadline: DecimalString,
}).strict();
export type CreditIntentMessage = z.infer<typeof CreditIntentMessage>;

/** 대기열 취소 의향서 (세션 키 서명). items[i] = itemId(purchaseId, itemIndex) = (purchaseId << 8) | itemIndex. */
export const CancelIntentMessage = z.object({
  wallet: Address,
  sessionKey: Address,
  roomId: DecimalString,
  items: z.array(DecimalString).min(1).max(10),
  nonce: DecimalString,
  deadline: DecimalString,
}).strict();
export type CancelIntentMessage = z.infer<typeof CancelIntentMessage>;

/** 세션 키 허가 (지갑 서명). expiresAt = unix 초(지금 + 최대 7일), spendLimitCredits = 이 세션 키로 쓸 수 있는 크레딧 합 상한. */
export const SessionGrantMessage = z.object({
  wallet: Address,
  sessionKey: Address,
  expiresAt: DecimalString,
  spendLimitCredits: DecimalString,
}).strict();
export type SessionGrantMessage = z.infer<typeof SessionGrantMessage>;

/** 65바이트 서명 (0x + 130 hex). */
export const Signature65 = z.string().regex(/^0x[0-9a-f]{130}$/, "65-byte signature (lowercase hex)");

// ── 곡괭이 번호 ─────────────────────────────────────────────────────────────

/** 곡괭이 번호 "<purchaseId>:<itemIndex>" (엔진 QueueItem.key, DB item_key). */
export function itemKeyOf(purchaseId: string | bigint | number, itemIndex: number): string {
  return `${BigInt(purchaseId).toString()}:${itemIndex}`;
}

/** "<purchaseId>:<itemIndex>" → 값. 형식이 틀리면 null. */
export function parseItemKey(itemKey: string): { purchaseId: string; itemIndex: number } | null {
  const m = /^(0|[1-9][0-9]*):([0-9])$/.exec(itemKey);
  return m ? { purchaseId: m[1]!, itemIndex: Number(m[2]) } : null;
}

/** CancelIntent.items의 값 = (purchaseId << 8) | itemIndex. */
export function itemIdOf(purchaseId: string | bigint | number, itemIndex: number): bigint {
  if (!Number.isInteger(itemIndex) || itemIndex < 0 || itemIndex > 9) throw new Error(`itemIdOf: bad item index ${itemIndex}`);
  return (BigInt(purchaseId) << 8n) | BigInt(itemIndex);
}

export function itemKeyFromId(itemId: string | bigint): string {
  const id = BigInt(itemId);
  return itemKeyOf(id >> 8n, Number(id & 0xffn));
}

// ── 다이제스트·서명·복원 ─────────────────────────────────────────────────────

const big = (s: string) => BigInt(s);

/** viem typed data (지갑 eth_signTypedData_v4·viem signTypedData가 그대로 받는다). */
export function creditIntentTypedData(domain: TypedDataDomain, m: CreditIntentMessage) {
  const p = CreditIntentMessage.parse(m);
  return {
    domain, types: CREDIT_INTENT_TYPES, primaryType: "CreditIntent" as const,
    message: {
      wallet: p.wallet as `0x${string}`, sessionKey: p.sessionKey as `0x${string}`, roomId: big(p.roomId), rulesHash: p.rulesHash as `0x${string}`,
      tiers: p.tiers, nonce: big(p.nonce), deadline: big(p.deadline),
    },
  };
}

export function cancelIntentTypedData(domain: TypedDataDomain, m: CancelIntentMessage) {
  const p = CancelIntentMessage.parse(m);
  return {
    domain, types: CANCEL_INTENT_TYPES, primaryType: "CancelIntent" as const,
    message: {
      wallet: p.wallet as `0x${string}`, sessionKey: p.sessionKey as `0x${string}`, roomId: big(p.roomId), items: p.items.map(big),
      nonce: big(p.nonce), deadline: big(p.deadline),
    },
  };
}

export function sessionGrantTypedData(domain: TypedDataDomain, m: SessionGrantMessage) {
  const p = SessionGrantMessage.parse(m);
  return {
    domain, types: SESSION_GRANT_TYPES, primaryType: "SessionGrant" as const,
    message: { wallet: p.wallet as `0x${string}`, sessionKey: p.sessionKey as `0x${string}`, expiresAt: big(p.expiresAt), spendLimitCredits: big(p.spendLimitCredits) },
  };
}

export function hashCreditIntent(domain: TypedDataDomain, m: CreditIntentMessage): `0x${string}` {
  return hashTypedData(creditIntentTypedData(domain, m));
}
export function hashCancelIntent(domain: TypedDataDomain, m: CancelIntentMessage): `0x${string}` {
  return hashTypedData(cancelIntentTypedData(domain, m));
}
export function hashSessionGrant(domain: TypedDataDomain, m: SessionGrantMessage): `0x${string}` {
  return hashTypedData(sessionGrantTypedData(domain, m));
}

/** 서명 함수: 다이제스트가 아니라 typed data를 받는다(지갑·로컬 키 어댑터가 같은 모양). */
export type TypedDataSigner = (typedData: ReturnType<typeof creditIntentTypedData> | ReturnType<typeof cancelIntentTypedData>
  | ReturnType<typeof sessionGrantTypedData>) => Promise<`0x${string}`>;

/** 개인키(테스트·개발·브라우저 세션 키)로 typed data에 서명하는 함수를 만든다. */
export function privateKeySigner(privateKey: `0x${string}`): { address: string; sign: TypedDataSigner } {
  const account = privateKeyToAccount(privateKey);
  return {
    address: account.address.toLowerCase(),
    sign: (typed) => account.signTypedData(typed as Parameters<typeof account.signTypedData>[0]),
  };
}

export function signCreditIntent(sign: TypedDataSigner, domain: TypedDataDomain, m: CreditIntentMessage): Promise<`0x${string}`> {
  return sign(creditIntentTypedData(domain, m));
}
export function signCancelIntent(sign: TypedDataSigner, domain: TypedDataDomain, m: CancelIntentMessage): Promise<`0x${string}`> {
  return sign(cancelIntentTypedData(domain, m));
}
export function signSessionGrant(sign: TypedDataSigner, domain: TypedDataDomain, m: SessionGrantMessage): Promise<`0x${string}`> {
  return sign(sessionGrantTypedData(domain, m));
}

const lower = (a: string) => a.toLowerCase();

export async function recoverCreditIntentSigner(domain: TypedDataDomain, m: CreditIntentMessage, signature: `0x${string}`): Promise<string> {
  return lower(await recoverTypedDataAddress({ ...creditIntentTypedData(domain, m), signature }));
}
export async function recoverCancelIntentSigner(domain: TypedDataDomain, m: CancelIntentMessage, signature: `0x${string}`): Promise<string> {
  return lower(await recoverTypedDataAddress({ ...cancelIntentTypedData(domain, m), signature }));
}
/** EOA 지갑의 허가 서명 복원 (스마트 지갑 ERC-1271은 체인 registerSessionKey가 직접 확인한다). */
export async function recoverSessionGrantSigner(domain: TypedDataDomain, m: SessionGrantMessage, signature: `0x${string}`): Promise<string> {
  return lower(await recoverTypedDataAddress({ ...sessionGrantTypedData(domain, m), signature }));
}

/** 컨트랙트 호출 인자 모양 (viem writeContract args). */
export function creditIntentArg(m: CreditIntentMessage) {
  return creditIntentTypedData({}, m).message;
}
export function cancelIntentArg(m: CancelIntentMessage) {
  return cancelIntentTypedData({}, m).message;
}
export function sessionGrantArg(m: SessionGrantMessage) {
  return sessionGrantTypedData({}, m).message;
}
