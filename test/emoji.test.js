'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { createCanvas, loadImage } = require('canvas');
const EmojiData = require('../public/js/emoji-data.js');
const EmojiCatalog = require('../public/js/emoji-catalog.js');
const EmojiSearch = require('../public/js/emoji-search.js');
const EmojiVirtualGrid = require('../public/js/emoji-virtual-grid.js');
const EmojiPicker = require('../public/js/emoji-picker.js');
const EmojiAssets = require('../src/emojiAssets');
const WordCloudCore = require('../public/js/wordcloud-core.js');
const { normalizeWordInput } = require('../src/words');
const { layoutForExport } = require('../src/exportSvg');
const { buildProductPrintSvg } = require('../src/mugPrint');
const { cacheControlForStaticRequest } = require('../src/httpCache');
const displaySource = fs.readFileSync(path.join(__dirname, '..', 'views', 'display.ejs'), 'utf8');
const configureSource = fs.readFileSync(path.join(__dirname, '..', 'views', 'configure.ejs'), 'utf8');
const pickerSource = fs.readFileSync(path.join(__dirname, '..', 'public', 'js', 'emoji-picker.js'), 'utf8');
const pickerCss = fs.readFileSync(path.join(__dirname, '..', 'public', 'emoji-picker.css'), 'utf8');
const emojiSearchRoot = path.join(__dirname, '..', 'public', 'emoji-search', '48.2');
const searchLocales = Object.freeze(['de', 'en', 'es', 'fr', 'it', 'tr']);
const emojiCategoryCatalog = require('../public/emoji-search/48.2/catalog.json');

test('the pinned catalog covers every bundled canonical Emoji 17 asset', () => {
  assert.equal(EmojiData.unicodeVersion, '17.0');
  assert.equal(EmojiData.artworkVersion, '2.051');
  assert.equal(Object.keys(EmojiData.canonicalAssets).length, 3944);
  for (const reference of new Set(Object.values(EmojiData.canonicalAssets))) {
    assert.ok(fs.existsSync(path.join(EmojiAssets.ASSET_ROOT, reference)), reference);
    assert.doesNotThrow(() => EmojiAssets.parseAsset(reference), reference);
  }
  for (const license of ['LICENSE', 'FLAGS-LICENSE', 'VERSION']) {
    assert.ok(fs.existsSync(path.join(EmojiAssets.ASSET_ROOT, license)), license);
  }
});

test('emoji runtimes load before every interactive renderer and artwork is immutable', () => {
  for (const view of ['display.ejs', 'configure.ejs']) {
    const source = fs.readFileSync(path.join(__dirname, '..', 'views', view), 'utf8');
    const dataIndex = source.indexOf("asset('/js/emoji-data.js')");
    const catalogIndex = source.indexOf("asset('/js/emoji-catalog.js')");
    const searchIndex = source.indexOf("asset('/js/emoji-search.js')");
    const virtualGridIndex = source.indexOf("asset('/js/emoji-virtual-grid.js')");
    const pickerIndex = source.indexOf("asset('/js/emoji-picker.js')");
    const coreIndex = source.indexOf("asset('/js/wordcloud-core.js')");
    assert.ok(dataIndex >= 0 && dataIndex < catalogIndex, view);
    assert.ok(catalogIndex < searchIndex && searchIndex < virtualGridIndex, view);
    assert.ok(virtualGridIndex < pickerIndex && pickerIndex < coreIndex, view);
    assert.match(source, /asset\('\/emoji-picker\.css'\)/, view);
  }
  assert.equal(
    cacheControlForStaticRequest({
      path: '/assets/noto-emoji/2.051/svg/emoji_u2764.svg',
      query: {},
    }),
    'public, max-age=31536000, immutable'
  );
});

