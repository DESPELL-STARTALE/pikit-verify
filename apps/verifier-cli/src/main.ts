#!/usr/bin/env node
// pikit-verify — 공개 엔진으로 기록을 다시 돌려 확인한다.
//  (1) 방 하나 v0 재생:  pikit-verify --catalog <catalog.json> --log <input-log.json> [--json] [--expect <expected.json>]
//  (2) 에폭 검증:       pikit-verify verify --shop <address> | --trust <trust.json>
//                                           --dir <folder|URL> (--epoch <N|latest> | --purchase <id>) [--from-snapshot <E|latest>]
//                                           [--rpc <url1>[,<url2>] | --chain <chain.json>] [--epochs <folder|URL>]
//                                           [--through <block>] [--max-rps <n>] [--log-chunk <n>] [--json]
//      신뢰 뿌리 (M-4, D162): 상점 주소는 운영자 파일(world.json)에서 받지 않는다 — --shop(또는 사람이 따로 받은 --trust 파일의 shop)이
//        world.json과 다르면 실패. 보고서 맨 위에 체인 id·상점·공정성·시드 약속·엔진 해시·방마다 카탈로그 해시와 RPC 호스트 이름을 찍는다.
//        --rpc 두 곳은 서로 다른 호스트여야 한다(같은 호스트 = 사용법 오류, 같은 도메인 = 경고 — 서로 다른 공급자여야 의미가 있다).
//      공개 폴더: world.json, catalogs/<catalogHash>.json, 에폭 입력 기록 v3, snapshots/<epoch>.json.
//        로컬 폴더면 에폭 파일은 기본 <dir>/epochs/<n>.json(데모 묶음 모양), URL이면 <dir>/<n>.json(game-server INPUT_LOG_DIR = chog.pikit.fun/epochs 모양).
//        --epochs로 바꾼다. 스냅숏은 <에폭 폴더>/snapshots/<E>.json. 없는 파일은 검증 실패다(아무도 그 구간을 검증할 수 없다).
//      체인 값: --rpc면 RPC에서 바로 읽는다(RpcChainSource — 운영자를 믿지 않음). 두 곳을 쉼표로 주면 모든 값을 두 곳에서 읽어 대조하고,
//        하나라도 다르면 첫 차이를 적고 실패한다. --max-rps(기본 20)는 곳마다(그리고 HTTP 파일 읽기에도) 적용된다.
//        --rpc가 없으면 --chain 또는 <dir>/chain.json(pikit.chain/v3) — 운영자가 준 값을 믿는 것이라 경고를 낸다(stderr).
//      감시자 이어 받기 (H-1, D163): --since-state <파일>이면 앞 실행이 남긴 상태의 시작 앵커 스냅숏에서 체인 마지막 앵커까지(따라잡기,
//        --max-epochs로 나눔) 검증하고, --write-state <파일>이면 성공했을 때만 다음 시작점을 쓴다(실패 = 상태 그대로 → 다음 실행이 같은 곳에서).
//        상태 파일이 없으면 처음부터. 새로 검증할 에폭이 없으면 "up to date"로 종료 0(상태 그대로 다시 쓴다).
//      범위: --epoch N | latest(체인의 마지막 앵커가 덮은 에폭). --from-snapshot E | latest(끝에서 하루 + 30분 이상 앞선 마지막 앵커 에폭)면
//        그 스냅숏(= 체인 앵커 루트)에서 시작한다. --purchase id면 그 구매 앞의 마지막 앵커 스냅숏에서 시작하고 그 곡괭이들을 따로 적는다.
//      보고: 검사마다 ✔/✘, "입력 = 체인 사건" 대조, 정산 대조. --json은 보고서 전체.
//      종료 코드: 0 = 모든 검사 통과, 1 = 실패(파일 누락·RPC 불일치 포함) 또는 읽기 오류, 2 = 사용법 오류.
import { join } from "node:path";
import { parseArgs } from "node:util";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { WorldManifest } from "@pikit/protocol";
import {
  ChainDisagreement, DEFAULT_MAX_RPS, describeLinkMismatch, localEngineVersionHash, describeSettlementMismatch, replay, resolveRange, RpcChainSource, StaticChainSource, verifyEpochs,
  nextVerifyState, VerifyRangeError, VerifyState, type ChainSource, type EpochVerifyReport, type ReplayReport, type TrustPins,
} from "@pikit/verifier";
import { FileReader, isUrl, joinPath } from "./files.js";
import { rpcHosts, trustPins } from "./trust.js";

