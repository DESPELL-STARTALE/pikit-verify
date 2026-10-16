# @pikit/engine — 결정론 게임 엔진

곡괭이 물리, 판(블록 링버퍼와 2,000블록 묶음), 보상(블록 값 × 피해·POP·BIG POP·LUCKY·상한, 보너스 사건 — 규칙 7, D137·`docs/specs/16-rules7.md`. 황금 입구는 규칙 7에서 삭제), 대기열, 비정상 종료 값, 상태 정리를 계산하는 순수 TypeScript 패키지다. **런타임 의존성은 `@pikit/protocol`(카탈로그 공식·HMAC·입력 규칙 상수) 하나, Node·브라우저 API 0개.** 같은 규칙표 + 같은 시드 + 같은 입력이면 어디서 돌려도 비트 단위로 같은 결과가 나온다(`docs/determinism.md`).

## 무엇을 어디서 옮겼나

| 엔진 파일 | 원본 | 바꾼 것 |
|---|---|---|
| `src/physics.ts` | `PIKIT-GameServer/src/physics/physics.engine.ts` + `docs/engine-safe-growth.patch` | 관통 방지 패치 중 서브스텝 ≤ 0.45칸, 가장 깊은 겹침부터 최대 4회, 중심이 블록 안이면 들어온 쪽으로(크기 키우기·gravityScale·드릴은 버프와 함께 D99에서 삭제 — 크기는 카탈로그 값 그대로). `Math.random` → 주입된 Rng, `Math.pow` → 곡괭이별 `frictionPerTick`, 피해는 남은 내구도까지. TNT 제거. **히트박스(D70)**: 카탈로그 `pickaxes[].hitbox`가 `circle`이면 옛 경로 그대로, `pickaxe`이면 손잡이 캡슐 + 머리 원이 `angle`로 도는 강체(`advanceRigid`: 캡슐/원–블록 겹침 `capsuleBlockContact`, 벽 포함 깊은 겹침부터 밀기, 접촉점 충격으로 회전·마찰, 머리 쪽으로 도는 힘, 회전 킥, 머리만 피해, 회전 포함 서브스텝 ≤ min(0.45, 손잡이 반지름)). 화면이 쓰는 `hitboxPrimitives` |
| `src/trig.ts` | 새로 작성 (D70) | 결정론 `detSin`·`detCos`·`detSinCos`(Cody–Waite 범위 줄이기 + 고정 테일러 다항식, + − × ÷와 `Math.round`만) |
| `src/types.ts` | `src/rooms/schema/WorldState.ts`(BlockState, PickaxeState) | Colyseus 스키마 대신 일반 객체. 내구도, 이월, 보상 상태(처음 닿은 블록, 새 블록 길·타격 길 끝부분, POP, 패턴별 맞은 위치, 연속 길이, 받은 보너스, 보너스 사건), 정수 틱, 정리 개수 추가 |
| `src/room.ts` | `src/rooms/World.ts`의 틱 순서(`update`, `updatePickaxeCollection`, 스폰 재배치), `src/item/item.model.ts`(초기값) | 블록 시계(윈도 1개 = 9틱), (정리) → 입력 → 스폰 → 틱 순서, 틱 안에서 곡괭이마다 물리 → 보상, 대기열(지갑당 1개 + 대기 10개), 정산. 벽시계·접속자·DB 덱·Colyseus 방은 옮기지 않음 |
| `src/board.ts` | `World.ts` 링버퍼 + BE 블록 생성 | 동기식 2,000블록 묶음, 줄마다 `row|y` 비복원 추출 |
| `src/reward.ts` | `_analysis/sim-route/rledger.ts`(참조 장부 모형) | 기본 수익 β·v·피해(밀리크레딧 버림 + 곡괭이별 이월 + 천장 가드), 보너스 상태 기계(POP, 카탈로그 `reward.patterns` 순서 패턴, `reward.streakEscalation` "연속!"), 곡괭이별 상한, 비정상 종료 min(P, E + u·P) |
| `src/prune.ts` | 새로 작성 (D68) | 200윈도마다 4,000윈도보다 오래된 결과·거절·장부 줄과 쉬는 지갑 칸을 앞에서 지우고 개수를 센다(규칙의 일부 → 해시가 어디서나 같음) |
| `src/rng.ts` | 새로 작성 | xoshiro128**, 이름표별 스트림(HMAC 주입), 윈도 키 메시지 |
| `src/window-rng.ts` | D161 (검증기에서 옮김) | 윈도 스트림 `windowRngFactory`·`lazyWindowRng` (HMAC = protocol `hmacSha256`) |
| `src/input-schedule.ts` | D161 (검증기에서 옮김) | 체인 사건 → 엔진 입력 → 윈도: `linkedInputs`·`freezeStarts`·`InputScheduler`·`carryAfter` |
| `src/serialize.ts` | 새로 작성 | 상태 → 바이트(빅엔디언 double, NaN 금지). 해시는 밖에서 |

