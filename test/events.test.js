'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { startTestServer, createEvent } = require('./helpers');

// Matches "<prefix>-<5-char suffix from the unambiguous alphabet>".
const SUFFIX_RE = /^(.+)-([23456789abcdefghjkmnpqrstuvwxyz]{5})$/;

test('event creation uses one canonical event URL', async (t) => {
  const { baseUrl, close } = await startTestServer();
  t.after(close);

  const event = await createEvent(baseUrl, { title: 'Anna & Ben', slug: 'anna-und-ben', pin: '4242' });
  // The final slug is the requested prefix PLUS a random suffix, not the
  // literal typed text -- this is the core of the privacy/collision fix.
  assert.notEqual(event.slug, 'anna-und-ben');
  const match = SUFFIX_RE.exec(event.slug);
  assert.ok(match, `expected "${event.slug}" to match "<prefix>-<suffix>"`);
  assert.equal(match[1], 'anna-und-ben');
  assert.equal(event.eventUrl, `/e/${event.slug}`);
  assert.equal('adminToken' in event, false);

  // Starting creates the final protected event atomically and sends the
  // browser straight to its unified live display.
  const missingNameResponse = await fetch(`${baseUrl}/start`, { method: 'POST', redirect: 'manual' });
  assert.equal(missingNameResponse.status, 400);
  assert.match(await missingNameResponse.text(), /id="start-dialog"[\s\S]*?data-open-on-load="true"/);

  const startResponse = await fetch(`${baseUrl}/start`, {
    method: 'POST',
    body: new URLSearchParams({
      cloudName: '  Sommerfest   2026  ', organizerPin: '5678', organizerPinConfirmation: '5678',
    }),
    redirect: 'manual',
  });
  assert.equal(startResponse.status, 303);
  const startLocation = startResponse.headers.get('location') || '';
  const startLocationMatch = /^\/e\/(wortwolke-[23456789abcdefghjkmnpqrstuvwxyz]{5})$/.exec(startLocation);
  assert.ok(startLocationMatch, `unexpected display location: ${startLocation}`);
  const startedSlug = startLocationMatch[1];
  assert.doesNotMatch(startResponse.headers.get('set-cookie') || '', /ww-draft-/);
  const startedInfo = await fetch(`${baseUrl}/api/events/${startedSlug}`).then((response) => response.json());
  assert.equal(startedInfo.hasOrganizerPin, true);
  assert.equal(startedInfo.title, 'Sommerfest 2026');
  assert.equal('isDraft' in startedInfo, false);
  assert.equal('isDraftOwner' in startedInfo, false);

  // Creators and contributors use one canonical event page, which contains
  // contribution and distinct sharing/copy-link controls.
  const eventPageResponse = await fetch(`${baseUrl}${event.eventUrl}`);
  assert.equal(eventPageResponse.status, 200);
  const displayHtml = await eventPageResponse.text();
  assert.match(displayHtml, /id="cloud-container"/);
  assert.match(displayHtml, /id="display-word-entry"/);
  assert.match(displayHtml, /id="display-word-input"/);
  assert.match(displayHtml, /id="display-word-submit"/);
  assert.doesNotMatch(displayHtml, /id="display-word-close"/);
  assert.match(displayHtml, /id="display-page-menu"/);
  assert.match(displayHtml, /id="display-own-words-button"/);
  assert.match(displayHtml, /id="display-own-words-dialog"/);
  assert.match(displayHtml, /id="presentation-mode-button"/);
  assert.match(displayHtml, /body\.presentation-mode \.display-word-entry/);
  assert.match(displayHtml, /body\.presentation-mode \.footer-actions/);
  assert.match(displayHtml, /body\.presentation-mode #memory-cta/);
  assert.match(displayHtml, /classList\.toggle\('presentation-mode', active\)/);
  assert.match(displayHtml, /presentationModeButton\.setAttribute\('aria-checked', String\(active\)\)/);
  assert.match(displayHtml, /class="ww-display-header-actions"[\s\S]*?id="memory-cta"[\s\S]*?data-i18n-source="Erinnerung gestalten"[\s\S]*?id="display-page-menu"/);
  assert.match(displayHtml, /class="ww-keepsake-cta-label ww-keepsake-cta-label-compact" data-i18n-source="Andenken"/);
  assert.match(displayHtml, /id="word-submission-status" role="status" aria-live="polite" aria-atomic="true"/);
  assert.match(displayHtml, /id="share-cloud"/);
  assert.match(displayHtml, /id="copy-cloud-link"/);
  assert.match(displayHtml, /id="share-dialog"/);
  assert.match(displayHtml, /navigator\.share\(data\)/);
  assert.match(displayHtml, /url:\s*eventUrl/);
  assert.doesNotMatch(displayHtml, /id="save-cloud"|beforeinstallprompt|appinstalled|serviceWorker\.register/);
  assert.match(displayHtml, /id="draft-settings-button"/);
  assert.match(displayHtml, /id="draft-settings-button"[\s\S]*?data-i18n-source="Organisatorbereich"/);
  assert.match(displayHtml, /id="draft-settings-title">Wortwolke verwalten</);
  assert.doesNotMatch(displayHtml, /id="draft-settings-button"[^>]*>Einstellungen<\/button>/);
  assert.match(displayHtml, /id="display-palette-picker"/);
  assert.match(displayHtml, /id="display-palette-trigger"[\s\S]*?role="radiogroup"[\s\S]*?data-palette-key="pastel"/);
  assert.doesNotMatch(displayHtml, /id="display-palette-select"|<select[^>]*aria-label="Farbwelt"/);
  assert.match(displayHtml, /wordcloud-palette:\$\{slug\}/);
  assert.match(displayHtml, /id="change-pin-button"/);
  assert.match(displayHtml, /id="reset-cloud-button"/);
  assert.match(
    displayHtml,
    new RegExp(`id="event-qr"[\\s\\S]*?data-event-url="http://[^"]+/e/${event.slug}"[\\s\\S]*?<svg\\b`)
  );
  assert.match(displayHtml, /<svg\b[\s\S]*?<path\b/);
  assert.doesNotMatch(displayHtml, /id="qr-img"|src=""|\/api\/events\/\$\{encodeURIComponent\(slug\)\}\/qr/);
  assert.match(displayHtml, /socket\.on\('word-update', \(words\) =>/);
  assert.match(displayHtml, /socket\.on\('word-accepted',[\s\S]*?announceWordAccepted\(\)/);
  assert.doesNotMatch(displayHtml, /lastWords|showToast\(word\)/);
  assert.equal((await fetch(`${baseUrl}${event.eventUrl}/manifest.webmanifest`)).status, 404);
  assert.equal((await fetch(`${baseUrl}/sw.js`)).status, 404);
  const removedDisplayRoute = await fetch(`${baseUrl}${event.eventUrl}/display`);
  assert.equal(removedDisplayRoute.status, 404);
  assert.equal((await fetch(`${baseUrl}/start`)).status, 404);
  assert.equal((await fetch(`${baseUrl}/wedding`)).status, 404);
  assert.equal((await fetch(`${baseUrl}/api/slug-availability?slug=anna-und-ben`)).status, 404);

  // Public event info is fetchable by the real (suffixed) slug.
  const info = await fetch(`${baseUrl}/api/events/${event.slug}`).then((r) => r.json());
  assert.equal(info.title, 'Anna & Ben');
  assert.equal(info.hasOrganizerPin, true);
  assert.equal('subtitle' in info, false);
  assert.equal('eventTitle' in info, false);
  assert.equal('eventLabel' in info, false);
  assert.equal('weddingDate' in info, false);

  const settingsResponse = await fetch(`${baseUrl}/api/events/${event.slug}/settings`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ title: 'Sommerfest Berlin', pin: '4242' }),
  });
  assert.equal(settingsResponse.status, 200);
  assert.deepEqual(await settingsResponse.json(), { title: 'Sommerfest Berlin' });
  const updatedInfo = await fetch(`${baseUrl}/api/events/${event.slug}`).then((r) => r.json());
  assert.equal(updatedInfo.title, 'Sommerfest Berlin');

  // The bare prefix (without suffix) was never actually created, so it
  // 404s just like any other unknown slug.
  const missingPrefix = await fetch(`${baseUrl}/api/events/anna-und-ben`);
  assert.equal(missingPrefix.status, 404);

  // Unknown slug -> 404.
  const missing = await fetch(`${baseUrl}/api/events/nope-nope-nope`);
  assert.equal(missing.status, 404);
});

