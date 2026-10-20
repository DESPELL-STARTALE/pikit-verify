import {
  catalogCrack, catalogHasCombo, catalogJackpotContributionMilli, catalogJackpotKind, catalogJackpotMinPoolMilli, catalogLastHitMilli,
  type Catalog, type EndReason, type EngineInput, type PickaxeHitbox,
} from "@pikit/protocol";
import { createRingBuffer, generateBlockRows } from "./board.js";
import { drawLuckyBuff, expireBuffs, GRAVITY_MUL_ONE_BPS, growOnCombo, stepScales, type RoomBuffEvent } from "./buffs.js";
import { PhysicsEngine, type HitEvent } from "./physics.js";
import { pruneDue, pruneRoom } from "./prune.js";
import {
  applyHitReward, drawLuckyKind, drawPickLevelBps, overCapMilli, rewardCapMilli, settleAbnormal, settleNormal, streamU53, wholeCreditsMilli,
} from "./reward.js";
import { createSkyState, dropSkyBoost, maybeDropSkyItem, stepSkyItem, type RoomSkyEvent } from "./sky.js";
import type { Rng, RngFactory } from "./rng.js";
import type {
  BonusEvent, CompletedBatch, EnginePayout, OwnerSlot, PickaxeResult, PickaxeState, QueueItem, RoomState,
} from "./types.js";

// ──────────────────────────────────────────────────────────────────────────
// 방(Room) — 블록 시계로 움직이는 결정론 시뮬레이션. Colyseus 방이 아니라 순수 함수 묶음이다.
// 윈도(확정 블록) w 처리 순서 (설계 부록 B, 원본 World.update 순서):
//   0) (세계 단위) 방들을 roomId 오름차순으로 (world.ts runWorldWindow)
//   1) 입력 적용 (블록 w−1의 체인 이벤트 + 동결·무효 줄, 기록 순서 그대로)
//   2) 스폰: 살아 있는 곡괭이가 없고 nextSpawnWindow ≤ w인 지갑의 대기열 맨 앞 (대기열 순번 순). 판에 바로 놓는다
//      (`spawn|<키>` 자리·자세, 규칙 7: `lucky|<키>` 한 수로 LUCKY 종류). 황금 입구는 규칙 7에서 지웠다(D137)
//   (윈도 번호가 PRUNE_PERIOD_WINDOWS의 배수면 먼저 오래된 기록 정리 — prune.ts)
//   3) (규칙 개정 4, D94) 멈춤 규칙 없음 — 플레이어 곡괭이가 없어도 봇과 틱은 윈도마다 돈다(아레나는 쉬지 않는다)
//   4) ticksPerWindow(9)틱: 곡괭이마다 물리 → 깊이 제한 → 피해·보상 / 끝난 곡괭이 정산 / 카메라 / 줄 생성
//      (족보는 POP·BIG POP뿐 — 규칙 7)
//   (D125) 2.5) 스폰 뒤 하늘 별 떨어뜨리기(`sky` 스트림), 틱 안에서 곡괭이 물리 앞에 커지기 효과 한 걸음,
//      끝 정산 뒤에 별 한 걸음·잡기·사라짐 (sky.ts)
//   (규칙 10, 명세 23) 스폰: LUCKY 뒤 `pick|<키>` 수 하나로 LUCKY PICK 단계, 잭팟 통 += 등급 기여. 타격: 플레이어 곡괭이가 잭팟 종류를 치면
//      applyHitReward 앞에 균열 뽑기(`crack|<키>|<n>`) — 균열이면 블록 체력 0(깨짐), 통 전부가 그 곡괭이의 J. 정산: T = min(총상한, max(E, 바닥)) + J
//   (규칙 11, 명세 24 §4.2) 틱 안 순서 고정: 지름 한 걸음(stepScales — 하늘 효과 + 버프 크기 목표, tryGrow) → 곡괭이마다 물리(몸마다 중력 배수) →
//      타격마다 균열 → applyHitReward(기본 · LUCKY · 막타 · COMBO 상금) → 새 칸이면 COMBO 성장 → 새 LUCKY 칸이면 버프 뽑기(`buff|<키>|<n>`) →
//      끝난 버프 정리(expireBuffs) → 정산(wholeCredits면 정수 크레딧) → 별 → 카메라 → 줄 (buffs.ts)
// 돈(개정 3): 엔진은 잔액을 모른다. 구매는 체인에서 이미 돈을 냈고, 엔진은 곡괭이마다 정산 값(EnginePayout)만 정한다 —
// 게임 서버가 DB에 남기고 settler가 체인 settleEnd로 보낸다(체인이 상한을 강제, 규칙 7: REWARD + 초과분 한 호출).
// 원본(World.ts)에서 버린 것: 벽시계 루프·dt, 접속자 0 정지, 비동기 블록 덱, TNT, Math.random 폴백.
// ──────────────────────────────────────────────────────────────────────────

const TWO_PI = Math.PI * 2;

/** 윈도 안에서 난 보너스 사건 (어느 곡괭이의 것인지 포함). 게임 서버가 피드(FeedEvent)로 바꿔 방 전체·전체 티커에 보낸다. */
export interface RoomBonusEvent extends BonusEvent {
  key: string;
  owner: string;
  tier: number;
}

