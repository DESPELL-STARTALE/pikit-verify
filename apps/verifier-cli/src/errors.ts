
// ──────────────────────────────────────────────────────────────────────────
// 오류 분류와 오류 줄 (D182 · D183).
//   전송 오류 = 검증 결과가 아니라 "지금 읽지 못함": HTTP 429·5xx, JSON-RPC 속도 제한(-32005·-32007·"rate limit"…), 시간 초과,
//   연결 끊김·거부·DNS(ECONNRESET·ECONNREFUSED·ETIMEDOUT·ENOTFOUND·EAI_AGAIN…, undici UND_ERR_*), fetch 실패,
//   그리고 **상태 코드 없는 HTTP 요청 실패**(D183: viem HttpRequestError 는 2xx 인데 본문이 JSON 이 아니면 — 빈 본문·잘린 본문·HTML —
//   status 없이 SyntaxError 를 cause 로 단다. 2026-10-13 메인넷 run 27 의 맨 "HTTP request failed." 가 이것이었다).
//   CLI 는 이것을 종료 3 + (--json) { ok: null, errorKind: "transport", error } 로 알린다 — 감시 루프(deploy/verifier/loop.mjs)가
//   검증 실패(종료 1)와 구분해 잠시 뒤 낮춘 속도로 다시 돌린다. 그 밖의 HTTP 4xx(401·403 = 키·설정 문제)는 전송 오류가 아니다.
//   공개 파일 404 는 여기 오지 않는다(files.ts 가 null → 검증기 파일 검사, 체인 끝 경합만 main.ts 가 tip-race 로).
// 오류 줄은 HTTP 상태 또는 밑 원인을 늘 싣는다(D183): `HTTP request failed (404 GET host/epochs/844.json)`,
//   `HTTP request failed (fetch failed: ECONNRESET; POST host/path)`, `HTTP request failed (SyntaxError: Unexpected end of JSON input; POST host/)`.
//   URL 은 호스트 + 경로만 남긴다 — 쿼리·#·사용자 정보는 지우고, 키처럼 보이는 경로 조각은 <key> 로(redactUrl).
// ──────────────────────────────────────────────────────────────────────────

