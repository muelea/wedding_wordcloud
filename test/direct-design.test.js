'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { startTestServer, createEvent, productDesignPayload } = require('./helpers');
const { DEFAULT_PRODUCT } = require('../src/products');

async function startDesign(baseUrl, suffix = '') {
  const response = await fetch(`${baseUrl}/design/start${suffix}`, {
    method: 'POST', redirect: 'manual',
  });
  assert.equal(response.status, 303);
  assert.equal(response.headers.get('cache-control'), 'no-store');
  const location = response.headers.get('location');
  const match = /^\/e\/([A-Za-z0-9_-]{21}[AEIMQUYcgkosw048])\/configure$/.exec(location);
  assert.ok(match, `unexpected configurator location: ${location}`);
  return { slug: match[1], location };
}

test('both Home entries deliberately start a blank default mug without cloud setup', async (t) => {
  const app = await startTestServer();
  t.after(app.close);
  const homepage = await fetch(app.baseUrl).then(response => response.text());
  assert.equal((homepage.match(/action="\/design\/start" method="post"/g) || []).length, 2);
  assert.match(homepage, /class="hero-actions"[\s\S]*?data-open-start-dialog/);
  assert.equal((await fetch(`${app.baseUrl}/design/start`)).status, 404,
    'prefetching or visiting the start URL must never create a workspace');
  assert.equal((await app.query('SELECT count(*)::integer AS count FROM events')).rows[0].count, 0);

  const first = await startDesign(app.baseUrl, '?lang=en');
  const second = await startDesign(app.baseUrl);
  assert.notEqual(first.slug, second.slug);
  const info = await fetch(`${app.baseUrl}/api/events/${first.slug}`).then(response => response.json());
  assert.equal(info.title, 'Your keepsake');
  assert.equal(info.locale, 'en');
  assert.equal(info.hasOrganizerPin, false);
  assert.equal(info.directDesign, true);
  const record = (await app.query('SELECT * FROM events WHERE slug = $1', [first.slug])).rows[0];
  assert.equal(record.organizer_pin_hash, null);
  assert.equal(record.organizer_pin_salt, null);
  assert.equal(new Date(record.expires_at) - new Date(record.created_at), 365 * 24 * 60 * 60 * 1000);
  assert.equal((await app.query('SELECT count(*)::integer AS count FROM reserved_event_slugs')).rows[0].count, 2);
  assert.equal((await app.query('SELECT count(*)::integer AS count FROM words')).rows[0].count, 0);
  assert.equal((await app.query('SELECT count(*)::integer AS count FROM configurations')).rows[0].count, 0);

  const payload = await fetch(`${app.baseUrl}/api/events/${first.slug}/configurator`);
  assert.equal(payload.status, 200);
  const data = await payload.json();
  assert.deepEqual(data.words, []);
  assert.equal(data.event.directDesign, true);
  assert.equal(data.product.key, DEFAULT_PRODUCT.key);
  assert.ok(data.products.length > 1, 'the usual product selector remains available');
  const page = await fetch(`${app.baseUrl}${first.location}`).then(response => response.text());
  assert.match(page, /const directDesign = true/);
  assert.match(page, /id="back-link"[^>]*href="\/"|href="\/"[^>]*id="back-link"/);
  assert.match(page, /Preparing your design/);

  const verify = await fetch(`${app.baseUrl}/api/events/${first.slug}/organizer/verify`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ pin: '1234' }),
  });
  assert.equal(verify.status, 409);
  assert.equal((await verify.json()).error, 'pin_not_configured');

  const cloud = await createEvent(app.baseUrl);
  const emptyCloud = await fetch(`${app.baseUrl}/api/events/${cloud.slug}/configurator?directDesign=true`);
  assert.equal(emptyCloud.status, 409, 'query parameters cannot turn a normal cloud into a direct design');
  assert.equal((await emptyCloud.json()).error, 'no_words');
});