/**
 * (규칙 9) 윈도 안에서 난 막타 1건 — 한 방에 못 깨는 블록(hp > 공격력)을 주인 있는 곡괭이가 깸. 게임 서버가 피드 `LAST_HIT`로 바꾼다.
 * prizeMilli = 규칙상 상금(catalogLastHitMilli), paidMilli = 곡괭이당 상한을 적용한 실제 지급(0일 수 있음). BonusEvent가 아니다(장부 해시의 BonusEventKind 그대로).
 */
export interface RoomLastHitEvent {
  key: string;
  owner: string;
  tier: number;
  window: number;
  tick: number;
  blockKind: number;
  prizeMilli: number;
  paidMilli: number;
}

/** 이 윈도에 스폰된(판에 놓인) 곡괭이 (피드 QUEUE_SPAWN의 원본). */
export interface SpawnRecord {
  key: string;
  owner: string;
  tier: number;
  tick: number;
  luckyKind: number;   // (규칙 7) 이 곡괭이의 LUCKY 종류 — 나올 때 공개
  pickLevelBps: number;        // (규칙 10) LUCKY PICK 단계(bps, 0 = 없음) — 나올 때 공개 (피드 LUCKY_PICK)
  contributionMilli: number;   // (규칙 10) 이 소환이 잭팟 통에 더한 몫
}

/**
 * (규칙 10, 명세 23 §4.2) 윈도 안에서 난 잭팟 균열 1건 — 주인 있는 곡괭이가 잭팟 종류 블록을 쳐서 통 전부(amountMilli = J)를 받음.
 * 게임 서버가 피드 `JACKPOT`으로 바꾼다. x·y = 블록 칸, poolAfterMilli = 균열 뒤 통(규칙 10: 늘 0 · 규칙 11 wholeCredits: J를 1,000밀리 단위로 내린
 * 나머지 < 1,000). BonusEvent가 아니다(장부 해시의 BonusEventKind 그대로).
 */
export interface RoomJackpotEvent {
  key: string;
  owner: string;
  tier: number;
  window: number;
  tick: number;
  blockKind: number;
  x: number;
  y: number;
  amountMilli: number;
  poolAfterMilli: number;
}

/** 무효 구매 하나를 처리한 결과 (voidPurchase 입력). */
export interface VoidRecord {
  ref: string;
  owner: string;
  removedItemKeys: string[];   // 대기열에서 지운 항목 + 지급 없이 없앤 살아 있던 곡괭이 (정산 없음, 체인 refundUnprocessed가 100%)
}

/** 윈도 하나를 처리한 결과. 사건은 일어난 순서대로. */
export interface WindowResult {
  window: number;
  ticksRun: number;           // 이 윈도에 돈 틱 수 (개정 4부터 늘 ticksPerWindow)
  spawned: SpawnRecord[];     // 이 윈도에 스폰된 곡괭이
  events: RoomBonusEvent[];   // 이 윈도에 난 보너스 사건
  ended: PickaxeResult[];     // 이 윈도에 끝난 곡괭이
  batches: CompletedBatch[];  // 이 윈도에 다 만들어진 2,000블록 묶음
  voided: VoidRecord[];       // 이 윈도에 무효 처리된 구매
  payouts: EnginePayout[];    // 이 윈도에 정해진 곡괭이별 정산 (생긴 순서)
  sky: RoomSkyEvent[];        // (D125) 이 윈도의 하늘 사건 DROP / CAUGHT / EXPIRED (일어난 순서)
  lastHits: RoomLastHitEvent[];   // (규칙 9) 이 윈도의 막타 (일어난 순서)
  jackpots: RoomJackpotEvent[];   // (규칙 10) 이 윈도의 잭팟 균열 (일어난 순서)
  buffs: RoomBuffEvent[];         // (규칙 11) 이 윈도의 LUCKY 버프 (일어난 순서 — 같은 타격의 COMBO 사건 뒤)
}

/**
 * 새 방: 링버퍼를 채우고 봇을 놓는다. createdWindow = 방을 만든 윈도(입력 없음), rng = 그 윈도의 스트림 팩토리
 * (봇 시작값 `botspawn|i`, 줄 `row|y`). 다음 runWindow는 createdWindow + 1부터.
 */
