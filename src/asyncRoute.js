'use strict';

const log = require('./structuredLog');

function asyncRoute(handler) {
  return function asyncExpressBoundary(req, res, next) {
    Promise.resolve(handler(req, res, next)).catch(next);
  };
}

function makeSanitizedErrorHandler({ renderPage } = {}) {
  return function sanitizedErrorHandler(error, req, res, next) {
    if (res.headersSent) return next(error);
    if (error?.type === 'entity.too.large') {
      return res.status(413).json({ error: 'payload_too_large' });
    }
    if (error instanceof SyntaxError && error?.status === 400 && Object.hasOwn(error, 'body')) {
      return res.status(400).json({ error: 'invalid_json' });
    }
    log.error('http_request_failed', {
      operation: 'express_route',
      errorCode: log.errorCode(error, 'internal_server_error'),
      statusCode: 500,
    });
    const browserPage = req.method === 'GET' && req.accepts?.('html') &&
      !req.path.startsWith('/api/') && !req.path.startsWith('/webhook/') &&
      !req.path.startsWith('/internal/');
    if (browserPage && renderPage) {
      return Promise.resolve(renderPage(req, res, '404', {
        status: 500,
        cacheControl: 'no-store',
        pageData: { statusKind: 'error' },
      })).catch((renderError) => {
        log.error('http_error_page_failed', {
          operation: 'render_error_page',
          errorCode: log.errorCode(renderError, 'error_page_failed'),
          statusCode: 500,
        });
        if (!res.headersSent) res.status(500).json({ error: 'internal_server_error' });
      });
    }
    return res.status(500).json({ error: 'internal_server_error' });
  };
}

const sanitizedErrorHandler = makeSanitizedErrorHandler();

module.exports = { asyncRoute, makeSanitizedErrorHandler, sanitizedErrorHandler };
