'use strict';

const express = require('express');
const db = require('../db');
const performanceProbe = require('../performanceProbe');
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
  return router;
}

module.exports = { makePerformanceRouter };
