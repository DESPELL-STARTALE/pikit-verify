// ──────────────────────────────────────────────────────────────────────────
// 무작위 — 엔진은 Math.random을 쓰지 않는다. 모든 값은 주입된 Rng에서 나온다.
//  - Rng: next()가 [0, 1) 실수(53비트)를 돌려주는 결정론 생성기
//  - Xoshiro128ss: 32비트 정수 연산(Math.imul, >>>)만 쓰는 xoshiro128** — 어느 JS 엔진에서도 비트 단위로 같다
//  - createStreamFactory: 윈도 키 + 이름표(label) → 독립 스트림. HMAC-SHA256은 밖에서 주입한다(엔진은 Node API 없음)
// 설계: docs/pikit-monad-architecture.md §4.2, 부록 B / docs/provable-fairness-design.md §5.4
// ──────────────────────────────────────────────────────────────────────────

/** [0, 1) 실수를 내는 결정론 난수 생성기. */
export interface Rng {
  next(): number;
}

/** 이름표(label) → 스트림. 같은 팩토리에서 같은 이름표는 같은 스트림 객체(이어서 뽑힘)를 돌려준다. */
export type RngFactory = (label: string) => Rng;

/** HMAC-SHA256(key, message) → 32바이트. Node는 node:crypto, 브라우저는 검증된 라이브러리를 주입한다. */
export type HmacSha256 = (key: Uint8Array, message: Uint8Array) => Uint8Array;

/** 스트림 파생 이름표의 접두사 (규칙이 바뀌면 v를 올린다). */
export const STREAM_DOMAIN = "PIKIT/stream/v1|";
/** 윈도 키 도메인 (설계 부록 B). */
export const WINDOW_DOMAIN = "PIKIT/win/v2";

const TWO_POW_26 = 67108864;
const TWO_POW_53 = 9007199254740992;

/** xoshiro128** (Blackman & Vigna). 상태 128비트, 주기 2^128 − 1. */
export class Xoshiro128ss implements Rng {
  private s0: number;
  private s1: number;
  private s2: number;
  private s3: number;

  private constructor(s0: number, s1: number, s2: number, s3: number) {
    this.s0 = s0 >>> 0;
    this.s1 = s1 >>> 0;
    this.s2 = s2 >>> 0;
    this.s3 = s3 >>> 0;
  }

  /** 앞 16바이트를 빅엔디언 u32 4개로 읽어 상태로 쓴다(32바이트 HMAC 출력이면 앞 절반). 상태가 모두 0이면 오류. */
  static fromBytes(bytes: Uint8Array): Xoshiro128ss {
    if (bytes.length < 16) throw new Error("Xoshiro128ss.fromBytes: need at least 16 bytes");
    const w = (i: number) => ((bytes[i]! << 24) | (bytes[i + 1]! << 16) | (bytes[i + 2]! << 8) | bytes[i + 3]!) >>> 0;
    const s = [w(0), w(4), w(8), w(12)] as const;
    if ((s[0] | s[1] | s[2] | s[3]) === 0) throw new Error("Xoshiro128ss.fromBytes: all-zero state");
    return new Xoshiro128ss(s[0], s[1], s[2], s[3]);
  }

  /** 다음 32비트 부호 없는 정수. */
  nextU32(): number {
    const result = Math.imul(rotl(Math.imul(this.s1, 5), 7), 9) >>> 0;
    const t = (this.s1 << 9) >>> 0;
    this.s2 = (this.s2 ^ this.s0) >>> 0;
    this.s3 = (this.s3 ^ this.s1) >>> 0;
    this.s1 = (this.s1 ^ this.s2) >>> 0;
    this.s0 = (this.s0 ^ this.s3) >>> 0;
    this.s2 = (this.s2 ^ t) >>> 0;
    this.s3 = rotl(this.s3, 11);
    return result;
  }

  /** [0, 1) 실수, 53비트 해상도 (u32 두 개: 상위 27비트 + 26비트). */
  next(): number {
    const a = this.nextU32() >>> 5;
    const b = this.nextU32() >>> 6;
    return (a * TWO_POW_26 + b) / TWO_POW_53;
  }

  /** 상태 직렬화용 (스냅샷·상태 해시). */
  state(): [number, number, number, number] {
    return [this.s0, this.s1, this.s2, this.s3];
  }
}

function rotl(x: number, k: number): number {
  return ((x << k) | (x >>> (32 - k))) >>> 0;
}

