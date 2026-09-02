'use strict';

require('dotenv').config();

const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');
const compression = require('compression');

const db = require('./src/db');
const { makeUniqueSlug } = require('./src/slug');
const { sourceHashForRequest } = require('./src/clientIdentity');
const rateLimits = require('./src/rateLimits');
const { attachSocketHandlers } = require('./src/socket');
const { makeRouter: makeEventsRouter } = require('./src/routes/events');
const { makeWebhookRouter } = require('./src/routes/webhook');
const { makeMaintenanceRouter } = require('./src/routes/maintenance');
const { makePerformanceRouter } = require('./src/routes/performance');
const { getBaseUrl } = require('./src/baseUrl');
const { buildEventUrl, renderEventQrSvg } = require('./src/eventQr');
const { MAX_EVENT_NAME_LENGTH, normalizeEventName } = require('./src/eventNames');
const { DEFAULT_PRODUCT, getPublicProduct } = require('./src/products');
const { layoutForExport } = require('./src/exportSvg');
const fulfillment = require('./src/fulfillment');
const emailDelivery = require('./src/emailDelivery');
const printArtifacts = require('./src/printArtifacts');
const { asyncRoute, makeSanitizedErrorHandler } = require('./src/asyncRoute');
const { validateRuntimeConfig } = require('./src/runtimeConfig');
const { staticCacheMiddleware } = require('./src/httpCache');
const { renderPage, resolvePageLocale } = require('./src/pageRenderer');
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
app.use(maintenanceMode.makeMiddleware({ renderPage }));
io.use(maintenanceMode.socketGuard);

// Stripe webhook needs the raw, unparsed body for signature verification —
// must be mounted BEFORE any express.json() body parser touches this path.
app.use('/webhook', makeWebhookRouter({ port: PORT }));
app.use('/internal/maintenance', makeMaintenanceRouter());

// Serve the pinned Three.js module locally so the configurator's 3D preview
// never depends on a third-party CDN being reachable from an event venue.
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
function landingPageOptions(pageData = {}) {
  return {
    header: {
      variant: 'landing',
      headerClass: 'site-header',
      navClass: 'shell nav',
      id: 'site-header',
      navLinks: [
        { href: '#erinnerungsstuecke', label: 'Erinnerungsstücke' },
        { href: '#so-gehts', label: "So geht's" },
        { href: '#inspiration', label: 'Inspiration' },
        { href: '#testimonials', label: 'Testimonials' },
      ],
    },
    pageData,
  };
}

app.get('/', asyncRoute(async (req, res) => {
  return renderPage(req, res, 'landing', landingPageOptions());
}));

app.post('/start', express.urlencoded({ extended: false, limit: '2kb' }), asyncRoute(async (req, res) => {
  const submittedName = typeof req.body?.cloudName === 'string' ? req.body.cloudName : '';
  const pin = typeof req.body?.organizerPin === 'string' ? req.body.organizerPin.trim() : '';
  const pinConfirmation = typeof req.body?.organizerPinConfirmation === 'string'
    ? req.body.organizerPinConfirmation.trim()
    : '';
  const title = normalizeEventName(submittedName);
  let error = '';
  if (!title || title.length > MAX_EVENT_NAME_LENGTH) {
    error = !title
      ? 'Bitte gebt eurer Wortwolke einen Namen.'
      : 'Der Name darf höchstens 80 Zeichen lang sein.';
  } else if (!/^\d{4,6}$/.test(pin)) {
    error = 'Bitte wählt eine Organisator-PIN mit 4–6 Ziffern.';
  } else if (pin !== pinConfirmation) {
    error = 'Die beiden PINs stimmen nicht überein.';
  }
  if (error) {
    return renderPage(req, res, 'landing', {
      ...landingPageOptions({
        startDialog: { open: true, name: submittedName.slice(0, MAX_EVENT_NAME_LENGTH), error },
      }),
      status: 400,
    });
  }
  const sourceHash = sourceHashForRequest(req);
  if (!rateLimits.consume([{
    name: 'event:create', key: sourceHash, ...rateLimits.LIMITS.eventCreate,
  }])) {
    return renderPage(req, res, 'landing', {
      ...landingPageOptions({
        startDialog: {
          open: true,
          name: submittedName.slice(0, MAX_EVENT_NAME_LENGTH),
          error: 'Bitte versucht es in einem Moment erneut.',
        },
      }),
      status: 429,
    });
  }

  const locale = resolvePageLocale(req).locale;
  let event = null;
  for (let attempt = 0; attempt < 20 && !event; attempt += 1) {
    try {
      event = await db.createEvent({
        slug: makeUniqueSlug('wortwolke', () => false), title, pin, locale,
      });
    } catch (error) {
      if (error?.code !== '23505') throw error;
    }
  }
  if (!event) {
    return renderPage(req, res, 'landing', {
      ...landingPageOptions({
        startDialog: {
          open: true,
          name: submittedName.slice(0, MAX_EVENT_NAME_LENGTH),
          error: 'Die Wortwolke konnte nicht erstellt werden.',
        },
      }),
      status: 500,
    });
  }
  return res.redirect(303, `/e/${encodeURIComponent(event.slug)}`);
}));

