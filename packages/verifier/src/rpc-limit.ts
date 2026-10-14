import { custom, type Chain, type Transport } from "viem";

// ──────────────────────────────────────────────────────────────────────────
// RPC 속도 제한 + 재시도 (viem 트랜스포트 감싸기). game-server 블록 시계(rpc-clock.ts)와 검증기 RpcChainSource가 같이 쓴다.
//   간격     요청을 1000 / maxRps ms 간격으로 내보낸다(동시에 부르면 차례로 줄을 선다).
//   재시도   일시 오류는 지수 백오프(backoffBaseMs × 2^n, 최대 backoffMaxMs, 지터) 뒤 다시 보낸다 — maxRetries번까지, 그리고 기다린 시간의 합이
//            retryBudgetMs를 넘지 않는 동안. 읽기에만 쓰므로 다시 보내도 안전하다. 일시 오류 =
//              속도 제한  HTTP 429·-32005·-32007·"rate limit"/"request limit"/"too many requests". Retry-After(초)가 있으면 적어도 그만큼 —
//                         그것이 남은 예산보다 길면 바로 포기한다(위 단계가 나중에 다시). **이 곳의 줄 전체를 그 시각까지 멈춘다**(D182):
//                         동시에 줄 선 다른 요청도 같은 제한 창에 계속 들어가지 않게 — 2026-10-13 메인넷에서 요청마다 따로 물러나던 것이
//                         동시 16개 블록 읽기를 계속 429 창에 보내 6번(≈ 10초)을 다 써 버렸다.
//              시간 초과  TimeoutError·"took too long"/"timed out"
//              서버·연결  HTTP 5xx, 끊긴 연결(ECONNRESET·EPIPE·ETIMEDOUT·UND_ERR_SOCKET·"socket hang up"·"other side closed")
//              깨진 응답  상태 없는 HttpRequestError 인데 cause 사슬에 시스템 오류 코드가 없음 — viem 은 2xx 본문이 JSON 이 아니면(빈·잘린·HTML)
//                         이렇게 던진다(SyntaxError cause). 2026-10-13 메인넷 run 27 이 이것으로 끝났다(D183)
//            그 밖의 오류(범위 초과, 되돌림, 연결 거부·DNS 같은 설정 문제 등)는 바로 올린다.
//   viem 자체 재시도는 끈다(이중 재시도 방지).
// 공개 RPC(QuickNode)는 초과분을 -32007 "50/second request limit reached"로 답한다(2026-10-10 실측).
// ──────────────────────────────────────────────────────────────────────────

export interface LimitOptions {
  maxRps?: number;          // 초당 요청 상한, 기본 10
  maxRetries?: number;      // 일시 오류 재시도 횟수 상한, 기본 6
  backoffBaseMs?: number;   // 기본 200
  backoffMaxMs?: number;    // 한 번 기다림의 상한(Retry-After 제외), 기본 10초
  retryBudgetMs?: number;   // 한 요청이 재시도로 기다리는 시간의 합 상한, 기본 없음(횟수만)
}

interface ErrLike { name?: string; status?: number; code?: number | string; message?: string; details?: string; headers?: Headers; cause?: unknown }

const DROPPED = new Set(["ECONNRESET", "EPIPE", "ETIMEDOUT", "UND_ERR_SOCKET", "UND_ERR_CLOSED"]);

/** 상태 없는 HTTP 실패이고 그 아래에 시스템 오류 코드가 없음 = 응답은 왔는데 읽을 수 없었다(깨진 본문). 연결 거부·DNS(코드 있음)는 아니다. */
function brokenResponse(x: ErrLike): boolean {
  if (x.name !== "HttpRequestError" || x.status !== undefined) return false;
  for (let cur: unknown = x.cause, i = 0; cur && typeof cur === "object" && i < 10; cur = (cur as ErrLike).cause, i++) {
    if (typeof (cur as ErrLike).code === "string") return false;
  }
  return true;
}

/** 다시 보낼 일시 오류면 { 최소 기다림 ms, 속도 제한인가 }, 아니면 null. */
function retryWait(e: unknown): { minMs: number; rateLimited: boolean } | null {
  for (let cur: unknown = e, i = 0; cur && typeof cur === "object" && i < 10; cur = (cur as ErrLike).cause, i++) {
    const x = cur as ErrLike;
    const text = `${x.message ?? ""} ${x.details ?? ""}`;
    if (x.status === 429 || x.code === -32005 || x.code === -32007 || /rate.?limit|request limit|too many requests/i.test(text)) {
      const sec = Number(x.headers?.get?.("retry-after") ?? Number.NaN);
      return { minMs: Number.isFinite(sec) && sec > 0 ? sec * 1000 : 0, rateLimited: true };
    }
    if (typeof x.status === "number" && x.status >= 500) return { minMs: 0, rateLimited: false };
    if (x.name === "TimeoutError" || /took too long|timed? ?out/i.test(text)) return { minMs: 0, rateLimited: false };
    if ((typeof x.code === "string" && DROPPED.has(x.code)) || /socket hang up|other side closed/i.test(text)) return { minMs: 0, rateLimited: false };
    if (brokenResponse(x)) return { minMs: 0, rateLimited: false };
  }
  return null;
}

/** 초당 maxRps 간격 + 일시 오류 백오프로 감싼 트랜스포트. */
export function limitedTransport(inner: Transport, o: LimitOptions = {}): Transport {
  const gap = 1000 / (o.maxRps ?? 10);
  const maxRetries = o.maxRetries ?? 6;
  const baseMs = o.backoffBaseMs ?? 200;
  const capMs = o.backoffMaxMs ?? 10_000;
  const budgetMs = o.retryBudgetMs ?? Number.POSITIVE_INFINITY;
  let nextAt = 0;
  const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
  return (params) => {
    const t = inner({ ...params, retryCount: 0 } as Parameters<Transport>[0]);
    const request = async (args: { method: string; params?: unknown }) => {
      let waited = 0;
      for (let attempt = 0; ; attempt++) {
        const now = Date.now();
        const at = Math.max(now, nextAt);
        nextAt = at + gap;
        if (at > now) await sleep(at - now);
        try {
          return await t.request(args as never);
        } catch (e) {
          const w = retryWait(e);
          if (w === null || attempt >= maxRetries) throw e;
          const backoff = Math.min(capMs, baseMs * 2 ** attempt);
          const wait = Math.max(w.minMs, backoff / 2 + Math.random() * (backoff / 2));
          if (waited + wait > budgetMs) throw e;
          waited += wait;
          if (w.rateLimited) nextAt = Math.max(nextAt, Date.now() + wait);   // 줄 전체를 멈춘다 — 이 요청은 다음 차례에 그 뒤로 선다
          else await sleep(wait);
        }
      }
    };
    return custom({ request }, { retryCount: 0 })({ ...params, retryCount: 0 } as { chain?: Chain });
  };
}