export function createRoom(catalog: Catalog, rng: RngFactory, roomId: number, createdWindow: number): RoomState {
  const { height, ringBufferRowMultiplier, botStartY, cameraLeadFraction } = catalog.world;
  if (!Number.isSafeInteger(createdWindow) || createdWindow < 0) throw new Error(`createRoom: bad createdWindow ${createdWindow}`);
  const state: RoomState = {
    roomId,
    tick: 0,
    window: createdWindow,
    scrollY: Math.max(0, botStartY - height * cameraLeadFraction),
    generatedRowCount: 0,
    blocks: createRingBuffer(catalog),
    batchIndex: -1,
    batchRemaining: [],
    batchKinds: [],
    batchRowWindows: [],
    pickaxes: [],
    owners: [],
    queueSeq: 0,
    results: [],
    rejected: [],
    voidedRefs: [],
    prunedResults: 0,
    prunedRejected: 0,
    sky: createSkyState(),
    jackpot: { poolMilli: 0, contributedMilli: 0, paidMilli: 0, wins: 0 },
  };
  const batches = generateBlockRows(state, catalog, height * ringBufferRowMultiplier, rng, createdWindow);
  if (batches.length > 0) throw new Error("createRoom: the initial rows must not complete a batch");

  // 봇: 봇 칸(catalog.bots[slot])의 몸 그대로, 상태의 tier = 그 칸 위치 (D104). 내구도·가격·보상 없음
  let botIndex = 0;
  catalog.bots.forEach((spec, slot) => {
    for (let n = 0; n < spec.count; n++) {
      const stream = rng(`botspawn|${botIndex}`);
      const x = stream.next() * catalog.world.width;
      state.pickaxes.push(makePickaxe(catalog, { ...spec, durability: 0 }, slot, `bot:${botIndex}`, null, 0, x, botStartY, stream, 0));
      botIndex += 1;
    }
  });
  return state;
}

/**
 * 윈도 w를 처리한다. w는 직전 윈도보다 커야 한다. 건너뛴 윈도는 입력도 틱도 없다 — 봇도 그 윈도를 건너뛰므로 재생기(게임 서버·검증기)는 윈도를 빠짐없이 부른다.
 * 방 여러 개는 runWorldWindow가 roomId 순서로 부른다.
 */
export function runWindow(state: RoomState, catalog: Catalog, window: number, inputs: readonly EngineInput[], rng: RngFactory): WindowResult {
  if (!Number.isSafeInteger(window) || window <= state.window) throw new Error(`runWindow: window ${window} must be > ${state.window}`);
  state.window = window;
  const result: WindowResult = { window, ticksRun: 0, spawned: [], events: [], ended: [], batches: [], voided: [], payouts: [], sky: [], lastHits: [], jackpots: [], buffs: [] };
  const ctx: Ctx = { state, catalog, window, payouts: result.payouts };

  // ── 0) 오래된 기록 정리 (규칙의 일부 — 모든 재생기가 같은 윈도에서 같은 것을 지운다)
  if (pruneDue(window)) pruneRoom(state, window);

  // ── 1) 입력
  inputs.forEach((input, index) => applyInput(ctx, index, input, result));

  // ── 2) 스폰
  spawnFromQueues(state, catalog, window, rng, result.spawned);

  const physics = physicsFor(catalog);

  // ── 2.5) 하늘 이벤트 (D125): 조건이 되면 `sky` 스트림으로 별을 떨어뜨린다
  maybeDropSkyItem(state, catalog, window, rng, physics, result.sky);

  // ── 3)·4) 틱 (멈춤 규칙 없음 — D94)
  for (let t = 0; t < catalog.world.ticksPerWindow; t++) stepTick(ctx, physics, rng, result);
  result.ticksRun = catalog.world.ticksPerWindow;
  return result;
}

/** 카탈로그의 물리 엔진 (등급별 히트박스 + 봇 칸별 모양). */
export function physicsFor(catalog: Catalog): PhysicsEngine {
  return new PhysicsEngine(catalog.physics, catalog.pickaxes.map((t) => t.hitbox), catalog.bots.map((b) => b.hitbox));
}

/**
 * 몸의 tier·봇 여부 → 엔진이 그 몸에 쓰는 히트박스. 플레이어 곡괭이는 등급 모양, 봇은 봇 칸 모양(봇의 tier = catalog.bots 위치, D104).
 * physicsFor와 화면이 같은 규칙을 쓴다. 모르는 칸이면 undefined.
 */
export function bodyHitbox(catalog: Catalog, tier: number, bot: boolean): PickaxeHitbox | undefined {
  return bot ? catalog.bots[tier]?.hitbox : catalog.pickaxes[tier]?.hitbox;
}

interface Ctx {
  state: RoomState;
  catalog: Catalog;
  window: number;
  payouts: EnginePayout[];
}

/**
 * 곡괭이(또는 대기열 항목) 하나의 정산을 정한다 (규칙 7: 곡괭이당 정확히 1건, settleEnd 한 번).
 * jackpotMilli = 그 곡괭이의 잭팟 J (규칙 10 — 총상한 밖이라 over 가드에 더한다, 명세 23 §3.2).
 */
