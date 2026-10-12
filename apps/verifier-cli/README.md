# @pikit/verifier-cli — `pikit-verify`

규칙표와 입력 기록 파일을 받아 공개 엔진으로 재생하고, 끝 상태 해시와 곡괭이별 정산 값(체인 settle과 대조할 값)을 출력하는 명령이다. 운영자가 아닌 사람도 같은 결과를 계산할 수 있다는 것을 보여 준다.

## 사용법 (저장소 루트에서)

```bash
pnpm install
pnpm -r build
node apps/verifier-cli/dist/main.js \
  --catalog packages/protocol/catalog.example.json \
  --log packages/verifier/test/fixtures/golden-1.log.json
```

옵션:

| 옵션 | 뜻 |
|---|---|
| `--catalog <파일>` | 규칙표 JSON (`pikit.catalog/v1`) |
| `--log <파일>` | 입력 기록 JSON (`pikit.inputlog/v0`) |
| `--json` | 사람이 읽는 표 대신 JSON 보고서 |
| `--expect <파일>` | 기대 보고서와 끝 상태 해시를 비교. 다르면 종료 코드 1 (골든 재생) |

출력 예 (일부):

```
finalStateHash   0xd7a0971c6aef8fa6581fde5e2e28dec15f956fe98ee7d3eb5b972979e7cf543e
pickaxe            owner        tier  status  end         price(cr)   base(cr)  lucky(cr)  bonus(cr)   paid(cr)   over(cr)  POP  BIG
7000:0             0xd1a00000…  FE    ENDED   DURABILITY   1000.000    481.592    197.947    505.000    900.000    284.539    Y    Y
```

## 에폭 검증: `verify`

남이 그대로 치는 명령(영어)은 **`PUBLIC.md`**, 무엇을 확인하고 무엇을 믿는지는 **`docs/VERIFY.md`**.

```bash
# 누구나, 공개 파일 + 공개 RPC 두 곳(교차 확인): 구매 하나. --shop = 직접 확인한 PikitShop 주소(필수, D162)
node apps/verifier-cli/dist/main.js verify --shop <상점 주소> --purchase <id> \
  --dir https://chog.pikit.fun/epochs --rpc https://testnet-rpc.monad.xyz,https://rpc.ankr.com/monad_testnet
# 어제치
node apps/verifier-cli/dist/main.js verify --shop <상점 주소> --epoch latest --from-snapshot latest \
  --dir https://chog.pikit.fun/epochs --rpc https://testnet-rpc.monad.xyz,https://rpc.ankr.com/monad_testnet
# 처음부터 에폭 N까지
node apps/verifier-cli/dist/main.js verify --shop <상점 주소> --epoch N --dir <INPUT_LOG_DIR 또는 URL> --rpc <RPC URL>
# 예제 묶음 (방 2개, 에폭 7개, 체인 값은 chain.json 파일). 두 번째 인자 = 속임(입력 delay|retier|dropcancel|extra, 지급 nosettle|overzero|voidover|missingfile), 세 번째 = 에폭 수
node packages/verifier/dist/test/demo-bundle.js /tmp/pikit-bundle [cheat|""] [epochs]
node apps/verifier-cli/dist/main.js verify --shop 0x5b0b000000000000000000000000000000000005 --epoch 7 --dir /tmp/pikit-bundle [--from-snapshot 3]
```

