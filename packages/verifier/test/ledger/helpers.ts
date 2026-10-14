// 장부 시험 공용: 키·세계 값·서명한 항목·명단 만들기. 고정 키 + RFC 6979 서명이라 결과가 늘 같다.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { engineVersionHash } from "@pikit/engine";
import {
  canonicalHash, entriesHash, entryHash, grantRef, hashBuyIntent, hashCancelQueue, ledgerDomain, ledgerPrivateKeySigner, onchainRulesHash, parseCatalog,
  signBuyIntent, signCancelQueue, signLedgerSession, signWindowList,
  type BuyIntentMessage, type CancelQueueMessage, type Catalog, type GrantMessage, type Hex32, type LedgerListEntry, type LedgerSessionRecord, type SignedWindowList,
} from "@pikit/protocol";
import { entryRoomId, type LedgerContext } from "../../src/index.js";

export const CHAIN_ID = 143;
export const LEDGER = "0x1ed6e00000000000000000000000000000000007";
export const W0 = 1000;
/** 블록 W0의 timestamp: 2026-10-20 00:00:00 UTC (day 20746). 블록마다 +1초 (계산이 쉽게). */
export const T0 = 1_792_454_400;
export const ts = (w: number) => T0 + (w - W0);
export const DAY0 = Math.floor(T0 / 86_400);

export const KEY = (n: number) => `0x${n.toString(16).padStart(64, "0")}` as `0x${string}`;
export const ANNOUNCE = ledgerPrivateKeySigner(KEY(0xa11));

export function loadNormal(): Catalog {
  return parseCatalog(JSON.parse(readFileSync(fileURLToPath(import.meta.resolve("@pikit/protocol/catalogs/normal.json")), "utf8")));
}

export function makeContext(catalog: Catalog = loadNormal(), roomIds: readonly number[] = [1]): LedgerContext {
  const rulesHash = onchainRulesHash(canonicalHash(catalog) as Hex32, engineVersionHash() as Hex32);
  return { chainId: CHAIN_ID, ledger: LEDGER, rooms: roomIds.map((roomId) => ({ roomId, createdWindow: W0, catalog, rulesHash })) };
}

export const domain = () => ledgerDomain(LEDGER, CHAIN_ID);

/** 플레이어 = 지갑 키 + 세션 키. */
export interface Player {
  wallet: ReturnType<typeof ledgerPrivateKeySigner>;
  session: ReturnType<typeof ledgerPrivateKeySigner>;
}
export function player(n: number): Player {
  return { wallet: ledgerPrivateKeySigner(KEY(0x1000 + n)), session: ledgerPrivateKeySigner(KEY(0x2000 + n)) };
}

export async function sessionRecord(p: Player, expiresAt: number | bigint = T0 + 7 * 86_400, signer: Player["wallet"] = p.wallet): Promise<LedgerSessionRecord> {
  const session = { wallet: p.wallet.address, sessionKey: p.session.address, expiresAt: String(expiresAt) };
  return { session, signature: await signLedgerSession(signer.sign, domain(), session), erc1271Block: null };
}

export async function buy(p: Player, o: { roomId?: number; rulesHash: string; tiers: number[]; seq: number | bigint; target: number; signer?: Player["session"] }): Promise<LedgerListEntry> {
  const intent: BuyIntentMessage = {
    wallet: p.wallet.address, sessionKey: p.session.address, roomId: o.roomId ?? 1, rulesHash: o.rulesHash.toLowerCase(), tiers: o.tiers, seq: String(o.seq), targetWindow: o.target,
  };
  return { kind: "BUY", ref: hashBuyIntent(domain(), intent), intent, signature: await signBuyIntent((o.signer ?? p.session).sign, domain(), intent) };
}

export async function cancel(p: Player, o: { roomId?: number; items: (bigint | string)[]; seq: number | bigint; target: number }): Promise<LedgerListEntry> {
  const intent: CancelQueueMessage = {
    wallet: p.wallet.address, sessionKey: p.session.address, roomId: o.roomId ?? 1, items: o.items.map(String), seq: String(o.seq), targetWindow: o.target,
  };
  return { kind: "CANCEL", ref: hashCancelQueue(domain(), intent), intent, signature: await signCancelQueue(p.session.sign, domain(), intent) };
}

export function grant(wallet: string, amountMilli: bigint | number, day: number): LedgerListEntry {
  const g: GrantMessage = { wallet, amountMilli: String(amountMilli), day, reason: "DAILY" };
  return { kind: "GRANT", ref: grantRef(g), grant: g };
}

/** 항목 → ANNOUNCE 키가 서명한 명단. */
export async function signedList(window: number, entries: LedgerListEntry[], announcer = ANNOUNCE): Promise<SignedWindowList> {
  const eh = entriesHash(entries.map((e) => entryHash(e.kind, entryRoomId(e), e.ref as Hex32)));
  const head = { window, entriesHash: eh, count: entries.length };
  return { ...head, signer: announcer.address, signature: await signWindowList(announcer.sign, domain(), head), entries };
}

/** 결정 짧은 글 ("APPLIED#3" · "APPLIED" · "SEQ_USED"). */
export const brief = (d: { status: string; reason: string | null; purchaseId: string | null }) =>
  d.status === "APPLIED" ? (d.purchaseId === null ? "APPLIED" : `APPLIED#${d.purchaseId}`) : d.reason!;

/** 작은 결정적 난수 (mulberry32). */
export function prng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
