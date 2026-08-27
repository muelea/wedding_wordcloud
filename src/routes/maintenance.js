'use strict';

const crypto = require('crypto');
const express = require('express');
const maintenance = require('../maintenance');
const { asyncRoute } = require('../asyncRoute');

function constantTimeSecretMatch(provided) {
  const expected = String(process.env.MAINTENANCE_SECRET || '');
  const left = crypto.createHash('sha256').update(String(provided || '')).digest();
  const right = crypto.createHash('sha256').update(expected).digest();
  return expected.length >= 32 && crypto.timingSafeEqual(left, right);
}

function bearerToken(req) {
  const authorization = String(req.get('authorization') || '');
  return authorization.startsWith('Bearer ') ? authorization.slice(7) : '';
}

function makeMaintenanceRouter() {
  const router = express.Router();
  router.post('/run', express.json({ limit: '1kb' }), asyncRoute(async (req, res) => {
    res.set('Cache-Control', 'no-store');
    if (!constantTimeSecretMatch(bearerToken(req))) {
      return res.status(404).json({ error: 'not_found' });
    }
    const result = await maintenance.run(process.env.NODE_ENV === 'test' ? 'test' : 'http');
    return res.json(result);
  }));
  return router;
}

module.exports = { constantTimeSecretMatch, makeMaintenanceRouter };
