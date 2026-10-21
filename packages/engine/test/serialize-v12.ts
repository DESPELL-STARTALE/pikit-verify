// (규칙 12 시험 전용) 규칙 11 엔진(5세계, 2f401a40)의 상태 직렬화 v12 그대로 — 규칙 12 새 칸(블록 quad · 곡괭이 itemUntil·itemKind·itemAngle)을 읽지 않는다.
// 규칙 11 출시 카탈로그 − buffs(새 꼴)로 돈 규칙 12 엔진의 상태를 이것으로 해시하면 5세계 빌드가 기록한 고정 기준(test/fixtures/r11-baseline.json
// checkpoints)과 같아야 한다 = 물리·판·보상 무변경 증거(r11-baseline.test.ts, 명세 25 §5.3-1). 원본: packages/engine/src/serialize.ts @ 2f401a40
// (STATE_ENCODING_TAG "PIKIT/state/v12"). 고치지 않는다.
import { utf8 } from "../src/index.js";
import type { BonusEvent, PickaxeResult, PickaxeState, RoomState } from "../src/index.js";

// ──────────────────────────────────────────────────────────────────────────
// 상태 직렬화 — 상태 해시의 입력. 같은 상태 = 같은 바이트.
//  - 모든 숫자는 IEEE-754 double 빅엔디언(DataView.setFloat64(..., false)) — 정수도 double로 정확히 표현된다
//  - NaN은 금지(구현마다 비트 패턴이 다를 수 있음, ECMA-262 NumericToRawBytes) → 오류
//  - 문자열은 u32 길이 + UTF-8, 불리언은 1바이트, 배열은 u32 길이 + 원소
//  - 배열은 엔진 순서 그대로 — 순서도 상태의 일부
//  - 방 상태(serializeRoom)마다 해시한다 → 앵커 roomsStateRoot의 잎들 (개정 3: 잔액은 체인에 있어 공유 장부가 없다)
// 해시(SHA-256 등)는 엔진 밖에서 계산한다(엔진은 Node API를 쓰지 않음).
// ──────────────────────────────────────────────────────────────────────────

// v12 (규칙 11, 명세 24 §4.3): 곡괭이 jackpotMilli 뒤 6칸(popStacks·buffCount·giantUntil·speedUntil·gravityMulBps·scaleTarget).
//   LIFE가 늘리는 durabilityTotal은 v9부터 이미 곡괭이 칸에 있다(frictionPerTick 뒤). 방·결과 칸은 그대로.
// v11 (규칙 10, 명세 23): 방 끝에 잭팟 통 4칸(pool·contributed·paid·wins), 곡괭이 막타 뒤 3칸(pickLevelBps·goldenHits·jackpotMilli),
//   결과 끝에 3칸(pickLevelBps·pickMilli·jackpotMilli).
// v10 (규칙 9, 명세 22): 곡괭이·결과에 막타 몫 lastHitMilli·횟수 lastHits (보너스 몫 바로 뒤).
// v9 (규칙 7, D137): 황금 입구 토큰·결과 삭제, 패턴·길 상태 삭제, LUCKY 종류·LUCKY 몫·BIG POP·초과분 추가, 하늘 절은 늘 있음
//   (v7/v8 두 갈래를 지움 — 규칙 7은 새 세계라 옛 기록은 옛 엔진 빌드로 재생한다).
// v8 (D125): 하늘 절. v7 (D107): 결제 수단 칸 삭제. v6 (D96): 황금 입구. v5 (D99): 버프 삭제. v4: 버프와 정리 개수. v3: 공유 장부 분리, roomId·묶음 진행·무효 구매
const STATE_ENCODING_TAG = "PIKIT/state/v12";

class ByteWriter {
  private buf = new Uint8Array(1 << 16);
  private view = new DataView(this.buf.buffer);
  private len = 0;

  private ensure(n: number): void {
    if (this.len + n <= this.buf.length) return;
    let size = this.buf.length * 2;
    while (size < this.len + n) size *= 2;
    const next = new Uint8Array(size);
    next.set(this.buf.subarray(0, this.len));
    this.buf = next;
    this.view = new DataView(next.buffer);
  }

  num(v: number): void {
    if (Number.isNaN(v)) throw new Error("serialize: NaN in engine state");
    this.ensure(8);
    this.view.setFloat64(this.len, v, false);
    this.len += 8;
  }

  u32(v: number): void {
    this.ensure(4);
    this.view.setUint32(this.len, v >>> 0, false);
    this.len += 4;
  }

  bool(v: boolean): void {
    this.ensure(1);
    this.buf[this.len++] = v ? 1 : 0;
  }

  str(s: string): void {
    const bytes = utf8(s);
    this.u32(bytes.length);
    this.ensure(bytes.length);
    this.buf.set(bytes, this.len);
    this.len += bytes.length;
  }

  optStr(s: string | null): void {
    this.bool(s !== null);
    if (s !== null) this.str(s);
  }

  nums(a: readonly number[]): void {
    this.u32(a.length);
    for (const v of a) this.num(v);
  }

  bytes(): Uint8Array {
    return this.buf.slice(0, this.len);
  }
}

