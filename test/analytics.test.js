'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ejs = require('ejs');
const analyticsConfig = require('../src/analyticsConfig');
const { runtimeSecrets } = require('../scripts/configure-fly-secrets');
const { localizeHtml } = require('../src/htmlLocalizer');

const script = fs.readFileSync(path.join(__dirname, '..', 'public/js/analytics.js'), 'utf8');
const slug = 'AbCdEf0123456789xyZQAA';

const { JSDOM } = require('jsdom');
const openDocuments = [];
test.afterEach(() => { for (const dom of openDocuments.splice(0)) dom.window.close(); });

function browser({ pathname = '/', search = '', referrer = '', cookie = '',
  id = 'G-TEST123', storage = new Map(), environment = 'local', entryFlow = '' } = {}) {
  const cookies = new Map(cookie.split(';').filter(Boolean).map(pair => pair.trim().split('=')));
  const partial = name => ejs.render(fs.readFileSync(path.join(__dirname, '../views/partials', name + '.ejs'), 'utf8'),
    { analyticsMeasurementId: id || 'G-TEST123' });
  const dom = new JSDOM('<html lang="de"><head><script></script></head><body><details>' +
    partial('analytics-settings') + '</details><footer>' + partial('analytics-settings') + '</footer>' +
    partial('analytics-ui') + '</body></html>', { url: 'https://wolkenworte.io' + pathname + search });
  openDocuments.push(dom);
  const document = dom.window.document;
  Object.defineProperty(document, 'readyState', { value: 'complete' });
  Object.defineProperty(document, 'referrer', { value: referrer });
  const currentScript = document.querySelector('script');
  Object.assign(currentScript.dataset, { ga4Id: id, appEnvironment: environment, entryFlow });
  Object.defineProperty(document, 'currentScript', { value: currentScript });
  Object.defineProperty(document, 'cookie', {
    get() { return [...cookies].map(([name, value]) => `${name}=${value}`).join('; '); },
    set(header) {
      const [name, value] = header.split(';')[0].split('=');
      if (header.includes('Max-Age=0')) cookies.delete(name); else cookies.set(name, value);
    },
  });
  const elements = Object.fromEntries(['ww-analytics-banner', 'ww-analytics-accept', 'ww-analytics-reject']
    .map(name => [name, document.getElementById(name)]));
  elements['ww-analytics-settings'] = document.querySelector('[data-analytics-settings]');
  const appended = [], dispatched = [];
  let reloads = 0;
  const append = document.head.appendChild.bind(document.head);
  document.head.appendChild = tag => { appended.push(tag); return append(tag); };
  const root = {
    document, location: { origin: 'https://wolkenworte.io', hostname: 'wolkenworte.io', protocol: 'https:',
      pathname, search, reload() { reloads++; } },
    sessionStorage: { getItem: key => storage.get(key) || null,
      setItem: (key, value) => storage.set(key, value), removeItem: key => storage.delete(key) },
    Event: dom.window.Event,
    addEventListener: (...args) => dom.window.addEventListener(...args),
    dispatchEvent(event) { dispatched.push(event.type); return dom.window.dispatchEvent(event); },
  };
  vm.runInNewContext(script, { window: root, URL, URLSearchParams, Date });
  return { root, cookies, elements, appended, dispatched, dom,
    commands: () => (root.dataLayer || []).map(args => Array.from(args)), reloads: () => reloads };
}

function eventCommands(state, name) {
  return state.commands().filter((command) => command[0] === 'event' && command[1] === name);
}

test('blank configuration renders no analytics UI or Google code', () => {
  const prior = process.env.GA4_MEASUREMENT_ID;
  try {
    delete process.env.GA4_MEASUREMENT_ID;
    assert.equal(analyticsConfig.measurementId(), '');
    const root = path.join(__dirname, '..', 'views', 'partials');
    for (const name of ['analytics-head.ejs', 'analytics-ui.ejs', 'analytics-settings.ejs']) {
      const template = fs.readFileSync(path.join(root, name), 'utf8');
      assert.equal(ejs.render(template, { analyticsMeasurementId: '', asset: (value) => value }).trim(), '');
    }
    const state = browser({ id: '' });
    assert.equal(state.root.WolkenworteAnalytics, undefined);
    assert.equal(state.appended.length, 0);
  } finally {
    if (prior === undefined) delete process.env.GA4_MEASUREMENT_ID;
    else process.env.GA4_MEASUREMENT_ID = prior;
  }
});

