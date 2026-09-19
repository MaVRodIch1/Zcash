#!/usr/bin/env node
/**
 * Generates Zcash wallets for the ZecMart mint: a BIP-39 seed phrase per wallet,
 * its transparent (t1) address, and the two files the rest of the tooling uses.
 *
 *   wallets.txt           public addresses, fed to mint.mjs and report.mjs
 *   wallets-secret.json   seed phrases (chmod 600, git-ignored) — the ONLY key
 *                         to whatever gets minted to those addresses
 *
 * Usage:
 *   node gen-wallets.mjs --count 25
 *   node gen-wallets.mjs --count 10 --append
 *   node gen-wallets.mjs --verify            # re-derive every address from its seed
 *   node gen-wallets.mjs --show w001         # print one seed phrase to import
 *
 * Flags:
 *   --count <n>        how many wallets to generate
 *   --words <12|24>    seed phrase length (default 12)
 *   --mode <seeds|accounts>
 *                      seeds:    one seed phrase per wallet, account 0 (default,
 *                                works with any BIP-39 wallet)
 *                      accounts: ONE seed phrase, N accounts derived from it
 *                                (one import instead of N — but only correct if
 *                                the wallet uses the same account-index scheme)
 *   --secret <file>    default wallets-secret.json
 *   --addresses <file> default wallets.txt
 *   --append           add to the existing files instead of refusing
 *   --force            overwrite existing files
 *   --print            also print seed phrases to the terminal (off by default)
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import {
  newMnemonic, deriveTransparent, defaultPath, isValidTransparent, selfTest, isValidMnemonic,
} from './wallet-lib.mjs';

const args = parseArgs(process.argv.slice(2));
const SECRET_FILE = args.secret ?? 'wallets-secret.json';
const ADDRESS_FILE = args.addresses ?? 'wallets.txt';

main().catch((err) => { console.error(`error: ${err.message}`); process.exit(1); });

async function main() {
  // Never generate a key with a crypto stack that failed its own vectors.
  const st = selfTest();
  if (args.verify) return verify();
  if (args.show) return show(String(args.show));

  const count = int(args.count, 0);
  if (count < 1) throw new Error('pass --count <n>, e.g. --count 25 (or --verify / --show <label>)');

  const words = int(args.words, 12);
  const mode = args.mode ?? 'seeds';
  if (mode !== 'seeds' && mode !== 'accounts') throw new Error('--mode must be "seeds" or "accounts"');

  console.log(`crypto self-test ok (vector address ${st.sampleAddress})`);

  const existing = await readSecret().catch(() => null);
  if (existing && !args.append && !args.force) {
    throw new Error(`${SECRET_FILE} already exists. Use --append to add wallets, or --force to ` +
                    `overwrite (overwriting DESTROYS the seed phrases in it).`);
  }
  const previous = args.append && existing ? existing.wallets : [];
  const startIndex = previous.length;

  const wallets = [...previous];
  const sharedMnemonic = mode === 'accounts'
    ? (previous[0]?.mnemonic ?? newMnemonic(words))
    : null;

  for (let i = 0; i < count; i++) {
    const index = startIndex + i;
    const mnemonic = mode === 'accounts' ? sharedMnemonic : newMnemonic(words);
    // seeds mode: one seed, account 0. accounts mode: one seed, account i.
    const derivePath = mode === 'accounts' ? defaultPath(index, 0) : defaultPath(0, 0);
    const { address, publicKey } = deriveTransparent(mnemonic, { path: derivePath });

    // Verify immediately: re-derive and decode, so a broken wallet never reaches the file.
    const recheck = deriveTransparent(mnemonic, { path: derivePath }).address;
    if (recheck !== address || !isValidTransparent(address)) {
      throw new Error(`derivation is not reproducible for wallet ${index} — aborting, nothing written`);
    }
    wallets.push({
      label: `w${String(index + 1).padStart(3, '0')}`,
      index, mode, mnemonic, path: derivePath, address, publicKey,
      createdAt: new Date().toISOString(),
    });
  }

  await writeSecret({
    warning: 'SEED PHRASES. Anyone with this file controls these wallets and everything minted ' +
             'to them. Keep it offline, never commit it, never paste it anywhere.',
    createdAt: existing?.createdAt ?? new Date().toISOString(),
    derivation: { scheme: 'BIP-39 + BIP-44', coinType: 133, addressType: 'transparent p2pkh (t1)' },
    wallets,
  });
  await writeAddresses(wallets);

  console.log(`generated ${count} wallet(s), ${wallets.length} total`);
  console.log(`  seed phrases -> ${SECRET_FILE} (chmod 600)`);
  console.log(`  addresses    -> ${ADDRESS_FILE}`);
  if (mode === 'accounts') {
    console.log(`  mode=accounts: all wallets come from ONE seed phrase (${words} words).`);
  }
  if (args.print) {
    console.log('');
    for (const w of wallets.slice(startIndex)) console.log(`${w.label}  ${w.address}\n  ${w.mnemonic}`);
  }
  console.log('');
  console.log('Before the drop, do this once — it is the only real proof the seeds work:');
  console.log(`  1. node gen-wallets.mjs --show ${wallets[startIndex].label}`);
  console.log('  2. import that seed phrase into Noir Wallet as a new wallet');
  console.log('  3. compare its TRANSPARENT address with the one printed next to it');
  console.log('  If they differ, stop — do not mint to addresses you cannot open.');
}

/* ------------------------------------------------------------------ modes */

