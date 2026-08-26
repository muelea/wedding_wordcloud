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
    assert.match(html, /<link rel="stylesheet" href="\/i18n\.css\?v=20260826-1" \/>/, filename);
    assert.match(html, /<script src="\/js\/i18n\.js\?v=20260826-3"><\/script>/, filename);
  }

  const guestPage = fs.readFileSync(path.join(__dirname, '..', 'public', 'guest.html'), 'utf8');
  const displayPage = fs.readFileSync(path.join(__dirname, '..', 'public', 'display.html'), 'utf8');
  assert.match(guestPage, /id="couple-name" data-i18n-ignore/);
  assert.match(displayPage, /id="couple-name" data-i18n-ignore/);
  assert.match(guestPage, /label\.setAttribute\('data-i18n-ignore', ''\)/);
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
