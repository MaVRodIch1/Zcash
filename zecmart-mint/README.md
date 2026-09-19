# ZecMart launchpad mint runner

Creates one mint order per wallet the moment the ZecMart public sale opens, for every
address you list. Written for the ZecPuppets drop, but the collection is a flag.

## How the mint actually works

Read off the live site bundle and API (`https://zecmart.com/assets/index-*.js`):

- Ordering is a plain REST call — `POST /api/mint/orders` with
  `{walletAddress, quantity, idempotencyKey}` and an `x-idempotency-key` header.
  **No wallet signature is involved**, so the runner only needs the addresses.
- ZecPuppets is `assetNetwork: "database"` / `recipientModel: "not_required"`:
  the backend allocates the collectible, there is no ZSA transfer and no ZEC payment
  (`priceZatoshi: "0"`). Nothing has to be broadcast from Noir Wallet.
- Limits come from `GET /api/mint/config`: `maxPerWallet: 2`, `maxPerOrder: 2`,
  supply 555. `GET /api/mint/launch` carries `launchAt` and `launchStarted`.
- Per-wallet remaining allowance: `GET /api/mint/wallet-limits?walletAddress=…`.

If the collection is ever a *paid* mint, this runner refuses to run unless you pass
`--allow-paid`; it can create orders but cannot sign or broadcast the payment, so you
would have to pay each order by hand within the 15-minute reservation window.

## Usage

Requires Node.js 18+ (uses the built-in `fetch`). No dependencies.

```bash
cp wallets.example.txt wallets.txt   # then paste your addresses, one per line
node mint.mjs --wallets wallets.txt --dry-run   # rehearse: validates everything, posts nothing
node mint.mjs --wallets wallets.txt             # waits for launchAt, then fires
```

Start it a few minutes before the drop and leave it running: it syncs to the server
clock, sleeps until `launchAt`, then sends all orders.

### Flags

| Flag | Default | Meaning |
| --- | --- | --- |
| `--wallets <file>` | `wallets.txt` | Addresses, one per line |
| `--collection <slug>` | `zecpuppets` | Collection slug |
| `--quantity <n>` | `maxPerOrder` (2) | NFTs per wallet, capped to the server limit |
| `--concurrency <n>` | `5` | Orders in flight at once |
| `--lead-ms <n>` | `250` | Fire this many ms before `launchAt` |
| `--attempts <n>` | `40` | Retries per wallet on transient errors |
| `--now` | off | Skip the countdown, fire immediately |
| `--dry-run` | off | Do everything except POST the order |
| `--skip-preflight` | off | Skip address/allowance validation |
| `--allow-paid` | off | Proceed on a non-free collection |
| `--base <url>` | `https://zecmart.com` | API base |

## What it does

1. Loads the config, prints price / supply / per-wallet limits, and refuses a paid
   mint unless you opt in.
2. Syncs to the server clock (3 samples, keeps the lowest-RTT one), so a skewed local
   clock does not make you early or late.
3. Preflight: validates every address through `wallet-limits` and reports any whose
   allowance is already 0 — a typo then costs nothing at t=0.
4. Sleeps until `launchAt - lead-ms`, re-checking in case the team moves the time.
5. Fires orders with bounded concurrency. Each wallet keeps one idempotency key for
   the whole run, so a retry can never produce a second order for that wallet.
6. Retries only transient failures (`MINT_NOT_STARTED`, 429, 5xx, network) with
   jittered backoff; stops a wallet on `WALLET_LIMIT_REACHED` / invalid address, and
   stops the run on `SOLD_OUT`.
7. Polls each order to its final status and writes `results-<timestamp>.json`.

## Notes

- `maxPerWallet` is 2 and enforced server-side; the only way to more is more wallets,
  each of which is a real account you control.
- Concurrency is deliberately modest and backoff is jittered. Turning it way up mostly
  earns you 429s — the bottleneck is the server, not your loop.
- `wallets.txt` and `results-*.json` are git-ignored. No private keys or seed phrases
  are involved anywhere in this flow; never put them in this repo.
- The API is undocumented and can change without notice (field names, error codes,
  auth). Re-run with `--dry-run` shortly before the drop to confirm it still matches.
