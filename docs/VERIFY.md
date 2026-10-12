# 공개 검증 (`pikit-verify verify`) — 무엇을 확인하고, 무엇을 믿나

> 2026-10-12, wave D3 (명세 `docs/specs/17-mainnet.md` G8 · §3.4-4 a–e·g · P0-7 · P0-16, 감사 `_analysis/manipulation-audit-2026-10-12/report.md` F-1 ② · F-2, 개정 6 `docs/contracts-rev6-migration.md` §3.4).
> 남이 치는 명령은 `apps/verifier-cli/PUBLIC.md`(영어), 옵션 전체는 `apps/verifier-cli/README.md`.

## 1. 한 줄

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

위조 기록 시험(`packages/verifier/test/demo-bundle.ts`의 지급 속임, CLI 시험 `forged-*`): `nosettle`(over > 0 정산 빠뜨림 → `OVERDUE`), `overzero`(over를 0으로 → `AMOUNT`), `voidover`(무효 over 안 줌 → `VOID_OVER`), `missingfile`(4.json 미공개 → 파일 검사).

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
- 그래서 매시간 감시자(`.github/workflows/verify-*.yml` → `_verify.yml`, §7)는 한 실행이 1시간 + 겹침 30분 ≈ 9,000 getBlock/곳(20 req/s에 약 8분)이다. 밀린 구간은 `--max-epochs`(기본 600 에폭 ≈ 50분)씩 나눠 따라잡는다.

## 6. 테스트넷 실제 실행 (2026-10-12)

`verify --dir https://chog.pikit.fun/epochs --rpc https://testnet-rpc.monad.xyz,https://rpc.ankr.com/monad_testnet --epoch latest --from-snapshot latest` →
`✘ engine build = world.engineVersionHash` (세계 `0xe95d…43b9` = 규칙 6 엔진, 이 검증기 `0xf8ab…636d` = 규칙 7), 종료 1, 1초 안(체인·파일을 읽기 전에 멈춤).
규칙 7 세계(R4 재배포) 전에는 통과할 수 없는 것이 정상이다. RPC 두 곳 읽기 자체(앵커 탐색·로그·블록 해시 대조)는 같은 날 테스트넷에서 확인했다(§5).

## 7. 매시간 외부 감시자 — 공백 없이 이어 받기 (리뷰 rev6 H-1 · M-1, D163)

### 7.1 왜 매시간, 왜 이어 받기

체인이 스스로 드러내는 것은 **정산을 안 보낸 것**뿐이다: 끝 정산이 없으면 구매 블록 + 6,001(30분)에 판매가 멈춘다. **정산을 보내되 작게(0으로·Refund로) 보내거나, 무효가 된 구매의 over를 안 주는 것은 체인 신호가 없다** — 판매도 안 멈추고, 그 뒤 환불 길도 닫힌다(리뷰 rev6 M-1, PoC R6-01·R6-02). 이것을 잡는 것은 검증기의 정산 대조(`AMOUNT`·`KIND`·`VOID_OVER`)뿐이고, 그것도 **다음 검증 실행에서만** 잡힌다. 그래서:

- 감시자는 **매시간**(`17 * * * *`) 돈다 — 조용한 축소가 드러나기까지 최대 약 1.5시간(실행 간격 + 정산 시한 30분).
- 시작점은 시계가 아니라 **앞 성공 실행이 남긴 `verify-state.json`**이다: `{ 검증한 마지막 에폭, 다음 시작 앵커(번호·roomsStateRoot), openFromWindow, … }`. 다음 실행은 그 앵커의 스냅숏에서 체인의 마지막 앵커까지 검증한다(밀렸으면 `--max-epochs`씩 따라잡기). 시작 앵커의 roomsStateRoot가 상태 파일과 다르면 실패.
- **실패한 실행은 상태를 올리지 않는다** — 다음 실행이 같은 곳에서 다시 시작해 다시 실패한다. 사이의 에폭 파일이 하나라도 없으면 실패(`every referenced epoch file … is published`)라 조용히 건너뛸 길이 없다. 상태 산출물이 하나도 없으면(첫 실행, 또는 90일 넘게 성공 없음) 처음부터 검증한다(비싸지만 공백은 아니다).
- 리뷰 PoC `daily-gap.mjs`의 다섯 경우(정시·20분·60분 늦음·0.29초 블록·하루 실패)와 48시간 매시간(지연 0~25분, 실패 3번)을 이 방식으로 다시 돌리면 **공백 0**이다(`_analysis/review-rev6-verifier-2026-10-12/poc/daily-gap-resume.{mjs,out.txt}`).
- 실패하면 저장소 비밀값 `VERIFY_ALERT_WEBHOOK`(Discord 웹훅 URL)이 있을 때 Discord로 실패 검사 이름과 실행 링크를 보낸다. 없으면 GitHub의 실패 메일(워크플로를 켠 계정)뿐이다.