| 옵션 | 뜻 |
|---|---|
| `--shop <주소>` | **필수**(또는 `--trust`): 검증하는 사람이 지갑 서명·탐색기·`/rules`에서 확인한 PikitShop 주소. `world.json`의 shop과 다르면 체인·파일을 읽기 전에 실패. 보고서 맨 위에 신뢰 뿌리(체인 id·상점·공정성·seedRoot·엔진·방마다 카탈로그 → 규칙) |
| `--trust <파일>` | 따로 받은 JSON `{ shop, chainId?, fairness?, seedRoot?, engineVersionHash? }` — 준 값은 모두 대조. `--shop`과 함께면 같아야 한다 |
| `--dir <폴더\|URL>` | 공개 파일: `world.json`, `catalogs/<catalogHash>.json`, 에폭 입력 기록 v3, `snapshots/<E>.json`. URL이면 game-server INPUT_LOG_DIR 모양(`<dir>/<n>.json`) |
| `--epoch <N\|latest>` | 마지막 에폭. `latest` = 체인 마지막 앵커가 덮은 에폭 |
| `--from-snapshot <E\|latest>` | 에폭 E 끝 스냅숏(= 체인 앵커 루트)에서 시작. `latest` = 끝에서 하루 + 30분 이상 앞선 마지막 앵커 에폭(세계가 더 어리면 처음부터). 없으면 처음부터 |
| `--purchase <id>` | 그 구매 블록 앞의 마지막 앵커 스냅숏에서 시작, 끝은 `--epoch`(기본 latest). 곡괭이마다 재생 값 ↔ 체인 기록 줄 |
| `--epochs <폴더\|URL>` | 에폭 파일 위치(기본: 폴더면 `<dir>/epochs`, URL이면 `<dir>`). 스냅숏은 `<여기>/snapshots/` |
| `--rpc <url1>[,<url2>]` | 체인 값을 RPC에서 바로 읽는다(확정 블록). 두 곳이면 **모든 값**을 두 곳에서 읽어 대조, 다르면 실패. 두 곳은 서로 다른 공급자 — 같은 호스트면 종료 2, 같은 도메인이면 경고 |
| `--chain <파일>` | 체인 값 파일(`pikit.chain/v3` + `voidOverPaid`, 기본 `<dir>/chain.json`). 운영자의 말 — stderr 경고. `--rpc`와 함께 못 쓴다. URL `--dir`이면 `--rpc` 또는 `--chain` 필수 |
| `--since-state <파일>` | 앞 성공 실행이 남긴 `verify-state.json`의 시작 앵커 스냅숏에서 체인 마지막 앵커까지(감시자, D163). 파일이 없으면 처음부터, 새 에폭이 없으면 `up to date`(종료 0). 시작 앵커의 roomsStateRoot가 다르거나 상점·엔진이 다르면 실패. `--from-snapshot`·`--purchase`와 함께 못 쓴다 |
| `--write-state <파일>` | 성공했을 때만 다음 시작점을 쓴다(실패면 그대로 — 다음 실행이 같은 곳에서 다시) |
| `--max-epochs <n>` | 한 실행에 n 에폭까지(끝 = 그 안의 마지막 앵커 에폭) — 밀린 구간을 나눠 따라잡는다 |
| `--through <블록>` | `--rpc`와 함께: 사건을 읽는 마지막 블록(기본 확정 머리) |
| `--max-rps <n>` | RPC 곳마다 + HTTP 파일 읽기의 초당 요청 상한(기본 20). 429·-32005·-32007·시간 초과는 백오프 뒤 다시 |
| `--log-chunk <n>` | `--rpc`와 함께: `eth_getLogs` 한 번의 블록 수(기본 100, 범위 오류면 반으로) |
| `--json` | 보고서 전체(JSON) |

**실패(종료 1)**: 엔진 해시 다름(체인·파일을 읽기 전에), 에폭 파일·시작 스냅숏 없음, RPC 두 곳 불일치, 입력 = 체인 사건 어긋남, 시드·기록 사슬, 앵커 루트, 묶음, 정산(`AMOUNT`·`KIND`·`BUYER`·`NOT_PAID`·`VOID_PURCHASE`·`DUPLICATE`·`OVERDUE`·`VOID_OVER`·`VOID_OVER_AMOUNT`·`VOID_OVER_EXTRA`). 시한 전 미지급은 경고(`unsettled`). 종료 2 = 사용법 오류. RPC 오류 줄에는 URL을 쓰지 않는다(키가 URL에 들어 있을 수 있다).

**속도**: 재생 ≈ 2,500 에폭/분(데모, 노트북), RPC가 병목 — 블록 해시 윈도 2개에 요청 1번(하루 ≈ 14.4만 번/곳, 20 req/s ≈ 2시간). `docs/VERIFY.md` §5.

**공개 묶음 확인**: `scripts/public-subtree-check.sh` — 네 패키지만 꺼내 새 작업공간에서 설치·빌드·골든·데모(정직·스냅숏·위조)를 돌린다(`PUBLIC_CHECK_OFFLINE=1`이면 pnpm 캐시만).

시험: `pnpm --filter @pikit/verifier-cli test` — 골든 재생 3개, 예제 묶음 검증, `test/cli.test.mjs`(정직 → 0, 입력 속임 네 가지 → 1, 위조 지급 기록 `forged-nosettle`·`forged-overzero`·`forged-voidover`·`forged-missingfile` → 1과 ✘ 한 줄, 스냅숏 시작·변조·누락, `--epoch latest`, `--purchase`, 사용법 오류, 닿지 않는 RPC). RPC 읽기·두 곳 교차 확인은 검증기 단위 시험(`packages/verifier/test/rpc-source.test.ts`)과 anvil e2e가 맡는다.

## 아직 없는 것 (ROADMAP)

- npm `pikit-verify`(엔진 해시 고정) — 출시 뒤 4주(P1). 지금은 공개 저장소를 빌드한다(`PUBLIC.md`).
- 체인만으로 입력 재구성(운영자 파일 없이, 명세 17 P0-16 f) — 출시 뒤 4주.
