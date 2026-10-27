'use strict';

// Browser acceptance only: real templates/client scripts, in-memory commerce,
// a loopback Google-tag recorder, no .env, provider calls or business database.
const fs = require('node:fs');
const path = require('node:path');
const express = require('express');
const { testEnvironment } = require('../test/support/local-postgres');
Object.assign(process.env, testEnvironment(process.env), { GA4_MEASUREMENT_ID: 'G-LOCALQA123' });
const { createFixture } = require('./check-configurator-browser');
const { renderPage } = require('../src/pageRenderer');
const { analyticsItems } = require('../src/analyticsCommerce');
const slug = '-_AbCdEf0123456789xyZQ';
const app = createFixture({ directDesign: true, words: [['Local', 3], ['Analytics', 2], ['Test', 1]] });
const configurations = new Map();
let quote = null, paid = false;
const router = express.Router();
router.use(express.json({ limit: '2mb' }));
router.use((req, res, next) => {
  const send = res.send.bind(res), json = res.json.bind(res);
  res.send = value => send(typeof value === 'string' && /<!doctype html>/i.test(value)
    ? value.replace('</body>', '<details id="local-analytics"><summary>Lokale Analytics-Prüfung</summary><pre id="local-analytics-events"></pre></details><script src="/__analytics-observer.js"></script></body>') : value);
  res.json = value => {
    if (req.method === 'POST' && /\/configurations$/.test(req.path) && value?.id) configurations.set(value.id, value);
    return json(value);
  };
  next();
});
router.get('/js/analytics.js', (req, res) => res.type('js').send(
  fs.readFileSync(path.join(__dirname, '../public/js/analytics.js'), 'utf8')
    .replace('https://www.googletagmanager.com/gtag/js', '/__analytics-tag.js')));
router.get('/__analytics-observer.js', (req, res) => res.type('js').send(`
  window.localAnalyticsRender = function () {
    document.getElementById('local-analytics-events').textContent = sessionStorage.getItem('local-analytics-events') || '[]';
  }; window.localAnalyticsRender();
`));
router.get('/__analytics-tag.js', (req, res) => res.type('js').send(`
  const recorded = JSON.parse(sessionStorage.getItem('local-analytics-events') || '[]');
  function record(args) {
    if (args[0] !== 'event') return;
    recorded.push({ name: args[1], parameters: args[2] });
    sessionStorage.setItem('local-analytics-events', JSON.stringify(recorded));
    window.localAnalyticsRender?.();
  }
  (window.dataLayer || []).forEach(record);
  window.gtag = function () { window.dataLayer.push(arguments); record(arguments); };
`));
router.get('/konto', (req, res, next) => renderPage(req, res, 'account', {
  header: { variant: 'back' }, pageData: { accountAvailable: false },
}).catch(next));
router.get(`/e/${slug}/shipping`, (req, res, next) => renderPage(req, res, 'shipping', {
  eventLocale: 'en', pageData: { directDesign: true },
  header: { variant: 'back', backHref: `/e/${slug}/configure?view=products`, backLabel: 'Zur Produktübersicht' },
}).catch(next));
router.post(`/api/events/${slug}/cart/estimate-costs`, (req, res) => {
  const rows = req.body.shipments[0].items.map(item => {
    const product = configurations.get(item.configurationId).product;
    return { productKey: product.key, quantity: item.quantity, unitAmountCents: product.price.unitGrossCents,
      netTotalCents: product.price.unitNetCents * item.quantity };
  });
  const net = rows.reduce((sum, row) => sum + row.netTotalCents, 0);
  const gross = rows.reduce((sum, row) => sum + row.unitAmountCents * row.quantity, 0);
  quote = { id: 'local-quote', currency: 'EUR', quantity: rows.reduce((sum, row) => sum + row.quantity, 0),
    itemsCents: gross, grossItemsCents: gross, shippingCents: 595, grossShippingCents: 595,
    taxCents: gross - net + 95, totalCents: gross + 595, taxBehavior: 'inclusive',
    pricingVersion: 2, pricedItems: rows, analyticsItems: analyticsItems(rows, net), checkoutPrepared: true,
    expiresAt: new Date(Date.now() + 1800000).toISOString(), checkoutExpiresAt: new Date(Date.now() + 1800000).toISOString() };
  res.json({ quote });
});
router.post(`/api/events/${slug}/cart/checkout`, (req, res) => res.json({ quote,
  ...(req.body.intent === 'pay' ? { url: '/__analytics-payment' } : {}) }));
router.get('/__analytics-payment', (req, res) => {
  paid = true;
  res.redirect(`/e/${slug}/order-confirmation?session_id=cs_test_local_analytics`);
});
router.get(`/e/${slug}/order-confirmation`, (req, res, next) => renderPage(req, res, 'order-confirmation', {
  pageData: { directDesign: true }, eventLocale: 'en',
}).catch(next));
router.get(`/api/events/${slug}/orders/status`, (req, res) => res.json({
  paymentConfirmed: paid, orderNumber: paid ? 'WW-00009999' : null, mode: 'test',
  currency: 'EUR', totalCents: quote.totalCents, netShippingCents: 500, taxCents: quote.taxCents,
  analyticsItems: paid ? quote.analyticsItems : [], quantity: quote.quantity,
  configurationIds: [...configurations.keys()], shipmentCount: 1,
}));
// Simulate only Printful's image response. The real approval UI still requires
// loading each selected product image and explicit customer acceptance.
router.all(`/api/events/${slug}/cart/mockups`, (req, res) => res.json({ jobs: [{
  jobId: 'localanalyticsmockup00001', status: 'completed', expiresAt: Date.now() + 3600000,
  configurationIds: [...configurations.keys()],
  items: [...configurations.values()].map(configuration => ({ configurationId: configuration.id,
    mockups: [{ url: '/assets/product-thumbnails/mug.svg', surfaceKey: 'default' }] })),
}] }));
app.use(router);
// Keep Express query/init middleware ahead of the fixture router.
app._router.stack.splice(2, 0, app._router.stack.pop());
const server = app.listen(0, '127.0.0.1', () => {
  console.log(`Local analytics acceptance: http://127.0.0.1:${server.address().port}/?lang=en`);
  console.log('All analytics and commerce stay local. Expand “Lokale Analytics-Prüfung” to inspect payloads.');
});
const close = () => { server.close(); server.closeAllConnections(); };
process.once('SIGINT', close);
process.once('SIGTERM', close);
