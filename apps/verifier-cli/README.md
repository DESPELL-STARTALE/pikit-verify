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
pickaxe            owner        tier  status  end         price(cr)   base(cr)  lucky(cr)  bonus(cr) lastHit(cr)   paid(cr)   over(cr)  POP  BIG   LH
7000:0             0xd1a00000…  FE    ENDED   DURABILITY   1000.000    481.592    197.947    505.000       0.000    900.000    284.539    Y    Y    0
```

`lastHit(cr)`·`LH` = 막타(규칙 9, LAST HIT) 몫과 횟수. 번 것 E = base + lucky + bonus + lastHit → paid = min(E, REWARD 상한), over = 나머지. 규칙 8 이전 기록은 0.

## 세계 검증: `verify` (개정 7 — 시간당 장부 루트, D205)

남이 그대로 치는 명령(영어)은 **`PUBLIC.md`**, 무엇을 확인하고 무엇을 믿는지는 **`docs/VERIFY.md` §8**.

세계 표 (공개 저장소 태그 규칙 D229 — 세계마다 계약 하나·공개 폴더 하나·태그 하나):

| 세계 | 기간 | 계약 | 공개 저장소 태그 | `--dir` |
|---|---|---|---|---|
| 5 — PikitLedger 규칙 11 (COMBO · POP/LUCKY 버프 · 정수 정산) | {W5 start} → | 새 PikitLedger (`deploy/mainnet/DEPLOYMENT.md` 맨 위) | `w5-rules11-{engine10}` — 배포 도구 `verifierTagFor`가 빌드에서 계산(`pnpm bootstrap:mainnet`이 찍는다, D248, `WORLD = 5`) | `https://chog.pikit.fun/epochs` |
| 4 — PikitLedger 규칙 10 (LUCKY PICK · 골든 CHOG 잭팟) | 2026-10-19 05:49 UTC → {W5 start} | `0x6456a33a3185D000B7DeEF3901F5B9FAbC963Ca8` | `w4-rules10-722d2bb82d` | `https://chog.pikit.fun/epochs-w4` |
| 3 — PikitLedger 규칙 9 (막타) | 2026-10-16 05:35 UTC → 2026-10-19 05:49 UTC | `0x21036eBe95b8bD56fd1268Bb94c587c599f4D6ef` | `w3-rules9-39d1ae79c2` | `https://chog.pikit.fun/epochs-w3` |
| 2 — PikitLedger 규칙 8 | 10-14 → 2026-10-16 05:35 UTC | `0xDcd661D0ee623F714134DB0Ba0467549B8115C02` | `w2-ledger-e219e71372` | `https://chog.pikit.fun/epochs-w2` |
| 1 — PikitShop (체인 구매) | 10-12 → 10-14 | 상점 `0xB0FAf7eA64b44daa7246Bac43aBf9e16f7a47e0C` | `engine-ac38812c12` (옛 CLI `--shop`·`--epoch`) | `https://chog.pikit.fun/epochs-rev6` |

```bash
# 누구나: 마지막 루트 하나(바로 앞 루트 경계에서) — 웹 검증 패널이 보여 주는 명령 그대로. --contract = 직접 확인한 PikitLedger 주소(필수)
node apps/verifier-cli/dist/main.js verify --contract <PikitLedger> --root latest \
  --dir https://chog.pikit.fun/epochs --rpc https://rpc.monad.xyz,https://rpc1.monad.xyz
# 처음부터 전부 / 루트 j 경계부터 k까지
node apps/verifier-cli/dist/main.js verify --contract <PikitLedger> --root latest --from-snapshot genesis --dir … --rpc …
node apps/verifier-cli/dist/main.js verify --contract <PikitLedger> --root <k> --from-snapshot <j> --dir … --rpc …
# 예제 묶음 (루트 3개, 체인 값은 chain.json 파일). 두 번째 인자 = 속임 leaf|missing|tip|announce
node packages/verifier/dist/test/ledger-demo-bundle.js /tmp/pikit-bundle [cheat]
node apps/verifier-cli/dist/main.js verify --contract 0x1ed6e00000000000000000000000000000000007 --from-snapshot genesis --dir /tmp/pikit-bundle
```

