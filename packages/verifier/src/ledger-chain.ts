import { z } from "zod";
import { Address, BlockNumber, Bytes32, HexBytes, LedgerRootRecord, U32 } from "@pikit/protocol";

// ──────────────────────────────────────────────────────────────────────────
// 개정 7 검증기가 체인(PikitLedger, 명세 20 §3.1, D197)에서 읽는 값과 그 출처.
//   world()     불변값(seedRoot·genesisBlock·rulesHash·ledgerHash·roomIds·EPOCH_BLOCKS·ANNOUNCER_DELAY) + 기준 블록(pin = 확정 머리)의
//               rootCount·announcer·announcerFromWindow. 불변값은 생성자의 `WorldCreated`와 같은 값이다(immutable) — 사건을 찾으려고 배포 블록까지
//               로그를 훑지 않고 view로 읽는다.
//   root(k)     rootAt(k)(저장 4칸) + 그 postedBlock의 `RootPosted(k, Root)` 10칸 — 둘이 같아야 한다
//   announcerChanges(from, to)  블록 [from, to]의 `AnnouncerChanged(previous, next, fromWindow)`
//   blocks(from, to, timestamps)  윈도 [from, to]의 블록 해시(윈도 난수 재료) + 요청한 윈도의 블록 timestamp(명단 창 — 세션 기한·GRANT 날)
//   blockHashesAt(ws)  범위 밖 윈도의 블록 해시 (스냅숏 앞에서 시작한 묶음 줄)
//   isValidSignature(wallet, hash, sig, block)  ERC-1271 `isValidSignature`를 그 블록에서 (스마트 지갑 세션 허가, 계획 §2.9)
// 출처: RpcLedgerSource(ledger-rpc.ts — 체인에서 바로, RPC 2곳 교차 확인) 또는 StaticLedgerSource(여기, `pikit.ledger-chain/v1` 파일 = 운영자의 말).
// ──────────────────────────────────────────────────────────────────────────

/** PikitLedger의 불변값 + 기준 블록의 상태. */
export interface LedgerWorldFacts {
  chainId: number;
  ledger: string;               // 소문자 주소
  seedRoot: string;
  genesisBlock: number;
  rulesHash: string;
  ledgerHash: string;
  roomIds: number[];
  epochBlocks: number;
  announcerDelay: number;
  /** 기준 블록 (RPC: 곳들의 확정 머리 중 가장 작은 것). 모든 상태 읽기는 이 블록에서. */
  finalized: number;
  rootCount: number;
  announcer: string;
  announcerFromWindow: number;
}

/** `AnnouncerChanged(previous, next, fromWindow)` 1건 + 실린 자리. */
export const AnnouncerChange = z.object({
  previous: Address,
  next: Address,
  fromWindow: BlockNumber,
  blockNumber: BlockNumber,
  logIndex: z.number().int().nonnegative(),
}).strict();
export type AnnouncerChange = z.infer<typeof AnnouncerChange>;

export interface LedgerBlocks {
  hashes: Record<string, string>;
  timestamps: Record<string, number>;
}

/** 개정 7 체인 값의 출처. */
export interface LedgerChainSource {
  world(): Promise<LedgerWorldFacts>;
  root(index: number): Promise<LedgerRootRecord>;
  announcerChanges(fromBlock: number, toBlock: number): Promise<AnnouncerChange[]>;
  blocks(fromWindow: number, toWindow: number, timestampWindows: readonly number[]): Promise<LedgerBlocks>;
  blockHashesAt(windows: readonly number[]): Promise<Record<string, string>>;
  isValidSignature(wallet: string, hash: string, signature: string, blockNumber: number): Promise<boolean>;
}

/**
 * 창 w의 ANNOUNCE 키 (D197 보강 ②): fromWindow ≤ w인 마지막 `AnnouncerChanged`의 next.
 * changes = 블록 [윈도 a − ANNOUNCER_DELAY, …]에서 읽은 교체(블록·로그 순서). 교체는 fromWindow = max(블록 + DELAY, W0)라
 * 블록 < a − DELAY인 교체는 모두 fromWindow ≤ a다 → 그 마지막 것(= 읽은 첫 교체의 previous, 읽은 교체가 없으면 base)이 기본 키.
 */
