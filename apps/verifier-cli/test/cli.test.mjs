// pikit-verify verify --epoch N (H-1): 정직한 데모 묶음은 통과(종료 0), 운영자가 체인과 다르게 넣은 묶음(delay·retier·dropcancel·extra)은
// "입력 = 체인 사건" 검사 하나만 실패(종료 1)하고 어긋남 줄(WINDOW·FIELDS·MISSING·EXTRA)을 낸다. 위조 지급 기록(nosettle·overzero·voidover·
// missingfile, 감사 F-1 ②)은 정산 검사(또는 파일 검사) 하나만 실패(종료 1). 스냅숏 시작·--epoch latest·--purchase. 사용법 오류는 2, 읽기 오류는 1.
// 컴파일하지 않는 시험(node --test) — 빌드된 dist/main.js와 검증기 데모 묶음(packages/verifier/dist/test/demo-bundle.js)을 띄운다.
// RPC 읽기 자체는 검증기 단위 시험(rpc-source.test)과 anvil e2e가 맡는다(여기서는 닿지 않는 RPC의 오류 줄만).
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { fileURLToPath } from "node:url";

import { rpcHosts, trustPins } from "../dist/trust.js";

const CLI = fileURLToPath(new URL("../dist/main.js", import.meta.url));
const SHOP = "0x5b0b000000000000000000000000000000000005";   // 데모 묶음의 상점 (packages/verifier/test/demo-bundle.ts)
const DEMO = fileURLToPath(new URL("../../../packages/verifier/dist/test/demo-bundle.js", import.meta.url));
const root = mkdtempSync(join(tmpdir(), "pikit-verify-cli-"));
after(() => rmSync(root, { recursive: true, force: true }));

/** 데모 묶음을 root/<name>에 쓴다 (cheat = 운영자의 속임). */
function bundle(name, cheat) {
  const dir = join(root, name);
  const r = spawnSync(process.execPath, [DEMO, dir, ...(cheat ? [cheat] : [])], { encoding: "utf8" });
  assert.equal(r.status, 0, r.stderr);
  return dir;
}

/** pikit-verify verify <args> (--shop <데모 상점>을 앞에 붙인다 — 사람이 고정한 상점, D162) */
function run(...args) {
  return runRaw("--shop", SHOP, ...args);
}

