'use strict';

const crypto = require('node:crypto');

function normalizedDatabaseIdentity(value) {
  const parsed = new URL(String(value || ''));
  if (!['postgres:', 'postgresql:'].includes(parsed.protocol)) throw new Error('invalid database url');
  return [parsed.hostname.toLowerCase(), parsed.port || '5432', parsed.pathname, parsed.username].join('|');
}

function cleanupTargetFingerprint(env = process.env) {
  const supabase = new URL(String(env.SUPABASE_URL || ''));
  if (supabase.protocol !== 'https:') throw new Error('invalid Supabase url');
  const identity = [
    normalizedDatabaseIdentity(env.DATABASE_URL),
    supabase.hostname.toLowerCase(),
    String(env.SUPABASE_STORAGE_BUCKET || 'wolkenworte-private').trim(),
  ].join('|');
  return crypto.createHash('sha256').update(identity).digest('hex');
}

module.exports = { cleanupTargetFingerprint, normalizedDatabaseIdentity };
