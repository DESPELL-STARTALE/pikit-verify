import {
  entriesHash, entryHash, grantRef, hashBuyIntent, hashCancelQueue, recoverWindowListSigner, type Hex32,
} from "@pikit/protocol";
import type { LedgerListEntry } from "@pikit/protocol";
import { contextDomain, type LedgerContext } from "./context.js";

// ──────────────────────────────────────────────────────────────────────────
// 명단 모양 검사 (ledgerHash 안). 명단 = ANNOUNCE 키가 서명한 (window, entriesHash, count) + 항목 본문.
//   ref = BUY·CANCEL은 의향서 EIP-712 다이제스트, GRANT는 grantRef (다시 계산해 같아야 한다)
//   entriesHash = keccak(entryHash(kind, roomId, ref) …) (GRANT의 roomId = 0), count = 항목 수 ≥ 1
// 어긋나면 결정이 아니라 오류(LedgerListError) — 서명된 머리와 본문이 맞지 않는 명단은 장부에 들어갈 수 없다(검증기 'list entries' 실패).
// 서명자(ANNOUNCE 키)가 그 창에 유효한지는 체인 `AnnouncerChanged`를 읽는 쪽(game-server 부팅 검사·검증기)이 정해 넘긴다.
// ──────────────────────────────────────────────────────────────────────────

/** 장부에 들어가는 명단 (SignedWindowList·LedgerFileList의 공통 부분). */
export interface LedgerListLike {
  window: number;
  entriesHash: string;
  count: number;
  entries: readonly LedgerListEntry[];
}

export class LedgerListError extends Error {
  constructor(readonly window: number, message: string) {
    super(`list ${window}: ${message}`);
    this.name = "LedgerListError";
  }
}

/** 항목의 ref를 본문에서 다시 계산한다 (본문 모양이 틀리면 던진다). */
export function computeEntryRef(ctx: LedgerContext, e: LedgerListEntry): Hex32 {
  const domain = contextDomain(ctx);
  switch (e.kind) {
    case "BUY": return hashBuyIntent(domain, e.intent);
    case "CANCEL": return hashCancelQueue(domain, e.intent);
    case "GRANT": return grantRef(e.grant);
  }
}

/** entryHash 재료의 방 (GRANT = 0). */
export function entryRoomId(e: LedgerListEntry): number {
  return e.kind === "GRANT" ? 0 : e.intent.roomId;
}

/** 본문의 entriesHash (ref는 본문에서 다시 계산한 값). */
export function computeEntriesHash(ctx: LedgerContext, entries: readonly LedgerListEntry[]): Hex32 {
  return entriesHash(entries.map((e) => entryHash(e.kind, entryRoomId(e), computeEntryRef(ctx, e))));
}

/** 명단 모양: count = 항목 수 ≥ 1, ref마다 = 다시 계산한 값, entriesHash = 다시 계산한 값. 어긋나면 LedgerListError. */
export function checkListStructure(ctx: LedgerContext, list: LedgerListLike): void {
  const fail = (m: string): never => { throw new LedgerListError(list.window, m); };
  if (!Number.isSafeInteger(list.window) || list.window < 0) fail("bad window");
  if (list.entries.length === 0) fail("empty lists are not signed or stored");
  if (list.count !== list.entries.length) fail(`count ${list.count} ≠ ${list.entries.length} entries`);
  const hashes: Hex32[] = [];
  list.entries.forEach((e, i) => {
    let ref: Hex32;
    try {
      ref = computeEntryRef(ctx, e);
    } catch (err) {
      return fail(`entry ${i}: malformed ${e.kind} (${(err as Error).message.split("\n")[0]})`);
    }
    if (e.ref.toLowerCase() !== ref) fail(`entry ${i}: ref ${e.ref} ≠ ${e.kind === "GRANT" ? "grantRef" : "intent digest"} ${ref}`);
    hashes.push(entryHash(e.kind, entryRoomId(e), ref));
  });
  const h = entriesHash(hashes);
  if (list.entriesHash.toLowerCase() !== h) fail(`entriesHash ${list.entriesHash} ≠ recomputed ${h}`);
}

/** WindowList 서명자 (소문자 주소). 서명 바이트가 틀리면 null. */
export async function listSigner(ctx: LedgerContext, list: LedgerListLike & { signature: string }): Promise<string | null> {
  try {
    return await recoverWindowListSigner(contextDomain(ctx), { window: list.window, entriesHash: list.entriesHash, count: list.count }, list.signature as `0x${string}`);
  } catch {
    return null;
  }
}
