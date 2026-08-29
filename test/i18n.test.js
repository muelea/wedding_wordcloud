'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { startTestServer, createEvent } = require('./helpers');
const I18n = require('../src/i18n');
const { normalizeWord } = require('../src/words');

const LOCALES = ['de', 'en', 'fr', 'it', 'es', 'tr'];
const CATALOG_LOCALES = LOCALES.filter((locale) => locale !== 'de');
const PUBLIC_PAGES = [
  'landing.html',
  'create.html',
  'guest.html',
  'display.html',
  'configure.html',
  'shipping.html',
  'order-confirmation.html',
  '404.html',
  'impressum.html',
  'datenschutz.html',
];
const REQUIRED_MESSAGES = [
  'Wortwolke starten',
  'Teilt ein Wort für das Brautpaar.',
  '{{count}} Wörter live geteilt',
  'Admin-PIN eingeben, um die Wortwolke zurückzusetzen:',
  'Eure Worte. Eure Erinnerung.',
  '{{count}} Elemente ausgewählt',
  'Wählt, wie viele Produkte an welche Adresse gehen sollen. Für eine einzelne Lieferung bleibt einfach diese eine Adresse stehen.',
  '{{count}} Lieferadressen',
  'Stripe hat die Zahlung bestätigt und wir haben die Bestellung sicher gespeichert.',
  'Diese Wortwolke gibt es nicht.',
  'und',
  'Zusätzlich werden rein funktionale Kennzeichnungen im Session Storage gespeichert, damit das erstellende Gerät den einmaligen Einrichtungs-Hinweis anzeigen kann. Die gewählte Sprache und Entwürfe im Warenkorb werden lokal gespeichert, damit sie bei weiteren Seitenaufrufen beziehungsweise beim Wechsel zwischen Konfiguration und Lieferadresse erhalten bleiben. Der Admin-PIN und ein Admin-Token werden nicht im Browser gespeichert.',
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
  assert.equal(I18n.translate('{{count}} Wörter live', 'fr', { count: 3 }), '3 mots en direct');
});

test('every public page loads the shared language layer', () => {
  for (const filename of PUBLIC_PAGES) {
    const html = fs.readFileSync(path.join(__dirname, '..', 'public', filename), 'utf8');
    assert.match(html, /<link rel="stylesheet" href="\/i18n\.css\?v=20260826-5" \/>/, filename);
    assert.match(html, /<link rel="stylesheet" href="\/site-fonts\.css\?v=20260829-1" \/>/, filename);
    assert.match(html, /<script src="\/js\/i18n\.js\?v=20260826-9"><\/script>/, filename);
    assert.match(html, /<link rel="stylesheet" href="\/site-header\.css\?v=20260826-3" \/>/, filename);
    assert.match(html, /<header\b[^>]*\bww-site-header\b/, `${filename} needs the shared site header`);
    assert.match(html, /class="[^"]*\bww-nav\b/, `${filename} needs a language-switcher host in its header`);
  }

  const guestPage = fs.readFileSync(path.join(__dirname, '..', 'public', 'guest.html'), 'utf8');
  const displayPage = fs.readFileSync(path.join(__dirname, '..', 'public', 'display.html'), 'utf8');
  assert.match(guestPage, /id="couple-name" data-i18n-ignore/);
  assert.match(displayPage, /id="couple-name" data-i18n-ignore/);
  assert.match(guestPage, /label\.setAttribute\('data-i18n-ignore', ''\)/);
});

test('interface fonts are locally served, pinned and licensed', () => {
  const publicRoot = path.join(__dirname, '..', 'public');
  const textFiles = [];
  const visit = (directory) => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const absolute = path.join(directory, entry.name);
      if (entry.isDirectory()) visit(absolute);
      else if (/\.(?:css|html|js)$/.test(entry.name)) textFiles.push(absolute);
    }
  };
  visit(publicRoot);

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
});