export function announcerKeyAt(changes: readonly AnnouncerChange[], base: string, w: number): string {
  let key = changes.length > 0 ? changes[0]!.previous : base;
  for (const c of changes) if (c.fromWindow <= w) key = c.next;
  return key.toLowerCase();
}

const Erc1271Answer = z.object({ wallet: Address, hash: Bytes32, signature: HexBytes, blockNumber: BlockNumber, valid: z.boolean() }).strict();

export const LEDGER_CHAIN_SCHEMA_ID = "pikit.ledger-chain/v1" as const;

/**
 * 체인 값 파일 (데모 묶음·시험용 — 운영자가 준 값을 그대로 믿는 것이다. 누구나 확인하려면 --rpc).
 * erc1271 = 체인이 `isValidSignature`에 답한 값 (없는 질문은 false).
 */
export const LedgerChainFile = z.object({
  schema: z.literal(LEDGER_CHAIN_SCHEMA_ID),
  chainId: z.number().int().positive(),
  ledger: Address,
  seedRoot: Bytes32,
  genesisBlock: BlockNumber,
  rulesHash: Bytes32,
  ledgerHash: Bytes32,
  roomIds: z.array(U32).min(1),
  epochBlocks: z.number().int().positive(),
  announcerDelay: z.number().int().nonnegative(),
  finalized: BlockNumber,
  roots: z.array(LedgerRootRecord),
  announcerChanges: z.array(AnnouncerChange).min(1),
  blockHashes: z.record(z.string(), Bytes32),
  blockTimestamps: z.record(z.string(), z.number().int().nonnegative()),
  erc1271: z.array(Erc1271Answer).default([]),
}).strict();
export type LedgerChainFile = z.infer<typeof LedgerChainFile>;

/** 파일로 받은 체인 값 (`pikit.ledger-chain/v1`). */
export class StaticLedgerSource implements LedgerChainSource {
  private readonly f: LedgerChainFile;

  constructor(data: unknown) {
    this.f = LedgerChainFile.parse(data);
  }

  async world(): Promise<LedgerWorldFacts> {
    const f = this.f;
    const last = [...f.announcerChanges].filter((c) => c.blockNumber <= f.finalized).pop()!;
    return {
      chainId: f.chainId, ledger: f.ledger, seedRoot: f.seedRoot, genesisBlock: f.genesisBlock, rulesHash: f.rulesHash, ledgerHash: f.ledgerHash,
      roomIds: f.roomIds, epochBlocks: f.epochBlocks, announcerDelay: f.announcerDelay, finalized: f.finalized,
      rootCount: f.roots.filter((r) => r.postedBlock <= f.finalized).length, announcer: last.next, announcerFromWindow: last.fromWindow,
    };
  }

  async root(index: number): Promise<LedgerRootRecord> {
    const r = this.f.roots.find((x) => x.rootIndex === index);
    if (!r) throw new Error(`chain file: no root ${index}`);
    return r;
  }

  async announcerChanges(fromBlock: number, toBlock: number): Promise<AnnouncerChange[]> {
    return this.f.announcerChanges.filter((c) => c.blockNumber >= fromBlock && c.blockNumber <= toBlock);
  }

  async blocks(fromWindow: number, toWindow: number, timestampWindows: readonly number[]): Promise<LedgerBlocks> {
    const hashes: Record<string, string> = {};
    for (let w = fromWindow; w <= toWindow; w++) {
      const h = this.f.blockHashes[String(w)];
      if (h !== undefined) hashes[String(w)] = h;
    }
    const timestamps: Record<string, number> = {};
    for (const w of timestampWindows) {
      const t = this.f.blockTimestamps[String(w)];
      if (t !== undefined) timestamps[String(w)] = t;
    }
    return { hashes, timestamps };
  }

  async blockHashesAt(windows: readonly number[]): Promise<Record<string, string>> {
    return Object.fromEntries(windows.filter((w) => this.f.blockHashes[String(w)] !== undefined).map((w) => [String(w), this.f.blockHashes[String(w)]!]));
  }

  async isValidSignature(wallet: string, hash: string, signature: string, blockNumber: number): Promise<boolean> {
    const low = (s: string) => s.toLowerCase();
    return this.f.erc1271.some((a) => a.wallet === low(wallet) && a.hash === low(hash) && a.signature === low(signature) && a.blockNumber === blockNumber && a.valid);
  }
}
