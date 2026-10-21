# 공개 검증 (`pikit-verify verify`) — 무엇을 확인하고, 무엇을 믿나

> 2026-10-12, wave D3 (명세 `docs/specs/17-mainnet.md` G8 · §3.4-4 a–e·g · P0-7 · P0-16, 감사 `_analysis/manipulation-audit-2026-10-12/report.md` F-1 ② · F-2, 개정 6 `docs/contracts-rev6-migration.md` §3.4).
> 남이 치는 명령은 `apps/verifier-cli/PUBLIC.md`(영어), 옵션 전체는 `apps/verifier-cli/README.md`.

> **여섯 세계 (D192·D201 → D229·D230 → D248·D249 → 규칙 11 → 규칙 12)** — `chog.pikit.fun`은 6세계 전환(규칙 12, {W6 start}, `deploy/mainnet/CUTOVER-W6.md`) 뒤 **6세계**로 돈다. 옛 세계 기록은 지우지 않는다.
> 세계마다 계약 하나 · 공개 폴더 하나 · 공개 저장소 태그 하나다. 다른 세계의 태그로 돌리면 루트를 보기 전에 빌드 불일치(`trust: …`)로 실패한다 — "틀린 태그"이지 "나쁜 세계"가 아니다.
>
> | | **6세계 — `PikitLedger` 규칙 12 (막타 룰렛 · HP 0 유예 · CHOG Ore 2×2 · LUCKY ORE 10종, {W6 start}~)** | **5세계 — `PikitLedger` 규칙 11 (COMBO · POP/LUCKY 버프 · 정수 정산, 2026-10-20 04:48 UTC~{W6 start})** | **4세계 — `PikitLedger` 규칙 10 (LUCKY PICK · 골든 CHOG 잭팟, 2026-10-19 05:49 UTC~2026-10-20 04:48 UTC)** | **3세계 — `PikitLedger` 규칙 9 (막타, 2026-10-16 05:35 UTC~2026-10-19 05:49 UTC)** | **2세계 — `PikitLedger` 규칙 8 (10-14~10-16)** | **1세계 — 개정 6 `PikitShop`·`PikitFairness` (10-12~10-14)** |
> |---|---|---|---|---|---|---|
> | 고정할 값 | `<6세계 PikitLedger>` · 체인 143 · rulesHash `{rulesHash}`(규칙 12 — 5세계와 다르다) · ledgerHash `0xe219e713…a4aa`(그대로) | `0xf3B934046014bB4F53aA859fc48bc5aE7B5AaAA2` · rulesHash `0x5a04da5e4e2bd26ca3c4faedd8909c75e823d54d7bfb1d17a2f607fed61e2455`(규칙 11) · ledgerHash `0xe219e713…a4aa` | `0x6456a33a3185D000B7DeEF3901F5B9FAbC963Ca8` · rulesHash(규칙 10, D247) · ledgerHash `0xe219e713…a4aa` | `0x21036eBe95b8bD56fd1268Bb94c587c599f4D6ef` · rulesHash `0x812f1346800b2e81c8cb5fe751191ef67da5e3478c4e3db9a084f911416a4f96`(규칙 9, D228) · ledgerHash `0xe219e713…a4aa` | `0xDcd661D0ee623F714134DB0Ba0467549B8115C02` · rulesHash `0xe29ed968c364d067e4c05e948dcfbe9dfa04082fe0c2afdf0b2a43d489b3ac7a`(규칙 8, D215) · ledgerHash `0xe219e71372f79bd55a2e679283176c5bd7c2ed49c58f35b922b381102808a4aa` | 옛 상점 `0xB0FAf7eA64b44daa7246Bac43aBf9e16f7a47e0C` |
> | 공개 저장소 태그 | `w6-rules12-<engine10>` (D229·D248: `w<세계>-rules<버전>-<engine10>`, 배포 도구 `verifierTagFor`가 빌드에서 계산 — 웹 검증 패널이 그 이름을 보여 준다) | `w5-rules11-aa342f7aac` | `w4-rules10-722d2bb82d` | `w3-rules9-39d1ae79c2` | `w2-ledger-e219e71372` (장부 규칙 해시로 태그, D205) | `engine-ac38812c12` (옛 CLI) |
> | 공개 파일 `--dir` | `https://chog.pikit.fun/epochs` | `https://chog.pikit.fun/epochs-w5` (읽기 전용, 볼륨 `epochs_w5`) | `https://chog.pikit.fun/epochs-w4` (읽기 전용, 볼륨 `epochs_w4`) | `https://chog.pikit.fun/epochs-w3` (읽기 전용, 볼륨 `epochs_w3`) | `https://chog.pikit.fun/epochs-w2` (읽기 전용, 볼륨 `epochs_w2`) | `https://chog.pikit.fun/epochs-rev6` (읽기 전용) |
> | 명령 | `verify --contract <6세계 PikitLedger> --root latest --dir https://chog.pikit.fun/epochs --rpc https://rpc.monad.xyz,https://rpc1.monad.xyz` (§8) | `verify --contract 0xf3B934046014bB4F53aA859fc48bc5aE7B5AaAA2 --root latest --dir https://chog.pikit.fun/epochs-w5 --rpc https://rpc.monad.xyz,https://rpc1.monad.xyz` → 마지막 루트까지 OK | `verify --contract 0x6456a33a3185D000B7DeEF3901F5B9FAbC963Ca8 --root latest --dir https://chog.pikit.fun/epochs-w4 --rpc https://rpc.monad.xyz,https://rpc1.monad.xyz` → 마지막 루트까지 OK | `verify --contract 0x21036eBe95b8bD56fd1268Bb94c587c599f4D6ef --root latest --dir https://chog.pikit.fun/epochs-w3 --rpc https://rpc.monad.xyz,https://rpc1.monad.xyz` → 마지막 루트까지 OK | `verify --contract 0xDcd661D0ee623F714134DB0Ba0467549B8115C02 --root latest --dir https://chog.pikit.fun/epochs-w2 --rpc https://rpc.monad.xyz,https://rpc1.monad.xyz` → 마지막 루트까지 OK | `verify --shop 0xB0FAf7eA64b44daa7246Bac43aBf9e16f7a47e0C --epoch latest --from-snapshot latest --dir https://chog.pikit.fun/epochs-rev6 --rpc https://rpc.monad.xyz,https://rpc1.monad.xyz` → 마지막 앵커까지 OK |
> | 이 문서 | **§8** (2~6세계 같은 검증기 — 엔진만 다르다) | §8 | §8 | §8 | §8 | §1~§7 (아래는 모두 1세계 설명이다) |
>
> 5세계 파일은 `https://chog.pikit.fun/epochs-w5/`(읽기 전용, `RESET_DB`가 지우지 않는다), GCS `143-0xf3b93404…/`, 공개 저장소 Release `w5-rules11-aa342f7aac-epochs`(tar)에 남는다. 5세계 PikitLedger는 마지막 루트로 체인에 남는다(돈 없음).
> 4세계 파일은 `https://chog.pikit.fun/epochs-w4/`(읽기 전용, `RESET_DB`가 지우지 않는다), GCS `143-0x6456a33a…/`, 공개 저장소 Release `w4-rules10-722d2bb82d-epochs`(tar)에 남는다. 4세계 PikitLedger는 마지막 루트(epoch 1320, throughWindow 114940125, 2026-10-20 04:02 UTC)로 체인에 남는다(돈 없음).
> 3세계 파일은 `https://chog.pikit.fun/epochs-w3/`(읽기 전용, `RESET_DB`가 지우지 않는다), GCS `143-0x21036ebe…/`, 공개 저장소 Release(tar)에 남는다. 3세계 PikitLedger는 마지막 루트로 체인에 남는다(돈 없음).
> 2세계 파일은 `https://chog.pikit.fun/epochs-w2/`(읽기 전용, `RESET_DB`가 지우지 않는다), GCS `143-0xdcd661d0…/`, 공개 저장소 Release(tar)에 남는다. 2세계 PikitLedger는 마지막 루트로 체인에 남는다(돈 없음).
> 1세계 파일은 `https://chog.pikit.fun/epochs-rev6/`(읽기 전용), GCS `143-<옛 상점>/`, 공개 저장소 Release(tar)에 남는다. 옛 컨트랙트는 마지막 앵커·판매 정지 상태로 체인에 남는다(돈 없음).
> 1세계 검증 코드(`verifyEpochs`·`RpcChainSource`·`StaticChainSource`·`checkSettlements`, CLI `--shop`·`--epoch`)는 D4에서 이 저장소에서 지웠다(D208) — 1세계 명령은 공개 저장소 태그 `engine-ac38812c12`의 CLI로 돌린다. §1~§7은 그 기록이다.
> 3세계부터 보고서의 곡괭이 표에는 막타 칸(`lastHit(cr)`·`LH`)이 있다 — 번 것 E = base + lucky + bonus + lastHit (명세 22).
> 4세계(규칙 10, 명세 23)는 곡괭이 표에 LUCKY PICK 단계·보충(`PICK`)과 잭팟(`JACKPOT`) 칸, "JACKPOT" 절(윈도·틱·지갑·금액·통 뒤)과 끝 줄 통 상태(`pool now N (contributed C, paid P)`)를 더 찍는다. 통과 단계는 엔진 상태(`PIKIT/state/v11` → roomsStateRoot)라 따로 믿을 파일이 없다 — 재생이 같은 값을 만든다. 장부 잎·루트 모양과 ledgerHash는 그대로다.

