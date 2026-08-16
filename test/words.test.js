'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { io: ioClient } = require('socket.io-client');
const { startTestServer, createEvent } = require('./helpers');

// Resolves once the server's initial `word-update` has actually been
// received (not just once the transport-level `connect` fires) — see the
// detailed comment in isolation.test.js for why waiting on `connect` alone
// is a race against that first emission.
function connectSocket(baseUrl, slug) {
  return new Promise((resolve, reject) => {
    const socket = ioClient(baseUrl, { query: { slug }, transports: ['websocket'], forceNew: true });
    const cleanup = () => {
      socket.off('word-update', onReady);
      socket.off('connect_error', onErr);
    };
    const onReady = (initialWords) => { cleanup(); resolve({ socket, initialWords }); };
    const onErr = (err) => { cleanup(); reject(err); };
    socket.once('word-update', onReady);
    socket.once('connect_error', onErr);
  });
}

function waitFor(socket, event, timeoutMs = 2000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`timed out waiting for "${event}"`)), timeoutMs);
    socket.once(event, (payload) => { clearTimeout(timer); resolve(payload); });
  });
}

test('word submission -> live update flow: broadcast, atomic increment, normalization', async (t) => {
  const { baseUrl, close } = await startTestServer();
  t.after(close);

  const event = await createEvent(baseUrl, { coupleName: 'Liebe Lea' });

  const { socket: guest1 } = await connectSocket(baseUrl, event.slug);
  const { socket: guest2 } = await connectSocket(baseUrl, event.slug);
  const { socket: display } = await connectSocket(baseUrl, event.slug);
  t.after(() => { guest1.close(); guest2.close(); display.close(); });

  // guest1 submits "Liebe " (mixed case, padded) — should normalize to "liebe"
  // and be visible on the third, unrelated "display" socket too (room-wide
  // broadcast, not just an echo to the sender).
  const displaySeesIt = waitFor(display, 'word-update');
  const guest1Accepted = waitFor(guest1, 'word-accepted');
  guest1.emit('submit-word', '  Liebe  ');
  assert.equal(await guest1Accepted, 'liebe');
  assert.deepEqual(await displaySeesIt, [['liebe', 1]]);

  // guest2 submits the same word (different casing/whitespace) — atomic
  // upsert must increment the existing row, not create a duplicate.
  const displaySeesIncrement = waitFor(display, 'word-update');
  guest2.emit('submit-word', 'LIEBE');
  assert.deepEqual(await displaySeesIncrement, [['liebe', 2]]);

  // A different word creates a second, independent entry.
  const displaySeesSecondWord = waitFor(display, 'word-update');
  guest1.emit('submit-word', 'Glück');
  const words = await displaySeesSecondWord;
  assert.equal(words.length, 2);
  const asMap = new Map(words);
  assert.equal(asMap.get('liebe'), 2);
  assert.equal(asMap.get('glück'), 1);

  // Empty / whitespace-only submissions are silently ignored (no event).
  let sawUnexpectedUpdate = false;
  const guard = () => { sawUnexpectedUpdate = true; };
  display.on('word-update', guard);
  guest1.emit('submit-word', '     ');
  guest1.emit('submit-word', '');
  await new Promise((r) => setTimeout(r, 300));
  display.off('word-update', guard);
  assert.equal(sawUnexpectedUpdate, false, 'blank submissions must not trigger a broadcast');
});

test('a newly connecting socket receives current state, not an empty board', async (t) => {
  const { baseUrl, close } = await startTestServer();
  t.after(close);

  const event = await createEvent(baseUrl, { coupleName: 'Nachzügler Nadine' });

  const { socket: first } = await connectSocket(baseUrl, event.slug);
  t.after(() => first.close());

  const accepted = waitFor(first, 'word-accepted');
  first.emit('submit-word', 'vertrauen');
  await accepted;

  const { socket: second, initialWords } = await connectSocket(baseUrl, event.slug);
  t.after(() => second.close());
  assert.deepEqual(initialWords, [['vertrauen', 1]]);
});