const USAGE = [
  "usage: pikit-verify --catalog <catalog.json> --log <input-log.json> [--json] [--expect <expected-report.json>]",
  "       pikit-verify verify --dir <folder|URL> (--epoch <N|latest> | --purchase <id>) [--from-snapshot <E|latest>]",
  "                           [--rpc <url1>[,<url2>] | --chain <chain.json>] [--epochs <folder|URL>]",
  "                           [--through <block>] [--max-rps <n>] [--log-chunk <n>] [--json]",
  "         --dir            public files: world.json, catalogs/, epoch logs, snapshots/ (a folder or e.g. https://chog.pikit.fun/epochs)",
  "         --epoch          last epoch to verify; latest = the epoch of the last on-chain anchor",
  "         --from-snapshot  start from the anchored snapshot of epoch E instead of genesis; latest = the last anchored epoch",
  "                          a day + 30 min before the end (what a daily run needs). Without it: from genesis",
  "         --since-state    resume where the last successful run left off (verify-state.json; missing file = from genesis)",
  "                          — what a watcher runs every hour so that no epoch is ever skipped. Not with --from-snapshot/--purchase",
  "         --write-state    on success, write where the next run must start (the file is left alone when the run fails)",
  "         --max-epochs     verify at most n epochs this run (catch up in steps; the state records how far it got)",
  "         --purchase       verify the range holding this purchase (from the anchored snapshot before it) and list its pickaxes",
  "         --rpc            read chain values straight from the chain (finalized blocks); two URLs = cross-check every value —",
  "                          they must be two different providers (same host = refused)",
  "         --chain          chain values from a file (default <dir>/chain.json) — the operator's word",
  "         --epochs         epoch input logs <folder|URL>/<n>.json (default <dir>/epochs for a folder, <dir> for a URL)",
  "         --through        with --rpc: last block to read events from (default: finalized head)",
  `         --max-rps        requests per second per RPC endpoint and for HTTP files (default ${DEFAULT_MAX_RPS})`,
  "         --log-chunk      with --rpc: blocks per eth_getLogs (default 100, halved on a range error)",
].join("\n");

async function main(): Promise<number> {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      catalog: { type: "string" },
      log: { type: "string" },
      json: { type: "boolean", default: false },
      expect: { type: "string" },
      epoch: { type: "string" },
      dir: { type: "string" },
      chain: { type: "string" },
      rpc: { type: "string" },
      epochs: { type: "string" },
      "from-snapshot": { type: "string" },
      purchase: { type: "string" },
      through: { type: "string" },
      "max-rps": { type: "string" },
      "log-chunk": { type: "string" },
      shop: { type: "string" },
      trust: { type: "string" },
      "since-state": { type: "string" },
      "write-state": { type: "string" },
      "max-epochs": { type: "string" },
      help: { type: "boolean", short: "h", default: false },
    },
  });
  if (values.help) { console.log(USAGE); return 0; }
  if (positionals[0] === "verify") return verifyCommand(values);
  if (positionals.length > 0 || !values.catalog || !values.log) { console.error(USAGE); return 2; }

  const report = replay(readJson(values.catalog), readJson(values.log));
  if (values.json) console.log(JSON.stringify(report, null, 2));
  else printReport(report);

  // ── 기대값 대조 (골든 재생): 해시가 다르면 종료 코드 1
  if (values.expect) {
    const expected = readJson(values.expect) as ReplayReport;
    if (expected.finalStateHash !== report.finalStateHash) {
      console.error(`MISMATCH: final state hash ${report.finalStateHash} ≠ expected ${expected.finalStateHash}`);
      return 1;
    }
    console.log(`OK: matches expected final state hash ${expected.finalStateHash}`);
  }
  return 0;
}

