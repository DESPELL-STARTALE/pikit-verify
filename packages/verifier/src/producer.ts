import {
  addRoom, createRoom, engineVersionHash, freezeStarts, InputScheduler, lazyWindowRng, linkedInputs, runWorldWindow,
  type LinkedInput, type LinkRoom, type World, type WorldWindowResult,
} from "@pikit/engine";
import {
  canonicalHash, catalogOverCapMilli, catalogRewardCapMilli, chainInputLog, epochLogEntries, epochOf, epochWindows, hexToBytes, INPUT_LOG_GENESIS_HEAD, itemIdOf, keccak256, onchainRulesHash,
  type AnchorRecord, type CancelRecord, type Catalog, type ChainSnapshot, type EpochInputLog, type EpochWindowInputs, type Hex32, type PurchaseRecord,
  type SeedChain, type SettlementRecord, type VoidRangeRecord, type WorldManifest,
} from "@pikit/protocol";
import type { ChainFacts, VoidOverPaidRecord } from "./chain.js";
import { boardBatchRoot, commitBatch, roomsStateRoot, worldStateHashes, type CommittedBatch } from "./roots.js";
import { parseItemKey, replayPayout, type ReplayPayout } from "./settlements.js";

// ──────────────────────────────────────────────────────────────────────────
// 만드는 쪽 참조 구현 — 게임 서버가 하는 일(체인 사건을 연결 규칙대로 윈도에 넣고 세계를 돌리고 에폭 입력 기록 v3 파일을 쓰고, 에폭 끝에
// 앵커 값을 계산)과 settler가 하는 일(처리된 구매의 엔진 정산을 체인 settleEnd로)을 가장 단순하게 적은 것. 검증기 테스트·CLI 예제 묶음을 만들고,
// game-server·settler가 같은 바이트를 내는지 대조할 기준이다.
// 입력은 체인 흉내로만 넣는다(D111): purchase·cancel·voidRange로 블록 b의 사건을 적으면 step()이 연결 규칙(linkage.ts)대로 윈도 b + 1부터
// 방마다 상한까지 넣는다. 동결은 앵커(anchor)로 정해지는 동결 시작 블록에서 저절로 들어간다. chainSnapshot()은 같은 사건을 체인 값으로 낸다.
// ──────────────────────────────────────────────────────────────────────────

export interface ProducerRoom {
  roomId: number;
  createdWindow: number;
  catalog: Catalog;
}

export interface ProducerOptions {
  chainId: number;
  shop: string;
  genesisBlock: number;
  seeds: SeedChain;
  rooms: ProducerRoom[];
  blockHash: (window: number) => Hex32;
  cap?: number;                    // 방-윈도 입력 상한 (기본 MAX_INPUTS_PER_ROOM_WINDOW)
  /**
   * 시험 전용: 연결 규칙이 정한 윈도 입력을 운영자가 바꿔 넣는 흉내(늦게·등급 바꿔·빼먹고·지어내어). 세계·기록·앵커·정산은 바꾼 입력으로 서로 맞고,
   * chainSnapshot()은 진짜 체인 사건 그대로라 검증기의 "입력 = 체인 사건" 검사만 잡는다(H-1). 운영 코드는 쓰지 않는다.
   */
  tamper?: (window: number, inputs: Map<number, LinkedInput[]>) => Map<number, LinkedInput[]>;
}

/** 체인 사건의 로그 자리 (주지 않으면 블록마다 0부터 차례로, tx는 블록·로그 번호에서 만든 가짜 해시). */
export interface LogAt {
  block: number;
  logIndex?: number;
  txHash?: Hex32;
}