test('both pages mount one shared, desktop-only, accessible emoji picker', () => {
  const trigger = displaySource.match(/<button\s+class="display-emoji-trigger"[\s\S]*?<\/button>/)?.[0] || '';
  assert.match(trigger, /type="button"/);
  assert.match(trigger, /aria-label="Emoji hinzufügen"/);
  assert.match(trigger, /<svg viewBox="0 0 32 32" aria-hidden="true">/);
  assert.match(trigger, /M24\.5 3v9M20 7\.4h9/);
  assert.doesNotMatch(trigger, />\s*😊\s*</);
  assert.match(displaySource, /\.display-emoji-trigger \{ display: none; \}/);
  assert.match(displaySource, /@media \(min-width: 621px\) and \(hover: hover\) and \(pointer: fine\) \{[\s\S]*?\.display-emoji-trigger \{ display: grid; \}/);
  assert.match(displaySource, /WolkenworteEmojiPicker\.create\(\{[\s\S]*?idPrefix: 'display-emoji'/);
  assert.match(displaySource, /value\.slice\(0, start\)\}\$\{emoji\}\$\{value\.slice\(end\)/);
  assert.match(configureSource, /id: 'editor-add'[\s\S]*?id: 'editor-emoji-toggle'[\s\S]*?id: 'editor-image'/);
  assert.match(configureSource, /\.editor-emoji-picker \{ position: relative; display: none; \}/);
  assert.match(configureSource, /WolkenworteEmojiPicker\.create\(\{[\s\S]*?idPrefix: 'editor-emoji'/);
  assert.match(configureSource, /onSelect: \(emoji\) => mugEditor\.addEmoji\(emoji\)/);
  for (const source of [displaySource, configureSource]) {
    assert.doesNotMatch(source, /function (?:render|load|remember|schedule)[A-Za-z]*Emoji/,
      'picker behavior must stay in the shared runtime');
  }
  assert.match(pickerSource, /this\.searchInput\.focus\(\{ preventScroll: true \}\)/);
  assert.match(pickerSource, /this\.virtualGrid\.windowRange/);
  assert.match(pickerSource, /image\.loading = 'lazy'/);
  assert.match(pickerSource, /SEARCH_DELAY_MS = 90/);
  assert.match(pickerSource, /includeSkinTones: true/);
  assert.match(pickerSource, /localStorage\?\.setItem\(RECENTS_KEY/);
  assert.match(pickerCss, /grid-template-columns: repeat\(10, minmax\(0, 1fr\)\)/);
  assert.match(pickerCss, /\.ww-emoji-grid \{[\s\S]*?overflow-y: auto/);
  assert.match(pickerCss, /\.ww-emoji-picker\[hidden\] \{ display: none !important; \}/);
  assert.match(pickerCss, /background: var\(--ww-emoji-bg\);/);
  assert.doesNotMatch(pickerCss, /backdrop-filter/);

  assert.equal(EmojiPicker.CATEGORIES.length, 10);
  assert.equal(EmojiPicker.FALLBACK_RECENTS.length, 24);
  assert.equal(EmojiPicker.RECENTS_KEY, 'wolkenworte:emoji-recents:v1');
  for (const value of EmojiPicker.FALLBACK_RECENTS) {
    assert.equal(EmojiCatalog.hasEmoji(value), true, value);
    assert.equal(EmojiCatalog.containsUnsupportedEmoji(value), false, value);
  }
});

test('official groups cover all emoji and virtual windows keep the DOM bounded', () => {
  assert.equal(emojiCategoryCatalog.unicodeVersion, EmojiData.unicodeVersion);
  assert.equal(emojiCategoryCatalog.count, 3944);
  assert.deepEqual(emojiCategoryCatalog.groups.map(({ key }) => key), [
    'smileys', 'people', 'nature', 'food', 'activities', 'travel', 'objects', 'symbols', 'flags',
  ]);
  const groupedKeys = emojiCategoryCatalog.groups.flatMap(({ entries }) => entries);
  assert.equal(groupedKeys.length, 3944);
  assert.equal(new Set(groupedKeys).size, 3944);
  assert.deepEqual(groupedKeys.slice().sort(), Object.keys(EmojiData.canonicalAssets).sort());
  assert.ok(emojiCategoryCatalog.groups.find(({ key }) => key === 'people').entries.length > 2000);

  for (const scrollTop of [0, 80, 4000, 10000, 19468]) {
    const range = EmojiVirtualGrid.windowRange({
      itemCount: 3944,
      scrollTop,
      viewportHeight: 252,
      columns: 8,
      rowHeight: 40,
      overscanRows: 2,
    });
    assert.ok(range.start >= 0 && range.end <= 3944);
    assert.ok(range.end - range.start <= 96,
      `virtual window at ${scrollTop}px must render at most 96 emoji`);
    assert.equal(range.totalHeight, 19720);
  }
});

test('localized CLDR search indexes cover the complete catalog and find hearts', () => {
  const expectedKeys = Object.keys(EmojiData.canonicalAssets).sort();
  const queries = {
    de: 'herz',
    en: 'heart',
    es: 'corazon',
    fr: 'coeur',
    it: 'cuore',
    tr: 'kalp',
  };

  for (const locale of searchLocales) {
    const index = JSON.parse(fs.readFileSync(path.join(emojiSearchRoot, `${locale}.json`), 'utf8'));
    assert.equal(index.cldrVersion, '48.2');
    assert.equal(index.unicodeVersion, EmojiData.unicodeVersion);
    assert.equal(index.locale, locale);
    assert.equal(index.entries.length, expectedKeys.length);
    assert.deepEqual(index.entries.map(([key]) => key).sort(), expectedKeys, locale);
    assert.ok(index.entries.every(([, name, terms, aliases]) => name && terms && typeof aliases === 'string'), locale);

    const results = EmojiSearch.search(EmojiSearch.prepare(index), queries[locale]);
    assert.ok(results.length >= 20, `${locale} should return a useful heart collection`);
    assert.ok(results.some(({ key }) => key === '2764_fe0f'), `${locale} should include red heart`);
    assert.ok(results.some(({ key }) => key === '1f494'), `${locale} should include broken heart`);
    assert.ok(results.every(({ key }) => !/(?:^|_)1f3f[b-f](?:_|$)/.test(key)),
      `${locale} should collapse skin-tone variants in broad search results`);
  }

  const germanIndex = JSON.parse(fs.readFileSync(path.join(emojiSearchRoot, 'de.json'), 'utf8'));
  const englishFallbackResults = EmojiSearch.search(EmojiSearch.prepare(germanIndex), 'heart');
  assert.ok(englishFallbackResults.slice(0, 12).some(({ key }) => key === '2764_fe0f'));
  assert.ok(englishFallbackResults.findIndex(({ key }) => key === '2764_fe0f')
    < englishFallbackResults.findIndex(({ key }) => key === '1f3e0'),
  'official English names should outrank incidental English keywords');

  const englishIndex = JSON.parse(fs.readFileSync(path.join(emojiSearchRoot, 'en.json'), 'utf8'));
  const completePeopleSearch = EmojiSearch.search(EmojiSearch.prepare(englishIndex), 'person', {
    limit: 3944,
    includeSkinTones: true,
  });
  assert.ok(completePeopleSearch.length > 320, 'virtualized search must not truncate the full catalog');

  assert.equal(EmojiSearch.normalize('cœur · Corazón'), 'coeur corazon');
  for (const filename of ['catalog.json', 'LICENSE', 'VERSION']) {
    assert.ok(fs.existsSync(path.join(emojiSearchRoot, filename)), filename);
  }
});

test('mixed text canonicalizes normal keyboard emoji without splitting joined sequences', () => {
  const value = 'Liebe ❤ · Familie 👨‍👩‍👧‍👦 · 👍🏽 · 🇩🇪 · 1️⃣';
  const canonical = EmojiCatalog.canonicalizeText(value);
  assert.equal(canonical, 'Liebe ❤️ · Familie 👨‍👩‍👧‍👦 · 👍🏽 · 🇩🇪 · 1️⃣');
  assert.deepEqual(
    EmojiCatalog.parse(canonical).filter((run) => run.type === 'emoji').map((run) => run.text),
    ['❤️', '👨‍👩‍👧‍👦', '👍🏽', '🇩🇪', '1️⃣']
  );
  assert.equal(EmojiCatalog.graphemeLength('👨‍👩‍👧‍👦'), 1);
  assert.equal(EmojiCatalog.containsUnsupportedEmoji('😀‍😀'), true);
});

test('guest normalization keeps supported emoji and applies the limit by grapheme', () => {
  assert.deepEqual(normalizeWordInput('  LIEBE ❤  ', 'de'), {
    word: 'liebe ❤️',
    error: null,
  });
  const family = '👨‍👩‍👧‍👦';
  assert.equal(normalizeWordInput(family.repeat(31)).word, family.repeat(30));
  assert.deepEqual(normalizeWordInput('😀‍😀'), {
    word: '',
    error: 'unsupported_emoji',
  });
});

test('word-cloud export inlines pinned emoji paths instead of native emoji text', async () => {
  const canvas = createCanvas(10, 10);
  const ctx = canvas.getContext('2d');
  const box = WordCloudCore.measureTextBox('ja ❤️', 100, ctx);
  assert.equal(box.runs.filter((run) => run.type === 'emoji').length, 1);
  assert.equal(box.runs.find((run) => run.type === 'emoji').width, 100);

  const svg = layoutForExport([['ja ❤️', 2], ['familie 👨‍👩‍👧‍👦', 1]], 'pastel', 1000);
  assert.match(svg, /data-emoji="2764_fe0f"/);
  assert.match(svg, /data-emoji="1f468_200d_1f469_200d_1f467_200d_1f466"/);
  assert.doesNotMatch(svg, /href="\/assets\/noto-emoji/);
  assert.doesNotMatch(svg, /❤️|👨‍👩‍👧‍👦/);
  const image = await loadImage(Buffer.from(svg));
  assert.equal(image.width, 1000);
  assert.equal(image.height, 1000);
});

test('product print SVG embeds the same artwork for emoji, modifiers and flags', async () => {
  const svg = buildProductPrintSvg(
    { printFile: { width: 2000, height: 1000 }, designSafeMargin: 24 },
    [{
      id: 'wort-emoji',
      type: 'text',
      text: 'für immer 👍🏽 🇩🇪',
      x: 1000,
      y: 500,
      fontSize: 110,
      angle: 8,
      color: '#9c1c4c',
      fontFamily: 'classic',
    }]
  );
  assert.match(svg, /data-emoji="1f44d_1f3fd"/);
  assert.match(svg, /data-emoji="1f1e9_1f1ea"/);
  assert.doesNotMatch(svg, /href="\/assets\/noto-emoji|👍🏽|🇩🇪/);
  const image = await loadImage(Buffer.from(svg));
  assert.equal(image.width, 2000);
  assert.equal(image.height, 1000);
});
