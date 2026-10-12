import { hmacSha256 } from "@pikit/protocol";
import { createStreamFactory, windowKeyMessage, type HmacSha256, type RngFactory } from "./rng.js";

// ──────────────────────────────────────────────────────────────────────────
// 윈도 난수 조립 (부록 B) — 게임 서버·settler·검증기·골든 재생이 모두 이 함수로 윈도 w의 스트림을 만든다.
// 결과를 정하는 코드라 엔진 안에 둔다: engineVersionHash(= 체인 rulesHash의 한쪽)가 이 파일을 덮는다(리뷰 rev6 M-3, D161).
// HMAC-SHA256은 protocol의 hmacSha256(@noble/hashes)이고, 그 파일(protocol/src/crypto.ts)도 엔진 해시에 들어간다(scripts/emit-build-info.mjs).
// ──────────────────────────────────────────────────────────────────────────

/** HMAC-SHA256 (@noble/hashes — Node·브라우저 같은 값). 스트림 팩토리에 주입한다. */
export const windowHmac: HmacSha256 = hmacSha256;

/** 윈도 w의 스트림 팩토리: K(ρ, w) = HMAC-SHA256(seed, "PIKIT/win/v2" ‖ chainId ‖ shop ‖ ρ ‖ w ‖ blockHash). */
export function windowRngFactory(seed: Uint8Array, chainId: number, shop: Uint8Array, roomId: number, window: number, blockHash: Uint8Array): RngFactory {
  return createStreamFactory(windowHmac, windowHmac(seed, windowKeyMessage(chainId, shop, roomId, window, blockHash)));
}

/** windowRngFactory와 같은 키를 처음 쓰일 때 계산한다(곡괭이가 없어 무작위를 쓰지 않는 윈도는 시드·블록 해시가 필요 없다). */
export function lazyWindowRng(seed: () => Uint8Array, chainId: number, shop: Uint8Array, roomId: number, window: number, blockHash: () => Uint8Array): RngFactory {
  let inner: RngFactory | null = null;
  return (label) => {
    inner ??= windowRngFactory(seed(), chainId, shop, roomId, window, blockHash());
    return inner(label);
  };
}
