'use strict';

function asyncRoute(handler) {
  return function asyncExpressBoundary(req, res, next) {
    Promise.resolve(handler(req, res, next)).catch(next);
  };
}

function sanitizedErrorHandler(error, req, res, next) {
  if (res.headersSent) return next(error);
  console.error(`[http] ${req.method} ${req.path}:`, error?.message || error);
  return res.status(500).json({ error: 'internal_server_error' });
}

module.exports = { asyncRoute, sanitizedErrorHandler };