test('legal pages describe the hosted product and enforced retention', () => {
  const privacy = fs.readFileSync(path.join(__dirname, '..', 'public', 'datenschutz.html'), 'utf8');
  const legalNotice = fs.readFileSync(path.join(__dirname, '..', 'public', 'impressum.html'), 'utf8');

  assert.match(privacy, /Fly\.io, Inc\.[\s\S]*Frankfurt am Main/);
  assert.match(privacy, /Supabase, Inc\.[\s\S]*privaten Objektspeicher/);
  assert.match(privacy, /Plus Five Five, Inc\.[\s\S]*Öffnungs- und Klicktracking ist deaktiviert/);
  assert.match(privacy, /automatisch 365 Tage nach Erstellung/);
  assert.match(privacy, /Nicht bezahlte persönliche Erinnerungskonfigurationen[\s\S]*30 Tagen/);
  assert.doesNotMatch(privacy, /ausschließlich lokal entwickelt|Google Fonts|künftige Hosting-Anbieter|künftigen Hosting-Anbieter/);
  assert.match(legalNotice, /interaktive Wortwolken[\s\S]*personalisierte Druckprodukte/);
});

test('guest and display pages keep event content below a dedicated branded header', () => {
  const guestPage = fs.readFileSync(path.join(__dirname, '..', 'public', 'guest.html'), 'utf8');
  const displayPage = fs.readFileSync(path.join(__dirname, '..', 'public', 'display.html'), 'utf8');

  for (const [filename, html] of [['guest.html', guestPage], ['display.html', displayPage]]) {
    assert.match(html, /<header class="site-header ww-site-header">[\s\S]*?<div class="ww-nav">[\s\S]*?Wolkenworte[\s\S]*?<\/header>/, filename);
  }

  assert.match(guestPage, /<section class="event-intro"/);
  assert.match(displayPage, /<aside class="cloud-status" aria-label="Live-Wortwolke">[\s\S]*?id="word-total"/);
  assert.match(displayPage, /<footer class="footer">[\s\S]*?class="footer-event-name" id="couple-name" data-i18n-ignore/);
  assert.doesNotMatch(displayPage, /display-meta/,
    'the display must not add a second header-like metadata bar');
  assert.doesNotMatch(guestPage, /<header class="header">/);
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

  assert.match(styles, /\.ww-nav\s*\{[^}]*width:\s*100%\s*!important[^}]*padding:\s*0 40px\s*!important/s);
  assert.match(styles, /\.ww-brand\s*\{[^}]*margin-right:\s*auto/s);
  assert.match(styles, /\.ww-site-header \.ww-language-inline\s*\{[^}]*margin-left:\s*auto/s);
  assert.match(styles, /@media \(max-width:\s*620px\)[\s\S]*?\.ww-nav\s*\{[^}]*padding:\s*0 16px\s*!important/s);
  assert.match(runtime, /container\.appendChild\(wrapper\)/);
  assert.doesNotMatch(runtime, /container\.insertBefore\(wrapper/,
    'the language switcher must remain the final, right-aligned header item');
});

