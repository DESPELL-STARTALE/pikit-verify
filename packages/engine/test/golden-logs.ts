// verifier 골든 재생 기록의 손 사본 (packages/verifier/test/replay.test.ts buildGolden{1,2,3,4}Log와 같은 입력) — 엔진 시험이 "옛 카탈로그 = 옛 결과
// 비트까지"를 보일 때 쓴다(rules10.test.ts: 규칙 9 · rules11.test.ts: 규칙 10). verifier 픽스처 파일은 규칙이 바뀔 때마다 새 값으로 다시 쓰이므로
// 읽지 않고 여기 손으로 둔다. 시드: golden-1 0x42 · golden-2 0x62 · golden-3 규칙 9 = 2, 규칙 10 = 1(규칙 10 키트가 다시 고름) · golden-4 1.
import { type Catalog, type EngineInput } from "@pikit/protocol";
import { createRoom, runWindow, windowRngFactory, type RoomState, type WindowResult } from "../src/index.js";

export interface Log {
  chainId: number;
  shop: string;
  roomId: number;
  seed: string;
  firstWindow: number;
  lastWindow: number;
  windows: { window: number; blockHash?: string; inputs: EngineInput[] }[];
}

const hexBytes = (h: string) => Uint8Array.from(Buffer.from(h.slice(2), "hex"));
/** 바이트 n을 32번 (0x4242…42). */
export const hh = (n: number) => `0x${n.toString(16).padStart(2, "0").repeat(32)}`;
const SHOP = "0x5b0b000000000000000000000000000000000005";

/** 기록 재생 (윈도를 빠짐없이). onWindow는 윈도마다 결과로 불린다. */
export function replayLog(catalog: Catalog, log: Log, onWindow?: (res: WindowResult) => void): RoomState {
  const seed = hexBytes(log.seed);
  const shop = hexBytes(log.shop);
  const zero = new Uint8Array(32);
  const by = new Map(log.windows.map((w) => [w.window, w]));
  const state = createRoom(catalog, windowRngFactory(seed, log.chainId, shop, log.roomId, log.firstWindow, zero), log.roomId, log.firstWindow);
  for (let w = log.firstWindow + 1; w <= log.lastWindow; w++) {
    const e = by.get(w);
    const res = runWindow(state, catalog, w, e?.inputs ?? [], windowRngFactory(seed, log.chainId, shop, log.roomId, w, e?.blockHash ? hexBytes(e.blockHash) : zero));
    onWindow?.(res);
  }
  return state;
}

const A = "0xa11ce00000000000000000000000000000000001";
const B = "0xb0b0000000000000000000000000000000000002";
const C = "0xc0c0000000000000000000000000000000000003";

/** golden-1: 지갑 3개 · 취소 · 무효 · 동결(ROOM_CLOSED). */
export const golden1: Log = {
  chainId: 143, shop: SHOP, roomId: 1, seed: hh(0x42), firstWindow: 1000, lastWindow: 1700,
  windows: [
    { window: 1001, blockHash: hh(1), inputs: [{ type: "purchase", ref: "8812", owner: A, tiers: [4, 4, 0] }] },
    { window: 1002, blockHash: hh(2), inputs: [{ type: "purchase", ref: "8813", owner: B, tiers: [0] }] },
    { window: 1040, inputs: [{ type: "purchase", ref: "8814", owner: B, tiers: [2, 1] }] },
    { window: 1041, inputs: [{ type: "cancel", owner: B, itemKey: "8814:1" }] },
    { window: 1100, inputs: [{ type: "purchase", ref: "8815", owner: C, tiers: [0, 0, 0, 0, 0, 0, 0, 0, 0, 0] }, { type: "purchase", ref: "8816", owner: C, tiers: [1, 1] }] },
    { window: 1101, inputs: [{ type: "voidPurchase", ref: "8815", owner: C }] },
    { window: 1102, inputs: [{ type: "voidPurchase", ref: "8815", owner: C }, { type: "purchase", ref: "8815", owner: C, tiers: [0] }] },
    { window: 1300, blockHash: hh(3), inputs: [{ type: "purchase", ref: "8817", owner: B, tiers: [0] }] },
    { window: 1450, inputs: [{ type: "purchase", ref: "8820", owner: A, tiers: [3] }] },
    { window: 1640, inputs: [{ type: "purchase", ref: "8821", owner: C, tiers: [4, 2] }] },
    { window: 1650, blockHash: hh(4), inputs: [{ type: "freeze", reason: "ROOM_CLOSED" }] },
  ],
};

const g2wallets = Array.from({ length: 7 }, (_, i) => `0x${"abcdef7"[i]!.repeat(4)}${"0".repeat(35)}${i + 1}`);
/** golden-2: 지갑 7개가 세 윈도에 10개씩 사는 바쁜 판(하늘 별 DROP·CAUGHT·EXPIRED). */
export const golden2: Log = {
  chainId: 143, shop: SHOP, roomId: 2, seed: hh(0x62), firstWindow: 5000, lastWindow: 8000,
  windows: [5001, 6000, 7000].map((window, b) => ({
    window, blockHash: hh(0x10 + b),
    inputs: g2wallets.map((owner, i) => ({ type: "purchase" as const, ref: String(9000 + b * 10 + i), owner, tiers: Array.from({ length: 10 }, (_, j) => (i + j + b) % 5) })),
  })),
};

/** golden-3: 지갑 3개가 [×1, ×2, ×5]를 한 번 사는 짧은 판. 시드 바이트는 규칙마다 다르다(규칙 9 = 2, 규칙 10 = 1). */
export function golden3(seedByte: number): Log {
  return {
    chainId: 143, shop: SHOP, roomId: 3, seed: hh(seedByte), firstWindow: 20000, lastWindow: 20300,
    windows: [{ window: 20001, blockHash: hh(0x70), inputs: [1, 2, 3].map((i) => ({ type: "purchase" as const, ref: String(7000 + i - 1), owner: `0xd1a0${"0".repeat(35)}${i}`, tiers: [0, 1, 2] })) }],
  };
}

const g4wallets = [1, 2, 3, 4, 5, 6, 7, 8].map((i) => `0x4a4a${"0".repeat(35)}${i}`);
/** golden-4 (규칙 10): 지갑 8개가 두 윈도에 10개씩 — 시험 카탈로그 golden4Catalog로 잭팟 균열 + 총상한 클램프. */
export const golden4: Log = {
  chainId: 143, shop: SHOP, roomId: 4, seed: hh(1), firstWindow: 30000, lastWindow: 32000,
  windows: [30001, 31000].map((window, b) => ({
    window, blockHash: hh(0x40 + b),
    inputs: g4wallets.map((owner, i) => ({ type: "purchase" as const, ref: String(4000 + b * 10 + i), owner, tiers: Array.from({ length: 10 }, (_, j) => (i + j + b) % 5) })),
  })),
};

/** golden-4 시험 카탈로그 = 바탕 카탈로그 + 총상한 1.1× + ×1.1 단계 하나(20 %) + 잭팟(기여 1 bps, κ 49 ppm, minPool 1) — verifier buildGolden4Catalog와 같다. */
export function golden4Catalog(base: Catalog): Catalog {
  const c = structuredClone(base);
  c.reward = { ...c.reward, totalCapBps: 11_000 };
  c.luckyPick = { levels: [{ multBps: 11_000, per10m: 2_000_000 }] };
  c.jackpot = { kindId: "chog_gold", contributionBpsByTier: c.pickaxes.map(() => 1), kappaPpm: 49, minPoolCredits: 1 };
  return c;
}
