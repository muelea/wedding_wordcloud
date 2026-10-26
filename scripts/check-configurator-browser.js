'use strict';

// Render the real configurator with an in-memory API fixture. No .env,
// database, provider calls or writable configuration endpoints are loaded.
const path = require('node:path');
const express = require('express');
const { renderPage } = require('../src/pageRenderer');
const { DEFAULT_PRODUCT, getProduct, getPublicProduct, getPublicProducts, getPublicProductFamilies } = require('../src/products');
const { ASSET_BASE } = require('../public/js/emoji-catalog');
const { makeEmojiArtworkRouter } = require('../src/routes/emojiArtwork');
const FIXTURE_SLUG = '-_AbCdEf0123456789xyZQ';

function createFixture({ words = [['test', 1]], directDesign = false, review = false } = {}) {
  const app = express();
  const root = path.join(__dirname, '..');
  const configurations = new Map();
  const publicConfiguration = saved => {
    const product = getPublicProduct(getProduct(saved.productKey), saved.orientation);
    const printPreviewUrls = Object.fromEntries(product.printSurfaces.map(surface => [surface.key,
      `/api/events/${FIXTURE_SLUG}/configurations/${saved.id}/print.svg?surface=${surface.key}`]));
    return { ...saved, product, printPreviewUrls, printFileUrl: Object.values(printPreviewUrls)[0],
      mockupUrl: `/api/events/${FIXTURE_SLUG}/configurations/${saved.id}/mockups` };
  };
  app.use(express.json({ limit: '2mb' }));
  app.use((req, res, next) => { res.set('Cache-Control', 'no-store'); next(); });
  if (review) {
    const user = { id: '41139ef6-90f5-400d-bac5-8b7365f88428', email: 'fixture@example.invalid' };
    app.get('/api/account/session', (req, res) => res.json({ user }));
    app.post('/api/account/designs', (req, res) => res.json({ design: {
      id: req.body.designId, name: req.body.name, version: (req.body.version || 0) + 1,
    } }));
    app.get('/review-probe.js', (req, res) => res.sendFile(path.join(root, 'test/browser/cart-review-probe.js')));
    app.get('/menu', (req, res, next) => {
      const palettes = getPublicProduct(DEFAULT_PRODUCT).themes.filter(theme => theme.key !== 'custom');
      renderPage(req, res, 'display', {
        header: { variant: 'display', hasWords: true, paletteOptions: palettes },
        pageData: { cloudTitle: 'Menu preview', eventUrl: `${req.protocol}://${req.get('host')}/menu`,
          initialWords: [], qrSvg: '', paletteOptions: palettes },
      }).catch(next);
    });
  }
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
    <body><a id="fixture-configure-link" href="/e/${FIXTURE_SLUG}/configure?lang=en&view=products">Create a keepsake</a></body></html>`));
  app.get(`/e/${FIXTURE_SLUG}/configure`, (req, res, next) => {
    if (['1', 'area', 'touch', 'review', 'gallery', 'product-ux', 'performance', 'scroll', 'gallery-input'].includes(req.query.probe)) {
      const send = res.send.bind(res);
      const probe = req.query.probe === 'scroll' ? 'overlay-scroll' : req.query.probe === 'product-ux' ? 'product-ux' : req.query.probe === 'gallery' ? 'product-gallery' : req.query.probe === 'review' ? 'review' : req.query.probe === 'area' ? 'area-layout' : req.query.probe === 'touch' ? 'mobile-canvas' : 'responsive';
      res.send = html => {
        if (req.query.probe === 'gallery-input') {
          return send(html.replace('<head>', '<head><script src="/gallery-input-scroll-probe.js"></script>'));
        }
        if (req.query.probe === 'performance') {
          return send(html.replace(/(<script src="[^\"]*\/js\/print-layout-client\.js[^\"]*"><\/script>)/,
            '$1<script src="/print-layout-performance-probe.js"></script>'));
        }
        // A narrow desktop window is intentionally still a desktop. The touch
        // fixture supplies mobile device signals before any application scripts.
        if (probe === 'mobile-canvas' || req.query.device === 'mobile') html = html.replace('<head>', `<head><script>
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
    res.status(201).json(publicConfiguration(configuration));
  });
  app.get(`/api/events/${FIXTURE_SLUG}/configurations/:id/edit`, (req, res) => {
    const configuration = configurations.get(req.params.id);
    if (!configuration) return res.status(404).json({ error: 'not_found' });
    res.json(configuration);
  });
  app.get(`/e/${FIXTURE_SLUG}/shipping`, (req, res, next) => renderPage(req, res, 'shipping', {
    eventLocale: 'en', header: { variant: 'back', backHref: `/e/${FIXTURE_SLUG}/configure`,
      backLabel: 'Zurück zum Design', mobileMenu: true },
  }).catch(next));
  app.get('/api/shipping/countries', (req, res) => res.json({ countries: [
    { code: 'DE', name: 'Germany', states: [] },
  ] }));
  app.get(`/api/events/${FIXTURE_SLUG}/configurations/:id`, (req, res) => {
    const saved = configurations.get(req.params.id);
    if (!saved) return res.status(404).json({ error: 'not_found' });
    res.json(publicConfiguration(saved));
  });
  app.get(`/api/events/${FIXTURE_SLUG}/configurations`, (req, res) => {
    const saved = String(req.query.ids || '').split(',').map(id => configurations.get(id));
    if (saved.some(item => !item)) return res.status(404).json({ error: 'not_found' });
    res.json({ configurations: saved.map(publicConfiguration) });
  });
  app.get(`/api/events/${FIXTURE_SLUG}/configurations/:id/print.svg`, (req, res) => {
    const saved = configurations.get(req.params.id);
    if (!saved) return res.sendStatus(404);
    const product = getPublicProduct(getProduct(saved.productKey), saved.orientation);
    const surface = req.query.surface || product.printSurfaces[0].key;
    res.type('image/svg+xml').send(require('../src/mugPrint').buildProductPrintSvg(product, saved.designs[surface]));
  });
  app.get(`/api/events/${FIXTURE_SLUG}/configurations/:id/print.png`, async (req, res, next) => {
    const saved = configurations.get(req.params.id);
    if (!saved) return res.sendStatus(404);
    const product = getPublicProduct(getProduct(saved.productKey), saved.orientation);
    const surface = req.query.surface || product.printSurfaces[0].key;
    try {
      res.type('image/png').send(await require('../src/printRaster').renderProviderPng(product, saved.designs[surface]));
    } catch (error) { next(error); }
  });
  app.get('/responsive-probe.js', (req, res) => res.sendFile(path.join(root, 'test/browser/configurator-workspace-probe.js')));
  app.get('/overlay-scroll-probe.js', (req, res) => res.sendFile(path.join(root, 'test/browser/overlay-scroll-probe.js')));
  app.get('/area-layout-probe.js', (req, res) => res.sendFile(path.join(root, 'test/browser/area-layout-probe.js')));
  app.get('/mobile-canvas-probe.js', (req, res) => res.sendFile(path.join(root, 'test/browser/mobile-canvas-probe.js')));
  app.get('/product-gallery-probe.js', (req, res) => res.sendFile(path.join(root, 'test/browser/product-gallery-probe.js')));
  app.get('/product-ux-probe.js', (req, res) => res.sendFile(path.join(root, 'test/browser/product-ux-probe.js')));
  app.get('/print-layout-performance-probe.js', (req, res) => res.sendFile(path.join(root, 'test/browser/print-layout-performance-probe.js')));
  app.get('/gallery-input-scroll-probe.js', (req, res) => res.sendFile(path.join(root, 'test/browser/gallery-input-scroll-probe.js')));
  app.use(ASSET_BASE, makeEmojiArtworkRouter());
  app.get('/vendor/three.min.js', (req, res) => res.sendFile(path.join(root, 'node_modules/three/build/three.min.js')));
  app.use('/vendor/three', express.static(path.join(root, 'node_modules/three'), { index: false, dotfiles: 'deny' }));
  app.get('/vendor/fabric.min.js', (req, res) => res.sendFile(path.join(root, 'node_modules/fabric/dist/index.min.js')));
  app.get('/vendor/fonts/gelasio-latin-ext-400-normal.woff', (req, res) =>
    res.sendFile(require.resolve('@fontsource/gelasio/files/gelasio-latin-ext-400-normal.woff')));
  app.use(express.static(path.join(root, 'public')));
  return app;
}

if (require.main === module) {
  const options = process.argv.includes('--review') ? { words: require('../test/support/area-layout-cases').SCREENSHOT_WORDS, review: true }
    : process.argv.includes('--direct-design') ? { words: [], directDesign: true }
    : process.argv.includes('--gallery')
      ? { words: require('../marketing/clouds/classic-wedding.json').words.map(({ word, count }) => [word, count]) }
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