test('identical titles produce distinct, independently working slugs (privacy/collision fix)', async (t) => {
  const { baseUrl, close } = await startTestServer();
  t.after(close);

  // Two unrelated events that happen to share a title -- previously
  // the second creation would 409 and force a manual retry; now each just
  // gets its own random suffix automatically.
  const first = await createEvent(baseUrl, { title: 'Johanna & Peter', pin: '1111' });
  const second = await createEvent(baseUrl, { title: 'Johanna & Peter', pin: '2222' });

  assert.notEqual(first.slug, second.slug, 'two events with identical titles must get different slugs');

  const firstMatch = SUFFIX_RE.exec(first.slug);
  const secondMatch = SUFFIX_RE.exec(second.slug);
  assert.ok(firstMatch && secondMatch);
  // Same human-readable prefix (both derived from "Johanna & Peter")...
  assert.equal(firstMatch[1], 'johanna-und-peter');
  assert.equal(secondMatch[1], 'johanna-und-peter');
  // ...but different random suffixes.
  assert.notEqual(firstMatch[2], secondMatch[2]);

  // Both slugs are independently real, working events -- not just distinct
  // strings, but two separate rows an event page can actually load.
  const firstInfo = await fetch(`${baseUrl}/api/events/${first.slug}`).then((r) => r.json());
  const secondInfo = await fetch(`${baseUrl}/api/events/${second.slug}`).then((r) => r.json());
  assert.equal(firstInfo.title, 'Johanna & Peter');
  assert.equal(secondInfo.title, 'Johanna & Peter');

  // The bare shared prefix without any suffix was never created as its own
  // event -- confirms neither creation silently collapsed onto a
  // guessable, suffix-less slug.
  const bareRes = await fetch(`${baseUrl}/api/events/johanna-und-peter`);
  assert.equal(bareRes.status, 404);
});

