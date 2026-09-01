'use strict';

const { hasCurrentPublicAssetVersion } = require('./publicAssets');

const VERSION_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const STATIC_EXTENSION_RE = /\.(?:css|gif|html?|ico|jpe?g|js|json|mp4|png|svg|webp|woff2?|ttf)$/i;

function isLocaleManifest(pathname) {
  return /^\/locales\/[^/]+\.json$/i.test(pathname);
}

function cacheControlForStaticRequest(req) {
  const pathname = String(req.path || '');
  if (!STATIC_EXTENSION_RE.test(pathname)) return null;
  if (/\.html?$/i.test(pathname)) {
    return 'no-cache';
  }
  const version = typeof req.query?.v === 'string' ? req.query.v : '';
  // Locale catalogs are tiny and correctness matters more than a long-lived
  // immutable response. Revalidation still allows an ETag/304 while ensuring
  // a deployment can never strand a browser on an older set of translations.
  if (isLocaleManifest(pathname)) return 'no-cache';
  if (VERSION_RE.test(version)) {
    // First-party immutable URLs are content-addressed. A stale or invented
    // version must be revalidated instead of pinning mismatched bytes for a
    // year. Vendor routes are pinned to npm package versions and do not live
    // under public/, so they keep their explicit immutable version contract.
    if (pathname.startsWith('/vendor/')) return 'public, max-age=31536000, immutable';
    if (hasCurrentPublicAssetVersion(pathname, version)) {
      return 'public, max-age=31536000, immutable';
    }
    return 'no-cache';
  }
  return 'public, max-age=0, must-revalidate';
}

function staticCacheMiddleware(req, res, next) {
  const value = cacheControlForStaticRequest(req);
  if (value) res.setHeader('Cache-Control', value);
  next();
}

module.exports = { cacheControlForStaticRequest, staticCacheMiddleware };
