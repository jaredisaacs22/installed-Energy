#!/usr/bin/env node
// The encrypted price book for the Site Analysis Workbench (see docs/WORKBENCH.md, "Prices").
//
// The repository and its Pages site are public, so unit prices are only ever committed encrypted:
// AES-GCM-256 with a key derived from a team passphrase (PBKDF2-SHA256). The workbench decrypts the
// book in the browser with the same passphrase (scripts/workbench-addon/addon.js holds the browser half).
// Binary fields are written as letters a–p (one per 4 bits) rather than base64, so the committed file
// carries no digit runs at all and can never trip the price-leak check in scrub-workbench.mjs.
//
// Usage (the passphrase is read from the PRICEBOOK_PASSPHRASE environment variable, never an argument):
//   node scripts/pricebook.mjs extract <workbench-source.html>       print a plain price book taken from a workbench file
//   node scripts/pricebook.mjs encrypt <plain.json> [out.enc.json]   default out: assets/workbench/pricebook.enc.json
//   node scripts/pricebook.mjs decrypt [in.enc.json]                 print the plain price book
// Keep plain price books outside the repository.
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { webcrypto } from 'node:crypto';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
export const DEFAULT_BOOK = join(ROOT, 'assets', 'workbench', 'pricebook.enc.json');
export const ITERATIONS = 600000;
const subtle = webcrypto.subtle;

