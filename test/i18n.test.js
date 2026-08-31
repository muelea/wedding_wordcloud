'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const ejs = require('ejs');
const { startTestServer, createEvent } = require('./helpers');
const I18n = require('../src/i18n');
const PageRenderer = require('../src/pageRenderer');
const { normalizeWord } = require('../src/words');

const LOCALES = ['de', 'en', 'fr', 'it', 'es', 'tr'];
const CATALOG_LOCALES = LOCALES.filter((locale) => locale !== 'de');
const PUBLIC_PAGES = [
  'landing.ejs',
  'create.ejs',
  'guest.ejs',
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

function viewSource(filename) {
  return fs.readFileSync(path.join(VIEW_ROOT, filename), 'utf8');
}

function renderView(filename, header = {}) {
  const fullPath = path.join(VIEW_ROOT, filename);
  return ejs.render(fs.readFileSync(fullPath, 'utf8'), {
    locale: 'de',
    localeSource: 'default',
    header,
    languages: TEST_LANGUAGES,
    t: (source) => source,
  }, { filename: fullPath });
}
const REQUIRED_MESSAGES = [
  'Wortwolke starten',
  'Teilt ein Wort für das Brautpaar.',
  '{{count}} Wörter live geteilt',
  'Neue Runde starten?',
  'Eure Worte. Eure Erinnerung.',
  '{{count}} Elemente ausgewählt',
  'Wählt, wie viele Produkte an welche Adresse gehen sollen. Für eine einzelne Lieferung bleibt einfach diese eine Adresse stehen.',
  '{{count}} Lieferadressen',
  'Eure Zahlung wurde bestätigt und eure Bestellung ist bei uns eingegangen.',
  'Diese Wortwolke gibt es nicht.',
  'und',
  'Zusätzlich werden rein funktionale Kennzeichnungen im Session Storage gespeichert, damit das erstellende Gerät den einmaligen Einrichtungs-Hinweis anzeigen kann. Die gewählte Sprache wird in einem funktionalen Cookie gespeichert; Entwürfe im Warenkorb werden lokal gespeichert, damit sie bei weiteren Seitenaufrufen beziehungsweise beim Wechsel zwischen Konfiguration und Lieferadresse erhalten bleiben. Der Admin-PIN wird nicht im Browser gespeichert.',
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
    const html = viewSource(filename);
    assert.match(html, /<link rel="stylesheet" href="\/i18n\.css\?v=20260829-2" \/>/, filename);
    assert.match(
      html,
      filename === 'landing.ejs'
        ? /<link rel="stylesheet" href="\/site-fonts\.css\?v=20260829-3" \/>/
        : /<link rel="stylesheet" href="\/site-fonts\.css\?v=20260829-1" \/>/,
      filename
    );
    assert.match(html, /<script src="\/js\/i18n\.js\?v=20260829-3"><\/script>/, filename);
    assert.match(html, /<link rel="stylesheet" href="\/site-header\.css\?v=20260829-2" \/>/, filename);
    assert.match(html, /include\('partials\/site-header'\)/,
      `${filename} needs the shared server-rendered site header`);
    const rendered = renderView(filename);
    assert.match(rendered, /<header\b[^>]*\bww-site-header\b/, filename);
    assert.match(rendered, /<details class="ww-language-picker ww-language-inline"/, filename);
  }

  const guestPage = viewSource('guest.ejs');
  const displayPage = viewSource('display.ejs');
  assert.match(guestPage, /id="couple-name" data-i18n-ignore/);
  assert.match(displayPage, /id="couple-name" data-i18n-ignore/);
  assert.match(guestPage, /label\.setAttribute\('data-i18n-ignore', ''\)/);
});

