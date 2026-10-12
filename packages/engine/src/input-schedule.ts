import {
  compareInputLinks, inputLinkKey, itemKeyFromId, MAX_INPUTS_PER_ROOM_WINDOW, T_FREEZE,
  type AnchorRecord, type CancelRecord, type EngineInput, type InputLink, type PurchaseRecord, type VoidRangeRecord,
} from "@pikit/protocol";

// ──────────────────────────────────────────────────────────────────────────
// 입력 = 체인 사건 (보안 리뷰 H-1, D111, docs/fairness-chain-linkage.md). 게임 서버·검증기·감시 봇이 같은 규칙을 쓴다.
//   체인 사건 → 엔진 입력 (방마다):
//     Purchased(b, l)        → purchase{ref = purchaseId, owner = buyer, tiers}                  연결 (b, l, 0)
//     CancelRequested(b, l)  → 항목 k마다 cancel{owner = wallet, itemKey}                          연결 (b, l, k)
//     PurchasesVoided(b, l)  → [fromId, toId)의 구매마다 voidPurchase{ref, owner = 그 구매자}       연결 (b, l, id − fromId), 방 = 그 구매의 방
//     동결 시작 블록 F        → 블록 F에 있던 방(createdWindow ≤ F)마다 freeze{FREEZE}              연결 (F, −1, 0)
//       동결 시작 = 처리 지연 lag(x) = x − P(x)가 T_FREEZE를 처음 넘는 블록. P(x) = 블록 ≤ x에 실린 앵커의 processedThrough 최댓값
//       (앵커가 없으면 genesisBlock). 늦은 앵커가 실려도 지연이 그대로 T_FREEZE 위면 같은 동결이 이어진다(새 동결 없음).
//   윈도 정하기 (InputScheduler): 방마다 (블록, 로그 번호, 순번) 순서로 줄을 세운다. 윈도 w에는 블록 ≤ w − 1인 것을 앞에서부터
//     MAX_INPUTS_PER_ROOM_WINDOW(100)개까지, 나머지는 순서 그대로 다음 윈도로(상한 때문에 밀린 것만 늦게 들어간다 — 그것도 체인 값으로 정해진다).
//     방이 만들어진 윈도 c 다음(c + 1)부터만 넣는다 — 그보다 이른 블록의 사건은 규칙 위반(BEFORE_ROOM).
//   대조 (checkInputLinkage): 기대한 줄과 공개 기록을 (방, 연결)로 하나씩 맞춘다. 하나라도 어긋나면 실패:
//     MISSING 빠짐 · EXTRA 체인에 없음 · WINDOW 다른 윈도(늦게·일찍) · FIELDS 값이 다름(등급·지갑·번호) · ORDER 같은 윈도 안 순서 · DUPLICATE 두 번
// 체인 사건 → 엔진 입력 → 윈도는 결과를 정하는 규칙이라 엔진 안에 둔다: engineVersionHash가 이 파일을 덮는다(리뷰 rev6 M-3, D161).
// 대조(checkInputLinkage)·사람이 읽는 줄은 검증기(packages/verifier/src/linkage.ts)에 있다.
// ──────────────────────────────────────────────────────────────────────────

/** 체인 사건 하나에서 나온 엔진 입력 하나. */
export interface LinkedInput {
  roomId: number;
  input: EngineInput;
  link: InputLink;
}

/** 대조에 쓰는 방: 만들어진 윈도와 (있으면) 그 방 카탈로그의 체인 rulesHash — 구매마다 같아야 한다. */
export interface LinkRoom {
  roomId: number;
  createdWindow: number;
  rulesHash?: string;
}

/** 무효 구간이 가리키는 구매에서 쓰는 것: 지갑(voidPurchase.owner)과 방. */
export type VoidedPurchase = Pick<PurchaseRecord, "buyer" | "roomId">;