test('direct custom designs save, reopen and freeze without live words while retaining isolation and validation', async (t) => {
  const app = await startTestServer();
  t.after(app.close);
  const event = await startDesign(app.baseUrl);
  const other = await startDesign(app.baseUrl);
  const cloud = await createEvent(app.baseUrl);
  const endpoint = `${app.baseUrl}/api/events/${event.slug}/configurations`;
  const save = body => fetch(endpoint, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  });
  for (const designs of [productDesignPayload().designs, {
    default: [{ id: 'heart-only', type: 'icon', icon: 'heart', x: 1350, y: 525,
      size: 170, angle: 0, color: '#d90368' }],
  }]) {
    const response = await save({ theme: 'pastel', words: [], designs });
    const configuration = await response.json();
    assert.equal(response.status, 201, JSON.stringify(configuration));
    const edit = await fetch(`${endpoint}/${configuration.id}/edit`).then(response => response.json());
    assert.deepEqual(edit.words, []);
    assert.equal(edit.designs.default[0].id, designs.default[0].id);
    const print = await fetch(app.baseUrl + configuration.printFileUrl);
    assert.equal(print.status, 200);
    const frozenSvg = await print.text();
    assert.match(frozenSvg, /<text |data-motif="heart"/);
    for (const slug of [other.slug, cloud.slug]) {
      assert.equal((await fetch(`${app.baseUrl}/api/events/${slug}/configurations/${configuration.id}/edit`)).status, 404);
    }
    await app.query('INSERT INTO words (event_id, word, count, updated_at) VALUES ((SELECT id FROM events WHERE slug = $1), $2, 1, now()) ON CONFLICT DO NOTHING',
      [event.slug, 'Später']);
    assert.equal(await fetch(app.baseUrl + configuration.printFileUrl).then(response => response.text()), frozenSvg);
  }
  for (const body of [
    { theme: 'pastel', words: [], designs: { default: [] } },
    { theme: 'pastel', words: 'bad', ...productDesignPayload() },
    { theme: 'pastel', words: [], designs: { default: [{ id: 'out-of-bounds', text: 'Wort',
      x: -1000, y: 525, fontSize: 96, color: '#d90368', angle: 0 }] } },
  ]) assert.equal((await save(body)).status, 400);
  const normalCloudSave = await fetch(`${app.baseUrl}/api/events/${cloud.slug}/configurations`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ theme: 'pastel', words: [], directDesign: true, ...productDesignPayload() }),
  });
  assert.equal(normalCloudSave.status, 400);
  assert.equal((await normalCloudSave.json()).error, 'invalid_words');

  await app.query("UPDATE events SET created_at = now() - interval '366 days' WHERE slug = $1", [event.slug]);
  assert.equal((await fetch(`${app.baseUrl}${event.location}`)).status, 404);
  assert.equal((await fetch(`${app.baseUrl}/api/events/${event.slug}/configurator`)).status, 404);
});

test('direct design creation shares the existing source limit with cloud creation', async (t) => {
  const app = await startTestServer();
  t.after(app.close);
  const { LIMITS } = require('../src/rateLimits');
  for (let i = 0; i < LIMITS.eventCreate.max; i += 1) await startDesign(app.baseUrl);
  const blocked = await fetch(`${app.baseUrl}/design/start`, { method: 'POST', redirect: 'manual' });
  assert.equal(blocked.status, 429);
  assert.match(await blocked.text(), /role="alert"/);
  const cloud = await fetch(`${app.baseUrl}/start`, {
    method: 'POST', redirect: 'manual',
    body: new URLSearchParams({ cloudName: 'Cloud', organizerPin: '1234', organizerPinConfirmation: '1234' }),
  });
  assert.equal(cloud.status, 429);
  assert.equal((await app.query('SELECT count(*)::integer AS count FROM events')).rows[0].count, LIMITS.eventCreate.max);
});

test('direct design creation retries reserved slugs and reports failure without partial records', async (t) => {
  const reserved = 'A'.repeat(22);
  const generator = t.mock.method(require('../src/slug'), 'generateEventSlug', () => reserved);
  const app = await startTestServer();
  t.after(app.close);
  await app.query('INSERT INTO reserved_event_slugs (slug, original_created_at) VALUES ($1, now())', [reserved]);
  const fresh = '-_AbCdEf0123456789xyZQ';
  const candidates = [reserved, fresh];
  generator.mock.mockImplementation(() => candidates.shift());
  assert.equal((await startDesign(app.baseUrl)).slug, fresh);
  generator.mock.mockImplementation(() => reserved);
  const calls = generator.mock.callCount();
  const response = await fetch(`${app.baseUrl}/design/start`, { method: 'POST', redirect: 'manual' });
  assert.equal(response.status, 500);
  assert.match(await response.text(), /role="alert"/);
  assert.equal(generator.mock.callCount() - calls, 20);
  assert.equal((await app.query('SELECT count(*)::integer AS count FROM events')).rows[0].count, 1);
});
