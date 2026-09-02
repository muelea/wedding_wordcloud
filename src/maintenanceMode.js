'use strict';

function isEnabled() {
  return String(process.env.MAINTENANCE_MODE || 'false').trim().toLowerCase() === 'true';
}

const ROOT_PUBLIC_ASSET = /^\/[^/]+\.(?:css|js|json|svg|png|jpe?g|webp|avif|gif|ico|woff2?|ttf|mp4|webm)$/i;
const PUBLIC_ASSET_PREFIXES = Object.freeze(['/assets/', '/js/', '/z_icons/', '/locales/']);

function isPublicAssetPath(requestPath) {
  return ROOT_PUBLIC_ASSET.test(requestPath) ||
    PUBLIC_ASSET_PREFIXES.some((prefix) => requestPath.startsWith(prefix));
}

function makeMiddleware({ renderPage } = {}) {
  return function maintenanceMiddleware(req, res, next) {
    if (!isEnabled()) return next();
    res.set('Cache-Control', 'no-store');
    res.set('X-Wolkenworte-Maintenance', 'active');
    if (req.path.startsWith('/api/') || req.path === '/api' ||
        req.path.startsWith('/webhook/') || req.path === '/webhook') {
      return res.status(503).json({ error: 'maintenance' });
    }
    // The branded maintenance document needs its local fonts, styles and
    // language catalog. Fingerprinted static assets remain safe and read-only.
    if (req.method === 'GET' && isPublicAssetPath(req.path)) return next();
    if (req.method === 'GET' && renderPage) {
      return Promise.resolve(renderPage(req, res, '404', {
        status: 503,
        cacheControl: 'no-store',
        pageData: { statusKind: 'maintenance' },
      })).catch(next);
    }
    return res.status(503).type('text/plain; charset=utf-8')
      .send('Wolkenworte ist wegen Wartungsarbeiten vorübergehend nicht verfügbar.');
  };
}

const middleware = makeMiddleware();

function socketGuard(socket, next) {
  if (!isEnabled()) return next();
  const error = new Error('maintenance');
  error.data = { error: 'maintenance' };
  return next(error);
}

module.exports = { isEnabled, makeMiddleware, middleware, socketGuard };
