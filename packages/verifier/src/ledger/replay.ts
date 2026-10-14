import type { LedgerDecision, LedgerEpochFile, LedgerFileList, LedgerRootFields, PayoutLeaf } from "@pikit/protocol";
import { authenticateEntries, sessionTable, type EntryAuth } from "./rules/auth.js";
import type { WindowApplication } from "./rules/apply.js";
import type { LedgerContext } from "./rules/context.js";
import { checkListStructure, listSigner } from "./rules/list.js";
import { ledgerRootFields, type RootFieldInputs } from "./rules/root.js";
import { LedgerState } from "./rules/state.js";
import { ledgerWindow, type LedgerEngineStep, type LedgerWindowResult } from "./rules/window.js";

// ──────────────────────────────────────────────────────────────────────────
// 공개 장부 파일로 장부를 다시 돈다 (ledgerHash 밖 — 순서·규칙은 rules/의 ledgerWindow가 정한다). 검증기(B5)·시험·game-server 복원이 쓴다.
//   1) addEpochFile: 파일의 세계(chainId·ledger)가 맞는지, 명단마다 모양(ref·entriesHash·count — 틀리면 LedgerListError를 던짐),
//      ANNOUNCE 서명자(announcerAt이 주어지면 그 창의 유효 키와 대조 → listProblems), 의향서·세션 인증(rules/auth)
//   2) window(w, runEngine): 그 창 명단(있으면)을 ledgerWindow로 적용 → 결정이 파일과 같은지(decisionMismatches) → 엔진 → 정산
//   3) rootFields(...): 경계에서 루트 10칸 (그 범위의 지급 잎은 replayer가 모은다), takePeriod()로 다음 범위를 시작
// 공급 불변식(나)용으로 받은 GRANT 합과 손실(가격 − payout − over) 합을 센다.
// ──────────────────────────────────────────────────────────────────────────

export interface DecisionMismatch {
  window: number;
  index: number;
  file: LedgerDecision;
  replay: LedgerDecision;
}

interface LoadedList {
  list: LedgerFileList;
  auth: EntryAuth[];
  blockTimestamp: number;
}

export interface AddEpochOptions {
  /** 창 w에 유효한 ANNOUNCE 키(소문자) — 체인 `AnnouncerChanged`(fromWindow)로 정한다. 없으면 서명자 검사를 건너뛴다(라이브러리 시험용). */
  announcerAt?: (window: number) => string | null;
}

const sameDecision = (a: LedgerDecision, b: LedgerDecision) => a.status === b.status && a.reason === b.reason && a.purchaseId === b.purchaseId;

export class LedgerReplayer {
  readonly state: LedgerState;
  /** 시작 공급 (잎 파일에서 시작하면 그 공급). */
  readonly startSupplyMilli: bigint;
  grantedMilli = 0n;
  /** Σ(끝난 곡괭이 가격 − payout − over) — 음수일 수 있다(over가 크면). */
  lossMilli = 0n;
  readonly decisionMismatches: DecisionMismatch[] = [];
  /** 명단 서명 문제 (서명자가 그 창의 ANNOUNCE 키가 아님·서명 바이트 틀림). */
  readonly listProblems: string[] = [];
  private lists = new Map<number, LoadedList>();
  private payouts: PayoutLeaf[] = [];
  private applications: WindowApplication[] = [];

  constructor(readonly ctx: LedgerContext, state: LedgerState = new LedgerState()) {
    this.state = state;
    this.startSupplyMilli = state.supplyMilli();
  }

