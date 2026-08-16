'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { io: ioClient } = require('socket.io-client');
const { startTestServer, createEvent } = require('./helpers');

// Resolves once the server's initial `word-update` (sent right after
// `connection` — see src/socket.js) has actually been received, not just
// once the transport-level `connect` event fires. Waiting on `connect`
// alone and THEN separately attaching a `word-update` listener on the next
// tick is a race: the server can emit before that listener exists, and a
// plain EventEmitter drops events nobody was listening for — there is no
// replay buffer. Registering `once('word-update', ...)` synchronously,
// before the connection even completes, closes that gap.
function connectSocket(baseUrl, slug) {
  return new Promise((resolve, reject) => {
    const socket = ioClient(baseUrl, { query: { slug }, transports: ['websocket'], forceNew: true });
    const cleanup = () => {
      socket.off('word-update', onReady);
      socket.off('fatal-error', onFatal);
      socket.off('connect_error', onErr);
    };
    const onReady = (initialWords) => { cleanup(); resolve({ socket, initialWords }); };
    const onFatal = (msg) => { cleanup(); socket.close(); reject(new Error(`fatal-error: ${msg}`)); };
    const onErr = (err) => { cleanup(); reject(err); };
    socket.once('word-update', onReady);
    socket.once('fatal-error', onFatal);
    socket.once('connect_error', onErr);
  });
}

function waitFor(socket, event, timeoutMs = 2000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`timed out waiting for "${event}"`)), timeoutMs);
    socket.once(event, (payload) => { clearTimeout(timer); resolve(payload); });
  });
}

// Collects every emission of `event` for a window of time, instead of just
// the first — used below to prove event B receives NOTHING at all while
// event A is active, not just "not the first thing".
function collectFor(socket, event, windowMs) {
  const seen = [];
  const handler = (payload) => seen.push(payload);
  socket.on(event, handler);
  return new Promise((resolve) => {
    setTimeout(() => { socket.off(event, handler); resolve(seen); }, windowMs);
  });
}

test('multi-tenant isolation: a word submitted to event A never reaches event B', async (t) => {
  const { baseUrl, close } = await startTestServer();
  t.after(close);

  const eventA = await createEvent(baseUrl, { coupleName: 'Alpha Aachen' });
  const eventB = await createEvent(baseUrl, { coupleName: 'Beta Berlin' });

  const { socket: socketA, initialWords: initialA } = await connectSocket(baseUrl, eventA.slug);
  const { socket: socketB } = await connectSocket(baseUrl, eventB.slug);
  t.after(() => { socketA.close(); socketB.close(); });

  assert.deepEqual(initialA, [], 'a fresh event should start with no words');

  const bUpdatesDuringA = collectFor(socketB, 'word-update', 800);

  const aGotUpdate = waitFor(socketA, 'word-update');
  socketA.emit('submit-word', 'geheimnis-von-a');
  const aWords = await aGotUpdate;

  assert.deepEqual(aWords, [['geheimnis-von-a', 1]], 'event A should see its own submitted word');

  const bUpdates = await bUpdatesDuringA;
  assert.equal(bUpdates.length, 0, 'event B must receive zero word-update emissions while only event A had activity');

  // Cross-check via the HTTP-visible state too: fetching event B's public
  // info + a fresh connect should show it never absorbed A's word.
  const { socket: socketB2, initialWords: bWords } = await connectSocket(baseUrl, eventB.slug);
  t.after(() => socketB2.close());
  assert.deepEqual(bWords, [], 'event B word list must remain empty — no leakage from event A');
});

test('multi-tenant isolation: theme-change on event A does not affect event B', async (t) => {
  const { baseUrl, close } = await startTestServer();
  t.after(close);

  const eventA = await createEvent(baseUrl, { coupleName: 'Gamma Gera' });
  const eventB = await createEvent(baseUrl, { coupleName: 'Delta Dresden' });

  const { socket: socketA } = await connectSocket(baseUrl, eventA.slug);
  const { socket: socketB } = await connectSocket(baseUrl, eventB.slug);
  t.after(() => { socketA.close(); socketB.close(); });

  const bThemeEvents = collectFor(socketB, 'theme-change', 700);
  socketA.emit('theme-change', 'neon');
  await new Promise((r) => setTimeout(r, 700));

  const events = await bThemeEvents;
  assert.equal(events.length, 0, 'event B must not receive event A\'s theme-change');
});

test('an unknown slug is rejected and disconnected rather than silently joined', async (t) => {
  const { baseUrl, close } = await startTestServer();
  t.after(close);

  const socket = ioClient(baseUrl, { query: { slug: 'does-not-exist' }, transports: ['websocket'], forceNew: true });
  t.after(() => socket.close());

  const msg = await waitFor(socket, 'fatal-error');
  assert.equal(msg, 'unknown event');
});
