# @pikit/verifier — 재생 검증기

규칙표(카탈로그) + 입력 기록(시드 포함)을 공개 엔진(`@pikit/engine`)으로 다시 돌려 **끝 상태 해시**와 **곡괭이별 정산 값**을 낸다. "누구나 결과를 다시 계산해 볼 수 있다"의 최소 구현이고, 게임 서버·감시 봇·검증 CLI·(나중에) 웹 검증 화면이 같은 함수를 쓴다.

```ts
import { replay } from "@pikit/verifier";
const report = replay(catalogJson, inputLogJson);
report.finalStateHash;   // 0x… (SHA-256 of serializeRoom)
report.pickaxes;         // 곡괭이별: 끝난 이유, 가격, 기본 수익, 보너스, 지급
report.payouts;          // 엔진 정산 전부, 곡괭이마다 1건 (REWARD/REFUND, 원인, payoutMilli, overMilli, window = 끝 윈도, purchaseId·itemIndex)
```

검사하는 것: 형식(zod), 입력 기록의 `rulesHash`가 규칙표의 정규 JSON 해시와 같은지(다르면 재생 거부), 윈도 순서.

v0(`replay`)는 방 하나·시드 하나 형식(`pikit.inputlog/v0`)으로 골든 시험에 쓴다. 끝 상태 해시 = SHA-256(serializeRoom). 개정 3: 잔액은 체인(개정 5: PikitShop)에 있어 엔진에 공유 장부가 없다.

## 세계 검증 — 개정 7 시간당 장부 루트 (`verifyLedger`, D205)

공개 CLI(`pikit-verify verify`)가 쓰는 것. 체인 `PikitLedger`의 루트 k(에폭 (직전 루트 epoch, 이 루트 epoch])마다 공개 파일만으로
명단 → 장부(A3 `LedgerReplayer`·`ledgerWindow`, 해시 안 규칙) → 엔진을 다시 돌려 루트 10칸을 만들고 `RootPosted`와 대조한다.

| 모듈 | 내용 |
|---|---|
| `ledger-verify.ts` | `verifyLedger({ world, catalogs, chain, read, trust, range, resume })` → `LedgerVerifyReport`. 검사 이름 `LEDGER_CHECK`(신뢰 뿌리)·`ROOT_CHECK`(루트마다, `rootCheckName(k, …)`)·`START_CHECK`(시작 경계). 범위 `resolveRootRange`(`last: k\|latest`, `from: j\|genesis`, 없으면 바로 앞 루트 = 루트 하나, `maxRoots`), 범위를 못 고르면 `VerifyRangeError`. 첫 실패 루트에서 멈춤, 체인·파일 읽기 오류는 던진다(CLI 전송 오류), RPC 불일치는 `AGREE_CHECK` 실패 + `disagreement` |
| `ledger-chain.ts` | `LedgerChainSource` = `world()`(불변값 + 기준 블록의 rootCount·announcer) · `root(k)` · `announcerChanges(from, to)` · `blocks(from, to, timestampWindows)` · `blockHashesAt(ws)` · `isValidSignature(wallet, hash, sig, block)`. `StaticLedgerSource`(파일 `pikit.ledger-chain/v1` = 운영자의 말), `announcerKeyAt`(창 w의 키 = fromWindow ≤ w인 마지막 교체의 next) |
| `ledger-rpc.ts` | `RpcLedgerSource({ rpcUrls: [1~2], ledger })` — 체인에서 바로, 두 곳이면 모든 값 대조. 루트 = `rootAt(k)` + 그 블록 하나의 `RootPosted`(처음부터 로그를 훑지 않는다), 불변값은 view(= `WorldCreated`), ERC-1271은 `isValidSignature`를 `erc1271Block`에서(6492는 안쪽 서명) |
| `state.ts` | 이어 받기 상태 v2 `VerifyState`(`pikit.verify-state/v2` = 마지막 루트 번호 + 그 칸), `nextVerifyState(report)`, `resumePoint(state)` |
| `agree.ts` | `ChainDisagreement`·`agree`·`AGREE_CHECK` (`RpcLedgerSource`가 쓴다) |

