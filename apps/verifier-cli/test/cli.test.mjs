// pikit-verify verify (개정 7, D205): 정직한 데모 묶음(packages/verifier/dist/test/ledger-demo-bundle.js — 루트 3개)은 통과(종료 0),
// 위조(leaf·announce)는 그 검사만 실패(종료 1), 오래된 루트의 파일이 없으면 실패(1), 방금 실린 루트의 파일이 없으면 체인 끝 경합(3).
// 신뢰 뿌리(--contract/--trust), 이어 받기(--since-state/--write-state/--max-roots, 상태 v2), RPC(가짜 JSON-RPC 서버 두 곳 — 다른 호스트),
// 전송 오류(종료 3), 오류 줄(D182·D183). 사용법 오류는 2.
// 컴파일하지 않는 시험(node --test) — 빌드된 dist/main.js와 검증기 dist/test 의 데모 묶음·가짜 체인을 쓴다.
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer as createHttpServer } from "node:http";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { fileURLToPath } from "node:url";

import { errorLine, HttpError, isTransportError, redactUrl } from "../dist/errors.js";
import { rpcHosts, trustPins } from "../dist/trust.js";

const CLI = fileURLToPath(new URL("../dist/main.js", import.meta.url));
const DEMO = fileURLToPath(new URL("../../../packages/verifier/dist/test/ledger-demo-bundle.js", import.meta.url));
const FAKE = new URL("../../../packages/verifier/dist/test/fake-ledger-chain.js", import.meta.url).href;
const LEDGER = "0x1ed6e00000000000000000000000000000000007";   // 데모 묶음의 PikitLedger (packages/verifier/test/ledger/helpers.ts)
const root = mkdtempSync(join(tmpdir(), "pikit-verify-cli-"));
after(() => rmSync(root, { recursive: true, force: true }));

const bundles = new Map();
/** 데모 묶음을 root/<name>에 쓴다 (cheat = 운영자의 속임). 같은 이름은 한 번만. */
function bundle(name, cheat) {
  if (bundles.has(name)) return bundles.get(name);
  const dir = join(root, name);
  const r = spawnSync(process.execPath, [DEMO, dir, ...(cheat ? [cheat] : [])], { encoding: "utf8" });
  assert.equal(r.status, 0, r.stderr);
  bundles.set(name, dir);
  return dir;
}

/** pikit-verify verify <args> 그대로 */
function runRaw(...args) {
  const r = spawnSync(process.execPath, [CLI, "verify", ...args], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  return { status: r.status, stdout: r.stdout, stderr: r.stderr };
}

/** pikit-verify verify --contract <데모 PikitLedger> <args> (사람이 고정한 주소, D162) */
const run = (...args) => runRaw("--contract", LEDGER, ...args);

/** 이 프로세스를 막지 않고 (같은 프로세스의 HTTP 서버가 답해야 할 때) */
function runAsync(...args) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [CLI, "verify", ...args]);
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (b) => { stdout += b; });
    child.stderr.on("data", (b) => { stderr += b; });
    child.on("close", (status) => resolve({ status, stdout, stderr }));
  });
}

/** ✘ 줄들 (앞 n글자). */
const crosses = (out, n = 60) => out.split("\n").filter((x) => x.startsWith("✘ ")).map((x) => x.slice(0, n));

/** 지금 아무도 듣지 않는 로컬 포트. */
async function closedPort() {
  const srv = createServer();
  await new Promise((r) => srv.listen(0, "127.0.0.1", r));
  const { port } = srv.address();
  await new Promise((r) => srv.close(r));
  return port;
}

