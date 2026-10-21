import type { BonusEventKind, EndReason } from "@pikit/protocol";

// ──────────────────────────────────────────────────────────────────────────
// 엔진 상태 — Colyseus 스키마가 아닌 일반 객체. 방(game-server)이 틱(또는 윈도)마다 스키마로 복사한다.
// 원본: PIKIT-GameServer/src/rooms/schema/WorldState.ts (BlockState, PickaxeState)
// ──────────────────────────────────────────────────────────────────────────

/** 바둑판 칸 하나 (링버퍼 슬롯). health ≤ 0 이면 빈 칸. */
export interface BlockState {
  kind: number;     // catalog.blocks 위치 (0 Dirt … 9 Diamond · 10 CHOG Ore · 11 Golden CHOG)
  x: number;        // 그리드 X
  y: number;        // 그리드 Y (스크롤 진행 시 증가). 링버퍼 슬롯에 옛 줄이 남아 있을 수 있어 y로 대조한다
  health: number;   // 남은 체력. (규칙 12) 2×2 네 칸은 늘 같은 값(묶음 체력, 시작 = 4 × hp — physics.ts mirrorQuad)
  quad: number;     // (규칙 12, 명세 25 §3.4.3) 0 = 1칸, 2×2면 1 왼쪽 위(앵커) · 2 오른쪽 위 · 3 왼쪽 아래 · 4 오른쪽 아래 (판 생성이 붙인다)
}

/** 떨어지는 곡괭이 하나 (플레이어 또는 시스템 봇) = 구매 1건. */
export interface PickaxeState {
  // ── 정체
  key: string;               // 곡괭이 번호: 플레이어 "구매ref:항목순번", 봇 "bot:i"
  owner: string | null;      // 주인 주소, null = 시스템 봇(보상 없음, 내구도 없음, 표적 없음)
  tier: number;              // 플레이어 곡괭이 = catalog.pickaxes 위치, 봇 = catalog.bots 위치 (D104)
  priceMilli: number;        // 산 가격 (밀리크레딧)

  // ── 물리
  x: number;
  y: number;
  vx: number;                // 틱당 속도
  vy: number;
  angle: number;             // 화면용 회전 (rad)
  vAngle: number;
  scale: number;             // 지름 (카탈로그 값)
  attack: number;            // 공격력 (카탈로그 값)
  frictionPerTick: number;   // 미리 계산한 마찰 상수 (Math.pow 없음)

  // ── 내구도·시간 (정수 틱, 벽시계 없음)
  durabilityTotal: number;   // D (봇은 0 = 무제한으로 취급). (규칙 11·12) 아이템 LIFE가 ⌊D × durabilityBps / 10⁴⌋씩 늘린다(남은 것도 같이)
  durabilityLeft: number;
  spawnTick: number;
  lastDamageTick: number;    // 멈춤 판정 (stuckTicks 동안 피해 0이면 비정상 종료)

