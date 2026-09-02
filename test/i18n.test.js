'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const ejs = require('ejs');
const { startTestServer, createEvent } = require('./helpers');
const I18n = require('../src/i18n');
const PageRenderer = require('../src/pageRenderer');
const { localizeHtml } = require('../src/htmlLocalizer');
const { publicAssetUrl } = require('../src/publicAssets');
const { normalizeWord } = require('../src/words');

const LOCALES = ['de', 'en', 'fr', 'it', 'es', 'tr'];
const CATALOG_LOCALES = LOCALES.filter((locale) => locale !== 'de');
const PUBLIC_PAGES = [
  'landing.ejs',
  'display.ejs',
  'configure.ejs',
  'shipping.ejs',
  'order-confirmation.ejs',
  '404.ejs',
  'impressum.ejs',
  'datenschutz.ejs',
];
const VIEW_ROOT = path.join(__dirname, '..', 'views');
const TEST_LANGUAGES = I18n.SUPPORTED_LOCALES.map((code) => ({
  code,
  name: PageRenderer.LANGUAGE_NAMES[code],
  flag: PageRenderer.LANGUAGE_FLAGS[code],
  href: `/?lang=${code}`,
}));
const TEST_LOCALE_CATALOG_URLS = Object.fromEntries(CATALOG_LOCALES.map((locale) => [
  locale,
  publicAssetUrl(`/locales/${locale}.json`),
]));

function viewSource(filename) {
  return fs.readFileSync(path.join(VIEW_ROOT, filename), 'utf8');
}

function renderView(filename, header = {}, locale = 'de') {
  const fullPath = path.join(VIEW_ROOT, filename);
  return ejs.render(fs.readFileSync(fullPath, 'utf8'), {
    locale,
    localeSource: 'default',
    header,
    pageData: {
      eventUrl: 'https://example.test/e/wortwolke-test',
      qrSvg: '<svg viewBox="0 0 1 1"><path d="M0 0h1v1H0z" /></svg>',
      cloudTitle: 'Lea & Max',
      paletteOptions: [],
    },
    languages: TEST_LANGUAGES,
    asset: publicAssetUrl,
    localeCatalogUrls: TEST_LOCALE_CATALOG_URLS,
    localeCatalogUrl: locale === 'de' ? '' : publicAssetUrl(`/locales/${locale}.json`),
    t: (source) => source,
  }, { filename: fullPath });
}
const REQUIRED_MESSAGES = [
  'Wortwolke starten',
  'Erinnerung gestalten',
  'Andenken',
  'Ein Wort eingeben',
  'Gib dein Wort hier ein…',
  'Emoji hinzufügen',
  'Emoji hinzugefügt',
  'Emoji auswählen',
  'Emojis suchen',
  'Suche löschen',
  'Suchergebnisse',
  'Keine Emojis gefunden.',
  '{{count}} Emojis gefunden',
  'Menschen',
  'Tiere & Natur',
  'Essen & Trinken',
  'Aktivitäten',
  'Reisen & Orte',
  'Objekte',
  'Symbole',
  'Flaggen',
  'Emoji-Katalog wird geladen…',
  'Emoji-Katalog konnte nicht geladen werden.',
  'Deine Wörter',
  'Organisatorbereich',
  'Wortwolke verwalten',
  'Organisatorbereich schließen',
  'Eine Eingabe von „{{word}}“ entfernen',
  'Einstellungen',
  'Präsentationsmodus',
  'Speichern',
  'Scannen & mitmachen',
  'Wie soll eure Wortwolke heißen?',
  'Wortwolke erstellen',
  'Link kopieren',
  'Per WhatsApp teilen',
  '{{name}} – Wolkenworte',
  'Ihr seid eingeladen, die Wortwolke „{{name}}“ mitzugestalten. Fügt ein Wort hinzu und erlebt live, wie sie gemeinsam wächst.',
  'Live-Wortwolke',
  'Wortwolke zurücksetzen?',
  'Nach dem Ändern wird der Organisatorbereich wieder gesperrt. Es gibt keine „PIN vergessen“-Funktion.',
  'Eure Worte. Eure Erinnerung.',
  '{{count}} Elemente ausgewählt',
  'Wählt, wie viele Produkte an welche Adresse gehen sollen. Für eine einzelne Lieferung bleibt einfach diese eine Adresse stehen.',
  '{{count}} Lieferadressen',
  'Eure Zahlung wurde bestätigt und eure Bestellung ist bei uns eingegangen.',
  'Diese Wortwolke gibt es nicht.',
  'Neues Wort hinzugefügt',
  'und',
  'Die gewählte Sprache wird in einem funktionalen Cookie gespeichert. Die persönliche Farbpalette der Wortwolke, zuletzt verwendete Emojis und Entwürfe im Warenkorb werden lokal gespeichert, damit sie bei weiteren Seitenaufrufen beziehungsweise beim Wechsel zwischen Wortwolke, Konfiguration und Lieferadresse erhalten bleiben. Die Organisator-PIN wird nicht im Browser gespeichert.',
];