function payout(
  ctx: Ctx, tick: number, item: { key: string; owner: string; tier: number; priceMilli: number },
  kind: EnginePayout["kind"], cause: EnginePayout["cause"], payoutMilli: number, overMilli = 0, jackpotMilli = 0,
): void {
  if (!Number.isSafeInteger(payoutMilli) || payoutMilli < 0) throw new Error(`payout: bad amount ${payoutMilli} (${item.key})`);
  if (!Number.isSafeInteger(overMilli) || overMilli < 0) throw new Error(`payout: bad over ${overMilli} (${item.key})`);
  // 체인 상한과 같은 불변식: REFUND ≤ 가격, REWARD ≤ REWARD 상한, over ≤ over 상한, over > 0이면 REWARD
  if (kind === "REFUND" && payoutMilli > item.priceMilli) throw new Error(`payout: refund above price (${item.key})`);
  if (kind === "REWARD" && payoutMilli > rewardCapMilli(ctx.catalog, item.tier)) throw new Error(`payout: reward above cap (${item.key})`);
  if (overMilli > 0 && kind !== "REWARD") throw new Error(`payout: over on a refund (${item.key})`);
  if (overMilli > overCapMilli(ctx.catalog, item.tier) + jackpotMilli) throw new Error(`payout: over above cap (${item.key})`);
  // (규칙 11, 명세 24 §3.10) 정수 크레딧 정산: 모든 정산(정상·비정상·환불)의 payout·over가 1,000밀리의 배수
  if (ctx.catalog.reward.wholeCredits && (payoutMilli % 1000 !== 0 || overMilli % 1000 !== 0)) throw new Error(`payout: not whole credits (${item.key})`);
  ctx.payouts.push({
    key: item.key, owner: item.owner, tier: item.tier, priceMilli: item.priceMilli,
    kind, cause, payoutMilli, overMilli, window: ctx.window, tick,
  });
}

// ──────────────────────────────────────────────────────────────────────────
// 틱 하나
// ──────────────────────────────────────────────────────────────────────────
function stepTick(ctx: Ctx, physics: PhysicsEngine, rng: RngFactory, out: WindowResult): void {
  const { state, catalog, window } = ctx;
  const width = catalog.world.width;
  const tick = state.tick;
  let maxY = -Infinity;

  // (D125 · 규칙 11) 지름 한 걸음 (곡괭이 물리 앞): 하늘 효과 + 버프 크기 목표, 커질 때는 tryGrow만 — buffs.ts
  if (state.sky.boosts.length > 0 || catalog.buffs) stepScales(state, catalog, physics);

  // 곡괭이마다 물리·충돌·피해·보상 (배열 순서 = 봇 먼저, 그다음 판에 들어온 순)
  for (const p of state.pickaxes) {
    const hits = physics.advancePickaxe(p, state.blocks, width, rng(kickLabel(p)));
    physics.clampPickaxeToGeneratedDepth(p, state.generatedRowCount);
    creditHits(ctx, p, hits, rng, out);
    assertFinite(p);
    maxY = Math.max(maxY, p.y);
  }

  // (규칙 11) 끝난 버프 정리: tick ≥ until인 GIANT(크기 목표 다시)·SPEED(중력 ×1) — 정산 앞
  if (catalog.buffs) expireBuffs(state, catalog, tick);

  // 끝난 곡괭이 정산 (내구도 소진 = 정상, 타이머·멈춤 = 비정상)
  const survivors: PickaxeState[] = [];
  for (const p of state.pickaxes) {
    const reason = p.owner === null ? null : endReasonAfterTick(catalog, p, tick);
    if (reason) settle(ctx, p, reason, tick, out.ended);
    else survivors.push(p);
  }
  state.pickaxes = survivors;

  // (D125) 별 한 걸음 → 잡기 → 시간 끝 (정산 뒤 = 이번 틱에 끝난 곡괭이는 못 잡는다). 별은 카메라를 움직이지 않는다
  if (state.sky.item) stepSkyItem(state, catalog, window, rng, physics, out.sky);

  // 카메라: 가장 깊은 곡괭이보다 화면 높이 × lead 위를 보간으로 따라간다
  if (Number.isFinite(maxY)) {
    const targetY = maxY - catalog.world.height * catalog.world.cameraLeadFraction;
    state.scrollY += (targetY - state.scrollY) * catalog.world.cameraLerp;
  }

  // 스크롤에 맞춰 줄 생성 (동기식)
  const targetGeneratedRow = Math.ceil(catalog.world.height + state.scrollY);
  if (state.generatedRowCount < targetGeneratedRow) {
    out.batches.push(...generateBlockRows(state, catalog, targetGeneratedRow - state.generatedRowCount, rng, window));
  }

  state.tick += 1;
}

function endReasonAfterTick(catalog: Catalog, p: PickaxeState, tick: number): EndReason | null {
  if (p.durabilityLeft <= 0) return "DURABILITY";
  if (tick + 1 - p.spawnTick >= catalog.limits.timerTicks) return "TIMER";
  if (tick + 1 - p.lastDamageTick >= catalog.limits.stuckTicks) return "STUCK";
  return null;
}

/**
 * 피해 목록을 구매 하나의 통계·보상에 반영한다. 봇은 통계만.
 * (규칙 10, 명세 23 §4.2) applyHitReward 앞에 잭팟 균열: 주인 있음 ∧ 블록 = 잭팟 종류 ∧ 아직 J 없음 → n = goldenHits++ →
 * 통 ≥ minPool이면 `crack|<키>|<n>` 첫 수로 catalogCrack. 균열이면 블록 체력 0(같은 틱 뒤 곡괭이와 다음 틱부터 그 블록이 없다),
 * 이 타격은 깨뜨린 타격(LAST HIT 규칙 그대로), J = 통 전부, 통 = 0. 같은 틱 순서 = state.pickaxes 순서(첫 균열 뒤 통 0 → 뒤는 뽑지 않음).
 * (규칙 11, 명세 24 §4.2) wholeCredits면 J = ⌊통 / 1000⌋ × 1000, 나머지는 통에 남는다(contributed = pool + paid 그대로).
 * applyHitReward(COMBO 상금 포함) 뒤, 이 타격이 처음 닿은 칸이면: COMBO 단계(s ≥ 2)마다 성장(growOnCombo) → 그 칸이 내 LUCKY 종류면
 * 버프 뽑기(drawLuckyBuff, `buff|<키>|<n>`) — 순서 고정: 균열 → applyHitReward → COMBO → 버프.
 */
