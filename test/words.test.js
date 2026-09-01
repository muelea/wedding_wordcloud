'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { io: ioClient } = require('socket.io-client');
const { startTestServer, createEvent } = require('./helpers');
const { groupContributions } = require('../public/js/own-word-groups');

test('owned contributions group repeated words while retaining one removable receipt per entry', () => {
  const groups = groupContributions([
    ['receipt-love-1', 'Love'],
    ['receipt-joy-1', 'Joy'],
    ['receipt-love-2', 'Love'],
  ], 'en');

  assert.deepEqual(groups, [
    ['Joy', ['receipt-joy-1']],
    ['Love', ['receipt-love-1', 'receipt-love-2']],
  ]);
  groups[1][1].pop();
  assert.deepEqual(groups[1], ['Love', ['receipt-love-1']],
    'removing one grouped entry must decrement the count instead of deleting the whole word');
});

// Resolves once the server's initial `word-update` has actually been
// received (not just once the transport-level `connect` fires) — see the
// detailed comment in isolation.test.js for why waiting on `connect` alone
// is a race against that first emission.
function connectSocket(baseUrl, slug, guestId) {
  return new Promise((resolve, reject) => {
    const socket = ioClient(baseUrl, {
      query: guestId ? { slug, guestId } : { slug },
      transports: ['websocket'],
      forceNew: true,
    });
    let initialWords;
    let ownWords;
    const cleanup = () => {
      socket.off('word-update', onWords);
      socket.off('own-word-update', onOwnWords);
      socket.off('connect_error', onErr);
    };
    const maybeReady = () => {
      if (initialWords === undefined || ownWords === undefined) return;
      cleanup();
      resolve({ socket, initialWords, ownWords });
    };
    const onWords = (words) => { initialWords = words; maybeReady(); };
    const onOwnWords = (words) => { ownWords = words; maybeReady(); };
    const onErr = (err) => { cleanup(); reject(err); };
    socket.once('word-update', onWords);
    socket.once('own-word-update', onOwnWords);
    socket.once('connect_error', onErr);
  });
}

function waitFor(socket, event, timeoutMs = 2000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`timed out waiting for "${event}"`)), timeoutMs);
    socket.once(event, (payload) => { clearTimeout(timer); resolve(payload); });
  });
}

function waitForArgs(socket, event, timeoutMs = 2000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`timed out waiting for "${event}"`)), timeoutMs);
    socket.once(event, (...args) => { clearTimeout(timer); resolve(args); });
  });
}

function emitWithAck(socket, event, payload, timeoutMs = 2000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`timed out waiting for "${event}" acknowledgement`)), timeoutMs);
    socket.emit(event, payload, (result) => { clearTimeout(timer); resolve(result); });
  });
}

