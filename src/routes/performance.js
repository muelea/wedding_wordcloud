'use strict';

const express = require('express');
const db = require('../db');
const performanceProbe = require('../performanceProbe');
const { asyncRoute } = require('../asyncRoute');
const { cleanupTargetFingerprint } = require('../cleanupTarget');
const { bearerToken, constantTimeSecretMatch } = require('./maintenance');

function makePerformanceRouter() {
  const router = express.Router();
  router.get('/snapshot', (req, res) => {
    res.set('Cache-Control', 'no-store');
    if (!constantTimeSecretMatch(bearerToken(req))) {
      return res.status(404).json({ error: 'not_found' });
    }
    return res.json(performanceProbe.snapshot(db.getPool()));
  });
  router.get('/operations', asyncRoute(async (req, res) => {
    res.set('Cache-Control', 'no-store');
    if (!constantTimeSecretMatch(bearerToken(req))) {
      return res.status(404).json({ error: 'not_found' });
    }
    return res.json(await db.getOperationalStatus());
  }));
  router.get('/cleanup-target', (req, res) => {
    res.set('Cache-Control', 'no-store');
    if (!constantTimeSecretMatch(bearerToken(req))) {
      return res.status(404).json({ error: 'not_found' });
    }
    return res.json({ fingerprint: cleanupTargetFingerprint() });
  });
  return router;
}

module.exports = { makePerformanceRouter };
