'use strict';

/**
 * Admin PIN session token.
 *
 * The brief: "The admin PIN gates the mutating actions (reset/new round) on
 * the display page, entered once per browser session." That's a session-
 * scoped, not persistent-login, requirement — so instead of a full
 * accounts/cookie-session system, verifying the PIN once mints a short-lived
 * HMAC-signed token that the browser holds in sessionStorage (cleared when
 * the tab closes) and sends as `Authorization: Bearer <token>` on the reset
 * call. No server-side session store needed; the token is self-verifying.
 *
 * Token shape: base64url(slug.expiresAt.signature)
 * signature = HMAC-SHA256(secret, `${slug}.${expiresAt}`)
 */

const crypto = require('crypto');

const SECRET = process.env.ADMIN_TOKEN_SECRET || 'dev-only-insecure-secret-change-me';
const TOKEN_TTL_MS = 12 * 60 * 60 * 1000; // 12h — comfortably covers one wedding day

function sign(slug, expiresAt) {
  return crypto.createHmac('sha256', SECRET).update(`${slug}.${expiresAt}`).digest('hex');
}

function issueToken(slug) {
  const expiresAt = Date.now() + TOKEN_TTL_MS;
  const sig = sign(slug, expiresAt);
  const payload = `${slug}.${expiresAt}.${sig}`;
  return Buffer.from(payload, 'utf8').toString('base64url');
}

function verifyToken(token, expectedSlug) {
  if (!token || typeof token !== 'string') return false;
  let payload;
  try {
    payload = Buffer.from(token, 'base64url').toString('utf8');
  } catch {
    return false;
  }
  const parts = payload.split('.');
  if (parts.length !== 3) return false;
  const [slug, expiresAtStr, sig] = parts;
  if (slug !== expectedSlug) return false;
  const expiresAt = Number(expiresAtStr);
  if (!Number.isFinite(expiresAt) || Date.now() > expiresAt) return false;
  const expectedSig = sign(slug, expiresAtStr);
  const a = Buffer.from(sig, 'hex');
  const b = Buffer.from(expectedSig, 'hex');
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

module.exports = { issueToken, verifyToken };
