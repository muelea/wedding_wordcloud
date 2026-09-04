'use strict';

const crypto = require('crypto');

// Sixteen bytes encode to 22 characters without padding. The final base64url
// character has four data bits, so only every fourth alphabet symbol is valid.
const EVENT_SLUG_RE = /^[A-Za-z0-9_-]{21}[AEIMQUYcgkosw048]$/;

// Event links grant public viewing and participation. Preserve all 128 random
// bits as 22 case-sensitive URL-safe characters, with no title or fixed prefix.
// Creation retries collisions against the permanent Postgres slug reservation.
function generateEventSlug() {
  return crypto.randomBytes(16).toString('base64url');
}

function isEventSlug(value) {
  return typeof value === 'string' && EVENT_SLUG_RE.test(value);
}

module.exports = { generateEventSlug, isEventSlug };
