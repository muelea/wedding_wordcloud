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
const fulfillment = require('./src/fulfillment');
const { asyncRoute, sanitizedErrorHandler } = require('./src/asyncRoute');
const { validateRuntimeConfig } = require('./src/runtimeConfig');

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
// '/' is the marketing landing page (hero, how-it-works, FAQ, mug preview
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

app.get('/impressum', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'impressum.html'));
});

app.get('/datenschutz', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'datenschutz.html'));
});

app.get('/e/:slug', asyncRoute(async (req, res) => {
  const event = await db.getEventBySlug(req.params.slug);
  if (!event) return res.status(404).sendFile(path.join(__dirname, 'public', '404.html'));
  res.sendFile(path.join(__dirname, 'public', 'guest.html'));
}));

app.get('/e/:slug/display', asyncRoute(async (req, res) => {
  const event = await db.getEventBySlug(req.params.slug);
  if (!event) return res.status(404).sendFile(path.join(__dirname, 'public', '404.html'));
  res.sendFile(path.join(__dirname, 'public', 'display.html'));
}));

app.get('/e/:slug/configure', asyncRoute(async (req, res) => {
  const event = await db.getEventBySlug(req.params.slug);
  if (!event) return res.status(404).sendFile(path.join(__dirname, 'public', '404.html'));
  res.sendFile(path.join(__dirname, 'public', 'configure.html'));
}));

app.get('/e/:slug/shipping', asyncRoute(async (req, res) => {
  const event = await db.getEventBySlug(req.params.slug);
  if (!event) return res.status(404).sendFile(path.join(__dirname, 'public', '404.html'));
  res.sendFile(path.join(__dirname, 'public', 'shipping.html'));
}));

app.get('/e/:slug/order-confirmation', asyncRoute(async (req, res) => {
  const event = await db.getEventBySlug(req.params.slug);
  if (!event) return res.status(404).sendFile(path.join(__dirname, 'public', '404.html'));
  res.set('Cache-Control', 'no-store');
  res.sendFile(path.join(__dirname, 'public', 'order-confirmation.html'));
}));

// Legacy live-event SVG export used by the display/download flow. Paid mug
// orders use the immutable configuration-specific route under /api instead,
// so later guest submissions can never change an approved print file.
// Generated on demand
// (measured ~10-25ms for a realistic 10-60 word cloud, ~110ms even at 100
// words — see src/exportSvg.js) rather than cached to disk: the word list
// can keep growing right up to checkout, and regenerating per-request means
// there's never a stale file to invalidate.
app.get('/e/:slug/export.svg', asyncRoute(async (req, res) => {
  const event = await db.getEventBySlug(req.params.slug);
  if (!event) return res.status(404).send('event not found');
  const words = await db.getWords(event.id);
  if (!words.length) return res.status(404).send('no words submitted yet');
  const svg = layoutForExport(words, event.theme);
  res.set('Content-Type', 'image/svg+xml; charset=utf-8');
  res.send(svg);
}));

attachSocketHandlers(io);

// Resume paid orders that were safely persisted before a restart. Claiming
// in the database prevents duplicate processing when a Stripe retry arrives
// at the same time.
server.on('listening', async () => {
  if (process.env.NODE_ENV === 'test') return;
  try {
    const resumed = await fulfillment.resumePendingOrders();
    if (resumed) console.log(`[fulfillment] ${resumed} wartende Bestellung(en) wieder aufgenommen.`);
  } catch (error) {
    console.error('[fulfillment] pending-order recovery failed:', error.message);
  }
});

// Rejected async route promises end here. SQL text, credentials and driver
// errors are logged server-side and never sent to a browser.
app.use(sanitizedErrorHandler);

let initialization = null;
function initialize() {
  if (!initialization) {
    validateRuntimeConfig();
    initialization = db.assertDatabaseReady();
  }
  return initialization;
}

async function start() {
  await initialize();
  server.listen(PORT, () => {
    const base = getBaseUrl(null, PORT);
    console.log('\n  ♡  WeddingCloud is running!\n');
    console.log(`  Create an event →  ${base}/`);
    console.log(`  (each event then gets its own /e/<slug> and /e/<slug>/display URLs)\n`);
  });
}

async function shutdown(signal) {
  console.log(`[server] ${signal} received; closing HTTP and Postgres cleanly.`);
  await new Promise((resolve) => server.close(() => resolve()));
  await db.closePool();
}

if (require.main === module) {
  start().catch((error) => {
    console.error('[startup] Wolkenworte could not start:', error.message);
    process.exitCode = 1;
  });
  for (const signal of ['SIGTERM', 'SIGINT']) {
    process.once(signal, () => {
      shutdown(signal).catch((error) => {
        console.error('[shutdown] clean shutdown failed:', error.message);
        process.exitCode = 1;
      });
    });
  }
}

module.exports = { app, server, io, initialize, start, shutdown };
