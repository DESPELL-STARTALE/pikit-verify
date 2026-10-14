// 장부 빌드 정보(src/ledger/build-info.ts)를 만든다 — PikitLedger 생성자 불변값 ledgerHash = LEDGER_VERSION_HASH (계획 §2.1, D192·D199).
//   엔진 해시(packages/engine/scripts/emit-build-info.mjs)와 같은 방식이다. 덮는 파일 (결과를 정하는 장부 코드 — D161 원칙):
//     verifier/src/ledger/rules/**/*.ts
//     + protocol/src의 LEDGER_PROTOCOL_FILES와 그 파일들이 상대 경로로 가져오는 protocol 파일 전부(닫힘) — 서명 형식·다이제스트·잎·루트·상수
//       (ledger.ts), 방-윈도 상한(input-log.ts MAX_INPUTS_PER_ROOM_WINDOW), 그 닫힘(primitives·crypto·canonical).
//   엔진(@pikit/engine)에서 가져오는 값(linkedInputs·InputScheduler)은 engineVersionHash가 덮고 체인 rulesHash가 고정한다 — 여기서 다시 해시하지 않는다.
//   안전장치 (하나라도 어기면 실패):
//     · rules 파일이 값으로(타입 아님) 가져오는 곳은 "@pikit/protocol"·"@pikit/engine"·rules 폴더 안 상대 경로뿐이다
//       (rules 밖 verifier 파일·viem·zod·node: 를 값으로 가져오면 그 코드가 해시 밖에서 결과를 바꿀 수 있다). `import type`은 어디서든 된다.
//     · "@pikit/protocol"에서 값으로 가져오는 이름은 모두 덮는 protocol 파일 안에서 export돼야 한다 (ledger-files.ts 같은 해시 밖 파일은 타입만).
//     · 동적 import·require 금지.
//   LEDGER_SOURCE_HASH  = keccak256( 경로 순으로 정렬한 파일마다 utf8(경로 "verifier/src/ledger/rules/…"·"protocol/src/…") ‖ 0x00 ‖ utf8(내용, 줄끝 LF) ‖ 0x00 )
//   LEDGER_VERSION_HASH = keccak256( utf8(`${verifier package.json version}+${LEDGER_SOURCE_HASH}`) )
// 사용: node scripts/emit-ledger-info.mjs          → 파일을 (바뀌었으면) 다시 쓴다 (build 단계)
//       node scripts/emit-ledger-info.mjs --check  → 커밋된 파일이 소스와 맞지 않으면 실패 (lint 단계)
import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { keccak256, stringToBytes } from "viem";

/** 장부 규칙이 값으로 쓰는 protocol 파일 (닫힘은 아래에서 따라간다). */
export const LEDGER_PROTOCOL_FILES = ["ledger.ts", "input-log.ts"];

const root = fileURLToPath(new URL("..", import.meta.url));
const packagesDir = join(root, "..");
const ledgerDir = join(root, "src", "ledger");
const rulesDir = join(ledgerDir, "rules");
const protocolSrc = join(packagesDir, "protocol", "src");
const outFile = join(ledgerDir, "build-info.ts");
const version = JSON.parse(readFileSync(join(root, "package.json"), "utf8")).version;
const read = (p) => readFileSync(p, "utf8").replace(/\r\n/g, "\n");
const rel = (p) => relative(packagesDir, p).split(sep).join("/");

function walk(dir) {
  return readdirSync(dir).flatMap((name) => {
    const p = join(dir, name);
    return statSync(p).isDirectory() ? walk(p) : p.endsWith(".ts") ? [p] : [];
  });
}

function protocolClosure() {
  const seen = new Set();
  const queue = LEDGER_PROTOCOL_FILES.map((f) => join(protocolSrc, f));
  while (queue.length > 0) {
    const p = queue.pop();
    if (seen.has(p)) continue;
    if (!existsSync(p)) throw new Error(`emit-ledger-info: ${rel(p)} is missing`);
    seen.add(p);
    for (const m of read(p).matchAll(/from\s+["'](\.\.?\/[^"']+)\.js["']/g)) queue.push(join(dirname(p), `${m[1]}.ts`));
  }
  return [...seen];
}

const ruleFiles = walk(rulesDir);
const protocolFiles = protocolClosure();

