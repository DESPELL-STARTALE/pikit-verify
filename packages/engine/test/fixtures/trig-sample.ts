// 자식 프로세스용: detSinCos를 정해진 입력 20만 개에 돌려 결과 바이트(빅엔디언 double)의 SHA-256을 출력한다.
// trig.test.ts가 `node --jitless`와 보통 `node`로 각각 실행해 비트가 같은지 본다.
import { createHash } from "node:crypto";
import { detSinCos, Xoshiro128ss } from "../../src/index.js";

const n = Number(process.argv[2] ?? "200000");
const r = Xoshiro128ss.fromBytes(new Uint8Array(16).map((_, i) => i * 17 + 3));
const buf = new DataView(new ArrayBuffer(16 * n));
for (let i = 0; i < n; i++) {
  // 절반은 엔진이 실제로 쓰는 [−π, π], 절반은 넓은 범위(±1000)
  const u = r.next();
  const x = i % 2 === 0 ? (u * 2 - 1) * Math.PI : (u * 2 - 1) * 1000;
  const { sin, cos } = detSinCos(x);
  buf.setFloat64(16 * i, sin, false);
  buf.setFloat64(16 * i + 8, cos, false);
}
process.stdout.write(`${JSON.stringify({
  jitless: process.execArgv.includes("--jitless"),
  digest: createHash("sha256").update(new Uint8Array(buf.buffer)).digest("hex"),
})}\n`);