test('only GA4 web Measurement IDs enable analytics', () => {
  const prior = process.env.GA4_MEASUREMENT_ID;
  try {
    process.env.GA4_MEASUREMENT_ID = '123456789';
    assert.equal(analyticsConfig.measurementId(), '');
    assert.match(analyticsConfig.validationError(), /G-\.\.\./);
    process.env.GA4_MEASUREMENT_ID = 'G-ABC123';
    assert.equal(analyticsConfig.measurementId(), 'G-ABC123');
    assert.equal(analyticsConfig.validationError(), '');
  } finally {
    if (prior === undefined) delete process.env.GA4_MEASUREMENT_ID;
    else process.env.GA4_MEASUREMENT_ID = prior;
  }
});

test('Fly secret staging carries the optional GA4 Measurement ID', () => {
  const values = {
    DATABASE_URL: 'postgresql://wolkenworte_app:test@localhost/wolkenworte',
    SUPABASE_URL: 'https://example.supabase.co',
    SUPABASE_SECRET_KEY: 'test-key',
    RATE_LIMIT_HMAC_SECRET: 'test-hmac',
    MAINTENANCE_SECRET: 'test-maintenance',
    GA4_MEASUREMENT_ID: 'G-TEST123',
  };
  const previous = Object.fromEntries(Object.keys(values).map((name) => [name, process.env[name]]));
  try {
    Object.assign(process.env, values);
    assert.equal(runtimeSecrets().GA4_MEASUREMENT_ID, 'G-TEST123');
    delete process.env.GA4_MEASUREMENT_ID;
    assert.equal(Object.hasOwn(runtimeSecrets(), 'GA4_MEASUREMENT_ID'), false);
    assert.equal(Object.hasOwn(runtimeSecrets(), 'MIGRATION_DATABASE_URL'), false);
  } finally {
    for (const [name, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  }
});

test('enabled consent controls render in the selected site language', () => {
  const partials = path.join(__dirname, '..', 'views', 'partials');
  const html = ['analytics-ui.ejs', 'analytics-settings.ejs'].map((name) => ejs.render(
    fs.readFileSync(path.join(partials, name), 'utf8'), { analyticsMeasurementId: 'G-TEST123' }
  )).join('');
  const english = localizeHtml(html, 'en');
  assert.match(english, /Continue without analytics/);
  assert.match(english, /Allow analytics/);
  assert.match(english, /Privacy settings/);
});

test('Google tag and events remain off before consent and after rejection', () => {
  const state = browser();
  assert.equal(state.elements['ww-analytics-banner'].hidden, false);
  assert.equal(state.root.WolkenworteAnalytics.track('word_submitted'), false);
  assert.equal(state.appended.length, 0);
  assert.equal(state.commands().length, 0);
  state.elements['ww-analytics-reject'].click();
  assert.equal(state.cookies.get('wolkenworte-analytics'), '1-no');
  assert.equal(state.appended.length, 0);
  assert.equal(state.root.WolkenworteAnalytics.track('word_submitted'), false);
});

test('acceptance loads GA once and sends generic page context', () => {
  const state = browser({
    pathname: `/e/${slug}/order-confirmation`,
    search: '?session_id=cs_private_secret&email=someone@example.test',
    referrer: `https://wolkenworte.io/e/${slug}/configure?configuration=private-id`,
  });
  state.elements['ww-analytics-accept'].click();
  assert.equal(state.cookies.get('wolkenworte-analytics'), '1-yes');
  assert.deepEqual(state.appended.map((tag) => tag.src),
    ['https://www.googletagmanager.com/gtag/js?id=G-TEST123']);
  const pageView = eventCommands(state, 'page_view');
  assert.equal(pageView.length, 1);
  assert.equal(pageView[0][2].page_location, 'https://wolkenworte.io/analytics/confirmation');
  assert.equal(pageView[0][2].page_referrer, 'https://wolkenworte.io/analytics/gallery');
  assert.equal(pageView[0][2].page_title, 'Wolkenworte confirmation');
  assert.equal(state.commands().find((command) => command[0] === 'config')[2].send_page_view, false);
  assert.ok(!JSON.stringify(state.commands()).includes(slug));
  assert.ok(!JSON.stringify(state.commands()).includes('cs_private_secret'));
  assert.ok(!JSON.stringify(state.commands()).includes('someone@example.test'));
});

test('purchase requires confirmed payment and sends one sanitized revenue event', () => {
  const state = browser({ cookie: 'wolkenworte-analytics=1-yes' });
  const order = {
    paymentConfirmed: true, orderNumber: 'WW-00000031',
    totalCents: 3456, shippingCents: 500, taxCents: 456, currency: 'EUR',
    buyerEmail: 'someone@example.test',
    analyticsItems: [{ productKey: 'white-glossy-mug-duo-11oz', unitPriceCents: 1250, quantity: 2 }],
  };
  assert.equal(state.root.WolkenworteAnalytics.trackPurchase({ ...order, paymentConfirmed: false }), false);
  assert.equal(state.root.WolkenworteAnalytics.trackPurchase(order), true);
  assert.equal(state.root.WolkenworteAnalytics.trackPurchase(order), false);
  const purchases = eventCommands(state, 'purchase');
  assert.equal(purchases.length, 1);
  assert.equal(purchases[0][2].transaction_id, 'WW-00000031');
  assert.equal(purchases[0][2].value, 25);
  assert.equal(purchases[0][2].shipping, 5);
  assert.equal(purchases[0][2].tax, 4.56);
  assert.ok(!JSON.stringify(purchases).includes('someone@example.test'));
});

test('journey markers appear only on their successful destination page', () => {
  const storage = new Map();
  const accepted = 'wolkenworte-analytics=1-yes';
  const source = browser({ cookie: accepted, storage });
  source.root.WolkenworteAnalytics.markNextPageEvent('cloud_created');
  const destination = browser({
    pathname: `/e/${slug}`, search: '?secret=private', cookie: accepted, storage,
  });
  assert.equal(eventCommands(destination, 'cloud_created').length, 1);
  assert.equal(eventCommands(destination, 'cloud_created')[0][2].page_location,
    'https://wolkenworte.io/analytics/event');
  const revisit = browser({ pathname: `/e/${slug}`, cookie: accepted, storage });
  assert.equal(eventCommands(revisit, 'cloud_created').length, 0);
});

test('inclusive shipping tax is removed once when calculating purchase revenue', () => {
  const state = browser({ cookie: 'wolkenworte-analytics=1-yes' });
  assert.equal(state.root.WolkenworteAnalytics.trackPurchase({
    paymentConfirmed: true, orderNumber: 'WW-00000032', currency: 'EUR',
    totalCents: 5655, shippingCents: 1484, netShippingCents: 1247, taxCents: 902,
    analyticsItems: [{ productKey: 'white-glossy-mug-duo-11oz', unitPriceCents: 1753, quantity: 2 }],
  }), true);
  const purchase = eventCommands(state, 'purchase')[0][2];
  assert.equal(purchase.value, 35.06);
  assert.equal(purchase.shipping, 12.47);
  assert.equal(purchase.tax, 9.02);
});

test('withdrawal denies tracking, removes GA cookies, and reloads', () => {
  const state = browser({ cookie: 'wolkenworte-analytics=1-yes; _ga=visitor; _ga_TEST=visitor' });
  state.elements['ww-analytics-reject'].click();
  assert.equal(state.cookies.get('wolkenworte-analytics'), '1-no');
  assert.equal(state.cookies.has('_ga'), false);
  assert.equal(state.cookies.has('_ga_TEST'), false);
  assert.equal(state.reloads(), 1);
  assert.equal(state.root.WolkenworteAnalytics.track('word_submitted'), false);
});

test('opening privacy settings from an overflow menu closes the menu', () => {
  const state = browser({ cookie: 'wolkenworte-analytics=1-no' });
  let closed = false;
  state.elements['ww-analytics-settings'].closest = (selector) => {
    assert.equal(selector, 'details');
    return { removeAttribute(name) { assert.equal(name, 'open'); closed = true; } };
  };
  state.elements['ww-analytics-settings'].click();
  assert.equal(closed, true);
  assert.equal(state.elements['ww-analytics-banner'].hidden, false);
});

test('every header and footer privacy control works, without duplicate IDs', () => {
  const state = browser({ cookie: 'wolkenworte-analytics=1-yes' });
  const controls = [...state.root.document.querySelectorAll('[data-analytics-settings]')];
  assert.equal(controls.length, 2);
  const ids = [...state.root.document.querySelectorAll('[id]')].map(node => node.id);
  assert.equal(new Set(ids).size, ids.length);
  for (const control of controls) {
    assert.equal(control.hidden, false);
    control.click();
    assert.equal(state.elements['ww-analytics-banner'].hidden, false);
    state.elements['ww-analytics-accept'].click();
  }
  assert.equal(state.appended.length, 1, 'reopening settings never loads a second tag');
});

test('account pages render shared consent controls and use a generic account URL', async () => {
  const prior = process.env.GA4_MEASUREMENT_ID;
  process.env.GA4_MEASUREMENT_ID = 'G-TEST123';
  try {
    const { renderPage } = require('../src/pageRenderer');
    const response = { cookie() {}, status() {}, set() {}, vary() {}, send: html => html };
    const html = await renderPage({ originalUrl: '/konto/einstellungen?email=private@example.test',
      query: {}, headers: {} }, response, 'account', { pageData: { accountAvailable: false } });
    const dom = new JSDOM(html); openDocuments.push(dom);
    assert.equal(dom.window.document.querySelectorAll('script[data-ga4-id]').length, 1);
    assert.equal(dom.window.document.querySelectorAll('[data-analytics-settings]').length, 2);
    assert.ok(dom.window.document.getElementById('ww-analytics-banner'));
    const state = browser({ pathname: '/konto/einstellungen', search: '?email=private@example.test', cookie: 'wolkenworte-analytics=1-yes' });
    assert.equal(eventCommands(state, 'page_view')[0][2].page_location, 'https://wolkenworte.io/analytics/account');
    assert.ok(!JSON.stringify(state.commands()).includes('private@example.test'));
  } finally {
    if (prior === undefined) delete process.env.GA4_MEASUREMENT_ID; else process.env.GA4_MEASUREMENT_ID = prior;
  }
});

test('virtual gallery, editor and basket views dedupe and keep sanitized referrers', () => {
  const state = browser({ pathname: `/e/${slug}/configure`, search: '?view=products&configuration=secret', cookie: 'wolkenworte-analytics=1-yes' });
  const analytics = state.root.WolkenworteAnalytics;
  assert.equal(analytics.page('gallery', 'direct'), false);
  assert.equal(analytics.page('editor', 'direct'), true);
  assert.equal(analytics.page('editor', 'direct'), false);
  assert.equal(analytics.page('cart', 'direct'), true);
  assert.equal(analytics.page('secret-untrusted-name'), false);
  const views = eventCommands(state, 'page_view').map(command => command[2]);
  assert.deepEqual(Array.from(views, view => new URL(view.page_location).pathname), ['/analytics/gallery', '/analytics/editor', '/analytics/cart']);
  assert.equal(views[1].page_referrer, 'https://wolkenworte.io/analytics/gallery');
  assert.equal(views[2].page_referrer, 'https://wolkenworte.io/analytics/editor');
  assert.equal(views[2].entry_flow, 'direct');
  assert.ok(!JSON.stringify(views).includes(slug));
  assert.ok(!JSON.stringify(views).includes('secret'));
});

test('campaigns survive deep landings but private query values and referrer paths never do', () => {
  const state = browser({ pathname: `/e/${slug}/configure`,
    search: '?utm_source=instagram&utm_medium=social&utm_campaign=gifts&utm_content=card1&utm_term=mug&email=private@example.test&gclid=private-ad-id',
    referrer: 'https://example.test/private-name?email=private@example.test', cookie: 'wolkenworte-analytics=1-yes' });
  const view = eventCommands(state, 'page_view')[0][2];
  assert.equal(new URL(view.page_location).searchParams.get('utm_content'), 'card1');
  assert.equal(new URL(view.page_location).searchParams.get('utm_term'), 'mug');
  assert.equal(view.page_referrer, 'https://example.test/');
  assert.ok(!JSON.stringify(state.commands()).includes('private'));
});

test('ecommerce includes exact product quantities and cents but excludes arbitrary details', () => {
  const state = browser({ cookie: 'wolkenworte-analytics=1-yes', environment: 'hosted-test' });
  const details = { currency: 'EUR', email: 'private@example.test', value: 9999,
    items: [{ productKey: 'white-glossy-mug-duo-11oz', category: 'mugs', unitPriceCents: 930, quantity: 3,
      name: 'Private wedding title', configurationId: 'secret-configuration' },
      { productKey: 'matte-poster-30x40cm', unitPriceCents: 1645, quantity: 2 }] };
  for (const name of ['view_item_list', 'select_item', 'view_item', 'view_cart', 'begin_checkout', 'add_shipping_info', 'payment_redirect']) {
    assert.equal(state.root.WolkenworteAnalytics.commerce(name, details), true);
    const event = eventCommands(state, name)[0][2];
    assert.equal(event.value, 60.8);
    assert.equal(event.items[0].quantity, 3);
    assert.equal(event.items[0].price, 9.3);
    assert.equal(event.app_environment, 'hosted-test');
  }
  assert.ok(!JSON.stringify(state.commands()).includes('Private'));
  assert.ok(!JSON.stringify(state.commands()).includes('secret-configuration'));
  assert.ok(!JSON.stringify(state.commands()).includes('private@example.test'));
  assert.equal(state.root.WolkenworteAnalytics.commerce('view_item', { ...details, currency: 'USD' }), false);
  assert.equal(state.root.WolkenworteAnalytics.commerce('view_item', { ...details, items: [...details.items, { productKey: 'invalid' }] }), false);
});

test('cart quantity deltas, replacements and cross-page removal Undo reconcile', () => {
  const storage = new Map();
  const state = browser({ cookie: 'wolkenworte-analytics=1-yes', storage });
  const a = { productKey: 'white-glossy-mug-duo-11oz', unitPriceCents: 930, quantity: 3 };
  const b = { productKey: 'matte-poster-30x40cm', unitPriceCents: 1645, quantity: 2 };
  state.root.WolkenworteAnalytics.cartChange(a, { ...a, quantity: 5 });
  assert.equal(eventCommands(state, 'add_to_cart')[0][2].items[0].quantity, 2);
  state.root.WolkenworteAnalytics.cartChange(a, b);
  assert.equal(eventCommands(state, 'remove_from_cart')[0][2].items[0].item_id, a.productKey);
  state.root.WolkenworteAnalytics.cartChange(b, null);
  const returned = browser({ cookie: 'wolkenworte-analytics=1-yes', storage });
  assert.equal(returned.root.WolkenworteAnalytics.restoreCartItem(b.productKey, b.quantity), true);
  assert.equal(returned.root.WolkenworteAnalytics.restoreCartItem(b.productKey, b.quantity), false);
  assert.equal(eventCommands(returned, 'add_to_cart')[0][2].value, 32.9);
});

test('excluding and re-including a retained cart design reports its quantity delta', () => {
  const state = browser({ cookie: 'wolkenworte-analytics=1-yes' });
  const item = { productKey: 'white-glossy-mug-duo-11oz', unitPriceCents: 930, quantity: 3 };
  const zero = { ...item, quantity: 0 };
  assert.equal(state.root.WolkenworteAnalytics.cartChange(item, zero), true);
  assert.equal(eventCommands(state, 'remove_from_cart')[0][2].value, 27.9);
  assert.equal(state.root.WolkenworteAnalytics.cartChange(zero, item), true);
  assert.equal(eventCommands(state, 'add_to_cart')[0][2].items[0].quantity, 3);
  assert.equal(state.root.WolkenworteAnalytics.commerce('view_cart', { currency: 'EUR', items: [] }), true);
  assert.equal(eventCommands(state, 'view_cart')[0][2].value, 0);
});

test('library and reorder flow survive checkout reloads only for the same local cart', () => {
  const storage = new Map(), cookie = 'wolkenworte-analytics=1-yes';
  browser({ pathname: `/e/${slug}/configure`, search: '?accountDesign=private', cookie, storage });
  const shipping = browser({ pathname: `/e/${slug}/shipping`, cookie, storage });
  assert.equal(eventCommands(shipping, 'page_view')[0][2].entry_flow, 'library');
  shipping.root.WolkenworteAnalytics.page('shipping', 'cloud');
  assert.equal(shipping.root.WolkenworteAnalytics.track('checkout_cancelled'), true);
  assert.equal(eventCommands(shipping, 'checkout_cancelled')[0][2].entry_flow, 'library');
  shipping.root.WolkenworteAnalytics.markNextPageEvent('reorder_started');
  const reorder = browser({ pathname: `/e/${slug}/shipping`, cookie, storage });
  assert.equal(eventCommands(reorder, 'page_view')[0][2].entry_flow, 'reorder');
  assert.equal(eventCommands(reorder, 'reorder_started').length, 1);
  const confirmation = browser({ pathname: `/e/${slug}/order-confirmation`, cookie, storage });
  assert.equal(eventCommands(confirmation, 'page_view')[0][2].entry_flow, 'reorder');
  const other = browser({ pathname: `/e/${'x'.repeat(22)}/shipping`, cookie, storage });
  assert.equal(eventCommands(other, 'page_view')[0][2].entry_flow, 'cloud');
});

test('declined consent drops ecommerce, navigation markers and purchases without later replay', () => {
  const state = browser();
  const item = { productKey: 'white-glossy-mug-duo-11oz', unitPriceCents: 930, quantity: 1 };
  assert.equal(state.root.WolkenworteAnalytics.commerce('add_to_cart', { currency: 'EUR', items: [item] }), false);
  state.root.WolkenworteAnalytics.markNextPageEvent('design_started');
  state.elements['ww-analytics-accept'].click();
  assert.equal(eventCommands(state, 'add_to_cart').length, 0);
  assert.equal(eventCommands(state, 'design_started').length, 0);
});

test('another tab withdrawing consent stops events and denies the running tag on focus', () => {
  const state = browser({ cookie: 'wolkenworte-analytics=1-yes; _ga=visitor' });
  state.cookies.set('wolkenworte-analytics', '1-no');
  assert.equal(state.root.WolkenworteAnalytics.track('word_submitted'), false);
  state.root.dispatchEvent(new state.root.Event('focus'));
  assert.equal(state.reloads(), 1);
  assert.equal(state.cookies.has('_ga'), false);
  assert.equal(state.commands().at(-1)[2].analytics_storage, 'denied');
});

test('checkout failures and share methods are strictly allowlisted', () => {
  const state = browser({ cookie: 'wolkenworte-analytics=1-yes' });
  const analytics = state.root.WolkenworteAnalytics;
  analytics.track('checkout_error', { stage: 'payment', reason: 'private@example.test', address: 'Secret address' });
  analytics.track('share', { method: 'copy_link', url: `/e/${slug}` });
  assert.equal(eventCommands(state, 'checkout_error')[0][2].failure_reason, 'unknown');
  assert.equal(eventCommands(state, 'share')[0][2].method, 'copy_link');
  assert.equal(analytics.track('share', { method: 'private@example.test' }), false);
  assert.ok(!JSON.stringify(state.commands()).includes('Secret address'));
  assert.ok(!JSON.stringify(state.commands()).includes(slug));
});
