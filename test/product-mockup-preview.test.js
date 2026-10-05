'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { JSDOM } = require('jsdom');
const Mockups = require('../public/js/product-mockup-preview');

const endpoint = `/api/events/${'e'.repeat(22)}/configurations/${'c'.repeat(16)}/mockups`;
const imageUrl = 'https://printful-upload.s3-accelerate.amazonaws.com/tmp/preview.png';
const jobId = 'j'.repeat(24);

function harness(t) {
  const dom = new JSDOM('', { url: 'https://example.test' });
  t.after(() => dom.window.close());
  let time = 1_000_000;
  const requests = [];
  const replies = [];
  const options = { window: dom.window, now: () => time,
    wait: async ms => { time += ms; },
    fetchImpl: async (url, init) => {
      requests.push({ url, ...init });
      const next = replies.shift();
      if (next instanceof Error) throw next;
      assert.ok(next, `unexpected request: ${url}`);
      return { ok: !next.error, status: next.error ? 429 : 200,
        headers: { get: () => next.retryAfter || null }, json: async () => next };
    },
  };
  const completed = () => ({ status: 'completed', expiresAt: time + Mockups.CACHE_MS,
    mockups: [{ url: imageUrl }] });
  return { window: dom.window, client: Mockups.create(options), options, requests, replies, completed,
    advance: ms => { time += ms; } };
}

test('mockups are explicit, share pending requests, poll, and cache only links across reloads', async t => {
  const h = harness(t);
  assert.equal(h.requests.length, 0);
  h.replies.push({ jobId }, { status: 'pending' }, h.completed());
  const first = h.client.load(endpoint);
  assert.equal(h.client.load(endpoint), first);
  assert.equal(h.client.get(endpoint).status, 'loading');
  const result = await first;
  assert.deepEqual(result.urls, [imageUrl]);
  assert.equal(h.requests.filter(request => request.method === 'POST').length, 1);
  assert.equal(h.requests[0].headers['X-Wolkenworte-Preview'], 'product-mockup');
  assert.equal(h.requests[1].url, `${endpoint}/${jobId}`);
  const stored = JSON.parse(h.window.localStorage.getItem(Mockups.STORAGE_KEY));
  assert.deepEqual(Object.keys(stored[endpoint]).sort(), ['expiresAt', 'urls']);
  assert.doesNotMatch(JSON.stringify(stored), /data:|base64|design_json/);
  assert.equal(Mockups.create(h.options).get(endpoint).status, 'completed');
  await Mockups.create(h.options).load(endpoint);
  assert.equal(h.requests.length, 3, 'reopening or reloading must not generate or poll again');
});

test('expiry, a new immutable design and a broken cached image require explicit generation', async t => {
  const h = harness(t);
  h.replies.push({ jobId }, h.completed());
  await h.client.load(endpoint);
  const another = endpoint.replace('/' + 'c'.repeat(16) + '/', '/' + 'd'.repeat(16) + '/');
  assert.equal(h.client.get(another).status, 'idle');
  h.client.invalidate(endpoint);
  assert.equal(h.client.get(endpoint).status, 'idle');
  assert.equal(h.requests.length, 2, 'image failure must not automatically regenerate');
  h.replies.push({ jobId }, h.completed());
  await h.client.load(endpoint);
  assert.equal(JSON.parse(h.requests[2].body).refresh, true);
  h.advance(Mockups.CACHE_MS + 1);
  assert.equal(h.client.get(endpoint).status, 'idle');
  assert.equal(h.requests.length, 4, 'cache expiry must not automatically regenerate');
});

test('provider throttling exposes the wait time and never automatically retries', async t => {
  const h = harness(t);
  h.replies.push({ error: 'mockup_rate_limited', retryAfter: 40 });
  await assert.rejects(h.client.load(endpoint), error => error.retryAfter === 40);
  assert.equal(h.requests.length, 1);
  assert.equal(h.client.get(endpoint).status, 'idle');
  assert.equal(h.window.localStorage.getItem(Mockups.STORAGE_KEY), null);
  h.replies.push({ jobId }, h.completed());
  await h.client.load(endpoint);
  assert.equal(h.requests.filter(request => request.method === 'POST').length, 2);
});

test('storage failures still permit memory caching and unsafe cached URLs are ignored', async t => {
  const h = harness(t);
  h.window.localStorage.setItem(Mockups.STORAGE_KEY, JSON.stringify({ [endpoint]: {
    expiresAt: 1_000_000 + Mockups.CACHE_MS, urls: ['https://attacker.test/image.png'],
  } }));
  assert.equal(h.client.get(endpoint).status, 'idle');
  Object.defineProperty(h.window, 'localStorage', { get() { throw new Error('blocked'); } });
  h.replies.push({ jobId }, h.completed());
  await h.client.load(endpoint);
  await h.client.load(endpoint);
  assert.equal(h.requests.length, 2);
  await assert.rejects(h.client.load('https://attacker.test/mockups'));
  assert.equal(h.requests.length, 2);
});

test('a server restart or failed provider task leaves a manual retry available', async t => {
  const h = harness(t);
  h.replies.push({ jobId }, new Error('job disappeared after restart'));
  await assert.rejects(h.client.load(endpoint));
  h.replies.push({ jobId }, { status: 'failed' });
  await assert.rejects(h.client.load(endpoint));
  assert.equal(h.client.get(endpoint).status, 'idle');
  assert.equal(h.requests.length, 4);
});