/** 입력을 만드는 체인 사건들. freezeBlocks = 동결 시작 블록(freezeStarts). */
export interface ChainInputEvents {
  purchases: readonly PurchaseRecord[];
  cancels: readonly CancelRecord[];
  voids: readonly VoidRangeRecord[];
  freezeBlocks: readonly number[];
}

export type LinkProblemCode =
  | "OUTSIDE_WORLD"      // 세계 목록에 없는 방의 사건 (그 구매는 엔진에 들어갈 곳이 없다)
  | "BEFORE_ROOM"        // 방이 만들어지기 전(블록 < createdWindow) 사건
  | "RULES"              // 구매의 체인 rulesHash ≠ 재생하는 카탈로그의 rulesHash
  | "UNKNOWN_PURCHASE"   // 무효 구간이 가리키는 구매가 체인 값에 없음
  | "DUPLICATE_PURCHASE" // 같은 purchaseId가 두 번
  | "DUPLICATE_EVENT";   // 같은 방에 같은 연결(블록, 로그 번호, 순번)이 두 번 — 체인 값이 틀렸다

export interface LinkProblem {
  code: LinkProblemCode;
  roomId: number | null;
  link: InputLink | null;
  detail: string;
}

/**
 * 동결 시작 블록: lag(x) = x − P(x) > T_FREEZE이고 lag(x − 1) ≤ T_FREEZE인 블록 x (fromBlock ≤ x ≤ toBlock).
 * P(x) = max({genesisBlock} ∪ {processedThrough : postedBlock ≤ x}) — PikitFairness.lastProcessedThrough()와 같다(P는 줄지 않는다).
 * anchors는 블록 ≤ toBlock에 실린 것이 빠짐없이 있어야 한다.
 */
export function freezeStarts(
  anchors: readonly Pick<AnchorRecord, "postedBlock" | "processedThrough">[], genesisBlock: number, fromBlock: number, toBlock: number,
): number[] {
  const out: number[] = [];
  if (toBlock < fromBlock) return out;
  const posts = [...anchors].sort((a, b) => a.postedBlock - b.postedBlock);
  let i = 0;
  let p = genesisBlock;
  const pAt = (x: number): number => {
    while (i < posts.length && posts[i]!.postedBlock <= x) {
      p = Math.max(p, posts[i]!.processedThrough);
      i += 1;
    }
    return p;
  };
  let prevFrozen = fromBlock - 1 - pAt(fromBlock - 1) > T_FREEZE;
  for (let x = fromBlock; x <= toBlock; x++) {
    const frozen = x - pAt(x) > T_FREEZE;
    if (frozen && !prevFrozen) out.push(x);
    prevFrozen = frozen;
  }
  return out;
}

/**
 * 체인 사건 → 엔진 입력 (방·연결 순서). 규칙에 어긋나는 사건은 입력을 만들지 않고 problems에 남긴다.
 * purchaseOf: 무효 구간이 가리키는 구매가 ev.purchases에 없을 때(더 이른 블록) 그 구매의 지갑·방을 찾는 함수.
 */
