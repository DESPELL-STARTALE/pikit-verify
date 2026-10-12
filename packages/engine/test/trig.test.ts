// 결정론 삼각함수 (src/trig.ts): 정확도, 사분면, −0 없음, `--jitless`와 같은 비트, 고정 다이제스트.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { detCos, detSin, detSinCos } from "../src/index.js";

// 다항식 계수·범위 줄이기를 바꾸면 이 값이 바뀐다 → 규칙(궤적)이 바뀌는 변경이므로 일부러 고정한다.
const PINNED_DIGEST = "cdd92aa6d23134e8df198d2034903c427032aca0259335edb0e95189ac201a4f";

describe("detSin / detCos", () => {
  it("agree with Math.sin / Math.cos within 1e-11 over [−π, π] and ±1000", () => {
    let worst = 0;
    for (let i = 0; i <= 20000; i++) {
      for (const x of [-Math.PI + (2 * Math.PI * i) / 20000, -1000 + (2000 * i) / 20000]) {
        worst = Math.max(worst, Math.abs(detSin(x) - Math.sin(x)), Math.abs(detCos(x) - Math.cos(x)));
      }
    }
    assert.ok(worst < 1e-11, `worst error ${worst}`);
  });

  it("exact at the quadrant points that matter and never returns −0", () => {
    assert.equal(detSin(0), 0);
    assert.equal(detCos(0), 1);
    assert.ok(!Object.is(detSin(-0), -0), "sin(−0) must be +0");
    assert.ok(Math.abs(detSin(Math.PI / 2) - 1) < 1e-15 && Math.abs(detCos(Math.PI) + 1) < 1e-15);
    for (let i = -40; i <= 40; i++) {
      const { sin, cos } = detSinCos(i * 0.1);
      assert.ok(!Object.is(sin, -0) && !Object.is(cos, -0));
      assert.ok(Math.abs(sin * sin + cos * cos - 1) < 1e-11, "sin² + cos² = 1");
    }
  });

  it("is odd / even and 2π-periodic up to rounding", () => {
    for (let i = 1; i < 500; i++) {
      const x = i * 0.0123;
      assert.ok(Math.abs(detSin(-x) + detSin(x)) < 1e-15);
      assert.equal(detCos(-x), detCos(x));
      assert.ok(Math.abs(detSin(x + 2 * Math.PI) - detSin(x)) < 1e-12);
    }
  });

  it("`node --jitless` and normal `node` give the same bits for 200,000 inputs (pinned digest)", () => {
    const script = fileURLToPath(new URL("./fixtures/trig-sample.js", import.meta.url));
    const normal = JSON.parse(execFileSync(process.execPath, [script], { encoding: "utf8" })) as { jitless: boolean; digest: string };
    const jitless = JSON.parse(execFileSync(process.execPath, ["--jitless", script], { encoding: "utf8" })) as { jitless: boolean; digest: string };
    assert.equal(normal.jitless, false);
    assert.equal(jitless.jitless, true, "자식 프로세스에 --jitless가 걸려 있어야 함");
    assert.equal(jitless.digest, normal.digest);
    assert.equal(normal.digest, PINNED_DIGEST);
  });
});
