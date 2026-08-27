'use strict';

function asyncRoute(handler) {
  return function asyncExpressBoundary(req, res, next) {
    Promise.resolve(handler(req, res, next)).catch(next);
  };
}

function sanitizedErrorHandler(error, req, res, next) {
  if (res.headersSent) return next(error);
  if (error?.type === 'entity.too.large') {
    return res.status(413).json({ error: 'payload_too_large' });
  }
  if (error instanceof SyntaxError && error?.status === 400 && Object.hasOwn(error, 'body')) {
    return res.status(400).json({ error: 'invalid_json' });
  }
  console.error(`[http] ${req.method} ${req.path}:`, error?.message || error);
  return res.status(500).json({ error: 'internal_server_error' });
}

module.exports = { asyncRoute, sanitizedErrorHandler };
