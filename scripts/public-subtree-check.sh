#!/usr/bin/env bash
# 공개 검증기 묶음이 혼자 빌드·실행되는지 확인한다 (명세 17 P0-16 e).
# 커밋된 packages/{engine,protocol,verifier} + apps/verifier-cli (+ tsconfig.base.json, .nvmrc)만 임시 폴더로 꺼내
# (git archive — 작업 중 파일·dist·node_modules·.env는 들어가지 않는다), 새 pnpm 작업공간을 만들어 설치·빌드하고
# 골든 재생 3개 + 데모 묶음 검증(정직 = 0, 위조 지급 기록 = 1)을 돌린다. DB·env 파일·비공개 패키지 없이 되어야 한다.
#   사용: scripts/public-subtree-check.sh [git-rev]   (기본 HEAD)
#   PUBLIC_CHECK_OFFLINE=1 이면 pnpm 저장소 캐시에서만 설치한다(네트워크 없이).
#   PUBLIC_CHECK_KEEP=1 이면 임시 폴더를 지우지 않고 경로를 알려 준다.
set -euo pipefail

REV="${1:-HEAD}"
ROOT="$(git rev-parse --show-toplevel)"
PATHS=(packages/engine packages/protocol packages/verifier apps/verifier-cli tsconfig.base.json .nvmrc)
TMP="$(mktemp -d "${TMPDIR:-/tmp}/pikit-public-verifier.XXXXXX")"
cleanup() { if [[ "${PUBLIC_CHECK_KEEP:-0}" == "1" ]]; then echo "kept: $TMP"; else rm -rf "$TMP"; fi; }
trap cleanup EXIT

echo "== export ${PATHS[*]} @ $(git -C "$ROOT" rev-parse --short "$REV") → $TMP"
git -C "$ROOT" archive --format=tar "$REV" -- "${PATHS[@]}" | tar -x -C "$TMP"

# 의존성: @pikit/* 는 이 넷끼리만, 나머지는 공개 npm 패키지여야 한다
node - "$TMP" <<'EOF'
const { readFileSync } = require("node:fs");
const { join } = require("node:path");
const dir = process.argv[2];
const own = new Set(["@pikit/engine", "@pikit/protocol", "@pikit/verifier", "@pikit/verifier-cli"]);
let bad = 0;
for (const p of ["packages/engine", "packages/protocol", "packages/verifier", "apps/verifier-cli"]) {
  const pkg = JSON.parse(readFileSync(join(dir, p, "package.json"), "utf8"));
  for (const [name, v] of Object.entries({ ...pkg.dependencies, ...pkg.devDependencies })) {
    if (name.startsWith("@pikit/") && !own.has(name)) { console.error(`✘ ${p} depends on ${name} (not in the public set)`); bad++; }
    if (!name.startsWith("@pikit/") && !/^[0-9]+\.[0-9]+\.[0-9]+$/.test(v)) { console.error(`✘ ${p}: ${name}@${v} is not an exact public version`); bad++; }
  }
}
if (bad) process.exit(1);
console.log("✔ dependencies: only the four public packages + exact public npm versions");
EOF

cat > "$TMP/package.json" <<'EOF'
{
  "name": "pikit-verifier-public",
  "private": true,
  "type": "module",
  "packageManager": "pnpm@10.33.0",
  "engines": { "node": ">=24.21.0 <25" },
  "scripts": {
    "build": "pnpm -r build",
    "test": "pnpm -r build && pnpm --filter @pikit/verifier --filter @pikit/verifier-cli test"
  }
}
EOF
printf 'packages:\n  - packages/engine\n  - packages/protocol\n  - packages/verifier\n  - apps/verifier-cli\n' > "$TMP/pnpm-workspace.yaml"
printf 'engine-strict=true\nsave-exact=true\n' > "$TMP/.npmrc"

cd "$TMP"
echo "== pnpm install"
if [[ "${PUBLIC_CHECK_OFFLINE:-0}" == "1" ]]; then pnpm install --offline --reporter=silent; else pnpm install --reporter=silent; fi
echo "== pnpm --filter @pikit/verifier-cli... build (PUBLIC.md §1)"
pnpm --filter "@pikit/verifier-cli..." build >/dev/null

CLI="node apps/verifier-cli/dist/main.js"
DEMO_SHOP=0x5b0b000000000000000000000000000000000005   # packages/verifier/test/demo-bundle.ts SHOP — verify needs the shop pinned (D162)
CAT=packages/protocol/catalog.example.json
FIX=packages/verifier/test/fixtures
for g in 1 2 3; do
  $CLI --catalog "$CAT" --log "$FIX/golden-$g.log.json" --expect "$FIX/golden-$g.expected.json" | grep '^OK: matches expected final state hash' >/dev/null
  echo "✔ golden-$g"
done

node packages/verifier/dist/test/demo-bundle.js demo >/dev/null
$CLI verify --shop "$DEMO_SHOP" --epoch 7 --dir demo 2>/dev/null | grep -q '^OK: ' || { echo "✘ demo bundle does not verify"; exit 1; }
echo "✔ demo bundle verifies (exit 0)"
$CLI verify --shop "$DEMO_SHOP" --epoch 7 --dir demo --from-snapshot 3 2>/dev/null | grep -q '^OK: ' || { echo "✘ demo bundle from snapshot 3 does not verify"; exit 1; }
echo "✔ demo bundle from snapshot 3 (exit 0)"
node packages/verifier/dist/test/demo-bundle.js forged nosettle >/dev/null
if $CLI verify --shop "$DEMO_SHOP" --epoch 7 --dir forged >/dev/null 2>&1; then echo "✘ a forged payout record passed"; exit 1; fi
echo "✔ forged payout record fails (exit 1)"

ENGINE="$(node --input-type=module -e 'import { engineVersionHash } from "./packages/engine/dist/src/index.js"; console.log(engineVersionHash())')"
echo "engineVersionHash (isolated build): $ENGINE"
if [[ -f "$ROOT/packages/engine/dist/src/index.js" ]]; then
  MONO="$(cd "$ROOT" && node --input-type=module -e 'import { engineVersionHash } from "./packages/engine/dist/src/index.js"; console.log(engineVersionHash())')"
  [[ "$ENGINE" == "$MONO" ]] && echo "✔ same engineVersionHash as the monorepo build" || { echo "✘ engineVersionHash differs from the monorepo build ($MONO)"; exit 1; }
fi
echo "OK: the public verifier builds and runs alone (no DB, no env file, no private package)"
