// ledgerVersionHash (D199): build-info.ts가 소스와 맞는지(--check), 덮는 파일, 해시 밖 코드를 값으로 가져오면 스크립트가 실패하는지.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";
import { LEDGER_HASHED_FILES, LEDGER_SOURCE_HASH, LEDGER_VERSION_HASH } from "../../src/index.js";

const PKG = fileURLToPath(new URL("../../../", import.meta.url));   // packages/verifier
const SCRIPT = join(PKG, "scripts", "emit-ledger-info.mjs");

describe("ledger build info", () => {
  it("--check: the committed build-info.ts matches the sources", () => {
    const r = spawnSync(process.execPath, [SCRIPT, "--check"], { encoding: "utf8" });
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, new RegExp(LEDGER_VERSION_HASH));
    assert.match(LEDGER_VERSION_HASH, /^0x[0-9a-f]{64}$/);
    assert.match(LEDGER_SOURCE_HASH, /^0x[0-9a-f]{64}$/);
  });

  it("covers ledger/rules/** and protocol ledger.ts + input-log.ts closure — not the file shapes, io, replay or the engine", () => {
    for (const f of ["verifier/src/ledger/rules/apply.ts", "verifier/src/ledger/rules/state.ts", "protocol/src/ledger.ts", "protocol/src/input-log.ts", "protocol/src/crypto.ts", "protocol/src/primitives.ts"]) {
      assert.ok(LEDGER_HASHED_FILES.includes(f), f);
    }
    for (const f of LEDGER_HASHED_FILES) assert.doesNotMatch(f, /ledger-files\.ts|ledger\/io\/|ledger\/replay\.ts|ledger\/check\.ts|engine\//, f);
  });

  it("fails when a rule file imports code outside the hash by value", () => {
    const root = mkdtempSync(join(tmpdir(), "ledger-info-"));
    try {
      const v = join(root, "packages", "verifier");
      mkdirSync(join(v, "src", "ledger"), { recursive: true });
      cpSync(join(PKG, "scripts"), join(v, "scripts"), { recursive: true });
      cpSync(join(PKG, "src", "ledger", "rules"), join(v, "src", "ledger", "rules"), { recursive: true });
      cpSync(join(PKG, "package.json"), join(v, "package.json"));
      symlinkSync(join(PKG, "node_modules"), join(v, "node_modules"), "dir");
      cpSync(join(PKG, "..", "protocol", "src"), join(root, "packages", "protocol", "src"), { recursive: true });
      const run = () => spawnSync(process.execPath, [join(v, "scripts", "emit-ledger-info.mjs")], { encoding: "utf8" });
      assert.equal(run().status, 0, "the copy builds as is");
      assert.equal(readFileSync(join(v, "src", "ledger", "build-info.ts"), "utf8").includes(LEDGER_VERSION_HASH), true, "same hash from a copy");
      const apply = join(v, "src", "ledger", "rules", "apply.ts");
      const src = readFileSync(apply, "utf8");
      for (const [bad, why] of [
        ['import { LedgerRejectReason } from "@pikit/protocol";\n', /LedgerRejectReason is outside the hashed protocol files/],
        ['import { checkLedgerInvariants } from "../check.js";\n', /from outside ledger\/rules/],
        ['import { keccak256 } from "viem";\n', /imports viem by value/],
      ] as const) {
        writeFileSync(apply, bad + src);
        const r = run();
        assert.equal(r.status, 1, bad);
        assert.match(r.stderr, why);
      }
      writeFileSync(apply, 'import type { Hex } from "viem";\n' + src);
      assert.equal(run().status, 0, "type-only imports are fine");
      assert.notEqual(readFileSync(join(v, "src", "ledger", "build-info.ts"), "utf8").includes(LEDGER_VERSION_HASH), true, "any rule edit changes the hash");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
