// 가스 한도 정책: gas = ceil(추정 × (1 + 여유)), 여유 5%(운영자·결정적) / 10%. 추정이 상한을 넘으면 경고하고 그래도 추정대로(2배 안),
// 2배를 넘으면 보내지 않는다(GasEstimateTooHighError). 한도를 추정 밑으로 깎지 않는다 (Monad는 가스 부족 되돌림에도 한도 전액을 청구).
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { GAS_CAPS, GasEstimateTooHighError, gasCap, gasFor, gasPadPct } from "../src/index.js";

// forge test --isolate 최대값 [최대 gas, 그때의 단위 수] (contracts/README.md 가스 표와 같이 고친다). 2026-10-10 개정 5(D105) 값
const FORGE_MAX: Record<keyof typeof GAS_CAPS, [bigint, number]> = {
  buyWithCredits: [238_186n, 1],     // 정산 멈춤 검사가 무효 구매 8개를 지나는 최악 (10개 묶음 최대 223,574)
  cancelQueued: [130_796n, 10],     // 구매 10곳 각 1개: 구매마다 취소 비트 쓰기(M-2). 1개 54,198
  registerSessionKey: [60_816n, 0],
  settleEnd: [107_369n, 0],          // 개정 6: Reward + over, 새 시간 창
  settleEndMany: [407_840n, 10],     // 지갑 10곳 (한 지갑 10개 149,648, + over 1개 177,932)
  payOverAfterVoid: [91_604n, 0],    // 개정 6: 무효 구매의 over (새 시간 창)
  refundUnprocessed: [85_560n, 0],
  refundUnsettled: [70_137n, 0],
  grantPromo: [81_135n, 0],
  anchor: [136_903n, 60],
  revealSeed: [452_539n, 4096],
  commitBatches: [78_692n, 12],
  skipMissedBatches: [36_482n, 0],
  createRoom: [72_999n, 0],
  setRoomOpen: [30_657n, 0],
};

// Monad 테스트넷 eth_estimateGas 실측 [추정, 단위 수] (2026-10-09, 개정 4 배포 — vault 호출 포함, 개정 5는 이보다 싸다; docs/DEPLOY.md
// "Monad 실측"). 상한 ≥ 추정 × 1.5
const MONAD_ESTIMATE: [keyof typeof GAS_CAPS, bigint, number][] = [
  ["settleEnd", 152_471n, 0],       // 지갑 첫 지급 (개정 4 settle 값; 2026-10-09 사고: 상한 150,000으로 보내 가스 부족)
  ["settleEnd", 135_269n, 0],       // 따뜻함
  ["settleEndMany", 198_550n, 2],
  ["settleEndMany", 227_859n, 3],
  ["payOverAfterVoid", 152_471n, 0], // 실측 없음: settle 첫 지급과 같은 꼴로 본다
  ["anchor", 107_353n, 0],          // 첫 앵커(시드 공개)
  ["anchor", 114_290n, 0],          // 커서 전진
  ["commitBatches", 36_617n, 1],
  ["commitBatches", 66_444n, 12],
  ["grantPromo", 110_622n, 0],
  ["refundUnsettled", 123_577n, 0],
  ["buyWithCredits", 175_012n, 1],
];

