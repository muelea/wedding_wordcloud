'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { io: ioClient } = require('socket.io-client');
const { startTestServer, createEvent } = require('./helpers');

function connectSocket(baseUrl, slug) {
  return new Promise((resolve, reject) => {
    const socket = ioClient(baseUrl, { query: { slug }, transports: ['websocket'], forceNew: true });
    const timer = setTimeout(() => reject(new Error('socket connection timed out')), 2000);
    socket.once('word-update', () => {
      clearTimeout(timer);
      resolve(socket);
    });
    socket.once('connect_error', reject);
  });
}

function submitWord(socket, word) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`submission timed out: ${word}`)), 2000);
    socket.once('word-accepted', (accepted) => {
      clearTimeout(timer);
      resolve(accepted);
    });
    socket.emit('submit-word', word);
  });
}

test('configurator exposes the verified Printful 11oz mug geometry for an event with words', async (t) => {
  const { baseUrl, close } = await startTestServer();
  t.after(close);
  const event = await createEvent(baseUrl, { coupleName: 'Mara & Theo' });

  const empty = await fetch(`${baseUrl}/api/events/${event.slug}/configurator`);
  assert.equal(empty.status, 409, 'an empty cloud cannot be configured');

  const socket = await connectSocket(baseUrl, event.slug);
  t.after(() => socket.close());
  await submitWord(socket, 'Liebe');

  const res = await fetch(`${baseUrl}/api/events/${event.slug}/configurator`);
  assert.equal(res.status, 200);
  const data = await res.json();
  assert.equal(data.product.key, 'white-glossy-mug-duo-11oz');
  assert.deepEqual(data.product.printFile, { width: 2700, height: 1050, dpi: 300, placement: 'default' });
  assert.equal(data.product.size.volumeMl, 325);
  assert.equal(data.product.defaultQuantity, 2);
  assert.equal(data.product.minQuantity, 1);
  assert.equal(data.product.maxQuantity, 99);
  assert.equal(data.product.unitPriceCents, 1745);
  assert.deepEqual(
    data.product.themes.map((theme) => theme.key),
    ['pastel', 'rose-garden', 'sage-gold', 'terracotta', 'ocean', 'classic', 'neon']
  );
  assert.ok(data.product.themes.every((theme) => theme.colors.length >= 6));
  assert.deepEqual(data.product.layouts.map((layout) => layout.key), ['single', 'both-sides', 'full-wrap']);
  assert.deepEqual(data.product.layoutGeometry.single, [{ x: 127, y: 65, side: 920 }]);
  assert.deepEqual(data.product.layoutGeometry['full-wrap'], [{ x: 130, y: 65, width: 2440, height: 920 }]);
  assert.deepEqual(data.words, [['liebe', 1]]);

  const threeBrowserBuild = await fetch(`${baseUrl}/vendor/three.min.js?v=0.160.1`);
  assert.equal(threeBrowserBuild.status, 200);
  assert.match(threeBrowserBuild.headers.get('cache-control') || '', /immutable/);
  assert.ok((await threeBrowserBuild.text()).length > 600000, 'the local Three.js build should be served in full');

  const fabricBrowserBuild = await fetch(`${baseUrl}/vendor/fabric.min.js?v=7.4.0`);
  assert.equal(fabricBrowserBuild.status, 200);
  assert.match(fabricBrowserBuild.headers.get('cache-control') || '', /immutable/);
  assert.ok((await fabricBrowserBuild.text()).length > 250000, 'the local Fabric.js build should be served in full');
});

test('confirmed configuration freezes the approved words in a permanent Printful-sized SVG', async (t) => {
  const { baseUrl, close } = await startTestServer();
  t.after(close);
  const event = await createEvent(baseUrl, { coupleName: 'Freeze Frieda & Emil' });
  const socket = await connectSocket(baseUrl, event.slug);
  t.after(() => socket.close());

  await submitWord(socket, 'Liebe');
  await submitWord(socket, 'Liebe');
  await submitWord(socket, 'Glück');

  const snapshot = [['liebe', 2], ['glück', 1]];
  const save = await fetch(`${baseUrl}/api/events/${event.slug}/configurations`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      productKey: 'white-glossy-mug-duo-11oz',
      quantity: 7,
      theme: 'pastel',
      placement: 'single',
      words: snapshot,
    }),
  });
  assert.equal(save.status, 201);
  const configuration = await save.json();
  assert.match(configuration.id, /^[A-Za-z0-9_-]{16}$/);
  assert.equal(configuration.quantity, 7);
  assert.equal(configuration.unitPriceCents, 1745);
  assert.equal(configuration.totalPriceCents, 12215);

  // The live event keeps changing after approval.
  await submitWord(socket, 'Später');

  const printRes = await fetch(baseUrl + configuration.printFileUrl);
  assert.equal(printRes.status, 200);
  assert.match(printRes.headers.get('content-type') || '', /image\/svg\+xml/);
  assert.match(printRes.headers.get('cache-control') || '', /immutable/);
  const svg = await printRes.text();
  assert.match(svg, /width="2700" height="1050"/);
  assert.match(svg, /data-background="transparent"/);
  assert.doesNotMatch(svg, /<rect\b/, 'the Printful file must not print a background');
  assert.ok(svg.includes('>liebe</text>'));
  assert.ok(svg.includes('>glück</text>'));
  assert.ok(!svg.includes('später'), 'words submitted after approval must never enter the saved print file');
  assert.equal((svg.match(/<text /g) || []).length, snapshot.length);
});

