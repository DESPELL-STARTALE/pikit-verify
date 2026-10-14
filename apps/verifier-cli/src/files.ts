import { readFile } from "node:fs/promises";
import { join } from "node:path";

import { HttpError, redactUrl } from "./errors.js";

// ──────────────────────────────────────────────────────────────────────────
// 공개 파일 읽기: 로컬 폴더 또는 https:// 주소(예: https://chog.pikit.fun/epochs). 바이트 그대로(루트 dataHash 재료) 또는 JSON. 없는 파일(ENOENT · HTTP 404)은 null —
// 검증기가 "참조한 파일이 모두 공개돼 있는가" 검사를 실패로 만든다. 그 밖의 오류(권한, 5xx, 잘못된 JSON)는 던진다 — HTTP 오류는 HttpError
// (`HTTP request failed (503 GET host/epochs/7.json)`, 상태가 없으면 밑 원인 `fetch failed: ECONNRESET`, D183)라 상태·원인이 늘 실린다
// (429·5xx·상태 없음 = 전송 오류, 종료 3). 2xx 인데 JSON 이 아니면 파일 내용 오류(종료 1) — 본문을 받다 끊긴 것은 HttpError(전송).
// HTTP는 초당 maxRps 간격 + 동시 4개로 읽는다(공개 서버를 두드리지 않게).
// ──────────────────────────────────────────────────────────────────────────

export const isUrl = (s: string) => /^https?:\/\//i.test(s);

export function joinPath(base: string, ...parts: string[]): string {
  return isUrl(base) ? [base.replace(/\/+$/, ""), ...parts].join("/") : join(base, ...parts);
}

export class FileReader {
  private nextAt = 0;
  private readonly gap: number;

  constructor(maxRps: number, private readonly concurrency = 4) {
    this.gap = 1000 / maxRps;
  }

  /** JSON 하나 (없으면 null). 2xx 인데 JSON 이 아니면 파일 내용 오류. */
  async json(path: string): Promise<unknown | null> {
    const b = await this.bytes(path);
    if (b === null) return null;
    try {
      return JSON.parse(new TextDecoder().decode(b)) as unknown;
    } catch (e) {
      throw new Error(`invalid JSON in ${isUrl(path) ? redactUrl(path) : path} (${(e as Error).message})`);
    }
  }

  /** 받은 바이트 그대로 (없으면 null) — 루트 dataHash 의 sha256 재료. */
  async bytes(path: string): Promise<Uint8Array | null> {
    if (!isUrl(path)) {
      try {
        return new Uint8Array(await readFile(path));
      } catch (e) {
        if ((e as { code?: string }).code === "ENOENT") return null;
        throw e;
      }
    }
    const now = Date.now();
    const at = Math.max(now, this.nextAt);
    this.nextAt = at + this.gap;
    if (at > now) await new Promise((r) => setTimeout(r, at - now));
    for (let attempt = 0; ; attempt++) {
      let res: Response;
      let body: Uint8Array;
      try {
        res = await fetch(path, { headers: { accept: "application/json" } });
        if (res.status === 404) return null;
        body = res.ok ? new Uint8Array(await res.arrayBuffer()) : new Uint8Array();
      } catch (e) {
        // 연결·본문 읽기 실패 (fetch failed · terminated) — 상태가 없으니 밑 원인을 단다 (전송 오류)
        throw new HttpError("GET", path, { cause: e });
      }
      if ((res.status === 429 || res.status >= 500) && attempt < 4) {
        await new Promise((r) => setTimeout(r, 500 * 2 ** attempt));
        continue;
      }
      if (!res.ok) throw new HttpError("GET", path, { status: res.status });   // 상태로 전송 오류(429·5xx)를 가린다 (errors.ts)
      return body;
    }
  }

  /** 여러 파일의 바이트를 순서대로 (동시 concurrency개). */
  async many(paths: readonly string[], onProgress?: (done: number) => void): Promise<(Uint8Array | null)[]> {
    const out: (Uint8Array | null)[] = new Array(paths.length).fill(null);
    let next = 0;
    let done = 0;
    const worker = async () => {
      while (next < paths.length) {
        const i = next++;
        out[i] = await this.bytes(paths[i]!);
        done += 1;
        if (onProgress && done % 200 === 0) onProgress(done);
      }
    };
    await Promise.all(Array.from({ length: Math.min(this.concurrency, paths.length) }, worker));
    return out;
  }
}