export class WorldProducer {
  readonly world: World = { rooms: [] };
  private nextWindow: number;
  private head: Hex32 = INPUT_LOG_GENESIS_HEAD;
  private epochPrevHead: Hex32 = INPUT_LOG_GENESIS_HEAD;
  private epochWindowsBuf: EpochWindowInputs[] = [];
  private readonly logs: EpochInputLog[] = [];
  private readonly anchors: AnchorRecord[] = [];
  private readonly blockHashes: Record<string, Hex32> = {};
  private readonly settlements: SettlementRecord[] = [];
  private readonly settledKeys = new Set<string>();
  private readonly voidOverPaid: VoidOverPaidRecord[] = [];
  private readonly voidedRefs = new Set<string>();
  private readonly purchases: PurchaseRecord[] = [];
  private readonly purchaseById = new Map<string, PurchaseRecord>();
  private readonly cancels: CancelRecord[] = [];
  private readonly voids: VoidRangeRecord[] = [];
  private readonly scheduler: InputScheduler;
  private readonly linkRooms: LinkRoom[];
  private readonly logIndexAt = new Map<number, number>();
  private nextPurchaseId = 0n;
  private chainThrough = -1;       // 적은 사건·앵커·정산의 마지막 블록
  private batchesSinceAnchor: CommittedBatch[] = [];
  readonly batches: CommittedBatch[] = [];
  /** 엔진 정산 전부 (생긴 순서). */
  readonly payouts: ReplayPayout[] = [];

  constructor(private readonly o: ProducerOptions) {
    this.nextWindow = o.genesisBlock;
    this.scheduler = new InputScheduler(o.cap);
    const engine = engineVersionHash() as Hex32;
    this.linkRooms = o.rooms.map((r) => ({ roomId: r.roomId, createdWindow: r.createdWindow, rulesHash: onchainRulesHash(canonicalHash(r.catalog) as Hex32, engine) }));
  }

  /** 마지막으로 처리한 윈도 W. */
  get lastWindow(): number {
    return this.nextWindow - 1;
  }

  /**
   * 체인 앵커의 processedThrough P = W − 1: 블록 b의 이벤트는 윈도 b + 1에서 엔진에 들어가므로, 윈도 W까지 돌았으면
   * 이벤트가 모두 들어간 마지막 블록은 W − 1이다(D57). 앵커의 방 상태·입력 기록 루트는 윈도 W 뒤의 값이다.
   */
  get processedThrough(): number {
    return this.lastWindow - 1;
  }

  private rngFor(w: number) {
    const shop = hexToBytes(this.o.shop);
    const seed = () => hexToBytes(this.o.seeds.seedOf(epochOf(w, this.o.genesisBlock)));
    const bh = () => hexToBytes(this.o.blockHash(w));
    return (roomId: number) => lazyWindowRng(seed, this.o.chainId, shop, roomId, w, bh);
  }

  // ── 체인 흉내: 블록 b의 사건 (윈도 b + 1을 돌리기 전에 적는다) ──────────────────

  private at(e: LogAt): { blockNumber: number; logIndex: number; txHash: Hex32 } {
    if (e.block < this.lastWindow) throw new Error(`WorldProducer: block ${e.block} is in the past (window ${e.block + 1} already ran)`);
    const logIndex = e.logIndex ?? this.logIndexAt.get(e.block) ?? 0;
    this.logIndexAt.set(e.block, Math.max(this.logIndexAt.get(e.block) ?? 0, logIndex + 1));
    this.chainThrough = Math.max(this.chainThrough, e.block);
    return { blockNumber: e.block, logIndex, txHash: e.txHash ?? keccak256(new TextEncoder().encode(`tx|${e.block}|${logIndex}`)) };
  }

  private schedule(ev: Parameters<typeof linkedInputs>[0]): void {
    const { items, problems } = linkedInputs(ev, this.linkRooms, (id) => this.purchaseById.get(id));
    if (problems.length > 0) throw new Error(`WorldProducer: ${problems.map((p) => p.detail).join("; ")}`);
    this.scheduler.add(items);
  }

  /** 체인 `Purchased` (블록 block). purchaseId를 주지 않으면 다음 번호. 돌려주는 값 = purchaseId. */
  purchase(e: LogAt & { roomId: number; buyer: string; tiers: number[]; purchaseId?: string; rulesHash?: Hex32 }): string {
    const purchaseId = e.purchaseId ?? String(this.nextPurchaseId);
    if (this.purchaseById.has(purchaseId)) throw new Error(`WorldProducer: purchase ${purchaseId} exists`);
    if (BigInt(purchaseId) >= this.nextPurchaseId) this.nextPurchaseId = BigInt(purchaseId) + 1n;
    const rulesHash = (e.rulesHash ?? this.linkRooms.find((r) => r.roomId === e.roomId)?.rulesHash ?? `0x${"0".repeat(64)}`) as Hex32;
    const p: PurchaseRecord = { purchaseId, buyer: e.buyer, roomId: e.roomId, rulesHash, tiers: [...e.tiers], ...this.at(e) };
    this.purchases.push(p);
    this.purchaseById.set(purchaseId, p);
    this.schedule({ purchases: [p], cancels: [], voids: [], freezeBlocks: [] });
    return purchaseId;
  }