/** 방 상태 전체(판, 곡괭이, 대기열, 끝난 곡괭이 결과, 거절 기록, 묶음 진행)를 바이트로. */
export function serializeRoomV12(state: RoomState): Uint8Array {
  const w = new ByteWriter();
  w.str(STATE_ENCODING_TAG);
  w.num(state.roomId);
  w.num(state.tick);
  w.num(state.window);
  w.num(state.scrollY);
  w.num(state.generatedRowCount);
  w.num(state.batchIndex);
  w.nums(state.batchRemaining);
  w.nums(state.batchKinds);
  w.nums(state.batchRowWindows);

  w.u32(state.blocks.length);
  for (const b of state.blocks) { w.num(b.kind); w.num(b.x); w.num(b.y); w.num(b.health); }

  w.u32(state.pickaxes.length);
  for (const p of state.pickaxes) writePickaxe(w, p);

  w.u32(state.owners.length);
  for (const s of state.owners) {
    w.str(s.owner);
    w.optStr(s.activeKey);
    w.num(s.nextSpawnWindow);
    w.u32(s.queue.length);
    for (const q of s.queue) { w.str(q.key); w.str(q.owner); w.num(q.tier); w.num(q.priceMilli); w.num(q.seq); }
  }

  w.num(state.queueSeq);

  w.u32(state.results.length);
  for (const r of state.results) writeResult(w, r);

  w.u32(state.rejected.length);
  for (const r of state.rejected) { w.num(r.window); w.num(r.index); w.str(r.reason); }

  w.u32(state.voidedRefs.length);
  for (const ref of state.voidedRefs) w.str(ref);

  w.num(state.prunedResults);
  w.num(state.prunedRejected);

  // (D125) 하늘 절
  const it = state.sky.item;
  w.bool(it !== null);
  if (it !== null) {
    w.num(it.id); w.num(it.x); w.num(it.y); w.num(it.vx); w.num(it.vy); w.num(it.angle); w.num(it.vAngle);
    w.num(it.scale); w.num(it.frictionPerTick); w.num(it.dropTick); w.num(it.ticks);
  }
  w.num(state.sky.nextWindow);
  w.u32(state.sky.boosts.length);
  for (const b of state.sky.boosts) { w.str(b.key); w.num(b.untilTick); }

  // (규칙 10) 잭팟 통
  w.num(state.jackpot.poolMilli); w.num(state.jackpot.contributedMilli); w.num(state.jackpot.paidMilli); w.num(state.jackpot.wins);
  return w.bytes();
}

function writePickaxe(w: ByteWriter, p: PickaxeState): void {
  w.str(p.key);
  w.optStr(p.owner);
  w.num(p.tier);
  w.num(p.priceMilli);
  w.num(p.x); w.num(p.y); w.num(p.vx); w.num(p.vy); w.num(p.angle); w.num(p.vAngle);
  w.num(p.scale); w.num(p.attack); w.num(p.frictionPerTick);
  w.num(p.durabilityTotal); w.num(p.durabilityLeft); w.num(p.spawnTick); w.num(p.lastDamageTick);
  w.num(p.luckyKind);
  w.num(p.baseMilli); w.num(p.carryMilli); w.num(p.luckyMilli); w.num(p.luckyCarryMilli); w.num(p.bonusMilli);
  w.num(p.lastHitMilli); w.num(p.lastHits);
  w.num(p.pickLevelBps); w.num(p.goldenHits); w.num(p.jackpotMilli);
  w.num(p.popStacks); w.num(p.buffCount); w.num(p.giantUntil); w.num(p.speedUntil); w.num(p.gravityMulBps); w.num(p.scaleTarget);
  w.nums(p.touched);
  w.num(p.popPrevKind); w.bool(p.popDone); w.bool(p.bigDone); w.num(p.streakKind); w.num(p.streakLen);
  writeEvents(w, p.bonusEvents);
  w.num(p.hits); w.num(p.blocksBroken);
}

function writeResult(w: ByteWriter, r: PickaxeResult): void {
  w.str(r.key); w.str(r.owner); w.num(r.tier); w.num(r.priceMilli);
  w.num(r.spawnTick); w.num(r.endTick); w.num(r.endWindow); w.str(r.endReason);
  w.num(r.hits); w.num(r.distinctBlocks); w.num(r.blocksBroken); w.num(r.durabilityUsed); w.num(r.durabilityTotal);
  w.bool(r.pop); w.bool(r.bigPop); writeEvents(w, r.events);
  w.num(r.luckyKind); w.num(r.baseMilli); w.num(r.luckyMilli); w.num(r.bonusMilli);
  w.num(r.lastHitMilli); w.num(r.lastHits); w.num(r.paidMilli); w.num(r.overMilli);
  w.num(r.pickLevelBps); w.num(r.pickMilli); w.num(r.jackpotMilli);
}

function writeEvents(w: ByteWriter, events: readonly BonusEvent[]): void {
  w.u32(events.length);
  for (const e of events) {
    w.str(e.kind); w.num(e.tick); w.num(e.window); w.num(e.blockKind); w.num(e.streakCount); w.num(e.prizeMilli); w.num(e.paidMilli);
  }
}