## 1. 한 줄 (1세계)

공개 파일(세계 목록·카탈로그·에폭 입력 기록·스냅숏)과 **체인에서 직접 읽은 값**(RPC 1~2곳)만으로 세계를 다시 돌려, 운영자가 체인에 올린 앵커 루트·정산 금액이 엔진 결과와 같은지 확인한다. 하나라도 다르거나 **빠지면** 종료 코드 1.

## 2. 실패(종료 1)가 되는 것

| 검사 | 무엇이 틀리면 | 이름 (`--json` `checks[].name` / `settlements.mismatches[].reason`) |
|---|---|---|
| 엔진 | 세계가 다른 엔진 빌드(규칙 버전)로 만들어짐 — **체인·파일을 읽기 전에** 멈춘다 | `engine build = world.engineVersionHash` |
| 방 첫 윈도 (D162, 개정 6-b) | `world.json`의 방 `createdWindow`가 체인 max(W0, `roomOf(r).createdBlock`)과 다름 — 운영자가 첫 판(첫 줄·봇)을 사후에 고르는 길(리뷰 rev6 L-3) | `room r: world createdWindow = max(W0, roomOf.createdBlock)` |
| 방 규칙 (D162) | 방마다 keccak256(catalogHash ‖ engineVersionHash)가 **그 방의** 체인 규칙(`roomOf` 지금·예약 규칙)이 아님, 또는 그 방이 체인에 없음 | `room r: keccak256(catalogHash ‖ engineVersionHash) = this room's on-chain rulesHash (roomOf)` |
| 파일 | 참조한 에폭 파일·시작 스냅숏이 공개돼 있지 않음 (HTTP 404·없는 파일) | `every referenced epoch file (and the start snapshot) is published` |
| RPC 2곳 | 두 곳이 체인 값(체인 id·시드 약속·앵커·사건·블록 해시·방 규칙) 하나라도 다르게 답함 — 첫 차이를 적는다 | `the RPC endpoints agree on every chain fact read` |
| 가격·상한표 (D162) | 체인 `catalogOf(rulesHash)`의 등급 가격·REWARD 상한·over 상한이 재생하는 카탈로그 값과 다름. rulesHash는 카탈로그(가격·`rewardCapBps` 포함)를 묶지만 `announceCatalog`는 가격·상한 배열을 따로 받아서, 같은 rulesHash로 두 배 가격인 상점을 배포할 수 있다(리뷰 rev6 M-2) — 방마다 대조 | `room r: chain tier prices (catalogOf) = catalog prices` (`PRICE_MISMATCH`) · `room r: chain tier caps (catalogOf) = catalog REWARD and over caps` (`CAP_MISMATCH`) |
| 입력 = 체인 사건 | 구매·취소·무효·동결 입력이 빠짐·늦음·바뀜·지어냄 (H-1) | `inputs = chain events …` (`MISSING`·`WINDOW`·`FIELDS`·`EXTRA`·`ORDER`·`DUPLICATE`) |
| 시드·기록 사슬 | S_e가 S_0까지 keccak으로 안 이어짐, 입력 기록 해시 사슬이 끊김 | `epoch e: …` |
| 앵커 | 재생한 세계·입력 기록·묶음이 앵커 루트와 다름 | `anchor k: roomsStateRoot` 등 |
| 정산 금액 | `Settled`(settleEnd) 한 칸의 kind·payout·**over**(0 포함)·지갑이 재생과 다름 | `AMOUNT`·`KIND`·`BUYER`·`NOT_PAID`·`VOID_PURCHASE`·`DUPLICATE` |
| 시한 지난 미지급 | 재생이 끝을 기록했는데 끝 윈도 + `SETTLE_STALL`(6,000블록, 30분)이 지나도록 settleEnd가 없음 (환불로 닫힌 정상 종료도 여기) | `OVERDUE` |
| 무효로 사라진 over | 무효 구매의 정상 종료(over > 0)에 settleEnd도 `VoidOverPaid`(개정 6 `payOverAfterVoid`)도 없이 max(끝 윈도, 무효 블록) + 6,000이 지남 | `VOID_OVER` |
| 무효 over 금액 | `VoidOverPaid`의 over·지갑이 재생과 다름 / 그런 곡괭이가 아닌데 있음·두 번 | `VOID_OVER_AMOUNT` / `VOID_OVER_EXTRA` |

체인 무효 구간(`PurchasesVoided`)은 재생 범위 끝 뒤 블록에 실렸어도(장애 뒤 첫 늦은 앵커의 무효는 윈도 A + 1에 들어가 범위 끝 P_A + 1 뒤다) 체인 값 머리까지의 것이면 무효로 대조한다 — 그 구매의 정상 종료는 settleEnd가 아니라 `VoidOverPaid`(over > 0)로 가므로 `OVERDUE`·`VOID_OVER_EXTRA`로 틀리게 실패하지 않는다(리뷰 rev6 I-1, D162).

시한 전 미지급은 경고(`unsettled`)다 — settler가 늦을 수 있다. 정산 시한을 `SETTLE_STALL`로 잡은 근거: 명세 16 §10-2, 체인은 그 시점에 판매를 멈춘다(정직한 운영이면 그 전에 보낸다).

### 2.1 없는 파일 = 실패, 단 체인 끝 경합은 아니다 (D183)

공개됐어야 할 파일이 없으면 실패다(감사 F-1 "missing file = FAIL" — 아무도 그 구간을 검증할 수 없다). 다만 체인 끝 바로 앞 에폭은 원본에 쓰였어도 공개 서버·CDN 에 아직 안 보일 수 있다. 그래서 CLI 는 404(없는 파일)인 에폭 e(에폭 파일 `e.json`, 또는 시작 스냅숏 `snapshots/e.json`)를 이 경계로 나눈다:

| 경계 | 값 | 이 안이면 |
|---|---|---|
| `TIP_EPOCHS` | e > (체인 마지막 앵커 에폭 L) − 2, 즉 e ≥ L − 1 | 체인 끝 경합 |
| `PUBLISH_LAG_WINDOWS` | 또는 e 의 끝 윈도 > 확정 머리 − 400 (2 에폭 ≈ 2분) | 체인 끝 경합 |

- 없는 에폭이 **모두** 체인 끝 경합이면 종료 3 + `--json` 이면 `{ "ok": null, "errorKind": "tip-race", "error": "epoch … not published yet — …", "retryAfterSec": 30 }` — 검증 실패가 아니다. 감시 루프는 `VERIFY_TIP_RETRY_SEC`(30)초 뒤 같은 속도로 다시 돈다.
- **하나라도 그보다 오래된 에폭이 없으면 지금처럼 실패**(종료 1, `every referenced epoch file (and the start snapshot) is published`). 근거: game-server 는 에폭을 처리하자마자 그 파일을 쓰고 앵커는 그 뒤에 올라가므로 L − 2 이하이면서 2분 넘게 지난 에폭의 파일은 원본에 이미 있어야 한다 — 그것이 없으면 반영 지연이 아니라 빠진 것이다. 앵커는 30–35 에폭(≈ 30분)마다라, 마지막 앵커가 덮은 마지막 두 에폭 밖은 늘 몇 분 이상 지난 파일이다.
- 앵커가 아직 없으면(범위를 고를 수 없음) 경계도 없다 — 없는 파일은 실패.
- 404 가 아닌 HTTP 오류는 이 표와 무관하다: 429·5xx·상태 없는 실패(연결·본문 읽기 실패, 2xx 인데 JSON 이 아닌 RPC 응답)는 전송 오류(종료 3, `errorKind: "transport"`), 그 밖의 4xx 는 설정 문제(종료 1), 2xx 인데 JSON 이 아닌 **공개 파일**은 내용 오류(종료 1). 오류 줄은 늘 상태 또는 밑 원인과 호스트 + 경로를 싣는다(`HTTP request failed (404 GET chog.pikit.fun/epochs/844.json)`, `(fetch failed: ECONNRESET; POST host/path)`) — 쿼리·키 같은 경로 조각은 지운다.

