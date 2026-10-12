// 엔진 빌드 정보(src/build-info.ts)를 만든다 — 체인 rulesHash = keccak256(catalogHash ‖ engineVersionHash) (Q5, DECISIONS D41).
//   덮는 파일 (D161, 리뷰 rev6 M-3 — 결과를 정하는 코드는 모두 이 해시 안에 있어야 한다):
//     engine/src/**/*.ts (build-info.ts 제외)
//     + protocol/src의 RULE_FILES와 그 파일들이 상대 경로로 가져오는 protocol 파일 전부(닫힘) — 엔진이 실행 중에 쓰는 카탈로그 공식
//       (catalogBaseCeilingMilli·catalogRewardCapMilli·catalogOverCapMilli), HMAC·EPOCH_BLOCKS, 입력 연결 상수(MAX_INPUTS_PER_ROOM_WINDOW·
//       compareInputLinks), 취소 항목 키(itemKeyFromId), T_FREEZE. protocol이 engine을 가져오면 패키지 순환이 생기고 앱·배포 도구가 protocol에서 이 이름들을 가져다 쓰므로
//       파일을 옮기지 않고 해시에 넣는다.
//     안전장치: 엔진 src가 "@pikit/protocol"에서 값으로(타입 아님) 가져오는 이름은 모두 덮는 protocol 파일 안에서 export돼야 한다 — 아니면 실패.
//   ENGINE_SOURCE_HASH  = keccak256( 경로 순으로 정렬한 파일마다 utf8(경로 "engine/src/…"·"protocol/src/…") ‖ 0x00 ‖ utf8(내용, 줄끝 LF) ‖ 0x00 )
//   ENGINE_VERSION_HASH = keccak256( utf8(`${package.json version}+${ENGINE_SOURCE_HASH}`) )
// 사용: node scripts/emit-build-info.mjs          → 파일을 (바뀌었으면) 다시 쓴다 (build 단계)
//       node scripts/emit-build-info.mjs --check  → 커밋된 파일이 소스와 맞지 않으면 실패 (lint 단계)
import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { keccak_256 } from "@noble/hashes/sha3";
import { bytesToHex, utf8ToBytes } from "@noble/hashes/utils";

/** 엔진이 실행 중에 쓰는 protocol 파일 (닫힘은 아래에서 따라간다). */
export const RULE_FILES = ["catalog.ts", "crypto.ts", "eip712.ts", "input-log.ts", "timers.ts"];

const root = fileURLToPath(new URL("..", import.meta.url));
const packagesDir = join(root, "..");
const srcDir = join(root, "src");
const protocolSrc = join(packagesDir, "protocol", "src");
const outFile = join(srcDir, "build-info.ts");
const version = JSON.parse(readFileSync(join(root, "package.json"), "utf8")).version;
const read = (p) => readFileSync(p, "utf8").replace(/\r\n/g, "\n");

function walk(dir) {
  return readdirSync(dir).flatMap((name) => {
    const p = join(dir, name);
    return statSync(p).isDirectory() ? walk(p) : p.endsWith(".ts") ? [p] : [];
  });
}

/** RULE_FILES + 그 파일들의 상대 import("./x.js") 닫힘 (protocol/src 안). */
function protocolClosure() {
  const seen = new Set();
  const queue = RULE_FILES.map((f) => join(protocolSrc, f));
  while (queue.length > 0) {
    const p = queue.pop();
    if (seen.has(p)) continue;
    if (!existsSync(p)) throw new Error(`emit-build-info: ${relative(packagesDir, p)} is missing`);
    seen.add(p);
    for (const m of read(p).matchAll(/from\s+["'](\.\.?\/[^"']+)\.js["']/g)) queue.push(join(dirname(p), `${m[1]}.ts`));
  }
  return [...seen];
}

const engineFiles = walk(srcDir).filter((p) => p !== outFile);
const protocolFiles = protocolClosure();

// 안전장치: 엔진이 protocol에서 값으로 가져오는 이름은 덮는 파일에 있어야 한다
const covered = new Set();
for (const p of protocolFiles) {
  for (const m of read(p).matchAll(/^export\s+(?:const|function|class|let)\s+([A-Za-z0-9_$]+)/gm)) covered.add(m[1]);
}
const uncovered = [];
for (const p of engineFiles) {
  for (const m of read(p).matchAll(/import\s+(?!type\b)\{([^}]*)\}\s*from\s*["']@pikit\/protocol["']/g)) {
    for (const raw of m[1].split(",")) {
      const name = raw.trim();
      if (name === "" || name.startsWith("type ")) continue;
      const local = name.split(/\s+as\s+/)[0];
      if (!covered.has(local)) uncovered.push(`${relative(root, p)}: ${local}`);
    }
  }
}
if (uncovered.length > 0) {
  console.error(`emit-build-info: the engine imports protocol values outside the hashed files — add their file to RULE_FILES:\n  ${uncovered.join("\n  ")}`);
  process.exit(1);
}

const files = [...engineFiles, ...protocolFiles]
  .map((p) => ({ rel: relative(packagesDir, p).split(sep).join("/"), p }))
  .sort((a, b) => (a.rel < b.rel ? -1 : 1));
const h = keccak_256.create();
for (const f of files) {
  h.update(utf8ToBytes(f.rel));
  h.update(new Uint8Array([0]));
  h.update(utf8ToBytes(read(f.p)));
  h.update(new Uint8Array([0]));
}
const sourceHash = `0x${bytesToHex(h.digest())}`;
const versionHash = `0x${bytesToHex(keccak_256(utf8ToBytes(`${version}+${sourceHash}`)))}`;

const content = `// 자동 생성 — packages/engine/scripts/emit-build-info.mjs (손으로 고치지 않는다). 엔진 소스나 덮는 protocol 파일이 바뀌면 build가 다시 쓴다.
export const ENGINE_VERSION = ${JSON.stringify(version)};
export const ENGINE_SOURCE_HASH = ${JSON.stringify(sourceHash)};
export const ENGINE_VERSION_HASH = ${JSON.stringify(versionHash)};
`;

const current = existsSync(outFile) ? readFileSync(outFile, "utf8") : "";
if (process.argv.includes("--check")) {
  if (current !== content) {
    console.error(`emit-build-info: src/build-info.ts is stale (expected engineVersionHash ${versionHash}). Run \`pnpm --filter @pikit/engine build\` and commit it.`);
    process.exit(1);
  }
  console.log(`emit-build-info: up to date (${versionHash})`);
} else if (current !== content) {
  writeFileSync(outFile, content);
  console.log(`emit-build-info: wrote ${versionHash} (${engineFiles.length} engine + ${protocolFiles.length} protocol files)`);
}
