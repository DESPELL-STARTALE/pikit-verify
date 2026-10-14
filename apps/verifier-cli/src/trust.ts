import type { LedgerTrustPins } from "@pikit/verifier";

// ──────────────────────────────────────────────────────────────────────────
// 신뢰 뿌리 (리뷰 rev6 M-4, D162 → 개정 7 D205). 검증하는 사람이 운영자 파일 밖에서 얻은 값만 믿는다:
//   --contract <주소>    지갑이 서명한 LedgerSession의 verifyingContract, 탐색기, 웹 /rules, deploy/mainnet/DEPLOYMENT.md에서 확인한 PikitLedger 주소
//   --trust <파일>       { contract, chainId?, ledgerHash?, rulesHash? } — 따로 받은(공개 검증 저장소 등) 고정 값, 준 값은 모두 체인과 대조
//   둘 다 주면 contract가 같아야 한다. 하나도 없으면 사용법 오류 — world.json의 shop(= PikitLedger 주소)을 그대로 믿지 않는다.
// RPC 두 곳은 서로 다른 호스트여야 한다(같은 곳을 두 번 읽는 "교차 확인"은 아무것도 확인하지 않는다).
// ──────────────────────────────────────────────────────────────────────────

const ADDRESS = /^0x[0-9a-fA-F]{40}$/;
const BYTES32 = /^0x[0-9a-fA-F]{64}$/;

/** --contract·--trust → LedgerTrustPins (주소·해시는 소문자). 잘못되면 던진다(사용법 오류). */
export function trustPins(contract: string | undefined, trustFile: unknown): LedgerTrustPins {
  let fromFile: Partial<LedgerTrustPins> = {};
  if (trustFile !== undefined) {
    const t = trustFile as Record<string, unknown>;
    if (!t || typeof t !== "object" || Array.isArray(t)) throw new Error("--trust: the file must be a JSON object { contract, chainId?, ledgerHash?, rulesHash? }");
    const allowed = new Set(["contract", "chainId", "ledgerHash", "rulesHash"]);
    for (const k of Object.keys(t)) if (!allowed.has(k)) throw new Error(`--trust: unknown field ${k}`);
    if (typeof t.contract !== "string" || !ADDRESS.test(t.contract)) throw new Error("--trust: contract must be a 0x-prefixed 20-byte address (the PikitLedger)");
    if (t.chainId !== undefined && !(Number.isSafeInteger(t.chainId) && (t.chainId as number) > 0)) throw new Error("--trust: chainId must be a positive integer");
    for (const k of ["ledgerHash", "rulesHash"] as const) {
      if (t[k] !== undefined && (typeof t[k] !== "string" || !BYTES32.test(t[k] as string))) throw new Error(`--trust: ${k} must be a 0x-prefixed 32-byte hex`);
    }
    fromFile = {
      contract: t.contract.toLowerCase(),
      ...(t.chainId !== undefined ? { chainId: t.chainId as number } : {}),
      ...(t.ledgerHash !== undefined ? { ledgerHash: (t.ledgerHash as string).toLowerCase() } : {}),
      ...(t.rulesHash !== undefined ? { rulesHash: (t.rulesHash as string).toLowerCase() } : {}),
    };
  }
  if (contract !== undefined && !ADDRESS.test(contract)) throw new Error("--contract must be a 0x-prefixed 20-byte address");
  const pinned = contract?.toLowerCase() ?? fromFile.contract;
  if (pinned === undefined) {
    throw new Error("give the PikitLedger address you trust: --contract <address> (or --trust <file>). It is not taken from the operator's world.json");
  }
  if (contract !== undefined && fromFile.contract !== undefined && fromFile.contract !== pinned) throw new Error(`--contract ${pinned} and --trust contract ${fromFile.contract} differ`);
  return { ...fromFile, contract: pinned };
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
