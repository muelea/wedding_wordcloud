'use strict';

require('dotenv').config();

const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');
const compression = require('compression');

const db = require('./src/db');
const { attachSocketHandlers } = require('./src/socket');
const { makeRouter: makeEventsRouter } = require('./src/routes/events');
const { makeWebhookRouter } = require('./src/routes/webhook');
const { getBaseUrl } = require('./src/baseUrl');
const { layoutForExport } = require('./src/exportSvg');

const PORT = process.env.PORT || 3000;

const app = express();
const server = http.createServer(app);
const io = new Server(server);

// Behind a reverse proxy, this makes req.protocol correctly report "https".
app.set('trust proxy', true);

app.use(compression());

// Stripe webhook needs the raw, unparsed body for signature verification —
// must be mounted BEFORE any express.json() body parser touches this path.
app.use('/webhook', makeWebhookRouter({ port: PORT }));

// Serve the pinned Three.js module locally so the configurator's 3D preview
// never depends on a third-party CDN being reachable from a wedding venue.
app.get('/vendor/three.min.js', (req, res) => {
  res.set('Cache-Control', 'public, max-age=31536000, immutable');
  res.sendFile(path.join(__dirname, 'node_modules', 'three', 'build', 'three.min.js'));
});

app.get('/vendor/fabric.min.js', (req, res) => {
  res.set('Cache-Control', 'public, max-age=31536000, immutable');
  res.sendFile(path.join(__dirname, 'node_modules', 'fabric', 'dist', 'index.min.js'));
});

app.use(express.static(path.join(__dirname, 'public'), {
  setHeaders: (res, filePath) => {
    // Vendored/shared libraries never change during an event — let phones
    // cache them for a week instead of re-fetching every load.
    if (filePath.endsWith('.js')) {
      res.setHeader('Cache-Control', 'public, max-age=604800, immutable');
    }
  },
}));

app.use('/api', makeEventsRouter({ io, port: PORT }));

// ── Public pages ─────────────────────────────────────────────────────────
// '/' is the marketing landing page (hero, how-it-works, FAQ, mug-duo
// showcase, live demo) — event creation itself lives at '/start' so the
// landing page's CTAs have a real, working flow to link into rather than
// being a dead-end mockup. See README "Public landing page" for the full
// routing rationale.
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'landing.html'));
});

app.get('/start', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'create.html'));
});

app.get('/e/:slug', (req, res) => {
  const event = db.getEventBySlug(req.params.slug);
  if (!event) return res.status(404).sendFile(path.join(__dirname, 'public', '404.html'));
  res.sendFile(path.join(__dirname, 'public', 'guest.html'));
});

app.get('/e/:slug/display', (req, res) => {
  const event = db.getEventBySlug(req.params.slug);
  if (!event) return res.status(404).sendFile(path.join(__dirname, 'public', '404.html'));
  res.sendFile(path.join(__dirname, 'public', 'display.html'));
});

app.get('/e/:slug/configure', (req, res) => {
  const event = db.getEventBySlug(req.params.slug);
  if (!event) return res.status(404).sendFile(path.join(__dirname, 'public', '404.html'));
  res.sendFile(path.join(__dirname, 'public', 'configure.html'));
});

// Server-side print-file export for the His & Hers mug-duo — the Printful
// order-creation call (src/printful.js) needs a fetchable URL, not inline
// SVG markup, so this is what that URL points at. Generated on demand
// (measured ~10-25ms for a realistic 10-60 word cloud, ~110ms even at 100
// words — see src/exportSvg.js) rather than cached to disk: the word list
// can keep growing right up to checkout, and regenerating per-request means
// there's never a stale file to invalidate.
app.get('/e/:slug/export.svg', (req, res) => {
  const event = db.getEventBySlug(req.params.slug);
  if (!event) return res.status(404).send('event not found');
  const words = db.getWords(event.id);
  if (!words.length) return res.status(404).send('no words submitted yet');
  const svg = layoutForExport(words, event.theme);
  res.set('Content-Type', 'image/svg+xml; charset=utf-8');
  res.send(svg);
});

attachSocketHandlers(io);

if (require.main === module) {
  server.listen(PORT, () => {
    const base = getBaseUrl(null, PORT);
    console.log('\n  ♡  WeddingCloud is running!\n');
    console.log(`  Create an event →  ${base}/`);
    console.log(`  (each event then gets its own /e/<slug> and /e/<slug>/display URLs)\n`);
  });
}

module.exports = { app, server, io };