export function linkedInputs(
  ev: ChainInputEvents, rooms: readonly LinkRoom[], purchaseOf?: (purchaseId: string) => VoidedPurchase | undefined,
): { items: LinkedInput[]; problems: LinkProblem[] } {
  const byRoom = new Map(rooms.map((r) => [r.roomId, r]));
  const items: LinkedInput[] = [];
  const problems: LinkProblem[] = [];
  const purchases = new Map<string, PurchaseRecord>();
  const add = (roomId: number, input: EngineInput, link: InputLink): void => {
    const room = byRoom.get(roomId);
    if (!room) {
      problems.push({ code: "OUTSIDE_WORLD", roomId, link, detail: `${input.type} in block ${link.block} is for room ${roomId}, which is not in the world` });
      return;
    }
    if (link.block < room.createdWindow) {
      problems.push({ code: "BEFORE_ROOM", roomId, link, detail: `${input.type} in block ${link.block} came before room ${roomId} was created (window ${room.createdWindow})` });
      return;
    }
    items.push({ roomId, input, link });
  };

  for (const p of ev.purchases) {
    const link: InputLink = { block: p.blockNumber, logIndex: p.logIndex, pos: 0, txHash: p.txHash };
    if (purchases.has(p.purchaseId)) {
      problems.push({ code: "DUPLICATE_PURCHASE", roomId: p.roomId, link, detail: `purchase ${p.purchaseId} appears twice in the chain data` });
      continue;
    }
    purchases.set(p.purchaseId, p);
    const rules = byRoom.get(p.roomId)?.rulesHash;
    if (rules !== undefined && p.rulesHash !== rules) {
      problems.push({ code: "RULES", roomId: p.roomId, link, detail: `purchase ${p.purchaseId} was bought under rules ${p.rulesHash}, the replay uses ${rules}` });
    }
    add(p.roomId, { type: "purchase", ref: p.purchaseId, owner: p.buyer, tiers: [...p.tiers] }, link);
  }
  for (const c of ev.cancels) {
    c.items.forEach((item, k) => add(c.roomId, { type: "cancel", owner: c.wallet, itemKey: itemKeyFromId(item) }, { block: c.blockNumber, logIndex: c.logIndex, pos: k, txHash: c.txHash }));
  }
  for (const v of ev.voids) {
    const from = BigInt(v.fromId);
    for (let id = from; id < BigInt(v.toId); id++) {
      const link: InputLink = { block: v.blockNumber, logIndex: v.logIndex, pos: Number(id - from), txHash: v.txHash };
      const p: VoidedPurchase | undefined = purchases.get(String(id)) ?? purchaseOf?.(String(id));
      if (!p) {
        problems.push({ code: "UNKNOWN_PURCHASE", roomId: null, link, detail: `PurchasesVoided in block ${v.blockNumber} covers purchase ${id}, which is not in the chain data` });
        continue;
      }
      add(p.roomId, { type: "voidPurchase", ref: String(id), owner: p.buyer }, link);
    }
  }
  for (const f of ev.freezeBlocks) {
    for (const r of rooms) {
      if (r.createdWindow <= f) items.push({ roomId: r.roomId, input: { type: "freeze", reason: "FREEZE" }, link: { block: f, logIndex: -1, pos: 0, txHash: null } });
    }
  }
  items.sort((a, b) => a.roomId - b.roomId || compareInputLinks(a.link, b.link));
  const unique = items.filter((it, i) => {
    const prev = items[i - 1];
    if (!prev || prev.roomId !== it.roomId || compareInputLinks(prev.link, it.link) !== 0) return true;
    problems.push({ code: "DUPLICATE_EVENT", roomId: it.roomId, link: it.link, detail: `two chain events at block ${it.link.block} log ${it.link.logIndex}#${it.link.pos} for room ${it.roomId}` });
    return false;
  });
  return { items: unique, problems };
}

/**
 * 방마다 연결 순서의 줄 + 윈도 상한. take(w)는 블록 ≤ w − 1인 것을 앞에서부터 cap개까지 꺼낸다(나머지는 같은 순서로 다음 윈도).
 * 이미 꺼낸 것보다 앞선 연결은 add가 거부한다 — 그 윈도는 이미 지나갔다(늦게 들어온 사건).
 */
export class InputScheduler {
  private readonly queues = new Map<number, LinkedInput[]>();
  private readonly heads = new Map<number, number>();
  private readonly lastTaken = new Map<number, InputLink>();

  constructor(readonly cap: number = MAX_INPUTS_PER_ROOM_WINDOW) {
    if (!Number.isInteger(cap) || cap < 1) throw new Error(`InputScheduler: bad cap ${cap}`);
  }

