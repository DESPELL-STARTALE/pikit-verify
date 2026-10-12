// 엔진 본체(src/)에 결정론을 깨는 호출이 없는지 검사한다 (설계 부록 E-1, docs/determinism.md).
// 허용: + − × ÷, Math.sqrt / floor / ceil / round / abs / min / max / imul, 상수 Math.PI.
// 금지: Math.random, Date, performance.now, Math.pow 와 ** 연산자, 초월함수(exp/log/sin/cos/tan/atan2/hypot/cbrt…), Node API.
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const srcDir = fileURLToPath(new URL("../src/", import.meta.url));
const rules = [
  [/\bMath\.random\b/, "Math.random — 주입된 Rng를 쓴다"],
  [/\bMath\.(pow|exp|expm1|log|log1p|log2|log10|sin|cos|tan|asin|acos|atan|atan2|sinh|cosh|tanh|asinh|acosh|atanh|hypot|cbrt|fround)\b/, "구현마다 결과가 다를 수 있는 Math 함수"],
  [/\*\*/, "** 연산자(Math.pow와 같음) — 상수는 카탈로그에 미리 계산"],
  [/\bDate\b|\bperformance\b/, "벽시계 — 시간은 정수 틱"],
  [/from\s+["']node:|require\(|\bprocess\./, "Node API — 엔진은 Node·브라우저 API 없이 돈다"],
  [/\bsetTimeout\b|\bsetInterval\b/, "타이머 — 엔진은 호출자가 윈도 단위로 돌린다"],
];

function walk(dir) {
  return readdirSync(dir).flatMap((name) => {
    const p = join(dir, name);
    return statSync(p).isDirectory() ? walk(p) : p.endsWith(".ts") ? [p] : [];
  });
}

const problems = [];
for (const file of walk(srcDir)) {
  readFileSync(file, "utf8").split("\n").forEach((line, i) => {
    // 주석은 검사하지 않는다: 한 줄 블록 주석, 줄 주석, /** … */ 블록의 줄
    const code = line.replace(/\/\*.*?\*\//g, "").replace(/\/\/.*$/, "");
    if (/^\s*(\/\*|\*)/.test(code)) return;
    for (const [re, why] of rules) if (re.test(code)) problems.push(`${file}:${i + 1}: ${why}\n    ${line.trim()}`);
  });
}

if (problems.length > 0) {
  console.error(`check-forbidden: ${problems.length} problem(s)\n${problems.join("\n")}`);
  process.exit(1);
}
console.log("check-forbidden: engine src is free of Math.random / Math.pow / ** / transcendental Math / Date / Node APIs");
