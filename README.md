# Verify PIKIT yourself

PIKIT keeps a credit ledger off chain: buying, cancelling and the daily grant are signatures only (no gas). About once an
hour the operator posts a **root** of the whole ledger and of the game world to the `PikitLedger` contract on Monad. This
tool replays the public files with the public engine and the public ledger rules and checks, **against the chain itself**,
that every root is exactly what the rules produce from the signed window lists. You need no account, no API key, no
database and nothing from the operator except the public files they must publish.

PIKIT has run five worlds. Each world is one contract, one set of public files and one repo tag — pick the row of the
world you want to check (`docs/VERIFY.md`, "five worlds"):

| World | Dates | Contract (pin it yourself, §1) | Repo tag | Public files (`--dir`) |
|---|---|---|---|---|
| 5 — PikitLedger, rules 11 (COMBO · POP/LUCKY buffs · whole-credit payouts) | {W5 start} → | the new PikitLedger (`/rules` page, your wallet's session signature) | `w5-rules11-{engine10}` | `https://chog.pikit.fun/epochs` |
| 4 — PikitLedger, rules 10 (LUCKY PICK · Golden CHOG jackpot) | 2026-10-19 05:49 UTC → {W5 start} | `0x6456a33a3185D000B7DeEF3901F5B9FAbC963Ca8` | `w4-rules10-722d2bb82d` | `https://chog.pikit.fun/epochs-w4` |
| 3 — PikitLedger, rules 9 (LAST HIT) | 2026-10-16 05:35 UTC → 2026-10-19 05:49 UTC | `0x21036eBe95b8bD56fd1268Bb94c587c599f4D6ef` | `w3-rules9-39d1ae79c2` | `https://chog.pikit.fun/epochs-w3` |
| 2 — PikitLedger, rules 8 | 2026-10-14 → 2026-10-16 05:35 UTC | `0xDcd661D0ee623F714134DB0Ba0467549B8115C02` | `w2-ledger-e219e71372` | `https://chog.pikit.fun/epochs-w2` |
| 1 — PikitShop (on-chain purchases) | 2026-10-12 → 10-14 | `--shop 0xB0FAf7eA64b44daa7246Bac43aBf9e16f7a47e0C` | `engine-ac38812c12` (its own old CLI and `PUBLIC.md`) | `https://chog.pikit.fun/epochs-rev6` |

Times are the first window (W0) of each world, UTC.

A tag from another world fails with a build mismatch (`trust: …`) before any root is checked — that means "wrong tag",
not "bad world".

## 1. Build and pin the PikitLedger (once)

### Build

Requirements: Node.js 24.21 or newer 24.x, pnpm 10 (`corepack enable`), git.

```sh
git clone <PUBLIC_VERIFIER_REPO_URL> pikit-verifier   # the public repo: packages/{engine,protocol,verifier} + apps/verifier-cli
cd pikit-verifier
git checkout <VERIFIER_TAG>                           # the tag of your world (table above), e.g. w5-rules11-<engine 10 hex>
pnpm install
pnpm --filter @pikit/verifier-cli... build
```

**Repo tags.** From world 3 on, the tag is `w<world>-rules<rulesVersion>-` followed by the first 10 hex digits (without
`0x`) of the engine's `engineVersionHash` — the engine build that the contract's `rulesHash` pins. The game's verify panel
prints the exact tag; the `verify` output header (`trust roots`) prints this build's `engine` hash (`engineVersionHash`), so you can check that the
tag name's 10 hex digits match the code it points to, and that the `rulesHash` read from the chain is the one published for your world (`docs/VERIFY.md` §8.2). World 2 is tagged `w2-ledger-e219e71372` (from its ledger-rules hash) and world 1
`engine-ac38812c12` with its old CLI (`--shop`, `--epoch`). The world itself is pinned by the contract address you give (`--contract`, below), not by a repo tag. The contract fixes two hashes at deployment: `rulesHash` (= keccak256(catalogHash ‖
engineVersionHash) — the game engine) and `ledgerHash` (the ledger rules: `packages/verifier/src/ledger/rules/**`), and
`verify` refuses a world whose on-chain `rulesHash` or `ledgerHash` differs from the build you run — that is a build mismatch,
not a failed root. The game's verify panel prints the whole command with the right tag.

### Pin the PikitLedger address yourself

`verify` refuses to run without `--contract <address>`: the address of the PikitLedger contract **you** trust. The operator's
`world.json` must name the same contract or the run fails at once. Get the address from places the operator's file server
does not control:

- your wallet: the `verifyingContract` of the PIKIT session you signed (EIP-712 domain `PIKIT-LEDGER` shown by the wallet),
- the game's `/rules` page and the public verifier repository,
- the block explorer: the contract that emits `RootPosted` every hour.

Instead of `--contract` you can pass `--trust trust.json` with `{ "contract": "0x…", "chainId": 143, "ledgerHash": "0x…",
"rulesHash": "0x…" }` (only `contract` is required; every other value you give is checked against the chain). Every run
prints these trust roots first — compare them with your wallet and the explorer.

## 2. Verify the last root (what the verify panel shows)

```sh
node apps/verifier-cli/dist/main.js verify --contract 0xLEDGER --root latest \
  --dir https://chog.pikit.fun/epochs \
  --rpc https://rpc.monad.xyz,https://rpc1.monad.xyz
```

It reads the last `RootPosted` from the chain, starts from the previous root's boundary (its world snapshot and ledger
leaves file, both checked against that previous root), replays the hour of signed lists → ledger → engine, and compares all
10 root fields (ledger root, payouts root, supply, world state, input log, seed, file hash …) with the chain.

