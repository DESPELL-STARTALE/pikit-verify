// 자식 프로세스용: 판 생성기만 돌려 {jitless, hash, batches}를 출력한다 (규칙 7 띠 생성의 결정론 — board.test.ts가 `node --jitless`와 비교).
//   board-hash.js <seed> <batches>
import { generateRows, loadCatalog } from "../helpers.js";

const seedNo = Number(process.argv[2] ?? "7");
const batches = Number(process.argv[3] ?? "3");
const run = generateRows(loadCatalog(), seedNo, batches);
process.stdout.write(`${JSON.stringify({ jitless: process.execArgv.includes("--jitless"), hash: run.hash, batches: run.batches.length })}\n`);
