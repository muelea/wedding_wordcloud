'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { DEFAULT_PRODUCT, getPublicProduct, getPublicProducts } = require('../src/products');
const WordCloudCore = require('../public/js/wordcloud-core');
const { startTestServer, createEvent } = require('./helpers');

const PALETTE_KEYS = ['konfetti', 'dopamin-pop', 'pastel', 'sage-gold', 'ocean', 'custom'];
const APPROVED_COLORS = {
  konfetti: ['#2455f5', '#ed2446', '#18a84b', '#efbf00', '#f77500', '#e600b8'],
  'dopamin-pop': ['#ff6a00', '#f500a6', '#00bfc4', '#ffd400', '#7b2cff', '#7ccc00'],
};
const WORDS = ['liebe', 'lachen', 'glück', 'sonne', 'tanzen', 'immer'];
const themes = getPublicProduct().themes;
const themeRuntime = fs.readFileSync(path.join(__dirname, '../public/js/theme.js'), 'utf8');

function themeBrowser(saved = {}) {
  const properties = new Map();
  const meta = { content: '' };
  const document = {
    documentElement: {
      dataset: {},
      style: { setProperty: (key, value) => properties.set(key, value) },
      classList: { add() {}, remove() {} },
    },
    querySelector: () => meta,
  };
  const window = {
    document,
    localStorage: { getItem: key => saved[key] || null },
  };
  vm.runInNewContext(themeRuntime, { window });
  return { window, document, properties, meta };
}

test('every product offers the approved six-color palettes with Konfetti first', () => {
  for (const product of getPublicProducts()) {
    assert.deepEqual(product.themes.map(theme => theme.key), PALETTE_KEYS);
    assert.equal(product.themes[0].label, 'Konfetti');
    for (const [key, colors] of Object.entries(APPROVED_COLORS)) {
      const palette = product.themes.find(theme => theme.key === key);
      assert.deepEqual(palette.colors, colors);
      assert.equal(new Set(palette.colors).size, 6);
      assert.equal(palette.background.length, 4);
      assert.ok(Object.isFrozen(palette));
      assert.ok(Object.isFrozen(palette.colors));
      const assignColor = WordCloudCore.makePaletteAssigner(palette.colors);
      assert.deepEqual(WORDS.map(assignColor), colors);
      assert.deepEqual(WORDS.map(assignColor), colors, 'repeat rendering preserves assigned colors');
    }
  }
});

test('both new palette names and descriptions are translated in every catalog', () => {
  for (const locale of ['en', 'fr', 'it', 'es', 'tr']) {
    const catalog = require(`../public/locales/${locale}.json`);
    for (const palette of themes.slice(0, 2)) {
      assert.equal(catalog[palette.label], palette.label, 'palette names remain consistent');
      assert.ok(catalog[palette.description]?.trim(), `${locale}: ${palette.description}`);
    }
  }
});

test('display palette restoration preserves personal choices and falls back to Konfetti', () => {
  const available = Object.fromEntries(themes.filter(theme => theme.key !== 'custom')
    .map(theme => [theme.key, theme]));
  for (const stored of [null, 'unknown', 'custom', ...Object.keys(available)]) {
    const { window, document, properties } = themeBrowser({ 'wordcloud-palette:ours': stored });
    const expected = available[stored] ? stored : 'konfetti';
    assert.equal(window.WolkenworteTheme.restore('wordcloud-palette:ours', available, themes[0].key), expected);
    assert.equal(document.documentElement.dataset.palette, expected);
    assert.equal(properties.get('--bg'), available[expected].background[0]);
    assert.equal(window.WolkenworteTheme.restoredKey('wordcloud-palette:another-event', available, themes[0].key), 'konfetti');
  }
  const { window } = themeBrowser();
  window.localStorage.getItem = () => { throw new Error('Storage blocked'); };
  assert.equal(window.WolkenworteTheme.restoredKey('wordcloud-palette:ours', available, themes[0].key), 'konfetti');
});

test('Dopamin Pop keeps vivid word colors separate from readable interface controls', () => {
  const palette = themes.find(theme => theme.key === 'dopamin-pop');
  const { window, properties, meta } = themeBrowser();
  window.WolkenworteTheme.applyVariables(palette);
  assert.equal(properties.get('--primary'), palette.uiPrimary);
  assert.equal(properties.get('--accent'), palette.colors[4]);
  assert.equal(meta.content, palette.background[0]);
  assert.deepEqual(palette.colors, APPROVED_COLORS['dopamin-pop']);
  const channels = palette.uiPrimary.slice(1).match(/../g).map(hex => {
    const value = parseInt(hex, 16) / 255;
    return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
  });
  const luminance = channels[0] * 0.2126 + channels[1] * 0.7152 + channels[2] * 0.0722;
  assert.ok(1.05 / (luminance + 0.05) >= 4.5, 'white control labels retain at least 4.5:1 contrast');
});

