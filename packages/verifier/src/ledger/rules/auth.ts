import { recoverBuyIntentSigner, recoverCancelQueueSigner, recoverLedgerSessionSigner } from "@pikit/protocol";
import type { LedgerListEntry, LedgerSessionRecord } from "@pikit/protocol";
import { contextDomain, type LedgerContext } from "./context.js";

// ──────────────────────────────────────────────────────────────────────────
// 의향서 인증 (ledgerHash 안, 계획 §2.9). 서명 복구만 비동기라 여기서 따로 하고, 상태 전이(apply.ts)는 그 결과를 받는 동기 함수다.
//   의향서 서명: 세션 키 서명을 복구한 주소 = intent.sessionKey  (아니면·복구 실패면 BAD_SIGNATURE)
//   세션: (intent.wallet, intent.sessionKey)의 LedgerSession 기록이 이 에폭 파일에 있고
//         · erc1271Block = null(EOA): 지갑 서명을 복구한 주소 = wallet
//         · erc1271Block ≠ null(스마트 지갑, ERC-1271/6492): 장부 규칙은 **받아들인다** — 진짜 확인은 검증기가 RPC로
//           그 블록에서 `isValidSignature`를 다시 부르는 것(B5). 규칙이 RPC를 부르면 재생이 체인 상태에 묶여 순수하지 않다.
//         없거나 틀리면 SESSION_MISSING. 기한(블록 timestamp ≤ expiresAt)은 apply가 본다.
// ──────────────────────────────────────────────────────────────────────────

/** 항목 하나의 인증 결과. GRANT는 인증이 없다(명단의 ANNOUNCE 서명이 승인) → null. */
export interface IntentAuth {
  /** 세션 키 서명이 intent.sessionKey의 것인가. */
  signatureOk: boolean;
  /** 유효한 세션 허가의 expiresAt (unix 초). null = 허가 없음 또는 지갑 서명이 틀림. */
  sessionExpiresAt: bigint | null;
}
export type EntryAuth = IntentAuth | null;

/** 세션 허가 키 "<wallet>:<sessionKey>" (소문자). */
export function sessionKeyOf(wallet: string, sessionKey: string): string {
  return `${wallet.toLowerCase()}:${sessionKey.toLowerCase()}`;
}

/** 세션 허가 기록 하나가 유효한가 → expiresAt 또는 null. */
export async function sessionExpiry(ctx: LedgerContext, rec: LedgerSessionRecord): Promise<bigint | null> {
  if (rec.erc1271Block !== null) return BigInt(rec.session.expiresAt);
  try {
    const signer = await recoverLedgerSessionSigner(contextDomain(ctx), rec.session, rec.signature as `0x${string}`);
    return signer === rec.session.wallet.toLowerCase() ? BigInt(rec.session.expiresAt) : null;
  } catch {
    return null;
  }
}

/** 세션 기록 목록 → 키별 유효 기한(유효한 것만). 같은 (wallet, sessionKey)가 두 번이면 던진다(파일 모양 위반). */
export async function sessionTable(ctx: LedgerContext, sessions: readonly LedgerSessionRecord[]): Promise<Map<string, bigint>> {
  const seen = new Set<string>();
  const out = new Map<string, bigint>();
  for (const s of sessions) {
    const k = sessionKeyOf(s.session.wallet, s.session.sessionKey);
    if (seen.has(k)) throw new Error(`sessions: (${k}) appears twice`);
    seen.add(k);
    const exp = await sessionExpiry(ctx, s);
    if (exp !== null) out.set(k, exp);
  }
  return out;
}

/** 의향서 서명 복구 (세션 키). 복구 실패는 false. */
export async function intentSignatureOk(ctx: LedgerContext, e: Exclude<LedgerListEntry, { kind: "GRANT" }>): Promise<boolean> {
  const domain = contextDomain(ctx);
  const sig = e.signature as `0x${string}`;
  try {
    const signer = e.kind === "BUY" ? await recoverBuyIntentSigner(domain, e.intent, sig) : await recoverCancelQueueSigner(domain, e.intent, sig);
    return signer === e.intent.sessionKey.toLowerCase();
  } catch {
    return false;
  }
}

/** 명단 항목마다 인증 (항목 순서 그대로). sessions = 그 창이 속한 에폭 파일의 세션 허가 (또는 미리 만든 sessionTable). */
export async function authenticateEntries(
  ctx: LedgerContext, entries: readonly LedgerListEntry[], sessions: readonly LedgerSessionRecord[] | ReadonlyMap<string, bigint>,
): Promise<EntryAuth[]> {
  const table = sessions instanceof Map ? sessions : await sessionTable(ctx, sessions as readonly LedgerSessionRecord[]);
  const out: EntryAuth[] = [];
  for (const e of entries) {
    if (e.kind === "GRANT") {
      out.push(null);
      continue;
    }
    out.push({
      signatureOk: await intentSignatureOk(ctx, e),
      sessionExpiresAt: table.get(sessionKeyOf(e.intent.wallet, e.intent.sessionKey)) ?? null,
    });
  }
  return out;
}
