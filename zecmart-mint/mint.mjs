#!/usr/bin/env node
/**
 * ZecMart launchpad mint runner.
 *
 * Creates one mint order per wallet address as soon as the public sale opens.
 * The launchpad mint is an ordinary REST flow (no wallet signature, no on-chain
 * transfer for database-allocated collections), so all the runner needs is the
 * list of wallet addresses you control.
 *
 * Usage:
 *   node mint.mjs --wallets wallets.txt [--quantity 2] [--concurrency 5] [--dry-run]
 *
 * Flags:
 *   --wallets <file>     newline separated wallet addresses (default: wallets.txt)
 *   --collection <slug>  collection slug (default: zecpuppets)
 *   --quantity <n>       NFTs per wallet, capped to maxPerOrder (default: maxPerOrder)
 *   --concurrency <n>    parallel in-flight orders (default: 4)
 *   --gap <ms>           spacing between order starts (default: 300) — the mint
 *                        endpoint answers a burst with a 1-hour IP ban
 *   --poll-ms <ms>       how often to re-check launchAt while waiting (default:
 *                        600000). Rarely, on purpose: the countdown must not
 *                        spend the IP's rate budget before the drop.
 *   --prep-ms <ms>       start talking to the server this long before launch
 *                        (default: 900000 = 15 min). Until then the process
 *                        sleeps without sending anything, so it can be started
 *                        hours early without burning the rate budget.
 *   --lead-ms <n>        fire this many ms before launchAt (default: 250)
 *   --attempts <n>       retry attempts per wallet on transient errors (default: 40)
 *   --base <url>         API base (default: https://zecmart.com)
 *   --now                skip the launch countdown and fire immediately
 *   --skip-preflight     do not validate addresses/allowances before firing
 *   --dry-run            run every check, but never POST an order
 *   --warm <n>           connections to open before launch (default: concurrency)
 *   --no-warm            skip connection pre-warming
 *   --allow-paid         proceed even if the collection is not a free mint
 */

import fs from 'node:fs/promises';
import { randomUUID } from 'node:crypto';

// Keep-alive pool: at t=0 a fresh TLS handshake costs more than the request
// itself, so orders must go out over connections that are already open.
let poolReady = false;
try {
  const { setGlobalDispatcher, Agent } = await import('undici');
  setGlobalDispatcher(new Agent({
    connections: 64,          // per origin, plenty for any sane wallet count
    keepAliveTimeout: 30_000, // undici defaults to 4s idle — far too short to pre-warm
    keepAliveMaxTimeout: 120_000,
    connect: { timeout: 10_000 },
  }));
  poolReady = true;
} catch {
  // undici is optional; without it Node's default pool still works, just colder.
}

const args = parseArgs(process.argv.slice(2));
const BASE = (args.base ?? 'https://zecmart.com').replace(/\/+$/, '');
const COLLECTION = args.collection ?? 'zecpuppets';
const WALLET_FILE = args.wallets ?? 'wallets.txt';
const CONCURRENCY = int(args.concurrency, 4);
const LEAD_MS = int(args['lead-ms'], 250);
const ATTEMPTS = int(args.attempts, 40);
const DRY_RUN = !!args['dry-run'];
const WARM = args['no-warm'] ? 0 : int(args.warm, CONCURRENCY);
const GAP = int(args.gap, 300);  // ms between order starts; the endpoint bans bursts
const POLL_MS = Math.max(60_000, int(args['poll-ms'], 600_000));  // countdown polling interval
const PREP_MS = Math.max(60_000, int(args['prep-ms'], 900_000));  // silent until this long before launch

// Errors that mean "not open yet / server busy" — worth retrying.
const RETRYABLE = new Set([
  'MINT_NOT_STARTED', 'MINT_NOT_LIVE', 'COMING_SOON', 'COLLECTION_PAUSED',
  'PUBLIC_MINT_BLOCKED', 'MINT_PAUSED', 'RATE_LIMITED', 'TOO_MANY_REQUESTS',
  'INTERNAL_ERROR', 'SERVICE_UNAVAILABLE',
]);
// Errors that permanently disqualify a wallet — stop retrying that wallet.
const WALLET_FATAL = new Set([
  'INVALID_WALLET_ADDRESS', 'WALLET_LIMIT_REACHED', 'WALLET_LIMIT_EXCEEDED',
  'MAX_PER_WALLET_EXCEEDED', 'DUPLICATE_ORDER', 'ORDER_ALREADY_EXISTS',
]);
// Errors that end the whole run.
const GLOBAL_FATAL = new Set(['SOLD_OUT', 'NO_INVENTORY', 'INVENTORY_EXHAUSTED']);