test('configurator bootstrap uses the catalog default but honors existing display selections', () => {
  const source = fs.readFileSync(path.join(__dirname, '../views/configure.ejs'), 'utf8');
  const selection = source.match(/let preferredPalette = '';[\s\S]*?(?=\s*buildProductOptions\(\);)/)?.[0];
  assert.ok(selection, 'test the real configurator initialization');
  for (const stored of [null, 'unknown', 'custom', ...PALETTE_KEYS.filter(key => key !== 'custom'), 'blocked']) {
    const context = {
      localStorage: { getItem: () => {
        if (stored === 'blocked') throw new Error('Storage blocked');
        return stored;
      } },
      paletteStorageKey: 'wordcloud-palette:ours',
      product: getPublicProduct(),
      selectedTheme: null,
    };
    vm.runInNewContext(selection, context);
    const expected = PALETTE_KEYS.includes(stored) && stored !== 'custom' ? stored : 'konfetti';
    assert.equal(context.selectedTheme, expected);
  }
});

test('new palettes appear on both pages and freeze their exact colors in saved print files', async (t) => {
  const { baseUrl, close } = await startTestServer();
  t.after(close);
  const event = await createEvent(baseUrl);
  const db = require('../src/db');
  const eventRecord = await db.getEventBySlug(event.slug);
  for (const word of WORDS) await db.addWordContribution(eventRecord.id, word, 'a'.repeat(32));
  const html = await fetch(`${baseUrl}${event.eventUrl}`).then(response => response.text());
  assert.deepEqual([...html.matchAll(/data-palette-key="([^"]+)"/g)].map(match => match[1]), PALETTE_KEYS.slice(0, -1));
  assert.match(html, /id="display-palette-current"[^>]*>Konfetti<\/span>/);
  assert.match(html, /aria-checked="true"\s+data-palette-key="konfetti"/);
  assert.doesNotMatch(html, /data-palette-key="custom"/);

  const headBoot = html.match(/<script>\s*(\(function \(\) \{\s*var palettes =[\s\S]*?\}\)\(\);)\s*<\/script>/)?.[1];
  assert.ok(headBoot, 'the first-paint palette restoration is present');
  for (const stored of [null, 'pastel', 'dopamin-pop']) {
    const browser = themeBrowser({ [`wordcloud-palette:${event.slug}`]: stored });
    vm.runInNewContext(headBoot, { window: browser.window, location: { pathname: event.eventUrl } });
    assert.equal(browser.document.documentElement.dataset.palette, stored || 'konfetti');
  }

  const configuratorResponse = await fetch(`${baseUrl}/api/events/${event.slug}/configurator`);
  assert.equal(configuratorResponse.status, 200);
  const data = await configuratorResponse.json();
  assert.deepEqual(data.product.themes.map(theme => theme.key), PALETTE_KEYS);
  assert.deepEqual(data.product.themes, themes);
  for (const [theme, colors] of Object.entries(APPROVED_COLORS)) {
    const design = WORDS.map((text, index) => ({
      id: `color-${index}`, text, color: colors[index], fontFamily: 'classic',
      x: 500 + (index % 3) * 800, y: 300 + Math.floor(index / 3) * 400,
      fontSize: 60, angle: 0,
    }));
    const response = await fetch(`${baseUrl}/api/events/${event.slug}/configurations`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ productKey: DEFAULT_PRODUCT.key, theme, words: WORDS.map(word => [word, 1]), designs: { default: design } }),
    });
    const saved = await response.json();
    assert.equal(response.status, 201, JSON.stringify(saved));
    assert.equal(saved.theme, theme);
    const restored = await fetch(`${baseUrl}/api/events/${event.slug}/configurations/${saved.id}/edit`).then(res => res.json());
    assert.equal(restored.theme, theme);
    assert.deepEqual(restored.designs.default.map(word => word.color), colors);
    const print = await fetch(baseUrl + saved.printFileUrl);
    assert.equal(print.status, 200);
    const svg = await print.text();
    assert.match(svg, /data-background="transparent"/);
    assert.deepEqual([...svg.matchAll(/<text\b[^>]*fill="(#[a-f\d]{6})"/g)].map(match => match[1]), colors);
  }
});