  // ── 보상 상태 (규칙 7, D137 — 재접속·재시작 때 반드시 함께 저장)
  luckyKind: number;         // LUCKY 종류 (판에 놓일 때 `lucky|<키>`로 뽑음). 봇은 −1
  luckyMultBps: number;      // (규칙 12 개정 2) LUCKY 배수 bps (판에 놓일 때 `luckymult|<키>`로 뽑음, 사다리 없으면 10,000). 봇·대기열은 0
  baseMilli: number;         // 지금까지 번 기본 수익 (β_t × 값 × 피해, 정수 밀리크레딧)
  carryMilli: number;        // 기본 수익의 버린 소수 이월 (0 ≤ carry < 1 밀리크레딧)
  luckyMilli: number;        // 지금까지 번 LUCKY 몫 (행운 종류에 준 피해, 정수 밀리크레딧)
  luckyCarryMilli: number;   // LUCKY 몫의 버린 소수 이월
  bonusMilli: number;        // 지금까지 받은 보너스 (POP + BIG POP — 규칙 11은 COMBO 단계 상금의 합, 정수 밀리크레딧, ≤ bonusCap × 1000)
  touched: number[];         // 이 곡괭이가 처음 닿은 블록 칸 키 (y × width + x) — "새 블록" 판정
  popPrevKind: number;       // 직전 새 블록의 종류 (−1 = 없음)
  popDone: boolean;          // POP 받음 (곡괭이당 1번). (규칙 11 COMBO) s = 2 사건(POP)이 한 번이라도 났음
  bigDone: boolean;          // BIG POP 받음 (곡괭이당 1번). (규칙 11 COMBO) s ≥ 3 사건(BIG_POP)이 한 번이라도 났음
  streakKind: number;        // 지금 연속 중인 종류 (새 블록 기준, −1 = 없음)
  streakLen: number;         // 같은 종류 새 블록 연속 길이 (2 = POP, 3 = BIG POP — 규칙 11 COMBO는 s ≥ 2마다 한 단계)
  bonusEvents: BonusEvent[]; // 보너스 사건 (추가만) — 히스토리 events[]와 피드의 원본. (규칙 11) COMBO 단계마다 POP(s = 2)·BIG_POP(s ≥ 3) 1건
  lastHitMilli: number;      // (규칙 9) 지금까지 받은 막타 몫 (정수 밀리크레딧, ≤ 가격 × lastHitCapBps ÷ 10,000)
  lastHits: number;          // (규칙 9) 막타 횟수 (한 방에 못 깨는 블록을 깬 수 — 상한에 걸려 0을 받은 것 포함)
  // ── (규칙 10, 명세 23 §3·§4) LUCKY PICK · 골든 CHOG 잭팟
  pickLevelBps: number;      // LUCKY PICK 바닥 배수(bps, 0 = 없음) — 판에 놓일 때 `pick|<키>`로 뽑음. 봇·대기열은 0
  goldenHits: number;        // J를 받기 전 잭팟 종류 블록 타격 수(통 미달로 뽑지 않은 타격도 센다) — 균열 스트림 `crack|<키>|<n>`의 n
  jackpotMilli: number;      // 받은 잭팟 J(밀리, 0 = 없음 — 곡괭이당 1번, 총상한 밖)
  // ── (규칙 11, 명세 24 §3.8·§4.2·§4.3) COMBO 성장 · 아이템(규칙 12 — 막타 룰렛). 봇·카탈로그에 buffs가 없으면 처음 값 그대로(0 · 0 · 0 · 0 · 10,000 · 몸 지름 · 0 · −1 · 0)
  popStacks: number;         // 성장 단계: COMBO 단계(같은 종류 새 블록 연속 s ≥ 2)마다 +1, ≤ buffs.growMaxStacks
  buffCount: number;         // (규칙 12) 받은 아이템 수(막타 뽑기에서 당첨된 수 = 사건 n), ≤ buffs.items.maxPerPickaxe
  giantUntil: number;        // GIANT가 끝나는 틱(0 = 없음, > 0 = 켜짐). 그 틱이 끝날 때 지운다
  speedUntil: number;        // SPEED가 끝나는 틱(0 = 없음, > 0 = 켜짐)
  gravityMulBps: number;     // 이 몸의 중력 배수(10,000 = ×1). SPEED 동안 그 버프의 gravityBps
  scaleTarget: number;       // 버프 크기 목표 = max(몸 지름, min(catalogScaleCap, 몸 지름 × (10⁴ + popStacks × growStepBps)/10⁴ × (GIANT면 scaleBps/10⁴))).
                             // 지름(scale)은 하늘 효과와 같은 길(stepScales → tryGrow)로 틱마다 이 값(하늘 효과 중이면 그것과의 큰 쪽)을 따라간다
  // ── (규칙 12, 명세 25 §3.3) 막타 룰렛: 뽑은 틱 t₀에 결과를 정하고 t₀ + rouletteTicks 틱에 적용(buffs.ts resolveItems). 그동안 끝나지 않는다(유예)
  itemUntil: number;         // 룰렛이 멈추는(아이템을 적용하는) 틱 (0 = 대기 없음). 불변식: 0 ∨ tick < itemUntil ≤ tick + rouletteTicks
  itemKind: number;          // 대기 중인 아이템 = buffs.items.table 위치 (−1 = 없음)
  itemAngle: number;         // 대기 중인 DASH의 각도 (rad, 셋째 수 × 2π — 그 밖은 0)

  // ── 통계 (히스토리 1행)
  hits: number;
  blocksBroken: number;
}

/**
 * 보너스 사건 1건 (protocol BonusEventSummary와 같은 모양). 상한 때문에 paidMilli < prizeMilli일 수 있다(0도 가능).
 * 그 등급 상금이 0이면 사건을 만들지 않는다.
 */
