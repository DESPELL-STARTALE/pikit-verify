import { canonicalJson } from "@pikit/protocol";

// ──────────────────────────────────────────────────────────────────────────
// RPC 두 곳 교차 확인 (리뷰 rev6 H-1·L-7). 같은 읽기를 두 곳에서 따로 하고 값이 하나라도 다르면 첫 차이를 담은 ChainDisagreement로 멈춘다
// (검증 실패, 종료 1). 개정 6 RpcChainSource와 개정 7 RpcLedgerSource가 같이 쓴다. 오류 글에 URL은 넣지 않는다 — 곳은 rpc#1·rpc#2.
// ──────────────────────────────────────────────────────────────────────────

/** RPC 두 곳이 같은 체인 값을 다르게 답했다 (검증 실패). what = 어느 값인지, a·b = 두 곳의 값(짧게, URL 없음). */
export class ChainDisagreement extends Error {
  constructor(readonly what: string, readonly a: string, readonly b: string) {
    super(`RPC endpoints disagree on ${what}: rpc#1 ${a} vs rpc#2 ${b}`);
    this.name = "ChainDisagreement";
  }
}

/** RPC 두 곳 교차 확인 검사의 이름 (다르면 그 자리에서 멈추고 첫 차이를 detail에). */
export const AGREE_CHECK = "the RPC endpoints agree on every chain fact read";

const short = (v: unknown) => { const s = typeof v === "string" ? v : canonicalJson(v); return s.length > 160 ? `${s.slice(0, 157)}…` : s; };

/** 곳들의 값이 모두 같아야 한다. 배열은 첫 다른 원소, 객체(블록 해시 표)는 첫 다른 키를 알려 준다. */
export function agree<T>(what: string, values: readonly T[]): T {
  const first = values[0]!;
  for (const other of values.slice(1)) {
    if (Array.isArray(first) && Array.isArray(other)) {
      const n = Math.max(first.length, other.length);
      for (let i = 0; i < n; i++) {
        if (canonicalJson(first[i] ?? null) !== canonicalJson(other[i] ?? null)) throw new ChainDisagreement(`${what}[${i}]`, short(first[i] ?? "none"), short(other[i] ?? "none"));
      }
    } else if (first && other && typeof first === "object" && typeof other === "object") {
      const a = first as Record<string, unknown>;
      const b = other as Record<string, unknown>;
      const keys = [...new Set([...Object.keys(a), ...Object.keys(b)])].sort((x, y) => Number(x) - Number(y) || x.localeCompare(y));
      for (const k of keys) {
        if (canonicalJson(a[k] ?? null) !== canonicalJson(b[k] ?? null)) throw new ChainDisagreement(`${what}[${k}]`, short(a[k] ?? "none"), short(b[k] ?? "none"));
      }
    } else if (canonicalJson(first) !== canonicalJson(other)) {
      throw new ChainDisagreement(what, short(first), short(other));
    }
  }
  return first;
}

/** 오류와 cause 사슬의 글 전부 (viem은 RPC 오류를 겹겹이 감싼다). */
export function errorText(e: unknown): string {
  const out: string[] = [];
  for (let cur: unknown = e; cur && typeof cur === "object" && out.length < 10; cur = (cur as { cause?: unknown }).cause) {
    const x = cur as { code?: unknown; shortMessage?: string; details?: string; message?: string };
    out.push(`${String(x.code ?? "")} ${x.shortMessage ?? ""} ${x.details ?? ""} ${x.message ?? ""}`);
  }
  return out.join(" | ");
}

/** eth_getLogs 구간이 너무 넓다는 제공자 오류 (settler rpc-source와 같은 판정). */
export const isRangeError = (e: unknown) =>
  /block range|range (is )?too (large|big|wide)|exceed(s|ed)? .*(range|block|result)|query returned more than|too many (results|blocks|logs)|limit.*(block|range)|-32602.*range|max.*block.*range/i.test(errorText(e));
