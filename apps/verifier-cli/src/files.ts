import { readFile } from "node:fs/promises";
import { join } from "node:path";

// ──────────────────────────────────────────────────────────────────────────
// 공개 파일 읽기: 로컬 폴더 또는 https:// 주소(예: https://chog.pikit.fun/epochs). 없는 파일(ENOENT · HTTP 404)은 null —
// 검증기가 "참조한 파일이 모두 공개돼 있는가" 검사를 실패로 만든다. 그 밖의 오류(권한, 5xx, 잘못된 JSON)는 던진다.
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

  /** JSON 하나 (없으면 null). */
  async json(path: string): Promise<unknown | null> {
    if (!isUrl(path)) {
      try {
        return JSON.parse(await readFile(path, "utf8")) as unknown;
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
      const res = await fetch(path, { headers: { accept: "application/json" } });
      if (res.status === 404) return null;
      if ((res.status === 429 || res.status >= 500) && attempt < 4) {
        await new Promise((r) => setTimeout(r, 500 * 2 ** attempt));
        continue;
      }
      if (!res.ok) throw new Error(`HTTP ${res.status} for ${path}`);
      return (await res.json()) as unknown;
    }
  }

  /** 여러 개를 순서대로 (동시 concurrency개). */
  async many(paths: readonly string[], onProgress?: (done: number) => void): Promise<(unknown | null)[]> {
    const out: (unknown | null)[] = new Array(paths.length).fill(null);
    let next = 0;
    let done = 0;
    const worker = async () => {
      while (next < paths.length) {
        const i = next++;
        out[i] = await this.json(paths[i]!);
        done += 1;
        if (onProgress && done % 200 === 0) onProgress(done);
      }
    };
    await Promise.all(Array.from({ length: Math.min(this.concurrency, paths.length) }, worker));
    return out;
  }
}