위조 기록 시험(옛 `packages/verifier/test/demo-bundle.ts`의 지급 속임, CLI 시험 `forged-*` — D4에서 지움, D208): `nosettle`(over > 0 정산 빠뜨림 → `OVERDUE`), `overzero`(over를 0으로 → `AMOUNT`), `voidover`(무효 over 안 줌 → `VOID_OVER`), `missingfile`(4.json 미공개 → 파일 검사).

## 3. 스냅숏 시작 (`--from-snapshot <E|latest>`) — 증명하는 것과 못 하는 것

game-server는 에폭마다 끝 세계를 `snapshots/<E>.json`(`{ epoch, processedWindow, inputLogHead, world: { rooms: [{ roomId, state }] } }`)으로 공개한다. 검증기는:

1. 체인에서 **앵커 k**(processedThrough + 1 = 스냅숏 processedWindow)를 `anchorAt` 이진 탐색으로 찾는다. 없으면 실패(앵커 없는 에폭에서는 시작할 수 없다).
2. 스냅숏 세계의 `roomsStateRoot`(방마다 SHA-256(serializeRoom))가 앵커 k의 값과, `inputLogHead`가 앵커 k의 `inputLogRoot`와 같아야 한다. 방 목록은 세계 목록에서 그때까지 만들어진 방과 같아야 한다.
3. 시드 S_{E+1}은 S_0(체인 `seedRoot`)까지 keccak E+1번으로 이어져야 한다(싸다: 30일 ≈ 4.3만 번).
4. 거기서 에폭 E+1…N을 처음부터 검증할 때와 **똑같이** 검증한다(앵커 k+1…의 세 루트, 입력 = 체인 사건, 정산, 묶음 — 스냅숏 앞에서 시작한 묶음 줄은 그 블록 해시를 체인에서 더 읽어 다시 뽑는다).
5. 체인 사건은 블록 [P_k + 1 − T_FREEZE, 끝]만 읽는다(처음부터 읽지 않는다). 동결 판정에 필요한 앞 앵커(블록 ≤ P_k에 실린 마지막 것까지)는 `anchorAt`으로 읽는다.

**증명하는 것**: "앵커 k가 올린 상태에서 출발하면, 공개된 E+1…N의 입력(= 체인 사건)으로 엔진이 낸 세계·묶음·정산이 체인 앵커 k+1…과 체인 정산 기록과 정확히 같다." 즉 그 범위 안의 결과(누가 무엇을 받았나)가 규칙대로다.

**증명하지 못하는 것** (처음부터 검증 `--epoch N`(시작 플래그 없음)이 여전히 있다):
- 앵커 k의 상태 자체가 규칙대로 만들어졌는지 — 그것은 앵커 k까지의 재생(앞 실행, 또는 처음부터 검증)이 증명한다. 감시자는 시계가 아니라 **앞 성공 실행이 남긴 상태**(`--since-state`, §7)로 시작 앵커를 고르므로 실행이 늦거나 실패해도 사슬이 끊기지 않는다(D163). `--from-snapshot latest`(시계로 고름)는 한 번 돌려 보는 사람용이다 — 두 실행 사이가 하루 + 30분보다 벌어지면 그 사이에 끝난 곡괭이를 아무도 다시 안 본다(리뷰 rev6 H-1).
- 스냅숏 앞에서 끝난 곡괭이의 정산(그 곡괭이는 재생하지 않는다 — 그 체인 기록은 `skipped`로 센다). `--since-state`의 시작 앵커는 앞 실행이 판정을 끝내지 못한 첫 곡괭이 끝(체인 머리 − `SETTLE_STALL`, 시한 전 미정산·무효 over의 끝 윈도) **앞**의 앵커라 그런 곡괭이는 다음 실행이 다시 재생한다.
- 스냅숏 경계를 넘는 방-윈도 상한 적체는 읽은 사건 구간(T_FREEZE = 12,000블록) 안의 것만 다시 계산한다(그보다 오래된 적체는 없다고 본다 — 한 방에 120만 입력이 밀려야 생긴다).
- 상태 해시는 `serializeRoom`이 담는 칸만 묶는다(엔진 불변식 — 상태 = 그 바이트).

`latest`의 뜻: 범위 끝(`--epoch latest` = 체인 마지막 앵커의 에폭)에서 288,000블록(하루) + 6,000블록 이상 앞선 마지막 앵커 에폭. 세계가 그보다 어리면 처음부터.

## 4. 무엇을 믿나

| 입력 | 출처 | 믿음 |
|---|---|---|
| **상점 주소** (D162) | 검증하는 사람이 고른 값: `--shop <주소>` 또는 따로 받은 `--trust <파일>`의 `shop`(+ 선택 `chainId`·`fairness`·`seedRoot`·`engineVersionHash`, 준 값은 모두 대조). `world.json`의 shop이 다르면 체인·파일을 읽기 전에 실패(`world.shop = the shop you pinned`). 공정성 주소·시드 약속·가격표는 그 상점에서 체인으로 읽는다 | 사람이 지갑 서명(EIP-712 `verifyingContract`)·탐색기·`/rules`에서 확인한 값 — 운영자 파일이 아니다. 모든 실행은 보고서 맨 위에 신뢰 뿌리(체인 id·상점·공정성·seedRoot·엔진 해시·방마다 카탈로그 → 규칙)를 찍는다 |
| 블록 해시·시드 약속·앵커·구매/취소/무효·정산·VoidOverPaid·방 규칙·가격/상한표(`catalogOf`) | `--rpc` (확정 블록, 두 곳이면 모두 대조, 읽기는 두 곳의 확정 머리 중 낮은 블록에 고정) | RPC 공급자 (두 곳이면 둘이 같은 거짓을 말해야 속는다). **두 URL은 서로 다른 공급자여야 한다** — 같은 호스트(이름을 소문자·끝 점·`www.` 빼고 비교)면 사용법 오류(종료 2), 같은 도메인이면 경고. 보고서에는 호스트 이름만 적는다(URL의 키는 안 적음). 웹이 보여 준 RPC를 그대로 믿지 말고 하나는 직접 고른다 |
| 에폭 입력 기록·스냅숏·세계 목록·카탈로그 | 운영자 공개 파일 (`https://chog.pikit.fun/epochs`) | 믿지 않는다 — 체인 앵커·사건과 대조된다. 없으면 실패 |
| `--chain chain.json` | 운영자 파일 | 운영자의 말 (stderr 경고). 시험·오프라인용 |
| 엔진 | 이 저장소의 공개 코드(`packages/engine`), `engineVersionHash` | 직접 빌드 |

## 5. 비용·속도 (2026-10-12 측정, M-series 노트북, Node 24.21)

- **재생 계산**: 데모 세계(방 2, 바쁜 방 하나 5윈도마다 구매) 300에폭 = 7.2초(처음부터), 150에폭 = 3.8초(`--from-snapshot 150`) → **약 2,400~2,600 에폭/분**. 하루치(1,440에폭) 계산 ≈ 35초.
- **RPC**: 블록 해시가 거의 전부 — 윈도 2개에 `eth_getBlockByNumber` 1번 → 하루 ≈ 14.4만 번/곳. 곳마다 `--max-rps 20`이면 ≈ 2시간(두 곳은 동시에). 로그는 100블록에 1번(하루 2,880번).
  테스트넷 실측: 두 곳(`testnet-rpc.monad.xyz` + `rpc.ankr.com/monad_testnet`) 각 4 req/s로 400윈도 해시 + 1,780블록 로그 = 60초.
- 그래서 매시간 감시자(`.github/workflows/verify-*.yml` → `_verify.yml`, §7)는 한 실행이 1시간 + 겹침 30분 ≈ 9,000 getBlock/곳(20 req/s에 약 8분)이다. 밀린 구간은 `--max-epochs`(기본 VM 300 · 호스팅 150 에폭)씩 나눠 따라잡는다. GitHub 러너 실측은 §7.3(≈ 6.5초/에폭).

## 6. 테스트넷 실제 실행 (2026-10-12)

`verify --dir https://chog.pikit.fun/epochs --rpc https://testnet-rpc.monad.xyz,https://rpc.ankr.com/monad_testnet --epoch latest --from-snapshot latest` →
`✘ engine build = world.engineVersionHash` (세계 `0xe95d…43b9` = 규칙 6 엔진, 이 검증기 `0xf8ab…636d` = 규칙 7), 종료 1, 1초 안(체인·파일을 읽기 전에 멈춤).
규칙 7 세계(R4 재배포) 전에는 통과할 수 없는 것이 정상이다. RPC 두 곳 읽기 자체(앵커 탐색·로그·블록 해시 대조)는 같은 날 테스트넷에서 확인했다(§5).

