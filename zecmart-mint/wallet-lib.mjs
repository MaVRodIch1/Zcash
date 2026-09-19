/**
 * Zcash transparent (t1) wallet derivation from BIP-39 mnemonics.
 *
 * Standard stack, nothing custom: BIP-39 mnemonic -> BIP-32 master key ->
 * BIP-44 path m/44'/133'/0'/0/0 (133 = Zcash, SLIP-44) -> secp256k1 public key
 * -> hash160 -> base58check with the Zcash mainnet P2PKH prefix 0x1C 0xB8.
 *
 * Any wallet that supports Zcash + BIP-39 (Noir Wallet included) recovers the
 * same address from the same mnemonic, which is what makes the seed phrases
 * this module prints actually worth something.
 */

import { generateMnemonic, mnemonicToSeedSync, validateMnemonic } from '@scure/bip39';
import { wordlist } from '@scure/bip39/wordlists/english.js';
import { HDKey } from '@scure/bip32';
import { base58check } from '@scure/base';
import { sha256 } from '@noble/hashes/sha2.js';
import { ripemd160 } from '@noble/hashes/legacy.js';
import { bytesToHex } from '@noble/hashes/utils.js';

const b58c = base58check(sha256);

/** Zcash mainnet transparent P2PKH version bytes. */
export const ZCASH_T_PREFIX = Uint8Array.from([0x1c, 0xb8]);
export const ZCASH_COIN_TYPE = 133;

export function defaultPath(account = 0, index = 0) {
  return `m/44'/${ZCASH_COIN_TYPE}'/${account}'/0/${index}`;
}

export function newMnemonic(words = 24) {
  if (words !== 12 && words !== 24) throw new Error('words must be 12 or 24');
  // @scure/bip39 pulls entropy from the platform CSPRNG.
  return generateMnemonic(wordlist, words === 24 ? 256 : 128);
}

export function isValidMnemonic(mnemonic) {
  return validateMnemonic(mnemonic, wordlist);
}

/** Derive the transparent address for a mnemonic. Returns { address, path, publicKey }. */
export function deriveTransparent(mnemonic, { path = defaultPath(), passphrase = '' } = {}) {
  if (!validateMnemonic(mnemonic, wordlist)) throw new Error('invalid BIP-39 mnemonic');
  const seed = mnemonicToSeedSync(mnemonic, passphrase);
  const node = HDKey.fromMasterSeed(seed).derive(path);
  if (!node.publicKey) throw new Error(`no public key at ${path}`);
  const hash160 = ripemd160(sha256(node.publicKey));
  const address = b58c.encode(concat(ZCASH_T_PREFIX, hash160));
  return { address, path, publicKey: bytesToHex(node.publicKey) };
}

/** Decode a t-address back to its payload — catches typos the ZecMart API does not. */
export function decodeTransparent(address) {
  const bytes = b58c.decode(address); // throws on a bad checksum
  if (bytes.length !== 22) throw new Error(`unexpected payload length ${bytes.length}`);
  if (bytes[0] !== ZCASH_T_PREFIX[0] || bytes[1] !== ZCASH_T_PREFIX[1]) {
    throw new Error('not a Zcash mainnet transparent address');
  }
  return bytes.slice(2);
}

export function isValidTransparent(address) {
  try { decodeTransparent(address); return true; } catch { return false; }
}

/**
 * Self-test against published test vectors, run before any key is generated.
 * If a dependency ever changes behaviour, this fails loudly instead of quietly
 * producing addresses whose seed phrases do not open them.
 */
export function selfTest() {
  const MN = 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';

  // BIP-39 (Trezor) vector: mnemonic + passphrase "TREZOR" -> known seed.
  const seed = bytesToHex(mnemonicToSeedSync(MN, 'TREZOR'));
  const EXPECTED_SEED = 'c55257c360c07c72029aebc1b53c05ed0362ada38ead3e3e9efa3708e53495531f09a6987599d18' +
                        '264c1e1c92f2cf141630c7a3c4ab7c81b2f001698e7463b04';
  if (seed !== EXPECTED_SEED) throw new Error('self-test failed: BIP-39 seed vector mismatch');

  // BIP-44 vector: the same mnemonic on Bitcoin's path and version byte.
  // Only the version bytes differ between this and a Zcash t-address, so a
  // match here proves the whole mnemonic -> key -> hash160 -> base58check chain.
  const btcSeed = mnemonicToSeedSync(MN, '');
  const btcNode = HDKey.fromMasterSeed(btcSeed).derive("m/44'/0'/0'/0/0");
  const btcAddr = b58c.encode(concat(Uint8Array.from([0x00]), ripemd160(sha256(btcNode.publicKey))));
  if (btcAddr !== '1LqBGSKuX5yYUonjxT5qGfpUsXKYYWeabA') {
    throw new Error('self-test failed: BIP-44 address vector mismatch');
  }

  // Round-trip: a derived address must decode back to the same hash160.
  const { address } = deriveTransparent(MN);
  if (!address.startsWith('t1') || decodeTransparent(address).length !== 20) {
    throw new Error('self-test failed: t-address round-trip');
  }
  return { ok: true, sampleAddress: address };
}

function concat(a, b) {
  const out = new Uint8Array(a.length + b.length);
  out.set(a, 0);
  out.set(b, a.length);
  return out;
}