function placeholders(value) {
  return [...String(value).matchAll(/\{\{\s*([\w.-]+)\s*\}\}/g)]
    .map((match) => match[1])
    .sort();
}

test('locale catalogs cover the complete user journey and preserve interpolation variables', () => {
  assert.deepEqual(I18n.SUPPORTED_LOCALES, LOCALES);
  const english = require('../public/locales/en.json');
  const englishKeys = Object.keys(english).sort();

  for (const locale of CATALOG_LOCALES) {
    const catalog = require(`../public/locales/${locale}.json`);
    assert.deepEqual(Object.keys(catalog).sort(), englishKeys,
      `${locale} must cover the complete English fallback catalog`);
    for (const source of REQUIRED_MESSAGES) {
      assert.equal(typeof catalog[source], 'string', `${locale} is missing: ${source}`);
      assert.ok(catalog[source].trim(), `${locale} has an empty translation: ${source}`);
      assert.deepEqual(placeholders(catalog[source]), placeholders(source),
        `${locale} changed interpolation variables for: ${source}`);
    }
    for (const [source, translation] of Object.entries(catalog)) {
      assert.deepEqual(placeholders(translation), placeholders(source),
        `${locale} changed interpolation variables for: ${source}`);
      assert.equal(typeof english[source], 'string', `${locale} contains a key absent from the English fallback`);
    }
  }

  assert.equal(I18n.translate('Wolkenworte', 'tr'), 'Wolkenworte');
  assert.equal(I18n.translate('Organisatorbereich', 'en'), 'Organizer controls');
  assert.equal(I18n.translate('Wortwolke verwalten', 'en'), 'Manage word cloud');
  assert.equal(I18n.translate('{{count}} Elemente ausgewählt', 'fr', { count: 3 }), '3 éléments sélectionnés');
});

test('every public page loads the shared language layer', () => {
  for (const filename of PUBLIC_PAGES) {
    const source = viewSource(filename);
    assert.match(source, /asset\('\/i18n\.css'\)/, filename);
    assert.match(source, /asset\('\/site-fonts\.css'\)/, filename);
    assert.match(source, /asset\('\/js\/i18n\.js'\)/, filename);
    assert.match(source, /asset\('\/site-header\.css'\)/, filename);
    assert.match(source, /include\('partials\/site-header'\)/,
      `${filename} needs the shared server-rendered site header`);
    const header = filename === 'landing.ejs'
      ? { variant: 'landing' }
      : filename === 'display.ejs' ? { variant: 'display' } : {};
    const rendered = renderView(filename, header);
    assert.ok(rendered.includes(publicAssetUrl('/i18n.css')), filename);
    assert.ok(rendered.includes(publicAssetUrl('/site-fonts.css')), filename);
    assert.ok(rendered.includes(publicAssetUrl('/js/i18n.js')), filename);
    assert.ok(rendered.includes(publicAssetUrl('/site-header.css')), filename);
    assert.match(rendered, /<header\b[^>]*\bww-site-header\b/, filename);
    assert.equal((rendered.match(/data-language-picker/g) || []).length, 1, filename);
    assert.match(rendered, /<summary\s+class="ww-language-trigger"\s+data-language-trigger/, filename);
    assert.match(rendered, /<nav class="ww-language-menu" data-language-menu/, filename);
    if (filename === 'display.ejs') {
      assert.match(rendered, /<details class="ww-display-menu" id="display-page-menu">/, filename);
      assert.match(rendered, /<details class="ww-language-picker ww-display-menu-language" data-language-picker/, filename);
    } else if (filename === 'landing.ejs') {
      assert.match(rendered, /<details class="ww-language-picker landing-menu-language" data-language-picker/, filename);
    } else {
      assert.match(rendered, /<details class="ww-language-picker ww-language-inline" data-language-picker/, filename);
    }
  }

  const displayPage = viewSource('display.ejs');
  assert.match(displayPage, /id="cloud-title" data-i18n-ignore/);
});

