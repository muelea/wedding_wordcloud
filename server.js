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
const { makeMaintenanceRouter } = require('./src/routes/maintenance');
const { makePerformanceRouter } = require('./src/routes/performance');
const { getBaseUrl } = require('./src/baseUrl');
const { layoutForExport } = require('./src/exportSvg');
const fulfillment = require('./src/fulfillment');
const emailDelivery = require('./src/emailDelivery');
const printArtifacts = require('./src/printArtifacts');
const { asyncRoute, sanitizedErrorHandler } = require('./src/asyncRoute');
const { validateRuntimeConfig } = require('./src/runtimeConfig');
const { sendHtml, staticCacheMiddleware } = require('./src/httpCache');
const performanceProbe = require('./src/performanceProbe');
const { createWordUpdateBroadcaster } = require('./src/wordBroadcasts');
const log = require('./src/structuredLog');
const maintenanceMode = require('./src/maintenanceMode');
const { markInfrastructureHostNoIndex, redirectWwwAlias } = require('./src/canonicalOrigin');

const PORT = process.env.PORT || 3000;

const app = express();
const server = http.createServer(app);
const io = new Server(server);
io.engine.on('headers', (headers) => {
  // Socket.io transport responses are session-specific, including the
  // unversioned client bundle path served by Engine.IO.
  headers['Cache-Control'] = 'no-store';
});

// Trust only the immediate private/local reverse-proxy hop. Source abuse
// identity is resolved separately and never accepts arbitrary X-Forwarded-For.
app.set('trust proxy', ['loopback', 'linklocal', 'uniquelocal']);

app.use(compression());
app.use(log.requestContext);
// Keep the permanent Fly hostname usable for provider callbacks and guarded
// operations without letting it compete with wolkenworte.io in search results.
app.use(markInfrastructureHostNoIndex);

let initialized = false;
let acceptingTraffic = false;
let shuttingDown = false;

app.get('/health/live', (req, res) => {
  res.set('Cache-Control', 'no-store');
  res.json({ status: 'ok' });
});

app.get('/health/ready', async (req, res) => {
  res.set('Cache-Control', 'no-store');
  if (!initialized || !acceptingTraffic || shuttingDown) {
    return res.status(503).json({ status: 'not_ready' });
  }
  try {
    await db.checkDatabaseReady(1_500);
    return res.json({ status: 'ok' });
  } catch {
    return res.status(503).json({ status: 'not_ready' });
  }
});

// Keep one public origin for browser traffic. The Fly hostname remains a
// stable infrastructure endpoint for existing provider callbacks and guarded
// operator tooling; only the public www alias redirects to the canonical apex.
app.use(redirectWwwAlias);

// Secret-bound operator status/fingerprint remains available while public
// traffic is paused, so a destructive cleanup can verify its exact target.
app.use('/internal/performance', makePerformanceRouter());

// The one-time pre-live cleanup requires a verifiable stop-the-world window.
// Liveness/readiness remain reachable, while every public HTTP and Socket.io
// operation is rejected before it can write business data.
app.use(maintenanceMode.middleware);
io.use(maintenanceMode.socketGuard);

// Stripe webhook needs the raw, unparsed body for signature verification —
// must be mounted BEFORE any express.json() body parser touches this path.
app.use('/webhook', makeWebhookRouter({ port: PORT }));
app.use('/internal/maintenance', makeMaintenanceRouter());

// Serve the pinned Three.js module locally so the configurator's 3D preview
// never depends on a third-party CDN being reachable from a wedding venue.
app.get('/vendor/three.min.js', staticCacheMiddleware, (req, res) => {
  res.sendFile(path.join(__dirname, 'node_modules', 'three', 'build', 'three.min.js'));
});

app.get('/vendor/fabric.min.js', staticCacheMiddleware, (req, res) => {
  res.sendFile(path.join(__dirname, 'node_modules', 'fabric', 'dist', 'index.min.js'));
});

app.get('/vendor/fonts/gelasio-latin-ext-400-normal.woff', staticCacheMiddleware, (req, res) => {
  res.type('font/woff');
  res.sendFile(require.resolve('@fontsource/gelasio/files/gelasio-latin-ext-400-normal.woff'));
});

app.use(staticCacheMiddleware, express.static(path.join(__dirname, 'public')));