/** URL 모양 (키가 경로·쿼리에 들어 있을 수 있어 오류 줄에서 줄인다). */
const URL_RE = /\b[a-z][a-z0-9+.-]*:\/\/[^\s"'<>()\\]*/gi;   // 괄호는 URL 밖 (오류 줄이 URL 을 괄호에 싼다)

const NET_CODES = new Set(["ECONNRESET", "ECONNREFUSED", "ECONNABORTED", "ETIMEDOUT", "ENOTFOUND", "EAI_AGAIN", "EPIPE", "EHOSTUNREACH", "ENETUNREACH", "ENETDOWN"]);

interface ErrLike { name?: unknown; status?: unknown; code?: unknown; message?: unknown; shortMessage?: unknown; details?: unknown; cause?: unknown; url?: unknown; method?: unknown }

function chainOf(e: unknown): ErrLike[] {
  const out: ErrLike[] = [];
  for (let cur: unknown = e; cur && typeof cur === "object" && out.length < 10; cur = (cur as ErrLike).cause) out.push(cur as ErrLike);
  return out;
}

/**
 * 키처럼 보이는 경로 조각: 점이 없고(파일 이름 `844.json`·`<해시>.json` 은 남긴다) 8글자 이상이며 숫자나 대문자가 섞인 것
 * (QuickNode·Infura·Alchemy 키, 위 시험의 SECRETKEY). `epochs`·`snapshots`·`catalogs`·`v2` 는 남는다.
 */
const KEYISH = /^(?=.*[0-9A-Z])[^.]{8,}$/;

/** URL → 호스트 + 경로 (쿼리·#·사용자 정보 없음, 키 같은 조각은 <key>). 읽을 수 없으면 <url>. */
export function redactUrl(u: string): string {
  try {
    const x = new URL(u);
    const path = x.pathname.split("/").map((s) => (KEYISH.test(decodeURIComponent(s)) ? "<key>" : s)).join("/");
    return `${x.host}${path}`;
  } catch {
    return "<url>";
  }
}

/** 글 안의 URL 을 모두 redactUrl 로. */
export const redactUrls = (s: string) => s.replace(URL_RE, (u) => redactUrl(u));

const firstLine = (v: unknown) => String(v ?? "").split("\n")[0]!.trim();

/**
 * 밑 원인 한 마디: `fetch failed: ECONNRESET`, `ECONNREFUSED`, `SyntaxError: Unexpected end of JSON input`, `terminated: UND_ERR_SOCKET`.
 * 사슬 첫 글 + (그 글에 없으면) 사슬 안의 첫 시스템 오류 코드. 글이 없으면 코드만.
 */
export function causeText(e: unknown): string {
  const chain = chainOf(e);
  if (chain.length === 0) return firstLine(e) || "no cause";
  const top = chain[0]!;
  const code = chain.map((x) => x.code).find((c): c is string => typeof c === "string");
  const name = typeof top.name === "string" && top.name !== "Error" && top.name !== "TypeError" ? `${top.name}: ` : "";
  const msg = firstLine(top.shortMessage ?? top.message);
  const text = msg ? `${name}${msg}` : "";
  if (!text) return code ?? "no cause";
  return code && !text.includes(code) ? `${text}: ${code}` : text;
}

/**
 * HTTP 요청 실패 (공개 파일 읽기 — files.ts). 글 = `HTTP request failed (<상태 | 원인>; <방법> <호스트/경로>)`, 상태가 있으면 `(404 GET …)`.
 * status 가 있으면 isTransportError 가 상태로(429·5xx = 전송), 없으면(fetch·본문 읽기 실패) 전송 오류.
 */
export class HttpError extends Error {
  override readonly name = "HttpError";
  readonly status: number | undefined;
  constructor(readonly method: string, readonly url: string, o: { status?: number; cause?: unknown }) {
    const where = `${method} ${redactUrl(url)}`;
    super(`HTTP request failed (${o.status !== undefined ? `${o.status} ${where}` : `${causeText(o.cause)}; ${where}`})`, o.cause === undefined ? undefined : { cause: o.cause });
    this.status = o.status;
  }
}

/** 체인 끝 경합 (D183): 마지막 앵커 근처 에폭 파일이 아직 안 보임 — 종료 3, errorKind "tip-race", 루프가 짧게 기다려 다시. */
export class TipRaceError extends Error {
  override readonly name = "TipRaceError";
}

const isHttpFailure = (x: ErrLike) => x.name === "HttpRequestError" || x.name === "HttpError";

/** 전송 오류인가 (위 목록). 검증 실패·사용법 오류·파일 내용 오류·HTTP 4xx(429 빼고)는 아니다. */
export function isTransportError(e: unknown): boolean {
  const chain = chainOf(e);
  // 상태 코드가 있는 첫 HTTP 실패가 결정한다 (429·5xx 전송, 그 밖의 4xx 는 설정 문제). 상태 없는 HTTP 실패 = 응답을 못 받음 → 전송.
  const http = chain.find(isHttpFailure);
  if (http) return typeof http.status === "number" ? http.status === 429 || http.status >= 500 : true;
  return chain.some((x) => {
    const text = `${String(x.shortMessage ?? "")} ${String(x.message ?? "")} ${String(x.details ?? "")}`;
    if (typeof x.status === "number") return x.status === 429 || x.status >= 500;
    if (typeof x.code === "string" && (NET_CODES.has(x.code) || x.code.startsWith("UND_ERR_"))) return true;
    if (x.code === -32005 || x.code === -32007 || /rate.?limit|request limit|too many requests/i.test(text)) return true;
    return x.name === "TimeoutError" || x.name === "AbortError" || /^fetch failed$/.test(String(x.message ?? ""));
  });
}

/**
 * 오류 한 줄. viem 오류는 긴 문장을 쓰지 않는다(`URL: …/<API 키>`·요청 본문이 붙는다).
 *   HTTP 실패(viem HttpRequestError · HttpError): `HTTP request failed (<상태 | 원인>; <방법> <호스트/경로>)` — 상태도 원인도 없는 맨 줄은 내지 않는다.
 *   그 밖: 짧은 문장(viem shortMessage 첫 줄, 아니면 message 전체를 한 줄로) + (HTTP 상태) + (시스템 오류 코드), 둘 다 없고 cause 가 있으면 (원인). URL 은 redactUrl.
 */
export function errorLine(e: unknown): string {
  const chain = chainOf(e);
  const top = chain[0];
  const http = chain.find(isHttpFailure);
  if (http?.name === "HttpError") return redactUrls(firstLine(http.message));
  if (http) {
    const where = `${typeof http.method === "string" ? http.method : "POST"} ${typeof http.url === "string" ? redactUrl(http.url) : "<url>"}`;
    const detail = typeof http.status === "number" ? `${http.status} ${where}` : `${http.cause !== undefined ? causeText(http.cause) : firstLine(http.details) || "no status, no cause"}; ${where}`;
    return redactUrls(`HTTP request failed (${detail})`);
  }
  const status = chain.find((x) => typeof x.status === "number")?.status;
  const sys = chain.find((x) => typeof x.code === "string")?.code;
  // viem 은 shortMessage 첫 줄만(긴 본문에 URL·요청이 붙는다). 그 밖(예: zod 검증 오류 = 여러 줄 JSON)은 전체를 한 줄로
  const head = top?.shortMessage !== undefined ? firstLine(top.shortMessage) : String(top?.message ?? e).replace(/\s*\n\s*/g, " ").trim();
  const cause = status === undefined && sys === undefined && top?.cause !== undefined ? ` (${causeText(top.cause)})` : "";
  const text = `${head}${status === undefined ? "" : ` (HTTP ${String(status)})`}${sys === undefined ? "" : ` (${String(sys)})`}${cause}`;
  return redactUrls(text);
}