let clockOffsetMs = 0;   // serverNow - localNow
let soldOut = false;
let rateLimited = false;   // set when the server answers 429 with a long Retry-After

main().catch((err) => { console.error('fatal:', err.message); process.exit(1); });

async function main() {
  const wallets = await loadWallets(WALLET_FILE);
  log(`wallets loaded: ${wallets.length}`);

  const config = await api(`/api/mint/config`);
  const col = config.collection ?? {};
  const maxPerOrder = int(col.maxPerOrder, 2);
  const quantity = Math.max(1, Math.min(int(args.quantity, maxPerOrder), maxPerOrder));
  const free = String(col.priceZatoshi ?? '0') === '0';

  log(`collection: ${col.name} (${col.slug}) supply=${col.targetSupply} available=${col.available}`);
  log(`price=${col.priceZec} ZEC  maxPerWallet=${col.maxPerWallet}  maxPerOrder=${maxPerOrder}  quantity=${quantity}`);
  log(`network=${config.network} assetNetwork=${col.assetNetwork} recipientModel=${col.recipientModel}`);

  if (!free && !args['allow-paid']) {
    throw new Error(
      `collection is not a free mint (${col.priceZec} ZEC). This runner cannot sign or broadcast ` +
      `a Noir payment; each order would need manual payment. Re-run with --allow-paid to create ` +
      `orders anyway and pay them by hand from the wallet.`);
  }
  if (col.recipientModel && col.recipientModel !== 'not_required') {
    log(`warning: collection expects a ZSA recipient (${col.recipientModel}); ` +
        `add "<address>,<zsaRecipient>" lines in the wallet file if orders are rejected.`);
  }

  // Everything below talks to the server, so it waits until the prep window.
  if (!args.now) await idleUntilPrep(config);

  await syncClock();
  if (!args['skip-preflight']) await preflight(wallets);
  if (args.now) await warmUp();
  else await waitForLaunch();

  const t0 = Date.now();
  const results = await runPool(wallets, CONCURRENCY, (w) => mintOne(w, quantity));
  log(`all orders sent in ${Date.now() - t0} ms`);

  await confirmAll(results);

  const ok = results.filter((r) => r.ok);
  const failed = results.filter((r) => !r.ok);
  log('');
  log(`=== done: ${ok.length}/${results.length} wallets got an order ===`);
  for (const r of failed) log(`  FAILED ${short(r.wallet)}: ${r.error}`);

  const out = `results-${new Date().toISOString().replace(/[:.]/g, '-')}.json`;
  await fs.writeFile(out, JSON.stringify(results, null, 2));
  log(`results written to ${out}`);
  if (failed.length) process.exitCode = 1;
}

/* ---------------------------------------------------------------- wallets */

async function loadWallets(file) {
  let raw;
  try {
    raw = await fs.readFile(file, 'utf8');
  } catch {
    throw new Error(`wallet file "${file}" not found. Copy wallets.example.txt to wallets.txt ` +
                    `and put one wallet address per line.`);
  }
  const seen = new Set();
  const wallets = [];
  for (const line of raw.split('\n')) {
    const text = line.split('#')[0].trim();
    if (!text) continue;
    const [address, zsaRecipient] = text.split(',').map((s) => s.trim());
    if (!address || seen.has(address)) continue;
    seen.add(address);
    wallets.push({ address, zsaRecipient: zsaRecipient || undefined, idempotencyKey: randomUUID() });
  }
  if (!wallets.length) throw new Error(`no wallet addresses found in "${file}"`);
  return wallets;
}

/**
 * Validate every address and its remaining allowance before the sale opens, so
 * a typo costs nothing at t=0.
 */
