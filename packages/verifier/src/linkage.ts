import { canonicalJson, compareInputLinks, inputLinkKey, MAX_INPUTS_PER_ROOM_WINDOW, type EngineInput, type EpochWindowInputs, type InputLink } from "@pikit/protocol";
import { InputScheduler, linkedInputs, type ChainInputEvents, type LinkedInput, type LinkProblem, type LinkRoom, type VoidedPurchase } from "@pikit/engine";

// 연결 규칙(체인 사건 → 엔진 입력 → 윈도: freezeStarts·linkedInputs·InputScheduler·carryAfter)은 엔진에 있다 — packages/engine/src/input-schedule.ts.
// 여기 남은 것은 그 규칙으로 정한 줄과 공개 기록을 맞추는 대조다. InputScheduler·lazyWindowRng는 @pikit/engine에서 가져온다(다시 내보내지 않음).
export {
  carryAfter, freezeStarts, linkedInputs,
  type ChainInputEvents, type LinkedInput, type LinkProblem, type LinkProblemCode, type LinkRoom, type VoidedPurchase,
} from "@pikit/engine";

export type LinkMismatchCode = "MISSING" | "EXTRA" | "WINDOW" | "FIELDS" | "ORDER" | "DUPLICATE";

/** 한쪽(기대 또는 공개 기록)의 자리. window = null이면 검사 범위 뒤(상한 때문에 다음 윈도로 밀림). */
export interface LinkSide {
  window: number | null;
  index: number | null;
  input: EngineInput;
}

export interface LinkMismatch {
  code: LinkMismatchCode;
  roomId: number;
  link: InputLink;
  expected: LinkSide | null;   // 체인 사건으로 정한 자리 (EXTRA면 null)
  actual: LinkSide | null;     // 공개 기록의 자리 (MISSING이면 null)
}

export interface LinkageReport {
  checked: number;             // 범위 안에 들어가야 하는 체인 입력 수
  matched: number;             // 그중 공개 기록과 정확히 같은 것
  pending: number;             // 범위 끝까지 상한 때문에 못 넣고 다음 윈도로 넘어가는 것
  mismatches: LinkMismatch[];  // 하나라도 있으면 실패
  problems: LinkProblem[];     // 하나라도 있으면 실패
  carryOut: LinkedInput[];     // 범위 뒤로 넘어가는 줄 (블록 ≤ last − 1, 연결 순서) — 다음 범위의 carry
}

export interface LinkageInput {
  rooms: readonly LinkRoom[];
  /** 체인 사건. 블록 ≤ last − 1인 것은 빠짐없이 있어야 한다(없으면 "빠진 입력"을 잡지 못한다). 그 뒤 블록의 것은 있어도 된다(범위 밖으로 기대). */
  events: ChainInputEvents;
  purchaseOf?: (purchaseId: string) => VoidedPurchase | undefined;
  /** first 전에 들어와 아직 못 넣은 것 (윈도 first − 1까지의 밀린 줄). genesisBlock부터 검사하면 없다. */
  carry?: readonly LinkedInput[];
  /** 공개 기록의 윈도들 (범위 [first, last] 밖은 무시). */
  windows: readonly EpochWindowInputs[];
  first: number;
  last: number;
  cap?: number;
}

