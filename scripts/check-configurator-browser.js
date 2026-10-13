'use strict';

// Render the real configurator with an in-memory API fixture. No .env,
// database, provider calls or writable configuration endpoints are loaded.
const path = require('node:path');
const express = require('express');
const { renderPage } = require('../src/pageRenderer');
const { DEFAULT_PRODUCT, getPublicProduct, getPublicProducts, getPublicProductFamilies } = require('../src/products');
const { ASSET_BASE } = require('../public/js/emoji-catalog');
const { makeEmojiArtworkRouter } = require('../src/routes/emojiArtwork');
const FIXTURE_SLUG = '-_AbCdEf0123456789xyZQ';

function createFixture({ words = [['test', 1]], directDesign = false } = {}) {
  const app = express();
  const root = path.join(__dirname, '..');
  const configurations = new Map();
  app.use(express.json({ limit: '2mb' }));
  app.use((req, res, next) => { res.set('Cache-Control', 'no-store'); next(); });
  if (directDesign) {
    app.get('/', (req, res, next) => renderPage(req, res, 'landing', {
      header: { variant: 'landing', headerClass: 'site-header', navClass: 'shell nav', id: 'site-header',
        navLinks: [{ href: '#erinnerungsstuecke', label: 'Erinnerungsstücke' },
          { href: '#so-gehts', label: "So geht's" }, { href: '#inspiration', label: 'Inspiration' },
          { href: '#testimonials', label: 'Testimonials' }] },
    }).catch(next));
    app.post('/design/start', (req, res) => res.redirect(303, `/e/${FIXTURE_SLUG}/configure?lang=de`));
  }
  app.get(`/e/${FIXTURE_SLUG}`, (req, res) => res.type('html').send(`<!doctype html>
    <html lang="en"><head><meta charset="utf-8"><title>Responsive test word cloud</title></head>
    <body><a id="fixture-configure-link" href="/e/${FIXTURE_SLUG}/configure?lang=en">Keepsake</a></body></html>`));
  app.get(`/e/${FIXTURE_SLUG}/configure`, (req, res, next) => {
    if (['1', 'area', 'touch'].includes(req.query.probe)) {
      const send = res.send.bind(res);
      const probe = req.query.probe === 'area' ? 'area-layout' : req.query.probe === 'touch' ? 'mobile-canvas' : 'responsive';
      res.send = html => {
        // A narrow desktop window is intentionally still a desktop. The touch
        // fixture supplies mobile device signals before any application scripts.
        if (probe === 'mobile-canvas') html = html.replace('<head>', `<head><script>
          Object.defineProperties(navigator, {
            userAgent: { configurable: true, value: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 Version/18.0 Mobile/15E148 Safari/604.1' },
            platform: { configurable: true, value: 'iPhone' },
            maxTouchPoints: { configurable: true, value: 5 }
          });
        </script>`);
        return send(html.replace('</body>', `<script src="/${probe}-probe.js"></script></body>`));
      };
    }
    renderPage(req, res, 'configure', {
      eventLocale: 'en',
      header: { variant: 'back', headerClass: 'topbar', brandId: 'brand-link', backId: 'back-link',
        backHref: directDesign ? '/' : `/e/${FIXTURE_SLUG}`,
        backLabel: directDesign ? 'Zur Startseite' : 'Zurück zur Wortwolke',
        mobileMenu: true, mobileBackId: 'mobile-back-link', cartButton: true },
      pageData: { directDesign },
    }).catch(next);
  });
  app.get(`/api/events/${FIXTURE_SLUG}/configurator`, (req, res) => res.json({
    event: { slug: FIXTURE_SLUG, title: 'Responsive test', locale: 'en', directDesign },
    words,
    product: getPublicProduct(DEFAULT_PRODUCT),
    products: getPublicProducts(),
    productFamilies: getPublicProductFamilies(),
  }));
  app.get(`/api/events/${FIXTURE_SLUG}`, (req, res) => res.json({
    slug: FIXTURE_SLUG, title: 'Responsive test', locale: 'en', directDesign,
  }));
  app.post(`/api/events/${FIXTURE_SLUG}/configurations`, (req, res) => {
    const configuration = { ...req.body,
      id: `FixtureCart${String(configurations.size + 1).padStart(5, '0')}`,
      productKey: req.body?.productKey || DEFAULT_PRODUCT,
      orientation: req.body?.orientation || 'default',
      printFileUrl: '', createdAt: new Date(0).toISOString() };
    configurations.set(configuration.id, structuredClone(configuration));
    res.status(201).json(configuration);
  });
  app.get(`/api/events/${FIXTURE_SLUG}/configurations/:id/edit`, (req, res) => {
    const configuration = configurations.get(req.params.id);
    if (!configuration) return res.status(404).json({ error: 'not_found' });
    res.json(configuration);
  });
  app.get('/responsive-probe.js', (req, res) => res.sendFile(path.join(root, 'test/browser/configurator-workspace-probe.js')));
  app.get('/area-layout-probe.js', (req, res) => res.sendFile(path.join(root, 'test/browser/area-layout-probe.js')));
  app.get('/mobile-canvas-probe.js', (req, res) => res.sendFile(path.join(root, 'test/browser/mobile-canvas-probe.js')));
  app.use(ASSET_BASE, makeEmojiArtworkRouter());
  app.get('/vendor/three.min.js', (req, res) => res.sendFile(path.join(root, 'node_modules/three/build/three.min.js')));
  app.get('/vendor/fabric.min.js', (req, res) => res.sendFile(path.join(root, 'node_modules/fabric/dist/index.min.js')));
  app.get('/vendor/fonts/gelasio-latin-ext-400-normal.woff', (req, res) =>
    res.sendFile(require.resolve('@fontsource/gelasio/files/gelasio-latin-ext-400-normal.woff')));
  app.use(express.static(path.join(root, 'public')));
  return app;
}

if (require.main === module) {
  const options = process.argv.includes('--direct-design') ? { words: [], directDesign: true }
    : process.argv.includes('--layout')
      ? { words: require('../test/support/area-layout-cases').SCREENSHOT_WORDS } : {};
  const server = createFixture(options).listen(0, '127.0.0.1', () => {
    console.log(`Configurator: http://127.0.0.1:${server.address().port}/e/${FIXTURE_SLUG}/configure?lang=en`);
    if (options.directDesign) console.log(`Direct design Home: http://127.0.0.1:${server.address().port}/?lang=de`);
    console.log('Add &probe=1 for repeatable browser geometry/interaction checks. No product records are written.');
    console.log(`Fixture PID: ${process.pid}`);
  });
  const close = () => { server.close(); server.closeAllConnections(); };
  process.once('SIGINT', close);
  process.once('SIGTERM', close);
}
module.exports = { createFixture };
