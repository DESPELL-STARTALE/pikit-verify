# Verify PIKIT yourself

PIKIT publishes every input of its game world and anchors its results on the Monad chain. This tool replays the world
with the public engine and checks, **against the chain itself**, that every payout is exactly what the rules produce.
You need no account, no API key, no database and nothing from the operator except the public files they must publish.

## 1. Build and pin the shop (once)

### Build

Requirements: Node.js 24.21 or newer 24.x, pnpm 10 (`corepack enable`), git.

```sh
git clone <PUBLIC_VERIFIER_REPO_URL> pikit-verifier   # the public repo: packages/{engine,protocol,verifier} + apps/verifier-cli
cd pikit-verifier
git checkout <ENGINE_TAG>                             # the engine the world ran: engine-<first 10 hex digits of engineVersionHash>
pnpm install
pnpm --filter @pikit/verifier-cli... build
```

**Engine tags.** Every engine that ever ran a PIKIT world is tagged in the public repo as `engine-` followed by the first
10 hex digits of its `engineVersionHash` (without `0x`) — for example `engine-f8ab3ad673` for `0xf8ab3ad673…`. The world's
hash is in `world.json` and on chain (`rulesHash` = keccak(catalogHash ‖ engineVersionHash)); the game's verify panel prints
the whole command with the right tag. Building from the default branch instead can give an `engineVersionHash` mismatch for
purchases made under earlier rules — that is a build mismatch, not a failed payout.

### Pin the shop address yourself

`verify` refuses to run without `--shop <address>`: the address of the PikitShop contract **you** trust. The operator's
`world.json` must name the same shop or the run fails at once — otherwise an operator could point you at an honest decoy
deployment while your real shop pays you less. Get the address from at least two places the operator's file server does
not control:

- your wallet: the `verifyingContract` of the PIKIT session you signed (EIP-712 domain shown by the wallet), or the `to`
  address of your purchase transaction on the explorer,
- the game's `/rules` page and the public verifier repository (its `trust.json`, if published),
- the block explorer: the contract that emitted the `Purchased` event of your purchase.

Instead of `--shop` you can pass `--trust trust.json` with `{ "shop": "0x…", "chainId": 143, "fairness": "0x…",
"seedRoot": "0x…", "engineVersionHash": "0x…" }` (only `shop` is required; every other value you give is checked too).
Every run prints these trust roots first — compare them with your wallet and the explorer.

## 2. Verify one purchase

Replace `1234` with your purchase id (shown in the game's history and in the `Purchased` event of your transaction) and
`0xSHOP` with the shop address from §1.

```sh
node apps/verifier-cli/dist/main.js verify --shop 0xSHOP --purchase 1234 \
  --dir https://chog.pikit.fun/epochs \
  --rpc https://testnet-rpc.monad.xyz,https://rpc.ankr.com/monad_testnet
```

It starts from the last anchored snapshot before your purchase, replays up to the latest on-chain anchor and prints one
line per pickaxe: what the engine says you earned (`payout` + `over`) and what the chain paid (`settleEnd` or `VoidOverPaid`).

## 3. Verify the last day

```sh
node apps/verifier-cli/dist/main.js verify --shop 0xSHOP --epoch latest --from-snapshot latest \
  --dir https://chog.pikit.fun/epochs \
  --rpc https://testnet-rpc.monad.xyz,https://rpc.ankr.com/monad_testnet
```

Or a fixed range: `--epoch 2000 --from-snapshot 560` (from the anchored snapshot of epoch 560 to epoch 2000), or everything
from genesis: `--epoch 2000` with no `--from-snapshot`.

For Monad mainnet use the mainnet files URL and two mainnet RPCs from different providers (QuickNode and Alchemy here):

```sh
node apps/verifier-cli/dist/main.js verify --shop 0xSHOP --purchase 1234 \
  --dir https://chog.pikit.fun/epochs \
  --rpc https://rpc.monad.xyz,https://rpc1.monad.xyz
```

**Choose the RPCs yourself.** The two `--rpc` URLs must be two *different providers*: the same host twice is refused
(it would cross-check nothing), and two hosts under one domain draw a warning. Do not simply copy the RPCs the website
shows you — pick at least one you trust independently.

## 4. Reading the result

- Exit code **0** and `OK: … checks passed` — everything matched.
- Exit code **1** and `FAILED` — something did not match or was missing. The `✘` lines say what. In particular it fails when:
  - a payout on chain differs from the replay by even 1 milli-credit (including an `over` reported as 0),
  - a payout the replay owes was not paid on chain within 30 minutes (6,000 blocks) of the pickaxe's end (`OVERDUE`),
  - the over-the-price share of a pickaxe whose purchase was later voided was never paid (`VOID_OVER`),
  - an epoch file or the start snapshot is not published,
  - the two RPC endpoints disagree on any chain fact (block hash, anchor, event…),
  - `world.json` names another shop than your `--shop`, or a value of your `--trust` file differs from the chain,
  - the prices or payout caps the chain charges with (`catalogOf`) differ from the published catalog (`PRICE_MISMATCH`,
    `CAP_MISMATCH`), or a room runs other rules on chain than the catalog says.
- Exit code **2** — wrong command line.
- `--json` prints the whole report.

## 5. What you trust

- **The shop address** is the one you pinned (§1) — not the operator's `world.json`. Everything else on chain (the
  fairness contract, the seed commitment, the anchors, prices) is read from that shop.
- **The chain values** come from the RPC endpoints you name (finalized blocks only). With two endpoints from different
  providers, every value is read from both and compared; they would both have to lie the same way to fool you.
- **The operator's files are not trusted**: each one is checked against on-chain anchors and events. A missing file fails.
- **The engine** is the code you just built. The world's `engineVersionHash` must equal your build's.
- A run with `--from-snapshot` proves the results *after* the snapshot, given the on-chain anchor that the snapshot must
  match. Earlier history is proven by earlier runs, or by a run from genesis. Details: `docs/VERIFY.md` §3.

## 6. Speed and politeness

`--max-rps` (default 20) caps requests per second for each RPC endpoint and for the file server. Replaying a day of epochs
takes well under a minute of CPU; reading a day of block hashes takes about 2 hours at 20 requests/s. Public RPCs limit you to
roughly 25 (mainnet) to 50 (testnet) requests per second — stay below that.

## 7. Run your own watcher

A one-off run proves the past. To catch a shortfall soon after it happens, run the hourly watcher from a GitHub account
the operator does not control — see `docs/VERIFY.md` §7 (fork, three repository variables, an optional Discord webhook).
