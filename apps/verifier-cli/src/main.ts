#!/usr/bin/env node
// pikit-verify — 공개 엔진과 공개 장부 규칙으로 기록을 다시 돌려 체인과 대조한다.
//  (1) 방 하나 v0 재생:  pikit-verify --catalog <catalog.json> --log <input-log.json> [--json] [--expect <expected.json>]
//  (2) 세계 검증(개정 7, 명세 20 — 시간당 장부 루트, D205):
//        pikit-verify verify (--contract <PikitLedger> | --trust <trust.json>) --dir <folder|URL>
//                            [--root <k|latest>] [--from-snapshot <j|genesis>] [--since-state <file>] [--write-state <file>] [--max-roots <n>]
//                            [--rpc <url1>[,<url2>] | --chain <chain.json>] [--max-rps <n>] [--log-chunk <n>] [--json]
//      신뢰 뿌리 (M-4, D162): PikitLedger 주소는 운영자 파일(world.json)에서 받지 않는다 — --contract(또는 사람이 따로 받은 --trust 파일의
//        contract)가 world.json의 shop과 다르면 실패. 체인 ledgerHash = 이 빌드의 장부 규칙 해시, 체인 rulesHash = keccak(catalogHash ‖ 이 빌드
//        엔진 해시)여야 한다. 보고서 맨 위에 체인 id·PikitLedger·seedRoot·rulesHash·ledgerHash·엔진·방마다 카탈로그와 RPC 호스트 이름을 찍는다.
//        --rpc 두 곳은 서로 다른 호스트여야 한다(같은 호스트 = 사용법 오류, 같은 도메인 = 경고).
//      공개 폴더(한 폴더 — chog.pikit.fun/epochs 모양): world.json, catalogs/<catalogHash>.json, <e>.json(입력 기록 v3), ledger/<e>.json(장부),
//        snapshots/<e>.json(루트 경계 세계), ledger/leaves/<k>.json(루트 k 잎). 루트가 덮는 파일이 하나라도 없으면 검증 실패.
//      체인 값: --rpc면 RPC에서 바로(RpcLedgerSource — 운영자를 믿지 않음, 두 곳이면 모든 값 대조, 다르면 실패). --max-rps(기본 20)는 곳마다
//        (그리고 HTTP 파일 읽기에도). --rpc가 없으면 --chain 또는 <dir>/chain.json(pikit.ledger-chain/v1) — 운영자의 말이라 경고.
//      범위: --root k | latest(기본, 체인 마지막 루트). 시작은 기본 바로 앞 루트의 경계(= 루트 하나만), --from-snapshot j면 루트 j 경계에서,
//        --from-snapshot genesis면 처음부터. --max-roots n이면 한 번에 n 루트까지(따라잡기).
//      감시자 이어 받기 (H-1, D163 → v2): --since-state <파일>이면 앞 실행이 검증한 마지막 루트 경계에서 체인 마지막 루트까지(--max-roots씩),
//        --write-state <파일>이면 성공했을 때만 다음 시작점(루트 번호 + 그 칸)을 쓴다. 상태 파일이 없으면 처음부터.
//        새 루트가 없으면 "up to date"로 종료 0(상태 그대로 다시 쓴다).
//      종료 코드: 0 = 모든 검사 통과, 1 = 검증 실패(파일 누락·RPC 불일치 포함) 또는 그 밖의 오류, 2 = 사용법 오류,
//        3 = 전송 오류(HTTP 429·5xx, 시간 초과, 연결·DNS — 검증 결과가 아니라 지금 읽지 못함, D182). --json 이면 stdout 에
//        { "ok": null, "errorKind": "transport", "error": "<상태 또는 원인을 실은 한 줄, URL 은 호스트 + 경로만 (D183)>" }.
//        체인 끝 경합(D183): 없는 공개 파일이 **모두** 확정 머리 − PUBLISH_LAG_BLOCKS 보다 늦게 실린 루트의 것이면 종료 3 +
//        { "ok": null, "errorKind": "tip-race", "error", "retryAfterSec" } — 공개 서버·CDN 반영 전일 수 있다. 그보다 오래된 루트의 파일이 없으면 실패(종료 1).
import { join } from "node:path";
import { parseArgs } from "node:util";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { WorldManifest } from "@pikit/protocol";
import {
  DEFAULT_MAX_RPS, LEDGER_VERSION_HASH, localEngineVersionHash, nextVerifyState, replay, resumePoint, RpcLedgerSource, StaticLedgerSource, verifyLedger,
  VerifyRangeError, VerifyState, type LedgerChainSource, type LedgerTrustPins, type LedgerVerifyReport, type ReplayReport, type RootRange,
} from "@pikit/verifier";
import { FileReader, isUrl, joinPath } from "./files.js";
import { errorLine, isTransportError, TipRaceError } from "./errors.js";
import { rpcHosts, trustPins } from "./trust.js";