## 7. 매시간 외부 감시자 — 공백 없이 이어 받기 (1세계, 리뷰 rev6 H-1 · M-1, D163 · D179 — 2세계는 §8.8)

감시는 두 겹이다:

| | 어디서 | 언제 | 역할 |
|---|---|---|---|
| **1차: VM `verifier` 컨테이너** (D179, §7.4) | 운영 VM 의 docker compose | 컨테이너가 스스로 매시간(시작 시각 기준) | 주 감시. GitHub 예약·러너·Actions 분과 무관, 배포를 막지 않는다. 결과를 감시(`verify-fail`·`verify-slow`·`verify-stale`)와 `GET /api/v1/metrics`의 `verify`로 |
| **2차: GitHub `verify-{testnet,mainnet}.yml`** (D163, §7.1~§7.3) | GitHub Actions(VM 러너 또는 호스팅, 포크) | `17 * * * *` 예약 + 손으로 | 독립된 두 번째 확인. 같은 명령·같은 공개 자료를 운영자 밖(포크)에서도 돌릴 수 있다 |

2026-10-13: GitHub 이 `17 * * * *` 예약 실행을 14:17·15:17 UTC 에 만들지 않았다(그 앞 13:10 실행은 배포가 러너를 쓰느라 취소). GitHub 예약은 "부하가 많으면 늦거나 빠질 수 있다"고 문서에 적혀 있다 — 그래서 매시간 보장은 VM 컨테이너가 맡는다.

### 7.1 왜 매시간, 왜 이어 받기

체인이 스스로 드러내는 것은 **정산을 안 보낸 것**뿐이다: 끝 정산이 없으면 구매 블록 + 6,001(30분)에 판매가 멈춘다. **정산을 보내되 작게(0으로·Refund로) 보내거나, 무효가 된 구매의 over를 안 주는 것은 체인 신호가 없다** — 판매도 안 멈추고, 그 뒤 환불 길도 닫힌다(리뷰 rev6 M-1, PoC R6-01·R6-02). 이것을 잡는 것은 검증기의 정산 대조(`AMOUNT`·`KIND`·`VOID_OVER`)뿐이고, 그것도 **다음 검증 실행에서만** 잡힌다. 그래서:

- GitHub 감시자는 기본으로 **테스트넷 VM 의 self-hosted 러너에서 매시간**(`17 * * * *`) 돈다 — 조용한 축소가 드러나기까지 최대 약 1.5시간(실행 간격 + 정산 시한 30분). 저장소 변수 `VERIFY_RUNNER=hosted`면 GitHub 호스팅 러너에서 **6시간마다**(`47 */6 * * *`)로 바뀐다(§7.3).
- 시작점은 시계가 아니라 **앞 성공 실행이 남긴 `verify-state.json`**이다: `{ 검증한 마지막 에폭, 다음 시작 앵커(번호·roomsStateRoot), openFromWindow, … }`. 다음 실행은 그 앵커의 스냅숏에서 체인의 마지막 앵커까지 검증한다(밀렸으면 `--max-epochs`씩 따라잡기). 시작 앵커의 roomsStateRoot가 상태 파일과 다르면 실패.
- **실패한 실행은 상태를 올리지 않는다** — 다음 실행이 같은 곳에서 다시 시작해 다시 실패한다. 사이의 에폭 파일이 하나라도 없으면 실패(`every referenced epoch file … is published`)라 조용히 건너뛸 길이 없다. 상태 산출물이 하나도 없으면(첫 실행, 또는 90일 넘게 성공 없음) 처음부터 검증한다(비싸지만 공백은 아니다).
- 리뷰 PoC `daily-gap.mjs`의 다섯 경우(정시·20분·60분 늦음·0.29초 블록·하루 실패)와 48시간 매시간(지연 0~25분, 실패 3번)을 이 방식으로 다시 돌리면 **공백 0**이다(`_analysis/review-rev6-verifier-2026-10-12/poc/daily-gap-resume.{mjs,out.txt}`).
- 실패하면 저장소 비밀값 `VERIFY_ALERT_WEBHOOK`(Discord 웹훅 URL)이 있을 때 Discord로 실패 검사 이름과 실행 링크를 보낸다. 없으면 GitHub의 실패 메일(워크플로를 켠 계정)뿐이다.

명령(감시자가 매시간 치는 것):

```sh
node apps/verifier-cli/dist/main.js verify --shop <PikitShop> --epoch latest \
  --since-state state/verify-state.json --write-state out/verify-state.json --max-epochs 300 \
  --dir <에폭 파일 URL> --rpc <공급자 A>,<공급자 B> --max-rps 20 --json > report.json
```

### 7.2 운영자가 관리하지 않는 곳에서 돌린다

이 저장소의 워크플로는 **운영자의 저장소 변수**(상점 주소·파일 주소·RPC)를 읽고 운영자 계정에서 돈다 — 운영자가 끄거나 바꿀 수 있다. 감시자가 의미를 가지려면 **운영자가 관리하지 않는 GitHub 계정의 포크**에서도 돌아야 한다(가디언 개인, 외부 감사인, 커뮤니티 사람 누구든). 두 번째 사람이 하는 일:

1. 공개 검증 저장소(또는 이 저장소)를 **자기 계정으로 포크**한다. 포크에서는 예약 워크플로가 기본으로 꺼져 있다 — 포크의 **Actions** 탭에서 워크플로를 켠다.
2. 포크의 **Settings → Secrets and variables → Actions → Variables**에 넣는다:
   - `VERIFY_MAINNET_SHOP`(또는 `VERIFY_TESTNET_SHOP`): PikitShop 주소 — **자기가 직접 확인한 값**(지갑이 서명한 EIP-712 `verifyingContract`, 탐색기의 `Purchased` 사건을 낸 컨트랙트, 웹 `/rules`. 운영자의 `world.json`을 그대로 베끼지 않는다).
   - `VERIFY_MAINNET_FILES_URL`: 공개 에폭 파일 주소.
   - `VERIFY_MAINNET_RPC_URLS`: 쉼표로 두 곳, **서로 다른 공급자**, 적어도 하나는 자기가 고른 것(같은 호스트 두 번은 거부된다, 같은 도메인은 경고).
   - `VERIFY_RUNNER` = `hosted` — **포크에는 꼭 넣는다.** 포크에는 운영자의 VM 러너(`pikit-testnet`)가 없어서, 없으면 잡이 러너를 기다리며 멈춘다. hosted면 6시간마다 돈다(분은 포크 계정이 낸다, §7.3).
   - (선택) `VERIFY_MAX_RPS`(기본 20), `VERIFY_MAX_EPOCHS`(기본 hosted 150 · VM 300).
3. (선택) **Secrets**에 `VERIFY_ALERT_WEBHOOK` = 자기 Discord 채널의 웹훅 URL(채널 설정 → 연동 → 웹후크 → 새 웹후크 → URL 복사). 없으면 실패 메일만 온다 — 계정의 Actions 알림 메일을 켜 둔다.
4. **Actions → verify-mainnet → Run workflow**로 한 번 돌려 초록인지, 요약의 `shop · chain · fairness · engine`이 자기가 아는 값인지 본다. 첫 실행은 처음부터 검증한다(오래 걸리면 `--max-epochs`씩 다음 실행에 이어 간다).
5. GitHub는 활동이 없는 저장소의 예약 워크플로를 60일 뒤 끈다 — 끔 알림 메일이 오면 다시 켠다(또는 가끔 빈 커밋).

상태(`verify-<망>-state-<PikitLedger 주소 0x 뒤 10자, 소문자>`)와 보고서(`verify-<망>-report`)는 그 포크의 작업 산출물로 90일 남는다. 상태를 지우면 다음 실행은 처음부터 검증한다. 상태 이름에 계약 주소가 들어가므로 `VERIFY_<망>_CONTRACT`를 새 세계 주소로 바꾸면 옛 세계 상태를 이어 받지 않고 처음부터 검증한다(CLI는 `pikit.verify-state/v2`만 받는다, D218).

### 7.3 어느 러너에서 도나 — 왜 기본이 VM 매시간인가 (2026-10-12, Actions 분)

조직(DESPELL-STARTALE)의 무료 Actions 분 2,000분/월을 10월 12일에 다 썼다(`_analysis/github-actions-minutes-2026-10-12.md`). 오너 방침은 "호스팅 분은 0에 가깝게, 정기 작업은 VM 러너로, 나머지는 묶어서 한 번에 손으로"다.

