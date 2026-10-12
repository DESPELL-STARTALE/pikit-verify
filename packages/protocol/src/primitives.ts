import { z } from "zod";

// ── 공통 원시 형식 ─────────────────────────────────────────────────────────
// 큰 정수(uint64·uint256, wei)는 JSON 숫자 정밀도(2^53)를 넘을 수 있어 10진 문자열로 둔다.

export const Address = z.string().regex(/^0x[0-9a-f]{40}$/, "lowercase 0x-prefixed 20-byte address");
export const Bytes32 = z.string().regex(/^0x[0-9a-f]{64}$/, "lowercase 0x-prefixed 32-byte hex");
export const HexBytes = z.string().regex(/^0x([0-9a-f]{2})*$/, "lowercase 0x-prefixed hex bytes");
export const DecimalString = z.string().regex(/^(0|[1-9][0-9]*)$/, "non-negative decimal integer string");
export const U32 = z.number().int().min(0).max(0xffffffff);
export const BlockNumber = z.number().int().nonnegative();

/** 엔진이 내는 보너스 사건 종류 (규칙 7). POP = 새 블록 2연속 같은 종류, BIG_POP = 3연속. 둘 다 곡괭이당 1번. */
export const BonusEventKind = z.enum(["POP", "BIG_POP"]);
export type BonusEventKind = z.infer<typeof BonusEventKind>;
