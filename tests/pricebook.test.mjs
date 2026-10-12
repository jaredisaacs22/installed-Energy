// The encrypted price book (scripts/pricebook.mjs) and its browser half (scripts/workbench-addon/crypto.js).
// No real price or the team passphrase appears here: the round trips use made-up books and a test passphrase.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join, dirname } from 'node:path';
import { webcrypto } from 'node:crypto';
import vm from 'node:vm';

import { toLetters, fromLetters, encryptPriceBook, decryptPriceBook, validatePriceBook, extractPriceBook, DEFAULT_BOOK } from '../scripts/pricebook.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const PASS = 'test-passphrase-not-the-team-one';
const FAST = { iterations: 1000 };
const book = {
  version: 1,
  updated: '2026-01-01',
  currency: 'USD',
  units: { 'a/1': { price: 1111, trailer_price: 2222, rental_per_month: 33 }, 'b/2': { price: null, rental_per_month: null } },
  new_unit_price: 4444,
  defaults: { install_usd: 555, om_usd_per_yr: 66 },
};

/** The browser half, loaded on its own as the workbench page would run it. */
function browserCrypto() {
  const ctx = { crypto: webcrypto, TextEncoder, TextDecoder, Uint8Array, JSON };
  vm.createContext(ctx);
  vm.runInContext(readFileSync(join(ROOT, 'scripts', 'workbench-addon', 'crypto.js'), 'utf8'), ctx);
  return ctx;
}

test('letters encoding: round trip, only a–p, rejects anything else', () => {
  const bytes = new Uint8Array([0, 1, 15, 16, 127, 128, 255]);
  const s = toLetters(bytes);
  assert.match(s, /^[a-p]+$/);
  assert.deepEqual(fromLetters(s), bytes);
  assert.throws(() => fromLetters('abc'), /malformed/);
  assert.throws(() => fromLetters('a1'), /malformed/);
});

test('encrypt → decrypt round trip; a wrong passphrase or an altered file is refused', async () => {
  const env = await encryptPriceBook(book, PASS, FAST);
  assert.equal(env.format, 'atlas-pricebook');
  for (const k of ['salt', 'iv', 'data']) assert.match(env[k], /^[a-p]+$/);
  assert.doesNotMatch(`${env.salt}${env.iv}${env.data}`, /[^a-p]/, 'nothing readable in the envelope');
  assert.doesNotMatch(JSON.stringify(env), /1111|"a\/1"|"price"|rental/);
  assert.deepEqual(await decryptPriceBook(env, PASS), book);
  await assert.rejects(decryptPriceBook(env, 'another-passphrase-entirely'), /wrong passphrase/);
  const flipped = { ...env, data: (env.data[0] === 'a' ? 'b' : 'a') + env.data.slice(1) };
  await assert.rejects(decryptPriceBook(flipped, PASS), /wrong passphrase|altered/);
  await assert.rejects(encryptPriceBook(book, 'short'), /at least 12/);
});

test('price book validation', () => {
  assert.deepEqual(validatePriceBook(book), []);
  assert.ok(validatePriceBook({ ...book, version: 2 }).length);
  assert.ok(validatePriceBook({ ...book, units: { x: { price: -1 } } }).some((p) => /price/.test(p)));
  assert.ok(validatePriceBook({ ...book, units: { x: { rental_per_month: '12' } } }).some((p) => /rental/.test(p)));
  assert.ok(validatePriceBook({ ...book, defaults: { install_usd: NaN } }).some((p) => /install/.test(p)));
});

test('browser half opens what the script seals, and the script opens what the browser seals', async () => {
  const c = browserCrypto();
  const env = await encryptPriceBook(book, PASS, FAST);
  const key = await c.finDerive(PASS, env);
  assert.deepEqual(JSON.parse(JSON.stringify(await c.finOpen(env, key))), book);
  const edited = { ...book, units: { ...book.units, 'b/2': { price: 7777, rental_per_month: 88 } } };
  const resealed = await c.finSeal(edited, key, env);
  assert.equal(resealed.salt, env.salt, 'same passphrase and salt');
  assert.notEqual(resealed.iv, env.iv, 'fresh IV');
  assert.deepEqual(await decryptPriceBook(resealed, PASS), edited);
  await assert.rejects(c.finDerive('another-passphrase-entirely', env).then((k) => c.finOpen(env, k)));
  assert.equal(c.finLetters(c.finBytes('afpg')), 'afpg');
});

test('extract: a price book from a workbench source file', () => {
  const src = [
    'var UNITS=[',
    '  {id:"a/1",  kw:1, cost:1111, costTrailer:2222, label:"A"},',
    '  {id:"b/2",  kw:2, cost:null, label:"B"}',
    '];',
    'function blankEconomics(){return {',
    '  batteryCost:1111, installCost:555, capexUSD:1666,',
    '  itcPct:0.40, omUSD:66, termYrs:15',
    '};}',
    "SZ_UNITS.push({id:id,label:'New unit type',kw:100,effC:0.94,effD:0.94,cost:4444});",
  ].join('\n');
  const got = extractPriceBook(src);
  assert.deepEqual(got.units, { 'a/1': { price: 1111, trailer_price: 2222, rental_per_month: null }, 'b/2': { price: null, rental_per_month: null } }, 'rental rates are not in the workbench; they start blank');
  assert.equal(got.new_unit_price, 4444);
  assert.deepEqual(got.defaults, book.defaults);
  assert.deepEqual(validatePriceBook(got), []);
  assert.throws(() => extractPriceBook('<html></html>'), /UNITS/);
});

test('committed price book: encrypted, letters only, nothing readable', () => {
  const raw = readFileSync(DEFAULT_BOOK, 'utf8');
  const env = JSON.parse(raw);
  assert.equal(env.format, 'atlas-pricebook');
  assert.equal(env.kdf, 'PBKDF2-SHA256');
  assert.equal(env.cipher, 'AES-GCM-256');
  assert.ok(env.iterations >= 600000, 'PBKDF2 work factor');
  assert.equal(fromLetters(env.salt).length, 16);
  assert.equal(fromLetters(env.iv).length, 12);
  for (const k of ['salt', 'iv', 'data']) assert.match(env[k], /^[a-p]+$/);
  assert.deepEqual(Object.keys(env).sort(), ['cipher', 'data', 'format', 'iterations', 'iv', 'kdf', 'salt']);
  assert.doesNotMatch(raw, /units|rental|RPS/);
  const header = raw.replace(/"iterations": \d+/, '').replace('PBKDF2-SHA256', '').replace('AES-GCM-256', '');
  assert.doesNotMatch(header, /\d/, 'no figures anywhere else in the file');
});

test('plain price books are git-ignored', () => {
  const gi = readFileSync(join(ROOT, '.gitignore'), 'utf8');
  assert.match(gi, /^\*pricebook\*\.json$/m);
  assert.match(gi, /^!assets\/workbench\/pricebook\.enc\.json$/m);
});
