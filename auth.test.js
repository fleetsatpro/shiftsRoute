import test from 'node:test';
import assert from 'node:assert/strict';
import { hashPin, isValidPin, parseCookies, safeEqual, sha256Hex } from './auth.js';

test('new PIN policy requires exactly six numeric digits', () => {
  assert.equal(isValidPin('123456'), true);
  assert.equal(isValidPin('1234'), false);
  assert.equal(isValidPin('12345'), false);
  assert.equal(isValidPin('1234567'), false);
  assert.equal(isValidPin('12a456'), false);
  assert.equal(isValidPin(123456), false);
});

test('PIN hashes are salted, deterministic for a supplied salt, and not plain PINs', async () => {
  const first = await hashPin('483920');
  const second = await hashPin('483920');
  assert.notEqual(first.salt, second.salt);
  assert.notEqual(first.hash, second.hash);
  assert.notEqual(first.hash, '483920');
  assert.deepEqual(await hashPin('483920', first.salt), first);
  assert.notEqual((await hashPin('483921', first.salt)).hash, first.hash);
});

test('constant-time equality helper rejects mismatches and type confusion', () => {
  assert.equal(safeEqual('abcdef', 'abcdef'), true);
  assert.equal(safeEqual('abcdef', 'abcdeg'), false);
  assert.equal(safeEqual('abcdef', 'abc'), false);
  assert.equal(safeEqual(null, 'null'), false);
});

test('SHA-256 helper returns a fixed-width lowercase hex digest', async () => {
  const digest = await sha256Hex('session-verifier');
  assert.match(digest, /^[a-f0-9]{64}$/);
});

test('cookie parsing tolerates malformed percent escapes and preserves token text', () => {
  const malformed = new Request('https://example.test/api/auth/me', {
    headers: { Cookie: 'roc_session=%; theme=dark%20mode' },
  });
  const parsed = parseCookies(malformed);
  assert.equal(parsed.roc_session, '%');
  assert.equal(parsed.theme, 'dark mode');

  const valid = new Request('https://example.test/api/auth/me', {
    headers: { Cookie: 'roc_session=' + 'a'.repeat(64) },
  });
  assert.equal(parseCookies(valid).roc_session, 'a'.repeat(64));
});