function creditHits(ctx: Ctx, p: PickaxeState, hits: readonly HitEvent[], rng: RngFactory, out: WindowResult): void {
  const { state, catalog, window } = ctx;
  const tick = state.tick;
  const jackpotKind = catalogJackpotKind(catalog);
  for (const hit of hits) {
    p.hits += 1;
    if (hit.destroyed) p.blocksBroken += 1;
    if (p.owner === null) continue;
    p.lastDamageTick = tick;
    let destroyed = hit.destroyed;
    if (hit.block.kind === jackpotKind && p.jackpotMilli === 0) {
      const n = p.goldenHits++;
      const pool = state.jackpot.poolMilli;
      if (pool >= catalogJackpotMinPoolMilli(catalog) && catalogCrack(catalog, p.tier, pool, streamU53(rng(`crack|${p.key}|${n}`)))) {
        if (!destroyed) {
          hit.block.health = 0;
          destroyed = true;
          p.blocksBroken += 1;
        }
        const won = catalog.reward.wholeCredits ? wholeCreditsMilli(pool) : pool;   // (규칙 11) 정수 크레딧, 나머지는 통에
        p.jackpotMilli = won;
        state.jackpot.poolMilli = pool - won;
        state.jackpot.paidMilli += won;
        state.jackpot.wins += 1;
        out.jackpots.push({
          key: p.key, owner: p.owner, tier: p.tier, window, tick, blockKind: hit.block.kind, x: hit.block.x, y: hit.block.y,
          amountMilli: won, poolAfterMilli: state.jackpot.poolMilli,
        });
      }
    }
    const before = p.bonusEvents.length;
    const lastHitsBefore = p.lastHits;
    const lastHitMilliBefore = p.lastHitMilli;
    const touchedBefore = p.touched.length;
    applyHitReward(catalog, p, hit.block, hit.damage, { window, tick }, destroyed);
    if (p.lastHits > lastHitsBefore) {
      out.lastHits.push({
        key: p.key, owner: p.owner, tier: p.tier, window, tick, blockKind: hit.block.kind,
        prizeMilli: catalogLastHitMilli(catalog, p.tier, hit.block.kind), paidMilli: p.lastHitMilli - lastHitMilliBefore,
      });
    }
    for (let i = before; i < p.bonusEvents.length; i++) out.events.push({ ...p.bonusEvents[i]!, key: p.key, owner: p.owner, tier: p.tier });
    // (규칙 11) 새 칸: COMBO 단계면 성장, 내 LUCKY 종류면 버프 (catalog.buffs가 없으면 둘 다 없음)
    if (catalog.buffs && p.touched.length > touchedBefore) {
      if (catalogHasCombo(catalog) && p.streakLen >= 2) growOnCombo(catalog, p);
      if (hit.block.kind === p.luckyKind) {
        const buff = drawLuckyBuff(catalog, p, rng, { window, tick });
        if (buff) out.buffs.push(buff);
      }
    }
  }
}

/** 반탄력 보정 스트림: 봇 `bot|i`, 플레이어 `kick|키`. */
function kickLabel(p: PickaxeState): string {
  return p.owner === null ? `bot|${p.key.slice(4)}` : `kick|${p.key}`;
}

function assertFinite(p: PickaxeState): void {
  // 상태 해시는 NaN을 담을 수 없다(구현마다 비트가 다름) → 엔진이 NaN을 만들면 즉시 멈춘다
  if (!Number.isFinite(p.x) || !Number.isFinite(p.y) || !Number.isFinite(p.vx) || !Number.isFinite(p.vy) || !Number.isFinite(p.angle)) {
    throw new Error(`engine: non-finite pickaxe state (${p.key})`);
  }
}

