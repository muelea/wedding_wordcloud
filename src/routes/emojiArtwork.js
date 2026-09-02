'use strict';

const express = require('express');
const { asyncRoute } = require('../asyncRoute');
const { loadBrowserSvg } = require('../emojiBrowserAssets');

function makeEmojiArtworkRouter() {
  const router = express.Router();
  // Errors and unknown references must never become immutable cached assets.
  router.use((req, res, next) => {
    res.set('Cache-Control', 'no-store');
    next();
  });
  router.get('/:family/:filename', asyncRoute(async (req, res) => {
    const svg = await loadBrowserSvg(`${req.params.family}/${req.params.filename}`);
    if (svg === null) return res.sendStatus(404);
    res.set('Cache-Control', 'public, max-age=31536000, immutable');
    res.set('X-Content-Type-Options', 'nosniff');
    return res.type('image/svg+xml').send(svg);
  }));
  router.use((req, res) => res.sendStatus(404));
  return router;
}

module.exports = { makeEmojiArtworkRouter };