  /** 체인 `CancelRequested` (블록 block). items = 곡괭이 키 "<purchaseId>:<itemIndex>" (체인에는 (purchaseId << 8) | itemIndex로 실린다). */
  cancel(e: LogAt & { roomId: number; wallet: string; items: string[] }): void {
    const c: CancelRecord = {
      wallet: e.wallet, roomId: e.roomId, items: e.items.map((k) => { const { purchaseId, itemIndex } = parseItemKey(k); return itemIdOf(purchaseId, itemIndex).toString(); }), ...this.at(e),
    };
    this.cancels.push(c);
    this.schedule({ purchases: [], cancels: [c], voids: [], freezeBlocks: [] });
  }

  /** PikitFairness `PurchasesVoided(fromId, toId)` (블록 block, 늦은 앵커와 같은 tx). 구간의 구매마다 voidPurchase. */
  voidRange(e: LogAt & { fromId: string; toId: string }): void {
    const v: VoidRangeRecord = { fromId: e.fromId, toId: e.toId, ...this.at(e) };
    this.voids.push(v);
    this.schedule({ purchases: [], cancels: [], voids: [v], freezeBlocks: [] });
  }

  /** 윈도 하나 (genesisBlock부터 빠짐없이 차례로). 입력 = 연결 규칙으로 정해진 체인 사건(+ 동결). */
  step(): WorldWindowResult {
    const w = this.nextWindow++;
    this.blockHashes[String(w)] = this.o.blockHash(w);
    for (const r of this.o.rooms) {
      if (r.createdWindow === w) addRoom(this.world, { roomId: r.roomId, catalog: r.catalog, state: createRoom(r.catalog, this.rngFor(w)(r.roomId), r.roomId, w) });
    }
    // 블록 w − 1이 동결 시작이면 그때 있던 방마다 freeze (연결 (w − 1, −1, 0): 그 블록의 로그보다 앞)
    if (w - 1 >= this.o.genesisBlock) this.schedule({ purchases: [], cancels: [], voids: [], freezeBlocks: freezeStarts(this.anchors, this.o.genesisBlock, w - 1, w - 1) });
    const open = this.o.rooms.filter((r) => r.createdWindow < w).map((r) => r.roomId);
    const scheduled = this.scheduler.take(w, open);
    const taken = this.o.tamper ? this.o.tamper(w, scheduled) : scheduled;
    const rooms = [...taken.entries()].filter(([, xs]) => xs.length > 0).sort(([a], [b]) => a - b)
      .map(([roomId, xs]) => ({ roomId, inputs: xs.map((x) => x.input), links: xs.map((x) => x.link) }));
    if (rooms.length > 0) {
      const wi: EpochWindowInputs = { window: w, rooms };
      this.epochWindowsBuf.push(wi);
      for (const entry of epochLogEntries({ windows: [wi] })) this.head = chainInputLog(this.head, entry);
    }
    for (const r of rooms) for (const i of r.inputs) if (i.type === "voidPurchase") this.voidedRefs.add(i.ref);
    const res = runWorldWindow(this.world, w, new Map(rooms.map((r) => [r.roomId, r.inputs])), this.rngFor(w));
    for (const { roomId, result } of res.rooms) {
      for (const b of result.batches) {
        const c = commitBatch(roomId, w, b);
        this.batches.push(c);
        this.batchesSinceAnchor.push(c);
      }
      for (const p of result.payouts) this.payouts.push(replayPayout(roomId, p));
    }
    const e = epochOf(w, this.o.genesisBlock);
    if (w === epochWindows(e, this.o.genesisBlock).last) this.closeEpoch(e);
    return res;
  }