test('language switcher uses the branded accessible menu and Unicode flags', () => {
  const browserI18n = require('../public/js/i18n.js');
  const runtime = fs.readFileSync(path.join(__dirname, '..', 'public', 'js', 'i18n.js'), 'utf8');
  const styles = fs.readFileSync(path.join(__dirname, '..', 'public', 'i18n.css'), 'utf8');

  assert.deepEqual(browserI18n.LANGUAGE_FLAGS, {
    de: '🇩🇪',
    en: '🇺🇸',
    fr: '🇫🇷',
    it: '🇮🇹',
    es: '🇪🇸',
    tr: '🇹🇷',
  });
  assert.match(runtime, /setAttribute\('aria-haspopup', 'listbox'\)/);
  assert.match(runtime, /setAttribute\('role', 'listbox'\)/);
  assert.doesNotMatch(runtime, /createElement\('select'\)/);
  assert.doesNotMatch(runtime, /addEventListener\('focusout'/,
    'focusout must not race pointer clicks inside the language menu');
  assert.match(styles, /\.ww-language-menu\s*\{/);
  assert.match(styles, /\.ww-language-option\.is-selected/);
  assert.match(runtime, /stackingHost\?\.classList\.toggle\('ww-language-host-open', isOpen\)/);
  assert.match(styles, /\.ww-language-host-open\s*\{[^}]*z-index:\s*10001\s*!important/s);
  assert.match(runtime, /querySelector\('\.ww-nav'\)/);
  assert.doesNotMatch(runtime, /querySelector\('body > \.header'\)/,
    'the language switcher must never fall back to page content');
  assert.doesNotMatch(runtime, /body\.appendChild\(wrapper\)/,
    'the language switcher must never be mounted outside a site header');
});

test('language switcher closes on a second trigger click and navigates on selection', () => {
  const browserI18n = require('../public/js/i18n.js');
  let open = false;
  let focusedOption = -1;
  let triggerFocusCount = 0;
  let chosenLocale = '';
  const controller = browserI18n.createLanguageMenuController({
    optionCodes: browserI18n.SUPPORTED_LOCALES,
    getSelectedCode: () => 'en',
    getOpen: () => open,
    setOpen: (value) => { open = value; },
    getFocusedIndex: () => focusedOption,
    focusOption: (index) => { focusedOption = index; },
    focusTrigger: () => { triggerFocusCount += 1; },
    onChoose: (code) => { chosenLocale = code; },
  });

  controller.toggle();
  assert.equal(open, true);
  assert.equal(focusedOption, browserI18n.SUPPORTED_LOCALES.indexOf('en'));

  controller.toggle();
  assert.equal(open, false, 'a second trigger click must close the menu');
  assert.equal(triggerFocusCount, 1);

  controller.open();
  assert.equal(controller.choose('fr'), true);
  assert.equal(open, false);
  assert.equal(chosenLocale, 'fr', 'choosing an option must request that locale');
  assert.equal(
    browserI18n.languageUrl('https://example.test/start?source=qr#form', chosenLocale),
    'https://example.test/start?source=qr&lang=fr#form'
  );
});

test('guest live preview hides the language switcher until the preview closes', () => {
  const guestPage = fs.readFileSync(path.join(__dirname, '..', 'public', 'guest.html'), 'utf8');
  const styles = fs.readFileSync(path.join(__dirname, '..', 'public', 'i18n.css'), 'utf8');

  assert.match(guestPage, /document\.body\.classList\.add\('preview-open'\)/);
  assert.match(guestPage, /document\.body\.classList\.remove\('preview-open'\)/);
  assert.match(styles, /body\.preview-open\s+\.ww-language-picker\s*\{[^}]*display:\s*none/s);
});

test('event locale is validated, persisted and returned by public APIs', async (t) => {
  const { baseUrl, close } = await startTestServer();
  t.after(close);

  const event = await createEvent(baseUrl, {
    coupleName: 'İpek & Işık',
    slug: 'ipek-isik',
    locale: 'tr-TR',
  });
  assert.equal(event.locale, 'tr');

  const info = await fetch(`${baseUrl}/api/events/${event.slug}`).then((response) => response.json());
  assert.equal(info.locale, 'tr');

  const personalConfigurator = await fetch(
    `${baseUrl}/api/events/${event.slug}/configurator?mode=personal`
  ).then((response) => response.json());
  assert.equal(personalConfigurator.event.locale, 'tr');

  const invalid = await fetch(`${baseUrl}/api/events`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ coupleName: 'Invalid Locale', pin: '1234', locale: 'xx' }),
  });
  assert.equal(invalid.status, 400);
  assert.deepEqual(await invalid.json(), { error: 'invalid_locale' });

  const germanDefault = await createEvent(baseUrl, { coupleName: 'Deutsch bleibt Standard' });
  assert.equal(germanDefault.locale, 'de');
});

test('word normalization uses the event locale without altering user content beyond normalization', () => {
  assert.equal(normalizeWord('  İYİ  ', 'tr'), 'iyi');
  assert.equal(normalizeWord('IŞIK', 'tr'), 'ışık');
  assert.equal(normalizeWord('IŞIK', 'de'), 'işik');
  assert.equal(normalizeWord('ÉTÉ', 'fr'), 'été');
});