/** Bytes → letters a–p, two per byte (high nibble first). */
export function toLetters(bytes) {
  let s = '';
  for (const b of bytes) s += String.fromCharCode(97 + (b >> 4), 97 + (b & 15));
  return s;
}
export function fromLetters(s) {
  if (typeof s !== 'string' || s.length % 2 || /[^a-p]/.test(s)) throw new Error('pricebook: malformed field');
  const out = new Uint8Array(s.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = ((s.charCodeAt(2 * i) - 97) << 4) | (s.charCodeAt(2 * i + 1) - 97);
  return out;
}

async function deriveKey(passphrase, salt, iterations) {
  const base = await subtle.importKey('raw', new TextEncoder().encode(passphrase), 'PBKDF2', false, ['deriveKey']);
  return subtle.deriveKey({ name: 'PBKDF2', hash: 'SHA-256', salt, iterations }, base, { name: 'AES-GCM', length: 256 }, true, ['encrypt', 'decrypt']);
}

/** Problems with a plain price book (empty list = valid). */
export function validatePriceBook(book) {
  const problems = [];
  const amount = (v, where) => {
    if (v != null && !(typeof v === 'number' && Number.isFinite(v) && v >= 0)) problems.push(`${where} must be a non-negative number or null`);
  };
  if (!book || typeof book !== 'object') return ['price book is not an object'];
  if (book.version !== 1) problems.push('version must be 1');
  if (!book.units || typeof book.units !== 'object' || Array.isArray(book.units)) problems.push('units must be an object keyed by unit id');
  else
    for (const [id, u] of Object.entries(book.units)) {
      if (!u || typeof u !== 'object') {
        problems.push(`units["${id}"] must be an object`);
        continue;
      }
      for (const k of ['price', 'trailer_price', 'rental_per_month']) amount(u[k], `units["${id}"].${k}`);
    }
  amount(book.new_unit_price, 'new_unit_price');
  const d = book.defaults || {};
  for (const k of ['install_usd', 'om_usd_per_yr']) amount(d[k], `defaults.${k}`);
  return problems;
}

export async function encryptPriceBook(book, passphrase, { iterations = ITERATIONS } = {}) {
  const problems = validatePriceBook(book);
  if (problems.length) throw new Error(`pricebook: ${problems.join('; ')}`);
  if (!passphrase || passphrase.length < 12) throw new Error('pricebook: passphrase must be at least 12 characters');
  const salt = webcrypto.getRandomValues(new Uint8Array(16));
  const iv = webcrypto.getRandomValues(new Uint8Array(12));
  const key = await deriveKey(passphrase, salt, iterations);
  const ct = new Uint8Array(await subtle.encrypt({ name: 'AES-GCM', iv }, key, new TextEncoder().encode(JSON.stringify(book))));
  return { format: 'atlas-pricebook', kdf: 'PBKDF2-SHA256', iterations, cipher: 'AES-GCM-256', salt: toLetters(salt), iv: toLetters(iv), data: toLetters(ct) };
}

export async function decryptPriceBook(env, passphrase) {
  if (!env || env.format !== 'atlas-pricebook') throw new Error('pricebook: not an Atlas price book');
  const key = await deriveKey(passphrase, fromLetters(env.salt), env.iterations);
  let plain;
  try {
    plain = await subtle.decrypt({ name: 'AES-GCM', iv: fromLetters(env.iv) }, key, fromLetters(env.data));
  } catch {
    throw new Error('pricebook: wrong passphrase (or the file was altered)');
  }
  return JSON.parse(new TextDecoder().decode(plain));
}

/** A plain price book built from the prices in a workbench source file (the original, not the Atlas build). */
export function extractPriceBook(src) {
  const cat = src.match(/var UNITS=\[[\s\S]*?\n\];/);
  if (!cat) throw new Error('pricebook: UNITS catalog not found');
  const units = {};
  for (const m of cat[0].matchAll(/\{id:"([^"]+)"[^\n]*?\bcost:(null|\d+(?:\.\d+)?)(?:,\s*costTrailer:(\d+(?:\.\d+)?))?/g)) {
    units[m[1]] = { price: m[2] === 'null' ? null : +m[2], ...(m[3] ? { trailer_price: +m[3] } : {}), rental_per_month: null };
  }
  if (!Object.keys(units).length) throw new Error('pricebook: no units with a cost field found');
  const num = (text, re) => {
    const m = text.match(re);
    return m && +m[1] > 0 ? +m[1] : null;
  };
  const econ = src.match(/function blankEconomics\(\)\{return \{[\s\S]*?\};\}/)?.[0] || '';
  return {
    version: 1,
    updated: new Date().toISOString().slice(0, 10),
    currency: 'USD',
    units,
    new_unit_price: num(src, /SZ_UNITS\.push\(\{[^}]*?\bcost:(\d+(?:\.\d+)?)\}/),
    defaults: { install_usd: num(econ, /installCost:(\d+(?:\.\d+)?)/), om_usd_per_yr: num(econ, /omUSD:(\d+(?:\.\d+)?)/) },
  };
}

function passphraseFromEnv() {
  const p = process.env.PRICEBOOK_PASSPHRASE;
  if (!p) {
    console.error('Set PRICEBOOK_PASSPHRASE in the environment (it is never taken as an argument, so it stays out of shell history).');
    process.exit(2);
  }
  return p;
}

async function main([cmd, a, b]) {
  if (cmd === 'extract' && a) {
    process.stdout.write(`${JSON.stringify(extractPriceBook(readFileSync(a, 'utf8')), null, 2)}\n`);
  } else if (cmd === 'encrypt' && a) {
    const out = b || DEFAULT_BOOK;
    const env = await encryptPriceBook(JSON.parse(readFileSync(a, 'utf8')), passphraseFromEnv());
    writeFileSync(out, `${JSON.stringify(env, null, 2)}\n`);
    console.log(`wrote ${out}. Rebuild the workbench to embed it: node scripts/workbench-addon.mjs`);
  } else if (cmd === 'decrypt') {
    const book = await decryptPriceBook(JSON.parse(readFileSync(a || DEFAULT_BOOK, 'utf8')), passphraseFromEnv());
    process.stdout.write(`${JSON.stringify(book, null, 2)}\n`);
  } else {
    console.error('Usage: node scripts/pricebook.mjs extract <workbench.html> | encrypt <plain.json> [out.enc.json] | decrypt [in.enc.json]');
    process.exit(2);
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).catch((err) => {
    console.error(err.message);
    process.exit(1);
  });
}