app.get('/impressum', asyncRoute(async (req, res) => {
  return renderPage(req, res, 'impressum', {
    header: { variant: 'back', headerClass: 'site-header', navClass: 'header-inner' },
  });
}));

app.get('/datenschutz', asyncRoute(async (req, res) => {
  return renderPage(req, res, 'datenschutz', {
    header: { variant: 'back', headerClass: 'site-header', navClass: 'header-inner' },
  });
}));

app.get('/e/:slug', asyncRoute(async (req, res) => {
  const event = await db.getEventBySlug(req.params.slug);
  if (!event) return renderPage(req, res, '404', { status: 404 });
  const eventUrl = buildEventUrl(getBaseUrl(req, PORT), event.slug);
  const [qrSvg, initialWords] = await Promise.all([
    renderEventQrSvg(eventUrl),
    db.getWords(event.id),
  ]);
  const paletteOptions = getPublicProduct(DEFAULT_PRODUCT).themes
    .filter((palette) => palette.key !== 'custom');
  return renderPage(req, res, 'display', {
    eventLocale: event.locale,
    header: { variant: 'display', paletteOptions, hasWords: initialWords.length > 0 },
    pageData: {
      eventUrl,
      qrSvg,
      cloudTitle: event.title,
      initialWords,
      paletteOptions,
    },
  });
}));

app.get('/e/:slug/configure', asyncRoute(async (req, res) => {
  const event = await db.getEventBySlug(req.params.slug);
  if (!event) return renderPage(req, res, '404', { status: 404 });
  return renderPage(req, res, 'configure', {
    eventLocale: event.locale,
    header: {
      variant: 'back', headerClass: 'topbar', brandId: 'brand-link', backId: 'back-link',
      backHref: '#', backLabel: 'Zurück zur Wortwolke', backAria: 'Zurück zur Wortwolke',
    },
  });
}));

app.get('/e/:slug/shipping', asyncRoute(async (req, res) => {
  const event = await db.getEventBySlug(req.params.slug);
  if (!event) return renderPage(req, res, '404', { status: 404 });
  return renderPage(req, res, 'shipping', {
    eventLocale: event.locale,
    header: {
      variant: 'back', headerClass: 'topbar', backId: 'back-link', backHref: '#',
      backLabel: 'Zurück zum Design', backAria: 'Zurück zum Design',
    },
  });
}));

app.get('/e/:slug/order-confirmation', asyncRoute(async (req, res) => {
  const event = await db.getEventBySlug(req.params.slug);
  if (!event) return renderPage(req, res, '404', { status: 404 });
  return renderPage(req, res, 'order-confirmation', {
    eventLocale: event.locale,
    cacheControl: 'no-store',
    header: { headerClass: 'topbar' },
  });
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
  const svg = layoutForExport(words, 'pastel');
  res.set('Content-Type', 'image/svg+xml; charset=utf-8');
  res.set('Cache-Control', 'no-store');
  res.send(svg);
}));

const socketRuntime = attachSocketHandlers(io, { wordBroadcasts });

// Unknown browser routes use the same localized, branded page as expired
// events. API, provider and asset requests retain their machine-readable 404s.
app.get('*', asyncRoute(async (req, res, next) => {
  if (req.path.startsWith('/api/') || req.path.startsWith('/webhook/') ||
      req.path.startsWith('/internal/') || path.extname(req.path)) {
    return next();
  }
  return renderPage(req, res, '404', { status: 404 });
}));

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
app.use(makeSanitizedErrorHandler({ renderPage }));

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
      console.log(`  (each event then gets its own /e/<slug> URL)\n`);
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
