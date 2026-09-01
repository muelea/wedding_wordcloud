'use strict';

const crypto = require('crypto');

// German-aware slugify: transliterates umlauts/ß instead of just stripping
// them (so "Jö & Björn" doesn't collapse to an ugly/ambiguous slug), then
// falls back to stripping remaining diacritics generically.
const UMLAUT_MAP = {
  ä: 'ae', ö: 'oe', ü: 'ue', ß: 'ss',
  Ä: 'Ae', Ö: 'Oe', Ü: 'Ue',
};

function slugify(input) {
  let s = String(input || '');
  s = s.replace(/[äöüßÄÖÜ]/g, (ch) => UMLAUT_MAP[ch] || ch);
  s = s.replace(/&/g, ' und ');
  s = s.normalize('NFD').replace(/[\u0300-\u036f]/g, ''); // strip remaining diacritics
  s = s.toLowerCase();
  s = s.replace(/[^a-z0-9]+/g, '-');
  s = s.replace(/^-+|-+$/g, '');
  s = s.replace(/-{2,}/g, '-');
  return s;
}

// ── Random suffix ────────────────────────────────────────────────────────
// Every event's *final* slug (see makeUniqueSlug below) always gets a short
// random suffix appended to the name-derived prefix, e.g.
// "sommerfest-2026-x7k2q". Two problems, one fix:
//   1. Collisions: common titles ("sommerfest") used to 409 on the
//      second event with the same title, forcing a manual retry.
//   2. Privacy: a guessable slug lets a stranger who guesses a common title
//      view that event's (unauthenticated-read) live word cloud.
//      Admin actions are PIN-gated, but *viewing* submitted guest words is
//      not, so an unguessable slug is the actual privacy boundary here.
// The prefix is kept (not replaced by a fully opaque id) because it's
// genuinely useful as a spoken/typed fallback if a QR code fails to scan —
// "unsere Wortwolke ist unter sommerfest-irgendwas" is still
// findable/memorable in a way a random ID alone would not be.
//
// Alphabet excludes visually-confusable characters (0/O, 1/l/I) so the
// suffix stays human-typeable as that fallback, even though guests reach
// it via QR code in the common case.
const SUFFIX_ALPHABET = '23456789abcdefghjkmnpqrstuvwxyz'; // 32 chars
const SUFFIX_LENGTH = 5; // 32^5 ≈ 33.6M possible suffixes per prefix

// Cryptographically random (crypto.randomBytes), not a sequential counter
// or anything else an attacker could enumerate.
function randomSuffix(length = SUFFIX_LENGTH) {
  const bytes = crypto.randomBytes(length);
  let out = '';
  for (let i = 0; i < length; i += 1) {
    out += SUFFIX_ALPHABET[bytes[i] % SUFFIX_ALPHABET.length];
  }
  return out;
}

// Builds the final slug: name-derived prefix + random suffix, retrying with
// a fresh suffix on the (astronomically unlikely) case that `exists()`
// reports a collision, rather than assuming one can never happen.
// `exists` is a `(candidateSlug) => boolean` predicate (e.g. db.slugExists).
function makeUniqueSlug(base, exists, { maxAttempts = 10 } = {}) {
  const prefix = base || 'wortwolke';
  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    const candidate = `${prefix}-${randomSuffix()}`;
    if (!exists(candidate)) return candidate;
  }
  throw new Error(`could not generate a unique slug for "${prefix}" after ${maxAttempts} attempts`);
}

module.exports = { slugify, randomSuffix, makeUniqueSlug, SUFFIX_ALPHABET, SUFFIX_LENGTH };
