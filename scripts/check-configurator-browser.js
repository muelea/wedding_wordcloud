'use strict';

// Render the real configurator with an in-memory API fixture. No .env,
// database, provider calls or writable configuration endpoints are loaded.
const path = require('node:path');
const express = require('express');
const { renderPage } = require('../src/pageRenderer');
const { DEFAULT_PRODUCT, getPublicProduct, getPublicProducts, getPublicProductFamilies } = require('../src/products');
const { ASSET_BASE } = require('../public/js/emoji-catalog');
const { makeEmojiArtworkRouter } = require('../src/routes/emojiArtwork');

function createFixture() {
  const app = express();
  const root = path.join(__dirname, '..');
  app.use((req, res, next) => { res.set('Cache-Control', 'no-store'); next(); });
  app.get('/e/responsive-test/configure', (req, res, next) => {
    if (req.query.probe === '1') {
      const send = res.send.bind(res);
      res.send = html => send(html.replace('</body>', '<script src="/responsive-probe.js"></script></body>'));
    }
    renderPage(req, res, 'configure', {
      eventLocale: 'en',
      header: { variant: 'back', headerClass: 'topbar', brandId: 'brand-link', backId: 'back-link',
        backHref: '/e/responsive-test', backLabel: 'Zurück zur Wortwolke' },
    }).catch(next);
  });
  app.get('/api/events/responsive-test/configurator', (req, res) => res.json({
    event: { slug: 'responsive-test', title: 'Responsive test', locale: 'en' },
    words: [['test', 1]],
    product: getPublicProduct(DEFAULT_PRODUCT),
    products: getPublicProducts(),
    productFamilies: getPublicProductFamilies(),
  }));
  app.get('/responsive-probe.js', (req, res) => res.sendFile(path.join(root, 'test/browser/configurator-workspace-probe.js')));
  app.use(ASSET_BASE, makeEmojiArtworkRouter());
  app.get('/vendor/three.min.js', (req, res) => res.sendFile(path.join(root, 'node_modules/three/build/three.min.js')));
  app.get('/vendor/fabric.min.js', (req, res) => res.sendFile(path.join(root, 'node_modules/fabric/dist/index.min.js')));
  app.get('/vendor/fonts/gelasio-latin-ext-400-normal.woff', (req, res) =>
    res.sendFile(require.resolve('@fontsource/gelasio/files/gelasio-latin-ext-400-normal.woff')));
  app.use(express.static(path.join(root, 'public')));
  return app;
}

if (require.main === module) {
  const server = createFixture().listen(0, '127.0.0.1', () => {
    console.log(`Configurator: http://127.0.0.1:${server.address().port}/e/responsive-test/configure?lang=en`);
    console.log('Add &probe=1 for repeatable browser geometry/interaction checks. No product records are written.');
    console.log(`Fixture PID: ${process.pid}`);
  });
  const close = () => { server.close(); server.closeAllConnections(); };
  process.once('SIGINT', close);
  process.once('SIGTERM', close);
}
module.exports = { createFixture };