## 쓰는 법 (서버·검증기 쪽)

```ts
import { addRoom, createLedger, createRoom, createStreamFactory, runWorldWindow, serializeLedger, serializeRoom, windowKeyMessage } from "@pikit/engine";
import { hmacSha256 as hmac } from "@pikit/protocol";

// 윈도 키: K(ρ, w) = HMAC-SHA256(S_{e(w)}, "PIKIT/win/v2" ‖ chainId ‖ shop ‖ ρ ‖ w ‖ blockhash(w))
const rngFor = (w: number) => (roomId: number) => createStreamFactory(hmac, hmac(seedOfEpoch(w), windowKeyMessage(chainId, shop, roomId, w, blockHash(w))));
const world = { ledger: createLedger(), rooms: [] };                       // 공유 장부 1개 + 방 여러 개 (D37)
addRoom(world, { roomId: 1, catalog, state: createRoom(catalog, rngFor(W)(1), 1, W) });
for (const w of windows) runWorldWindow(world, w, ledgerInputsOf(w), roomInputsOf(w), rngFor(w));   // 확정 블록마다 1번
const roomHash = sha256(serializeRoom(world.rooms[0].state)), ledgerHash = sha256(serializeLedger(world.ledger));
```

윈도 규칙 (`runWindow`, 규칙 7 — D137, 황금 입구 삭제):

1. 입력 적용(블록 w−1의 체인 이벤트 + 동결·무효 줄, 기록 순서 그대로). 윈도 번호가 200의 배수면 그 전에 오래된 기록 정리(`prune.ts`).
2. 스폰: 살아 있는 곡괭이가 없고 `nextSpawnWindow ≤ w`인 지갑의 대기열 맨 앞(대기열 순번 순). 곡괭이는 바로 판에 놓인다(`spawn|<키>` 스트림 x,
   카메라 위 `spawnOffsetRows`).
3. ~~멈춤: 플레이어 곡괭이가 없으면 틱 없음(봇도 멈춤)~~ — **D94에서 삭제.** 플레이어가 없어도 봇 3개와 틱은 윈도마다 돈다(아레나는 쉬지 않는다). `ticksRun`은 늘 `ticksPerWindow`.
4. `ticksPerWindow`(9)틱: 곡괭이마다 물리 → 깊이 제한 → 피해·보상 / 끝난 곡괭이 정산 / 카메라 / 줄 생성.
   (다이내믹 버프는 D99에서, 순서 패턴·"연속!"은 규칙 7에서 지웠다. 족보는 POP·BIG POP뿐, LUCKY 블록은 카탈로그 값.)

정산(`EnginePayout`): 곡괭이마다 끝 정산 **1번**(체인 `settleEnd` 한 호출, 개정 6). 정상 종료(REWARD)는 번 것 E를 `payoutMilli` = min(E, REWARD 상한 = 가격 × 0.9)과
`overMilli` = E − payoutMilli(가격을 넘는 몫, ≤ 등급 over 상한)로 나눈다. 비정상 종료는 REFUND min(P, E + u·P), 취소·넘침·동결 대기열은 REFUND 100%, REFUND의 over는 늘 0.
E = 기본 + LUCKY + 보너스(POP·BIG POP) + 막타(규칙 9: 한 방에 못 깨는 블록을 깨면 `reward.lastHitMult` × 그 한 대, 곡괭이당 ≤ 가격 × `lastHitCapBps`,
윈도 결과 `lastHits[]` → 피드 `LAST_HIT`) — 몫을 손으로 더하지 말고 `earnedMilli`를 쓴다. 상태 직렬화 태그 `PIKIT/state/v10`.

건너뛴 윈도는 입력도 틱도 없다(봇도 그 윈도를 건너뛴다). 그래서 재생기(game-server·verifier)는 윈도를 빠짐없이 부른다.