async function verify() {
  const data = await readSecret();
  let bad = 0;
  for (const w of data.wallets) {
    const problems = [];
    if (!isValidMnemonic(w.mnemonic)) problems.push('invalid BIP-39 mnemonic');
    else if (deriveTransparent(w.mnemonic, { path: w.path }).address !== w.address) {
      problems.push('address does not match its seed phrase');
    }
    if (!isValidTransparent(w.address)) problems.push('address checksum invalid');
    if (problems.length) { bad++; console.log(`  BAD  ${w.label} ${w.address}: ${problems.join(', ')}`); }
  }
  const addresses = new Set(data.wallets.map((w) => w.address));
  if (addresses.size !== data.wallets.length) {
    bad++;
    console.log(`  BAD  duplicate addresses: ${data.wallets.length - addresses.size}`);
  }
  console.log(bad === 0
    ? `verify ok: ${data.wallets.length} wallets, every address re-derives from its seed phrase`
    : `verify FAILED: ${bad} problem(s)`);
  if (bad) process.exitCode = 1;
}

async function show(label) {
  const data = await readSecret();
  const w = data.wallets.find((x) => x.label === label || x.address === label || String(x.index) === label);
  if (!w) throw new Error(`no wallet "${label}" in ${SECRET_FILE}`);
  console.log(`${w.label}  ${w.address}  (${w.path})`);
  console.log(w.mnemonic);
}

/* ------------------------------------------------------------------ files */

async function readSecret() {
  return JSON.parse(await fs.readFile(SECRET_FILE, 'utf8'));
}

async function writeSecret(data) {
  const tmp = `${SECRET_FILE}.tmp`;
  await fs.writeFile(tmp, JSON.stringify(data, null, 2), { mode: 0o600 });
  await fs.chmod(tmp, 0o600);
  await fs.rename(tmp, SECRET_FILE);
  await fs.chmod(SECRET_FILE, 0o600);
}

async function writeAddresses(wallets) {
  const lines = [
    '# Generated by gen-wallets.mjs — public addresses only, safe to keep here.',
    `# Seed phrases live in ${path.basename(SECRET_FILE)}.`,
    '',
    ...wallets.map((w) => `${w.address}  # ${w.label}`),
    '',
  ];
  await fs.writeFile(ADDRESS_FILE, lines.join('\n'));
}

/* ------------------------------------------------------------------ utils */

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