test('customer-facing actions stay calm and do not expose staging or provider narration', () => {
  const shipping = viewSource('shipping.ejs');
  const confirmation = viewSource('order-confirmation.ejs');
  const display = viewSource('display.ejs');

  assert.match(shipping, />Weiter zur Zahlung <span/);
  assert.doesNotMatch(shipping, /Weiter zur Testzahlung|Preis wird noch einmal geprüft|Der Preis ist kurzzeitig reserviert/);
  assert.doesNotMatch(confirmation, /Stripe-Testmodus|Testzahlung erfolgreich|Dies war eine Testzahlung/);
  assert.doesNotMatch(display, /(?:^|[^\w$.])(?:window\.)?(?:confirm|prompt|alert)\s*\(/m);
  assert.match(display, /<dialog class="reset-dialog ww-mobile-dialog" id="reset-dialog"/);
  assert.match(display, /<button class="reset-dialog-button" id="reset-cancel" type="button">Abbrechen<\/button>/);

  for (const filename of ['configure.ejs', 'shipping.ejs', 'display.ejs']) {
    const page = renderView(filename, filename === 'display.ejs' ? { variant: 'display' } : {});
    assert.ok(page.includes(publicAssetUrl('/action-state.css')), filename);
    assert.ok(page.includes(publicAssetUrl('/js/action-state.js')), filename);
  }

  const actionStyles = fs.readFileSync(path.join(__dirname, '..', 'public', 'action-state.css'), 'utf8');
  const actionRuntime = fs.readFileSync(path.join(__dirname, '..', 'public', 'js', 'action-state.js'), 'utf8');
  assert.match(actionStyles, /prefers-reduced-motion/);
  assert.match(actionStyles, /prefers-reduced-motion[\s\S]*animation:\s*none/);
  assert.match(actionRuntime, /aria-busy/);
});

test('interface fonts are locally served, pinned and licensed', () => {
  const publicRoot = path.join(__dirname, '..', 'public');
  const textFiles = [];
  const visit = (directory) => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const absolute = path.join(directory, entry.name);
      if (entry.isDirectory()) visit(absolute);
      else if (/\.(?:css|ejs|html|js)$/.test(entry.name)) textFiles.push(absolute);
    }
  };
  visit(publicRoot);
  visit(VIEW_ROOT);

  for (const filename of textFiles) {
    const content = fs.readFileSync(filename, 'utf8');
    assert.doesNotMatch(content, /fonts\.(?:googleapis|gstatic)\.com/i,
      `${path.relative(publicRoot, filename)} must not load fonts from a third party`);
  }

  const styles = fs.readFileSync(path.join(publicRoot, 'site-fonts.css'), 'utf8');
  for (const family of ['jost', 'playfair-display', 'cormorant-garamond']) {
    assert.match(styles, new RegExp(`/assets/site-fonts/${family}/`));
    assert.ok(fs.statSync(path.join(publicRoot, 'assets', 'site-fonts', family, 'OFL.txt')).size > 0,
      `${family} must retain its OFL license`);
  }

  const englishLanding = renderView('landing.ejs', { variant: 'landing' }, 'en');
  const turkishLanding = renderView('landing.ejs', { variant: 'landing' }, 'tr');
  const basePreload = publicAssetUrl('/assets/site-fonts/jost/jost-latin.woff2');
  const extendedPreload = publicAssetUrl('/assets/site-fonts/jost/jost-latin-ext.woff2');
  const playfairPreload = publicAssetUrl('/assets/site-fonts/playfair-display/playfair-display-latin.woff2');
  const playfairExtendedPreload = publicAssetUrl('/assets/site-fonts/playfair-display/playfair-display-latin-ext.woff2');

  for (const filename of PUBLIC_PAGES) {
    const header = filename === 'landing.ejs'
      ? { variant: 'landing' }
      : filename === 'display.ejs' ? { variant: 'display' } : {};
    const englishPage = renderView(filename, header, 'en');
    assert.ok(englishPage.includes(basePreload), `${filename} must preload its primary Jost subset`);
    assert.ok(englishPage.includes(playfairPreload), `${filename} must preload its heading font`);
  }
  assert.ok(!englishLanding.includes(extendedPreload),
    'non-Turkish pages must not preload an unused extended subset');
  assert.ok(turkishLanding.includes(basePreload));
  assert.ok(turkishLanding.includes(extendedPreload),
    'Turkish needs the extended Jost glyph subset before first paint');
  assert.ok(turkishLanding.includes(playfairExtendedPreload),
    'Turkish headings need the extended Playfair subset before first paint');
  assert.match(styles, /font-family:\s*"Wolkenworte Jost Fallback"[\s\S]*?size-adjust:/);
  assert.match(styles, /font-family:\s*"Wolkenworte Playfair Fallback"[\s\S]*?size-adjust:/);
});