async function preflight(wallets) {
  log('preflight: checking wallet addresses and allowances...');
  const bad = [];
  await runPool(wallets, CONCURRENCY, async (w) => {
    try {
      const limits = await api(`/api/mint/wallet-limits?walletAddress=${encodeURIComponent(w.address)}`);
      w.remaining = limits.walletRemainingAllowance ?? limits.effectiveMaxQuantity;
      if (w.remaining === 0) log(`  ${short(w.address)}: allowance already 0 — will be skipped`);
    } catch (err) {
      bad.push(`${short(w.address)}: ${err.message}`);
    }
    return { ok: true, wallet: w.address };
  });
  if (bad.length) {
    for (const b of bad) log(`  invalid: ${b}`);
    throw new Error(`${bad.length} wallet address(es) rejected by the API — fix them before the sale.`);
  }
  log(`preflight ok: ${wallets.length} wallets usable`);
}

/* ------------------------------------------------------------ launch time */

/**
 * Sleep — sending nothing at all — until shortly before launch.
 *
 * The API rate-limits per IP and a 429 carries an hour-long Retry-After, so the
 * hours before a drop are best spent silent: every request made while waiting is
 * budget that might not be there at t=0. launchAt comes from the config fetch
 * that already happened, so this costs no extra request.
 */
async function idleUntilPrep(config) {
  if (!config?.launchAt) return;
  const target = Date.parse(config.launchAt) - PREP_MS;
  if (!Number.isFinite(target) || target - Date.now() <= 0) return;

  log(`staying idle until ${new Date(target).toISOString()} ` +
      `(${fmtDuration(target - Date.now())} from now) — no requests until then`);
  while (Date.now() < target) {
    await sleep(Math.min(target - Date.now(), 1_800_000));
    const left = target - Date.now();
    if (left > 0) log(`idle... ${fmtDuration(left)} until prep`);
  }
  log('prep window reached — checking wallets');
}

/**
 * Align to the server clock so the countdown is not off by local drift.
 * Takes several samples and keeps the one with the lowest round-trip time; a
 * cached response would otherwise poison the offset with a stale Date header.
 */
async function syncClock() {
  let best = null;
  for (let i = 0; i < 3; i++) {
    const t0 = Date.now();
    let res;
    try {
      res = await fetch(`${BASE}/api/mint/launch?_=${t0}`, {
        cache: 'no-store',
        headers: { 'cache-control': 'no-cache', pragma: 'no-cache' },
      });
    } catch { continue; }
    const t1 = Date.now();
    await res.text().catch(() => '');
    const serverDate = res.headers.get('date');
    if (!serverDate) continue;
    const rtt = t1 - t0;
    // The Date header has 1s resolution, so assume the midpoint of that second.
    const offset = Date.parse(serverDate) + 500 - (t0 + rtt / 2);
    if (!best || rtt < best.rtt) best = { rtt, offset };
    await sleep(120);
  }
  if (best) {
    clockOffsetMs = best.offset;
    log(`clock offset vs server: ${Math.round(best.offset)} ms (rtt ${best.rtt} ms)`);
  } else {
    log('warning: could not read the server clock, using the local clock');
  }
}

const serverNow = () => Date.now() + clockOffsetMs;

let warmed = false;

async function waitForLaunch() {
  let launch = await api('/api/mint/launch');
  if (launch.launchStarted) { log('sale already open'); return; }

  const target = Date.parse(launch.launchAt) - LEAD_MS;
  log(`launch at ${launch.launchAt} (in ${fmtDuration(target - serverNow())})`);

  let synced = false;
  while (serverNow() < target) {
    const left = target - serverNow();
    // Poll rarely. The API rate-limits per IP and a 429 carries an hour-long
    // Retry-After, so a long wait must not spend the budget on the countdown:
    // once every 10 minutes is enough to notice a moved launchAt.
    if (left > 120_000) {
      await sleep(Math.min(left - 60_000, POLL_MS));
      launch = await api('/api/mint/launch').catch(() => launch);
      if (launch.launchStarted) { log('sale opened early'); return; }
      const moved = Date.parse(launch.launchAt) - LEAD_MS;
      if (moved !== target) { log(`launchAt moved to ${launch.launchAt}`); return waitForLaunch(); }
      log(`waiting... ${fmtDuration(target - serverNow())} left`);
    } else if (left > 5_000) {
      // One clock re-sync near the end, not one per loop.
      if (!synced) { synced = true; await syncClock(); }
      await sleep(Math.min(left - 2_000, 20_000));
    } else {
      if (!warmed) { warmed = true; await warmUp(); }
      await sleep(Math.min(left, 25)); // busy-ish wait only for the last seconds
    }
  }
  if (!warmed) await warmUp();
  log('launch window reached — firing orders');
}

