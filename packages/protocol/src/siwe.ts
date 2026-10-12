import { getAddress } from "viem";
import { createSiweMessage, parseSiweMessage } from "viem/siwe";

// ──────────────────────────────────────────────────────────────────────────
// 로그인 + 세션 키 위임 = SIWE(EIP-4361) 서명 한 번 (INTERFACES §8 Q2 결정 → DECISIONS D38)
//  - resources: ["urn:pikit:session-key:<세션 키 주소(소문자)>:exp:<만료 unix 초>"]
//  - statement: "Authorize session key <주소> for in-game credit purchases until <ISO 날짜>"
//  - 위임의 증거 = 이 SIWE 메시지 + 지갑 서명 자체. 세션 키는 secp256k1 주소(EIP-712 서명용)다.
// 메시지 문자열 조립·파싱은 viem/siwe를 쓴다(EIP-4361 문법 그대로).
// ──────────────────────────────────────────────────────────────────────────

export const SESSION_KEY_URN_PREFIX = "urn:pikit:session-key:";

/** "urn:pikit:session-key:<address>:exp:<unix>" */
export function sessionKeyResource(sessionKey: string, expiresAtUnix: number): string {
  const key = normalizeAddress(sessionKey);
  if (!Number.isSafeInteger(expiresAtUnix) || expiresAtUnix <= 0) throw new Error("sessionKeyResource: bad expiry");
  return `${SESSION_KEY_URN_PREFIX}${key}:exp:${expiresAtUnix}`;
}

/** "Authorize session key <address> for in-game credit purchases until <ISO date>" (ISO = UTC, 초 단위, 예: 2026-10-07T12:00:00Z). */
export function sessionKeyStatement(sessionKey: string, expiresAtUnix: number): string {
  return `Authorize session key ${normalizeAddress(sessionKey)} for in-game credit purchases until ${isoSeconds(expiresAtUnix)}`;
}

export interface SessionSiweParams {
  domain: string;
  uri: string;
  wallet: string;
  sessionKey: string;
  expiresAtUnix: number;       // 세션 키 만료 (SIWE expirationTime과 같은 값)
  nonce: string;
  issuedAtUnix: number;
  chainId?: number;            // 기본 143
}

/** 로그인 + 위임 SIWE 메시지 문자열. 지갑에 그대로 넘겨 personal_sign 한다. */
export function createSessionSiweMessage(p: SessionSiweParams): string {
  return createSiweMessage({
    domain: p.domain,
    uri: p.uri,
    address: getAddress(p.wallet),
    chainId: p.chainId ?? 143,
    version: "1",
    nonce: p.nonce,
    issuedAt: new Date(p.issuedAtUnix * 1000),
    expirationTime: new Date(p.expiresAtUnix * 1000),
    statement: sessionKeyStatement(p.sessionKey, p.expiresAtUnix),
    resources: [sessionKeyResource(p.sessionKey, p.expiresAtUnix)],
  });
}

export interface SessionDelegationClaim {
  wallet: string;              // 소문자
  sessionKey: string;          // 소문자
  expiresAtUnix: number;
  chainId: number;
  domain: string;
  nonce: string;
}

/**
 * SIWE 메시지에서 위임 내용을 꺼내고 모양을 검사한다(서명 검사는 따로: viem `verifyMessage`, 컨트랙트 지갑은 EIP-1271).
 * 검사: resources에 세션 키 항목이 정확히 1개, statement가 같은 키·만료를 말함, expirationTime = 만료.
 */
export function parseSessionDelegation(message: string): SessionDelegationClaim {
  const m = parseSiweMessage(message);
  if (!m.address || !m.chainId || !m.domain || !m.nonce) throw new Error("siwe: missing address/chainId/domain/nonce");
  const urns = (m.resources ?? []).filter((r) => r.startsWith(SESSION_KEY_URN_PREFIX));
  if (urns.length !== 1) throw new Error("siwe: need exactly one session-key resource");
  const match = /^urn:pikit:session-key:(0x[0-9a-f]{40}):exp:([1-9][0-9]*)$/.exec(urns[0]!);
  if (!match) throw new Error(`siwe: malformed session-key resource ${urns[0]}`);
  const sessionKey = match[1]!;
  const expiresAtUnix = Number(match[2]);
  if (m.statement !== sessionKeyStatement(sessionKey, expiresAtUnix)) throw new Error("siwe: statement does not match the session-key resource");
  if (!m.expirationTime || Math.floor(m.expirationTime.getTime() / 1000) !== expiresAtUnix) throw new Error("siwe: expirationTime must equal the session-key expiry");
  return { wallet: m.address.toLowerCase(), sessionKey, expiresAtUnix, chainId: m.chainId, domain: m.domain, nonce: m.nonce };
}

function normalizeAddress(a: string): string {
  const l = a.toLowerCase();
  if (!/^0x[0-9a-f]{40}$/.test(l)) throw new Error(`not an address: ${a}`);
  return l;
}

function isoSeconds(unix: number): string {
  return new Date(unix * 1000).toISOString().replace(/\.\d{3}Z$/, "Z");
}