| 선택 | 언제 | 비용 | 대가 |
|---|---|---|---|
| **VM self-hosted (기본)** | 매시간 17분 | Actions 분 0 | 운영자 VM 에서 돈다 → **운영자와 독립된 감시가 아니다.** 독립성은 §7.2 포크가 맡는다. 같은 러너를 배포·rules-freeze 와 나눠 쓰므로 한 실행을 45분 안(기본 300 에폭)으로 자른다 |
| GitHub 호스팅 (`VERIFY_RUNNER=hosted`) | 6시간마다 47분 | 아래 실측 | 조용한 축소가 드러나기까지 최대 약 6.5시간. 이어 받기(§7.1)라 **공백은 없다** — 늦게 잡을 뿐 |

**왜 호스팅 6시간마다를 기본으로 두지 않았나.** 호스팅 1회가 2분 이하라면 6시간마다 호스팅이 기본이었을 것이다. 실측은 다르다: 첫 실행(run 38212290114, 2026-10-12)이 31 에폭에 검증 단계 203초 + 준비(설치·빌드) 약 50초 — **약 6.5초/에폭**(RPC 블록 해시가 대부분, §5). 검증할 양은 실행 간격이 아니라 **체인 시간**에 비례하므로(1분 = 1 에폭) 6시간마다면 한 번에 약 360 에폭 ≈ 40분, 하루 1,440 에폭 ≈ 2.6시간 ≈ **월 4,700분**이다. 무료 2,000분을 넘으므로 호스팅은 기본이 될 수 없다. 호스팅을 고르면 잡 상한 20분·150 에폭이라 하루 600 에폭만 따라잡아 **점점 뒤처진다**(요약의 `up to date`가 안 나온다) — 짧게 시험하거나, 포크가 자기 분으로 돌릴 때만 쓴다.

손으로 한 번: **Actions → verify-testnet → Run workflow**, `runner` 에서 `self-hosted`/`hosted` 를 고른다(`auto` = `VERIFY_RUNNER`, 그것도 없으면 self-hosted).

### 7.4 VM `verifier` 컨테이너 — 1차 매시간 (D179)

`deploy/docker-compose.yml`의 `verifier` 서비스(이미지 `pikit-verifier` = `deploy/verifier/Dockerfile`: `apps/verifier-cli` 빌드 + `deploy/verifier/loop.mjs`)가 GitHub 과 같은 명령을 매시간 돌린다:

```sh
nice -n 19 node apps/verifier-cli/dist/main.js verify --shop $SHOP_ADDRESS --epoch latest \
  --since-state /var/lib/pikit-verify/verify-state-<계약 10자>.json \
  --write-state /var/lib/pikit-verify/verify-state-<계약 10자>.json.next --max-epochs $VERIFY_MAX_EPOCHS \
  --dir $VERIFY_FILES_URL --rpc $VERIFY_RPC_URLS --max-rps $VERIFY_MAX_RPS --json
# 상태 파일이 없으면(첫 실행) --since-state 대신 --from-snapshot latest
```