윈도 w의 순서(`runWorldWindow`): 방들을 roomId 오름차순으로 `runWindow`(입력 → 스폰 → 9틱). 옛 공유 장부(바우처·금고 nonce, D54)는 개정 3에서 없앴다 — 잔액은 체인(`PikitShop`)에 있다. `hmac`은 HMAC-SHA256 함수를 주입한다(엔진은 의존성 0개). 완성된 예는 `packages/verifier/src/epoch.ts`와 `replay.ts`.

엔진 버전 해시 `engineVersionHash()` = keccak256(`<package version>+<소스 해시>`)는 빌드 때 `scripts/emit-build-info.mjs`가 `src/build-info.ts`에 적는다(lint가 최신인지 검사). 소스 해시는 `src/**/*.ts`와 엔진이 실행 중에 쓰는 protocol 파일(`catalog`·`crypto`·`eip712`·`input-log`·`timers` + 상대 import 닫힘)을 덮고, 엔진이 그 밖의 protocol 값을 가져오면 build가 실패한다(D161). 체인 rulesHash = keccak256(canonicalHash(카탈로그) ‖ engineVersionHash()).

## 테스트

| 묶음 | 내용 |
|---|---|
| `test/physics.test.ts` | 원본 곡괭이 물리 테스트 + 관통 방지(크기 키우기·드릴 시험은 D99에서 삭제) + 내구도 (원 몸, 원본 TNT 테스트 6개는 TNT가 없어져 옮기지 않음) |
| `test/hitbox.test.ts` | 곡괭이 몸: 모양·회전 방향, 원 안에 들어감, 스키마 거부, 겹침 법선(원·가로 손잡이·모서리·블록을 지나는 선분·떨어짐), 여러 각도로 떨어져도 블록 속에 남지 않음, 비켜 맞으면 돎(거울상은 반대), 가운데로 떨어지면 안 돎, 머리만 피해·`handleDamage`, 벽, 머리 쪽으로 도는 힘, 회전 킥, 결정론 |
| `test/trig.test.ts` | `detSinCos`: Math.sin 대비 1e-11, −0 없음, 대칭·주기, `node`와 `node --jitless`가 입력 20만 개에서 같은 비트(고정 다이제스트) |
| `test/bonus-patterns.test.ts` | 순서 패턴(스트레이트, 거꾸로 불일치, 끼어든 블록), newBlocksOnly 참/거짓, 곡괭이당 1번, 겹침 금지, 등급 상금 0, POP만, "연속!" 상금과 상한, 무작위 시드에서 Σ 사건 지급 = 보너스 ≤ 상한, 결정론, 카탈로그 검사 |
| `test/rng-reward.test.ts` | xoshiro128** 참조값, 스트림 독립성, UTF-8, 기본 수익·이월, POP, 흙길 패턴·상한, 다이아만 쳐도 천장 이하, 하우스 안전 공식(< 0.97 × 가격), 봇 무보상, 비정상 종료 값 |
| `test/prune.test.ts` | 정리 규칙: 지운 개수 + 남은 개수 = 전부, 보관 기간 안은 안 지움, 정리 경계를 넘는 복원 결정론, 앞부분만 지움(남은 바이트 그대로), 쉬는 지갑 칸, 오래 돌아도 크기가 커지지 않음 |
| `test/room.test.ts` | 대기열·스폰·넘침·크레딧/프로모 구매·취소·동결·멈추지 않음(플레이어 없이도 봇이 9틱, D94) / 결정론(두 번 실행, 다른 시드, 스냅샷 복원, `--jitless`) / 불변식 퍼징(24시드) |
| `test/ledger-world.test.ts` | 공유 장부·세계 순서, 바우처, creditsToUse·SHORT_CREDIT, 무효 구매, 묶음 다시 뽑기, 엔진 버전 해시 |

### 밸런스 대조 (`pnpm --filter @pikit/engine balance`)

`test/tools/balance.ts`가 실제 엔진을 시드 여러 개로 돌려(작업자 스레드로 나눠서) 환수율·POP·수명(평균·중앙값·p10)·최대 지급을 표로 낸다.

```bash
pnpm --filter @pikit/engine build
pnpm --filter @pikit/engine balance --seeds=200                      # NORMAL, 쉬지 않는 플레이어 1명
pnpm --filter @pikit/engine balance --seeds=200 --catalog=normal     # normal | <카탈로그 JSON 경로> (출시 카탈로그는 NORMAL 하나, D104)
pnpm --filter @pikit/engine balance --seeds=40 --windows=2000 --skilled   # 숙련자(가장 좋은 5%·1% 순간) 오라클, 수 분
pnpm --filter @pikit/engine balance --seeds=200 --pickaxes=50 --gap=120   # 띄엄띄엄 오는 플레이어(곡괭이가 끝나면 평균 120초 쉼), 시드마다 곡괭이 50개
# 그 밖: --windows=4000 --players=1 --every=20 --workers=N --gapdist=exp|fixed --attack=a0,a1,a2,a3,a4
```

