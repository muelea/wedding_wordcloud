'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { startTestServer, createEvent } = require('./helpers');

// Matches "<prefix>-<5-char suffix from the unambiguous alphabet>".
const SUFFIX_RE = /^(.+)-([23456789abcdefghjkmnpqrstuvwxyz]{5})$/;

test('event creation uses one canonical event URL', async (t) => {
  const { baseUrl, close } = await startTestServer();
  t.after(close);

  const event = await createEvent(baseUrl, { coupleName: 'Anna & Ben', slug: 'anna-und-ben', pin: '4242' });
  // The final slug is the requested prefix PLUS a random suffix, not the
  // literal typed text -- this is the core of the privacy/collision fix.
  assert.notEqual(event.slug, 'anna-und-ben');
  const match = SUFFIX_RE.exec(event.slug);
  assert.ok(match, `expected "${event.slug}" to match "<prefix>-<suffix>"`);
  assert.equal(match[1], 'anna-und-ben');
  assert.equal(event.eventUrl, `/e/${event.slug}`);
  assert.equal('adminToken' in event, false);

  // Starting now creates an owner-bound draft immediately and sends the
  // browser straight to its unified live display.
  const startResponse = await fetch(`${baseUrl}/start`, { method: 'POST', redirect: 'manual' });
  assert.equal(startResponse.status, 303);
  const startLocation = startResponse.headers.get('location') || '';
  const draftLocationMatch = /^\/e\/(wortwolke-[23456789abcdefghjkmnpqrstuvwxyz]{5})$/.exec(startLocation);
  assert.ok(draftLocationMatch, `unexpected draft display location: ${startLocation}`);
  const draftSlug = draftLocationMatch[1];
  const draftCookie = (startResponse.headers.get('set-cookie') || '').split(';')[0];
  assert.match(draftCookie, new RegExp(`^ww-draft-${draftSlug}=`));
  const draftInfo = await fetch(`${baseUrl}/api/events/${draftSlug}`, {
    headers: { Cookie: draftCookie },
  }).then((response) => response.json());
  assert.equal(draftInfo.isDraft, true);
  assert.equal(draftInfo.isDraftOwner, true);
  assert.equal(draftInfo.hasAdminPin, false);

  // Creators and contributors use one canonical event page, which contains
  // contribution, sharing and save controls.
  const eventPageResponse = await fetch(`${baseUrl}${event.eventUrl}`);
  assert.equal(eventPageResponse.status, 200);
  const displayHtml = await eventPageResponse.text();
  assert.match(displayHtml, /id="cloud-container"/);
  assert.match(displayHtml, /id="display-word-entry"/);
  assert.match(displayHtml, /id="display-word-input"/);
  assert.match(displayHtml, /id="display-word-submit"/);
  assert.match(displayHtml, /id="display-own-words"/);
  assert.match(displayHtml, /id="memory-cta" title="Wortwolke verewigen"/);
  assert.match(displayHtml, /id="share-cloud"/);
  assert.match(displayHtml, /id="save-cloud"/);
  assert.match(displayHtml, /id="draft-settings-button"/);
  assert.match(displayHtml, /\/api\/events\/\$\{encodeURIComponent\(slug\)\}\/qr/);
  assert.match(displayHtml, /socket\.on\('word-update', \(words\) =>/);
  const manifest = await fetch(`${baseUrl}${event.eventUrl}/manifest.webmanifest`).then((response) => response.json());
  assert.equal(manifest.id, event.eventUrl);
  assert.equal(manifest.start_url, event.eventUrl);
  assert.equal(manifest.scope, event.eventUrl);
  const removedDisplayRoute = await fetch(`${baseUrl}${event.eventUrl}/display`);
  assert.equal(removedDisplayRoute.status, 404);
  assert.equal((await fetch(`${baseUrl}/start`)).status, 404);
  assert.equal((await fetch(`${baseUrl}/wedding`)).status, 404);
  assert.equal((await fetch(`${baseUrl}/api/slug-availability?slug=anna-und-ben`)).status, 404);

  // Public event info is fetchable by the real (suffixed) slug.
  const info = await fetch(`${baseUrl}/api/events/${event.slug}`).then((r) => r.json());
  assert.equal(info.coupleName, 'Anna & Ben');
  assert.equal('eventTitle' in info, false);
  assert.equal('weddingDate' in info, false);

  // The bare prefix (without suffix) was never actually created, so it
  // 404s just like any other unknown slug.
  const missingPrefix = await fetch(`${baseUrl}/api/events/anna-und-ben`);
  assert.equal(missingPrefix.status, 404);

  // Unknown slug -> 404.
  const missing = await fetch(`${baseUrl}/api/events/nope-nope-nope`);
  assert.equal(missing.status, 404);
});

test('identical couple names produce distinct, independently working slugs (privacy/collision fix)', async (t) => {
  const { baseUrl, close } = await startTestServer();
  t.after(close);

  // Two unrelated couples who happen to share a name combo -- previously
  // the second creation would 409 and force a manual retry; now each just
  // gets its own random suffix automatically.
  const first = await createEvent(baseUrl, { coupleName: 'Johanna & Peter', pin: '1111' });
  const second = await createEvent(baseUrl, { coupleName: 'Johanna & Peter', pin: '2222' });

  assert.notEqual(first.slug, second.slug, 'two events with identical couple names must get different slugs');

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
  assert.equal(firstInfo.coupleName, 'Johanna & Peter');
  assert.equal(secondInfo.coupleName, 'Johanna & Peter');

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
    body: JSON.stringify({ coupleName: 'Klara & Jonas', pin: '12' }),
  });
  assert.equal(badPin.status, 400);
});

test('slug is auto-derived from couple names when not supplied, umlauts transliterated', async (t) => {
  const { baseUrl, close } = await startTestServer();
  t.after(close);

  const res = await fetch(`${baseUrl}/api/events`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ coupleName: 'Jö & Björn Müller', pin: '9999' }),
  });
  const body = await res.json();
  assert.equal(res.status, 201);
  const match = SUFFIX_RE.exec(body.slug);
  assert.ok(match, `expected "${body.slug}" to match "<prefix>-<suffix>"`);
  assert.equal(match[1], 'joe-und-bjoern-mueller');
});

test('admin PIN authorizes one reset request without issuing or storing a reusable token', async (t) => {
  const { baseUrl, close } = await startTestServer();
  t.after(close);

  const event = await createEvent(baseUrl, { coupleName: 'Pinnwand Petra', pin: '7777' });

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

  // The retired verification endpoint no longer exists.
  const verifyRes = await fetch(`${baseUrl}/api/events/${event.slug}/admin/verify`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ pin: '7777' }),
  });
  assert.equal(verifyRes.status, 404);

  // The correct PIN is verified for this reset only.
  const resetRes = await fetch(`${baseUrl}/api/events/${event.slug}/reset`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ pin: '7777' }),
  });
  assert.equal(resetRes.status, 200);

  const displayHtml = await fetch(`${baseUrl}/e/${event.slug}`).then((response) => response.text());
  assert.doesNotMatch(displayHtml, /admin-token:|sessionStorage\.setItem\([^)]*admin/i);
  assert.match(displayHtml, /JSON\.stringify\(\{ pin \}\)/);
});