/** pikit-verify verify <args> 그대로 */
function runRaw(...args) {
  const r = spawnSync(process.execPath, [CLI, "verify", ...args], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  return { status: r.status, stdout: r.stdout, stderr: r.stderr };
}

/** pikit-verify verify --epoch 7 <args> */
const verify = (...args) => run("--epoch", "7", ...args);

/** ✘ 줄들 (앞 n글자). */
const crosses = (out, n = 40) => out.split("\n").filter((x) => x.startsWith("✘ ")).map((x) => x.slice(0, n));

/** 지금 아무도 듣지 않는 로컬 포트. */
async function closedPort() {
  const srv = createServer();
  await new Promise((r) => srv.listen(0, "127.0.0.1", r));
  const { port } = srv.address();
  await new Promise((r) => srv.close(r));
  return port;
}

describe("pikit-verify verify --epoch 7 (demo bundle: 2 rooms, 7 epochs)", () => {
  let honest;
  before(() => {
    honest = bundle("honest");
  });

  it("honest bundle: exit 0, the linkage check ✔, every chain input at its window; a chain.json file draws the operator's-word warning", () => {
    const r = verify("--dir", honest);
    assert.equal(r.status, 0, r.stdout + r.stderr);
    assert.match(r.stdout, /^✔ inputs = chain events \(block b → window b \+ 1/m);
    assert.match(r.stdout, /^linkage +(\d+)\/\1 chain inputs at their window, 0 pending past window 2399 \(room-window cap\), 0 mismatched, 0 rule problems$/m);
    assert.match(r.stdout, /^chain values +file .*chain\.json \(operator-supplied\), events through block \d+$/m);
    assert.match(r.stdout, /^OK: \d+ checks passed, 7 anchors matched$/m);
    assert.match(r.stderr, /^warning: chain values from .*chain\.json are the operator's word.*--rpc <url>/m);
  });

  it("--json prints the whole report, linkage included", () => {
    const r = verify("--dir", honest, "--json");
    assert.equal(r.status, 0, r.stderr);
    const rep = JSON.parse(r.stdout);
    assert.equal(rep.ok, true);
    assert.ok(rep.linkage.checked > 200 && rep.linkage.matched === rep.linkage.checked, JSON.stringify(rep.linkage).slice(0, 300));
    assert.deepEqual([rep.linkage.mismatches, rep.linkage.problems, rep.linkage.pending], [[], [], 0]);
    assert.ok(rep.checks.some((c) => c.name.startsWith("inputs = chain events") && c.ok));
  });

  it("--epochs <dir> reads <dir>/<n>.json: the game-server INPUT_LOG_DIR layout (world.json, catalogs/ and <n>.json in one folder)", () => {
    const flat = join(root, "input-log-dir");
    cpSync(join(honest, "epochs"), flat, { recursive: true });
    cpSync(join(honest, "world.json"), join(flat, "world.json"));
    cpSync(join(honest, "catalogs"), join(flat, "catalogs"), { recursive: true });
    const r = verify("--dir", flat, "--epochs", flat, "--chain", join(honest, "chain.json"));
    assert.equal(r.status, 0, r.stdout + r.stderr);
    const missing = verify("--dir", flat, "--chain", join(honest, "chain.json"));
    assert.equal(missing.status, 1, "default <dir>/epochs does not exist there: every epoch file is missing");
    assert.match(missing.stdout, /^✘ every referenced epoch file \(and the start snapshot\) is published  — missing: 1\.json, 2\.json/m);
  });

  for (const [cheat, code] of [["delay", "WINDOW"], ["retier", "FIELDS"], ["dropcancel", "MISSING"], ["extra", "EXTRA"]]) {
    it(`operator cheat '${cheat}': exit 1, only the linkage check ✘, a ${code} line; --json linkage.mismatches[0].code = ${code}`, () => {
      const dir = bundle(cheat, cheat);
      const r = verify("--dir", dir);
      assert.equal(r.status, 1, r.stdout + r.stderr);
      assert.deepEqual(r.stdout.split("\n").filter((x) => x.startsWith("✘ ")).map((x) => x.slice(0, 26)), ["✘ inputs = chain events (b"], "only the linkage check fails");
      assert.match(r.stdout, new RegExp(`^  ✘ ${code} room 1 `, "m"));
      assert.match(r.stdout, /^linkage +\d+\/\d+ chain inputs at their window, \d+ pending .*, 1 mismatched, 0 rule problems$/m);
      assert.match(r.stdout, /^FAILED: 1 of \d+ checks failed$/m);
      const json = verify("--dir", dir, "--json");
      assert.equal(json.status, 1);
      const rep = JSON.parse(json.stdout);
      assert.equal(rep.ok, false);
      assert.equal(rep.linkage.mismatches[0].code, code);
    });
  }

  it("usage errors exit 2: --rpc with --chain, an RPC-only flag without --rpc, a bad number, an unknown flag", () => {
    for (const args of [
      ["--rpc", "http://127.0.0.1:1", "--chain", join(honest, "chain.json")],
      ["--through", "3000"],
      ["--rpc", "http://a.example,http://b.example,http://c.example"],
      ["--from-snapshot", "x"],
      ["--from-snapshot", "0"],
      ["--purchase", "1", "--from-snapshot", "2"],
      ["--purchase", "01"],
      ["--rpc", "http://127.0.0.1:1", "--log-chunk", "0"],
      ["--rpc", "http://127.0.0.1:1", "--max-rps", "fast"],
      ["--bogus"],
    ]) {
      const r = verify("--dir", honest, ...args);
      assert.equal(r.status, 2, `${args.join(" ")}: ${r.stderr}`);
      assert.match(r.stderr, /usage: pikit-verify/);
    }
  });

  it("a URL --dir needs --rpc (or an explicit --chain): no chain.json is fetched from the operator's server", () => {
    const r = verify("--dir", "https://files.example/epochs");
    assert.equal(r.status, 2, r.stderr);
  });

  it("an RPC that does not answer: exit 1 and one error line that does not echo the RPC URL (API keys live in URLs)", async () => {
    const r = verify("--dir", honest, "--rpc", `http://127.0.0.1:${await closedPort()}/v2/SECRETKEY?key=QSECRET`, "--json");
    assert.equal(r.status, 1, r.stderr);
    assert.equal(r.stdout, "");
    assert.match(r.stderr, /^pikit-verify: HTTP request failed\. \(ECONNREFUSED\)$/m);
    assert.ok(!r.stderr.includes("SECRETKEY") && !r.stderr.includes("QSECRET"), r.stderr);
  });
});

describe("forged payout records (audit F-1 ②): exit 1, exactly one ✘", () => {
  for (const [cheat, line, detail] of [
    ["nosettle", "✘ settlements: every replayed end has ex", /^  ✘ E12 0:0 OVERDUE: chain none vs replay REWARD 900000\+1491900 \(window \d+\)$/m],
    ["overzero", "✘ settlements: every replayed end has ex", /^  ✘ E12 0:0 AMOUNT: chain REWARD 900000\+0 \(block \d+\) vs replay REWARD 900000\+1491900/m],
    ["voidover", "✘ settlements: every replayed end has ex", /^  ✘ E12 \d+:0 VOID_OVER: chain none vs replay REWARD \d+\+\d+ \(window \d+\)$/m],
    ["missingfile", "✘ every referenced epoch file (and the st", /— missing: 4\.json$/m],
  ]) {
    it(`forged-${cheat}`, () => {
      const dir = bundle(`forged-${cheat}`, cheat);
      const r = verify("--dir", dir);
      assert.equal(r.status, 1, r.stdout + r.stderr);
      assert.deepEqual(crosses(r.stdout).filter((x) => !x.startsWith("✘ E12")), [line.slice(0, 40)]);
      assert.match(r.stdout, detail);
      assert.match(r.stdout, /^FAILED: 1 of \d+ checks failed$/m);
    });
  }
});

describe("snapshot start, latest and purchase (spec 17 P0-16 c)", () => {
  let honest;
  before(() => {
    honest = bundle("honest-snap");
  });

  it("--from-snapshot 3 --epoch 7: exit 0, starts at the anchored snapshot, checks anchors 3…6", () => {
    const r = verify("--dir", honest, "--from-snapshot", "3");
    assert.equal(r.status, 0, r.stdout + r.stderr);
    assert.match(r.stdout, /^epochs +4 … 7 \(windows 1600 … 2399\)$/m);
    assert.match(r.stdout, /^start +snapshot of epoch 3 \(window 1599\) = on-chain anchor 2$/m);
    assert.match(r.stdout, /^✔ start snapshot 3: roomsStateRoot = anchor 2 roomsStateRoot$/m);
    assert.match(r.stdout, /^OK: \d+ checks passed, 4 anchors matched$/m);
  });

  it("--epoch latest --from-snapshot latest on a world younger than a day: from genesis, through the last anchor", () => {
    const r = run("--dir", honest, "--epoch", "latest", "--from-snapshot", "latest");
    assert.equal(r.status, 0, r.stdout + r.stderr);
    assert.match(r.stderr, /epochs 1 … 7 \(no anchored snapshot a day \+ SETTLE_STALL before the end — from genesis\)/);
  });

  it("a tampered snapshot fails its root check; a missing one fails the file check", () => {
    const dir = join(root, "snap-tampered");
    cpSync(honest, dir, { recursive: true });
    const p = join(dir, "epochs", "snapshots", "3.json");
    const snap = JSON.parse(readFileSync(p, "utf8"));
    snap.world.rooms[1].state.pickaxes = snap.world.rooms[1].state.pickaxes.slice(1);
    writeFileSync(p, JSON.stringify(snap));
    const r = verify("--dir", dir, "--from-snapshot", "3");
    assert.equal(r.status, 1);
    assert.deepEqual(crosses(r.stdout, 60), ["✘ start snapshot 3: roomsStateRoot = anchor 2 roomsStateRoot"]);
    rmSync(p);
    const gone = verify("--dir", dir, "--from-snapshot", "3");
    assert.equal(gone.status, 1);
    assert.match(gone.stdout, /— missing: snapshots\/3\.json$/m);
  });

  it("--purchase <id>: the range holding it, and a line per pickaxe (the void over is paid by VoidOverPaid)", () => {
    const chain = JSON.parse(readFileSync(join(honest, "chain.json"), "utf8"));
    const id = chain.voidOverPaid[0].purchaseId;
    const r = run("--dir", honest, "--purchase", id);
    assert.equal(r.status, 0, r.stdout + r.stderr);
    assert.match(r.stdout, /^start +snapshot of epoch 3 /m);
    assert.match(r.stdout, new RegExp(`^  ${id}:0 +REWARD +4500\\.000 +\\d+\\.\\d{3} +\\d+  MATCH VoidOverPaid `, "m"));
  });
});

describe("trust roots (review rev6 M-4, D162)", () => {
  let honest;
  before(() => {
    honest = bundle("honest-trust");
  });

  it("no --shop and no --trust: exit 2 — the shop is never taken from world.json alone", () => {
    const r = runRaw("--epoch", "7", "--dir", honest);
    assert.equal(r.status, 2, r.stdout + r.stderr);
    assert.match(r.stderr, /give the PikitShop address you trust: --shop <address> \(or --trust <file>\)/);
  });

  it("every run prints the trust roots first: chain id, pinned shop, seedRoot, engine, catalog → rules per room", () => {
    const r = verify("--dir", honest);
    assert.equal(r.status, 0, r.stdout + r.stderr);
    const lines = r.stdout.split("\n");
    assert.match(lines[0], /^trust roots /);
    assert.match(r.stdout, /^  chain id +143$/m);
    assert.match(r.stdout, new RegExp(`^  shop +${SHOP} \\(pinned by you\\)$`, "m"));
    assert.match(r.stdout, /^  fairness +not read from the chain$/m, "a chain file has no fairness address");
    assert.match(r.stdout, /^  seedRoot +0x[0-9a-f]{64}$/m);
    assert.match(r.stdout, /^  room 1 +catalog 0x[0-9a-f]{64} → rules 0x[0-9a-f]{64}$/m);
    const json = JSON.parse(verify("--dir", honest, "--json").stdout);
    assert.deepEqual([json.trust.shop, json.trust.shopPinned, json.trust.chainId, json.trust.rooms.length], [SHOP, true, 143, 2]);
  });

  it("a shop other than world.json's (a decoy deployment): exit 1 before any chain or epoch file is read", () => {
    const other = `0x${"5c".repeat(20)}`;
    const r = runRaw("--shop", other, "--epoch", "7", "--dir", honest);
    assert.equal(r.status, 1, r.stdout + r.stderr);
    assert.deepEqual(crosses(r.stdout, 200).map((x) => x.split("  — ")[0]), ["✘ world.shop = the shop you pinned (--shop / --trust)"]);
    assert.match(r.stdout, new RegExp(`world\\.json ${SHOP} vs pinned ${other}`));
    assert.doesNotMatch(r.stderr, /epoch files read/);
  });

  it("--trust <file>: shop from the file; every other value given is checked (chainId, seedRoot, engineVersionHash); --shop must agree", () => {
    const world = JSON.parse(readFileSync(join(honest, "world.json"), "utf8"));
    const file = join(root, "trust.json");
    writeFileSync(file, JSON.stringify({ shop: SHOP.toUpperCase().replace("0X", "0x"), chainId: 143, seedRoot: world.seedRoot, engineVersionHash: world.engineVersionHash }));
    const ok = runRaw("--trust", file, "--epoch", "7", "--dir", honest);
    assert.equal(ok.status, 0, ok.stdout + ok.stderr);
    writeFileSync(file, JSON.stringify({ shop: SHOP, chainId: 10143 }));
    const bad = runRaw("--trust", file, "--epoch", "7", "--dir", honest);
    assert.equal(bad.status, 1);
    assert.deepEqual(crosses(bad.stdout, 30), ["✘ pinned chainId = chain  — pi"]);
    const clash = runRaw("--trust", file, "--shop", `0x${"5c".repeat(20)}`, "--epoch", "7", "--dir", honest);
    assert.equal(clash.status, 2);
    assert.match(clash.stderr, /--shop 0x5c5c.* and --trust shop 0x5b0b.* differ/);
    writeFileSync(file, JSON.stringify({ shop: SHOP, extra: 1 }));
    assert.equal(runRaw("--trust", file, "--epoch", "7", "--dir", honest).status, 2, "unknown fields are refused");
  });

  it("--rpc twice the same host is refused (PoC same-rpc-twice); hostnames are normalised; the report names hosts, never URLs", () => {
    const r = verify("--dir", honest, "--rpc", "http://127.0.0.1:9,http://127.0.0.1:9");
    assert.equal(r.status, 2, r.stderr);
    assert.match(r.stderr, /--rpc: both endpoints are 127\.0\.0\.1 — reading the same host twice cross-checks nothing; give two different providers/);
    assert.equal(verify("--dir", honest, "--rpc", "http://127.0.0.1:8,http://127.0.0.1:9/other").status, 2, "same host, other port or path");
    assert.throws(() => rpcHosts(["https://RPC.Example.com./a?key=1", "https://www.rpc.example.com/b"]), /both endpoints are rpc\.example\.com/);
    assert.deepEqual(rpcHosts(["https://rpc.monad.xyz/KEY", "https://rpc1.monad.xyz"]), ["rpc.monad.xyz", "rpc1.monad.xyz"]);
    assert.deepEqual(rpcHosts(["https://testnet-rpc.monad.xyz", "https://rpc.ankr.com/monad_testnet"]), ["testnet-rpc.monad.xyz", "rpc.ankr.com"]);
    assert.throws(() => rpcHosts(["not a url"]), /not a URL \(#1\)/);
  });

  it("trustPins: --shop or a trust file is required; addresses are lower-cased; bad values are refused", () => {
    assert.throws(() => trustPins(undefined, undefined), /--shop <address>/);
    assert.deepEqual(trustPins(SHOP.replace("5b0b", "5B0B"), undefined), { shop: SHOP });
    assert.throws(() => trustPins("0x1234", undefined), /--shop must be/);
    assert.throws(() => trustPins(undefined, { shop: SHOP, chainId: -1 }), /chainId/);
    assert.throws(() => trustPins(undefined, { shop: SHOP, seedRoot: "0x12" }), /seedRoot/);
    assert.throws(() => trustPins(undefined, [SHOP]), /JSON object/);
  });
});

describe("watcher state: --since-state / --write-state / --max-epochs (review rev6 H-1, D163)", () => {
  let honest;
  let world;
  let anchors;
  before(() => {
    honest = bundle("honest-state");
    world = JSON.parse(readFileSync(join(honest, "world.json"), "utf8"));
    anchors = JSON.parse(readFileSync(join(honest, "chain.json"), "utf8")).anchors;
  });
  const stateFile = (name) => join(root, `${name}.json`);
  const readState = (f) => JSON.parse(readFileSync(f, "utf8"));
  const base = (o) => ({ schema: "pikit.verify-state/v1", chainId: 143, shop: SHOP, engineVersionHash: world.engineVersionHash, openFromWindow: 0, chainThroughBlock: 0, ...o });

  it("no state file: from genesis, and --write-state records where the next run starts", () => {
    const f = stateFile("first");
    const r = run("--epoch", "latest", "--dir", honest, "--since-state", f, "--write-state", f);
    assert.equal(r.status, 0, r.stdout + r.stderr);
    assert.match(r.stderr, /no state file .* verifying from genesis/);
    const s = readState(f);
    assert.equal(s.lastEpoch, 7);
    assert.equal(s.resume, null, "a 7-epoch demo world is younger than SETTLE_STALL: everything stays open, so the next run starts at genesis again");
    assert.ok(s.openFromWindow <= s.chainThroughBlock - 6000);
  });

  it("nothing new on chain: 'up to date', exit 0, the state is written again unchanged", () => {
    const f = stateFile("uptodate");
    const st = base({ lastEpoch: 7, resume: null });
    writeFileSync(f, JSON.stringify(st));
    const r = run("--epoch", "latest", "--dir", honest, "--since-state", f, "--write-state", f);
    assert.equal(r.status, 0, r.stdout + r.stderr);
    assert.match(r.stdout, /^up to date: epoch 7 is the last anchored epoch, already verified/m);
    assert.deepEqual(readState(f), st);
    const json = run("--epoch", "latest", "--dir", honest, "--since-state", f, "--json");
    assert.deepEqual([json.status, JSON.parse(json.stdout).ok, JSON.parse(json.stdout).upToDate], [0, true, true]);
  });

  it("catch-up from a resume anchor to the last anchor (epochs 4…7), anchored root checked; the new state moves on", () => {
    const f = stateFile("resume");
    const a = anchors.find((x) => x.anchorIndex === 2);
    writeFileSync(f, JSON.stringify(base({ lastEpoch: 5, resume: { epoch: 3, anchorIndex: 2, roomsStateRoot: a.roomsStateRoot } })));
    const out = stateFile("resume-out");
    const r = run("--epoch", "latest", "--dir", honest, "--since-state", f, "--write-state", out);
    assert.equal(r.status, 0, r.stdout + r.stderr);
    assert.match(r.stdout, /^start +snapshot of epoch 3 \(window 1599\) = on-chain anchor 2$/m);
    assert.match(r.stdout, /^✔ start anchor 2 = the anchor the previous run resumed from \(verify-state\)$/m);
    assert.equal(readState(out).lastEpoch, 7);
  });

  it("a state whose anchor root differs from the chain: exit 1 and the state file is left alone", () => {
    const f = stateFile("wrongroot");
    const st = base({ lastEpoch: 5, resume: { epoch: 3, anchorIndex: 2, roomsStateRoot: `0x${"0b".repeat(32)}` } });
    writeFileSync(f, JSON.stringify(st));
    const r = run("--epoch", "latest", "--dir", honest, "--since-state", f, "--write-state", f);
    assert.equal(r.status, 1, r.stdout + r.stderr);
    assert.match(r.stdout, /^✘ start anchor 2 = the anchor the previous run resumed from \(verify-state\)/m);
    assert.deepEqual(readState(f), st);
  });

  it("an unpublished epoch file between the state and the head fails the run (no silent skip) and keeps the state", () => {
    const dir = bundle("state-missing", "missingfile");
    const f = stateFile("missing");
    const r = run("--epoch", "latest", "--dir", dir, "--since-state", f, "--write-state", f);
    assert.equal(r.status, 1, r.stdout + r.stderr);
    assert.match(r.stdout, /— missing: 4\.json$/m);
    assert.equal(existsSync(f), false, "no state written");
  });

  it("--max-epochs splits a catch-up: 1…3, then 4…7 from the state", () => {
    const f = stateFile("steps");
    const one = run("--epoch", "latest", "--dir", honest, "--max-epochs", "3", "--write-state", f);
    assert.equal(one.status, 0, one.stdout + one.stderr);
    assert.match(one.stderr, /capped at 3 epochs: through epoch 3 of 7/);
    assert.equal(readState(f).lastEpoch, 3);
    const two = run("--epoch", "latest", "--dir", honest, "--since-state", f, "--write-state", f);
    assert.equal(two.status, 0, two.stdout + two.stderr);
    assert.equal(readState(f).lastEpoch, 7);
  });

  it("refuses: --since-state with --from-snapshot or --purchase (exit 2); a state for another shop or engine (exit 1)", () => {
    const f = stateFile("other");
    assert.equal(run("--epoch", "latest", "--dir", honest, "--since-state", f, "--from-snapshot", "3").status, 2);
    assert.equal(run("--dir", honest, "--since-state", f, "--purchase", "1").status, 2);
    assert.equal(run("--epoch", "latest", "--dir", honest, "--max-epochs", "0").status, 2);
    writeFileSync(f, JSON.stringify(base({ lastEpoch: 3, resume: null, shop: `0x${"5c".repeat(20)}` })));
    const shop = run("--epoch", "latest", "--dir", honest, "--since-state", f);
    assert.equal(shop.status, 1);
    assert.match(shop.stderr, /--since-state is for shop 0x5c5c/);
    writeFileSync(f, JSON.stringify(base({ lastEpoch: 3, resume: null, engineVersionHash: `0x${"ee".repeat(32)}` })));
    const engine = run("--epoch", "latest", "--dir", honest, "--since-state", f);
    assert.equal(engine.status, 1);
    assert.match(engine.stderr, /a rules change starts a new state/);
  });
});