  private closeEpoch(e: number): void {
    const { first, last } = epochWindows(e, this.o.genesisBlock);
    this.logs.push({
      schema: "pikit.inputlog/v3", chainId: this.o.chainId, shop: this.o.shop, epoch: e, firstWindow: first, lastWindow: last,
      prevHead: this.epochPrevHead, head: this.head, seed: this.o.seeds.seedOf(e), windows: this.epochWindowsBuf,
    });
    this.epochPrevHead = this.head;
    this.epochWindowsBuf = [];
  }

  /**
   * 지금까지 돈 세계로 앵커 값을 만들어 블록 postedBlock에 실었다고 적는다(마지막 윈도 W가 에폭 끝이어야 함, postedBlock ≥ W).
   * processedThrough = W − 1, processedPurchases = 블록 ≤ processedThrough인 구매 수(= 그중 가장 큰 purchaseId + 1, D57).
   * 앵커는 동결 판정(처리 지연)에도 쓰인다 — 블록 ≤ postedBlock부터 지연이 줄어든다.
   */
  anchor(postedBlock: number): AnchorRecord {
    const w = this.lastWindow;
    const e = epochOf(w, this.o.genesisBlock);
    if (epochWindows(e, this.o.genesisBlock).last !== w) throw new Error("anchor: the last processed window must be an epoch end");
    if (postedBlock < w) throw new Error(`anchor: posted block ${postedBlock} is before the last processed window ${w}`);
    const processedPurchases = this.purchases.filter((p) => p.blockNumber <= w - 1).reduce((n, p) => (BigInt(p.purchaseId) + 1n > n ? BigInt(p.purchaseId) + 1n : n), 0n);
    const record: AnchorRecord = {
      anchorIndex: this.anchors.length, postedBlock, processedThrough: w - 1, processedPurchases: Number(processedPurchases), epoch: e,
      seed: this.o.seeds.seedOf(e), roomsStateRoot: roomsStateRoot(worldStateHashes(this.world)), inputLogRoot: this.head,
      boardBatchRoot: boardBatchRoot(this.batchesSinceAnchor),
    };
    this.anchors.push(record);
    this.chainThrough = Math.max(this.chainThrough, postedBlock);
    this.batchesSinceAnchor = [];
    return record;
  }

  /**
   * settler 흉내 (settleEnd + 무효 over): 마지막 앵커가 덮은 구매(purchaseId < processedPurchases, 무효 구매 제외)의 아직 안 보낸 정산을 블록 blockNumber에
   * 체인으로, 무효 구매의 정상 종료 over > 0은 payOverAfterVoid(VoidOverPaid)로. limit이 있으면 그 수만큼만(나머지는 다음 호출 — settler 지연).
   * skip(key)가 참인 곡괭이는 보내지 않는다(시험: 빠뜨린 지급). 보낸 settleEnd 기록을 돌려준다.
   */
  settle(blockNumber: number, limit = Number.POSITIVE_INFINITY, skip: (p: ReplayPayout) => boolean = () => false): SettlementRecord[] {
    const last = this.anchors[this.anchors.length - 1];
    if (!last) return [];
    const bound = BigInt(last.processedPurchases);
    const out: SettlementRecord[] = [];
    for (const p of this.payouts) {
      if (out.length >= limit) break;
      if (this.settledKeys.has(p.key) || skip(p)) continue;
      // 체인에서 무효인 구매(엔진이 아직 voidPurchase를 안 넣었어도 — 범위 끝 뒤에 실린 무효, I-1)는 settleEnd가 되돌려진다 → over만 VoidOverPaid
      const id = BigInt(p.purchaseId);
      const chainVoid = this.voids.some((v) => v.blockNumber <= blockNumber && BigInt(v.fromId) <= id && id < BigInt(v.toId));
      if (this.voidedRefs.has(p.purchaseId) || chainVoid) {
        if (p.overMilli > 0) {
          this.voidOverPaid.push({
            purchaseId: p.purchaseId, itemIndex: p.itemIndex, buyer: p.owner, overMilli: String(p.overMilli), blockNumber,
            txHash: keccak256(new TextEncoder().encode(`void-over|${blockNumber}|${p.key}`)),
          });
          this.settledKeys.add(p.key);
          this.chainThrough = Math.max(this.chainThrough, blockNumber);
        }
        continue;
      }
      if (BigInt(p.purchaseId) >= bound) continue;
      const record: SettlementRecord = {
        purchaseId: p.purchaseId, itemIndex: p.itemIndex, buyer: p.owner, kind: p.kind, payoutMilli: String(p.payoutMilli), overMilli: String(p.overMilli), blockNumber,
        txHash: keccak256(new TextEncoder().encode(`settle|${blockNumber}|${p.key}`)),
      };
      this.settledKeys.add(p.key);
      out.push(record);
    }
    this.settlements.push(...out);
    if (out.length > 0) this.chainThrough = Math.max(this.chainThrough, blockNumber);
    return out;
  }