명령(감시자가 매시간 치는 것):

```sh
node apps/verifier-cli/dist/main.js verify --shop <PikitShop> --epoch latest \
  --since-state state/verify-state.json --write-state out/verify-state.json --max-epochs 600 \
  --dir <에폭 파일 URL> --rpc <공급자 A>,<공급자 B> --max-rps 20 --json > report.json
```

### 7.2 운영자가 관리하지 않는 곳에서 돌린다

이 저장소의 워크플로는 **운영자의 저장소 변수**(상점 주소·파일 주소·RPC)를 읽고 운영자 계정에서 돈다 — 운영자가 끄거나 바꿀 수 있다. 감시자가 의미를 가지려면 **운영자가 관리하지 않는 GitHub 계정의 포크**에서도 돌아야 한다(가디언 개인, 외부 감사인, 커뮤니티 사람 누구든). 두 번째 사람이 하는 일:

1. 공개 검증 저장소(또는 이 저장소)를 **자기 계정으로 포크**한다. 포크에서는 예약 워크플로가 기본으로 꺼져 있다 — 포크의 **Actions** 탭에서 워크플로를 켠다.
2. 포크의 **Settings → Secrets and variables → Actions → Variables**에 넣는다:
   - `VERIFY_MAINNET_SHOP`(또는 `VERIFY_TESTNET_SHOP`): PikitShop 주소 — **자기가 직접 확인한 값**(지갑이 서명한 EIP-712 `verifyingContract`, 탐색기의 `Purchased` 사건을 낸 컨트랙트, 웹 `/rules`. 운영자의 `world.json`을 그대로 베끼지 않는다).
   - `VERIFY_MAINNET_FILES_URL`: 공개 에폭 파일 주소.
   - `VERIFY_MAINNET_RPC_URLS`: 쉼표로 두 곳, **서로 다른 공급자**, 적어도 하나는 자기가 고른 것(같은 호스트 두 번은 거부된다, 같은 도메인은 경고).
   - (선택) `VERIFY_MAX_RPS`(기본 20), `VERIFY_MAX_EPOCHS`(기본 600).
3. (선택) **Secrets**에 `VERIFY_ALERT_WEBHOOK` = 자기 Discord 채널의 웹훅 URL(채널 설정 → 연동 → 웹후크 → 새 웹후크 → URL 복사). 없으면 실패 메일만 온다 — 계정의 Actions 알림 메일을 켜 둔다.
4. **Actions → verify-mainnet → Run workflow**로 한 번 돌려 초록인지, 요약의 `shop · chain · fairness · engine`이 자기가 아는 값인지 본다. 첫 실행은 처음부터 검증한다(오래 걸리면 `--max-epochs`씩 다음 시간에 이어 간다).
5. GitHub는 활동이 없는 저장소의 예약 워크플로를 60일 뒤 끈다 — 끔 알림 메일이 오면 다시 켠다(또는 가끔 빈 커밋).

상태(`verify-<망>-state`)와 보고서(`verify-<망>-report`)는 그 포크의 작업 산출물로 90일 남는다. 상태를 지우면 다음 실행은 처음부터 검증한다.
