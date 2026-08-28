'use strict';

function isEnabled() {
  return String(process.env.MAINTENANCE_MODE || 'false').trim().toLowerCase() === 'true';
}

function middleware(req, res, next) {
  if (!isEnabled()) return next();
  res.set('Cache-Control', 'no-store');
  res.set('X-Wolkenworte-Maintenance', 'active');
  if (req.path.startsWith('/api/') || req.path === '/api' ||
      req.path.startsWith('/webhook/') || req.path === '/webhook') {
    return res.status(503).json({ error: 'maintenance' });
  }
  return res.status(503).type('text/plain; charset=utf-8')
    .send('Wolkenworte ist wegen Wartungsarbeiten vorübergehend nicht verfügbar.');
}

function socketGuard(socket, next) {
  if (!isEnabled()) return next();
  const error = new Error('maintenance');
  error.data = { error: 'maintenance' };
  return next(error);
}

module.exports = { isEnabled, middleware, socketGuard };
