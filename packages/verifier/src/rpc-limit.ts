import { custom, type Chain, type Transport } from "viem";

// ──────────────────────────────────────────────────────────────────────────
// RPC 속도 제한 + 재시도 (viem 트랜스포트 감싸기). game-server 블록 시계(rpc-clock.ts)와 검증기 RpcChainSource가 같이 쓴다.
//   간격     요청을 1000 / maxRps ms 간격으로 내보낸다(동시에 부르면 차례로 줄을 선다).
//   재시도   속도 제한 응답(HTTP 429·-32005·-32007·"rate limit"/"request limit"/"too many requests")과 시간 초과는
//            지수 백오프(backoffBaseMs × 2^n, 최대 10초, 지터 — Retry-After가 있으면 그만큼은 기다린다) 뒤 maxRetries번까지 다시 보낸다.
//            읽기에만 쓰므로 다시 보내도 안전하다. 그 밖의 오류(범위 초과, 되돌림 등)는 바로 올린다.
//   viem 자체 재시도는 끈다(이중 재시도 방지).
// 공개 RPC(QuickNode)는 초과분을 -32007 "50/second request limit reached"로 답한다(2026-10-10 실측).
// ──────────────────────────────────────────────────────────────────────────

export interface LimitOptions {
  maxRps?: number;          // 초당 요청 상한, 기본 10
  maxRetries?: number;      // 속도 제한·시간 초과 재시도, 기본 6
  backoffBaseMs?: number;   // 기본 200
}

interface ErrLike { name?: string; status?: number; code?: number; message?: string; details?: string; headers?: Headers; cause?: unknown }

/** 다시 보낼 일시 오류면 기다릴 최소 시간(ms): 속도 제한(Retry-After, 없으면 0)·시간 초과(0). 아니면 null. */
function retryWait(e: unknown): number | null {
  for (let cur: unknown = e, i = 0; cur && typeof cur === "object" && i < 10; cur = (cur as ErrLike).cause, i++) {
    const x = cur as ErrLike;
    const text = `${x.message ?? ""} ${x.details ?? ""}`;
    if (x.status === 429 || x.code === -32005 || x.code === -32007 || /rate.?limit|request limit|too many requests/i.test(text)) {
      const sec = Number(x.headers?.get?.("retry-after") ?? Number.NaN);
      return Number.isFinite(sec) ? sec * 1000 : 0;
    }
    if (x.name === "TimeoutError" || /took too long|timed? ?out/i.test(text)) return 0;
  }
  return null;
}

/** 초당 maxRps 간격 + 속도 제한·시간 초과 백오프로 감싼 트랜스포트. */
export function limitedTransport(inner: Transport, o: LimitOptions = {}): Transport {
  const gap = 1000 / (o.maxRps ?? 10);
  const maxRetries = o.maxRetries ?? 6;
  const baseMs = o.backoffBaseMs ?? 200;
  let nextAt = 0;
  const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
  return (params) => {
    const t = inner({ ...params, retryCount: 0 } as Parameters<Transport>[0]);
    const request = async (args: { method: string; params?: unknown }) => {
      for (let attempt = 0; ; attempt++) {
        const now = Date.now();
        const at = Math.max(now, nextAt);
        nextAt = at + gap;
        if (at > now) await sleep(at - now);
        try {
          return await t.request(args as never);
        } catch (e) {
          const ra = retryWait(e);
          if (ra === null || attempt >= maxRetries) throw e;
          const backoff = Math.min(10_000, baseMs * 2 ** attempt);
          await sleep(Math.max(ra, backoff / 2 + Math.random() * (backoff / 2)));
        }
      }
    };
    return custom({ request }, { retryCount: 0 })({ ...params, retryCount: 0 } as { chain?: Chain });
  };
}