test('event creation validates required fields', async (t) => {
  const { baseUrl, close } = await startTestServer();
  t.after(close);

  const noName = await fetch(`${baseUrl}/api/events`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ pin: '1234' }),
  });
  assert.equal(noName.status, 400);

  const badPin = await fetch(`${baseUrl}/api/events`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ title: 'Klara & Jonas', pin: '12' }),
  });
  assert.equal(badPin.status, 400);

  const missingStartPin = await fetch(`${baseUrl}/start`, {
    method: 'POST',
    body: new URLSearchParams({ cloudName: 'Geschützte Wolke' }),
  });
  assert.equal(missingStartPin.status, 400);
  assert.match(await missingStartPin.text(), /Organisator-PIN mit 4–6 Ziffern/);

  const mismatchedStartPin = await fetch(`${baseUrl}/start`, {
    method: 'POST',
    body: new URLSearchParams({
      cloudName: 'Geschützte Wolke', organizerPin: '1234', organizerPinConfirmation: '1235',
    }),
  });
  assert.equal(mismatchedStartPin.status, 400);
  assert.match(await mismatchedStartPin.text(), /Die beiden PINs stimmen nicht überein/);
});

test('slug is auto-derived from the title when not supplied, umlauts transliterated', async (t) => {
  const { baseUrl, close } = await startTestServer();
  t.after(close);

  const res = await fetch(`${baseUrl}/api/events`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ title: 'Jö & Björn Müller', pin: '9999' }),
  });
  const body = await res.json();
  assert.equal(res.status, 201);
  const match = SUFFIX_RE.exec(body.slug);
  assert.ok(match, `expected "${body.slug}" to match "<prefix>-<suffix>"`);
  assert.equal(match[1], 'joe-und-bjoern-mueller');
});

test('organizer PIN protects settings, rotation and reset without issuing a reusable token', async (t) => {
  const { baseUrl, close } = await startTestServer();
  t.after(close);

  const event = await createEvent(baseUrl, { title: 'Pinnwand Petra', pin: '7777' });

  // A missing PIN and a wrong PIN use the same generic authentication error.
  const noAuth = await fetch(`${baseUrl}/api/events/${event.slug}/reset`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}',
  });
  assert.equal(noAuth.status, 401);
  assert.deepEqual(await noAuth.json(), { error: 'invalid_pin' });

  const wrongPin = await fetch(`${baseUrl}/api/events/${event.slug}/reset`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ pin: '0000' }),
  });
  assert.equal(wrongPin.status, 401);
  assert.deepEqual(await wrongPin.json(), { error: 'invalid_pin' });

  const verifyRes = await fetch(`${baseUrl}/api/events/${event.slug}/organizer/verify`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ pin: '7777' }),
  });
  assert.equal(verifyRes.status, 204);

  const rotateRes = await fetch(`${baseUrl}/api/events/${event.slug}/organizer-pin`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ pin: '7777', newPin: '888888' }),
  });
  assert.equal(rotateRes.status, 204);

  const oldPinSettings = await fetch(`${baseUrl}/api/events/${event.slug}/settings`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ title: 'Alter PIN darf nicht', pin: '7777' }),
  });
  assert.equal(oldPinSettings.status, 401);

  const newPinSettings = await fetch(`${baseUrl}/api/events/${event.slug}/settings`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ title: 'Neuer PIN funktioniert', pin: '888888' }),
  });
  assert.equal(newPinSettings.status, 200);

  // The correct PIN is verified for this reset only.
  const resetRes = await fetch(`${baseUrl}/api/events/${event.slug}/reset`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ pin: '888888' }),
  });
  assert.equal(resetRes.status, 200);

  const displayHtml = await fetch(`${baseUrl}/e/${event.slug}`).then((response) => response.text());
  assert.doesNotMatch(displayHtml, /admin-token:|sessionStorage\.setItem\([^)]*admin/i);
  assert.doesNotMatch(displayHtml, /localStorage\.setItem\([^)]*pin/i);
  assert.match(displayHtml, /body: JSON\.stringify\(\{ pin: unlockedOrganizerPin \}\)/);
});