test('customer-facing actions stay calm and do not expose staging or provider narration', () => {
  const shipping = viewSource('shipping.ejs');
  const confirmation = viewSource('order-confirmation.ejs');
  const create = viewSource('create.ejs');
  const guest = viewSource('guest.ejs');
  const display = viewSource('display.ejs');

  assert.match(shipping, />Weiter zur Zahlung <span/);
  assert.doesNotMatch(shipping, /Weiter zur Testzahlung|Preis wird noch einmal geprüft|Der Preis ist kurzzeitig reserviert/);
  assert.doesNotMatch(confirmation, /Stripe-Testmodus|Testzahlung erfolgreich|Dies war eine Testzahlung/);
  assert.doesNotMatch(create, /Wird geprüft…|Wird gestartet…/);
  assert.doesNotMatch(guest, /window\.prompt/);
  assert.doesNotMatch(display, /(?:^|[^\w$.])(?:window\.)?(?:confirm|prompt|alert)\s*\(/m);
  assert.match(display, /<dialog class="reset-dialog" id="reset-dialog"/);
  assert.match(display, /<button class="reset-dialog-button" id="reset-cancel" type="button">Abbrechen<\/button>/);

  for (const filename of ['create.ejs', 'configure.ejs', 'shipping.ejs', 'display.ejs']) {
    const page = viewSource(filename);
    assert.match(page, /\/action-state\.css\?v=20260829-1/, filename);
    assert.match(page, /\/js\/action-state\.js\?v=20260829-1/, filename);
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
});

test('legal pages describe the hosted product and enforced retention', () => {
  const privacy = viewSource('datenschutz.ejs');
  const legalNotice = viewSource('impressum.ejs');

  assert.match(privacy, /Fly\.io, Inc\.[\s\S]*Frankfurt am Main/);
  assert.match(privacy, /Supabase, Inc\.[\s\S]*privaten Objektspeicher/);
  assert.match(privacy, /Plus Five Five, Inc\.[\s\S]*Öffnungs- und Klicktracking ist deaktiviert/);
  assert.match(privacy, /automatisch 365 Tage nach Erstellung/);
  assert.match(privacy, /Nicht bezahlte persönliche Erinnerungskonfigurationen[\s\S]*30 Tagen/);
  assert.doesNotMatch(privacy, /ausschließlich lokal entwickelt|Google Fonts|künftige Hosting-Anbieter|künftigen Hosting-Anbieter/);
  assert.match(legalNotice, /interaktive Wortwolken[\s\S]*personalisierte Druckprodukte/);
});

test('guest and display pages keep event content below a dedicated branded header', () => {
  const guestPage = renderView('guest.ejs');
  const displayPage = renderView('display.ejs');

  for (const [filename, html] of [['guest.ejs', guestPage], ['display.ejs', displayPage]]) {
    assert.match(html, /<header class="site-header ww-site-header">[\s\S]*?<div class="ww-nav ww-language-mounted">[\s\S]*?ww-brand-wordmark[\s\S]*?<\/header>/, filename);
  }

  assert.match(guestPage, /<section class="event-intro"/);
  assert.match(displayPage, /<aside class="cloud-status" aria-label="Live-Wortwolke">[\s\S]*?id="memory-cta"/);
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
  const partial = fs.readFileSync(path.join(VIEW_ROOT, 'partials', 'site-header.ejs'), 'utf8');

  assert.match(styles, /\.ww-nav\s*\{[^}]*width:\s*100%\s*!important[^}]*padding:\s*0 40px\s*!important/s);
  assert.match(styles, /\.ww-brand\s*\{[^}]*margin-right:\s*auto/s);
  assert.doesNotMatch(styles, /\.ww-nav::after/,
    'the final language control is server-rendered, so an empty placeholder must not return');
  assert.match(styles, /\.ww-site-header \.ww-language-inline\s*\{[^}]*margin-left:\s*auto/s);
  assert.match(styles, /@media \(max-width:\s*620px\)[\s\S]*?\.ww-nav\s*\{[^}]*padding:\s*0 16px\s*!important/s);
  assert.match(partial, /<details class="ww-language-picker ww-language-inline"/);
  assert.match(partial, /<summary[\s\S]*?id="ww-language-select"/);
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
  const partial = fs.readFileSync(path.join(VIEW_ROOT, 'partials', 'site-header.ejs'), 'utf8');

  assert.deepEqual(browserI18n.LANGUAGE_FLAGS, {
    de: '🇩🇪',
    en: '🇺🇸',
    fr: '🇫🇷',
    it: '🇮🇹',
    es: '🇪🇸',
    tr: '🇹🇷',
  });
  assert.match(partial, /<details class="ww-language-picker ww-language-inline"/);
  assert.match(partial, /<nav id="ww-language-menu"/);
  assert.match(partial, /<a[\s\S]*?data-language-code=/);
  assert.match(partial, /hreflang="<%= language\.code %>"/);
  assert.match(styles, /\.ww-language-menu\s*\{/);
  assert.match(styles, /\.ww-language-trigger\s*\{[^}]*width:\s*126px/s,
    'translated language names must not resize the header control');
  assert.match(styles, /\.ww-language-option\.is-selected/);
  assert.match(styles, /\.ww-language-picker\[open\] \.ww-language-trigger/);
  assert.match(runtime, /stackingHost\?\.classList\.toggle\('ww-language-host-open', picker\.open\)/);
  assert.match(styles, /\.ww-language-host-open\s*\{[^}]*z-index:\s*10001\s*!important/s);
  assert.match(runtime, /await setLocale\(nextLocale, \{ persist: true, source: 'stored' \}\)/);
  assert.match(runtime, /history\?\.replaceState/);
  assert.doesNotMatch(runtime, /localStorage\?\.(?:getItem|setItem)/,
    'the client and server must not compete over duplicate language preferences');
  assert.doesNotMatch(runtime, /location\.assign/,
    'language changes must not destroy and rebuild the document');
  assert.match(runtime, /`\/locales\/\$\{encodeURIComponent\(code\)\}\.json`/);
  assert.match(runtime, /cache:\s*'no-cache'/,
    'translation catalogs must revalidate so deployments cannot leave mixed-language copy behind');
  assert.match(runtime, /function setText\(element, source, params = \{\}\)/,
    'dynamic UI must retain an explicit translation source');
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
    browserI18n.languageUrl('https://example.test/start?source=qr#form', 'fr'),
    'https://example.test/start?source=qr&lang=fr#form'
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

test('guest live preview hides the language switcher until the preview closes', () => {
  const guestPage = viewSource('guest.ejs');
  const styles = fs.readFileSync(path.join(__dirname, '..', 'public', 'i18n.css'), 'utf8');

  assert.match(guestPage, /document\.body\.classList\.add\('preview-open'\)/);
  assert.match(guestPage, /document\.body\.classList\.remove\('preview-open'\)/);
  assert.match(styles, /body\.preview-open\s+\.ww-language-picker\s*\{[^}]*visibility:\s*hidden/s);
});

test('event locale is validated, persisted and returned by public APIs', async (t) => {
  const { baseUrl, close } = await startTestServer();
  t.after(close);

  const frenchLanding = await fetch(`${baseUrl}/?lang=fr`);
  assert.equal(frenchLanding.status, 200);
  assert.match(frenchLanding.headers.get('set-cookie') || '', /wolkenworte-language=fr/);
  const frenchLandingHtml = await frenchLanding.text();
  assert.match(frenchLandingHtml, /<html lang="fr">/);
  assert.match(frenchLandingHtml, /Wolkenworte – Vos souvenirs en un mot/);
  assert.match(frenchLandingHtml, /Commencer ici/);
  assert.match(frenchLandingHtml, /ww-language-current-name">Français/);

  const rememberedStart = await fetch(`${baseUrl}/start`, {
    headers: { Cookie: 'wolkenworte-language=fr' },
    redirect: 'manual',
  });
  assert.equal(rememberedStart.status, 303);
  const rememberedStartLocation = rememberedStart.headers.get('location') || '';
  const rememberedDraftMatch = /^\/e\/([^/]+)\/display$/.exec(rememberedStartLocation);
  assert.ok(rememberedDraftMatch, `unexpected draft display location: ${rememberedStartLocation}`);
  const rememberedDraftInfo = await fetch(
    `${baseUrl}/api/events/${rememberedDraftMatch[1]}`
  ).then((response) => response.json());
  assert.equal(rememberedDraftInfo.locale, 'fr');
  const draftCookie = (rememberedStart.headers.get('set-cookie') || '').split(';')[0];
  const rememberedDisplay = await fetch(`${baseUrl}${rememberedStartLocation}`, {
    headers: { Cookie: `wolkenworte-language=fr; ${draftCookie}` },
  });
  assert.equal(rememberedDisplay.status, 200);
  const rememberedDisplayHtml = await rememberedDisplay.text();
  assert.match(rememberedDisplayHtml, /<html lang="fr"/);
  assert.match(rememberedDisplayHtml, /ww-language-current-name">Français/);

  const event = await createEvent(baseUrl, {
    coupleName: 'İpek & Işık',
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
