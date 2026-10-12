import { sha256 } from "@noble/hashes/sha2";
import { bytesToHex, utf8ToBytes } from "@noble/hashes/utils";

// ──────────────────────────────────────────────────────────────────────────
// 정규 JSON (RFC 8785 JCS와 같은 규칙) + SHA-256 지문
//  - 객체 키는 UTF-16 코드 단위 순서로 정렬, 공백 없음
//  - 숫자는 ECMAScript Number→String 규칙(JCS가 정한 방식), NaN·Infinity는 금지
//  - 같은 내용이면 키 순서·공백·줄바꿈이 달라도 지문이 같다 → rulesHash
// ──────────────────────────────────────────────────────────────────────────

/** 값을 정규 JSON 문자열로 만든다. undefined·함수·bigint·NaN·Infinity가 있으면 오류. */
export function canonicalJson(value: unknown): string {
  if (value === null) return "null";
  switch (typeof value) {
    case "boolean":
      return value ? "true" : "false";
    case "number":
      if (!Number.isFinite(value)) throw new Error("canonicalJson: non-finite number");
      return Object.is(value, -0) ? "0" : String(value);
    case "string":
      return JSON.stringify(value);
    case "object": {
      if (Array.isArray(value)) return `[${value.map((v) => canonicalJson(v)).join(",")}]`;
      const obj = value as Record<string, unknown>;
      const keys = Object.keys(obj).filter((k) => obj[k] !== undefined).sort(compareUtf16);
      return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalJson(obj[k])}`).join(",")}}`;
    }
    default:
      throw new Error(`canonicalJson: unsupported type ${typeof value}`);
  }
}

function compareUtf16(a: string, b: string): number {
  // 기본 문자열 비교가 곧 UTF-16 코드 단위 비교다 (JCS 3.2.3)
  if (a < b) return -1;
  if (a > b) return 1;
  return 0;
}

/** 정규 JSON의 SHA-256을 0x 접두 16진수로 돌려준다. 카탈로그에 쓰면 rulesHash. */
export function canonicalHash(value: unknown): `0x${string}` {
  // @noble/hashes: Node·브라우저에서 같은 값 (node:crypto를 쓰지 않아 웹 번들에도 들어간다)
  return `0x${bytesToHex(sha256(utf8ToBytes(canonicalJson(value))))}`;
}