| 옵션 | 뜻 |
|---|---|
| `--contract <주소>` | **필수**(또는 `--trust`): 검증하는 사람이 지갑 서명(EIP-712 `PIKIT-LEDGER` verifyingContract)·탐색기·`/rules`에서 확인한 PikitLedger 주소. `world.json`의 shop과 다르면 체인·파일을 읽기 전에 실패 |
| `--trust <파일>` | 따로 받은 JSON `{ contract, chainId?, ledgerHash?, rulesHash? }` — 준 값은 모두 체인과 대조. `--contract`와 함께면 같아야 한다 |
| `--dir <폴더\|URL>` | 공개 파일(한 폴더): `world.json`, `catalogs/<catalogHash>.json`, `<e>.json`, `ledger/<e>.json`, `snapshots/<e>.json`, `ledger/leaves/<k>.json` |
| `--root <k\|latest>` | 마지막으로 검증할 루트(기본 latest = 체인 마지막 루트) |
| `--from-snapshot <j\|genesis>` | 시작 = 루트 j 경계(스냅숏 + 잎 파일, 루트 j 칸과 대조) 또는 처음부터. 없으면 `--root` 바로 앞 루트(= 루트 하나) |
| `--rpc <url1>[,<url2>]` | 체인 값을 RPC에서 바로(확정 블록). 두 곳이면 **모든 값**을 대조, 다르면 실패. 같은 호스트면 종료 2, 같은 도메인이면 경고 |
| `--chain <파일>` | 체인 값 파일(`pikit.ledger-chain/v1`, 기본 `<dir>/chain.json`) — 운영자의 말, stderr 경고. URL `--dir`이면 `--rpc` 또는 `--chain` 필수 |
| `--since-state <파일>` | 앞 성공 실행이 검증한 마지막 루트 경계에서 체인 마지막 루트까지(감시자, 상태 `pikit.verify-state/v2`). 파일이 없으면 처음부터, 새 루트가 없으면 `up to date`(종료 0). 다른 PikitLedger·엔진·장부 규칙이면 실패. `--from-snapshot`과 함께 못 쓴다 |
| `--write-state <파일>` | 성공했을 때만 다음 시작점(루트 번호 + 칸)을 쓴다 |
| `--max-roots <n>` | 한 실행에 n 루트까지 — 밀린 구간을 나눠 따라잡는다 |
| `--max-rps <n>` | RPC 곳마다 + HTTP 파일 읽기의 초당 요청 상한(기본 20) |
| `--log-chunk <n>` | `--rpc`와 함께: `eth_getLogs` 한 번의 블록 수(기본 100, 범위 오류면 반으로) — PikitLedger 로그(ANNOUNCE 교체)만 읽는다 |
| `--json` | 보고서 전체(`ok`·`upToDate`·`trust`·`roots`·`epochs`·`start`·`rootResults`·`ledger`·`linkage`·`checks`·`missing`·`disagreement`) |

**검사**(이름은 `docs/VERIFY.md` §8.5 표): 신뢰 뿌리(`trust: …`) → 루트마다 파일·모양·시드·입력 기록 사슬·명단 서명자·명단 항목·ERC-1271 세션·명단 창 timestamp·장부 재생 결정·범위 밖 명단·입력 = 명단·묶음 생성·불변식·잎 파일·경계 스냅숏·루트 10칸. 첫 실패 루트에서 멈춘다.
**종료 코드**: 0 통과 · 1 검증 실패(파일 누락·RPC 불일치 포함) · 2 사용법 · 3 전송 오류(HTTP 429·5xx·시간 초과·연결, `--json`이면 `{ ok: null, errorKind: "transport", error }`) 또는 체인 끝 경합(없는 파일이 모두 확정 머리 − 400블록보다 늦게 실린 루트의 것, `errorKind: "tip-race"`, D183). HTTP 오류 줄은 상태 코드 또는 밑 원인을 싣고 URL은 호스트 + 경로만.

**속도**: 루트 하나(≈ 12,000블록) = 블록 읽기 ≈ 6,000번/곳(명단 창은 timestamp 때문에 그 블록을 따로) → 20 req/s ≈ 5분, 재생은 몇 초.

**공개 묶음 확인**: `scripts/public-subtree-check.sh` — 네 패키지만 꺼내 새 작업공간에서 설치·빌드·골든·데모(처음부터·마지막 루트·위조 잎)를 돌린다(`PUBLIC_CHECK_OFFLINE=1`이면 pnpm 캐시만).

시험: `pnpm --filter @pikit/verifier-cli test` — 골든 재생 3개, 예제 묶음 검증, `test/cli.test.mjs`(정직 → 0, 위조 leaf·announce → 1과 그 ✘, 오래된 파일 누락 → 1, 방금 실린 루트 파일 누락 → 3 tip-race, 신뢰 뿌리, 상태 v2 이어 받기·up to date·실패 시 상태 그대로, 가짜 JSON-RPC 서버 두 곳 교차 확인, 닿지 않는 RPC·끊긴 파일 서버 → 3, HTTP 404·403, 오류 분류). RPC 읽기 자체는 검증기 단위 시험(`packages/verifier/test/ledger-rpc.test.ts`).

## 아직 없는 것 (ROADMAP)

- npm `pikit-verify`(엔진 해시 고정) — 출시 뒤 4주(P1). 지금은 공개 저장소를 빌드한다(`PUBLIC.md`).
- 체인만으로 입력 재구성(운영자 파일 없이, 명세 17 P0-16 f) — 출시 뒤 4주.
