// 자식 프로세스용: 시나리오 하나를 돌리고 {jitless, v8, hash, paid} JSON을 출력한다.
// determinism.test.ts가 `node --jitless`와 보통 `node`로 각각 실행해 결과를 비교한다.
//   run-scenario.js <seed> <windows>          무작위 계획 (지갑 3개, 동결 포함)
//   run-scenario.js busy <seed> <windows>     (D125) 지갑 8개가 쉬지 않고 사는 바쁜 판 — 하늘 별이 떨어지고 잡히고 커진다
import { busyBoard, fuzzPlan, loadCatalog, runPlan, seedFrom } from "../helpers.js";

const busy = process.argv[2] === "busy";
const args = busy ? process.argv.slice(3) : process.argv.slice(2);
const seedNo = Number(args[0] ?? "7");
const windows = Number(args[1] ?? "400");
const catalog = loadCatalog();
const seed = seedFrom(seedNo);
const run = busy ? busyBoard(catalog, seedNo, windows) : { ...runPlan(catalog, seed, fuzzPlan(catalog, seed, windows, true), windows), sky: [] };
process.stdout.write(`${JSON.stringify({
  jitless: process.execArgv.includes("--jitless"),
  v8: process.versions.v8,
  hash: run.hash,
  paid: run.results.map((r) => [r.key, r.paidMilli]),
  sky: run.sky.map((e) => [e.window, e.tick, e.kind, e.key, e.x, e.y]),
})}\n`);
