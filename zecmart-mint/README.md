# ZecMart launchpad mint runner

> Пошаговая инструкция на русском, с нуля и до отчёта: **[ЗАПУСК.md](ЗАПУСК.md)**

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

## The three scripts

| Script | What it does |
| --- | --- |
| `gen-wallets.mjs` | Creates wallets: a BIP-39 seed phrase + `t1` address each |
| `mint.mjs` | Waits for `launchAt` and fires one order per wallet |
| `report.mjs` | After the drop: which NFT landed in which wallet |

## Usage

Requires Node.js 18+. `npm install` once (the generator uses `@scure`/`@noble`;
the mint runner itself has no dependencies).

```bash
npm install

# 1. Wallets — either paste your own addresses into wallets.txt...
cp wallets.example.txt wallets.txt
#    ...or generate them:
node gen-wallets.mjs --count 25      # writes wallets.txt + wallets-secret.json
node gen-wallets.mjs --verify        # every address re-derives from its seed phrase

# 2. Rehearse (validates everything, posts nothing)
node mint.mjs --dry-run --now

# 3. On drop day, a few minutes before launchAt
node mint.mjs

# 4. Afterwards
node report.mjs --orders results-*.json
```

## Generating wallets

`gen-wallets.mjs` writes two files:

- **`wallets.txt`** — addresses only, used by `mint.mjs` and `report.mjs`.
- **`wallets-secret.json`** — the seed phrases, `chmod 600` and git-ignored.
  This file is the *only* key to anything minted to those addresses. Lose it and
  the NFTs are gone; leak it and they are someone else's.

Derivation is the ordinary stack — BIP-39 mnemonic → BIP-32 → BIP-44
`m/44'/133'/0'/0/0` → secp256k1 → hash160 → base58check with the Zcash mainnet
prefix `0x1C 0xB8`. Any BIP-39 wallet recovers the same address. Before
generating a single key the library self-tests against published vectors (the
BIP-39 Trezor seed vector and the BIP-44 address `1LqBGSKuX5yYUonjxT5qGfpUsXKYYWeabA`),
and it aborts rather than emit an address whose seed phrase might not open it.

| Flag | Default | Meaning |
| --- | --- | --- |
| `--count <n>` | — | How many wallets to generate |
| `--words <12\|24>` | `12` | Seed phrase length |
| `--mode seeds` | default | One seed phrase per wallet, account 0 — works with any wallet |
| `--mode accounts` | | One seed phrase, N accounts (`m/44'/133'/i'/0/0`) — a single import, but only correct if the wallet derives accounts the same way |
| `--append` | off | Add wallets to the existing files |
| `--show <label>` | | Print one seed phrase, to import it |
| `--verify` | | Re-derive every address from its seed phrase |
| `--print` | off | Also print seed phrases to the terminal |

**Verify one before the drop.** Run `node gen-wallets.mjs --show w001`, import that
seed phrase into Noir Wallet, and check that the wallet's *transparent* address
matches. That is the only real proof the seeds open the addresses you are about to
mint to. Note that the ZecMart API does not checksum-validate addresses — it accepted
a deliberately corrupted one in testing — so a wrong address is accepted happily and
the NFT lands somewhere nobody controls.

Generate the wallets on the machine that will keep them, not on a shared or remote
box, and back up `wallets-secret.json` somewhere offline before minting.

