'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { slugify, suggestSlug, randomSuffix, makeUniqueSlug, SUFFIX_ALPHABET, SUFFIX_LENGTH } = require('../src/slug');

test('randomSuffix produces fixed-length strings from the unambiguous alphabet only', () => {
  const alphabetSet = new Set(SUFFIX_ALPHABET.split(''));
  for (let i = 0; i < 50; i += 1) {
    const suffix = randomSuffix();
    assert.equal(suffix.length, SUFFIX_LENGTH);
    for (const ch of suffix) {
      assert.ok(alphabetSet.has(ch), `"${ch}" in "${suffix}" is not in SUFFIX_ALPHABET`);
    }
  }
  // Excludes visually-confusable characters -- these must never appear.
  for (const forbidden of ['0', 'O', '1', 'l', 'I']) {
    assert.ok(!SUFFIX_ALPHABET.includes(forbidden), `SUFFIX_ALPHABET should exclude "${forbidden}"`);
  }
});

// Proves the suffix is genuinely random-ish, not a sequential counter (e.g.
// "aaaaa", "aaaab", "aaaac", ...) that a stranger could enumerate to
// rediscover other couples' events -- the exact privacy property this
// feature exists to guarantee. Not a real entropy analysis, just a smoke
// check that would fail hard against a naive counter-based implementation.
test('randomSuffix is not a sequential/enumerable counter', () => {
  const alphabetIndex = new Map([...SUFFIX_ALPHABET].map((ch, i) => [ch, i]));
  const toNumber = (suffix) => [...suffix].reduce((acc, ch) => acc * SUFFIX_ALPHABET.length + alphabetIndex.get(ch), 0);

  const n = 40;
  const suffixes = Array.from({ length: n }, () => randomSuffix());

  // Extremely unlikely to collide across 40 draws from a ~33.6M space --
  // a counter or low-entropy generator would collide/repeat far sooner.
  assert.equal(new Set(suffixes).size, n, 'suffixes should not repeat across 40 draws');

  // A sequential counter would be monotonically increasing (or decreasing)
  // for every consecutive pair; true randomness essentially never is, for
  // 40 draws in a row (probability ~2^-39 for either direction).
  const values = suffixes.map(toNumber);
  const isMonotonic = values.every((v, i) => i === 0 || v > values[i - 1])
    || values.every((v, i) => i === 0 || v < values[i - 1]);
  assert.equal(isMonotonic, false, 'suffixes look monotonically ordered -- looks like a counter, not random');

  // A counter starting from a fixed seed would also produce suffixes whose
  // generation order matches their sorted order; random draws essentially
  // never do for 40 items (1-in-40! chance).
  const sorted = [...suffixes].sort();
  assert.notDeepEqual(suffixes, sorted, 'generation order matches sorted order -- looks like a counter, not random');
});

test('makeUniqueSlug appends "<prefix>-<suffix>" and accepts it when unused', () => {
  const slug = makeUniqueSlug('johanna-und-peter', () => false);
  const match = /^johanna-und-peter-([a-z0-9]{5})$/.exec(slug);
  assert.ok(match, `expected "${slug}" to match the prefix-suffix pattern`);
});

test('makeUniqueSlug retries with a fresh suffix on collision, and eventually succeeds', () => {
  const seen = [];
  let calls = 0;
  const exists = (candidate) => {
    calls += 1;
    seen.push(candidate);
    return calls <= 2; // first two candidates are "taken", third is free
  };
  const slug = makeUniqueSlug('anna-und-max', exists);
  assert.equal(calls, 3);
  assert.equal(new Set(seen).size, 3, 'each retry should try a different candidate, not repeat one');
  assert.ok(slug.startsWith('anna-und-max-'));
  assert.equal(slug, seen[2]);
});

test('makeUniqueSlug throws rather than looping forever if every candidate is somehow taken', () => {
  assert.throws(() => makeUniqueSlug('anna-und-max', () => true, { maxAttempts: 5 }), /anna-und-max/);
});

test('makeUniqueSlug falls back to a default prefix for an empty base', () => {
  const slug = makeUniqueSlug('', () => false);
  assert.ok(slug.startsWith('unser-brautpaar-'));
});

// Existing behavior, unchanged by this feature -- pinned down here so a
// future refactor of slug.js can't silently break the name-derivation part.
test('slugify/suggestSlug still transliterate umlauts as before', () => {
  assert.equal(slugify('Jö & Björn Müller'), 'joe-und-bjoern-mueller');
  assert.equal(suggestSlug('Johanna & Peter'), 'johanna-und-peter');
  assert.equal(suggestSlug(''), 'unser-brautpaar');
});