export interface BonusEvent {
  kind: BonusEventKind;
  tick: number;
  window: number;
  blockKind: number;         // 사건을 일으킨 블록 종류
  streakCount: number;       // 그 순간 같은 종류 새 블록 연속 길이
  prizeMilli: number;        // 규칙상 상금
  paidMilli: number;         // 상한 적용 후 실제 지급
}

/** 대기열 항목 (아직 스폰되지 않은 곡괭이). */
export interface QueueItem {
  key: string;
  owner: string;
  tier: number;
  priceMilli: number;
  seq: number;               // 방 전체에서 들어온 순번 (스폰 순서 동률 규칙)
}

/** (지갑, 방)마다 하나. 살아 있는 곡괭이는 항상 최대 1개. */
export interface OwnerSlot {
  owner: string;
  queue: QueueItem[];
  activeKey: string | null;
  nextSpawnWindow: number;   // 앞 곡괭이가 끝난 윈도 e → e + 1 (규칙 12: 대기열이 남아 있으면 + limits.queueGapWindows)
}

/**
 * 곡괭이 1개의 정산 값 (규칙 7, D137 — 체인 `settleEnd` 한 번). 엔진이 정하고, 게임 서버가 DB settlement 행으로 남기고,
 * settler가 체인 settleEnd로 보낸다.
 *  REWARD = 정상 종료(DURABILITY): 번 것 E = 기본 + LUCKY + 보너스 + 막타(규칙 9)를 payoutMilli = min(E, REWARD 상한)과 overMilli = E − payoutMilli로 나눈다
 *           (체인이 payout ≤ tierCapsMilli, over ≤ tierOverCapsMilli로 막는다)
 *  (규칙 10) REWARD/END는 T = min(총상한, max(E, 바닥)) + J를 나눈다. 비정상 종료에 단계나 J가 있으면 REWARD/ABNORMAL_END(T = min(총상한, max(V, 바닥)) + J)
 *  REFUND = 비정상 종료 min(P, E + u·P) · 취소 · 넘침 · 동결/방 닫힘 때 대기열 100% (체인이 가격으로 막는다), overMilli = 0
 * 곡괭이 하나는 정확히 1건을 낸다. 무효(VOID)로 없어진 곡괭이는 정산이 없다(체인 refundUnprocessed가 가격 100%를 돌려준다). 봇은 정산이 없다.
 */
export interface EnginePayout {
  key: string;               // "<purchaseId>:<itemIndex>"
  owner: string;
  tier: number;
  priceMilli: number;
  kind: "REWARD" | "REFUND";
  cause: "END" | "ABNORMAL_END" | "CANCEL" | "OVERFLOW" | "QUEUE_REFUND";
  payoutMilli: number;
  overMilli: number;
  window: number;
  tick: number;
}

/** 곡괭이 1개가 끝났을 때의 결과 (히스토리 1행의 엔진 쪽 값). */
export interface PickaxeResult {
  key: string;
  owner: string;
  tier: number;
  priceMilli: number;
  spawnTick: number;
  endTick: number;
  endWindow: number;
  endReason: EndReason;
  hits: number;
  distinctBlocks: number;
  blocksBroken: number;
  durabilityUsed: number;
  durabilityTotal: number;
  pop: boolean;
  bigPop: boolean;
  events: BonusEvent[];
  luckyKind: number;
  luckyMultBps: number;
  baseMilli: number;
  luckyMilli: number;
  bonusMilli: number;
  lastHitMilli: number;      // (규칙 9) 막타 몫
  lastHits: number;          // (규칙 9) 막타 횟수
  paidMilli: number;         // 정산 payoutMilli (VOID는 0, 정산 없음)
  overMilli: number;         // 정산 overMilli (REWARD만, 그 밖 0)
  pickLevelBps: number;      // (규칙 10) LUCKY PICK 단계(bps, 0 = 없음)
  pickMilli: number;         // (규칙 10) 사다리 보충 = T_main − min(X, 총상한) (≥ 0, VOID·REFUND는 0 · 규칙 11 wholeCredits: max(0, 내린 T_main − min(X, 총상한)))
  jackpotMilli: number;      // (규칙 10) 받은 잭팟 J (VOID면 통으로 돌아가 0)
}

/** 입력이 효과를 내지 못한 경우 (재생 결과에 남긴다 — 서버 재량이 아니라 규칙 결과임을 보이기 위함). */
export interface RejectedInput {
  window: number;
  index: number;
  reason: "BAD_TIER" | "TOO_MANY_TIERS" | "NOT_QUEUED" | "ALREADY_VOID";
}