const problems = [];
const covered = new Set();
for (const p of protocolFiles) {
  for (const m of read(p).matchAll(/^export\s+(?:async\s+)?(?:const|function|class|let|enum)\s+([A-Za-z0-9_$]+)/gm)) covered.add(m[1]);
}
for (const p of ruleFiles) {
  const src = read(p);
  const where = relative(root, p).split(sep).join("/");
  if (/\brequire\s*\(|\bimport\s*\(/.test(src)) problems.push(`${where}: dynamic import/require`);
  for (const m of src.matchAll(/^\s*(import|export)\s+(type\s+)?([^;]*?)\s*from\s*["']([^"']+)["']/gm)) {
    const [, , typeOnly, what, spec] = m;
    if (typeOnly) continue;
    if (spec.startsWith(".")) {
      const target = join(dirname(p), spec.replace(/\.js$/, ".ts"));
      if (!target.startsWith(rulesDir + sep)) problems.push(`${where}: imports ${spec} by value from outside ledger/rules`);
      continue;
    }
    if (spec !== "@pikit/protocol" && spec !== "@pikit/engine") {
      problems.push(`${where}: imports ${spec} by value (only @pikit/protocol, @pikit/engine and ledger/rules files; use \`import type\` for types)`);
      continue;
    }
    if (spec !== "@pikit/protocol") continue;
    const names = /^\{([\s\S]*)\}$/.exec(what.trim());
    if (!names) {
      problems.push(`${where}: namespace/default import of ${spec}`);
      continue;
    }
    for (const raw of names[1].split(",")) {
      const name = raw.trim();
      if (name === "" || name.startsWith("type ")) continue;
      const local = name.split(/\s+as\s+/)[0];
      if (!covered.has(local)) problems.push(`${where}: @pikit/protocol value ${local} is outside the hashed protocol files — add its file to LEDGER_PROTOCOL_FILES or import it as a type`);
    }
  }
  for (const m of src.matchAll(/^\s*import\s+["']([^"']+)["']/gm)) problems.push(`${where}: side-effect import ${m[1]}`);
}
if (problems.length > 0) {
  console.error(`emit-ledger-info: ledger rules import code outside the ledger hash:\n  ${problems.join("\n  ")}`);
  process.exit(1);
}

const files = [...ruleFiles, ...protocolFiles].map((p) => ({ rel: rel(p), p })).sort((a, b) => (a.rel < b.rel ? -1 : 1));
const chunks = [];
for (const f of files) chunks.push(f.rel, "\0", read(f.p), "\0");
const sourceHash = keccak256(stringToBytes(chunks.join("")));
const versionHash = keccak256(stringToBytes(`${version}+${sourceHash}`));

const content = `// 자동 생성 — packages/verifier/scripts/emit-ledger-info.mjs (손으로 고치지 않는다). 장부 규칙(src/ledger/rules/**)이나 덮는 protocol 파일이 바뀌면 build가 다시 쓴다.
// LEDGER_VERSION_HASH = PikitLedger 생성자 불변값 ledgerHash (D192·D199).
export const LEDGER_VERSION = ${JSON.stringify(version)};
export const LEDGER_SOURCE_HASH = ${JSON.stringify(sourceHash)};
export const LEDGER_VERSION_HASH = ${JSON.stringify(versionHash)};
/** 해시가 덮는 파일 (packages/ 기준, 경로 순). */
export const LEDGER_HASHED_FILES: readonly string[] = ${JSON.stringify(files.map((f) => f.rel))};
`;

const current = existsSync(outFile) ? readFileSync(outFile, "utf8") : "";
if (process.argv.includes("--check")) {
  if (current !== content) {
    console.error(`emit-ledger-info: src/ledger/build-info.ts is stale (expected ledgerVersionHash ${versionHash}). Run \`pnpm --filter @pikit/verifier build\` and commit it.`);
    process.exit(1);
  }
  console.log(`emit-ledger-info: up to date (${versionHash})`);
} else if (current !== content) {
  writeFileSync(outFile, content);
  console.log(`emit-ledger-info: wrote ${versionHash} (${ruleFiles.length} rule + ${protocolFiles.length} protocol files)`);
} else {
  console.log(`emit-ledger-info: up to date (${versionHash})`);
}
