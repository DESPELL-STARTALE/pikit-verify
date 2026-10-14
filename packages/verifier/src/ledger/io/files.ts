import {
  epochWindows, LEDGER_FILE_SCHEMA_ID, LEDGER_LEAVES_SCHEMA_ID, LedgerEpochFile, LedgerLeavesFile, rootThroughWindow, sha256Hex,
  type Hex32, type LedgerDecision, type LedgerFileList, type LedgerListEntry, type LedgerSessionRecord, type SignedWindowList,
} from "@pikit/protocol";
import type { LedgerContext } from "../rules/context.js";
import { sessionKeyOf } from "../rules/auth.js";
import type { LedgerState } from "../rules/state.js";

// ──────────────────────────────────────────────────────────────────────────
// 장부 공개 파일 만들기·읽기 (ledgerHash **밖** — 모양은 protocol `ledger-files.ts`, 바꾸면 replayHash만 바뀐다).
//   `ledger/<e>.json`        pikit.ledger/v1        에폭 e의 명단 + 결정 + 쓰인 세션 허가 + 명단 창의 블록 timestamp
//   `ledger/leaves/<k>.json` pikit.ledger-leaves/v1 루트 k 경계의 잎 전부
// 파일 바이트 = JSON.stringify(파일) (game-server 에폭 파일과 같은 관례). dataHash의 sha256은 **공개된 바이트 그대로**에서 잰다(fileSha256).
// ──────────────────────────────────────────────────────────────────────────

/** 서명된 명단 + 장부 결정 → 장부 파일 안의 명단. */
export function ledgerFileList(list: SignedWindowList, decisions: readonly LedgerDecision[]): LedgerFileList {
  if (decisions.length !== list.entries.length) throw new Error(`list ${list.window}: ${decisions.length} decisions for ${list.entries.length} entries`);
  return { ...list, decisions: [...decisions] };
}

/** 명단 항목들이 쓰는 세션 허가 (지갑·세션 키 오름차순, 중복 없음). lookup = (wallet, sessionKey) → 그 허가 기록 (없으면 undefined — 파일에 싣지 않는다). */
export function sessionsUsed(
  entries: readonly LedgerListEntry[], lookup: (wallet: string, sessionKey: string) => LedgerSessionRecord | undefined,
): LedgerSessionRecord[] {
  const out = new Map<string, LedgerSessionRecord>();
  for (const e of entries) {
    if (e.kind === "GRANT") continue;
    const k = sessionKeyOf(e.intent.wallet, e.intent.sessionKey);
    if (out.has(k)) continue;
    const rec = lookup(e.intent.wallet, e.intent.sessionKey);
    if (rec) out.set(k, rec);
  }
  return [...out.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)).map(([, r]) => r);
}

export interface LedgerEpochFileInput {
  ctx: LedgerContext;
  epoch: number;
  genesisBlock: number;
  /** 이 에폭 명단(빈 명단 제외)과 결정 — 창 순서는 상관없다(정렬한다). */
  lists: readonly LedgerFileList[];
  /** 이 에폭 명단의 BUY·CANCEL이 쓴 세션 허가 (순서 상관없음, (wallet, sessionKey)마다 하나). */
  sessions: readonly LedgerSessionRecord[];
  /** 명단 창 w → 블록 w timestamp (unix 초). 명단 창은 모두 있어야 한다. */
  blockTimestamps: ReadonlyMap<number, number>;
}

/** `ledger/<e>.json` 만들기 (zod 모양 검사까지). */
export function buildLedgerEpochFile(i: LedgerEpochFileInput): LedgerEpochFile {
  const { first, last } = epochWindows(i.epoch, i.genesisBlock);
  const lists = [...i.lists].sort((a, b) => a.window - b.window);
  const sessions = [...i.sessions].sort((a, b) => {
    const ka = sessionKeyOf(a.session.wallet, a.session.sessionKey);
    const kb = sessionKeyOf(b.session.wallet, b.session.sessionKey);
    return ka < kb ? -1 : ka > kb ? 1 : 0;
  });
  const blockTimestamps: Record<string, number> = {};
  for (const l of lists) {
    const ts = i.blockTimestamps.get(l.window);
    if (ts === undefined) throw new Error(`ledger file ${i.epoch}: no block timestamp for list ${l.window}`);
    blockTimestamps[String(l.window)] = ts;
  }
  return LedgerEpochFile.parse({
    schema: LEDGER_FILE_SCHEMA_ID, chainId: i.ctx.chainId, ledger: i.ctx.ledger.toLowerCase(), epoch: i.epoch,
    firstWindow: first, lastWindow: last, sessions, lists, blockTimestamps,
  });
}

export interface LedgerLeavesFileInput {
  chainId: number;
  ledger: string;
  rootIndex: number;
  epoch: number;
  genesisBlock: number;
  state: LedgerState;
}

/** `ledger/leaves/<k>.json` 만들기 (경계 상태). */
export function buildLedgerLeavesFile(i: LedgerLeavesFileInput): LedgerLeavesFile {
  return LedgerLeavesFile.parse({
    schema: LEDGER_LEAVES_SCHEMA_ID, chainId: i.chainId, ledger: i.ledger.toLowerCase(), rootIndex: i.rootIndex, epoch: i.epoch,
    throughWindow: rootThroughWindow(i.epoch, i.genesisBlock), nextPurchaseId: i.state.nextPurchaseId.toString(),
    ledgerRoot: i.state.root(), supplyMilli: i.state.supplyMilli().toString(), leaves: i.state.leaves(),
  });
}

export function parseLedgerEpochFile(x: unknown): LedgerEpochFile {
  return LedgerEpochFile.parse(x);
}

export function parseLedgerLeavesFile(x: unknown): LedgerLeavesFile {
  return LedgerLeavesFile.parse(x);
}

/** 공개하는 바이트 (JSON.stringify — 공백 없음). */
export function ledgerFileText(file: LedgerEpochFile | LedgerLeavesFile): string {
  return JSON.stringify(file);
}

/** dataHash 재료 sha256 — 받은(또는 쓴) 바이트 그대로. 문자열이면 UTF-8. */
export function fileSha256(content: string | Uint8Array): Hex32 {
  return sha256Hex(typeof content === "string" ? new TextEncoder().encode(content) : content);
}