/** 체인 사건으로 윈도 [first, last]의 입력을 정하고 공개 기록과 (방, 연결)로 하나씩 맞춘다. */
export function checkInputLinkage(o: LinkageInput): LinkageReport {
  const { items, problems } = linkedInputs(o.events, o.rooms, o.purchaseOf);
  const scheduler = new InputScheduler(o.cap);
  for (const it of [...(o.carry ?? []), ...items]) {
    try {
      scheduler.add([it]);
    } catch {
      problems.push({ code: "DUPLICATE_EVENT", roomId: it.roomId, link: it.link, detail: `room ${it.roomId}: ${inputLinkKey(it.link)} is both carried over and a new chain event` });
    }
  }

  const key = (roomId: number, link: InputLink) => `${roomId}|${inputLinkKey(link)}`;
  const expected = new Map<string, { roomId: number; link: InputLink; side: LinkSide }>();
  for (let w = o.first; w <= o.last; w++) {
    const open = o.rooms.filter((r) => r.createdWindow < w).map((r) => r.roomId);
    for (const [roomId, list] of scheduler.take(w, open)) {
      list.forEach((it, index) => expected.set(key(roomId, it.link), { roomId, link: it.link, side: { window: w, index, input: it.input } }));
    }
  }
  const carryOut = scheduler.pending(o.last - 1);
  for (const it of scheduler.pending()) expected.set(key(it.roomId, it.link), { roomId: it.roomId, link: it.link, side: { window: null, index: null, input: it.input } });

  const mismatches: LinkMismatch[] = [];
  const actual = new Map<string, { roomId: number; link: InputLink; side: LinkSide }>();
  for (const wi of o.windows) {
    if (wi.window < o.first || wi.window > o.last) continue;
    for (const r of wi.rooms) {
      r.inputs.forEach((input, index) => {
        const link = r.links[index]!;
        const k = key(r.roomId, link);
        const side: LinkSide = { window: wi.window, index, input };
        if (actual.has(k)) mismatches.push({ code: "DUPLICATE", roomId: r.roomId, link, expected: expected.get(k)?.side ?? null, actual: side });
        else actual.set(k, { roomId: r.roomId, link, side });
      });
    }
  }

  let checked = 0;
  let matched = 0;
  // 같은 (윈도, 방) 안에서 맞은 것들의 기록 순번이 기대 순서대로 늘어나는지 (빠진 것·끼어든 것 때문에 번호가 밀리는 것은 ORDER가 아니다)
  const lastIndex = new Map<string, number>();
  const ordered = [...expected.values()].sort((a, b) => (a.side.window ?? Infinity) - (b.side.window ?? Infinity) || a.roomId - b.roomId || (a.side.index ?? 0) - (b.side.index ?? 0));
  for (const e of ordered) {
    const a = actual.get(key(e.roomId, e.link));
    if (e.side.window !== null) checked += 1;
    if (!a) {
      if (e.side.window !== null) mismatches.push({ code: "MISSING", roomId: e.roomId, link: e.link, expected: e.side, actual: null });
      continue;
    }
    if (a.side.window !== e.side.window) {
      mismatches.push({ code: "WINDOW", roomId: e.roomId, link: e.link, expected: e.side, actual: a.side });
      continue;
    }
    if (canonicalJson(a.side.input) !== canonicalJson(e.side.input)) {
      mismatches.push({ code: "FIELDS", roomId: e.roomId, link: e.link, expected: e.side, actual: a.side });
      continue;
    }
    const slot = `${e.side.window}|${e.roomId}`;
    const prev = lastIndex.get(slot);
    if (prev !== undefined && a.side.index! <= prev) {
      mismatches.push({ code: "ORDER", roomId: e.roomId, link: e.link, expected: e.side, actual: a.side });
      continue;
    }
    lastIndex.set(slot, a.side.index!);
    matched += 1;
  }
  for (const [k, a] of actual) if (!expected.has(k)) mismatches.push({ code: "EXTRA", roomId: a.roomId, link: a.link, expected: null, actual: a.side });

  const at = (m: LinkMismatch) => m.actual?.window ?? m.expected?.window ?? Number.POSITIVE_INFINITY;
  mismatches.sort((a, b) => at(a) - at(b) || a.roomId - b.roomId || compareInputLinks(a.link, b.link));
  return { checked, matched, pending: carryOut.length, mismatches, problems, carryOut };
}

/** 사람이 읽는 한 줄 (CLI·예외 메모). */
export function describeLinkMismatch(m: LinkMismatch): string {
  const where = (s: LinkSide | null) => (s === null ? "none" : s.window === null ? "after the checked range" : `window ${s.window} #${s.index}`);
  const what = (s: LinkSide | null) => (s === null ? "" : ` ${canonicalJson(s.input)}`);
  const src = `room ${m.roomId} ${m.link.logIndex === -1 ? `freeze of block ${m.link.block}` : `block ${m.link.block} log ${m.link.logIndex}#${m.link.pos} (tx ${m.link.txHash})`}`;
  switch (m.code) {
    case "MISSING": return `MISSING ${src}: expected at ${where(m.expected)}${what(m.expected)}, not in the input log`;
    case "EXTRA": return `EXTRA ${src}: at ${where(m.actual)}${what(m.actual)}, no such chain event`;
    case "WINDOW": return `WINDOW ${src}: expected at ${where(m.expected)}, logged at ${where(m.actual)}`;
    case "FIELDS": return `FIELDS ${src}: chain says${what(m.expected)}, log says${what(m.actual)}`;
    case "ORDER": return `ORDER ${src}: logged at ${where(m.actual)}, out of (block, log index) order`;
    case "DUPLICATE": return `DUPLICATE ${src}: logged twice (again at ${where(m.actual)})`;
  }
}