// ──────────────────────────────────────────────────────────────────────────
// 정산
// ──────────────────────────────────────────────────────────────────────────
function settle(ctx: Ctx, p: PickaxeState, reason: EndReason, tick: number, ended: PickaxeResult[]): void {
  const { state, window } = ctx;
  if (p.owner === null) throw new Error("settle: bots are never settled");
  dropSkyBoost(state, p.key);   // (D125) 끝난 곡괭이의 커지기 효과도 끝
  const item = { key: p.key, owner: p.owner, tier: p.tier, priceMilli: p.priceMilli };
  let paid = 0;
  let over = 0;
  let pick = 0;
  let jackpot = p.jackpotMilli;
  if (reason === "DURABILITY") {
    const s = settleNormal(ctx.catalog, p);
    paid = s.payoutMilli;
    over = s.overMilli;
    pick = s.pickMilli;
    payout(ctx, tick, item, "REWARD", "END", paid, over, jackpot);
  } else if (reason !== "VOID") {
    // (규칙 10) 단계·J가 없으면 규칙 9 그대로 REFUND V, 있으면 REWARD/ABNORMAL_END (명세 23 §3.2)
    const s = settleAbnormal(ctx.catalog, p);
    paid = s.payoutMilli;
    over = s.overMilli;
    pick = s.pickMilli;
    payout(ctx, tick, item, s.kind, "ABNORMAL_END", paid, over, jackpot);
  } else if (jackpot > 0) {
    // (규칙 10) VOID: 지급 없음 — 받은 잭팟은 통으로 돌아간다 (contributed = pool + paid 유지)
    state.jackpot.poolMilli += jackpot;
    state.jackpot.paidMilli -= jackpot;
    state.jackpot.wins -= 1;
    jackpot = 0;
  }

  const result: PickaxeResult = {
    key: p.key,
    owner: p.owner,
    tier: p.tier,
    priceMilli: p.priceMilli,
    spawnTick: p.spawnTick,
    endTick: tick,
    endWindow: window,
    endReason: reason,
    hits: p.hits,
    distinctBlocks: p.touched.length,
    blocksBroken: p.blocksBroken,
    durabilityUsed: p.durabilityTotal - p.durabilityLeft,
    durabilityTotal: p.durabilityTotal,
    pop: p.popDone,
    bigPop: p.bigDone,
    events: p.bonusEvents.map((e) => ({ ...e })),
    luckyKind: p.luckyKind,
    baseMilli: p.baseMilli,
    luckyMilli: p.luckyMilli,
    bonusMilli: p.bonusMilli,
    lastHitMilli: p.lastHitMilli,
    lastHits: p.lastHits,
    paidMilli: paid,
    overMilli: over,
    pickLevelBps: p.pickLevelBps,
    pickMilli: pick,
    jackpotMilli: jackpot,
  };
  state.results.push(result);
  ended.push(result);

  const slot = ownerSlot(state, p.owner);
  slot.activeKey = null;
  slot.nextSpawnWindow = window + 1;
}

// ──────────────────────────────────────────────────────────────────────────
// 입력
// ──────────────────────────────────────────────────────────────────────────
function applyInput(ctx: Ctx, index: number, input: EngineInput, out: WindowResult): void {
  const { state, catalog, window } = ctx;
  switch (input.type) {
    case "purchase": {
      // 돈은 체인에서 이미 냈다(MON·출금 가능 잔액·프로모 잔액). 형식이 틀린 구매는 체인이 받지 않으므로 아래 거절은 방어용이다.
      if (input.tiers.length > catalog.limits.maxTiersPerBuy) return reject(state, window, index, "TOO_MANY_TIERS");
      if (input.tiers.some((t) => !catalog.pickaxes[t])) return reject(state, window, index, "BAD_TIER");
      if (state.voidedRefs.includes(input.ref)) return reject(state, window, index, "ALREADY_VOID");
      const slot = ownerSlot(state, input.owner);
      input.tiers.forEach((tier, i) => {
        const item: QueueItem = {
          key: `${input.ref}:${i}`, owner: input.owner, tier, priceMilli: catalog.pickaxes[tier]!.priceCredits * 1000, seq: state.queueSeq++,
        };
        if (slot.queue.length >= catalog.limits.queueMax) return payout(ctx, state.tick, item, "REFUND", "OVERFLOW", item.priceMilli);
        slot.queue.push(item);
      });
      return;
    }
    case "cancel": {
      const slot = state.owners.find((s) => s.owner === input.owner);
      const at = slot ? slot.queue.findIndex((q) => q.key === input.itemKey) : -1;
      if (!slot || at < 0) return reject(state, window, index, "NOT_QUEUED");
      const [item] = slot.queue.splice(at, 1);
      payout(ctx, state.tick, item!, "REFUND", "CANCEL", item!.priceMilli);
      return;
    }
    case "freeze": {
      // 돌던 곡괭이는 비정상 종료 값, 대기 중인 곡괭이는 100% (설계 §5.3)
      for (const p of state.pickaxes) if (p.owner !== null) settle(ctx, p, input.reason, state.tick, out.ended);
      state.pickaxes = state.pickaxes.filter((p) => p.owner === null);
      for (const slot of state.owners) {
        for (const item of slot.queue) payout(ctx, state.tick, item, "REFUND", "QUEUE_REFUND", item.priceMilli);
        slot.queue = [];
        slot.nextSpawnWindow = window + 1;
      }
      return;
    }
    case "voidPurchase": {
      if (state.voidedRefs.includes(input.ref)) return reject(state, window, index, "ALREADY_VOID");
      state.voidedRefs.push(input.ref);
      out.voided.push(voidPurchase(ctx, input.ref, input.owner, out.ended));
      return;
    }
  }
}