  add(items: Iterable<LinkedInput>): void {
    for (const it of items) {
      const last = this.lastTaken.get(it.roomId);
      if (last && compareInputLinks(it.link, last) <= 0) {
        throw new Error(`InputScheduler: room ${it.roomId} input ${inputLinkKey(it.link)} is not after the last placed input ${inputLinkKey(last)}`);
      }
      let q = this.queues.get(it.roomId);
      if (!q) this.queues.set(it.roomId, q = []);
      const head = this.heads.get(it.roomId) ?? 0;
      let i = q.length;
      while (i > head && compareInputLinks(q[i - 1]!.link, it.link) > 0) i -= 1;
      if (i > head && compareInputLinks(q[i - 1]!.link, it.link) === 0) throw new Error(`InputScheduler: room ${it.roomId} input ${inputLinkKey(it.link)} added twice`);
      q.splice(i, 0, it);
    }
  }

  /** 윈도 w의 입력 (방마다, 연결 순서). rooms = 윈도 w에 입력을 받는 방 (createdWindow < w). */
  take(window: number, rooms: Iterable<number>): Map<number, LinkedInput[]> {
    const out = new Map<number, LinkedInput[]>();
    for (const roomId of rooms) {
      const q = this.queues.get(roomId);
      if (!q) continue;
      let h = this.heads.get(roomId) ?? 0;
      const taken: LinkedInput[] = [];
      while (h < q.length && taken.length < this.cap && q[h]!.link.block <= window - 1) taken.push(q[h++]!);
      if (taken.length > 0) {
        out.set(roomId, taken);
        this.lastTaken.set(roomId, taken[taken.length - 1]!.link);
      }
      if (h > 4096) {
        q.splice(0, h);
        h = 0;
      }
      this.heads.set(roomId, h);
    }
    return out;
  }

  /** 아직 꺼내지 않은 것 중 블록 ≤ throughBlock인 것 (방·연결 순서). */
  pending(throughBlock = Number.POSITIVE_INFINITY): LinkedInput[] {
    const out: LinkedInput[] = [];
    for (const roomId of [...this.queues.keys()].sort((a, b) => a - b)) {
      const q = this.queues.get(roomId)!;
      for (let i = this.heads.get(roomId) ?? 0; i < q.length; i++) if (q[i]!.link.block <= throughBlock) out.push(q[i]!);
    }
    return out;
  }
}

/**
 * 스냅숏 시작용: 윈도 ≤ throughWindow까지 돌았을 때 방-윈도 상한 때문에 아직 못 들어간 줄 (방·연결 순서) — 다음 범위의 carry.
 * InputScheduler와 같은 규칙(윈도 w에 블록 ≤ w − 1인 것을 앞에서부터 cap개, 방은 createdWindow < w부터)을 빈 윈도는 건너뛰며 돈다.
 * items = 범위 앞 체인 사건의 입력 (linkedInputs). 그보다 앞서 밀려 있던 줄은 없다고 본다(읽은 사건 구간 앞의 적체는 0 — VERIFY.md §3).
 */
export function carryAfter(items: readonly LinkedInput[], rooms: readonly LinkRoom[], throughWindow: number, cap: number = MAX_INPUTS_PER_ROOM_WINDOW): LinkedInput[] {
  const out: LinkedInput[] = [];
  for (const room of [...rooms].sort((a, b) => a.roomId - b.roomId)) {
    const q = items.filter((it) => it.roomId === room.roomId).sort((a, b) => compareInputLinks(a.link, b.link));
    let h = 0;
    let w = room.createdWindow + 1;
    while (h < q.length) {
      w = Math.max(w, q[h]!.link.block + 1);
      if (w > throughWindow) break;
      let taken = 0;
      while (h < q.length && taken < cap && q[h]!.link.block <= w - 1) { h += 1; taken += 1; }
      w += 1;
    }
    out.push(...q.slice(h));
  }
  return out;
}