const USAGE = [
  "usage: pikit-verify --catalog <catalog.json> --log <input-log.json> [--json] [--expect <expected-report.json>]",
  "       pikit-verify verify (--contract <PikitLedger> | --trust <trust.json>) --dir <folder|URL>",
  "                           [--root <k|latest>] [--from-snapshot <j|genesis>] [--since-state <file>] [--write-state <file>] [--max-roots <n>]",
  "                           [--rpc <url1>[,<url2>] | --chain <chain.json>] [--max-rps <n>] [--log-chunk <n>] [--json]",
  "         --contract       the PikitLedger address you trust (never taken from the operator's world.json)",
  "         --trust          a JSON file { contract, chainId?, ledgerHash?, rulesHash? } — every value given is checked against the chain",
  "         --dir            public files: world.json, catalogs/, <e>.json, ledger/, snapshots/ (a folder or e.g. https://chog.pikit.fun/epochs)",
  "         --root           the last root to verify (default latest = the last root on chain)",
  "         --from-snapshot  start from the boundary (snapshot + leaves file) of root j, or genesis. Default: the root before --root",
  "                          (one root). Not with --since-state",
  "         --since-state    resume after the last root the previous successful run verified (verify-state.json; missing file = from",
  "                          genesis) — what a watcher runs so that no root is ever skipped",
  "         --write-state    on success, write where the next run must start (the file is left alone when the run fails)",
  "         --max-roots      verify at most n roots this run (catch up in steps; the state records how far it got)",
  "         --rpc            read chain values straight from the chain (finalized blocks); two URLs = cross-check every value —",
  "                          they must be two different providers (same host = refused)",
  "         --chain          chain values from a file (default <dir>/chain.json for a folder) — the operator's word",
  `         --max-rps        requests per second per RPC endpoint and for HTTP files (default ${DEFAULT_MAX_RPS})`,
  "         --log-chunk      with --rpc: blocks per eth_getLogs (default 100, halved on a range error)",
].join("\n");

/**
 * 체인 끝 경합의 경계 (D183, docs/VERIFY.md §2.1·§8). 루트가 덮는 파일이 404 일 때 그 루트가 확정 머리 − 400 블록(≈ 2분)보다 늦게 실렸으면
 * "아직 안 보임"(종료 3, tip-race), 그보다 오래됐으면 "공개됐어야 할 파일이 없음"(검증 실패, 종료 1). game-server 는 경계 파일을 쓴 뒤 루트 행을
 * 만들고 settler 가 그 뒤 postRoot 하므로 원본에는 이미 있다 — 남는 것은 공개 서버·CDN 반영(몇 초).
 */
const PUBLISH_LAG_BLOCKS = 400;
/** tip-race 뒤 다시 돌리기까지 (루프 VERIFY_TIP_RETRY_SEC 기본과 같다). */
const TIP_RETRY_SEC = 30;

async function main(): Promise<number> {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      catalog: { type: "string" },
      log: { type: "string" },
      json: { type: "boolean", default: false },
      expect: { type: "string" },
      dir: { type: "string" },
      chain: { type: "string" },
      rpc: { type: "string" },
      root: { type: "string" },
      "from-snapshot": { type: "string" },
      "max-rps": { type: "string" },
      "log-chunk": { type: "string" },
      contract: { type: "string" },
      trust: { type: "string" },
      "since-state": { type: "string" },
      "write-state": { type: "string" },
      "max-roots": { type: "string" },
      help: { type: "boolean", short: "h", default: false },
    },
  });
  if (values.help) { console.log(USAGE); return 0; }
  if (positionals[0] === "verify") {
    try {
      return await verifyCommand(values);
    } catch (e) {
      if (e instanceof TipRaceError) {
        if (values.json) console.log(JSON.stringify({ ok: null, errorKind: "tip-race", error: e.message, retryAfterSec: TIP_RETRY_SEC }, null, 2));
        console.error(`pikit-verify: ${e.message}`);
        return 3;
      }
      if (!isTransportError(e)) throw e;
      const line = errorLine(e);
      if (values.json) console.log(JSON.stringify({ ok: null, errorKind: "transport", error: line }, null, 2));
      console.error(`pikit-verify: ${line}`);
      return 3;
    }
  }
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
  dir?: string | undefined;
  chain?: string | undefined;
  rpc?: string | undefined;
  root?: string | undefined;
  "from-snapshot"?: string | undefined;
  "max-rps"?: string | undefined;
  "log-chunk"?: string | undefined;
  contract?: string | undefined;
  trust?: string | undefined;
  "since-state"?: string | undefined;
  "write-state"?: string | undefined;
  "max-roots"?: string | undefined;
  json?: boolean | undefined;
}

