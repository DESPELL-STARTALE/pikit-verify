import type { TrustPins } from "@pikit/verifier";

// ──────────────────────────────────────────────────────────────────────────
// 신뢰 뿌리 (리뷰 rev6 M-4, D162). 검증하는 사람이 운영자 파일 밖에서 얻은 값만 믿는다:
//   --shop <주소>        지갑이 서명한 SessionGrant의 verifyingContract, 탐색기, 웹 /rules에서 확인한 PikitShop 주소
//   --trust <파일>       { shop, chainId?, fairness?, seedRoot?, engineVersionHash? } — 따로 받은(공개 검증 저장소 등) 고정 값
//   둘 다 주면 shop이 같아야 한다. 하나도 없으면 사용법 오류 — world.json의 shop을 그대로 믿지 않는다.
// RPC 두 곳은 서로 다른 호스트여야 한다(같은 곳을 두 번 읽는 "교차 확인"은 아무것도 확인하지 않는다).
// ──────────────────────────────────────────────────────────────────────────

const ADDRESS = /^0x[0-9a-fA-F]{40}$/;
const BYTES32 = /^0x[0-9a-fA-F]{64}$/;

/** --shop·--trust → TrustPins (주소·해시는 소문자). 잘못되면 던진다(사용법 오류). */
export function trustPins(shop: string | undefined, trustFile: unknown): TrustPins {
  let fromFile: Partial<TrustPins> = {};
  if (trustFile !== undefined) {
    const t = trustFile as Record<string, unknown>;
    if (!t || typeof t !== "object" || Array.isArray(t)) throw new Error("--trust: the file must be a JSON object { shop, chainId?, fairness?, seedRoot?, engineVersionHash? }");
    const allowed = new Set(["shop", "chainId", "fairness", "seedRoot", "engineVersionHash"]);
    for (const k of Object.keys(t)) if (!allowed.has(k)) throw new Error(`--trust: unknown field ${k}`);
    if (typeof t.shop !== "string" || !ADDRESS.test(t.shop)) throw new Error("--trust: shop must be a 0x-prefixed 20-byte address");
    if (t.chainId !== undefined && !(Number.isSafeInteger(t.chainId) && (t.chainId as number) > 0)) throw new Error("--trust: chainId must be a positive integer");
    if (t.fairness !== undefined && (typeof t.fairness !== "string" || !ADDRESS.test(t.fairness))) throw new Error("--trust: fairness must be an address");
    for (const k of ["seedRoot", "engineVersionHash"] as const) {
      if (t[k] !== undefined && (typeof t[k] !== "string" || !BYTES32.test(t[k] as string))) throw new Error(`--trust: ${k} must be a 0x-prefixed 32-byte hex`);
    }
    fromFile = {
      shop: t.shop.toLowerCase(),
      ...(t.chainId !== undefined ? { chainId: t.chainId as number } : {}),
      ...(t.fairness !== undefined ? { fairness: (t.fairness as string).toLowerCase() } : {}),
      ...(t.seedRoot !== undefined ? { seedRoot: (t.seedRoot as string).toLowerCase() } : {}),
      ...(t.engineVersionHash !== undefined ? { engineVersionHash: (t.engineVersionHash as string).toLowerCase() } : {}),
    };
  }
  if (shop !== undefined && !ADDRESS.test(shop)) throw new Error("--shop must be a 0x-prefixed 20-byte address");
  const pinned = shop?.toLowerCase() ?? fromFile.shop;
  if (pinned === undefined) {
    throw new Error("give the PikitShop address you trust: --shop <address> (or --trust <file>). It is not taken from the operator's world.json");
  }
  if (shop !== undefined && fromFile.shop !== undefined && fromFile.shop !== pinned) throw new Error(`--shop ${pinned} and --trust shop ${fromFile.shop} differ`);
  return { ...fromFile, shop: pinned };
}

/** RPC URL들의 호스트 이름 (소문자, 끝 점·www. 없이). 두 곳이 같은 호스트면 던진다(사용법 오류). URL 자체는 돌려주지 않는다(키가 들어 있을 수 있다). */
export function rpcHosts(urls: readonly string[]): string[] {
  const hosts = urls.map((u) => {
    let h: string;
    try {
      h = new URL(u).hostname;
    } catch {
      throw new Error(`--rpc: not a URL (#${urls.indexOf(u) + 1})`);
    }
    return h.toLowerCase().replace(/\.+$/, "").replace(/^www\./, "");
  });
  if (hosts.length === 2 && hosts[0] === hosts[1]) {
    throw new Error(`--rpc: both endpoints are ${hosts[0]} — reading the same host twice cross-checks nothing; give two different providers`);
  }
  return hosts;
}
