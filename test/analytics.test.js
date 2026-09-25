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

function browser({ pathname = '/', search = '', referrer = '', cookie = '',
  id = 'G-TEST123', storage = new Map() } = {}) {
  const cookies = new Map();
  for (const pair of cookie.split(';')) {
    const [name, value] = pair.trim().split('=');
    if (name && value) cookies.set(name, value);
  }
  const elements = Object.fromEntries(['ww-analytics-banner', 'ww-analytics-settings',
    'ww-analytics-accept', 'ww-analytics-reject'].map((name) => [name, {
    hidden: true, listeners: {},
    addEventListener(type, handler) { this.listeners[type] = handler; },
    click() { this.listeners.click(); },
  }]));
  const appended = [];
  const dispatched = [];
  let reloads = 0;
  const document = {
    currentScript: { dataset: { ga4Id: id } },
    readyState: 'complete',
    referrer,
    get cookie() { return [...cookies].map(([name, value]) => `${name}=${value}`).join('; '); },
    set cookie(header) {
      const [pair] = header.split(';');
      const [name, value] = pair.split('=');
      if (header.includes('Max-Age=0')) cookies.delete(name);
      else cookies.set(name, value);
    },
    getElementById(name) { return elements[name]; },
    createElement() { return {}; },
    head: { appendChild(tag) { appended.push(tag); } },
  };
  const root = {
    document,
    location: {
      origin: 'https://wolkenworte.io', hostname: 'wolkenworte.io', protocol: 'https:',
      pathname, search, reload() { reloads++; },
    },
    sessionStorage: {
      getItem(key) { return storage.get(key) || null; },
      setItem(key, value) { storage.set(key, value); },
      removeItem(key) { storage.delete(key); },
    },
    Event: class Event { constructor(type) { this.type = type; } },
    dispatchEvent(event) { dispatched.push(event.type); },
  };
  vm.runInNewContext(script, { window: root, URL, URLSearchParams, Date });
  return {
    root, cookies, elements, appended, dispatched,
    commands: () => (root.dataLayer || []).map((args) => Array.from(args)),
    reloads: () => reloads,
  };
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
    for (const name of ['analytics-head.ejs', 'analytics-ui.ejs']) {
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
  const template = fs.readFileSync(path.join(__dirname, '..', 'views', 'partials', 'analytics-ui.ejs'), 'utf8');
  const html = ejs.render(template, { analyticsMeasurementId: 'G-TEST123' });
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
  assert.equal(pageView[0][2].page_referrer, 'https://wolkenworte.io/analytics/configure');
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

test('withdrawal denies tracking, removes GA cookies, and reloads', () => {
  const state = browser({ cookie: 'wolkenworte-analytics=1-yes; _ga=visitor; _ga_TEST=visitor' });
  state.elements['ww-analytics-reject'].click();
  assert.equal(state.cookies.get('wolkenworte-analytics'), '1-no');
  assert.equal(state.cookies.has('_ga'), false);
  assert.equal(state.cookies.has('_ga_TEST'), false);
  assert.equal(state.reloads(), 1);
  assert.equal(state.root.WolkenworteAnalytics.track('word_submitted'), false);
});