describe("pikit-verify verify (rev 7 demo bundle: 3 roots, ANNOUNCE rotation, a smart-wallet session)", () => {
  let honest;
  before(() => { honest = bundle("honest"); });

  it("default: the last root alone from the previous root's boundary — exit 0; a chain.json draws the operator's-word warning", () => {
    const r = run("--dir", honest);
    assert.equal(r.status, 0, r.stdout + r.stderr);
    assert.match(r.stderr, /^warning: chain values from .*chain\.json are the operator's word/m);
    assert.match(r.stderr, /^pikit-verify: roots 2 … 2 of 2 \(epochs 3 … 4 of 4; root 2 alone, from the boundary of root 1\)$/m);
    assert.match(r.stdout, /^start {12}boundary of root 1 \(epoch 2, window 1399\): snapshot \+ leaves file$/m);
    assert.match(r.stdout, /^OK: \d+ checks passed, 1 roots matched$/m);
  });

  it("--from-snapshot genesis: every root; --root 1 --from-snapshot 0: root 1 only; the trust roots come first", () => {
    const all = run("--dir", honest, "--from-snapshot", "genesis");
    assert.equal(all.status, 0, all.stdout);
    assert.match(all.stdout, /^OK: \d+ checks passed, 3 roots matched$/m);
    assert.deepEqual(all.stdout.split("\n").slice(0, 3), [
      "trust roots      (check these against your wallet and the explorer — not against the operator's files)",
      "  chain id       143",
      `  PikitLedger    ${LEDGER} (pinned by you)`,
    ]);
    assert.match(all.stdout, /^ {2}ledgerHash {5}0x[0-9a-f]{64} \(chain\) — this build 0x[0-9a-f]{64}$/m);
    const one = run("--dir", honest, "--root", "1", "--from-snapshot", "0");
    assert.equal(one.status, 0, one.stdout);
    assert.match(one.stdout, /^root 1 {11}epochs 2 … 2, through window 1399, posted at block 1699: ✔ 10 fields match$/m);
  });

  it("--json prints the whole report (trust, roots, ledger, rootResults)", () => {
    const r = run("--dir", honest, "--from-snapshot", "genesis", "--json");
    assert.equal(r.status, 0, r.stderr);
    const rep = JSON.parse(r.stdout);
    assert.deepEqual([rep.ok, rep.trust.contract, rep.trust.chainId, rep.roots, rep.start], [true, LEDGER, 143, { first: 0, last: 2, latest: 2 }, null]);
    assert.equal(rep.rootResults.length, 3);
    assert.ok(rep.ledger.applied > 50 && rep.ledger.erc1271Sessions >= 1);
  });

  it("usage errors exit 2: no pin, --rpc with --chain, --log-chunk without --rpc, a bad root, --since-state with --from-snapshot, rev 6 flags", () => {
    for (const args of [
      ["--dir", honest],
      ["--contract", "0x123", "--dir", honest],
      ["--contract", LEDGER, "--dir", honest, "--rpc", "http://a.example", "--chain", join(honest, "chain.json")],
      ["--contract", LEDGER, "--dir", honest, "--log-chunk", "10"],
      ["--contract", LEDGER, "--dir", honest, "--root", "x"],
      ["--contract", LEDGER, "--dir", honest, "--from-snapshot", "latest"],
      ["--contract", LEDGER, "--dir", honest, "--since-state", join(root, "s.json"), "--from-snapshot", "0"],
      ["--contract", LEDGER, "--dir", honest, "--max-roots", "0"],
      ["--shop", LEDGER, "--dir", honest],
      ["--contract", LEDGER, "--dir", honest, "--epoch", "7"],
      ["--contract", LEDGER, "--dir", "https://files.example/epochs"],
    ]) {
      const r = runRaw(...args);
      assert.equal(r.status, 2, `${args.join(" ")}: ${r.stderr}`);
    }
  });

  it("a root that is not on chain yet: exit 1 with the reason", () => {
    const r = run("--dir", honest, "--root", "3");
    assert.equal(r.status, 1);
    assert.match(r.stderr, /^pikit-verify: root 3 is not on chain yet \(the last root at block \d+ is 2\)$/m);
  });
});

describe("forgeries: exit 1, exactly the checks that catch them", () => {
  it("a leaf balance changed (leaf): root 0 leaves file ✘ + root fields (dataHash) ✘; --json ok false without errorKind", () => {
    const dir = bundle("leaf", "leaf");
    const r = run("--dir", dir, "--from-snapshot", "genesis");
    assert.equal(r.status, 1, r.stdout);
    assert.deepEqual(crosses(r.stdout, 26), ["✘ root 0: leaves file = re", "✘ root 0: root fields = ch"]);
    assert.match(r.stdout, /^root 0 {11}.*: ✘ dataHash differ$/m);
    const j = run("--dir", dir, "--from-snapshot", "genesis", "--json");
    const rep = JSON.parse(j.stdout);
    assert.deepEqual([j.status, rep.ok, rep.errorKind, rep.verified], [1, false, undefined, null]);
  });

  it("lists signed by a key that is not the window's ANNOUNCE key (announce): root 0 list signatures ✘", () => {
    const r = run("--dir", bundle("announce", "announce"), "--from-snapshot", "genesis");
    assert.equal(r.status, 1, r.stdout);
    assert.deepEqual(crosses(r.stdout, 42), ["✘ root 0: list signatures = the ANNOUNCE k"]);
  });

  it("an old root's file missing (missing): exit 1, the file check fails — a missing file is never skipped (audit F-1)", () => {
    const r = run("--dir", bundle("missing", "missing"), "--from-snapshot", "genesis");
    assert.equal(r.status, 1, r.stdout + r.stderr);
    assert.match(r.stdout, /^✘ root 1: every public file of the range is published .* — missing: ledger\/2\.json$/m);
  });

  it("the just-posted root's file missing (tip): exit 3, --json { ok: null, errorKind: tip-race, retryAfterSec } — not a verification failure", () => {
    const r = run("--dir", bundle("tip", "tip"), "--json");
    assert.equal(r.status, 3, r.stdout + r.stderr);
    const out = JSON.parse(r.stdout);
    assert.deepEqual([out.ok, out.errorKind, out.retryAfterSec], [null, "tip-race", 30]);
    assert.match(out.error, /^root 2 files not published yet \(4\.json\) — posted less than 400 blocks before the finalized head \d+ \(tip race/);
    assert.match(r.stderr, /^pikit-verify: root 2 files not published yet/m);
  });
});

describe("trust roots (review rev6 M-4, D162 → rev 7)", () => {
  let honest;
  before(() => { honest = bundle("honest"); });

  it("a PikitLedger other than world.json's (a decoy deployment): exit 1 before any chain value or root file is read", () => {
    const r = runRaw("--contract", "0x00000000000000000000000000000000000000ff", "--dir", honest, "--json");
    assert.equal(r.status, 1, r.stderr);
    const rep = JSON.parse(r.stdout);
    assert.deepEqual(rep.checks.filter((c) => !c.ok).map((c) => c.name), ["trust: world.shop = the PikitLedger you pinned (--contract / --trust)"]);
    assert.equal(rep.chainThroughBlock, -1);
  });

  it("--trust <file>: contract from the file; chainId · ledgerHash · rulesHash given are checked; --contract must agree", () => {
    const chain = JSON.parse(readFileSync(join(honest, "chain.json"), "utf8"));
    const good = join(root, "trust-good.json");
    writeFileSync(good, JSON.stringify({ contract: LEDGER, chainId: 143, ledgerHash: chain.ledgerHash, rulesHash: chain.rulesHash }));
    assert.equal(runRaw("--trust", good, "--dir", honest).status, 0);
    const bad = join(root, "trust-bad.json");
    writeFileSync(bad, JSON.stringify({ contract: LEDGER, ledgerHash: `0x${"11".repeat(32)}` }));
    const r = runRaw("--trust", bad, "--dir", honest);
    assert.equal(r.status, 1);
    assert.deepEqual(crosses(r.stdout, 47), ["✘ trust: pinned ledgerHash = chain ledgerHash  "]);
    assert.equal(runRaw("--trust", good, "--contract", "0x00000000000000000000000000000000000000ff", "--dir", honest).status, 2);
  });

  it("trustPins: --contract or a trust file is required; addresses lower-cased; unknown fields and bad values refused", () => {
    assert.throws(() => trustPins(undefined, undefined), /--contract <address>/);
    assert.deepEqual(trustPins(LEDGER.toUpperCase().replace("0X", "0x"), undefined), { contract: LEDGER });
    assert.throws(() => trustPins(undefined, { shop: LEDGER }), /unknown field shop/);
    assert.throws(() => trustPins(undefined, { contract: LEDGER, ledgerHash: "0x12" }), /ledgerHash must be/);
    assert.throws(() => trustPins(undefined, { contract: LEDGER, chainId: -1 }), /chainId/);
  });

  it("--rpc twice the same host is refused (PoC same-rpc-twice); hostnames are normalised", () => {
    assert.throws(() => rpcHosts(["https://rpc.monad.xyz/a", "https://RPC.monad.xyz./b"]), /both endpoints are rpc\.monad\.xyz/);
    assert.deepEqual(rpcHosts(["https://www.a.example/KEY", "https://b.example"]), ["a.example", "b.example"]);
    assert.equal(run("--dir", honest, "--rpc", "https://rpc.monad.xyz/a,https://rpc.monad.xyz/b").status, 2);
  });
});

describe("watcher state v2: --since-state / --write-state / --max-roots (H-1, D163 → D205)", () => {
  let honest;
  before(() => { honest = bundle("honest"); });
  const stateArgs = (state, next, ...more) => ["--dir", honest, "--since-state", state, "--write-state", next, ...more];

  it("no state file: from genesis; --max-roots 1 walks root by root (0, 1, 2), then 'up to date' (exit 0, state written again)", () => {
    const state = join(root, "walk.json");
    const seen = [];
    for (let i = 0; i < 3; i++) {
      const r = run(...stateArgs(state, state, "--max-roots", "1"));
      assert.equal(r.status, 0, r.stdout + r.stderr);
      const s = JSON.parse(readFileSync(state, "utf8"));
      seen.push([s.schema, s.lastRoot, s.epoch]);
      if (i === 0) assert.match(r.stderr, /^warning: no state file .* verifying from genesis/m);
      if (i === 0) assert.match(r.stderr, /^pikit-verify: roots 0 … 0 of 2 \(epochs 1 … 1 of 4; from genesis; capped at 1 roots: through root 0 of 2 \(catching up\)\)$/m);
    }
    assert.deepEqual(seen, [["pikit.verify-state/v2", 0, 1], ["pikit.verify-state/v2", 1, 2], ["pikit.verify-state/v2", 2, 4]]);
    const before = readFileSync(state, "utf8");
    const up = run(...stateArgs(state, state, "--json"));
    assert.equal(up.status, 0, up.stderr);
    const j = JSON.parse(up.stdout);
    assert.deepEqual([j.ok, j.upToDate, j.roots.latest, j.epochs.last], [true, true, 2, 4]);
    assert.equal(readFileSync(state, "utf8"), before);
  });

  it("a failing run leaves the state alone (the next run starts from the same place); a state for another PikitLedger or world is refused", () => {
    const state = join(root, "keep.json");
    assert.equal(run(...stateArgs(state, state, "--max-roots", "1")).status, 0);
    const before = readFileSync(state, "utf8");
    const next = join(root, "keep.next.json");
    const r = run("--dir", bundle("missing", "missing"), "--since-state", state, "--write-state", next);
    assert.equal(r.status, 1, r.stdout);
    assert.equal(existsSync(next), false);
    assert.equal(readFileSync(state, "utf8"), before);
    const other = join(root, "other.json");
    writeFileSync(other, JSON.stringify({ ...JSON.parse(before), contract: "0x00000000000000000000000000000000000000ff" }));
    assert.match(run(...stateArgs(other, other)).stderr, /--since-state is for PikitLedger 0x0{38}ff/);
    writeFileSync(other, JSON.stringify({ ...JSON.parse(before), ledgerHash: `0x${"22".repeat(32)}` }));
    const w = run(...stateArgs(other, other));
    assert.equal(w.status, 1);
    assert.match(w.stderr, /a new world starts a new state/);
    writeFileSync(other, JSON.stringify({ ...JSON.parse(before), ledgerRoot: `0x${"33".repeat(32)}` }));
    const f = run(...stateArgs(other, other));
    assert.equal(f.status, 1);
    assert.deepEqual(crosses(f.stdout, 30), ["✘ start: chain root = the root"]);
  });
});

describe("RPC (two fake JSON-RPC servers on different hosts) and transport errors (D182)", () => {
  let honest;
  let servers = [];
  let urls = [];
  before(async () => {
    honest = bundle("honest");
    const { FakeLedgerChain } = await import(FAKE);
    const chain = JSON.parse(readFileSync(join(honest, "chain.json"), "utf8"));
    for (const host of ["127.0.0.1", "localhost"]) {
      const { url, server } = await new FakeLedgerChain(chain).listen();
      servers.push(server);
      urls.push(url.replace("127.0.0.1", host));
    }
  });
  after(() => { for (const s of servers) s.close(); });

  it("--rpc a,b: every chain value cross-checked, exit 0; the report names the hosts, never the URLs", async () => {
    const r = await runAsync("--contract", LEDGER, "--dir", honest, "--rpc", urls.join(","), "--from-snapshot", "genesis", "--max-rps", "2000");
    assert.equal(r.status, 0, r.stdout + r.stderr);
    assert.match(r.stdout, /^chain values {5}RPC ×2, cross-checked \(127\.0\.0\.1, localhost\), finalized blocks/m);
    assert.ok(!r.stdout.includes("/rpc"), "no URL path in the report");
  });

  it("an RPC that does not answer: exit 3 (transport), --json { ok: null, errorKind: transport }, one error line without the key", async () => {
    const port = await closedPort();
    const r = run("--dir", honest, "--rpc", `http://127.0.0.1:${port}/v2/SECRETKEY?key=QSECRET`, "--json");
    assert.equal(r.status, 3, r.stderr);
    const line = `HTTP request failed (fetch failed: ECONNREFUSED; POST 127.0.0.1:${port}/v2/<key>)`;
    assert.deepEqual(JSON.parse(r.stdout), { ok: null, errorKind: "transport", error: line });
    assert.ok(r.stderr.split("\n").includes(`pikit-verify: ${line}`), r.stderr);
    for (const out of [r.stdout, r.stderr]) assert.ok(!out.includes("SECRETKEY") && !out.includes("QSECRET"), out);
    const plain = run("--dir", honest, "--rpc", `http://127.0.0.1:${await closedPort()}/KEY`);
    assert.deepEqual([plain.status, plain.stdout], [3, ""]);
  });
});

describe("public files over HTTP (D183)", () => {
  let honest;
  let srv;
  let base;
  const gone = new Set();
  const statusFor = new Map();
  before(async () => {
    honest = bundle("honest");
    srv = createHttpServer((req, res) => {
      const path = new URL(req.url, "http://x").pathname;
      if (path === "/drop/world.json" || path === "/dropfile/ledger/3.json") { req.socket.destroy(); return; }
      if (gone.has(path)) { res.writeHead(404).end("not found"); return; }
      if (statusFor.has(path)) { res.writeHead(statusFor.get(path)).end("no"); return; }
      const file = join(honest, path.replace(/^\/(pub|drop|dropfile)\//, ""));
      if (!existsSync(file)) { res.writeHead(404).end(); return; }
      res.writeHead(200, { "content-type": "application/json" }).end(readFileSync(file));
    });
    await new Promise((r) => srv.listen(0, "127.0.0.1", r));
    base = `http://127.0.0.1:${srv.address().port}`;
  });
  after(() => srv.close());
  const runHttp = (dir, ...args) => runAsync("--contract", LEDGER, "--dir", `${base}/${dir}`, "--chain", join(honest, "chain.json"), ...args);

  it("all files there: exit 0 over HTTP (dataHash over the bytes as served)", async () => {
    gone.clear();
    const r = await runHttp("pub", "--from-snapshot", "genesis");
    assert.equal(r.status, 0, r.stdout + r.stderr);
  });

  it("a public file server that drops the connection (world.json or a root's file): exit 3 (transport) — not a verification failure", async () => {
    for (const dir of ["drop", "dropfile"]) {
      const r = await runHttp(dir, "--json");
      assert.equal(r.status, 3, r.stdout + r.stderr);
      assert.equal(JSON.parse(r.stdout).errorKind, "transport");
    }
  });

  it("a 404 for world.json is a failure with host + path; a 403 on a root file is a failure (config) with its status", async () => {
    gone.clear();
    gone.add("/pub/world.json");
    const r = await runHttp("pub");
    assert.equal(r.status, 1, r.stderr);
    assert.match(r.stderr, new RegExp(`^pikit-verify: missing public file 127\\.0\\.0\\.1:${srv.address().port}/pub/world\\.json$`, "m"));
    gone.clear();
    statusFor.set("/pub/ledger/3.json", 403);
    try {
      const f = await runHttp("pub", "--json");
      assert.equal(f.status, 1, f.stderr);
      assert.match(f.stderr, new RegExp(`^pikit-verify: HTTP request failed \\(403 GET 127\\.0\\.0\\.1:${srv.address().port}/pub/ledger/3\\.json\\)$`, "m"));
    } finally {
      statusFor.clear();
    }
  });
});

describe("error classification (D182): transport (exit 3) vs everything else (exit 1)", () => {
  const http = (status, cause) => Object.assign(new Error("HTTP request failed."), { name: "HttpRequestError", shortMessage: "HTTP request failed.", status, cause });
  it("transport: HTTP 429 and 5xx, JSON-RPC rate limits, timeouts, connection and DNS errors (also deep in the cause chain)", () => {
    for (const e of [
      http(429), http(502), http(503),
      Object.assign(new Error("limit exceeded"), { code: -32005 }), Object.assign(new Error("50/second request limit reached"), { code: -32007 }),
      Object.assign(new Error("The request took too long to respond."), { name: "TimeoutError" }),
      Object.assign(new Error("HTTP request failed."), { cause: Object.assign(new TypeError("fetch failed"), { cause: Object.assign(new Error("read ECONNRESET"), { code: "ECONNRESET" }) }) }),
      Object.assign(new Error("getaddrinfo ENOTFOUND rpc.example"), { code: "ENOTFOUND" }), Object.assign(new Error("x"), { code: "EAI_AGAIN" }),
      Object.assign(new Error("other side closed"), { code: "UND_ERR_SOCKET" }),
      Object.assign(new Error("could not read https://files.example/1.json"), { status: 503 }),
    ]) assert.equal(isTransportError(e), true, String(e.message));
  });
  it("not transport: HTTP 401/403/400 (key or config), a revert, a parse error, a plain error", () => {
    for (const e of [http(403), http(401), http(400), new Error("execution reverted"), new SyntaxError("Unexpected token"), new Error("missing public file x")]) {
      assert.equal(isTransportError(e), false, String(e.message));
    }
  });
  it("D183: an HTTP failure without a status is transport (the bare 'HTTP request failed.' of mainnet run 27); the HTTP status decides when there is one", () => {
    const bare = http(undefined, new SyntaxError("Unexpected end of JSON input"));   // viem: 2xx 인데 본문이 JSON 이 아님
    const fetchFailed = http(undefined, Object.assign(new TypeError("fetch failed"), { cause: Object.assign(new Error("connect ECONNREFUSED"), { code: "ECONNREFUSED" }) }));
    const wrapped = Object.assign(new Error("HTTP request failed."), { name: "ContractFunctionExecutionError", shortMessage: "HTTP request failed.", cause: bare });
    for (const e of [bare, http(undefined), fetchFailed, wrapped, http(500), http(502), http(504),
      new HttpError("GET", "https://chog.pikit.fun/epochs/844.json", { cause: new TypeError("fetch failed") }), new HttpError("GET", "https://h/1.json", { status: 503 })]) {
      assert.equal(isTransportError(e), true, errorLine(e));
    }
    // 4xx(429 빼고) 는 응답이 있는 설정 문제 — 밑에 연결 오류 글이 섞여 있어도 상태가 결정한다. 404 는 files.ts 가 null 로(여기 오지 않음)
    for (const e of [http(404), http(401, new Error("fetch failed")), new HttpError("GET", "https://h/1.json", { status: 404 }), new HttpError("GET", "https://h/1.json", { status: 403 })]) {
      assert.equal(isTransportError(e), false, errorLine(e));
    }
    assert.equal(isTransportError(new Error("invalid JSON in h/epochs/3.json (Unexpected token)")), false, "a published file that is not JSON is a content error");
  });
  it("errorLine (D183): every HTTP failure carries its status or its cause; URLs keep host + path, never the query or a key", () => {
    const url = "https://rpc.example/v2/SECRETKEY0?apikey=Q";
    assert.equal(errorLine(Object.assign(http(429), { message: "HTTP request failed.\nURL: https://rpc.example/KEY", url })), "HTTP request failed (429 POST rpc.example/v2/<key>)");
    // 2026-10-13 run 27: 2xx 인데 본문이 JSON 이 아님 → viem 은 status 없이 SyntaxError 를 cause 로. 예전 줄은 맨 "HTTP request failed." 였다
    assert.equal(errorLine(http(undefined, new SyntaxError("Unexpected end of JSON input"))), "HTTP request failed (SyntaxError: Unexpected end of JSON input; POST <url>)");
    assert.equal(errorLine(Object.assign(http(undefined, new SyntaxError("Unexpected token '<'")), { url })), "HTTP request failed (SyntaxError: Unexpected token '<'; POST rpc.example/v2/<key>)");
    const reset = Object.assign(new TypeError("fetch failed"), { cause: Object.assign(new Error("read ECONNRESET"), { code: "ECONNRESET" }) });
    assert.equal(errorLine(Object.assign(http(undefined, reset), { url })), "HTTP request failed (fetch failed: ECONNRESET; POST rpc.example/v2/<key>)");
    const cut = Object.assign(new TypeError("terminated"), { cause: Object.assign(new Error("other side closed"), { code: "UND_ERR_SOCKET" }) });
    assert.equal(errorLine(Object.assign(http(undefined, cut), { url })), "HTTP request failed (terminated: UND_ERR_SOCKET; POST rpc.example/v2/<key>)");
    // 공개 파일 (files.ts HttpError)
    assert.equal(errorLine(new HttpError("GET", "https://chog.pikit.fun/epochs/844.json?t=1", { status: 404 })), "HTTP request failed (404 GET chog.pikit.fun/epochs/844.json)");
    assert.equal(errorLine(new HttpError("GET", "https://chog.pikit.fun/epochs/844.json", { cause: reset })), "HTTP request failed (fetch failed: ECONNRESET; GET chog.pikit.fun/epochs/844.json)");
    // 그 밖: 상태·코드가 없으면 원인을 단다, URL 은 호스트 + 경로
    assert.equal(errorLine(new Error("chain read failed", { cause: new Error("boom") })), "chain read failed (boom)");
    assert.equal(errorLine(new Error("missing public file https://chog.pikit.fun/epochs/world.json")), "missing public file chog.pikit.fun/epochs/world.json");
    assert.equal(errorLine(Object.assign(new Error("x"), { code: "ENOTFOUND" })), "x (ENOTFOUND)");
  });
  it("redactUrl: host + path; query, fragment, user info and key-like path segments go", () => {
    assert.equal(redactUrl("https://u:p@chog.pikit.fun/epochs/snapshots/840.json?x=1#y"), "chog.pikit.fun/epochs/snapshots/840.json");
    assert.equal(redactUrl("https://x.monad-mainnet.quiknode.pro/0a1b2c3d4e5f60718293/"), "x.monad-mainnet.quiknode.pro/<key>/");
    assert.equal(redactUrl(`https://h/catalogs/0x${"ab".repeat(32)}.json`), `h/catalogs/0x${"ab".repeat(32)}.json`);
    assert.equal(redactUrl("not a url"), "<url>");
  });
});