루트 k의 검사: 파일(`rootDataPaths`)·모양 → 시드 사슬 → 입력 기록 해시 사슬 → 명단 항목(entriesHash)·서명자(창마다 ANNOUNCE 키) → ERC-1271 세션 →
명단 창 블록 timestamp = 체인 → 윈도마다 `LedgerReplayer.window`(+ 엔진 `runWorldWindow`, 방은 createdWindow에 생성) → 묶음 생성 → 결정 = 파일 →
범위 밖 명단 없음 → `checkInputLinkage(ledgerInputEvents(...))` → `checkLedgerInvariants` → `checkLeavesFile` → 경계 스냅숏 = 재생 세계 →
`compareLedgerRoot(rootFields, chain)`(boardBatchRoot = 범위 (직전 throughWindow, throughWindow]에서 끝난 묶음, inputLogRoot = 다시 계산한 사슬 머리).

시험: `test/ledger-verify.test.ts`(정직 3루트 · 루트 하나 · 범위 · 상한 · 이어 받기 3루트 · 위조: 잎 잔액 · 명단 순서 · 세션 서명 · 파일 누락 · 다른 ANNOUNCE 키 ·
같은 날 GRANT 두 번 · 지급 루트/공급 · ERC-1271 · timestamp · 입력 빠짐 · 스냅숏 · 범위 밖 명단 · 신뢰 뿌리), `test/ledger-rpc.test.ts`(가짜 JSON-RPC
`test/fake-ledger-chain.ts`), 묶음 `test/ledger-fixture.ts`(A3 함수로 만드는 game-server 흉내), 데모 `test/ledger-demo-bundle.ts`.

## (개정 6) 에폭 검증 — D4에서 지움 (D208)

개정 6의 에폭 검증(`verifyEpochs`, `epoch.ts`)과 체인 값 출처(`RpcChainSource`·`StaticChainSource`·`ChainFacts`, `pikit.chain/v3`), 정산 대조 `checkSettlements`, 만드는 쪽 참조 구현 `WorldProducer`, 옛 데모 `test/demo-bundle.ts`는 D4(D208)에서 지웠다. 남은 공용 조각은 루트 함수(`worldStateHashes`, `roomsStateRoot`, `boardBatchRoot`, `commitBatch` — `roots.ts`)와 입력 대조 `checkInputLinkage`(`linkage.ts`), 속도 제한 `limitedTransport`(`rpc-limit.ts`)다. `localEngineVersionHash`는 `replay.ts`, `DEFAULT_MAX_RPS`·`VERIFIER_RETRY`는 `ledger-rpc.ts`에 있다. 옛 설계는 `docs/fairness-chain-linkage.md`·DECISIONS(D37~D43, D111).

## 아직 없는 것 (ROADMAP)

- 체인만으로 입력 재구성(운영자 파일 없이, 명세 17 P0-16 f)
- 규칙 버전이 바뀌는 방(카탈로그 교체) 재생
- 웹 검증 화면, 공개 저장소에서 입력 기록 내려받기

## 골든 재생 테스트

`test/fixtures/golden-1.log.json`(손으로 짠 입력 기록: 묶음 구매(결제 수단 칸 없음 — D107에서 지우고 골든을 다시 만듦), 취소, 대기열 넘침, 무효 구매, 방 닫힘, 블록 해시가 있는 윈도)을 재생해 `golden-1.expected.json`과 비교한다. `golden-2`는 하늘 별(D125)이 모두 나오는 바쁜 판, `golden-3`은 BIG POP·LUCKY 몫·over(1배 넘는 지급)가 나오는 짧은 판(규칙 7)이다. 엔진 규칙을 **일부러** 바꿨다면:

```bash
UPDATE_GOLDEN=1 pnpm --filter @pikit/verifier test   # 기대값 다시 쓰기 → 바뀐 이유를 커밋 메시지에
```