test('word submission -> live update flow: broadcast, atomic increment, normalization', async (t) => {
  const { baseUrl, close } = await startTestServer();
  t.after(close);

  const event = await createEvent(baseUrl, { title: 'Liebe Lea' });
  const guest1Id = '1'.repeat(32);
  const guest2Id = '2'.repeat(32);

  const { socket: guest1, ownWords: guest1InitialOwnWords } = await connectSocket(baseUrl, event.slug, guest1Id);
  const { socket: guest2 } = await connectSocket(baseUrl, event.slug, guest2Id);
  const { socket: display } = await connectSocket(baseUrl, event.slug);
  t.after(() => { guest1.close(); guest2.close(); display.close(); });
  assert.deepEqual(guest1InitialOwnWords, []);

  // guest1 submits "Liebe " (mixed case, padded) — should normalize to "liebe"
  // and be visible on the third, unrelated "display" socket too (room-wide
  // broadcast, not just an echo to the sender).
  const displaySeesIt = waitFor(display, 'word-update');
  const guest1Accepted = waitForArgs(guest1, 'word-accepted');
  guest1.emit('submit-word', '  Liebe  ');
  const [guest1Love, guest1LoveReceipt] = await guest1Accepted;
  assert.equal(guest1Love, 'liebe');
  assert.match(guest1LoveReceipt, /^[A-Za-z0-9_-]{24}$/);
  assert.deepEqual(await displaySeesIt, [['liebe', 1]]);

  // guest2 submits the same word (different casing/whitespace) — atomic
  // upsert must increment the existing row, not create a duplicate.
  const displaySeesIncrement = waitFor(display, 'word-update');
  const guest2Accepted = waitForArgs(guest2, 'word-accepted');
  guest2.emit('submit-word', 'LIEBE');
  const [, guest2LoveReceipt] = await guest2Accepted;
  assert.deepEqual(await displaySeesIncrement, [['liebe', 2]]);

  // A different word creates a second, independent entry.
  const displaySeesSecondWord = waitFor(display, 'word-update');
  const guest1SecondAccepted = waitForArgs(guest1, 'word-accepted');
  guest1.emit('submit-word', 'Glück');
  const [guest1SecondWord, guest1SecondReceipt] = await guest1SecondAccepted;
  assert.equal(guest1SecondWord, 'glück');
  const words = await displaySeesSecondWord;
  assert.equal(words.length, 2);
  const asMap = new Map(words);
  assert.equal(asMap.get('liebe'), 2);
  assert.equal(asMap.get('glück'), 1);

  // Removing guest1's one "liebe" contribution decrements the aggregate
  // from two to one; it does not remove guest2's matching contribution.
  const displaySeesDecrement = waitFor(display, 'word-update');
  const removeGuest1Love = emitWithAck(guest1, 'remove-word', { receipt: guest1LoveReceipt });
  assert.deepEqual(await removeGuest1Love, { ok: true, word: 'liebe' });
  assert.deepEqual(new Map(await displaySeesDecrement), new Map([['liebe', 1], ['glück', 1]]));

  // Ownership survives a reconnect in the same anonymous browser session.
  // Only the still-active "glück" contribution is returned.
  const { socket: guest1Reloaded, ownWords: reloadedOwnWords } = await connectSocket(baseUrl, event.slug, guest1Id);
  t.after(() => guest1Reloaded.close());
  assert.deepEqual(reloadedOwnWords, [{ receipt: guest1SecondReceipt, word: 'glück' }]);

  // Even a valid receipt cannot be used from another guest session.
  let sawUnauthorizedUpdate = false;
  const unauthorizedGuard = () => { sawUnauthorizedUpdate = true; };
  display.on('word-update', unauthorizedGuard);
  const unauthorized = await emitWithAck(guest2, 'remove-word', { receipt: guest1SecondReceipt });
  await new Promise((r) => setTimeout(r, 200));
  display.off('word-update', unauthorizedGuard);
  assert.deepEqual(unauthorized, { ok: false, error: 'not_found' });
  assert.equal(sawUnauthorizedUpdate, false, 'another guest must not be able to remove this contribution');

  // The actual owner can remove the remaining "liebe" vote, so the word
  // disappears while the unrelated word remains.
  const displaySeesLoveDisappear = waitFor(display, 'word-update');
  const removeGuest2Love = emitWithAck(guest2, 'remove-word', { receipt: guest2LoveReceipt });
  assert.deepEqual(await removeGuest2Love, { ok: true, word: 'liebe' });
  assert.deepEqual(await displaySeesLoveDisappear, [['glück', 1]]);

  // A receipt is single-use: replaying it is rejected without another
  // decrement or room broadcast.
  let sawReplayUpdate = false;
  const replayGuard = () => { sawReplayUpdate = true; };
  display.on('word-update', replayGuard);
  const replay = await emitWithAck(guest2, 'remove-word', { receipt: guest2LoveReceipt });
  await new Promise((r) => setTimeout(r, 200));
  display.off('word-update', replayGuard);
  assert.deepEqual(replay, { ok: false, error: 'not_found' });
  assert.equal(sawReplayUpdate, false, 'a deletion receipt must only decrement once');

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

  const event = await createEvent(baseUrl, { title: 'Nachzügler Nadine' });

  const { socket: first } = await connectSocket(baseUrl, event.slug);
  t.after(() => first.close());

  const accepted = waitFor(first, 'word-accepted');
  first.emit('submit-word', 'vertrauen');
  await accepted;

  const { socket: second, initialWords } = await connectSocket(baseUrl, event.slug);
  t.after(() => second.close());
  assert.deepEqual(initialWords, [['vertrauen', 1]]);
});
