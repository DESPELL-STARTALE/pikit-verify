// 가스 한도 정책: gas = ceil(추정 × (1 + 여유)), 여유 5%(운영자·결정적) / 10%. 추정이 상한을 넘으면 경고하고 그래도 추정대로(2배 안),
// 2배를 넘으면 보내지 않는다(GasEstimateTooHighError). 한도를 추정 밑으로 깎지 않는다 (Monad는 가스 부족 되돌림에도 한도 전액을 청구).
// 개정 7(명세 20): 보내는 함수는 PikitLedger postRoot·revealSeed 둘뿐이다 (D4에서 개정 6 함수 상한을 지웠다).
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { GAS_CAPS, GasEstimateTooHighError, gasCap, gasFor, gasPadPct } from "../src/index.js";

// forge test --isolate 최대값 [최대 gas, 그때의 단위 수] (contracts/README.md 가스 표와 같이 고친다).
const FORGE_MAX: Record<keyof typeof GAS_CAPS, [bigint, number]> = {
  postRoot: [513_798n, 4096],       // 개정 7 PikitLedger (D197): 4,096단계. 첫 루트 60단계 116,752
  revealSeed: [452_539n, 4096],
};

// Monad eth_estimateGas 실측 [추정, 단위 수]. 상한 ≥ 추정 × 1.5
const MONAD_ESTIMATE: [keyof typeof GAS_CAPS, bigint, number][] = [
  ["postRoot", 114_942n, 60],       // 개정 7 PikitLedger 첫 루트 (2026-10-13, 상태 덮어쓰기 추정 — tx 없음)
  ["postRoot", 98_326n, 60],        // 이후 루트
];

describe("gas caps", () => {
  it("only the rev 7 operator calls have caps (postRoot, revealSeed)", () => {
    assert.deepEqual(Object.keys(GAS_CAPS).sort(), ["postRoot", "revealSeed"]);
    for (const fn of ["buyWithCredits", "settleEnd", "anchor", "grantPromo", "commitBatches"]) assert.ok(!(fn in GAS_CAPS), fn);
  });

  it("scales per seed step", () => {
    assert.equal(gasCap("revealSeed", 4096), 50_000n + 140n * 4096n);
    assert.equal(gasCap("postRoot", 60), 198_400n);
    assert.throws(() => gasCap("postRoot", -1));
    assert.throws(() => gasCap("postRoot", 1.5));
  });

  it("covers the measured gas (forge --isolate max × 1.35, contracts/README.md 가스 표)", () => {
    for (const fn of Object.keys(GAS_CAPS) as (keyof typeof GAS_CAPS)[]) {
      const [max, units] = FORGE_MAX[fn];
      assert.ok(gasCap(fn, units) * 100n >= max * 135n, `${fn} cap ${gasCap(fn, units)} < forge max ${max} × 1.35`);
    }
  });

  it("covers the Monad estimates × 1.5 (cold storage is far dearer on Monad than in forge)", () => {
    for (const [fn, estimate, units] of MONAD_ESTIMATE) {
      assert.ok(gasCap(fn, units) * 10n >= estimate * 15n, `${fn}(${units}) cap ${gasCap(fn, units)} < Monad estimate ${estimate} × 1.5`);
    }
  });

  it("pads a sane estimate by 5% (operator, deterministic), rounded up, never below the estimate", () => {
    const warns: string[] = [];
    const warn = (m: string) => warns.push(m);
    for (const fn of ["postRoot", "revealSeed"] as const) assert.equal(gasPadPct(fn), 5n, fn);
    assert.equal(gasFor("postRoot", 114_942n, { units: 60, warn }), 120_690n);
    // 상한 바로 밑의 추정: 여유가 상한을 넘어도 자르지 않는다 (가스 부족 되돌림은 한도 전액을 낸다)
    const cap = gasCap("postRoot", 60);
    assert.equal(gasFor("postRoot", cap, { units: 60, warn }), (cap * 105n + 99n) / 100n, "estimate = cap is still the sane branch");
    assert.deepEqual(warns, []);
  });

  it("above the cap but within 2 × cap: sends estimate + pad and warns (cheaper than a revert that pays the whole limit)", () => {
    const warns: string[] = [];
    const cap = gasCap("revealSeed", 1);
    assert.equal(gasFor("revealSeed", cap + 1n, { units: 1, warn: (m) => warns.push(m) }), ((cap + 1n) * 105n + 99n) / 100n);
    assert.equal(gasFor("revealSeed", 2n * cap, { units: 1, warn: (m) => warns.push(m) }), (2n * cap * 105n + 99n) / 100n, "exactly 2 × cap is still sent");
    assert.equal(warns.length, 2);
    assert.match(warns[0]!, new RegExp(`GAS ESTIMATE ABOVE CAP: revealSeed estimate ${cap + 1n} > cap ${cap}`));
  });

  it("refuses an estimate above 2 × cap (the public RPC's 24M estimates): throws GasEstimateTooHighError, nothing to send", () => {
    const warns: string[] = [];
    assert.throws(() => gasFor("postRoot", 23_938_769n, { units: 60, warn: (m) => warns.push(m) }), (e: unknown) => {
      assert.ok(e instanceof GasEstimateTooHighError);
      assert.deepEqual([e.fn, e.estimate, e.cap], ["postRoot", 23_938_769n, 198_400n]);
      assert.match(e.message, /GAS ESTIMATE REFUSED: postRoot estimate 23938769 > 2 × cap 198400/);
      return true;
    });
    assert.deepEqual(warns, [], "a refusal does not also warn");
  });
});