- **이어 받기**: 상태 파일은 이름 있는 볼륨 `verify`의 `verify-state-<LEDGER_ADDRESS 0x 뒤 10자, 소문자>.json`이다 — 계약마다 하나라 계약이 바뀌면 옛 세계 상태를 이어 받지 않고 저절로 처음부터 검증한다(옛 파일은 두든 지우든 상관없다, D218). 성공(종료 0)일 때만 `.next`를 상태로 바꿔 끼운다 — 실패하면 다음 실행이 같은 곳에서 다시(§7.1 과 같은 규칙, 공백 없음). 볼륨이 비었으면(첫 배포·볼륨 삭제) `--from-snapshot latest`(하루 + 30분 앞 앵커 스냅숏, 세계가 그보다 어리면 처음부터)로 시작한다 — 처음부터보다 몇 시간 빠르고, 시작 스냅숏은 체인 앵커 루트와 대조된다(§3).
- **설정**(VM `.env`, `pnpm vm-env:*`가 쓴다): `SHOP_ADDRESS`(운영 설정 그대로 — 사람이 고정한 값과 대조하는 것은 2차의 몫, D162), `VERIFY_FILES_URL`(기본 `https://<DOMAIN>/epochs` — 남이 받는 그 주소), `VERIFY_RPC_URLS`(메인넷 기본 `https://rpc.monad.xyz,https://rpc1.monad.xyz`, 테스트넷 `https://testnet-rpc.monad.xyz,https://rpc.ankr.com/monad_testnet`). 조정값(compose 기본, D181): `VERIFY_MAX_RPS` 20(곳마다 — 공개 Monad RPC 는 IP 당 ≈ 50 req/s, 이 VM 의 다른 공개 RPC 읽기는 적다), `VERIFY_MAX_EPOCHS` 60(한 덩이), `VERIFY_INTERVAL_SEC` 3600(up to date 일 때만 기다림), `VERIFY_TIMEOUT_SEC` 3000(한 실행 상한), `VERIFY_TRANSIENT_RETRY_SEC` 120(전송 오류 뒤 다시까지, D182), `VERIFY_TIP_RETRY_SEC` 30(체인 끝 경합 뒤 다시까지, 속도 그대로, D183 · §2.1).
- **따라잡기 (D181)**: 한 실행 = 최대 `VERIFY_MAX_EPOCHS` 에폭 한 덩이(20 req/s 에 ≈ 6.5초/에폭 → 60 에폭 ≈ 6.5분). 성공했는데 체인 마지막 앵커에 못 닿았으면(CLI 범위 줄 `capped at 60 epochs: through epoch B of L`) **기다리지 않고 바로 다음 덩이**, `up to date`(또는 끝까지 닿음)일 때만 간격을 기다린다. CLI 는 성공해야만 상태를 쓰므로 50분에 끊긴 실행은 진행을 남기지 못한다 — 그래서 끊기면 **상한을 반으로(최소 10) 줄여 바로 다시**, 줄인 상한은 up to date 가 되면 되돌린다. 2026-10-13 첫 메인넷 실행은 처음부터 300 에폭 · 10 req/s 로 돌다 50분에 끊겼고(에폭 파일 200개 읽은 뒤 체인 대조 중), 상태가 없으니 매시간 같은 곳에서 다시 시작해 끝나지 않았다.
- **첫 따라잡기가 걸리는 시간 (메인넷 실측, 2026-10-13 재배포 #6)**: 덩이는 상한 60 에폭까지 가지 않고 **다음 앵커에서 멈춘다 — 덩이마다 30–35 에폭, ≈ 4.5분**. 그동안 체인이 ≈ 4.5 에폭 자라므로 순 ≈ **6 에폭/분**. 처음부터 ≈ 700 에폭 밀렸으면 ≈ 700 ÷ 6 ≈ **2시간**, 밀린 양 N 이면 ≈ N ÷ 6 분. 그동안 `verify` 는 `ok: true`, `epochsBehind` 가 덩이마다 ≈ 27 줄고, 300 넘게 뒤처진 동안 `slowSince` 가 켜져 있다. 그 구간은 ≈ (N − 300) ÷ 6 분 — 700 이면 ≈ 70분이라 경고 없이 끝나고, N 이 ≈ 1,000 을 넘으면 `verify-slow` 경고가 한 번 날 수 있다(그때 `epochsBehind` 가 줄고 있으면 정상, `deploy/RUNBOOKS.md` §14.4). (D181 이 적은 "덩이 ≈ 50 에폭, ≈ 70분"은 실측보다 낙관이었다.)
- **전송 오류는 실패가 아니다 (D182)**: 2026-10-13 메인넷에서 8 덩이 성공 뒤 9번째가 공개 RPC 의 `HTTP 429`(속도 제한)로 끝났는데 결과가 `ok: false` 라 루프는 한 시간을 기다렸고 감시는 `verify-fail` 을 울렸다. 이제 CLI 는 전송 오류(HTTP 429·5xx, JSON-RPC 속도 제한, 시간 초과, 연결 끊김·거부·DNS)를 **종료 3** + `--json` 이면 `{ "ok": null, "errorKind": "transport", "error": "…" }`(URL 은 지움)로 알리고, 검증 실패는 그대로 종료 1. **상태 코드 없는 HTTP 실패도 전송 오류다**(D183): 같은 날 run 27 이 맨 `HTTP request failed.`(상태·원인 없음)로 `ok: false` 가 됐다 — 공개 RPC 가 2xx 에 JSON 이 아닌 본문(빈·잘린·HTML)을 준 것으로, viem 은 status 없이 SyntaxError 를 cause 로 단다. 이제 그런 응답은 RPC 층이 먼저 다시 보내고(아래 백오프와 같은 예산), 그래도 남으면 종료 3 이고 오류 줄에 원인이 실린다(`HTTP request failed (SyntaxError: Unexpected end of JSON input; POST rpc.monad.xyz/)`). 체인 끝 에폭 파일의 404 는 `errorKind: "tip-race"`(§2.1). 루프는 종료 3 을 `ok: null, transient: true, lastError` 로 적고 `VERIFY_TRANSIENT_RETRY_SEC`(120)초 뒤 **곳마다 초당 요청을 반으로(최소 5)** 줄여 다시 돈다. 성공할 때마다 +5 씩 `VERIFY_MAX_RPS` 까지 되돌린다. 그 전에 검증기 RPC 층(`packages/verifier/src/rpc-limit.ts`)이 먼저 버틴다: 429·5xx·끊긴 연결·시간 초과를 지수 백오프(500 ms → 15초 상한, 지터)로 **요청마다 기다림 합 ≈ 60초까지** 다시 보내고, `Retry-After` 를 지키며(남은 예산보다 길면 바로 포기 → 루프가 몇 분 뒤), 속도 제한을 받으면 **그 곳의 줄 전체를 멈춘다**(동시에 줄 선 다른 읽기도 같은 제한 창에 들어가지 않게). 예전에는 6번 · 합 ≈ 10초였고 거절된 요청만 물러났다 — 동시 16개 블록 읽기가 계속 제한 창을 두드려 재시도를 다 썼다.
- **게임과 다투지 않는다**: nice 19 + `cpu_shares: 128`(cgroup v2 에서는 nice 만으로 다른 컨테이너보다 뒤로 가지 않는다) + `mem_limit: 1g`. 키·DB 없음, `edge` 망만, 능력 0개·읽기 전용 루트. 한 실행 상한 50분.
- **결과**: 실행마다 `/var/lib/pikit-verify/verify-status.json` = `{ startedAt, finishedAt, ok, timedOut, transient, errorKind, epochsChecked, lastEpoch, epochsBehind, epochCap, rps, firstFailure, lastError, slowSince, transientSince, lastGoodAt, runs }`.
  `ok` = `true` 통과 · `false` 진짜 검증 실패 · `null` 끊김(`timedOut: true`) 또는 전송 오류(`transient: true`, D182) — 둘 다 실패가 아니라 아직 못 끝냄. **성공 못 한 실행은 앞 성공의 `lastEpoch`·`epochsBehind`·`epochCap`·`slowSince` 를 지우지 않는다**(`lastEpoch` 는 상태 파일이 검증한 끝 — 실패한 덩이의 끝이 아니다) — 어디까지 왔는지 계속 보인다. `epochsBehind` = 체인 마지막 앵커 에폭 − `lastEpoch`(up to date 면 0), `epochCap`·`rps` = 이번 덩이 상한·곳마다 초당 요청, **오류 칸 규칙(D183)**: `firstFailure` ⇔ `ok: false`(처음 실패한 검사 — 늘 글이 있다), `lastError` ⇔ `ok: null`(전송 오류 한 줄 또는 끊김 한 줄 — 늘 글이 있다), `ok: true` 면 둘 다 `null`. `errorKind` = 전송 오류의 종류 `"transport"` | `"tip-race"`(아니면 `null`). URL 은 호스트 + 경로만(쿼리·키 같은 조각 지움), `slowSince` = 끊김이거나 300 에폭 넘게 뒤처진 상태가 시작된 시각, `transientSince` = 전송 오류가 이어지기 시작한 시각, `lastGoodAt` = 마지막 성공 실행이 끝난 시각, `runs` = 이 볼륨에서의 실행 수 `{ total, ok, failed, timedOut, transient }`. 같은 볼륨을 읽기 전용으로 붙인 둘이 읽는다:
  - 감시(`deploy/monitoring/check.mjs`): `verify-fail`(**ok=false 만** — 실패한 검사 이름을 웹훅으로. 끊김·전송 오류는 아니다), `verify-slow`(경고: `slowSince` 가 `VERIFY_SLOW_MIN` 120분 넘음 = 끊김이 이어지거나 300 에폭 넘게 뒤처진 채 2시간, **또는 전송 오류가 2시간 넘게 이어짐**(`transientSince`)), `verify-stale`(120분 넘게 끝난 실행 없음 · 파일이 없음 · 읽을 수 없음).
  - api `GET /api/v1/metrics` → `verify: {…}`(파일이 없으면 `null`, 주소·URL 은 가림) — VM 에 들어가지 않고 누구나 본다.
- 대응: `deploy/RUNBOOKS.md` §14.

## 8. 2세계(개정 7): 시간당 루트를 공개 파일로 검증하는 법 (명세 20 §2.10·§2.11, 계획 `docs/plans/spec20-implementation.md`, D196·D197·D201)

> CLI = `apps/verifier-cli`(B5, D205), 검증 본체 = `packages/verifier/src/ledger-verify.ts`(`verifyLedger`)·체인 읽기 `ledger-rpc.ts`(`RpcLedgerSource`). 형식(서명·해시·파일 모양)은 A1(`packages/protocol/src/ledger.ts`·`ledger-files.ts`, D196), 장부 규칙은 A3(`packages/verifier/src/ledger/rules/**`, D199).

### 8.1 한 줄

구매·취소·오늘 받기는 이제 **서명만** 하고(가스 0), 서버가 크레딧 장부를 든다. 서버는 **약 1시간(60에폭 = 12,000블록)마다 장부 전체와 게임 상태의 지문(루트)을 `PikitLedger`에 올린다**.
누구나 공개 파일만으로 그 사이의 명단 → 장부 → 엔진을 다시 돌려 체인의 루트 10칸과 같은지 확인한다. 하나라도 다르거나 **빠지면** 종료 1.

### 8.2 무엇을 고정하나 (신뢰 뿌리)

| 값 | 어디서 | 왜 |
|---|---|---|
| `PikitLedger` 주소 + 체인 143 | 검증하는 사람이 고른다: `--contract <주소>` 또는 `--trust <파일>`(`{ contract, chainId?, ledgerHash?, rulesHash? }`, 준 값은 모두 대조). 탐색기·`/rules`·`deploy/mainnet/DEPLOYMENT.md`에서 확인 | 운영자 파일(`world.json`)이 아니다(D162와 같은 원칙). `world.json`의 `shop` 칸(= PikitLedger 주소)이 다르면 시작 전에 실패 |
| `rulesHash` = keccak256(catalogHash ‖ engineVersionHash), **6세계(현재)** = `{rulesHash}`(규칙 12 — 엔진·카탈로그는 G0 값, `ledgerHash`는 그대로, 공개 태그 `w6-rules12-<engine10>`) | 체인 불변값 `rulesHash()` ↔ 이 빌드의 엔진 해시 + 카탈로그 | 6세계는 **규칙 12 엔진·카탈로그**(5세계와 다름 — 막타 룰렛·HP 0 유예·CHOG Ore 2×2·LUCKY ORE 10종) |
| `rulesHash`, **5세계** = `0x5a04da5e4e2bd26ca3c4faedd8909c75e823d54d7bfb1d17a2f607fed61e2455`(규칙 11 — 엔진 `0xaa342f7aacc602df181e40037c31d9bad1b606b9e1a57594e33a5ba52780da5b`, 카탈로그 `0x85cd30d9c4ee92fe054f88cf96d4d623218a350ddee05ee589b7b3c6fcce775c`, `ledgerHash`는 그대로 `0xe219e71372f79bd55a2e679283176c5bd7c2ed49c58f35b922b381102808a4aa`, 공개 태그 `w5-rules11-aa342f7aac`) | 체인 불변값 `rulesHash()` ↔ 이 빌드의 엔진 해시 + 카탈로그 | 5세계는 **규칙 11 엔진·카탈로그**(4세계와 다름 — COMBO·POP/LUCKY 버프·정수 정산) |
| `rulesHash`, **4세계** = `0x131fb492d0acc6b82729243f0bfb954b754abe31713cad0a41c1ecebbcc12462`(규칙 10, D247–D249 — 엔진 `0x722d2bb82d291eec19ecce774f8b4a99ee7ab1212dec776b75bb3dee0e77fc46`, 카탈로그 `0x02ad4c1dc0090f7df46820910565ce062cb227c2afcf79d300e915b24902a1fd`, `ledgerHash`는 그대로 `0xe219e71372f79bd55a2e679283176c5bd7c2ed49c58f35b922b381102808a4aa`, 공개 태그 `w4-rules10-722d2bb82d`) | 체인 불변값 `rulesHash()` ↔ 이 빌드의 엔진 해시 + 카탈로그 | 4세계는 **규칙 10 엔진·카탈로그**(3세계와 다름 — 체력 ×1.7·LUCKY PICK·잭팟, 공개 파일 `/epochs-w4`) |
| `rulesHash`, **3세계** = `0x812f1346800b2e81c8cb5fe751191ef67da5e3478c4e3db9a084f911416a4f96`(규칙 9, D228–D230 — 엔진 `0x39d1ae79c2a38ef70a7f14af1f1cf806501301ccb1b2520318287657b3cd0129`, 카탈로그 `0x169cc202d804674cf400a149045b57ebdcad213a254f603d6c6a25c4c3eb2c8f`, `ledgerHash`는 2세계와 같은 `0xe219e71372f79bd55a2e679283176c5bd7c2ed49c58f35b922b381102808a4aa`, 공개 태그 `w3-rules9-39d1ae79c2`) | 체인 불변값 `rulesHash()` ↔ 이 빌드의 엔진 해시 + 카탈로그 | 3세계는 **규칙 9 엔진·카탈로그**(2세계와 다름, 공개 파일 `/epochs-w3`) |
| `rulesHash`, **2세계** = `0xe29ed968c364d067e4c05e948dcfbe9dfa04082fe0c2afdf0b2a43d489b3ac7a`(규칙 8, D215 — 엔진 `0x09f864b084d82cb27e0ddda5d93bf49c5a20e9f2b136af84fd8603635ccef2a5`, 카탈로그 `0x74698a8b9918454eb1ef07424f49d7e6781687275fd679a948d2f15fa3836cd2`. 1세계는 규칙 7 `0xccab66f9…344d`) | 체인 불변값 `rulesHash()` ↔ 이 빌드의 엔진 해시 + 카탈로그 | 2세계는 **규칙 8 엔진·카탈로그**(1세계와 다름, D215) |
| `ledgerHash` | 체인 불변값 `ledgerHash()` ↔ 이 빌드의 장부 규칙 해시(`packages/verifier/src/ledger/rules/**` + protocol `ledger.ts` 닫힘, `ledgerVersionHash`) | 장부 규칙도 체인에 고정 — 운영자가 서버와 공개 검증기를 함께 바꿔도 잡힌다 |
| `seedRoot`·`genesisBlock`(W0)·방 목록 | 체인 불변값 = `world.json` | 새 세계는 새 시드 사슬(옛 사슬 재사용 거부) |

### 8.3 체인에 무엇이 올라가나 (`PikitLedger`, `contracts/README.md` §8)

| 사건·읽기 | 칸 | 쓰임 |
|---|---|---|
| `WorldCreated(seedRoot, genesisBlock, rulesHash, ledgerHash, roomIds)` | 배포 때 한 번 | 신뢰 뿌리 |
| `RootPosted(index, Root)` | `Root { epoch, seed, throughWindow, roomsStateRoot, inputLogRoot, boardBatchRoot, ledgerRoot, payoutsRoot, supplyMilli, dataHash }` | 루트 k = `index`(0부터). `throughWindow = W0 + 200·epoch − 1`(그 에폭 마지막 윈도), 늘기만 한다 |
| `rootCount()` · `rootAt(k)` | `{ postedBlock, throughWindow, epoch, ledgerRoot }` | 저장된 두 칸(나머지 8칸은 이벤트에서) |
| `AnnouncerChanged(previous, next, fromWindow)` | ANNOUNCE 키 교체 — `fromWindow`(= 교체 블록 + 20) 창부터 새 키 | 창마다 명단 서명 키를 정한다 |
| `RootPosterChanged(previous, next)` · `SeedRevealed(epoch, seed)` | ROOT 키 교체 · 누구나 시드 공개 | 참고 |

시드: 루트가 `S_epoch`을 공개한다(사슬 검사 = 1세계와 같은 keccak 사슬). 에폭 파일의 1분 공개는 그대로.

### 8.4 루트 하나가 덮는 공개 파일과 `dataHash` 순서

루트 k가 에폭 `fromEpoch..toEpoch`를 덮는다: `fromEpoch` = 직전 루트의 epoch + 1(첫 루트는 1), `toEpoch` = 이 루트의 epoch. 파일 경로는 `https://chog.pikit.fun/epochs/` 아래 상대 경로다.

**경로 순서** (protocol `rootDataPaths(fromEpoch, toEpoch, k)` 그대로):

1. 에폭 e = fromEpoch, fromEpoch + 1, …, toEpoch 오름차순으로, 에폭마다 둘씩 번갈아 — `<e>.json`, `ledger/<e>.json`
2. 그다음 `snapshots/<toEpoch>.json`
3. 마지막 `ledger/leaves/<k>.json`

예: 루트 0이 에폭 1~60이면 `1.json, ledger/1.json, 2.json, ledger/2.json, …, 60.json, ledger/60.json, snapshots/60.json, ledger/leaves/0.json`(122개).

**해시** (protocol `dataHash`): 위 순서 그대로, 파일마다 `keccak256(utf8(경로))`(32바이트)와 `sha256(파일 바이트 그대로)`(32바이트)를 이어 붙이고, 전체를 keccak256 한다.

```
dataHash = keccak256( keccak256(utf8(path_0)) ‖ sha256(file_0) ‖ keccak256(utf8(path_1)) ‖ sha256(file_1) ‖ … )
```

경로는 `/` 구분 상대 경로(앞 `/`·`\` 없음). 파일 하나라도 바이트가 다르거나 빠지면 루트의 `dataHash`와 달라진다 → `files`·`dataHash` 실패.

| 파일 | schema | 내용 (모양 = protocol `ledger-files.ts`) |
|---|---|---|
| `<e>.json` | `pikit.inputlog/v3` (1세계와 **같다**) | 엔진 입력 기록. 2세계에서 입력은 체인 구매가 아니라 **서명된 명단**에서 온다: BUY → `PurchaseRecord{ blockNumber: w − 1, logIndex: 명단 순번, txHash: 의향서 다이제스트 }` |
| `ledger/<e>.json` | `pikit.ledger/v1` | `{ chainId, ledger, epoch, firstWindow, lastWindow, sessions[], lists[], blockTimestamps }` — 그 에폭의 명단 전부(창마다 `{ window, entriesHash, count, signer, signature, entries[], decisions[] }`), 쓰인 세션 허가(`{ session, signature, erc1271Block }`), 명단이 있는 창의 블록 timestamp |
| `snapshots/<toEpoch>.json` | 1세계와 같다 | 루트 경계의 세계 상태 (이어 받기 시작점) |
| `ledger/leaves/<k>.json` | `pikit.ledger-leaves/v1` | `{ rootIndex, epoch, throughWindow, nextPurchaseId, ledgerRoot, supplyMilli, leaves[] }` — 경계의 지갑 잎 전부(지갑 오름차순). 잎 = `keccak256(bytes.concat(keccak256(abi.encode(wallet, currency 0, balanceMilli, openStakeMilli, withdrawTotalMilli 0, lastSeq, lastGrantDay))))`, 루트 = OZ 정렬 쌍 머클 |

### 8.5 검사 (D205 — 보고서의 검사 이름 그대로, 루트마다 `root <k>: …`)

| # | 검사 | 실패 이름 |
|---|---|---|
| 0 | 신뢰 뿌리(체인을 읽기 전): `world.shop` = 고정한 PikitLedger, `world.engineVersionHash` = 이 빌드 엔진, `world.ledgerVersionHash` = 이 빌드 장부 규칙, 카탈로그 해시. 체인: `ledgerHash` = `LEDGER_VERSION_HASH`, `rulesHash` = keccak(catalogHash ‖ engineVersionHash), chainId·seedRoot·genesisBlock·방 목록(모두 W0에 생김) = `world.json`, `EPOCH_BLOCKS` = 200, `--trust`로 고정한 chainId·ledgerHash·rulesHash | `trust: …` |
| 1 | 범위 파일(§8.4)이 모두 있다 · 모양(입력 기록 v3·장부·스냅숏·잎)과 에폭이 맞다 | `root k: every public file of the range is published …` · `… public files have their formats …` |
| 2 | 시드: 루트의 S_epoch가 앞 루트의 시드(처음이면 seedRoot)까지 keccak으로 이어지고, 파일의 seed는 그 사슬과 같다 | `root k: seed chain …` |
| 3 | 명단 서명자 = 그 창의 ANNOUNCE 키(창 w의 키 = fromWindow ≤ w인 마지막 `AnnouncerChanged`의 next) | `root k: list signatures = the ANNOUNCE key of each window …` |
| 4 | 명단 항목 = 서명된 entriesHash(ref·count·순서) | `root k: list entries = the signed entriesHash …` |
| 5 | 의향서: 세션 키 서명·EOA 지갑 서명은 장부 재생(→ 6)이, 스마트 지갑 세션은 RPC로 `erc1271Block`에서 `isValidSignature` = 0x1626ba7e(ERC-6492는 안쪽 서명, 그 블록에 지갑이 배포돼 있어야 한다) · 명단 창의 블록 timestamp(파일) = 체인 | `root k: intent auth: …` · `root k: list block timestamps = chain block timestamps` |
| 6 | 장부 재생(같은 `ledgerWindow`): 결정(받음·거절·이유·purchaseId) = 파일 · 범위 밖 명단 없음 | `root k: ledger decisions = replay …` · `… every list lies inside the root's windows` · `… ledger + engine replay` |
| 7 | 입력 = 명단: `checkInputLinkage`(MISSING·EXTRA·WINDOW·FIELDS·ORDER·DUPLICATE) · 입력 기록 해시 사슬(prevHead·head) | `root k: inputs = signed lists …` · `root k: input log hash chain …` |
| 8 | 엔진 재생 → 끝난 묶음마다 시드 + 블록 해시로 다시 생성 | `root k: board batches regenerated …` |
| 9 | 잎 파일 = 재생 잎 · 경계 스냅숏 = 재생 세계 · 루트 10칸(epoch·seed·throughWindow·roomsStateRoot·inputLogRoot·boardBatchRoot(범위 안에서 끝난 묶음)·ledgerRoot·payoutsRoot·supplyMilli·dataHash) = 체인 `RootPosted` — 다른 칸 이름이 `rootResults[k].mismatchedFields`에 | `root k: leaves file = replayed ledger` · `… boundary snapshot = replayed world …` · `… root fields = chain RootPosted …` |
| 10 | 불변식: 지갑마다 openStake = 엔진의 살아 있거나 대기 중인 곡괭이 가격 합, 공급 = 시작 + GRANT − 손실, balance·openStake ≥ 0 (하루 GRANT ≤ 1·상한은 6의 결정이 강제) | `root k: ledger invariants …` |
| 11 | RPC 2곳이 모든 체인 값(불변값·루트·키 교체·블록 해시·timestamp·ERC-1271)에 동의 | `the RPC endpoints agree on every chain fact read` |
| — | 시작 경계(루트 j): 스냅숏 = 루트 j의 roomsStateRoot·inputLogRoot, 잎 파일 = ledgerRoot·supplyMilli, 이어 받기면 체인 루트 j = 상태 파일 | `start: …` |

1세계의 정산 대조(`AMOUNT`·`KIND`·`VOID_OVER`·`OVERDUE`)·무효·동결·`catalogOf` 가격표 줄은 2세계에 없다 — 정산은 체인 tx가 아니라 장부 안에서 바로 일어나고, 가격은 rulesHash 불변값이 묶는다.

### 8.6 증명하지 **못하는** 것 (솔직하게)

| 못 하는 것 | 왜 | 대신 |
|---|---|---|
| 명단이 블록 w **전에** 나왔는지 | 서버(ANNOUNCE 키)가 서명 시각을 정한다. 블록 해시를 본 뒤 그 창 구매를 안 받는 일('보고 안 받기')은 화면에 보이지만 증명은 못 한다 | 명단은 제안 머리 w − 2에 닫고 커밋 뒤 방송, 영수증 저장. 크기는 A4가 잰다(결과를 여기 적는다). CHOG 전에 독립 증인(층 ②) |
| 오늘 받기 자격(CHOG 보유·Turnstile·새 지갑 상한) | api가 정하고 명단 GRANT로 들어온다 | 장부는 하루 1번·상한(`GRANT_MAX_MILLI`)만 강제하고, 루트마다 `supplyMilli`가 공개된다 |
| 검열(받지 않은 의향서) | 명단에 없는 의향서는 파일에 없다 | 본인 화면에 LATE·거절이 보인다. 뒤로(웨이브 E): `verify --receipts`(모은 영수증 ≠ 공개 명단 → 실패) |

크레딧은 돈이 아니다(출금·전송 없음) — 해커톤 기간 이 약점을 받아들인다(계획 §2.6).

### 8.7 명령

```sh
git clone <공개 검증 저장소> && cd <저장소> && git checkout <태그>   # 6세계 w6-rules12-<engine10> · 5세계 w5-rules11-aa342f7aac · 4세계 w4-rules10-722d2bb82d · 3세계 w3-rules9-39d1ae79c2 · 2세계 w2-ledger-e219e71372 (맨 위 세계 표), 세계는 --contract 로 고정
pnpm install --frozen-lockfile && pnpm --filter "@pikit/verifier-cli..." build
node apps/verifier-cli/dist/main.js verify --contract <PikitLedger> --root latest \
  --dir https://chog.pikit.fun/epochs --rpc https://rpc.monad.xyz,https://rpc1.monad.xyz
# 기본 = 마지막 루트 하나(바로 앞 루트의 경계 스냅숏 + 잎 파일에서). 루트 k 하나: --root <k>. 루트 j 경계부터: --from-snapshot <j>.
# 처음부터 전부: --from-snapshot genesis. ledgerHash 까지 고정: --trust trust.json  ({ "contract": "0x…", "ledgerHash": "0x…" })
# 감시자: --since-state <파일> --write-state <파일> --max-roots N (§8.8). --json = 보고서 전체(ok · upToDate · trust · roots · epochs · start ·
#   rootResults · ledger · linkage · checks · missing · disagreement)
```

웹 검증 패널(C1, D200)과 공개 저장소 `PUBLIC.md`(B5)가 보여 주는 명령도 정확히 `verify --contract <PikitLedger> --root latest …` 이 모양이다(계획 §5).

종료 코드는 1세계와 같다(0 통과 · 1 검증 실패 · 2 사용법 · 3 전송 오류/체인 끝 경합, D182·D183).

### 8.8 이어 받기와 감시자 (§7의 2세계판)

- **상태 = 마지막으로 검증한 루트 번호와 그 칸들.** 다음 실행은 그 경계 스냅숏(`snapshots/<epoch>.json`) + 잎 파일(`ledger/leaves/<k>.json`)에서 시작해 체인 마지막 루트까지(`--since-state`·`--write-state`, 한 실행 `--max-roots`씩). 시작 잎 파일의 ledgerRoot가 상태와 다르면 실패. 정산 시한을 기다릴 일이 없어 1세계의 `openFromWindow`는 없다.
- **실패한 실행은 상태를 올리지 않는다**(1세계와 같은 규칙 — 공백 없음).
- **매시간 → 루트마다**: VM `verifier` 컨테이너(`deploy/verifier/loop.mjs`, env `LEDGER_ADDRESS`·`VERIFY_MAX_ROOTS`(기본 1)·`VERIFY_INTERVAL_SEC`(기본 600)) 한 덩이 = 루트 하나(60에폭 ≈ 6.5분), 밀렸으면 바로 다음 덩이. 상태 파일(`pikit.verify-state/v2`) = `{ lastRoot, epoch, throughWindow, roomsStateRoot, inputLogRoot, ledgerRoot, … }`. 결과 파일 칸 = `ok · timedOut · transient · errorKind · rootsChecked · lastRoot · rootsBehind · rootCap · rps · firstFailure · lastError · slowSince · transientSince · lastGoodAt · runs` + 한 릴리스 동안 개정 6 이름 `epochsChecked · lastEpoch · epochsBehind`(에폭 단위, api metrics가 읽는다 — `epochCap`은 없어졌다). 감시 `verify-slow`는 `rootsBehind > VERIFY_SLOW_BEHIND_ROOTS`(기본 5 = 300에폭) 경보는 **경계 + 15분** 안에 검증이 안 끝나면(`verify-stale` 기준을 루트 주기에 맞춤). 운영 감시의 `root-late`(경계 + `ROOT_GRACE_BLOCKS` 3,000블록 ≈ 15~20분)와 짝이다 — 대응은 `deploy/RUNBOOKS.md` §17.
- GitHub `verify-mainnet.yml`·`verify-testnet.yml`(2차): 저장소 변수 `VERIFY_MAINNET_CONTRACT`(PikitLedger 주소, 사람이 고정) · 선택 `VERIFY_MAINNET_LEDGER_HASH`(있으면 `--trust`로 ledgerHash도 고정) · `VERIFY_MAINNET_FILES_URL` · `VERIFY_MAINNET_RPC_URLS` · `VERIFY_MAX_ROOTS`(VM 5 · 호스팅 2). 기본 러너는 VM self-hosted(호스팅 분 0), 옛 `VERIFY_MAINNET_SHOP`은 쓰지 않는다.
- 비용: 루트 하나 ≈ 12,000블록 → 블록 해시 ≈ 6,000번/곳(20 req/s ≈ 5분) + 장부 재생(서명 복구·잎 해시, 지갑 수에 비례 — 수천 지갑이면 몇 초) [추정 — D2 리허설에서 잰다].
