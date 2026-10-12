# PIKIT public verifier

PIKIT publishes every input of its game world and anchors its results on the Monad chain. This repository is the
**public engine and verifier**: it replays the world with the same deterministic engine the game server runs and checks,
**against the chain itself**, that every payout is exactly what the rules produce.

You need no account, no API key, no database and nothing from the operator except the public files they must publish.

| Directory | What it is |
|---|---|
| `packages/engine` | The deterministic game engine. Its `engineVersionHash` is part of the on-chain `rulesHash`. |
| `packages/protocol` | Shared types, catalog format, hashing, contract ABIs. |
| `packages/verifier` | Replay + epoch verification against chain facts (anchors, events, settlements). |
| `apps/verifier-cli` | The `pikit-verify` command. Full guide: [`apps/verifier-cli/PUBLIC.md`](apps/verifier-cli/PUBLIC.md). |
| `rules.lock` | The rules version this tree builds: `engineVersionHash`, `catalogHash`, golden `replayHash`. |
| `.github/workflows/verify-*.yml` | The hourly watcher you can run from your own fork (see "Run your own watcher"). |

## What this verifies

For a purchase, a day, or the whole history of a PIKIT world, `verify`:

- rebuilds every room from the published epoch input logs and snapshots with this engine,
- checks that every input (purchase, cancel, void, freeze) is exactly a chain event — nothing missing, late, changed or invented,
- checks the seed chain back to the on-chain `seedRoot`, and every on-chain anchor root (rooms state, input log, bundle),
- checks every on-chain payout (`settleEnd` / `VoidOverPaid`) against the replay to the milli-credit, including the
  `over` share, and fails if a payout owed was not made within 30 minutes (6,000 blocks) of the pickaxe's end,
- checks that the prices and payout caps the chain charges with (`catalogOf`) are the published catalog's.

## Run it

Requirements: Node.js 24.21 or newer 24.x, pnpm 10 (`corepack enable`), git.

```sh
git clone https://github.com/DESPELL-STARTALE/pikit-verify pikit-verifier && cd pikit-verifier
git checkout engine-<first 10 hex digits of the world's engineVersionHash>   # e.g. engine-ac38812c12
pnpm install --frozen-lockfile && pnpm --filter @pikit/verifier-cli... build
```

Then one line (replace `0xSHOP` with the shop address **you** pinned, and `1234` with your purchase id):

```sh
node apps/verifier-cli/dist/main.js verify --shop 0xSHOP --purchase 1234 \
  --dir https://chog.pikit.fun/epochs \
  --rpc https://rpc.monad.xyz,https://rpc1.monad.xyz
```

On testnet use `--rpc https://testnet-rpc.monad.xyz,https://rpc.ankr.com/monad_testnet`. To verify the last day instead of
one purchase: `--epoch latest --from-snapshot latest`. The game's verify panel prints this whole command with the right tag,
shop and URLs filled in — but check the shop yourself (below).

**Engine tags.** Every engine that ever ran a PIKIT world is tagged `engine-` + the first 10 hex digits of its
`engineVersionHash` (without `0x`). Build the tag of the world you verify: building another engine fails with an
`engineVersionHash` mismatch, which is a build mismatch, not a failed payout.

Exit code `0` and `OK: … checks passed` means everything matched. Exit code `1` and `FAILED` means something did not match
or was missing; the `✘` lines say what. Exit code `2` is a wrong command line. `--json` prints the whole report.

## Trust roots

- **The shop address is yours, not the operator's.** `verify` refuses to run without `--shop <address>` (or
  `--trust trust.json`). Take it from at least two places the operator's file server does not control: the
  `verifyingContract` of the PIKIT session your wallet signed (EIP-712 domain) or the `to` of your purchase transaction, the
  contract that emitted your `Purchased` event on the block explorer, and the game's `/rules` page. If the operator's
  `world.json` names another shop, the run fails before reading anything else. The fairness contract, seed commitment,
  anchors and prices are all read from that shop on chain.
- **Chain values come from the RPC endpoints you name** (finalized blocks only). With two endpoints from different
  providers every value is read from both and compared. The same host twice is refused; pick at least one yourself rather
  than copying the RPCs a website shows you.
- **The operator's files are not trusted.** Each one is checked against on-chain anchors and events; a missing file fails.
- **The engine is the code you just built.** Its `engineVersionHash` must equal the world's (and is bound into the
  on-chain `rulesHash = keccak256(catalogHash ‖ engineVersionHash)`).

Every run prints these trust roots first — compare them with your wallet and the explorer.

## How to report a FAIL

A `FAILED` run is evidence. Please keep it:

1. Re-run the same command with `--json > report.json`, and note the exact command, the tag you built (`git describe --tags`)
   and the `engineVersionHash` the run printed.
2. First rule out a build mismatch: if the only `✘` is `engine build = world.engineVersionHash`, check out the tag the
   world's hash names and run again.
3. Open an issue in this repository with the `✘` lines, the command (RPC URLs with API keys removed), the trust roots the
   run printed and `report.json` attached. Publishing the report is allowed and encouraged — anyone can re-run the same
   command against the same public files and chain to confirm it.

## Run your own watcher

A one-off run proves the past. To catch a shortfall soon after it happens, fork this repository from a GitHub account the
operator does not control, enable Actions in the fork, and set the repository variables `VERIFY_MAINNET_SHOP` (the shop you
pinned), `VERIFY_MAINNET_FILES_URL` and `VERIFY_MAINNET_RPC_URLS` (two providers, comma-separated); optionally the secret
`VERIFY_ALERT_WEBHOOK` (a Discord webhook) for failure alerts. `verify-mainnet` then runs hourly and resumes from the state
its last successful run left, so no gap goes unchecked. Testnet uses `VERIFY_TESTNET_SHOP` (plus optional
`VERIFY_TESTNET_FILES_URL` / `VERIFY_TESTNET_RPC_URLS`). Details: `apps/verifier-cli/PUBLIC.md` §7 and `docs/VERIFY.md` §7.

## Development

```sh
pnpm install --frozen-lockfile && pnpm -r build
pnpm --filter @pikit/verifier-cli test   # 3 golden replays, the demo bundle, CLI tests
pnpm --filter @pikit/engine --filter @pikit/verifier test   # engine + verifier unit tests
scripts/public-subtree-check.sh          # this tree builds and runs alone from a git archive of HEAD
```

`@pikit/protocol`'s own test suite also checks constants against the Solidity contracts, which live outside this tree
(two of its tests need `contracts/src`). Package READMEs and `docs/VERIFY.md` (the full list of checks and what a snapshot start proves) are in Korean;
`apps/verifier-cli/PUBLIC.md` is the English user guide.

## License

See [`LICENSE`](LICENSE): all rights reserved; verification use permitted.