/** k | latest → 숫자 또는 "latest", 틀리면 null(사용법 오류). */
function rootArg(s: string | undefined, word: "latest" | "genesis"): number | "latest" | "genesis" | undefined | null {
  if (s === undefined) return undefined;
  if (s === word) return word;
  const x = Number(s);
  return /^[0-9]+$/.test(s) && Number.isSafeInteger(x) ? x : null;
}

/** 범위 줄 — deploy/verifier/loop.mjs parseRangeLine 이 이 줄로 따라잡기 여부와 뒤처진 정도를 안다 (바꾸면 같이, D181). */
function rangeLine(r: RootRange): string {
  return `pikit-verify: roots ${r.firstRoot} … ${r.lastRoot} of ${r.latestRoot} (epochs ${r.firstEpoch} … ${r.lastEpoch} of ${r.latestEpoch}; ${r.note})`;
}

async function verifyCommand(v: VerifyArgs): Promise<number> {
  const last = rootArg(v.root, "latest");
  const from = rootArg(v["from-snapshot"], "genesis");
  const maxRpsArg = numberArg(v["max-rps"], Number.MIN_VALUE, false);
  const maxRps = maxRpsArg === undefined ? DEFAULT_MAX_RPS : maxRpsArg;
  const logChunk = numberArg(v["log-chunk"], 1, true);
  const maxRoots = numberArg(v["max-roots"], 1, true);
  const sinceState = v["since-state"];
  const rpcUrls = v.rpc === undefined ? [] : v.rpc.split(",").map((x) => x.trim()).filter((x) => x !== "");
  let pins: LedgerTrustPins;
  let hosts: string[];
  try {
    pins = trustPins(v.contract, v.trust === undefined ? undefined : readJson(v.trust));
    hosts = rpcHosts(rpcUrls);
  } catch (e) {
    console.error(`pikit-verify: ${(e as Error).message}\n${USAGE}`);
    return 2;
  }
  const domains = hosts.map((h) => h.split(".").slice(-2).join("."));
  if (hosts.length === 2 && domains[0] === domains[1]) {
    console.error(`warning: both --rpc endpoints are under ${domains[0]} — make sure they are two different providers (an endpoint you do not trust can only be outvoted by an independent one)`);
  }
  if (!v.dir || last === null || from === null || last === "genesis" || from === "latest" || maxRps === null || logChunk === null || maxRoots === null
    || (v.rpc !== undefined && (v.chain !== undefined || rpcUrls.length < 1 || rpcUrls.length > 2)) || (logChunk !== undefined && v.rpc === undefined)
    || (sinceState !== undefined && from !== undefined) || (isUrl(v.dir) && v.rpc === undefined && v.chain === undefined)) {
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
  let chain: LedgerChainSource;
  let source: string;
  if (v.rpc !== undefined) {
    chain = new RpcLedgerSource({ rpcUrls, ledger: pins.contract, maxRps, ...(logChunk !== undefined ? { logChunk } : {}) });
    source = `${rpcUrls.length === 2 ? "RPC ×2, cross-checked" : "RPC"} (${hosts.join(", ")}), finalized blocks (read directly — no operator file)`;
    console.error(`pikit-verify: reading chain values over ${rpcUrls.length === 2 ? "two RPC endpoints (every value cross-checked)" : "RPC"} at ≤ ${maxRps} req/s each — this can take a while`);
  } else {
    const file = v.chain ?? join(dir, "chain.json");
    chain = new StaticLedgerSource(JSON.parse(readFileSync(file, "utf8")));
    source = `file ${file} (operator-supplied)`;
    console.error(`warning: chain values from ${file} are the operator's word, not read from the chain — use --rpc <url> to check against the chain`);
  }

  // 앞 실행의 상태 (H-1): 같은 PikitLedger·엔진·장부 규칙이어야 한다. 없으면 처음부터
  let state: VerifyState | null = null;
  if (sinceState !== undefined) {
    if (existsSync(sinceState)) {
      state = VerifyState.parse(readJson(sinceState));
      if (state.contract !== pins.contract) throw new Error(`--since-state is for PikitLedger ${state.contract}, not ${pins.contract}`);
      if (state.engineVersionHash !== localEngineVersionHash() || state.ledgerHash !== LEDGER_VERSION_HASH) {
        throw new Error(`--since-state was written for engine ${state.engineVersionHash} / ledger rules ${state.ledgerHash}; this build is ${localEngineVersionHash()} / ${LEDGER_VERSION_HASH} — a new world starts a new state`);
      }
      console.error(`pikit-verify: state: verified through root ${state.lastRoot} (epoch ${state.epoch}); resuming from its boundary`);
    } else {
      console.error(`warning: no state file ${sinceState} — verifying from genesis (a first run, or the previous state was lost)`);
    }
  }
  const writeState = (s: VerifyState) => {
    if (v["write-state"] === undefined) return;
    writeFileSync(v["write-state"], `${JSON.stringify(s, null, 2)}\n`);
    console.error(`pikit-verify: wrote ${v["write-state"]}: verified through root ${s.lastRoot} (epoch ${s.epoch}), the next run starts from its boundary`);
  };

  const world = WorldManifest.parse(await need(joinPath(dir, "world.json")));
  const catalogs = new Map<string, unknown>();
  for (const r of world.rooms) if (!catalogs.has(r.catalogHash)) catalogs.set(r.catalogHash, await files.json(joinPath(dir, "catalogs", `${r.catalogHash}.json`)) ?? undefined);
  for (const [k, c] of catalogs) if (c === undefined) catalogs.delete(k);

  let report: LedgerVerifyReport;
  try {
    report = await verifyLedger({
      world, catalogs, chain, trust: pins,
      range: { last: last ?? "latest", ...(from !== undefined ? { from } : sinceState !== undefined && state === null ? { from: "genesis" as const } : {}), ...(maxRoots !== undefined ? { maxRoots } : {}) },
      ...(state ? { resume: resumePoint(state) } : {}),
      read: (paths) => files.many(paths.map((p) => joinPath(dir, p)), (done) => console.error(`pikit-verify: ${done} files read`)),
      onRange: (r) => console.error(rangeLine(r)),
      onProgress: (line) => console.error(`pikit-verify: ${line}`),
    });
  } catch (e) {
    if (e instanceof VerifyRangeError) {
      console.error(`pikit-verify: ${e.message}`);
      return 1;
    }
    throw e;
  }
  if (report.upToDate && state) {
    const line = `up to date: root ${report.roots!.latest} is the last root on chain, already verified (state: through root ${state.lastRoot}, epoch ${state.epoch})`;
    console.log(v.json ? JSON.stringify({ ok: true, upToDate: true, roots: report.roots, epochs: report.epochs, note: line }, null, 2) : line);
    writeState(state);
    return 0;
  }
  // 없는 파일이 모두 방금 실린 루트의 것이면 아직 안 보이는 것 (tip-race, 종료 3). 오래된 루트의 파일이 하나라도 없으면 실패 (F-1)
  if (!report.ok && report.missing.length > 0 && report.missing.every((m) => m.postedBlock > report.chainThroughBlock - PUBLISH_LAG_BLOCKS)) {
    const roots = [...new Set(report.missing.map((m) => m.rootIndex))];
    throw new TipRaceError(
      `root ${roots.join(", ")} files not published yet (${report.missing.slice(0, 3).map((m) => m.path).join(", ")}${report.missing.length > 3 ? " …" : ""}) — posted less than `
      + `${PUBLISH_LAG_BLOCKS} blocks before the finalized head ${report.chainThroughBlock} (tip race, not a verification failure; retry in ${TIP_RETRY_SEC} s)`,
    );
  }
  if (state && report.trust.chainId !== null && report.trust.chainId !== state.chainId) {
    report.checks.push({ name: "verify-state chainId = chain", ok: false, detail: `state ${state.chainId} vs chain ${report.trust.chainId}` });
    report.ok = false;
  }
  if (v.json) console.log(JSON.stringify(report, null, 2));
  else printLedgerReport(report, source);
  if (report.ok) writeState(nextVerifyState(report));
  return report.ok ? 0 : 1;
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

function credits(milli: number | bigint | string): string {
  const m = BigInt(milli);
  const sign = m < 0n ? "-" : "";
  const a = m < 0n ? -m : m;
  return `${sign}${a / 1000n}.${String(a % 1000n).padStart(3, "0")}`;
}

function printReport(r: ReplayReport): void {
  console.log(`rulesHash        ${r.rulesHash}`);
  console.log(`finalStateHash   ${r.finalStateHash}`);
  console.log(`windows          ${r.windows} (active ${r.activeWindows}), ticks ${r.ticks}, rejected inputs ${r.rejectedInputs}`);
  console.log("");
  // 막타(규칙 9, LAST HIT): 몫 lastHit(cr)와 횟수 LH — E = base + lucky + bonus + lastHit
  // (규칙 10) PICK = 소환 때 뽑은 LUCKY PICK 바닥 ×m(보충 pick(cr) = 정산 T_main − min(X, 총상한)), JACKPOT = 받은 골든 CHOG 잭팟 J. paid + over = T_main + J
  console.log("pickaxe            owner        tier  status  end         price(cr)   base(cr)  lucky(cr)  bonus(cr) lastHit(cr)   paid(cr)   over(cr)  POP  BIG   LH   PICK    pick(cr)  JACKPOT(cr)");
  for (const p of r.pickaxes) {
    console.log([
      p.key.padEnd(18), `${p.owner.slice(0, 10)}…`.padEnd(12), p.tier.padEnd(5), p.status.padEnd(7), (p.endReason ?? "-").padEnd(10),
      credits(p.priceMilli).padStart(10), credits(p.baseMilli).padStart(10), credits(p.luckyMilli).padStart(10), credits(p.bonusMilli).padStart(10),
      credits(p.lastHitMilli).padStart(11), credits(p.paidMilli).padStart(10), credits(p.overMilli).padStart(10), (p.pop ? "Y" : "-").padStart(4),
      (p.bigPop ? "Y" : "-").padStart(4), String(p.lastHits).padStart(4), pickLevel(p.pickLevelBps).padStart(6), credits(p.pickMilli).padStart(11),
      credits(p.jackpotMilli).padStart(12),
    ].join(" "));
  }
  console.log("");
  console.log("settlement (engine payout)              kind    cause           payout(cr)    over(cr)  window");
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
  // (규칙 10) LUCKY PICK 단계 수 — 단계는 곡괭이 표 PICK 열, 소환 사건 전부는 --json의 luckyPicks
  if (r.luckyPicks.length > 0) {
    const byLevel = new Map<number, number>();
    for (const e of r.luckyPicks) byLevel.set(e.pickLevelBps, (byLevel.get(e.pickLevelBps) ?? 0) + 1);
    console.log("");
    console.log(`LUCKY PICK       ${r.luckyPicks.length} spawns with a level: ${[...byLevel].sort((a, b) => a[0] - b[0]).map(([bps, n]) => `${pickLevel(bps)} ${n}`).join(" · ")}`);
  }
  // (규칙 10) 골든 CHOG 잭팟 — 균열마다 한 줄 (통 전부가 그 곡괭이로, 통은 0부터)
  if (r.jackpots.length > 0) {
    console.log("");
    console.log("JACKPOT           window     tick  wallet        pickaxe              amount(cr)  pool after(cr)");
    for (const j of r.jackpots) {
      console.log([
        "".padEnd(16), String(j.window).padStart(7), String(j.tick).padStart(8), ` ${j.owner.slice(0, 10)}…`.padEnd(13), j.key.padEnd(18),
        credits(j.amountMilli).padStart(12), credits(j.poolAfterMilli).padStart(15),
      ].join(" "));
    }
  }
  console.log("");
  console.log(`jackpot          pool now ${credits(r.jackpot.poolMilli)} (contributed ${credits(r.jackpot.contributedMilli)}, paid ${credits(r.jackpot.paidMilli)}, wins ${r.jackpot.wins})`);
}

/** LUCKY PICK 단계 bps → "×1.1" (없음 "-"). */
function pickLevel(bps: number): string {
  return bps > 0 ? `×${bps / 10_000}` : "-";
}

function printLedgerReport(r: LedgerVerifyReport, source: string): void {
  // 신뢰 뿌리 (M-4): 이 실행이 무엇을 믿었는지 — 맨 위에. PikitLedger 주소는 사람이 고른 값(--contract/--trust)이다
  const t = r.trust;
  console.log("trust roots      (check these against your wallet and the explorer — not against the operator's files)");
  console.log(`  chain id       ${t.chainId ?? "not read"}`);
  console.log(`  PikitLedger    ${t.contract}${t.contractPinned ? " (pinned by you)" : " (from world.json — NOT pinned)"}`);
  console.log(`  seedRoot       ${t.seedRoot ?? "not read"}`);
  console.log(`  genesisBlock   ${t.genesisBlock ?? "not read"}`);
  console.log(`  rulesHash      ${t.rulesHash ?? "not read"} (chain)`);
  console.log(`  ledgerHash     ${t.ledgerHash ?? "not read"} (chain) — this build ${t.ledgerVersionHash}`);
  console.log(`  engine         ${t.engineVersionHash}`);
  for (const room of t.rooms) console.log(`  room ${String(room.roomId).padEnd(9)} catalog ${room.catalogHash} → rules ${room.rulesHash}`);
  if (t.announcer) console.log(`  announcer      ${t.announcer} (the latest ANNOUNCE key; each window's key comes from AnnouncerChanged)`);
  console.log("");
  if (r.roots) console.log(`roots            ${r.roots.first} … ${r.roots.last} of ${r.roots.latest}${r.epochs ? ` (epochs ${r.epochs.first} … ${r.epochs.last}${r.windows ? `, windows ${r.windows.first} … ${r.windows.last}` : ""})` : ""}`);
  console.log(`start            ${r.start ? `boundary of root ${r.start.root} (epoch ${r.start.epoch}, window ${r.start.throughWindow}): snapshot + leaves file` : "genesis"}`);
  console.log(`chain values     ${source}, read at block ${r.chainThroughBlock}`);
  const l = r.ledger;
  const rej = Object.entries(l.rejected).map(([k, n]) => `${k} ${n}`).join(", ");
  console.log(`ledger           ${l.lists} signed lists, ${l.entries} entries: ${l.applied} applied, ${l.entries - l.applied} rejected${rej ? ` (${rej})` : ""}`);
  console.log(`                 grants ${credits(l.grantedMilli)} cr, ${l.sessions} session grants (${l.erc1271Sessions} ERC-1271 checked on chain), ${l.payouts} payouts`);
  console.log(`linkage          ${r.linkage.matched}/${r.linkage.checked} listed intents at their window in the input log, ${r.linkage.mismatches} mismatched`);
  console.log(`batches          ${r.batches} completed, regenerated from seeds + block hashes`);
  // (규칙 10) 잭팟 통 — 재생한 엔진 상태 (방 상태 해시 → roomsStateRoot가 묶는다), 보고만
  for (const j of r.jackpotPools) {
    console.log(`jackpot room ${String(j.roomId).padEnd(3)} pool now ${credits(j.poolMilli)} (contributed ${credits(j.contributedMilli)}, paid ${credits(j.paidMilli)}, wins ${j.wins}; ${j.cracksInRange} in this range)`);
  }
  for (const x of r.rootResults) {
    console.log(`root ${String(x.rootIndex).padEnd(11)} epochs ${x.fromEpoch} … ${x.epoch}, through window ${x.throughWindow}, posted at block ${x.postedBlock}: ${x.ok ? "✔ 10 fields match" : `✘${x.mismatchedFields.length > 0 ? ` ${x.mismatchedFields.join(", ")} differ` : ""}`}`);
  }
  console.log("");
  for (const c of r.checks) console.log(`${c.ok ? "✔" : "✘"} ${c.name}${c.ok || !c.detail ? "" : `  — ${c.detail}`}`);
  if (r.checks.some((c) => !c.ok && /^trust: (engine build|ledger rules build)/.test(c.name))) {
    // 공개 저장소 태그 = 세계마다 하나 (D229, PUBLIC.md "Which tag"): 이 빌드의 엔진 앞 10자로 4세계 태그 이름을 보여 준다 (규칙 10, D248)
    console.log(`  (this world was produced by another engine or ledger-rules build — check out the public repo tag for that world: world 4 = w4-rules<version>-<engine, 10 hex>`
      + ` (this build: …-${t.engineVersionHash.slice(2, 12)}), world 3 = w3-rules9-39d1ae79c2, world 2 = w2-ledger-e219e71372, world 1 = engine-ac38812c12; see PUBLIC.md)`);
  }
  console.log("");
  console.log(r.ok ? `OK: ${r.checks.length} checks passed, ${r.rootResults.length} roots matched` : `FAILED: ${r.checks.filter((c) => !c.ok).length} of ${r.checks.length} checks failed`);
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
