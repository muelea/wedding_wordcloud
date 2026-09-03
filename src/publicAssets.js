'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const PUBLIC_ROOT = path.join(__dirname, '..', 'public');
const FINGERPRINT_LENGTH = 16;
const fingerprintCache = new Map();

function resolvePublicAsset(publicPath) {
  const pathname = String(publicPath || '');
  if (!pathname.startsWith('/') || pathname.includes('?') || pathname.includes('#') || pathname.includes('\0')) {
    throw new TypeError(`Invalid public asset path: ${pathname}`);
  }
  const filename = path.resolve(PUBLIC_ROOT, pathname.slice(1));
  if (filename === PUBLIC_ROOT || !filename.startsWith(`${PUBLIC_ROOT}${path.sep}`)) {
    throw new TypeError(`Public asset path escapes the public directory: ${pathname}`);
  }
  return { filename, pathname };
}

function fingerprintPublicAsset(publicPath, { missing = 'throw' } = {}) {
  let resolved;
  try {
    resolved = resolvePublicAsset(publicPath);
  } catch (error) {
    if (missing === 'null') return null;
    throw error;
  }

  const cached = fingerprintCache.get(resolved.filename);
  let contents;
  let signature;
  try {
    // The development server stays alive while templates/scripts are edited.
    // Never serve new bytes under yesterday's immutable fingerprint.
    if (process.env.NODE_ENV === 'production' && cached) return cached.fingerprint;
    const stat = fs.statSync(resolved.filename);
    signature = `${stat.size}:${stat.mtimeMs}:${stat.ctimeMs}`;
    if (cached?.signature === signature) return cached.fingerprint;
    contents = fs.readFileSync(resolved.filename);
  } catch (error) {
    if (missing === 'null' && error?.code === 'ENOENT') return null;
    throw error;
  }
  const fingerprint = crypto.createHash('sha256')
    .update(contents)
    .digest('hex')
    .slice(0, FINGERPRINT_LENGTH);
  fingerprintCache.set(resolved.filename, { fingerprint, signature });
  return fingerprint;
}

function publicAssetUrl(publicPath) {
  const { pathname } = resolvePublicAsset(publicPath);
  return `${pathname}?v=${fingerprintPublicAsset(pathname)}`;
}

function hasCurrentPublicAssetVersion(publicPath, version) {
  const fingerprint = fingerprintPublicAsset(publicPath, { missing: 'null' });
  return fingerprint !== null && fingerprint === String(version || '');
}

module.exports = {
  FINGERPRINT_LENGTH,
  PUBLIC_ROOT,
  fingerprintPublicAsset,
  hasCurrentPublicAssetVersion,
  publicAssetUrl,
  resolvePublicAsset,
};
