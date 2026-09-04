'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { once } = require('node:events');
const { io: ioClient } = require('socket.io-client');
const { startTestServer, createEvent, productDesignPayload } = require('./helpers');

const EVENT_ID_RE = /^[A-Za-z0-9_-]{21}[AEIMQUYcgkosw048]$/;

test('random IDs preserve case and URL-safe symbols across the event journey', async (t) => {
  const ids = ['-_AbCdEf0123456789xyZQ', '_-aBcDeF0123456789XYzQ'];
  const pendingIds = [...ids];
  t.mock.method(require('../src/slug'), 'generateEventSlug', () => pendingIds.shift());
  const { baseUrl, close } = await startTestServer();
  t.after(close);

  const event = await createEvent(baseUrl);
  assert.equal(event.slug, ids[0]);
  const started = await fetch(`${baseUrl}/start`, {
    method: 'POST', redirect: 'manual',
    body: new URLSearchParams({ cloudName: '🎉', organizerPin: '5678', organizerPinConfirmation: '5678' }),
  });
  assert.equal(started.status, 303);
  assert.equal(started.headers.get('location'), `/e/${ids[1]}`);

  for (const slug of ids) {
    const api = `${baseUrl}/api/events/${slug}`;
    const page = await fetch(`${baseUrl}/e/${slug}`);
    assert.equal(page.status, 200);
    const shareUrl = /data-event-url="([^"]+)"/.exec(await page.text())?.[1];
    assert.ok(shareUrl);
    assert.equal(new URL(shareUrl).pathname, `/e/${slug}`);
    const qr = await fetch(`${api}/qr`).then((response) => response.json());
    assert.equal(qr.url, shareUrl);
    assert.match(qr.dataUrl, /^data:image\/png;base64,/);
    assert.equal((await fetch(`${baseUrl}/e/${slug.toLowerCase()}`)).status, 404);
    assert.equal((await fetch(`${baseUrl}/api/events/${slug.toLowerCase()}`)).status, 404);

    const socket = ioClient(baseUrl, {
      query: { slug }, transports: ['websocket'], forceNew: true, autoConnect: false,
    });
    t.after(() => socket.close());
    const initial = once(socket, 'word-update', { signal: AbortSignal.timeout(5000) });
    socket.connect();
    assert.deepEqual(await initial, [[]]);
    const update = once(socket, 'word-update', { signal: AbortSignal.timeout(5000) });
    socket.emit('submit-word', 'Freude');
    assert.deepEqual(await update, [[['freude', 1]]]);
    socket.close();

    const configurator = await fetch(`${api}/configurator`).then((response) => response.json());
    assert.equal(configurator.event.slug, slug);
    assert.deepEqual(configurator.words, [['freude', 1]]);
    const saved = await fetch(`${api}/configurations`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ theme: 'pastel', ...productDesignPayload() }),
    });
    assert.equal(saved.status, 201);
    const configuration = await saved.json();
    assert.equal((await fetch(`${api}/configurations/${configuration.id}/edit`)).status, 200);
    const otherSlug = ids.find((id) => id !== slug);
    assert.equal((await fetch(`${baseUrl}/api/events/${otherSlug}/configurations/${configuration.id}/edit`)).status, 404);
    for (const path of ['configure', 'shipping', 'order-confirmation']) {
      assert.equal((await fetch(`${baseUrl}/e/${slug}/${path}`)).status, 200);
    }
  }
});

test('both creation endpoints retry permanent ID collisions and stop after 20 attempts', async (t) => {
  const reserved = 'A'.repeat(22);
  const generator = t.mock.method(require('../src/slug'), 'generateEventSlug', () => reserved);
  const { baseUrl, query, close } = await startTestServer();
  t.after(close);
  // A reservation without an event represents an ID retained after cleanup.
  await query('INSERT INTO reserved_event_slugs (slug, original_created_at) VALUES ($1, now())', [reserved]);
  const requests = [
    ['/api/events', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: 'Test', pin: '1234' }),
    }, 'AAECAwQFBgcICQoLDA0ODw', 201],
    ['/start', {
      method: 'POST', redirect: 'manual',
      body: new URLSearchParams({ cloudName: 'Test', organizerPin: '1234', organizerPinConfirmation: '1234' }),
    }, '-_AbCdEf0123456789xyZQ', 303],
  ];
  for (const [path, options, fresh, status] of requests) {
    const candidates = [reserved, fresh];
    generator.mock.mockImplementation(() => candidates.shift());
    const response = await fetch(`${baseUrl}${path}`, options);
    assert.equal(response.status, status);
    if (status === 201) assert.equal((await response.json()).slug, fresh);
    else assert.equal(response.headers.get('location'), `/e/${fresh}`);
    assert.equal(candidates.length, 0, 'the reserved ID must cause a retry');

    generator.mock.mockImplementation(() => reserved);
    const previousCalls = generator.mock.callCount();
    const failed = await fetch(`${baseUrl}${path}`, options);
    assert.equal(failed.status, 500);
    assert.equal(generator.mock.callCount() - previousCalls, 20);
    if (path === '/api/events') assert.deepEqual(await failed.json(), { error: 'event_id_generation_failed' });
    else assert.match(await failed.text(), /Die Wortwolke konnte nicht erstellt werden/);
  }
  assert.equal((await query('SELECT count(*)::integer AS count FROM events')).rows[0].count, 2);
  assert.equal((await query('SELECT count(*)::integer AS count FROM reserved_event_slugs')).rows[0].count, 3);
});