  /** 에폭 e 끝(윈도 = 에폭 마지막 윈도)의 공개 스냅숏 — game-server `snapshots/<e>.json`과 같은 모양. 그 윈도를 막 돈 뒤에만 부른다. */
  snapshotFile(): { epoch: number; processedWindow: number; inputLogHead: Hex32; world: { rooms: { roomId: number; state: unknown }[] } } {
    const w = this.lastWindow;
    const e = epochOf(w, this.o.genesisBlock);
    if (epochWindows(e, this.o.genesisBlock).last !== w) throw new Error("snapshotFile: the last processed window must be an epoch end");
    return { epoch: e, processedWindow: w, inputLogHead: this.head, world: JSON.parse(JSON.stringify({ rooms: this.world.rooms.map((r) => ({ roomId: r.roomId, state: r.state })) })) };
  }

  epochLogs(): EpochInputLog[] {
    return this.logs;
  }

  manifest(): WorldManifest {
    return {
      schema: "pikit.world/v1", chainId: this.o.chainId, shop: this.o.shop, genesisBlock: this.o.genesisBlock, seedRoot: this.o.seeds.root(),
      engineVersionHash: engineVersionHash(),
      rooms: [...this.o.rooms].sort((a, b) => a.roomId - b.roomId).map((r) => ({ roomId: r.roomId, createdWindow: r.createdWindow, catalogHash: canonicalHash(r.catalog) })),
    };
  }

  /** 체인 값 v3 + 개정 6 VoidOverPaid + 방 규칙·카탈로그 가격표 (검증기 ChainFacts). */
  chainFacts(extra: Partial<Pick<ChainSnapshot, "rulesHashes">> = {}): ChainFacts {
    return { ...this.chainSnapshot(extra), voidOverPaid: this.voidOverPaid };
  }

  /**
   * 체인 값 v3 (적은 사건·앵커·정산·블록 해시) + 방마다 roomOf 규칙과 그 규칙의 catalogOf 가격·상한표(배포 도구가 카탈로그에서 계산해 넣는 값, D162).
   * rulesHashes를 주지 않으면 방 카탈로그의 체인 rulesHash.
   */
  chainSnapshot(extra: Partial<Pick<ChainSnapshot, "rulesHashes">> = {}): ChainSnapshot & Pick<ChainFacts, "roomRules" | "catalogs"> {
    const byRules = new Map(this.o.rooms.map((r) => [this.linkRooms.find((l) => l.roomId === r.roomId)!.rulesHash!, r.catalog]));
    return {
      schema: "pikit.chain/v3", chainId: this.o.chainId, shop: this.o.shop, genesisBlock: this.o.genesisBlock, seedRoot: this.o.seeds.root(),
      throughBlock: Math.max(this.lastWindow, this.chainThrough),
      rulesHashes: extra.rulesHashes ?? [...byRules.keys()],
      roomRules: [...this.linkRooms].sort((a, b) => a.roomId - b.roomId).map((r) => ({ roomId: r.roomId, rulesHash: r.rulesHash!, nextRulesHash: null, createdBlock: r.createdWindow })),
      catalogs: [...byRules].map(([rulesHash, c]) => ({
        rulesHash,
        tierPrices: c.pickaxes.map((p) => String(p.priceCredits)),
        tierCapsMilli: c.pickaxes.map((_, t) => String(catalogRewardCapMilli(c, t))),
        tierOverCapsMilli: c.pickaxes.map((_, t) => String(catalogOverCapMilli(c, t))),
      })),
      anchors: this.anchors, blockHashes: this.blockHashes, settlements: this.settlements,
      purchases: this.purchases, cancels: this.cancels, voids: this.voids,
    };
  }
}