test('two-sided placement prints each approved word exactly twice and rejects invalid options', async (t) => {
  const { baseUrl, close } = await startTestServer();
  t.after(close);
  const event = await createEvent(baseUrl, { coupleName: 'Doppelseite Dana' });

  const invalid = await fetch(`${baseUrl}/api/events/${event.slug}/configurations`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ theme: 'rainbow', placement: 'everywhere', words: [['liebe', 1]] }),
  });
  assert.equal(invalid.status, 400);

  const invalidQuantity = await fetch(`${baseUrl}/api/events/${event.slug}/configurations`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ quantity: 100, theme: 'pastel', placement: 'single', words: [['liebe', 1]] }),
  });
  assert.equal(invalidQuantity.status, 400);
  assert.equal((await invalidQuantity.json()).error, 'invalid_quantity');

  const save = await fetch(`${baseUrl}/api/events/${event.slug}/configurations`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ quantity: 1, theme: 'sage-gold', placement: 'both-sides', words: [['liebe & treue', 3], ['spaß', 2]] }),
  });
  assert.equal(save.status, 201);
  const configuration = await save.json();
  const svg = await fetch(baseUrl + configuration.printFileUrl).then((res) => res.text());
  assert.equal((svg.match(/<text /g) || []).length, 4);
  assert.equal((svg.match(/liebe &amp; treue/g) || []).length, 2);
  assert.equal((svg.match(/>spaß<\/text>/g) || []).length, 2);
  assert.match(svg, /fill="#425b4a"/);
  assert.doesNotMatch(svg, /<rect\b/);

  const fullWrapSave = await fetch(`${baseUrl}/api/events/${event.slug}/configurations`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ quantity: 3, theme: 'ocean', placement: 'full-wrap', words: [['liebe', 3], ['spaß', 2]] }),
  });
  assert.equal(fullWrapSave.status, 201);
  const fullWrapConfiguration = await fullWrapSave.json();
  const fullWrapSvg = await fetch(baseUrl + fullWrapConfiguration.printFileUrl).then((res) => res.text());
  assert.match(fullWrapSvg, /data-cloud="full-wrap"/);
  assert.equal((fullWrapSvg.match(/<text /g) || []).length, 2);
  assert.equal((fullWrapSvg.match(/<g data-cloud=/g) || []).length, 1);
  assert.match(fullWrapSvg, /fill="#173a4a"/);
  assert.doesNotMatch(fullWrapSvg, /<rect\b/);
});

test('custom editor design is frozen exactly and cannot leave the printable area', async (t) => {
  const { baseUrl, close } = await startTestServer();
  t.after(close);
  const event = await createEvent(baseUrl, { coupleName: 'Editor Ella & Finn' });
  const words = [['ursprünglich', 2], ['liebe', 1]];
  const design = [
    { id: 'wort-1', text: 'Unser Wort', x: 1280, y: 460, fontSize: 118, angle: 15, color: '#123456' },
    { id: 'wort-2', text: 'für immer', x: 1550, y: 655, fontSize: 82, angle: -30, color: '#abcdef' },
  ];

  const save = await fetch(`${baseUrl}/api/events/${event.slug}/configurations`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      productKey: 'white-glossy-mug-duo-11oz',
      quantity: 2,
      theme: 'pastel',
      placement: 'full-wrap',
      words,
      design,
    }),
  });
  assert.equal(save.status, 201);
  const configuration = await save.json();
  const svg = await fetch(baseUrl + configuration.printFileUrl).then((res) => res.text());
  assert.match(svg, /data-cloud="full-wrap" data-custom="true"/);
  assert.match(svg, /x="1280\.0"/);
  assert.match(svg, /font-size="118\.0"/);
  assert.match(svg, /transform="rotate\(15\.0 1280\.0 460\.0\)"/);
  assert.match(svg, /fill="#123456"/);
  assert.match(svg, />Unser Wort<\/text>/);
  assert.match(svg, />für immer<\/text>/);
  assert.doesNotMatch(svg, />ursprünglich<\/text>/, 'the edited design, not the original cloud, is printed');
  assert.equal((svg.match(/<text /g) || []).length, 2);
  assert.doesNotMatch(svg, /<rect\b/);

  const outside = await fetch(`${baseUrl}/api/events/${event.slug}/configurations`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      quantity: 2,
      theme: 'pastel',
      placement: 'single',
      words,
      design: [{ id: 'outside', text: 'zu weit', x: 10, y: 500, fontSize: 100, angle: 0, color: '#123456' }],
    }),
  });
  assert.equal(outside.status, 400);
  assert.equal((await outside.json()).error, 'invalid_design');
});
