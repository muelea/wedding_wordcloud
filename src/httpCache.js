'use strict';

const VERSION_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const STATIC_EXTENSION_RE = /\.(?:css|gif|html?|ico|jpe?g|js|json|mp4|png|svg|webp|woff2?|ttf)$/i;

function isLocaleManifest(pathname) {
  return /^\/locales\/[^/]+\.json$/i.test(pathname);
}

function cacheControlForStaticRequest(req) {
  const pathname = String(req.path || '');
  if (!STATIC_EXTENSION_RE.test(pathname)) return null;
  if (/\.html?$/i.test(pathname) || isLocaleManifest(pathname)) {
    return 'no-cache';
  }
  const version = typeof req.query?.v === 'string' ? req.query.v : '';
  if (VERSION_RE.test(version)) return 'public, max-age=31536000, immutable';
  return 'public, max-age=0, must-revalidate';
}

function staticCacheMiddleware(req, res, next) {
  const value = cacheControlForStaticRequest(req);
  if (value) res.setHeader('Cache-Control', value);
  next();
}

function sendHtml(res, filePath, status = 200) {
  res.status(status);
  res.set('Cache-Control', 'no-cache');
  return res.sendFile(filePath);
}

module.exports = { cacheControlForStaticRequest, sendHtml, staticCacheMiddleware };