Better still, keep the secret file outside the project directory — an IDE that indexes
the project can retain copies of it (PyCharm's Local History does). Set `ZECMART_SECRET`
once and every script picks it up:

```powershell
$env:ZECMART_SECRET = "$env:USERPROFILE\Documents\zec\wallets-secret.json"
```

```bash
export ZECMART_SECRET=~/zec/wallets-secret.json
```

Only `wallets.txt` (addresses) is needed to mint, so a machine that runs the sniper
never needs the seed phrases at all.

## Reading the results

```bash
node report.mjs --orders results-<timestamp>.json --json report.json
```

Prints a `wallet -> NFT` table (label, address, item name/number/image), falls back
to the order status for wallets whose items have not been allocated yet, and totals
it up. Seed phrases are never read into the report; `--show <label>` prints one when
you want to import that wallet. `My Collection` on the site queries the connected
wallet's shielded *and* transparent address, so once a seed is imported into Noir
Wallet its items show up there too.

### Flags

| Flag | Default | Meaning |
| --- | --- | --- |
| `--wallets <file>` | `wallets.txt` | Addresses, one per line |
| `--collection <slug>` | `zecpuppets` | Collection slug |
| `--quantity <n>` | `maxPerOrder` (2) | NFTs per wallet, capped to the server limit |
| `--concurrency <n>` | `2` | Orders in flight at once |
| `--gap <ms>` | `1000` | Spacing between order starts |
| `--watch` | off | Poll until the mint opens, then fire (no announced launchAt) |
| `--preflight` | off | Validate addresses first — one request per wallet |
| `--warm <n>` | `= concurrency` | Connections opened before launch |
| `--prep-ms <ms>` | `900000` | Stay silent until this long before launch |
| `--poll-ms <ms>` | `600000` | Countdown polling interval |
| `--no-warm` | off | Skip connection pre-warming |
| `--lead-ms <n>` | `250` | Fire this many ms before `launchAt` |
| `--attempts <n>` | `40` | Retries per wallet on transient errors |
| `--now` | off | Skip the countdown, fire immediately |
| `--dry-run` | off | Do everything except POST the order |
| `--allow-paid` | off | Proceed on a non-free collection |
| `--base <url>` | `https://zecmart.com` | API base |

## What it does

1. Loads the config, prints price / supply / per-wallet limits, and refuses a paid
   mint unless you opt in.
2. Syncs to the server clock (3 samples, keeps the lowest-RTT one), so a skewed local
   clock does not make you early or late.
3. Preflight (opt-in, `--preflight`): validates every address through `wallet-limits`.
   It costs one request per wallet, so run it in a rehearsal days ahead — never in
   the minutes before a drop, where that budget is worth more spent on orders.
4. Sleeps until `launchAt - lead-ms`, re-checking in case the team moves the time.
5. Fires orders with bounded concurrency. Each wallet keeps one idempotency key for
   the whole run, so a retry can never produce a second order for that wallet.
6. Retries only transient failures (`MINT_NOT_STARTED`, 429, 5xx, network) with
   jittered backoff; stops a wallet on `WALLET_LIMIT_REACHED` / invalid address, and
   stops the run on `SOLD_OUT`.
7. Polls each order to its final status and writes `results-<timestamp>.json`.

## The rate limit is the real constraint

The order endpoint rate-limits **per IP**, and it does not answer a burst with a
polite slowdown — it answers with `HTTP 429` and `Retry-After: 3600`. One hour,
which is longer than any drop. Measured, not guessed: eight warm-up GETs plus a
single POST from one address was enough to trigger it.

What follows from that:

- **More wallets do not mean more NFTs.** Past some number, the run gets banned
  partway through and the remaining wallets get nothing.
- **Observed on the 2026-09-19 ZecPuppets drop:** 25 wallets, preflighted 15 minutes
  ahead, then orders at t=0 — the *first* POST came back 429 with `Retry-After: 3600`
  and not one order landed. Across the whole drop only 43 of 555 went out before the
  collection was paused, so the server was shedding load broadly, not just from one
  IP. The preflight's 25 requests almost certainly did not help.
- Orders now start with a **single probe wallet**: if that one is rate limited, the
  rest are not attempted, because an hour-long ban costs every one of them anyway.
- `--gap 300` (the default) spaces the orders. Lower it only if you have reason to
  think the limit is looser than it looked; `--gap 500` is the cautious direction.
- On a 429 with a long `Retry-After` the run **stops** instead of retrying. Hammering
  a one-hour ban cannot succeed and only adds load.
- Warm-up runs against a static page, not the API, so handshakes do not spend the
  API's rate budget.
- Started hours early, the runner sends **nothing** until `--prep-ms` before launch
  (15 min by default), then polls every `--poll-ms` (10 min). A 3.5-hour wait costs
  about 25 requests rather than 200 — budget that is still there when it matters.

Spreading the orders over many IPs is what would get around this, and that is exactly
what the limiter exists to prevent. This tooling does not do it.

## Speed

Ordered by how much they actually buy you:

1. **Pre-warmed connections** (on by default). At t=0 a fresh TLS handshake costs more
   than the request: measured 143 ms cold vs 21 ms on a pooled connection. `undici`
   holds the pool open (`keepAliveTimeout` 30 s, since its default 4 s is too short to
   pre-warm), and the warm-up fires a couple of seconds before launch.
2. **Ordering and confirmation are separate passes.** Polling an order to COMPLETED
   used to hold a worker slot for seconds while other wallets waited to order.
3. **`--lead-ms`** — fire slightly before `launchAt` so the request lands as the gate
   opens. 250 ms by default; raise it on a slow link.
4. **Where you run it.** The site sits behind Google Frontend, so a VPS on decent
   network beats a home connection — but this is worth tens of milliseconds, while
   the rate limit above is worth the whole run.

## Notes

- `maxPerWallet` is 2 and enforced server-side, per address — more than two means
  more addresses.
- Concurrency is deliberately modest and backoff is jittered. Turning it way up mostly
  earns you 429s — the bottleneck is the server, not your loop.
- `wallets.txt`, `wallets-secret.json` and `results-*.json` are git-ignored.
- The API is undocumented and can change without notice (field names, error codes,
  auth). Re-run with `--dry-run` shortly before the drop to confirm it still matches.
- Minting across many self-generated wallets is how you get past a per-wallet cap
  that exists to spread a 555-piece free drop around. That is a choice about other
  minters, not a technical detail — and platforms do sometimes claw back or blocklist
  drops they read as sybil activity. No credentials, captchas or rate-limit defences
  are bypassed anywhere in this tooling.