/**
 * 윈도 키 하나에서 이름표별 독립 스트림을 만드는 팩토리.
 * 스트림 시드 = HMAC-SHA256(windowKey, utf8("PIKIT/stream/v1|" + label))의 앞 16바이트 → xoshiro128** 상태.
 * 같은 팩토리 안에서는 이름표마다 스트림을 하나만 만들고 이어서 뽑는다(예: 한 윈도 9틱 동안의 kick 순번).
 * 윈도가 바뀌면 새 팩토리를 만든다 → 순번이 윈도마다 0부터 다시 시작한다(윈도 하나만 떼어 재생 가능).
 */
export function createStreamFactory(hmac: HmacSha256, windowKey: Uint8Array): RngFactory {
  const streams = new Map<string, Rng>();
  return (label: string): Rng => {
    const cached = streams.get(label);
    if (cached) return cached;
    const digest = hmac(windowKey, utf8(STREAM_DOMAIN + label));
    const rng = Xoshiro128ss.fromBytes(digest);
    streams.set(label, rng);
    return rng;
  };
}

/**
 * 윈도 키 메시지 (부록 B): "PIKIT/win/v2" ‖ u64be(chainId) ‖ shop(20바이트) ‖ u32be(roomId) ‖ u64be(window) ‖ blockHash(32바이트).
 * 키 K(ρ, w) = HMAC-SHA256(S_{e(w)}, 이 메시지). HMAC 계산은 호출자가 한다.
 */
export function windowKeyMessage(chainId: number, shop: Uint8Array, roomId: number, window: number, blockHash: Uint8Array): Uint8Array {
  if (shop.length !== 20) throw new Error("windowKeyMessage: shop must be 20 bytes");
  if (blockHash.length !== 32) throw new Error("windowKeyMessage: blockHash must be 32 bytes");
  const domain = utf8(WINDOW_DOMAIN);
  const out = new Uint8Array(domain.length + 8 + 20 + 4 + 8 + 32);
  let o = 0;
  out.set(domain, o); o += domain.length;
  o = writeU64(out, o, chainId);
  out.set(shop, o); o += 20;
  o = writeU32(out, o, roomId);
  o = writeU64(out, o, window);
  out.set(blockHash, o);
  return out;
}

function writeU32(buf: Uint8Array, o: number, v: number): number {
  if (!Number.isInteger(v) || v < 0 || v > 0xffffffff) throw new Error(`u32 out of range: ${v}`);
  buf[o] = (v >>> 24) & 0xff; buf[o + 1] = (v >>> 16) & 0xff; buf[o + 2] = (v >>> 8) & 0xff; buf[o + 3] = v & 0xff;
  return o + 4;
}

function writeU64(buf: Uint8Array, o: number, v: number): number {
  if (!Number.isSafeInteger(v) || v < 0) throw new Error(`u64 out of safe range: ${v}`);
  const hi = Math.floor(v / 4294967296);
  const lo = v - hi * 4294967296;
  writeU32(buf, o, hi);
  return writeU32(buf, o + 4, lo);
}

/** UTF-8 인코딩 (TextEncoder는 ES 표준이 아니라 엔진 본체에서 쓰지 않는다). 짝 없는 서로게이트는 오류. */
export function utf8(s: string): Uint8Array {
  const bytes: number[] = [];
  for (let i = 0; i < s.length; i++) {
    let c = s.charCodeAt(i);
    if (c >= 0xd800 && c <= 0xdbff) {
      const d = s.charCodeAt(i + 1);
      if (!(d >= 0xdc00 && d <= 0xdfff)) throw new Error("utf8: unpaired surrogate");
      c = 0x10000 + ((c - 0xd800) << 10) + (d - 0xdc00);
      i++;
    } else if (c >= 0xdc00 && c <= 0xdfff) {
      throw new Error("utf8: unpaired surrogate");
    }
    if (c < 0x80) bytes.push(c);
    else if (c < 0x800) bytes.push(0xc0 | (c >> 6), 0x80 | (c & 0x3f));
    else if (c < 0x10000) bytes.push(0xe0 | (c >> 12), 0x80 | ((c >> 6) & 0x3f), 0x80 | (c & 0x3f));
    else bytes.push(0xf0 | (c >> 18), 0x80 | ((c >> 12) & 0x3f), 0x80 | ((c >> 6) & 0x3f), 0x80 | (c & 0x3f));
  }
  return Uint8Array.from(bytes);
}