/**
 * 무효 구매 제거 (설계 §5.3 "무효 구매가 만든 곡괭이는 F에서 제거"). 돈은 체인 `refundUnprocessed`(정산이 없을 때 가격 100%) 또는
 * 정산 시한 뒤 `refundUnsettled`(안 된 곡괭이 100%, D93)가 잔액으로 돌려주므로 엔진은 그 구매의 대기 항목과 살아 있는 곡괭이를
 * 정산 없이 없앤다(endReason VOID). 이미 체인에 정산된 앞 항목은 그 값을 갖고(D93: 앵커 전 정산), 아직 안 보낸 행은 체인이
 * 받지 않는다(무효·환불된 구매는 정산 불가) — settler가 그 행을 VOID로 둔다.
 */
function voidPurchase(ctx: Ctx, ref: string, owner: string, ended: PickaxeResult[]): VoidRecord {
  const { state } = ctx;
  const prefix = `${ref}:`;
  const removed: string[] = [];
  const slot = state.owners.find((s) => s.owner === owner);
  if (slot) {
    for (const item of slot.queue) if (item.key.startsWith(prefix)) removed.push(item.key);
    slot.queue = slot.queue.filter((item) => !item.key.startsWith(prefix));
  }
  for (const p of state.pickaxes) {
    if (p.owner === owner && p.key.startsWith(prefix)) {
      settle(ctx, p, "VOID", state.tick, ended);   // 정산 없음, 슬롯을 비우고 다음 곡괭이는 w + 1
      removed.push(p.key);
    }
  }
  state.pickaxes = state.pickaxes.filter((p) => !(p.owner === owner && p.key.startsWith(prefix)));
  return { ref, owner, removedItemKeys: removed };
}

function reject(state: RoomState, window: number, index: number, reason: RoomState["rejected"][number]["reason"]): void {
  state.rejected.push({ window, index, reason });
}

function ownerSlot(state: RoomState, owner: string): OwnerSlot {
  let slot = state.owners.find((s) => s.owner === owner);
  if (!slot) {
    slot = { owner, queue: [], activeKey: null, nextSpawnWindow: 0 };
    state.owners.push(slot);
  }
  return slot;
}

// ──────────────────────────────────────────────────────────────────────────
// 스폰
// ──────────────────────────────────────────────────────────────────────────
function spawnFromQueues(state: RoomState, catalog: Catalog, window: number, rng: RngFactory, spawned: SpawnRecord[]): void {
  const ready = state.owners
    .filter((s) => s.activeKey === null && s.queue.length > 0 && s.nextSpawnWindow <= window)
    .sort((a, b) => a.queue[0]!.seq - b.queue[0]!.seq);   // seq는 방 전체에서 유일 → 동률 없음
  for (const slot of ready) {
    const item = slot.queue.shift()!;
    const p = placeOnBoard(state, catalog, item, rng);
    slot.activeKey = item.key;
    // (규칙 10, 명세 23 §4.1) 통이 늘어나는 유일한 곳: 플레이어 곡괭이 소환 (대기열·취소는 0)
    const contributionMilli = catalogJackpotContributionMilli(catalog, item.tier);
    state.jackpot.poolMilli += contributionMilli;
    state.jackpot.contributedMilli += contributionMilli;
    spawned.push({ key: item.key, owner: item.owner, tier: item.tier, tick: state.tick, luckyKind: p.luckyKind, pickLevelBps: p.pickLevelBps, contributionMilli });
  }
}

/**
 * 곡괭이를 판에 놓는다 (스폰 윈도 맨 앞): x = `spawn|<키>` 첫 수 × 폭, y = 카메라 − spawnOffsetRows, 같은 스트림에서 자세,
 * 블록과 겹치면 빈 곳으로 옮김. (규칙 7) LUCKY 종류 = `lucky|<키>`의 수 하나 (나올 때 공개, 물리와 무관).
 */
function placeOnBoard(
  state: RoomState, catalog: Catalog, item: { key: string; owner: string; tier: number; priceMilli: number }, rng: RngFactory,
): PickaxeState {
  const stream = rng(`spawn|${item.key}`);
  const x = stream.next() * catalog.world.width;
  const y = state.scrollY - catalog.world.spawnOffsetRows;
  const tier = catalog.pickaxes[item.tier];
  if (!tier) throw new Error(`placeOnBoard: unknown tier ${item.tier}`);
  const p = makePickaxe(catalog, tier, item.tier, item.key, item.owner, item.priceMilli, x, y, stream, state.tick);
  relocateSpawnToEmptySpace(state, catalog, p, rng);
  p.luckyKind = drawLuckyKind(catalog, rng(`lucky|${item.key}`).next());
  p.pickLevelBps = drawPickLevelBps(catalog, rng(`pick|${item.key}`), item.tier);   // (규칙 10) LUCKY PICK — 물리와 무관한 새 스트림
  state.pickaxes.push(p);
  return p;
}

/** 몸 숫자(등급 칸·봇 칸)에서 곡괭이를 만든다. 스트림에서 각도·vx·각속도를 순서대로 뽑는다(원본 item.model.ts toPickaxeState). */
/** 몸 숫자 (등급 칸 또는 봇 칸). 봇은 durability 0 = 무제한. */
interface BodySpec {
  scale: number;
  attack: number;
  frictionPerTick: number;
  durability: number;
}