/* ------------------------------------------------------------------- mint */

/**
 * Orders are spaced by GAP ms. The mint endpoint rate-limits per IP and answers
 * a burst with a one-hour Retry-After, so a measured stream places more orders
 * than a stampede does.
 */
let nextSlot = 0;
async function takeSlot() {
  const now = Date.now();
  const at = Math.max(now, nextSlot);
  nextSlot = at + GAP;
  if (at > now) await sleep(at - now);
}

async function mintOne(wallet, quantity) {
  if (wallet.remaining === 0) return { ok: false, wallet: wallet.address, error: 'allowance already 0' };

  let delay = 150;
  for (let attempt = 1; attempt <= ATTEMPTS; attempt++) {
    if (soldOut) return { ok: false, wallet: wallet.address, error: 'sold out' };
    if (rateLimited) return { ok: false, wallet: wallet.address, error: 'skipped: rate limited' };
    try {
      await takeSlot();   // also in a dry run, so the rehearsal shows real timing
      if (DRY_RUN) {
        log(`[dry-run] would POST order for ${short(wallet.address)} qty=${quantity}`);
        return { ok: true, wallet: wallet.address, dryRun: true };
      }
      const body = {
        walletAddress: wallet.address,
        quantity,
        idempotencyKey: wallet.idempotencyKey,
        ...(wallet.zsaRecipient ? { zsaRecipient: wallet.zsaRecipient } : {}),
      };
      const order = await api('/api/mint/orders', {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-idempotency-key': wallet.idempotencyKey },
        body: JSON.stringify(body),
      });
      log(`ordered ${short(wallet.address)} -> ${order.id} status=${order.status} delivery=${order.deliveryStatus ?? '-'}`);
      // Confirmation happens in a second pass: polling here would hold a pool
      // slot for seconds while other wallets are still waiting to order.
      return { ok: true, wallet: wallet.address, label: wallet.label, orderId: order.id,
               status: order.status, deliveryStatus: order.deliveryStatus,
               paymentAddress: order.paymentAddress, totalPriceZec: order.totalPriceZec, attempt };
    } catch (err) {
      const code = err.code ?? '';
      // A 429 with a long Retry-After is an IP ban, not a blip. Retrying into it
      // only adds load and cannot succeed inside the drop window, so the run stops.
      if (err.status === 429 && err.retryAfter >= 60) {
        if (!rateLimited) {
          rateLimited = true;
          log('');
          log(`!! rate limited by the server: Retry-After ${err.retryAfter}s (${fmtDuration(err.retryAfter * 1000)}).`);
          log('!! this IP cannot place further orders for that long — stopping the remaining wallets.');
          log('!! fewer wallets and a larger --gap next time; the limit is per IP, not per wallet.');
        }
        return { ok: false, wallet: wallet.address, error: `rate limited (retry after ${err.retryAfter}s)` };
      }
      if (rateLimited) return { ok: false, wallet: wallet.address, error: 'skipped: rate limited' };
      if (GLOBAL_FATAL.has(code)) { soldOut = true; return { ok: false, wallet: wallet.address, error: err.message }; }
      if (WALLET_FATAL.has(code)) return { ok: false, wallet: wallet.address, error: `${code}: ${err.message}` };
      const retryable = RETRYABLE.has(code) || err.transient;
      if (!retryable || attempt === ATTEMPTS) {
        return { ok: false, wallet: wallet.address, error: `${code || 'error'}: ${err.message}` };
      }
      // Jittered backoff, capped: before the gate opens every wallet is polling.
      const wait = Math.min(delay, 3_000) * (0.7 + Math.random() * 0.6);
      if (attempt % 5 === 1) log(`retry ${short(wallet.address)} (${code || err.message}) in ${Math.round(wait)}ms`);
      await sleep(wait);
      delay = Math.min(delay * 1.6, 3_000);
    }
  }
  return { ok: false, wallet: wallet.address, error: 'attempts exhausted' };
}