## 3. Verify more

- One given root: `--root 41` (from root 40's boundary).
- A range: `--root 41 --from-snapshot 30` (roots 31 … 41 from root 30's boundary).
- Everything from the start of the world: `--from-snapshot genesis` (with `--root latest` or a root number).
- Your own credits: `--json` prints the report; the ledger leaves file `ledger/leaves/<k>.json` has your wallet's balance,
  open stake and last sequence number at root k, and the replay proves it.

**Choose the RPCs yourself.** The two `--rpc` URLs must be two *different providers*: the same host twice is refused
(it would cross-check nothing), and two hosts under one domain draw a warning. Do not simply copy the RPCs the website
shows you — pick at least one you trust independently.

## 4. Reading the result

- Exit code **0** and `OK: … checks passed, N roots matched` — everything matched.
- Exit code **1** and `FAILED` — something did not match or was missing. The `✘` lines say what. In particular it fails when:
  - a root field on chain differs from the replay (the `root k … ✘` line names the fields),
  - a window list is not signed by that window's ANNOUNCE key (the key comes from the contract's `AnnouncerChanged` events),
  - a list's entries do not hash to its signed `entriesHash` (an entry added, dropped or reordered),
  - a decision in the ledger file (applied / rejected, reason, purchase id) differs from the ledger rules,
  - a smart-wallet session does not pass ERC-1271 `isValidSignature` at the block the server recorded, or a list window's
    block timestamp differs from the chain,
  - the game's input log does not hold exactly the listed intents at their windows,
  - a public file of the root is not published, or the leaves file / boundary snapshot differs from the replay,
  - the two RPC endpoints disagree on any chain fact,
  - `world.json` names another contract than your `--contract`, or the chain's `ledgerHash` / `rulesHash` differs from your build.
- Exit code **2** — wrong command line.
- Exit code **3** — could not read right now (rate limit, timeout, connection), or the root was posted seconds ago and its
  files are not visible yet. Not a verification result: run again in a minute.
- `--json` prints the whole report.

## 5. What you trust and what this cannot prove

- **The contract address** is the one you pinned (§1). The seed commitment, genesis block, rooms, rules and ledger hashes
  and every root are read from that contract over the RPCs you name (finalized blocks only, cross-checked).
- **The operator's files are not trusted**: each one is bound to the on-chain root by the root's `dataHash` and replayed.
- **Not provable** (honest limits, `docs/VERIFY.md` §8.6): that a window list was published *before* its block (the
  server could leave out an intent after seeing the block hash), who is eligible for the daily grant (the ledger only
  enforces once per day and the cap), and censorship of intents that never reached a list. Credits are not money.

## 6. Speed and politeness

`--max-rps` (default 20) caps requests per second for each RPC endpoint and for the file server. A root covers ≈ 12,000
blocks: reading their hashes takes about 5 minutes at 20 requests/s; the replay itself takes seconds. Public RPCs limit you
to roughly 25–50 requests per second — stay below that.

## 7. Run your own watcher

A one-off run proves the past. To catch a bad root soon after it is posted, run the watcher from a GitHub account the
operator does not control — `--since-state state.json --write-state state.json --max-roots 5` continues after the last root
it verified, so no root is ever skipped. See `docs/VERIFY.md` §7–§8 (fork, repository variables `VERIFY_*_CONTRACT`,
optional `VERIFY_*_LEDGER_HASH`, `VERIFY_MAX_ROOTS`, an optional Discord webhook).