function makePickaxe(
  catalog: Catalog, body: BodySpec, tier: number, key: string, owner: string | null, priceMilli: number,
  x: number, y: number, stream: Rng, spawnTick: number,
): PickaxeState {
  const p: PickaxeState = {
    key, owner, tier, priceMilli,
    x, y,
    vx: 0, vy: 0,   // 초기 vy는 주지 않는다 — 자유낙하만으로 가속 (원본 주석과 같음)
    angle: 0, vAngle: 0,
    scale: body.scale, attack: body.attack,
    frictionPerTick: body.frictionPerTick,
    durabilityTotal: body.durability,
    durabilityLeft: body.durability,
    spawnTick, lastDamageTick: spawnTick,
    luckyKind: -1,
    baseMilli: 0, carryMilli: 0, luckyMilli: 0, luckyCarryMilli: 0, bonusMilli: 0,
    touched: [], popPrevKind: -1, popDone: false, bigDone: false, streakKind: -1, streakLen: 0,
    bonusEvents: [],
    lastHitMilli: 0, lastHits: 0,
    pickLevelBps: 0, goldenHits: 0, jackpotMilli: 0,
    popStacks: 0, buffCount: 0, giantUntil: 0, speedUntil: 0, gravityMulBps: GRAVITY_MUL_ONE_BPS, scaleTarget: body.scale,
    hits: 0, blocksBroken: 0,
  };
  p.angle = stream.next() * TWO_PI;
  p.vx = (stream.next() - 0.5) * 0.2;       // -0.1 ~ 0.1 — 좌우 흔들림
  p.vAngle = (stream.next() - 0.5) * 0.3;   // 회전 효과
  return p;
}

/**
 * 스폰 위치가 블록과 겹치면 가까운 빈 곳으로 옮긴다 (원본 World.ts relocateItemSpawnToEmptySpace의 결정론 판).
 * x 후보: 원위치 + 0.5칸 격자(toFixed·Set 대신 정확한 k/2), 원위치 거리 → 정수 우선 → x 오름차순.
 * y 후보: 원위치, 위로 1~5칸, 아래로 1~5칸. 모두 막히면 봇 하나의 위치(`reloc|키`), 봇도 없으면 화면 위 공중.
 * 원본 그대로 반경 대신 scale(지름)로 겹침을 본다 — 넉넉한 쪽이라 유지.
 */
function relocateSpawnToEmptySpace(state: RoomState, catalog: Catalog, p: PickaxeState, rng: RngFactory): void {
  if (!isOverlappingSolidBlock(state, catalog, p)) return;
  const { width, height } = catalog.world;
  const originalX = p.x;
  const originalY = p.y;
  const r = p.scale || 0.5;
  const minX = r;
  const maxX = Math.max(r, width - r);

  const raw: number[] = [originalX];
  for (let k = 0; k <= 2 * width; k++) raw.push(k / 2);
  const xs = raw
    .filter((x, i) => raw.indexOf(x) === i)
    .filter((x) => minX <= x && x <= maxX)
    .sort((a, b) => {
      const da = Math.abs(a - originalX);
      const db = Math.abs(b - originalX);
      if (da !== db) return da - db;
      const ia = Number.isInteger(a) ? 0 : 1;
      const ib = Number.isInteger(b) ? 0 : 1;
      if (ia !== ib) return ia - ib;
      return a - b;
    });
  const ys = [0, -1, -2, -3, -4, -5, 1, 2, 3, 4, 5].map((d) => originalY + d);

  for (const y of ys) {
    p.y = y;
    for (const x of xs) {
      p.x = x;
      if (!isOverlappingSolidBlock(state, catalog, p)) return;
    }
  }

  const bots = state.pickaxes.filter((q) => q.owner === null);
  if (bots.length > 0) {
    const bot = bots[Math.floor(rng(`reloc|${p.key}`).next() * bots.length)]!;
    p.x = bot.x;
    p.y = bot.y;
    return;
  }
  p.x = originalX;
  p.y = state.scrollY - Math.floor(height * 0.4);
}

/** 곡괭이 외곽 사각형(반경 = scale)과 살아 있는 블록이 겹치나 (원본 isItemOverlappingSolidBlock). */
function isOverlappingSolidBlock(state: RoomState, catalog: Catalog, p: PickaxeState): boolean {
  const EPSILON = 1e-9;
  const width = catalog.world.width;
  const rows = Math.floor(state.blocks.length / width);
  const r = p.scale || 0.5;
  const left = p.x - r;
  const right = p.x + r;
  const top = p.y - r;
  const bottom = p.y + r;
  const sx = Math.max(0, Math.floor(left));
  const ex = Math.min(width - 1, Math.floor(right));
  const sy = Math.floor(top);
  const ey = Math.floor(bottom);
  for (let y = sy; y <= ey; y++) {
    for (let x = sx; x <= ex; x++) {
      const block = state.blocks[(((y % rows) + rows) % rows) * width + x]!;
      if (block.health <= 0 || block.y !== y) continue;
      const overlaps = right >= block.x - EPSILON && left <= block.x + 1 + EPSILON && bottom >= block.y - EPSILON && top <= block.y + 1 + EPSILON;
      if (overlaps) return true;
    }
  }
  return false;
}
