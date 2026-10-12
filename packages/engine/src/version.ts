import { ENGINE_SOURCE_HASH, ENGINE_VERSION, ENGINE_VERSION_HASH } from "./build-info.js";

// 엔진 버전 해시 (Q5 → DECISIONS D41). 체인 `scheduleRules`의 rulesHash = keccak256(canonicalHash(카탈로그) ‖ engineVersionHash()).
// 값은 빌드 때 scripts/emit-build-info.mjs가 소스에서 계산해 build-info.ts에 적는다(엔진은 keccak 라이브러리를 들고 있지 않다).

/** keccak256(utf8(`<package version>+<engine source hash>`)), 0x 소문자 32바이트. */
export function engineVersionHash(): string {
  return ENGINE_VERSION_HASH;
}

export function engineBuildInfo(): { version: string; sourceHash: string; versionHash: string } {
  return { version: ENGINE_VERSION, sourceHash: ENGINE_SOURCE_HASH, versionHash: ENGINE_VERSION_HASH };
}