/** 2,000블록 묶음 하나가 다 만들어졌을 때 (앵커의 boardBatchRoot·묶음 생성 검사 재료). rowWindows[i] = 줄 200j + i를 만든 윈도. */
export interface CompletedBatch {
  batchIndex: number;
  kinds: number[];        // 2,000개, 줄 순서 × 칸 순서
  rowWindows: number[];   // 200개
}

/** 방 하나의 전체 상태. 이 객체를 직렬화한 바이트의 해시가 상태 해시다. */
export interface RoomState {
  roomId: number;              // 체인 방 번호 (방 상태 루트에 쓴다)
  tick: number;                // 실제로 돈 틱 수 (멈춘 윈도는 세지 않음)
  window: number;              // 마지막으로 처리한 윈도 (−1 = 아직 없음)
  scrollY: number;             // 카메라 중심 y
  generatedRowCount: number;   // 생성된 줄 수 (0줄부터)
  blocks: BlockState[];        // 링버퍼 (width × height × multiplier)
  batchIndex: number;          // 지금 묶음 번호 (−1 = 아직 없음)
  batchRemaining: number[];    // 지금 묶음에 남은 종류별 개수
  batchKinds: number[];        // 지금 묶음에서 지금까지 꺼낸 종류 (줄 순서 × 칸 순서, 다 차면 CompletedBatch로 내보내고 비움)
  batchRowWindows: number[];   // 지금 묶음의 줄마다 그 줄을 만든 윈도
  pickaxes: PickaxeState[];    // 봇 먼저, 그다음 판에 들어온 순서
  owners: OwnerSlot[];         // 처음 들어온 순서
  queueSeq: number;            // 다음 대기열 순번
  results: PickaxeResult[];    // 끝난 곡괭이 (추가만, 보관 기간이 지난 앞부분은 정리 규칙이 지운다)
  rejected: RejectedInput[];   // 효과 없는 입력 (추가만, 〃)
  voidedRefs: string[];        // 무효 처리된 MON 구매 ref (같은 구매를 두 번 무효로 하지 않음, 정리하지 않음 — 예외 상황에서만 생김)
  prunedResults: number;       // 지금까지 정리로 지운 results 개수 (절대 순번 = prunedResults + 배열 위치)
  prunedRejected: number;
  sky: SkyState;               // (D125) 하늘 이벤트 상태 (규칙 7: 카탈로그에 skyEvent가 늘 있다)
  jackpot: JackpotState;       // (규칙 10, 명세 23 §4.1) 골든 CHOG 잭팟 통 — 처음 0, 카탈로그에 jackpot이 없으면 늘 0
}

/** (규칙 10) 방의 잭팟 통. 불변식 contributedMilli = poolMilli + paidMilli. 늘어나는 곳 = 플레이어 곡괭이 소환, 줄어드는 곳 = 균열. */
export interface JackpotState {
  poolMilli: number;           // 지금 통
  contributedMilli: number;    // 지금까지 소환 때 더한 합
  paidMilli: number;           // 지금까지 균열로 준 합 (VOID로 돌아온 J는 뺀다)
  wins: number;                // 균열(당첨) 수 (VOID로 돌아온 것은 뺀다)
}

/** 하늘 이벤트 상태 (방에 하나, D125). */
export interface SkyState {
  item: SkyItem | null;        // 떨어지는 중인 별 (최대 1개)
  nextWindow: number;          // 이 윈도부터 새 별이 떨어질 수 있다 (쿨다운 끝)
  boosts: SkyBoost[];          // 커지기 효과를 받는 중인 곡괭이 (잡은 순서)
}

/** 떨어지는 별 = 작은 원 몸 (원 몸 물리, 블록 피해 없음, 다른 몸과 충돌 없음). id = 떨어진 윈도 번호 (방 안 유일). */
export interface SkyItem {
  id: number;
  x: number;
  y: number;
  vx: number;
  vy: number;
  angle: number;
  vAngle: number;
  scale: number;               // 지름 (카탈로그 skyEvent.item.diameter)
  frictionPerTick: number;     // (카탈로그 skyEvent.item.frictionPerTick — 원 몸 물리가 읽는다)
  dropTick: number;            // 나타난 방 틱
  ticks: number;               // 지금까지 보낸 틱
}

/** 커지기 효과를 받는 곡괭이 하나. untilTick부터 원래(등급) 지름으로 돌아가고, 다 돌아가면 지운다. */
export interface SkyBoost {
  key: string;
  untilTick: number;
}