describe("gas caps", () => {
  it("scales per unit (tiers, items, settlements, seed steps)", () => {
    assert.equal(gasCap("buyWithCredits", 1), GAS_CAPS.buyWithCredits.base + GAS_CAPS.buyWithCredits.perUnit);
    assert.equal(gasCap("settleEndMany", 20), GAS_CAPS.settleEndMany.base + 20n * GAS_CAPS.settleEndMany.perUnit);
    assert.equal(gasCap("grantPromo"), GAS_CAPS.grantPromo.base);
    assert.equal(gasCap("revealSeed", 4096), 50_000n + 140n * 4096n);
    assert.ok(gasCap("settleEndMany", 1) >= 101_392n * 135n / 100n, "first-ever settlement");
    assert.equal(gasCap("commitBatches", 12), 158_000n);
    assert.ok(gasCap("anchor", 4096) * 100n >= 497_442n * 135n);
    assert.throws(() => gasCap("buyWithCredits", -1));
    assert.throws(() => gasCap("buyWithCredits", 1.5));
  });

  it("covers the measured gas (forge --isolate max × 1.35, contracts/README.md 가스 표)", () => {
    for (const fn of Object.keys(GAS_CAPS) as (keyof typeof GAS_CAPS)[]) {
      const [max, units] = FORGE_MAX[fn];
      assert.ok(gasCap(fn, units) * 100n >= max * 135n, `${fn} cap ${gasCap(fn, units)} < forge max ${max} × 1.35`);
    }
  });

  it("covers the Monad testnet estimates × 1.5 (cold storage is far dearer on Monad than in forge)", () => {
    for (const [fn, estimate, units] of MONAD_ESTIMATE) {
      assert.ok(gasCap(fn, units) * 10n >= estimate * 15n, `${fn}(${units}) cap ${gasCap(fn, units)} < Monad estimate ${estimate} × 1.5`);
    }
  });

  it("pads a sane estimate by 5% for the operator's deterministic calls, 10% otherwise (rounded up), never below the estimate", () => {
    const warns: string[] = [];
    const warn = (m: string) => warns.push(m);
    assert.equal(gasFor("anchor", 91_053n, { units: 3, warn }), 95_606n);
    assert.equal(gasFor("commitBatches", 61_580n, { units: 12, warn }), 64_659n);
    assert.equal(gasFor("settleEnd", 66_431n, { warn }), 69_753n);
    assert.equal(gasFor("buyWithCredits", 175_012n, { units: 1, warn }), 192_514n);
    for (const fn of ["anchor", "revealSeed", "commitBatches", "skipMissedBatches", "settleEnd", "settleEndMany", "payOverAfterVoid"] as const) assert.equal(gasPadPct(fn), 5n, fn);
    for (const fn of ["buyWithCredits", "cancelQueued", "registerSessionKey", "grantPromo", "refundUnprocessed", "refundUnsettled"] as const) {
      assert.equal(gasPadPct(fn), 10n, fn);
    }
    assert.equal(gasFor("settleEnd", 152_471n, { warn }), 160_095n, "the 2026-10-09 settle estimate now goes out padded, not clipped to 150,000");
    // 상한 바로 밑의 추정: 여유가 상한을 넘어도 자르지 않는다 (가스 부족 되돌림은 한도 전액을 낸다)
    assert.equal(gasFor("grantPromo", GAS_CAPS.grantPromo.base - 1n, { warn }), 186_999n);
    assert.equal(gasFor("grantPromo", GAS_CAPS.grantPromo.base, { warn }), 187_000n, "estimate = cap is still the sane branch");
    assert.deepEqual(warns, []);
  });

  it("above the cap but within 2 × cap: sends estimate + pad and warns (cheaper than a revert that pays the whole limit)", () => {
    const warns: string[] = [];
    const cap = gasCap("settleEnd");
    assert.equal(gasFor("settleEnd", cap + 1n, { warn: (m) => warns.push(m) }), ((cap + 1n) * 105n + 99n) / 100n);
    assert.equal(gasFor("settleEnd", 2n * cap, { warn: (m) => warns.push(m) }), (2n * cap * 105n + 99n) / 100n, "exactly 2 × cap is still sent");
    assert.equal(gasFor("settleEndMany", 400_000n, { units: 2, warn: (m) => warns.push(m) }), 420_000n, "units scale the cap (230k + 2 × 47k = 324k)");
    assert.equal(warns.length, 3);
    assert.match(warns[0]!, new RegExp(`GAS ESTIMATE ABOVE CAP: settleEnd estimate ${cap + 1n} > cap ${cap}`));
  });

  it("revision 5 has no MON path, revision 6 no separate jackpot settlement (D105, D138)", () => {
    for (const fn of ["buy", "withdraw", "executeWithdraw", "settle", "settleMany"]) assert.ok(!(fn in GAS_CAPS), fn);
  });

  it("refuses an estimate above 2 × cap (the public RPC's 24M estimates): throws GasEstimateTooHighError, nothing to send", () => {
    const warns: string[] = [];
    assert.throws(() => gasFor("settleEnd", 23_938_769n, { warn: (m) => warns.push(m) }), (e: unknown) => {
      assert.ok(e instanceof GasEstimateTooHighError);
      assert.deepEqual([e.fn, e.estimate, e.cap], ["settleEnd", 23_938_769n, GAS_CAPS.settleEnd.base]);
      assert.match(e.message, /GAS ESTIMATE REFUSED: settleEnd estimate 23938769 > 2 × cap 300000/);
      return true;
    });
    assert.throws(() => gasFor("settleEnd", 2n * gasCap("settleEnd") + 1n, { warn: (m) => warns.push(m) }), GasEstimateTooHighError);
    assert.deepEqual(warns, [], "a refusal does not also warn");
  });
});
