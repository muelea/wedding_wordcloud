'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { generateEventSlug, isEventSlug } = require('../src/slug');

test('event IDs preserve all 16 random bytes in URL-safe, unpadded encoding', (t) => {
  const vectors = [
    ['00000000000000000000000000000000', 'AAAAAAAAAAAAAAAAAAAAAA'],
    ['ffffffffffffffffffffffffffffffff', '_____________________w'],
    ['000102030405060708090a0b0c0d0e0f', 'AAECAwQFBgcICQoLDA0ODw'],
    ['fbf01b09d11fd35db7e39ebbf3dc7265', '-_AbCdEf0123456789xyZQ'],
  ];
  const randomBytes = t.mock.method(crypto, 'randomBytes');
  for (const [hex, expected] of vectors) {
    const bytes = Buffer.from(hex, 'hex');
    randomBytes.mock.mockImplementation((size) => {
      assert.equal(size, 16);
      return bytes;
    });
    const slug = generateEventSlug();
    assert.equal(slug, expected);
    assert.equal(isEventSlug(slug), true);
    assert.deepEqual(Buffer.from(slug, 'base64url'), bytes);
  }
  assert.equal(randomBytes.mock.callCount(), vectors.length);
});

test('event ID validation accepts only canonical 16-byte base64url values', () => {
  for (const valid of ['-_AbCdEf0123456789xyZQ', '_-aBcDeF0123456789XYzQ']) {
    assert.equal(isEventSlug(valid), true);
  }
  for (const invalid of [null, '', 'a'.repeat(21), 'a'.repeat(23), 'a'.repeat(22),
    '/'.repeat(22), 'wortwolke-9ygku']) {
    assert.equal(isEventSlug(invalid), false);
  }
});

test('event ID generation fails if cryptographic randomness is unavailable', (t) => {
  const failure = new Error('random source unavailable');
  t.mock.method(crypto, 'randomBytes', () => { throw failure; });
  assert.throws(generateEventSlug, (error) => error === failure);
});
