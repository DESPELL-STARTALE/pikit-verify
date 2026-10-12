// Foundry 산출물(contracts/out)에서 컨트랙트 ABI를 꺼내 packages/protocol에 적는다.
//   abi/<Contract>.json      — 다른 언어·도구용 원본 ABI
//   src/abi.generated.ts     — viem이 타입을 추론할 수 있는 `as const` 사본
// 쓰는 법: `pnpm --filter @pikit/protocol abi:export` (먼저 contracts에서 `forge build`).
// `--check`: 파일을 쓰지 않고 지금 파일이 산출물과 같은지만 본다(다르면 종료 코드 1). contracts/out이 없으면 건너뛴다.
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const out = join(root, "..", "..", "contracts", "out");
// 개정 5(D105): PikitVault는 PikitShop에 합쳐져 없다 — abi/PikitVault.json도 지운다(STALE에서 확인).
const CONTRACTS = [
  ["PikitShop", "pikitShopAbi"],
  ["PikitFairness", "pikitFairnessAbi"],
];
const STALE = ["PikitVault"];
const check = process.argv.includes("--check");

if (!existsSync(out)) {
  if (check) {
    console.log("export-abi --check: contracts/out not found (run forge build); skipped");
    process.exit(0);
  }
  console.error("export-abi: contracts/out not found — run `forge build` in contracts/ first");
  process.exit(1);
}

let ts = "// 자동 생성 파일 — 고치지 말 것. `pnpm --filter @pikit/protocol abi:export`가 contracts/out(Foundry)에서 만든다.\n";
ts += "// 컨트랙트가 진실이다(DECISIONS D53). 원본 JSON은 packages/protocol/abi/*.json.\n\n";
const files = {};
for (const [name, constName] of CONTRACTS) {
  const artifact = JSON.parse(readFileSync(join(out, `${name}.sol`, `${name}.json`), "utf8"));
  const json = `${JSON.stringify(artifact.abi, null, 2)}\n`;
  files[join(root, "abi", `${name}.json`)] = json;
  ts += `export const ${constName} = ${JSON.stringify(artifact.abi, null, 2)} as const;\n\n`;
}
files[join(root, "src", "abi.generated.ts")] = ts;

let stale = 0;
for (const name of STALE) {
  const path = join(root, "abi", `${name}.json`);
  if (!existsSync(path)) continue;
  if (check) {
    console.error(`export-abi --check: ${path} belongs to a removed contract — run pnpm --filter @pikit/protocol abi:export`);
    stale++;
  } else {
    rmSync(path);
    console.log(`removed ${path}`);
  }
}
for (const [path, content] of Object.entries(files)) {
  const current = existsSync(path) ? readFileSync(path, "utf8") : "";
  if (current === content) continue;
  if (check) {
    console.error(`export-abi --check: ${path} is stale — run pnpm --filter @pikit/protocol abi:export`);
    stale++;
  } else {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, content);
    console.log(`wrote ${path}`);
  }
}
process.exit(stale ? 1 : 0);