interface VerifyArgs {
  epoch?: string | undefined;
  dir?: string | undefined;
  chain?: string | undefined;
  rpc?: string | undefined;
  epochs?: string | undefined;
  "from-snapshot"?: string | undefined;
  purchase?: string | undefined;
  through?: string | undefined;
  "max-rps"?: string | undefined;
  "log-chunk"?: string | undefined;
  shop?: string | undefined;
  trust?: string | undefined;
  "since-state"?: string | undefined;
  "write-state"?: string | undefined;
  "max-epochs"?: string | undefined;
  json?: boolean | undefined;
}

/** N | latest → 숫자 또는 "latest", 아니면 null(사용법 오류). */
function epochArg(s: string | undefined): number | "latest" | undefined | null {
  if (s === undefined) return undefined;
  if (s === "latest") return "latest";
  const x = Number(s);
  return /^[0-9]+$/.test(s) && Number.isSafeInteger(x) && x >= 1 ? x : null;
}

async function verifyCommand(v: VerifyArgs): Promise<number> {
  const epoch = epochArg(v.epoch);
  const fromSnapshot = epochArg(v["from-snapshot"]);
  const through = numberArg(v.through, 0, true);
  const maxRpsArg = numberArg(v["max-rps"], Number.MIN_VALUE, false);
  const maxRps = maxRpsArg === undefined ? DEFAULT_MAX_RPS : maxRpsArg;
  const logChunk = numberArg(v["log-chunk"], 1, true);
  const maxEpochs = numberArg(v["max-epochs"], 1, true);
  const sinceState = v["since-state"];
  const rpcOnly = v.through !== undefined || v["log-chunk"] !== undefined;
  const rpcUrls = v.rpc === undefined ? [] : v.rpc.split(",").map((x) => x.trim()).filter((x) => x !== "");
  const purchaseOk = v.purchase === undefined || /^(0|[1-9][0-9]*)$/.test(v.purchase);
  let pins: TrustPins;
  let hosts: string[];
  try {
    pins = trustPins(v.shop, v.trust === undefined ? undefined : readJson(v.trust));
    hosts = rpcHosts(rpcUrls);
  } catch (e) {
    console.error(`pikit-verify: ${(e as Error).message}\n${USAGE}`);
    return 2;
  }
  const domains = hosts.map((h) => h.split(".").slice(-2).join("."));
  if (hosts.length === 2 && domains[0] === domains[1]) {
    console.error(`warning: both --rpc endpoints are under ${domains[0]} — make sure they are two different providers (an endpoint you do not trust can only be outvoted by an independent one)`);
  }
  if (!v.dir || epoch === null || fromSnapshot === null || (epoch === undefined && v.purchase === undefined) || !purchaseOk
    || (v.purchase !== undefined && fromSnapshot !== undefined)
    || (v.rpc !== undefined && (v.chain !== undefined || rpcUrls.length < 1 || rpcUrls.length > 2)) || (rpcOnly && v.rpc === undefined)
    || through === null || maxRps === null || logChunk === null || maxEpochs === null
    || (sinceState !== undefined && (fromSnapshot !== undefined || v.purchase !== undefined)) || (isUrl(v.dir) && v.rpc === undefined && v.chain === undefined)) {
    console.error(USAGE);
    return 2;
  }
  const dir = v.dir;
  const files = new FileReader(maxRps);
  const need = async (path: string) => {
    const x = await files.json(path);
    if (x === null) throw new Error(`missing public file ${path}`);
    return x;
  };
  const world = WorldManifest.parse(await need(joinPath(dir, "world.json")));
  let chain: ChainSource;
  let source: string;
  if (v.rpc !== undefined) {
    chain = new RpcChainSource({ rpcUrls, shop: pins.shop, maxRps, ...(through !== undefined ? { throughBlock: through } : {}), ...(logChunk !== undefined ? { logChunk } : {}) });
    source = `${rpcUrls.length === 2 ? "RPC ×2, cross-checked" : "RPC"} (${hosts.join(", ")}), finalized blocks (read directly — no operator file)`;
    console.error(`pikit-verify: reading chain values over ${rpcUrls.length === 2 ? "two RPC endpoints (every value cross-checked)" : "RPC"} at ≤ ${maxRps} req/s each — this can take a while`);
  } else {
    const file = v.chain ?? join(dir, "chain.json");
    chain = new StaticChainSource(JSON.parse(readFileSync(file, "utf8")));
    source = `file ${file} (operator-supplied)`;
    console.error(`warning: chain values from ${file} are the operator's word, not read from the chain — use --rpc <url> to check against the chain`);
  }

  // 앞 실행의 상태 (H-1): 같은 상점·엔진이어야 한다. 없으면 처음부터
  let state: VerifyState | null = null;
  if (sinceState !== undefined) {
    if (existsSync(sinceState)) {
      state = VerifyState.parse(readJson(sinceState));
      if (state.shop !== pins.shop) throw new Error(`--since-state is for shop ${state.shop}, not ${pins.shop}`);
      if (state.engineVersionHash !== localEngineVersionHash()) {
        throw new Error(`--since-state was written by engine ${state.engineVersionHash}, this build is ${localEngineVersionHash()} — a rules change starts a new state`);
      }
      console.error(`pikit-verify: state: verified through epoch ${state.lastEpoch}; resuming from ${state.resume ? `the anchored snapshot of epoch ${state.resume.epoch} (anchor ${state.resume.anchorIndex})` : "genesis"}`);
    } else {
      console.error(`warning: no state file ${sinceState} — verifying from genesis (a first run, or the previous state was lost)`);
    }
  }
  const writeState = (s: VerifyState) => {
    if (v["write-state"] === undefined) return;
    writeFileSync(v["write-state"], `${JSON.stringify(s, null, 2)}\n`);
    console.error(`pikit-verify: wrote ${v["write-state"]}: verified through epoch ${s.lastEpoch}, next run starts ${s.resume ? `from the snapshot of epoch ${s.resume.epoch}` : "from genesis"}`);
  };

  try {
    // 엔진(규칙 버전)이나 상점이 다르면 범위를 고르거나 파일을 받기 전에 실패한다 — 공개 서버·RPC를 쓸 이유가 없다
    if (world.engineVersionHash !== localEngineVersionHash() || world.shop !== pins.shop) {
      const report = await verifyEpochs({ world, catalogs: new Map(), epochs: [], chain, trust: pins });
      if (v.json) console.log(JSON.stringify(report, null, 2));
      else printEpochReport(report, source);
      return 1;
    }
    if (state) {
      const latest = await resolveRange(chain, { epoch: epoch ?? "latest" });
      if (latest.lastEpoch <= state.lastEpoch) {
        const line = `up to date: epoch ${latest.lastEpoch} is the last anchored epoch, already verified (state: through epoch ${state.lastEpoch})`;
        console.log(v.json ? JSON.stringify({ ok: true, upToDate: true, epochs: state.lastEpoch, note: line }, null, 2) : line);
        writeState(state);
        return 0;
      }
    }
    const resumeFrom = state?.resume?.epoch;
    const range = epoch === undefined || epoch === "latest" || fromSnapshot !== undefined || v.purchase !== undefined || resumeFrom !== undefined || maxEpochs !== undefined
      ? await resolveRange(chain, {
        epoch: epoch ?? "latest", ...(fromSnapshot !== undefined ? { fromSnapshot } : {}), ...(resumeFrom !== undefined ? { fromSnapshot: resumeFrom } : {}),
        ...(v.purchase !== undefined ? { purchase: v.purchase } : {}), ...(maxEpochs !== undefined ? { maxEpochs } : {}),
      })
      : { firstEpoch: 1, lastEpoch: epoch, snapshotEpoch: null, note: "from genesis" };
    const epochDir = v.epochs ?? (isUrl(dir) ? dir : join(dir, "epochs"));
    console.error(`pikit-verify: epochs ${range.firstEpoch} … ${range.lastEpoch} (${range.note})`);
    const catalogs = new Map<string, unknown>();
    for (const r of world.rooms) if (!catalogs.has(r.catalogHash)) catalogs.set(r.catalogHash, await need(joinPath(dir, "catalogs", `${r.catalogHash}.json`)));
    const epochs = await files.many(
      Array.from({ length: range.lastEpoch - range.firstEpoch + 1 }, (_, i) => joinPath(epochDir, `${range.firstEpoch + i}.json`)),
      (done) => console.error(`pikit-verify: ${done} epoch files read`),
    );
    const snapshot = range.snapshotEpoch === null ? undefined : await files.json(joinPath(epochDir, "snapshots", `${range.snapshotEpoch}.json`));
    const report = await verifyEpochs({
      world, catalogs, epochs, chain, trust: pins, firstEpoch: range.firstEpoch,
      ...(snapshot !== undefined ? { snapshot } : {}), ...(v.purchase !== undefined ? { purchase: v.purchase } : {}),
      ...(state?.resume ? { resume: { anchorIndex: state.resume.anchorIndex, roomsStateRoot: state.resume.roomsStateRoot } } : {}),
    });
    if (state && report.trust.chainId !== null && report.trust.chainId !== state.chainId) {
      report.checks.push({ name: "verify-state chainId = chain", ok: false, detail: `state ${state.chainId} vs chain ${report.trust.chainId}` });
      report.ok = false;
    }
    if (v.json) console.log(JSON.stringify(report, null, 2));
    else printEpochReport(report, source);
    if (report.ok) writeState(nextVerifyState(report));
    return report.ok ? 0 : 1;
  } catch (e) {
    if (e instanceof ChainDisagreement) {
      if (v.json) console.log(JSON.stringify({ ok: false, disagreement: { what: e.what, rpc1: e.a, rpc2: e.b } }, null, 2));
      else console.log(`✘ the two RPC endpoints agree on every chain fact  — ${e.message}\n\nFAILED: RPC endpoints disagree`);
      return 1;
    }
    if (e instanceof VerifyRangeError) {
      console.error(`pikit-verify: ${e.message}`);
      return 1;
    }
    throw e;
  }
}

