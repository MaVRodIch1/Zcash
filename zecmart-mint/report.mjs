#!/usr/bin/env node
/**
 * Post-drop report: what landed in which wallet.
 *
 * Reads the wallet list (or the secret file, for labels), asks ZecMart which
 * collectibles each address holds, and prints a wallet -> NFT table. Seed
 * phrases are never read into the output.
 *
 * Usage:
 *   node report.mjs
 *   node report.mjs --json report.json
 *   node report.mjs --orders results-2026-09-19T14-30-00-000Z.json
 *
 * Flags:
 *   --wallets <file>   address list (default wallets.txt)
 *   --secret <file>    secret file, used only for labels (default wallets-secret.json)
 *   --orders <file>    a results-*.json from mint.mjs, to cross-check orders vs items
 *   --json <file>      also write the report as JSON
 *   --base <url>       API base (default https://zecmart.com)
 *   --batch <n>        addresses per request (default 20)
 */

import fs from 'node:fs/promises';

const args = parseArgs(process.argv.slice(2));
const BASE = (args.base ?? 'https://zecmart.com').replace(/\/+$/, '');
const BATCH = int(args.batch, 20);

main().catch((err) => { console.error(`error: ${err.message}`); process.exit(1); });

async function main() {
  const labels = await loadLabels(args.secret ?? 'wallets-secret.json');
  const addresses = await loadAddresses(args.wallets ?? 'wallets.txt', labels);
  if (!addresses.length) throw new Error('no wallet addresses found');

  const config = await api('/api/mint/config').catch(() => ({ network: 'mainnet' }));
  const network = config.network ?? 'mainnet';
  console.log(`checking ${addresses.length} wallet(s) on ${network}...\n`);

  const byAddress = new Map(addresses.map((a) => [a.address, { ...a, items: [] }]));
  for (const chunk of chunks(addresses, BATCH)) {
    const params = new URLSearchParams();
    params.set('network', network);
    for (const a of chunk) params.append('walletAddress', a.address);
    const res = await api(`/api/collection/my-collection-with-state?${params.toString()}`);
    for (const item of res.items ?? []) {
      // The endpoint answers for the batch, so map each item back to its owner.
      const owner = ownerOf(item, byAddress);
      if (owner) owner.items.push(item);
      else console.log(`  (item ${item.id ?? '?'} returned without a matching wallet)`);
    }
  }

  const orders = args.orders ? await readJson(args.orders).catch(() => null) : null;
  const orderByWallet = new Map((orders ?? []).map((o) => [o.wallet, o]));

  let total = 0;
  const rows = [];
  for (const w of byAddress.values()) {
    total += w.items.length;
    const order = orderByWallet.get(w.address);
    rows.push({ label: w.label, address: w.address, count: w.items.length,
                orderId: order?.orderId, orderStatus: order?.status,
                items: w.items.map(describe) });

    const head = `${w.label.padEnd(6)} ${w.address}`;
    if (w.items.length) {
      console.log(`${head}  ${w.items.length} NFT`);
      for (const it of w.items) {
        const d = describe(it);
        console.log(`        ${d.name}${d.tokenId ? ` #${d.tokenId}` : ''}${d.image ? `  ${d.image}` : ''}`);
      }
    } else if (order?.orderId) {
      console.log(`${head}  no items yet (order ${order.orderId}, status ${order.orderStatus ?? '?'})`);
    } else {
      console.log(`${head}  nothing`);
    }
  }

  console.log('');
  console.log(`total: ${total} NFT across ${rows.filter((r) => r.count).length}/${rows.length} wallets`);
  console.log(`seed phrase for any of them: node gen-wallets.mjs --show <label>`);

  if (args.json) {
    await fs.writeFile(String(args.json), JSON.stringify({ network, total, wallets: rows }, null, 2));
    console.log(`written to ${args.json}`);
  }
}

/** Items carry the owning address under one of a few possible keys. */
function ownerOf(item, byAddress) {
  for (const key of ['walletAddress', 'ownerAddress', 'owner', 'address', 'holderAddress']) {
    const v = item?.[key];
    if (typeof v === 'string' && byAddress.has(v)) return byAddress.get(v);
  }
  return null;
}

function describe(item) {
  return {
    id: item.id,
    name: item.name ?? item.title ?? item.collectionName ?? 'item',
    tokenId: item.tokenId ?? item.itemNumber ?? item.number ?? item.serial,
    collection: item.collectionSlug ?? item.collection?.slug,
    image: item.imageUrl ?? item.image ?? item.media?.url,
    state: item.state ?? item.status,
  };
}

/* ------------------------------------------------------------------ input */

async function loadLabels(secretFile) {
  const labels = new Map();
  try {
    const data = JSON.parse(await fs.readFile(secretFile, 'utf8'));
    for (const w of data.wallets ?? []) labels.set(w.address, w.label);
  } catch { /* labels are a nicety; addresses alone are enough */ }
  return labels;
}

async function loadAddresses(file, labels) {
  const raw = await fs.readFile(file, 'utf8').catch(() => {
    throw new Error(`wallet file "${file}" not found`);
  });
  const out = [];
  const seen = new Set();
  for (const line of raw.split('\n')) {
    const address = line.split('#')[0].split(',')[0].trim();
    if (!address || seen.has(address)) continue;
    seen.add(address);
    out.push({ address, label: labels.get(address) ?? `w${String(out.length + 1).padStart(3, '0')}` });
  }
  return out;
}

const readJson = async (f) => JSON.parse(await fs.readFile(f, 'utf8'));

/* ------------------------------------------------------------------ utils */

async function api(path) {
  const res = await fetch(`${BASE}${path}`, { cache: 'no-store' });
  const text = await res.text();
  let data = {};
  try { data = text ? JSON.parse(text) : {}; } catch { /* non-JSON error page */ }
  if (!res.ok) throw new Error(data.message || data.error || `Request failed (${res.status})`);
  return data;
}

function* chunks(arr, size) {
  for (let i = 0; i < arr.length; i += size) yield arr.slice(i, i + size);
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