/**
 * Second pass: poll every placed order until it settles. Free mints usually
 * come back COMPLETED on the first look.
 */
async function confirmAll(results) {
  const placed = results.filter((r) => r.ok && r.orderId && !r.dryRun);
  if (!placed.length) return;
  log(`confirming ${placed.length} order(s)...`);
  const done = new Set(['COMPLETED', 'DELIVERED', 'FAILED', 'EXPIRED', 'CANCELLED']);

  await runPool(placed, Math.min(CONCURRENCY, 8), async (r) => {
    let current = { status: r.status, deliveryStatus: r.deliveryStatus };
    for (let i = 0; i < 10 && !done.has(current.status); i++) {
      await sleep(1_000);
      current = await api(`/api/mint/orders/${encodeURIComponent(r.orderId)}`).catch(() => current);
    }
    r.status = current.status;
    r.deliveryStatus = current.deliveryStatus;
    if (current.status === 'AWAITING_PAYMENT' && current.paymentAddress) {
      r.paymentAddress = current.paymentAddress;
      log(`  ${short(r.wallet)} needs payment: ${current.totalPriceZec} ZEC -> ${current.paymentAddress}`);
    }
    return r;
  });
}

/**
 * Open (and keep open) a set of connections before the gate lifts, so the first
 * orders do not each pay for a TLS handshake. undici drops idle connections
 * after keepAliveTimeout, so this runs shortly before firing, not minutes ahead.
 */
async function warmUp(n = WARM) {
  if (n < 1) return;
  const t0 = Date.now();
  // Warm against a static page: the API endpoints have their own rate buckets
  // and must not be spent on handshakes.
  const hits = await Promise.allSettled(
    Array.from({ length: n }, () => fetch(`${BASE}/launchpad?_w=${Math.random()}`, {
      method: 'HEAD', cache: 'no-store',
    })),
  );
  const ok = hits.filter((h) => h.status === 'fulfilled').length;
  log(`warmed ${ok}/${n} connection(s) in ${Date.now() - t0} ms${poolReady ? '' : ' (undici pool unavailable)'}`);
}

/* ------------------------------------------------------------------ utils */

async function api(path, init = {}) {
  let res;
  try {
    res = await fetch(`${BASE}${path}`, { ...init, cache: 'no-store' });
  } catch (err) {
    const e = new Error(`network: ${err.message}`);
    e.transient = true;
    throw e;
  }
  const text = await res.text();
  let data = {};
  try { data = text ? JSON.parse(text) : {}; } catch { /* non-JSON error page */ }
  if (!res.ok) {
    const err = new Error(data.message || data.error || `Request failed (${res.status})`);
    err.code = data.error || `HTTP_${res.status}`;
    err.status = res.status;
    err.retryAfter = Number(res.headers.get('retry-after')) || 0;
    err.transient = res.status === 429 || res.status >= 500;
    throw err;
  }
  return data;
}

/** Run `fn` over `items` with at most `limit` in flight. */
async function runPool(items, limit, fn) {
  const results = new Array(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const i = next++;
      results[i] = await fn(items[i]);
    }
  });
  await Promise.all(workers);
  return results;
}

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    if (!argv[i].startsWith('--')) continue;
    const key = argv[i].slice(2);
    const val = argv[i + 1];
    if (val === undefined || val.startsWith('--')) out[key] = true;
    else { out[key] = val; i++; }
  }
  return out;
}

function int(v, d) { return Number.isFinite(Number(v)) ? Math.trunc(Number(v)) : d; }
function sleep(ms) { return new Promise((r) => setTimeout(r, Math.max(0, ms))); }
function short(a) { return a.length > 16 ? `${a.slice(0, 8)}…${a.slice(-6)}` : a; }
function log(msg) { console.log(msg === '' ? '' : `[${new Date().toISOString().slice(11, 23)}] ${msg}`); }

function fmtDuration(ms) {
  if (ms <= 0) return '0s';
  const s = Math.round(ms / 1000);
  return `${Math.floor(s / 3600)}h ${Math.floor((s % 3600) / 60)}m ${s % 60}s`;
}