  /** 에폭 장부 파일 하나를 싣는다 (그 에폭 창들을 window()로 돌기 전에). */
  async addEpochFile(file: LedgerEpochFile, o: AddEpochOptions = {}): Promise<void> {
    if (file.chainId !== this.ctx.chainId || file.ledger !== this.ctx.ledger.toLowerCase()) {
      throw new Error(`ledger file ${file.epoch}: chainId/ledger ${file.chainId}/${file.ledger} ≠ world ${this.ctx.chainId}/${this.ctx.ledger}`);
    }
    const sessions = await sessionTable(this.ctx, file.sessions);
    for (const list of file.lists) {
      checkListStructure(this.ctx, list);
      if (o.announcerAt) {
        const want = o.announcerAt(list.window);
        const got = await listSigner(this.ctx, list);
        if (got === null || want === null || got !== want.toLowerCase()) {
          this.listProblems.push(`list ${list.window}: signed by ${got ?? "an invalid signature"}, the announcer for that window is ${want ?? "none"}`);
        }
        if (got !== null && list.signer !== got) this.listProblems.push(`list ${list.window}: signer field ${list.signer} ≠ recovered ${got}`);
      }
      const ts = file.blockTimestamps[String(list.window)];
      if (ts === undefined) throw new Error(`ledger file ${file.epoch}: no block timestamp for list ${list.window}`);
      this.lists.set(list.window, { list, auth: await authenticateEntries(this.ctx, list.entries, sessions), blockTimestamp: ts });
    }
  }

  /** 창 w의 블록 timestamp (명단이 있는 창만). 검증기는 RPC 값과 대조한다. */
  blockTimestamps(): Map<number, number> {
    return new Map([...this.lists].map(([w, l]) => [w, l.blockTimestamp]));
  }

  /** 윈도 w 재생. 명단 결정이 파일과 다르면 decisionMismatches에 남긴다. */
  window(w: number, runEngine: LedgerEngineStep): LedgerWindowResult {
    const loaded = this.lists.get(w) ?? null;
    const res = ledgerWindow(this.state, this.ctx, w, loaded ? { list: loaded.list, auth: loaded.auth, blockTimestamp: loaded.blockTimestamp } : null, runEngine);
    if (loaded && res.application) {
      res.application.decisions.forEach((d, i) => {
        const f = loaded.list.decisions[i]!;
        if (!sameDecision(f, d)) this.decisionMismatches.push({ window: w, index: i, file: f, replay: d });
      });
      this.grantedMilli += res.application.grantedMilli;
      this.applications.push(res.application);
      this.lists.delete(w);
    }
    for (const p of res.payouts) this.lossMilli += BigInt(p.priceMilli) - BigInt(p.payoutMilli) - BigInt(p.overMilli);
    this.payouts.push(...res.payouts);
    return res;
  }

  /** 공급 불변식(나)의 기대 공급. */
  expectedSupplyMilli(): bigint {
    return this.startSupplyMilli + this.grantedMilli - this.lossMilli;
  }

  /** 아직 돌지 않은 명단 창 (범위 끝에 남아 있으면 파일에 범위 밖 명단이 있다는 뜻). */
  unplayedLists(): number[] {
    return [...this.lists.keys()].sort((a, b) => a - b);
  }

  /** 지금 범위의 지급 잎·받은 항목 (루트 경계에서 꺼내고 비운다). */
  takePeriod(): { payouts: PayoutLeaf[]; applications: WindowApplication[] } {
    const out = { payouts: this.payouts, applications: this.applications };
    this.payouts = [];
    this.applications = [];
    return out;
  }

  /** 지금 범위의 지급 잎 (비우지 않음). */
  periodPayouts(): readonly PayoutLeaf[] {
    return this.payouts;
  }

  /** 지금 범위의 받은 항목 (비우지 않음 — 입력 = 명단 대조용, ledgerInputEvents로 넘긴다). */
  periodApplications(): readonly WindowApplication[] {
    return this.applications;
  }

  /** 경계의 루트 10칸 (지금 범위의 지급 잎으로). 칸을 만든 뒤 takePeriod()로 다음 범위를 시작한다. */
  rootFields(i: Omit<RootFieldInputs, "state" | "payouts">): LedgerRootFields {
    return ledgerRootFields({ ...i, state: this.state, payouts: this.payouts });
  }
}