test('server localization produces the selected language before browser scripts run', () => {
  const cases = [
    ['landing.ejs', { variant: 'landing' }, 'Collect wishes &amp; memories'],
    ['display.ejs', { variant: 'display' }, 'Waiting for your words…'],
    ['configure.ejs', {}, 'Preparing your word cloud…'],
    ['shipping.ejs', {}, 'Loading your design…'],
    ['order-confirmation.ejs', {}, 'Confirming payment'],
    ['404.ejs', {}, 'This word cloud does not exist.'],
    ['impressum.ejs', {}, 'Legal information'],
    ['datenschutz.ejs', {}, 'Privacy policy'],
  ];
  for (const [filename, header, expected] of cases) {
    const localized = localizeHtml(renderView(filename, header, 'en'), 'en');
    assert.ok(localized.includes(expected), `${filename} must contain English in the HTTP response`);
    assert.match(localized, /data-locale-catalog-url="\/locales\/en\.json\?v=/, filename);
  }

  const ignored = localizeHtml(
    '<!doctype html><html><body><p>Wir warten auf eure Wörter…</p><code data-i18n-ignore>Wir warten auf eure Wörter…</code></body></html>',
    'en'
  );
  assert.match(ignored, /<p data-i18n-source="Wir warten auf eure Wörter…">Waiting for your words…<\/p>/);
  assert.match(ignored, /<code data-i18n-ignore="">Wir warten auf eure Wörter…<\/code>/);

  const germanBindings = localizeHtml(
    '<!doctype html><html><body><p>Wir warten auf eure Wörter…</p><input placeholder="Gib dein Wort hier ein…"></body></html>',
    'de'
  );
  assert.match(germanBindings, /<p data-i18n-source="Wir warten auf eure Wörter…">Wir warten auf eure Wörter…<\/p>/,
    'the default-language response must retain stable sources for an in-place switch');
  assert.match(germanBindings, /data-i18n-placeholder-source="Gib dein Wort hier ein…"/);

  const nested = localizeHtml(
    '<!doctype html><html><body><button>Hier starten <span aria-hidden="true">→</span></button></body></html>',
    'en'
  );
  assert.match(nested, /data-i18n-text-sources="\{&quot;0&quot;:&quot;Hier starten&quot;\}"/,
    'mixed-content controls need a source binding without adding layout-changing wrapper elements');
  assert.match(nested, />Start here <span aria-hidden="true">→<\/span><\/button>/);
});

test('legal pages describe the hosted product and enforced retention', () => {
  const privacy = viewSource('datenschutz.ejs');
  const legalNotice = viewSource('impressum.ejs');

  assert.match(privacy, /Fly\.io, Inc\.[\s\S]*Frankfurt am Main/);
  assert.match(privacy, /Supabase, Inc\.[\s\S]*privaten Objektspeicher/);
  assert.match(privacy, /Plus Five Five, Inc\.[\s\S]*Öffnungs- und Klicktracking ist deaktiviert/);
  assert.match(privacy, /automatisch 365 Tage nach Erstellung/);
  assert.doesNotMatch(privacy, /ausschließlich lokal entwickelt|Google Fonts|künftige Hosting-Anbieter|künftigen Hosting-Anbieter/);
  assert.match(legalNotice, /interaktive Wortwolken[\s\S]*personalisierte Druckprodukte/);
});

test('the event page keeps its content below a dedicated branded header', () => {
  const displayPage = renderView('display.ejs', { variant: 'display' });

  assert.match(displayPage, /<header class="site-header ww-site-header">[\s\S]*?<div class="ww-nav ww-language-mounted">[\s\S]*?ww-brand-wordmark[\s\S]*?<\/header>/);

  assert.match(displayPage, /class="ww-display-header-actions"[\s\S]*?id="memory-cta"[\s\S]*?id="display-page-menu"/);
  assert.doesNotMatch(displayPage, /cloud-status/);
  assert.match(displayPage, /<footer class="footer">[\s\S]*?class="footer-event-name" id="cloud-title" data-i18n-ignore/);
  assert.doesNotMatch(displayPage, /id="qr-url"/,
    'the footer must not expose the raw event URL as visible copy');
  assert.match(displayPage, /class="line2">QR-Code scannen</);
  assert.match(displayPage, /id="display-page-menu"[\s\S]*?id="display-own-words-button"[\s\S]*?id="draft-settings-button"[\s\S]*?id="presentation-mode-button"/);
  assert.doesNotMatch(displayPage, /display-meta/,
    'the display must not add a second header-like metadata bar');
  assert.doesNotMatch(displayPage, /<header class="header">/);
});

test('shared site header is transparent at rest and becomes glassy only after scrolling', () => {
  const styles = fs.readFileSync(path.join(__dirname, '..', 'public', 'site-header.css'), 'utf8');
  const runtime = fs.readFileSync(path.join(__dirname, '..', 'public', 'js', 'site-header.js'), 'utf8');

  assert.match(styles, /\.ww-site-header\s*\{[^}]*background:\s*transparent\s*!important/s);
  assert.match(styles, /\.ww-site-header\.scrolled\s*\{[^}]*background:/s);
  assert.match(styles, /\.ww-site-header\.scrolled\s*\{[^}]*backdrop-filter:\s*blur\(14px\)/s);
  assert.match(runtime, /window\.scrollY\s*>\s*4/);
  assert.match(runtime, /classList\.toggle\('scrolled', scrolled\)/);
});

test('shared header pins the brand left and language switcher right at every viewport size', () => {
  const styles = fs.readFileSync(path.join(__dirname, '..', 'public', 'site-header.css'), 'utf8');
  const runtime = fs.readFileSync(path.join(__dirname, '..', 'public', 'js', 'i18n.js'), 'utf8');
  const headerPartial = fs.readFileSync(path.join(VIEW_ROOT, 'partials', 'site-header.ejs'), 'utf8');
  const pickerPartial = fs.readFileSync(path.join(VIEW_ROOT, 'partials', 'language-picker.ejs'), 'utf8');

  assert.match(styles, /\.ww-nav\s*\{[^}]*width:\s*100%\s*!important[^}]*padding:\s*0 40px\s*!important/s);
  assert.match(styles, /\.ww-brand\s*\{[^}]*margin-right:\s*auto/s);
  assert.doesNotMatch(styles, /\.ww-nav::after/,
    'the final language control is server-rendered, so an empty placeholder must not return');
  assert.match(styles, /\.ww-site-header \.ww-language-inline\s*\{[^}]*margin-left:\s*auto/s);
  assert.match(styles, /@media \(max-width:\s*620px\)[\s\S]*?\.ww-nav\s*\{[^}]*padding:\s*0 16px\s*!important/s);
  assert.equal((headerPartial.match(/include\('language-picker'/g) || []).length, 3);
  assert.doesNotMatch(headerPartial, /<details class="ww-language-picker/);
  assert.match(pickerPartial, /<details class="ww-language-picker/);
  assert.match(pickerPartial, /<summary[\s\S]*?data-language-trigger/);
  assert.doesNotMatch(runtime, /createElement\(/,
    'the header and language control must exist in the server response');
});

test('shared wordmark uses font-independent, mask-free vector rendering', () => {
  const publicRoot = path.join(__dirname, '..', 'public');
  const styles = fs.readFileSync(path.join(publicRoot, 'site-header.css'), 'utf8');
  const icon = fs.readFileSync(path.join(publicRoot, 'z_icons', 'icon.svg'), 'utf8');
  const wordmark = fs.readFileSync(path.join(VIEW_ROOT, 'partials', 'brand-wordmark.ejs'), 'utf8');

  assert.match(styles, /\.ww-brand-wordmark\s*\{[^}]*height:\s*\.81em/s);
  assert.doesNotMatch(styles, /\.ww-brand\s*\{[^}]*font-family/s);
  assert.doesNotMatch(icon, /<mask\b|\bmask=/i);
  assert.match(icon, /fill-rule="evenodd"/);
  assert.match(wordmark, /<svg[\s\S]*?<path\b/);
  assert.match(wordmark, /fill="currentColor"/);
  assert.doesNotMatch(wordmark, /<text\b|font-family/i);
});

test('language switcher is server-rendered, progressively enhanced and uses Unicode flags', () => {
  const browserI18n = require('../public/js/i18n.js');
  const runtime = fs.readFileSync(path.join(__dirname, '..', 'public', 'js', 'i18n.js'), 'utf8');
  const styles = fs.readFileSync(path.join(__dirname, '..', 'public', 'i18n.css'), 'utf8');
  const partial = fs.readFileSync(path.join(VIEW_ROOT, 'partials', 'language-picker.ejs'), 'utf8');

  assert.deepEqual(browserI18n.LANGUAGE_FLAGS, {
    de: '🇩🇪',
    en: '🇺🇸',
    fr: '🇫🇷',
    it: '🇮🇹',
    es: '🇪🇸',
    tr: '🇹🇷',
  });
  assert.match(partial, /<details class="ww-language-picker/);
  assert.match(partial, /data-language-picker/);
  assert.match(partial, /<nav class="ww-language-menu" data-language-menu/);
  assert.match(partial, /<a[\s\S]*?data-language-code=/);
  assert.match(partial, /hreflang="<%= language\.code %>"/);
  assert.match(styles, /\.ww-language-menu\s*\{/);
  assert.match(styles, /\.ww-language-trigger\s*\{[^}]*width:\s*126px/s,
    'translated language names must not resize the header control');
  assert.match(styles, /\.ww-language-option\.is-selected/);
  assert.match(styles, /\.ww-language-picker\[open\] \.ww-language-trigger/);
  assert.match(runtime, /querySelectorAll\('\[data-language-picker\]'\)/);
  assert.match(runtime, /stackingHost\?\.classList\.toggle\('ww-language-host-open', hasOpenPicker\)/);
  assert.match(styles, /\.ww-language-host-open\s*\{[^}]*z-index:\s*10001\s*!important/s);
  assert.match(runtime, /option\.addEventListener\('click', async \(event\) =>/);
  assert.match(runtime, /event\.preventDefault\(\)[\s\S]{0,400}await setLocale\(nextLocale, \{ persist: true, source: 'stored' \}\)/,
    'an ordinary language selection must update the existing document in place');
  assert.match(runtime, /history\?\.replaceState/,
    'the selected language must remain reloadable and shareable without navigating now');
  assert.doesNotMatch(runtime, /location\.assign|location\.replace|location\.reload/,
    'language changes must not rebuild the page or restart media');
  assert.doesNotMatch(runtime, /MutationObserver/,
    'the language layer must not rewrite arbitrary page text after paint');
  assert.doesNotMatch(runtime, /localStorage\?\.(?:getItem|setItem)/,
    'the client and server must not compete over duplicate language preferences');
  assert.match(runtime, /`\/locales\/\$\{encodeURIComponent\(nextLocale\)\}\.json`/);
  assert.match(runtime, /dataset\?\.localeCatalogUrls/,
    'every in-place target must use the exact fingerprinted catalog published by the server render');
  assert.match(runtime, /cache:\s*renderedUrl \? 'force-cache' : 'no-cache'/,
    'fingerprinted catalogs should reuse the browser cache without risking mixed deployment versions');
  assert.match(runtime, /data-i18n-text-sources/,
    'mixed-content controls must translate from explicit server-provided sources');
  assert.match(runtime, /function setText\(element, source, params = \{\}\)/,
    'dynamic UI must retain an explicit translation source');
});

test('language switcher visuals have one owner and cannot inherit page-specific link skins', () => {
  const header = fs.readFileSync(path.join(VIEW_ROOT, 'partials', 'site-header.ejs'), 'utf8');
  const picker = fs.readFileSync(path.join(VIEW_ROOT, 'partials', 'language-picker.ejs'), 'utf8');
  const landing = viewSource('landing.ejs');
  const display = viewSource('display.ejs');
  const languageStyles = fs.readFileSync(path.join(__dirname, '..', 'public', 'i18n.css'), 'utf8');
  const headerStyles = fs.readFileSync(path.join(__dirname, '..', 'public', 'site-header.css'), 'utf8');

  assert.equal((header.match(/include\('language-picker'/g) || []).length, 3);
  assert.equal((picker.match(/<details class="ww-language-picker/g) || []).length, 1);
  assert.match(landing, /\.landing-section-link::after/);
  assert.doesNotMatch(landing, /\.landing-section-links a(?::|\s|\{)/);
  assert.doesNotMatch(display, /\.ww-display-menu\s+\.ww-language-option/);
  assert.match(headerStyles, /\.ww-site-header a:not\(\.ww-language-option\):focus-visible/);
  assert.match(languageStyles, /\.ww-language-option:hover,[\s\S]*?background:\s*#fbf2e7/);
  assert.match(languageStyles, /\.ww-language-option\.is-selected\s*\{[\s\S]*?color:\s*#8c1945/);
});

test('shipping rerenders derived UI from stable sources whenever the locale changes', () => {
  const shipping = viewSource('shipping.ejs');
  assert.match(shipping, /WolkenworteI18n\.setText\(element, source, params\)/);
  assert.match(shipping, /window\.addEventListener\('wolkenworte:localechange', refreshLocalizedShipping\)/);
  assert.match(shipping, /showQuote\(currentQuote, \{ scroll: false, resetAction: false \}\)/);
  assert.match(shipping, /locale:\s*WolkenworteI18n\.getLocale\(\)/);
  assert.doesNotMatch(shipping, /customerErrorMessage/,
    'errors must keep their source key instead of freezing an already translated string');

  for (const locale of CATALOG_LOCALES) {
    const catalog = require(`../public/locales/${locale}.json`);
    for (const source of [
      'Preis aktualisieren',
      'Weiter zur Zahlung',
      'Mehr zur Verarbeitung eurer Lieferdaten im',
      'Zahlung abgebrochen. Eure Angaben sind weiterhin gespeichert.',
    ]) {
      assert.ok(catalog[source], `${locale} is missing shipping copy: ${source}`);
    }
  }
});

test('language URLs preserve page state and server locale resolution honors explicit preference', () => {
  const browserI18n = require('../public/js/i18n.js');
  assert.equal(
    browserI18n.languageUrl('https://example.test/e/wortwolke-x7k2q?source=qr#cloud', 'fr'),
    'https://example.test/e/wortwolke-x7k2q?source=qr&lang=fr#cloud'
  );
  assert.deepEqual(PageRenderer.resolvePageLocale({
    query: { lang: 'tr-TR' },
    headers: { cookie: 'wolkenworte-language=fr', 'accept-language': 'en-US,en;q=0.8' },
  }, 'de'), { locale: 'tr', source: 'query' });
  assert.deepEqual(PageRenderer.resolvePageLocale({
    query: {},
    headers: { cookie: 'wolkenworte-language=fr', 'accept-language': 'en-US,en;q=0.8' },
  }, 'de'), { locale: 'fr', source: 'cookie' });
  assert.equal(PageRenderer.preferredRequestLocale('fr;q=0, en-US;q=0.8, de;q=0.5'), 'en');
});

test('event locale is validated, persisted and returned by public APIs', async (t) => {
  const { baseUrl, close } = await startTestServer();
  t.after(close);

  const frenchLanding = await fetch(`${baseUrl}/?lang=fr`);
  assert.equal(frenchLanding.status, 200);
  assert.match(frenchLanding.headers.get('set-cookie') || '', /wolkenworte-language=fr/);
  const frenchLandingHtml = await frenchLanding.text();
  assert.match(frenchLandingHtml, /<html lang="fr"(?:\s|>)/);
  assert.match(frenchLandingHtml, /Wolkenworte – Vos souvenirs en un mot/);
  assert.match(frenchLandingHtml, /Commencer ici/);
  assert.match(frenchLandingHtml, /ww-language-current-name">Français/);

  const rememberedStart = await fetch(`${baseUrl}/start`, {
    method: 'POST',
    headers: { Cookie: 'wolkenworte-language=fr' },
    body: new URLSearchParams({
      cloudName: 'Nuage des amis', organizerPin: '4567', organizerPinConfirmation: '4567',
    }),
    redirect: 'manual',
  });
  assert.equal(rememberedStart.status, 303);
  const rememberedStartLocation = rememberedStart.headers.get('location') || '';
  const rememberedEventMatch = /^\/e\/([^/]+)$/.exec(rememberedStartLocation);
  assert.ok(rememberedEventMatch, `unexpected display location: ${rememberedStartLocation}`);
  const rememberedEventInfo = await fetch(
    `${baseUrl}/api/events/${rememberedEventMatch[1]}`
  ).then((response) => response.json());
  assert.equal(rememberedEventInfo.locale, 'fr');
  assert.equal(rememberedEventInfo.title, 'Nuage des amis');
  const rememberedDisplay = await fetch(`${baseUrl}${rememberedStartLocation}`, {
    headers: { Cookie: 'wolkenworte-language=fr' },
  });
  assert.equal(rememberedDisplay.status, 200);
  const rememberedDisplayHtml = await rememberedDisplay.text();
  assert.match(rememberedDisplayHtml, /<html lang="fr"/);
  assert.match(rememberedDisplayHtml, /ww-language-current-name">Français/);

  const event = await createEvent(baseUrl, {
    title: 'İpek & Işık',
    slug: 'ipek-isik',
    locale: 'tr-TR',
  });
  assert.equal(event.locale, 'tr');

  const turkishGuest = await fetch(`${baseUrl}/e/${event.slug}`);
  assert.equal(turkishGuest.status, 200);
  const turkishGuestHtml = await turkishGuest.text();
  assert.match(turkishGuestHtml, /<html lang="tr"/);
  assert.match(turkishGuestHtml, /ww-language-current-name">Türkçe/);

  const info = await fetch(`${baseUrl}/api/events/${event.slug}`).then((response) => response.json());
  assert.equal(info.locale, 'tr');

  const invalid = await fetch(`${baseUrl}/api/events`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ title: 'Invalid Locale', pin: '1234', locale: 'xx' }),
  });
  assert.equal(invalid.status, 400);
  assert.deepEqual(await invalid.json(), { error: 'invalid_locale' });

  const germanDefault = await createEvent(baseUrl, { title: 'Deutsch bleibt Standard' });
  assert.equal(germanDefault.locale, 'de');
});

test('word normalization uses the event locale without altering user content beyond normalization', () => {
  assert.equal(normalizeWord('  İYİ  ', 'tr'), 'iyi');
  assert.equal(normalizeWord('IŞIK', 'tr'), 'ışık');
  assert.equal(normalizeWord('IŞIK', 'de'), 'işik');
  assert.equal(normalizeWord('ÉTÉ', 'fr'), 'été');
});
