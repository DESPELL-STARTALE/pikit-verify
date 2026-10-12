# @pikit/verifier — 재생 검증기

규칙표(카탈로그) + 입력 기록(시드 포함)을 공개 엔진(`@pikit/engine`)으로 다시 돌려 **끝 상태 해시**와 **곡괭이별 정산 값**을 낸다. "누구나 결과를 다시 계산해 볼 수 있다"의 최소 구현이고, 게임 서버·감시 봇·검증 CLI·(나중에) 웹 검증 화면이 같은 함수를 쓴다.

```ts
import { replay } from "@pikit/verifier";
const report = replay(catalogJson, inputLogJson);
report.finalStateHash;   // 0x… (SHA-256 of serializeRoom)
report.pickaxes;         // 곡괭이별: 끝난 이유, 가격, 기본 수익, 보너스, 지급
report.payouts;          // 엔진 정산 전부, 곡괭이마다 1건 (REWARD/REFUND, 원인, payoutMilli, overMilli, window = 끝 윈도, purchaseId·itemIndex) — 체인 settleEnd와 대조할 값
```

검사하는 것: 형식(zod), 입력 기록의 `rulesHash`가 규칙표의 정규 JSON 해시와 같은지(다르면 재생 거부), 윈도 순서.

v0(`replay`)는 방 하나·시드 하나 형식(`pikit.inputlog/v0`)으로 골든 시험에 쓴다. 끝 상태 해시 = SHA-256(serializeRoom). 개정 3: 잔액은 체인(개정 5: PikitShop)에 있어 엔진에 공유 장부가 없다.

## 에폭 검증 (`verifyEpochs`, D37~D43, D111)

세계 목록(`WorldManifest`) + 카탈로그 + 에폭 입력 기록 v3(1…N) + 체인 값(`ChainSource`, `pikit.chain/v3`)으로:

| 검사 | 내용 |
|---|---|
| 엔진·규칙 | 내 엔진의 `engineVersionHash()` = 세계 목록의 값, keccak256(catalogHash ‖ engineVersionHash)가 체인에 올라간 rulesHash(`rulesHashes`, 필수). 세계 목록의 shop·chainId·genesisBlock·seedRoot = 체인 값 |
| 입력 = 체인 사건 (`LINKAGE_CHECK`, H-1) | 체인의 `Purchased`·`CancelRequested`(항목마다)·`PurchasesVoided`(구매마다)·동결 시작마다 공개 기록에 입력이 정확히 하나, 정해진 윈도(블록 b → 윈도 b + 1, 방-윈도 100개 상한을 넘으면 순서 그대로 다음 윈도)에 같은 값으로 있고, 체인에 없는 입력은 없어야 한다(`linkage.ts`). 하나라도 어긋나면 실패: `MISSING`·`WINDOW`·`FIELDS`·`ORDER`·`EXTRA`·`DUPLICATE`, 규칙 위반 `OUTSIDE_WORLD`·`BEFORE_ROOM`·`RULES`·`UNKNOWN_PURCHASE`. 체인 값이 블록 (마지막 윈도 − 1)까지 빠짐없어야 한다(`chain data covers the replayed windows`) |
| 시드 사슬 | 에폭마다 S_e가 S_{e−1}로 keccak 한 번에 내려가 S_0(체인 `seedRoot`)까지 이어짐 |
| 입력 기록 | 파일마다 `prevHead`가 앞 파일 `head`와 같고, 줄을 다시 해시하면 `head`가 나옴 |
| 세계 재생 | 윈도마다 방 roomId 순. 윈도 키 = HMAC(S_{e(w)}, … ‖ 블록 해시(체인 값)) |
| 앵커 | 각 앵커의 `inputLogRoot`·`roomsStateRoot`·`boardBatchRoot`. 앵커의 `processedThrough` P는 "이벤트가 다 들어간 마지막 블록"이라 윈도 P + 1 뒤의 세계와 비교한다(D57) |
| 묶음 | 끝난 묶음마다 줄 윈도의 시드 + 블록 해시로 다시 뽑아 같은 2,000칸 |
| 파일 | 참조한 에폭 파일·시작 스냅숏이 없으면(`epochs[i] = null`) 실패 `FILES_CHECK`. 엔진 해시가 다르면 체인·파일을 읽기 전에 실패 |
| 스냅숏 시작 | `firstEpoch` > 1 + `snapshot`: 체인 앵커 k(processedThrough + 1 = 스냅숏 윈도)의 `roomsStateRoot`·`inputLogRoot` = 스냅숏, S_{E+1} → S_0. 증명 범위는 `docs/VERIFY.md` §3. 범위 고르기 `resolveRange`(`--epoch latest`·`--from-snapshot E\|latest`·`--purchase`) |
| 정산 | `checkSettlements` (규칙 7 §10): 체인 `Settled`(settleEnd, 곡괭이마다 한 칸)마다 같은 곡괭이의 재생 정산과 종류·`payoutMilli`·`overMilli`(0 포함)·지갑이 정확히 같은지(다르면 E12 `KIND`·`AMOUNT`·`BUYER`, 실패). 재생이 끝을 기록했는데 끝 윈도 + `SETTLE_STALL`(6,000블록)이 체인 값 끝 블록보다 앞서도록 settleEnd가 없으면 `OVERDUE` 실패, 무효 구매의 정상 종료(over > 0)는 `VoidOverPaid`(개정 6 `payOverAfterVoid`)와 대조 — 없이 max(끝 윈도, 무효 블록) + 6,000이 지나면 `VOID_OVER`, 금액·지갑이 다르면 `VOID_OVER_AMOUNT`, 대상이 아닌데 있으면 `VOID_OVER_EXTRA`(모두 실패). 재생에 정산이 없는 곡괭이(VOID·진행 중)의 체인 정산도 실패. 앵커 전에 정산된 뒤 무효가 된 구매(D93)는 재생 정산이 있는 곡괭이를 평소처럼 대조하고, 없는 곡괭이의 체인 정산만 `VOID_PURCHASE` 실패. 처리된 구매(가장 최근 앵커의 `processedPurchases` 아래)인데 체인 정산이 아직 없고 시한 전이면 `unsettled` 경고 |