test('event creation uses one canonical event URL', async (t) => {
  const { baseUrl, close } = await startTestServer();
  t.after(close);

  const event = await createEvent(baseUrl, { title: 'Anna & Ben', pin: '4242' });
  assert.match(event.slug, EVENT_ID_RE);
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
  const startLocationMatch = /^\/e\/([A-Za-z0-9_-]{22})$/.exec(startLocation);
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
  assert.match(displayHtml, /id="draft-settings-title"[^>]*>Wortwolke verwalten</);
  assert.doesNotMatch(displayHtml, /id="draft-settings-button"[^>]*>Einstellungen<\/button>/);
  assert.match(displayHtml, /id="display-palette-picker"/);
  assert.match(displayHtml, /id="display-palette-trigger"[\s\S]*?role="radiogroup"[\s\S]*?data-palette-key="pastel"/);
  assert.doesNotMatch(displayHtml, /id="display-palette-select"|<select[^>]*aria-label="Farbwelt"/);
  assert.match(displayHtml, /wordcloud-palette:\$\{slug\}/);
  assert.match(displayHtml, /WolkenworteTheme\.restore\([\s\S]*?<style>/,
    'the saved palette must be restored in the head before display CSS can paint');
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

  // A reload renders the committed snapshot and its dependent CTA directly
  // into the response; it must not briefly show the empty state first.
  const database = require('../src/db');
  const eventRecord = await database.getEventBySlug(event.slug);
  await database.addWordContribution(eventRecord.id, 'reload-ready', 'f'.repeat(32));
  const populatedHtml = await fetch(`${baseUrl}${event.eventUrl}`).then((response) => response.text());
  assert.match(populatedHtml, /class="ww-keepsake-cta visible"/);
  assert.match(populatedHtml, /id="empty-state" class="hidden"/);
  assert.match(populatedHtml, /let currentWords = \[\["reload-ready",1\]\]/);
  assert.match(populatedHtml, /if \(currentWords\.length\) scheduleRender\(currentWords, 0\)/);
  assert.equal((await fetch(`${baseUrl}${event.eventUrl}/manifest.webmanifest`)).status, 404);
  assert.equal((await fetch(`${baseUrl}/sw.js`)).status, 404);
  const removedDisplayRoute = await fetch(`${baseUrl}${event.eventUrl}/display`);
  assert.equal(removedDisplayRoute.status, 404);
  assert.equal((await fetch(`${baseUrl}/start`)).status, 404);
  assert.equal((await fetch(`${baseUrl}/wedding`)).status, 404);
  assert.equal((await fetch(`${baseUrl}/api/slug-availability?slug=anna-und-ben`)).status, 404);

  // Public event info is fetchable by the exact random ID.
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

  // Unknown slug -> 404.
  const missing = await fetch(`${baseUrl}/api/events/nope-nope-nope`);
  assert.equal(missing.status, 404);
});

test('identical titles produce distinct, independently working random IDs', async (t) => {
  const { baseUrl, close } = await startTestServer();
  t.after(close);

  const first = await createEvent(baseUrl, { title: 'Johanna & Peter', pin: '1111' });
  const second = await createEvent(baseUrl, { title: 'Johanna & Peter', pin: '2222' });

  assert.notEqual(first.slug, second.slug, 'two events with identical titles must get different slugs');

  assert.match(first.slug, EVENT_ID_RE);
  assert.match(second.slug, EVENT_ID_RE);

  // Both slugs are independently real, working events -- not just distinct
  // strings, but two separate rows an event page can actually load.
  const firstInfo = await fetch(`${baseUrl}/api/events/${first.slug}`).then((r) => r.json());
  const secondInfo = await fetch(`${baseUrl}/api/events/${second.slug}`).then((r) => r.json());
  assert.equal(firstInfo.title, 'Johanna & Peter');
  assert.equal(secondInfo.title, 'Johanna & Peter');

  // The event title cannot be used to discover its URL.
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

test('event IDs are independent of Unicode titles and caller-supplied IDs', async (t) => {
  const { baseUrl, close } = await startTestServer();
  t.after(close);

  for (const title of ['Jö & Björn Müller', '東京', '🎉']) {
    const res = await fetch(`${baseUrl}/api/events`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title, pin: '9999', slug: 'A'.repeat(22) }),
    });
    const body = await res.json();
    assert.equal(res.status, 201);
    assert.match(body.slug, EVENT_ID_RE);
    assert.notEqual(body.slug, 'A'.repeat(22), 'clients cannot choose a guessable ID');
    const info = await fetch(`${baseUrl}/api/events/${body.slug}`).then((response) => response.json());
    assert.equal(info.title, title);
  }
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
