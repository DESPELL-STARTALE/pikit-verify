// 개정 7 데모 검증 묶음 (공개 검증기 CLI 시험·공개 묶음 확인 scripts/public-subtree-check.sh):
//   `node dist/test/ledger-demo-bundle.js <outDir> [cheat]` → <outDir>/{world.json, catalogs/<catalogHash>.json, <e>.json, ledger/<e>.json,
//   snapshots/<e>.json, ledger/leaves/<k>.json, chain.json(pikit.ledger-chain/v1)} — chog.pikit.fun/epochs와 같은 모양(한 폴더).
//   묶음 = ledger-fixture.ts (루트 3개, PikitLedger LEDGER). 검증: `verify --contract <LEDGER> --root latest --from-snapshot genesis --dir <outDir>`.
// 속임(cheat):
//   leaf     잎 파일 0의 잔액 하나를 바꿈 → root 0: leaves file ✘ + root fields(dataHash) ✘
//   missing  ledger/2.json을 지움(오래된 루트 1의 파일) → root 1: files ✘ (체인 끝이 아니다 — 실패)
//   tip      마지막 루트(2)가 방금 실렸고(확정 머리 = 실린 블록 + 50) 그 범위의 4.json이 아직 없음 → 체인 끝 경합(CLI 종료 3)
//   announce 체인의 ANNOUNCE 키가 다른 키 → root 0: list signatures ✘
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { LEDGER, mutateJson, produce } from "./ledger-fixture.js";
import { player } from "./ledger/helpers.js";

export { LEDGER };

export async function writeLedgerDemoBundle(dir: string, cheat?: string): Promise<void> {
  const F = await produce();
  let files = F.files;
  const chain = structuredClone(F.chain);
  if (cheat === "leaf") files = mutateJson(files, "ledger/leaves/0.json", (x) => { x.leaves[0].balanceMilli = String(BigInt(x.leaves[0].balanceMilli) + 1000n); });
  else if (cheat === "missing") { files = new Map(files); files.delete("ledger/2.json"); }
  else if (cheat === "tip") { files = new Map(files); files.delete("4.json"); chain.finalized = chain.roots[2]!.postedBlock + 50; }
  else if (cheat === "announce") { const k = player(77).wallet.address; chain.announcerChanges[0]!.next = k; chain.announcerChanges[1]!.previous = k; }
  else if (cheat !== undefined) throw new Error(`unknown cheat ${cheat}`);
  rmSync(dir, { recursive: true, force: true });
  const put = (rel: string, data: string | Uint8Array) => {
    const p = join(dir, rel);
    mkdirSync(dirname(p), { recursive: true });
    writeFileSync(p, data);
  };
  put("world.json", `${JSON.stringify(F.world, null, 2)}\n`);
  for (const [hash, c] of F.catalogs) put(`catalogs/${hash}.json`, JSON.stringify(c));
  for (const [path, bytes] of files) put(path, bytes);
  put("chain.json", `${JSON.stringify(chain)}\n`);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const out = process.argv[2];
  if (!out) {
    console.error("usage: node ledger-demo-bundle.js <outDir> [leaf|missing|tip|announce]");
    process.exit(2);
  }
  await writeLedgerDemoBundle(out, process.argv[3]);
  console.log(`wrote the rev 7 demo bundle to ${out} (PikitLedger ${LEDGER})`);
}