const wordBroadcasts = createWordUpdateBroadcaster({ io, getWords: db.getWords });
app.use('/api', makeEventsRouter({ io, port: PORT, wordBroadcasts }));

app.get('/api/print-files/:artifactId/:nonce', asyncRoute(async (req, res) => {
  res.set('Cache-Control', 'private, no-store');
  const artifactId = String(req.params.artifactId || '');
  const nonce = String(req.params.nonce || '');
  if (!/^[A-Za-z0-9_-]{24}$/.test(artifactId) || !/^[A-Za-z0-9_-]{32}$/.test(nonce)) {
    return res.status(404).send('print file not found');
  }
  let stored;
  try {
    stored = await printArtifacts.loadActiveArtifactBytes(artifactId, nonce);
  } catch {
    return res.status(503).send('print file temporarily unavailable');
  }
  if (!stored) return res.status(404).send('print file not found');
  res.set('Content-Type', stored.artifact.mime_type);
  return res.send(stored.bytes);
}));

// ── Public pages ─────────────────────────────────────────────────────────
// '/' is the marketing landing page (hero, how-it-works, FAQ, mug preview
// showcase, live demo) — event creation itself lives at '/start' so the
// landing page's CTAs have a real, working flow to link into rather than
// being a dead-end mockup. See README "Public landing page" for the full
// routing rationale.
app.get('/', (req, res) => {
  sendHtml(res, path.join(__dirname, 'public', 'landing.html'));
});

app.get('/start', (req, res) => {
  sendHtml(res, path.join(__dirname, 'public', 'create.html'));
});

app.get('/impressum', (req, res) => {
  sendHtml(res, path.join(__dirname, 'public', 'impressum.html'));
});

app.get('/datenschutz', (req, res) => {
  sendHtml(res, path.join(__dirname, 'public', 'datenschutz.html'));
});

app.get('/e/:slug', asyncRoute(async (req, res) => {
  const event = await db.getEventBySlug(req.params.slug);
  if (!event) return sendHtml(res, path.join(__dirname, 'public', '404.html'), 404);
  sendHtml(res, path.join(__dirname, 'public', 'guest.html'));
}));

app.get('/e/:slug/display', asyncRoute(async (req, res) => {
  const event = await db.getEventBySlug(req.params.slug);
  if (!event) return sendHtml(res, path.join(__dirname, 'public', '404.html'), 404);
  sendHtml(res, path.join(__dirname, 'public', 'display.html'));
}));

app.get('/e/:slug/configure', asyncRoute(async (req, res) => {
  const event = await db.getEventBySlug(req.params.slug);
  if (!event) return sendHtml(res, path.join(__dirname, 'public', '404.html'), 404);
  sendHtml(res, path.join(__dirname, 'public', 'configure.html'));
}));

app.get('/e/:slug/shipping', asyncRoute(async (req, res) => {
  const event = await db.getEventBySlug(req.params.slug);
  if (!event) return sendHtml(res, path.join(__dirname, 'public', '404.html'), 404);
  sendHtml(res, path.join(__dirname, 'public', 'shipping.html'));
}));

app.get('/e/:slug/order-confirmation', asyncRoute(async (req, res) => {
  const event = await db.getEventBySlug(req.params.slug);
  if (!event) return sendHtml(res, path.join(__dirname, 'public', '404.html'), 404);
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
  res.set('Cache-Control', 'no-store');
  res.send(svg);
}));

const socketRuntime = attachSocketHandlers(io, { wordBroadcasts });

// Resume paid orders that were safely persisted before a restart. Claiming
// in the database prevents duplicate processing when a Stripe retry arrives
// at the same time.
server.on('listening', () => {
  acceptingTraffic = true;
  if (process.env.NODE_ENV === 'test') return;
  fulfillment.start();
  emailDelivery.start();
});

server.on('close', () => {
  acceptingTraffic = false;
  socketRuntime.stop();
  wordBroadcasts.stop();
  performanceProbe.stop();
});

// Rejected async route promises end here. SQL text, credentials and driver
// errors are logged server-side and never sent to a browser.
app.use(sanitizedErrorHandler);