/** 숫자 옵션: 없으면 undefined, min 미만·정수 아님(integer)이면 null(사용법 오류). */
function numberArg(s: string | undefined, min: number, integer: boolean): number | undefined | null {
  if (s === undefined) return undefined;
  const x = Number(s);
  return s.trim() !== "" && Number.isFinite(x) && x >= min && (!integer || Number.isInteger(x)) ? x : null;
}

function readJson(path: string): unknown {
  return JSON.parse(readFileSync(path, "utf8")) as unknown;
}


/** URL 모양 (키가 경로·쿼리에 들어 있을 수 있어 오류 줄에서 지운다). */
const URL_RE = /\b[a-z][a-z0-9+.-]*:\/\/[^\s"'<>\\]*/gi;

/** 오류 한 줄. viem 오류는 짧은 문장만 쓴다(긴 문장에는 `URL: …/<API 키>`·요청 본문이 붙는다) + HTTP 상태·시스템 오류 코드, URL은 지운다. */
function errorLine(e: unknown): string {
  const chain: { shortMessage?: string; message?: string; status?: unknown; code?: unknown }[] = [];
  for (let cur: unknown = e; cur && typeof cur === "object" && chain.length < 10; cur = (cur as { cause?: unknown }).cause) chain.push(cur as never);
  const top = chain[0];
  const status = chain.find((x) => typeof x.status === "number")?.status;
  const sys = chain.find((x) => typeof x.code === "string")?.code;
  const text = `${top?.shortMessage ?? top?.message ?? String(e)}${status === undefined ? "" : ` (HTTP ${String(status)})`}${sys === undefined ? "" : ` (${String(sys)})`}`;
  return text.replace(URL_RE, "<url>");
}

function credits(milli: number): string {
  return (milli / 1000).toFixed(3);
}

function printReport(r: ReplayReport): void {
  console.log(`rulesHash        ${r.rulesHash}`);
  console.log(`finalStateHash   ${r.finalStateHash}`);
  console.log(`windows          ${r.windows} (active ${r.activeWindows}), ticks ${r.ticks}, rejected inputs ${r.rejectedInputs}`);
  console.log("");
  console.log("pickaxe            owner        tier  status  end         price(cr)   base(cr)  lucky(cr)  bonus(cr)   paid(cr)   over(cr)  POP  BIG");
  for (const p of r.pickaxes) {
    console.log([
      p.key.padEnd(18), `${p.owner.slice(0, 10)}…`.padEnd(12), p.tier.padEnd(5), p.status.padEnd(7), (p.endReason ?? "-").padEnd(10),
      credits(p.priceMilli).padStart(10), credits(p.baseMilli).padStart(10), credits(p.luckyMilli).padStart(10), credits(p.bonusMilli).padStart(10),
      credits(p.paidMilli).padStart(10), credits(p.overMilli).padStart(10), (p.pop ? "Y" : "-").padStart(4), (p.bigPop ? "Y" : "-").padStart(4),
    ].join(" "));
  }
  console.log("");
  console.log("settlement (engine → chain settleEnd)  kind    cause           payout(cr)    over(cr)  window");
  for (const p of r.payouts) {
    console.log([
      `${p.purchaseId}:${p.itemIndex}`.padEnd(38), p.kind.padEnd(7), p.cause.padEnd(13), credits(p.payoutMilli).padStart(12), credits(p.overMilli).padStart(11),
      String(p.window).padStart(7),
    ].join(" "));
  }
  // (D125) 하늘 별 — 돈과 무관한 연출 사건이지만 누가 잡았는지도 같은 시드로 다시 얻는다
  if (r.sky.length > 0) {
    console.log("");
    console.log("sky star (D125)  kind     window     tick  pickaxe");
    for (const e of r.sky) {
      console.log([String(e.id).padEnd(16), e.kind.padEnd(8), String(e.window).padStart(7), String(e.tick).padStart(8), ` ${e.key ?? "-"}`].join(" "));
    }
  }
}

function printEpochReport(r: EpochVerifyReport, source: string): void {
  // 신뢰 뿌리 (M-4): 이 실행이 무엇을 믿었는지 — 맨 위에. 상점은 사람이 고른 값(--shop/--trust)이다
  const t = r.trust;
  console.log(`trust roots      (check these against your wallet and the explorer — not against the operator's files)`);
  console.log(`  chain id       ${t.chainId ?? "not read"}`);
  console.log(`  shop           ${t.shop}${t.shopPinned ? " (pinned by you)" : " (from world.json — NOT pinned)"}`);
  console.log(`  fairness       ${t.fairness ?? "not read from the chain"}`);
  console.log(`  seedRoot       ${t.seedRoot ?? "not read"}`);
  console.log(`  engine         ${t.engineVersionHash}`);
  for (const room of t.rooms) console.log(`  room ${String(room.roomId).padEnd(9)} catalog ${room.catalogHash} → rules ${room.rulesHash}`);
  console.log("");
  console.log(`epochs           ${r.firstEpoch} … ${r.epochs} (windows ${r.windows.first} … ${r.windows.last})`);
  console.log(`start            ${r.start ? `snapshot of epoch ${r.start.epoch} (window ${r.start.processedWindow}) = on-chain anchor ${r.start.anchorIndex}` : "genesis"}`);
  console.log(`engine           ${r.engineVersionHash}`);
  console.log(`chain values     ${source}, events through block ${r.chainThroughBlock}`);
  console.log(`input log head   ${r.head}`);
  for (const room of r.stateHashes.rooms) console.log(`room ${String(room.roomId).padEnd(11)} ${room.stateHash}`);
  console.log(`batches          ${r.batches.length} completed (${r.batches.map((b) => `room ${b.roomId} #${b.batchIndex}`).join(", ") || "none"})`);
  const s = r.settlements;
  console.log(
    `settlements      ${s.checked} on-chain checked (settleEnd + VoidOverPaid), ${s.matched} matched, ${s.mismatches.length} failed (E12: amount/kind/overdue/void over), ` +
    `${s.unsettled.length} unsettled (warning, not yet due), ${s.skipped} outside the replay range`,
  );
  for (const m of s.mismatches) console.log(`  ✘ ${m.code} ${describeSettlementMismatch(m)}`);
  for (const p of s.unsettled.slice(0, 20)) console.log(`  ! unsettled ${p.key} ${p.kind} ${p.payoutMilli}+${p.overMilli} (room ${p.roomId}, window ${p.window})`);
  if (s.unsettled.length > 20) console.log(`  ! … ${s.unsettled.length - 20} more unsettled`);
  const l = r.linkage;
  console.log(
    `linkage          ${l.matched}/${l.checked} chain inputs at their window, ${l.pending} pending past window ${r.windows.last} (room-window cap), ` +
    `${l.mismatches.length} mismatched, ${l.problems.length} rule problems`,
  );
  for (const p of l.problems) console.log(`  ✘ ${p.code} ${p.detail}`);
  for (const m of l.mismatches) console.log(`  ✘ ${describeLinkMismatch(m)}`);
  if (r.purchase) {
    console.log("");
    console.log(`purchase ${r.purchase.purchaseId}     kind    payout(cr)    over(cr)  window  chain`);
    for (const i of r.purchase.items) {
      const chainSide = i.settled ? `settleEnd ${i.settled.kind} ${credits(Number(i.settled.payoutMilli))}+${credits(Number(i.settled.overMilli))} (block ${i.settled.blockNumber})`
        : i.voidOverPaid ? `VoidOverPaid ${credits(Number(i.voidOverPaid.overMilli))} (block ${i.voidOverPaid.blockNumber})` : "none";
      console.log([
        `  ${i.key}`.padEnd(18), (i.replayed?.kind ?? "-").padEnd(7), (i.replayed ? credits(i.replayed.payoutMilli) : "-").padStart(12),
        (i.replayed ? credits(i.replayed.overMilli) : "-").padStart(11), String(i.replayed?.window ?? "-").padStart(7), ` ${i.status} ${chainSide}`,
      ].join(" "));
    }
  }
  console.log("");
  for (const c of r.checks) console.log(`${c.ok ? "✔" : "✘"} ${c.name}${c.ok || !c.detail ? "" : `  — ${c.detail}`}`);
  if (r.checks.some((c) => c.name === "engine build = world.engineVersionHash" && !c.ok)) {
    console.log("  (this world was produced by another engine build / rules version — verify it with the verifier release tagged with the world's engineVersionHash)");
  }
  console.log("");
  console.log(r.ok ? `OK: ${r.checks.length} checks passed, ${r.anchors.length} anchors matched` : `FAILED: ${r.checks.filter((c) => !c.ok).length} of ${r.checks.length} checks failed`);
}

process.exitCode = await main().catch((e: unknown) => {
  const code = (e as { code?: unknown }).code;
  if (typeof code === "string" && code.startsWith("ERR_PARSE_ARGS")) {
    console.error(`${(e as Error).message}\n${USAGE}`);
    return 2;
  }
  console.error(`pikit-verify: ${errorLine(e)}`);
  return 1;
});
