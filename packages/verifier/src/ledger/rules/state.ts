import { LEDGER_CURRENCY_FREE, ledgerRoot, ledgerSupplyMilli, type Hex32, type LedgerLeaf } from "@pikit/protocol";

// ──────────────────────────────────────────────────────────────────────────
// 장부 상태 (계획 §2.4 · §2.10, D199). **ledgerHash 안** — `packages/verifier/src/ledger/rules/**`는 `emit-ledger-info.mjs`가 해시한다.
//   지갑 → { balanceMilli, openStakeMilli, lastSeq, lastGrantDay } + 전역 nextPurchaseId (0부터 — 옛 상점 _purchaseCount와 같은 출발).
//   잎 = 하나라도 0이 아닌 지갑만, 지갑 오름차순. currency = 0, withdrawTotalMilli = 0 (CHOG 대비 칸).
// 금액은 bigint(밀리크레딧). 지갑 키는 소문자 주소.
// ──────────────────────────────────────────────────────────────────────────

export interface LedgerAccount {
  balanceMilli: bigint;
  openStakeMilli: bigint;
  lastSeq: bigint;
  lastGrantDay: number;
}

/** 장부 규칙 위반 (재생 중 나오면 입력·엔진이 장부와 어긋났다는 뜻 — 결정이 아니라 오류). */
export class LedgerInvariantError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "LedgerInvariantError";
  }
}

const ZERO: Readonly<LedgerAccount> = Object.freeze({ balanceMilli: 0n, openStakeMilli: 0n, lastSeq: 0n, lastGrantDay: 0 });

function isZero(a: LedgerAccount): boolean {
  return a.balanceMilli === 0n && a.openStakeMilli === 0n && a.lastSeq === 0n && a.lastGrantDay === 0;
}

export class LedgerState {
  private readonly map = new Map<string, LedgerAccount>();

  constructor(public nextPurchaseId: bigint = 0n) {
    if (nextPurchaseId < 0n) throw new LedgerInvariantError("nextPurchaseId < 0");
  }

  /** 읽기 (없으면 0 계정 — 넣지 않는다). */
  get(wallet: string): Readonly<LedgerAccount> {
    return this.map.get(wallet.toLowerCase()) ?? ZERO;
  }

  /** 고칠 계정 (없으면 0으로 만든다). */
  account(wallet: string): LedgerAccount {
    const k = wallet.toLowerCase();
    let a = this.map.get(k);
    if (!a) this.map.set(k, a = { ...ZERO });
    return a;
  }

  /** 0이 아닌 계정 (지갑 오름차순). */
  wallets(): string[] {
    return [...this.map.entries()].filter(([, a]) => !isZero(a)).map(([w]) => w).sort();
  }

  clone(): LedgerState {
    const s = new LedgerState(this.nextPurchaseId);
    for (const [w, a] of this.map) s.map.set(w, { ...a });
    return s;
  }

  /** 잎 (0이 아닌 지갑, 지갑 오름차순) — 잎 파일·ledgerRoot 재료. */
  leaves(): LedgerLeaf[] {
    return this.wallets().map((wallet) => {
      const a = this.map.get(wallet)!;
      return {
        wallet, currency: LEDGER_CURRENCY_FREE, balanceMilli: a.balanceMilli.toString(), openStakeMilli: a.openStakeMilli.toString(),
        withdrawTotalMilli: "0", lastSeq: a.lastSeq.toString(), lastGrantDay: a.lastGrantDay,
      };
    });
  }

  root(): Hex32 {
    return ledgerRoot(this.leaves());
  }

  /** Σ(balance + openStake) (무료 모드 withdrawTotal = 0). */
  supplyMilli(): bigint {
    return ledgerSupplyMilli(this.leaves());
  }

  /** 잎 파일 → 상태 (경계 스냅숏에서 이어 갈 때). 잎은 모양이 맞아야 하고 지갑이 겹치면 안 된다. */
  static fromLeaves(leaves: readonly LedgerLeaf[], nextPurchaseId: bigint | string): LedgerState {
    const s = new LedgerState(BigInt(nextPurchaseId));
    for (const l of leaves) {
      const w = l.wallet.toLowerCase();
      if (s.map.has(w)) throw new LedgerInvariantError(`fromLeaves: wallet ${w} twice`);
      if (l.currency !== LEDGER_CURRENCY_FREE || l.withdrawTotalMilli !== "0") throw new LedgerInvariantError(`fromLeaves: ${w} has a non-free currency or a withdrawal`);
      s.map.set(w, { balanceMilli: BigInt(l.balanceMilli), openStakeMilli: BigInt(l.openStakeMilli), lastSeq: BigInt(l.lastSeq), lastGrantDay: l.lastGrantDay });
    }
    return s;
  }
}