let initialization = null;
async function initialize() {
  if (!initialization) {
    validateRuntimeConfig();
    initialization = db.assertDatabaseReady().then(() => {
      initialized = true;
      performanceProbe.start();
      return true;
    });
  }
  return initialization;
}

async function start() {
  await initialize();
  server.listen(PORT, () => {
    const base = getBaseUrl(null, PORT);
    if (process.env.NODE_ENV === 'production') {
      log.info('server_started', { outcome: 'ready' });
    } else {
      console.log('\n  ♡  Wolkenworte is running!\n');
      console.log(`  Create an event →  ${base}/`);
      console.log(`  (each event then gets its own /e/<slug> and /e/<slug>/display URLs)\n`);
    }
  });
}

let shutdownPromise = null;
function closeSocketTransports() {
  for (const client of Object.values(io.engine.clients || {})) {
    const transport = client.transport;
    client.close(true);
    // Engine.IO's WebSocket transport uses ws.close(), which waits for a
    // closing handshake. Thousands of remote clients can keep those upgraded
    // TCP sockets attached to Node (and counted by Fly Proxy) for seconds.
    // The Machine is being replaced and socket state is disposable, so end
    // the underlying transport immediately; clients still observe a transport
    // loss and retain normal automatic reconnection semantics.
    transport?.socket?.terminate?.();
  }
}

function closeHttpAndSockets(timeoutMs = 10_000) {
  // Socket sessions contain no authoritative state. Disconnect immediately so
  // clients begin reconnecting while Fly replaces the Machine instead of
  // holding the restart at the full transport-drain timeout. Close the
  // Engine.IO transports—not the Socket.IO namespaces—because a server-side
  // namespace disconnect deliberately disables client auto-reconnection.
  closeSocketTransports();
  // io.close() also closes its attached HTTP server. Calling server.close()
  // concurrently creates two drain waiters for the same listener and kept a
  // loaded Fly Machine alive until this fallback timer elapsed.
  const cleanClose = new Promise((resolve) => io.close(() => resolve(true)));
  return Promise.race([
    cleanClose,
    new Promise((resolve) => {
      const timer = setTimeout(() => {
        io.disconnectSockets(true);
        server.closeAllConnections?.();
        resolve(false);
      }, timeoutMs);
      timer.unref();
      cleanClose.finally(() => clearTimeout(timer));
    }),
  ]);
}

function shutdown(signal = 'shutdown') {
  if (shutdownPromise) return shutdownPromise;
  shuttingDown = true;
  acceptingTraffic = false;
  log.info('server_shutdown_started', { signal });
  shutdownPromise = (async () => {
    const [transportClosed, fulfillmentWorker, emailWorker] = await Promise.all([
      closeHttpAndSockets(),
      fulfillment.stop({ timeoutMs: 15_000 }),
      emailDelivery.stop({ timeoutMs: 15_000 }),
    ]);
    wordBroadcasts.stop();
    socketRuntime.stop();
    performanceProbe.stop();
    if (!transportClosed) log.warn('server_transport_drain_timeout', { durationMs: 10_000 });
    if (!fulfillmentWorker.drained) {
      log.warn('server_fulfillment_drain_incomplete', { count: fulfillmentWorker.activeOrders });
    }
    if (!emailWorker.drained) {
      log.warn('server_email_drain_incomplete', { count: emailWorker.activeJobs });
    }
    await db.closePool();
    log.info('server_shutdown_completed', { outcome: 'succeeded' });
  })();
  return shutdownPromise;
}

if (require.main === module) {
  start().catch(async (error) => {
    log.error('server_startup_failed', { errorCode: log.errorCode(error, 'startup_failed') });
    process.exitCode = 1;
    await db.closePool().catch(() => {});
  });
  for (const signal of ['SIGTERM', 'SIGINT']) {
    process.once(signal, () => {
      const forceExit = setTimeout(() => {
        log.error('server_shutdown_forced', { durationMs: 28_000 });
        process.exit(1);
      }, 28_000);
      forceExit.unref();
      shutdown(signal)
        .catch((error) => {
          log.error('server_shutdown_failed', { errorCode: log.errorCode(error, 'shutdown_failed') });
          process.exitCode = 1;
        })
        .finally(() => clearTimeout(forceExit));
    });
  }
}

module.exports = { app, server, io, initialize, start, shutdown, closeSocketTransports };