황금 입구 시절(규칙 5~6) 입구 확률표 도구(`gate-calibrate`)와 그 결과(`docs/golden-gate-balance.md`)는 규칙 7(D137)에서 입구와 함께 지웠다 — 문서는 기록으로만 남는다.

`--gap`(초)·`--gapdist`: 플레이어가 곡괭이가 끝난 뒤 쉬는 시간(지수분포 평균 또는 고정). 쉬는 동안 봇은 계속 판다(D94). `--gap=0`(기본)은 쉬지 않는 플레이어로 옛 측정과 같다. `--pickaxes=N`: `--windows` 대신 시드마다 플레이어 곡괭이 N개가 끝날 때까지. `--attack`: 등급별 공격력을 덮어써 재조정을 시험한다(봇도 같이 바뀜, 카탈로그 파일은 그대로). 표에는 `pre-damaged`(곡괭이가 처음 닿은 블록 중 스폰 때 이미 깎여 있던 비율)와 Σ지급/Σ가격의 표준오차 줄이 붙는다. D94 측정 결과는 `docs/arena-never-sleeps-experiment.md`.

`--skilled`: 일반 플레이어 방을 돌리다 `every` 윈도마다 멈추고, 등급마다 "지금 사면"을 24번 굴려 본다(앞으로의 줄·튕김 무작위만 바꾸고 화면의 판은 그대로). 앞 16번 평균 = 추정, 뒤 8번 평균 = 측정. 등급마다 추정 상위 5%(S5)·1%(S1) 순간의 측정 평균이 숙련자 환수율, κ = S5 ÷ 아무 순간.

**버프 삭제(D99, 2026-10-10) 전 → 후**는 `docs/no-items-balance.md`(환수율 ±0.002, 수명 +39%, POP +2.3%p — 카탈로그 값은 그대로).

기록: 2026-10-06 곡괭이 히트박스 재밸런스(D73) 전 → 후 (NORMAL, 시드 200 × 4,000윈도, 봇 BM×3, 버프 전체 — 버프는 그 뒤 D99에서 삭제):

| 등급 | 환수율 | POP | 수명 평균 (중앙값) | 최대 | POUND / 곡괭이 |
|---|---|---|---|---|---|
| FE | 0.798 → 0.796 | 61.9% → 62.5% | 16.3 (16.4) → **23.0 (22.9)초** | 0.922 → 0.914 | 1.37 → 0.36 |
| FC | 0.815 → 0.811 | 74.8% → 74.0% | 21.4 (21.2) → 25.5 (25.2)초 | 0.910 → 0.898 | 1.69 → 0.36 |
| VD | 0.811 → 0.809 | 80.3% → 79.4% | 24.2 (23.9) → 28.5 (27.5)초 | 0.893 → 0.886 | 2.01 → 0.41 |
| WB | 0.812 → 0.812 | 82.0% → 83.0% | 25.6 (24.3) → 29.8 (28.6)초 | 0.892 → 0.885 | 2.17 → 0.53 |
| BM | 0.809 → 0.812 | 80.6% → 85.4% | 26.4 (25.2) → 31.4 (30.1)초 | 0.889 → 0.882 | 2.18 → 0.66 |
| 전체 | **0.809 → 0.808** (Σ 0.810 → 0.810) | 75.9% → 76.8% | 22.8 → 27.6초 | **0.922 → 0.914** | 1.88 → 0.46 |

곡괭이당 효과(후): PUMP 0.65 · MEGA 0.08 · ROCKET 0.27 · DRILL 0.29 · SPLIT 0.31 · POUND 0.46. 비정상 종료 0. 숙련자 S5 0.838 → 0.833(κ 1.03 → 1.03, 시드 40 × 2,000윈도). HARDCORE 0.812 → 0.810, 수명 FE 10.8 → 17.3초 … BM 17.9 → 23.0초. LITE = NORMAL과 같은 표(값 ÷10).

테스트 전에 `scripts/check-forbidden.mjs`가 엔진 소스에서 `Math.random`, `Math.pow`, `**`, 초월함수, `Date`, Node API를 찾는다.

```bash
pnpm --filter @pikit/engine build
pnpm --filter @pikit/engine test
```
