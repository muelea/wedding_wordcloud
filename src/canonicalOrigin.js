'use strict';

function configuredOrigin() {
  try {
    const url = new URL(process.env.PUBLIC_URL || '');
    if (url.protocol !== 'https:' || url.pathname !== '/' || url.search || url.hash) return null;
    return url;
  } catch {
    return null;
  }
}

function redirectWwwAlias(req, res, next) {
  const canonical = configuredOrigin();
  if (!canonical || canonical.hostname.startsWith('www.')) return next();

  const requestedHost = String(req.hostname || '').toLowerCase().replace(/\.$/, '');
  if (requestedHost !== `www.${canonical.hostname.toLowerCase()}`) return next();

  const requestTarget = String(req.originalUrl || '/');
  const safeTarget = requestTarget.startsWith('/') ? requestTarget : `/${requestTarget}`;
  return res.redirect(308, `${canonical.origin}${safeTarget}`);
}

module.exports = { configuredOrigin, redirectWwwAlias };