체인(PikitShop.settleEnd)이 강제하는 것: REWARD ≤ 등급 상한(`tierCapsMilli`, 가격 × rewardCapBps), REFUND ≤ 가격, over ≤ 등급 over 상한·REWARD만, 곡괭이당 1번, Pending·Processed 구매만(Void·Refunded 거부, D93). 여기서 확인하는 것: 정확한 값(결정론 재생).

### 체인 값 출처 (`ChainSource`)

| 출처 | 믿는 것 | 쓰는 곳 |
|---|---|---|
| `RpcChainSource({ rpcUrls: [1~2곳], shop })` (`rpc-source.ts`) | RPC. 두 곳이면 모든 값을 두 곳에서 읽어 대조(다르면 `ChainDisagreement` → 검사 `AGREE_CHECK` 실패), 읽기는 두 곳 확정 머리 중 낮은 블록에 고정. 운영자가 준 파일은 믿지 않는다 | `pikit-verify verify --rpc a[,b]`, anvil e2e |
| `StaticChainSource(json)` | 파일(`chain.json`, `ChainFacts` = `pikit.chain/v3` + `voidOverPaid`) = 운영자가 준 값 | `pikit-verify verify --chain`, 시험 |

`ChainSource` = `head()` · `anchorAt(i)` · `purchaseBlock(id)` · `snapshot(need)` · `blockHashes(windows)`.

`RpcChainSource`가 읽는 것 (docs/fairness-chain-linkage.md §3):

1. `eth_chainId`. `PikitShop.fairness()`로 공정성 컨트랙트를 찾고 그 `shop()`이 같은 상점인지 확인한다. `genesisBlock()`·`seedRoot()`.
2. 확정 머리(`finalized`, 두 곳이면 낮은 쪽 = 기준 블록, eth_call은 그 블록으로). 사건은 블록 `[eventsFrom ?? genesisBlock, T]`에서 읽는다. T = 확정 머리(또는 `throughBlock` 중 작은 것). 확정 머리 < 마지막 윈도이거나 T < 마지막 윈도 − 1이면 오류다.
3. 상점·공정성 로그를 `logChunk`블록(기본 100)씩 읽는다. 범위 오류면 구간을 반으로 줄이고 그 크기를 기억한다. 구매·취소·정산(개정 6 `Settled` — kind 0 REWARD·1 REFUND, payoutMilli, overMilli)·`VoidOverPaid`·무효 구간·앵커(실린 블록 = `postedBlock`)가 나온다.
4. 방마다 `roomOf`의 rulesHash와 예약된 nextRulesHash. 체인에 없는 방은 건너뛴다.
5. 윈도 `[fromWindow ?? genesisBlock, 마지막 윈도]`의 블록 해시. 블록 k 하나를 읽으면 k와 parentHash(= k − 1)가 나와 요청 1번에 윈도 2개다. 동시에 `concurrency`(기본 16)개까지 읽는다.

속도 제한은 `limitedTransport`(`rpc-limit.ts`, game-server 블록 시계와 같은 것)다. 곳마다 초당 `maxRps`(기본 20)로 보내고, 429·-32005·-32007·시간 초과는 지수 백오프(Retry-After 존중, 최대 10초) 뒤 `maxRetries`(기본 6)번까지 다시 보낸다. 비용은 거의 블록 해시다(윈도 2개에 요청 1번).

만드는 쪽 참조 구현 `WorldProducer`(체인 흉내 `purchase`·`cancel`·`voidRange` → 윈도 돌리기 `step()`, 에폭 파일, 앵커 값 `anchor()`, settler 흉내 `settle()`(+ 무효 over `VoidOverPaid`), 에폭 끝 스냅숏 `snapshotFile()`, 체인 값 `chainSnapshot()`·`chainFacts()`)와 루트 함수(`worldStateHashes`, `roomsStateRoot`, `boardBatchRoot`, `commitBatch`)를 game-server·settler가 같이 쓴다. 윈도 난수 `lazyWindowRng`·입력 배치 `InputScheduler`는 `@pikit/engine`에 있다(D161).

## 아직 없는 것 (ROADMAP)

- 체인만으로 입력 재구성(운영자 파일 없이, 명세 17 P0-16 f)
- 규칙 버전이 바뀌는 방(카탈로그 교체) 재생
- 웹 검증 화면, 공개 저장소에서 입력 기록 내려받기

## 골든 재생 테스트

`test/fixtures/golden-1.log.json`(손으로 짠 입력 기록: 묶음 구매(결제 수단 칸 없음 — D107에서 지우고 골든을 다시 만듦), 취소, 대기열 넘침, 무효 구매, 방 닫힘, 블록 해시가 있는 윈도)을 재생해 `golden-1.expected.json`과 비교한다. `golden-2`는 하늘 별(D125)이 모두 나오는 바쁜 판, `golden-3`은 BIG POP·LUCKY 몫·over(1배 넘는 지급)가 나오는 짧은 판(규칙 7)이다. 엔진 규칙을 **일부러** 바꿨다면:

```bash
UPDATE_GOLDEN=1 pnpm --filter @pikit/verifier test   # 기대값 다시 쓰기 → 바뀐 이유를 커밋 메시지에
```
