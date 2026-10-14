# @pikit/protocol — 주고받는 데이터의 형식

게임 서버·API·웹·검증기·컨트랙트 도구가 **같은 모양의 데이터**를 쓰도록 형식을 한 곳에 모은 패키지다. 각 형식은 TypeScript 타입 + 검증 스키마(zod 4.6.5)로 되어 있고, 빌드하면 다른 언어에서도 쓸 수 있는 JSON Schema가 `schemas/*.schema.json`으로 나온다.

- 검사: `parseCatalog(json)`, `InputLog.parse(json)` 처럼 부르면 틀린 곳을 모두 담은 오류를 던진다.
- 큰 숫자(uint64·uint256·wei)는 JSON 숫자 정밀도(2^53)를 넘을 수 있어 10진 문자열로 둔다.
- 주소·해시는 소문자 `0x…` 16진수.

## 형식과 오너가 알아야 할 뜻

| 형식 (코드 이름) | 파일 | 오너 입장에서의 뜻 | 설계 근거 |
|---|---|---|---|
| **카탈로그 / 규칙표** (`Catalog`, `CatalogSchema`) | `src/catalog.ts`, 출시 표 `catalogs/normal.json` 하나(구슬 가격 ×1·×2·×5·×10·×20 + 블록 값 1 + 등급별 POP, 봇 칸 따로 — D104; LITE·HARDCORE 삭제), `catalog.example.json` = NORMAL | 게임의 모든 숫자: 곡괭이 가격·공격력·크기·무게·내구도, 블록 체력·가치, β, 보너스 표(POP 상금, 순서 패턴 `reward.patterns`, "연속!" `reward.streakEscalation`)와 곡괭이별 상한, 대기열 10개, 타이머·멈춤 기준, 2,000블록 구성, 봇 수, 물리 상수. 엔진은 숫자를 코드에 박지 않고 여기서만 읽는다. 바꾸면 규칙 버전이 바뀐다 | 부록 B, `route-streak-balance.md` §0.3 |
| **규칙 지문** (`canonicalHash`) | `src/canonical.ts` | 규칙표를 정규 JSON(키 정렬, 공백 없음, RFC 8785 방식)으로 만든 뒤 SHA-256. 키 순서·줄바꿈이 달라도 내용이 같으면 지문이 같다. 컨트랙트에 72시간 예고로 올리는 `rulesHash` 후보 | §2.3-6 |
| **정산 종류** (`SettleKind`, `SettlementStatus`) | `src/purchase.ts` | 곡괭이 정산 REWARD/REFUND와 상태. 개정 6 체인 이벤트 모양(`PurchasedEvent`·`PurchaseStatus`·`SettledEvent` 등)은 D4에서 지웠다(D208) | §2.3, D53 |
| (개정 6) **시드 사슬 약속·앵커·묶음 약속** (`SeedChainCommitment`, `EpochAnchor`, `BoardBatchCommitment`, `src/fairness.ts`) | — | D4에서 지움(D208). 개정 7은 시간당 장부 루트(`src/ledger.ts`) | §4.2·§4.5·§6.2 |
| **곡괭이 히스토리 1행** (`PickaxeHistoryRecord`) | `src/history.ts` | 히스토리 탭 한 줄: 등급, 결제 수단, 가격, 번 것(기본·보너스), 실제 지급, PnL, 끝난 이유, 보너스 사건 요약 `events[]`(POP·PATTERN·STREAK, 상금과 실제 지급) | §8.5, 부록 D `pickaxe_run` |
| **피드·대기열·살아 있는 곡괭이·생존 신호** (`FeedEvent`, `QueueState`, `PickaxeLiveState`, `LivenessSignal`, `shortPlayerId`) | `src/feed.ts` | 방 안 전원과 전체 티커에 실시간으로 나가는 보너스·스폰·종료 사건(주소 대신 짧은 id), 내 대기열, 화면에 보여도 되는 곡괭이 값, 서버 생존 상태. 메시지 이름과 흐름은 `docs/INTERFACES.md` | §5.1, §8.4, 오너 결정 2026-10-06 |
| **예외 기록** (`ExceptionRecord`) | `src/history.ts` | E1~E13(서버 다운, 방 멈춤, Monad 정지, 바우처 지연 …)을 언제·누가 감지했는지 | §5.2 |
| (개정 6) **환불·정산 기록** (`RefundRecord`) | — | D4에서 지움(D208) | §5.3 |
| **엔진 입력 기록** (`InputLog` v0, `EpochInputLog` v1, `EngineInput`, `LedgerInput`) | `src/input-log.ts` | 엔진이 윈도마다 받는 입력. 방 입력: 구매(`creditsToUse` 포함), 취소, 프로모, 동결, 무효 구매 제거. 공유 장부 입력: 바우처 묶기·해제, 청구 확정, 프로모(D37). v1은 에폭마다 파일 하나(모든 방 + 공유 장부)이고 줄마다 keccak 해시 사슬로 잇는다 | §2.4, §4.5, D37·D40 |
| **해시·약속 바이트** (`keccak256`, `hmacSha256`, `SeedChain`, `epochOf`, `chainInputLog`, `merkleRoot`·`merkleProof`, `liabilityLeaf`, `idValueLeaf`, `boardBatchHash`, `batchPreCommitment`·`roomsRulesRoot`, `onchainRulesHash`) | `src/crypto.ts` | 시드 사슬 S_{i−1} = keccak256(S_i), 입력 기록 사슬, OpenZeppelin 호환 Merkle(부채 잎·방 상태·묶음), 묶음 해시 H_j, 체인 rulesHash = keccak256(catalogHash ‖ engineVersionHash). 컨트랙트와 같은 값(시험 벡터) | D40·D41 |
| **EIP-712 서명** (`CreditIntentMessage`, `CancelIntentMessage`, `SessionGrantMessage`, `pikitDomain`, `hash*`·`sign*`·`recover*Signer`) | `src/eip712.ts` | 세션 키(secp256k1, 브라우저 viem 로컬 계정) 구매·취소 의향서(`CreditIntent`에 `promo` 칸 없음, 개정 5)와 지갑의 세션 키 허가(SessionGrant), 모두 PikitShop 도메인. 옛 영수증·확인·청구 바우처(금고 도메인)는 없앴다(개정 3·5). 다이제스트는 Foundry 시험이 같은 값을 확인한다. viem 2.57.3 | D39·D42·D52 |
| **로그인 + 세션 키 위임** (`createSessionSiweMessage`, `parseSessionDelegation`) | `src/siwe.ts` | SIWE 한 번: `resources`에 `urn:pikit:session-key:<주소>:exp:<unix>`, 고정 문구 | D38 |
| **검증 묶음** (`WorldManifest`, `AnchorRecord`) | `src/bundle.ts` | 세계 목록과 앵커 기록(엔진 해시 안에 있어 남김). 개정 6 체인 값 `ChainSnapshot`(`pikit.chain/v3`)·`SettlementRecord`는 D4에서 지웠다(D208) | D37·D56 |
| **REST 응답** (`VoucherView`, `VoucherRefusalCode`, `HistoryItem`, `MeView`, `ActivePickaxeSummary`) | `src/rest.ts` | api가 웹에 주는 모양. 바우처는 RESERVING → ISSUED, 히스토리는 대기·진행 중인 곡괭이도(끝 값 null) + 벽시계 시각, `/me`의 다음 의향서 nonce | D62·D63 |
| **방 메시지** (`JoinOptions`, `CreditIntentSubmit`, `CancelIntentSubmit`, `ConfirmSubmit`, `ConfirmRequestMsg`, `PurchaseReceiptMsg`, `SystemNotice`, `ChatSend`·`ChatMsg`·`ChatHistoryMsg`·`ChatRejectedMsg`(D212), `PickaxeEndMsg`, `HistoryAppendMsg`, `SettingsUpdate`) | `src/messages.ts` | game-server ↔ web Colyseus 메시지. 방 선택은 `chainRoomId` | D58, INTERFACES §1 |
| **ABI** (`pikitLedgerAbi` — 개정 6 `pikitShopAbi`·`pikitFairnessAbi`는 D4에서 지움, D208) | `src/abi.ts`, `src/abi.generated.ts`, `abi/*.json` | 컨트랙트 Foundry 산출물에서 뽑은 ABI(viem 타입 추론이 되는 `as const`). 손으로 고치지 않는다 | D53 |

## 아직 없는 것 (ROADMAP)

배포 주소 묶음(체인별), EIP-1271 컨트랙트 지갑 서명 검증(api 몫).

## 명령

```bash
pnpm --filter @pikit/protocol build   # 컴파일 + schemas/*.schema.json 다시 만들기
pnpm --filter @pikit/protocol test
pnpm --filter @pikit/protocol abi:export   # 컨트랙트를 바꾼 뒤: forge build + abi/*.json·src/abi.generated.ts 다시 만들기
```

`pnpm --filter @pikit/protocol lint`는 `contracts/out`이 있으면 ABI 파일이 산출물과 같은지 검사한다(다르면 실패).
