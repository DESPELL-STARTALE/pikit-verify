// 감사 F-9 CI 검사 (명세 16 §4.5·§8.7, 명세 17 §2.11 P0-12): 출시 카탈로그를 실제 엔진으로 돌려 등급마다
//   rewardCapBps/1e4 + E[over]/price < 0.98 · over 상한 ≤ 100 × 가격 · rewardCapBps ≤ 9700
//   + REWARD 상한 ≤ 0.90 × 가격 · over 상한 ≥ LUCKY 최대 (D153)
// 을 확인한다. 계산은 test/tools/f9.ts f9Check — CI 규칙 동결 스크립트(scripts/ci/rules-freeze.mjs)도 같은 함수를 부른다. 3인 방, 시드 고정 = 결정론.
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { MAX_OVER_MULTIPLE, MAX_REWARD_CAP_BPS } from "@pikit/protocol";
import { loadCatalogFor } from "./tools/balance.js";
import { f9Check } from "./tools/f9.js";

describe("F-9: REWARD cap + E[over] stays below the price", () => {
  const catalog = loadCatalogFor("normal");
  const check = f9Check(catalog);
  const f9 = check.report;

  it("rewardCapBps ≤ 9700", () => {
    assert.ok(f9.rewardCapBps <= MAX_REWARD_CAP_BPS, `rewardCapBps ${f9.rewardCapBps}`);
  });

  for (const t of f9.tiers) {
    it(`${t.code}: cap + E[over]/price < 0.98 and over cap ≤ ${MAX_OVER_MULTIPLE} × price`, () => {
      assert.ok(t.n >= 200, `표본 ${t.n}개`);
      assert.ok(t.sum < 0.98, `${t.code}: ${t.capShare} + ${t.eOver.toFixed(4)} = ${t.sum.toFixed(4)}`);
      assert.ok(t.overCapMilli <= t.overCapLimitMilli, `${t.code}: over cap ${t.overCapMilli} > ${t.overCapLimitMilli}`);
    });
  }

  for (const t of check.tiers) {
    it(`${t.code}: REWARD cap ≤ 0.90 × price and over cap ≥ the LUCKY maximum`, () => {
      assert.ok(t.rewardCapMilli <= t.rewardCapLimitMilli, `${t.code}: ${t.rewardCapMilli} > ${t.rewardCapLimitMilli}`);
      assert.ok(t.overCapMilli >= t.luckyMaxMilli, `${t.code}: ${t.overCapMilli} < ${t.luckyMaxMilli}`);
    });
  }

  it("the tool's verdict agrees", () => {
    assert.equal(f9.ok, true);
    assert.deepEqual(check.problems, []);
    assert.equal(check.ok, true);
  });

  it("f9Check catches a catalog that breaks a rule (REWARD cap 95% of the price)", () => {
    const bad = f9Check({ ...catalog, reward: { ...catalog.reward, rewardCapBps: 9500 } }, { seeds: 2, pickaxes: 5 });
    assert.equal(bad.ok, false);
    assert.ok(bad.problems.some((p) => /REWARD cap .* > 0\.90 × price/.test(p)), bad.problems.join("\n"));
  });
});
