'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { once } = require('node:events');
const { Server } = require('socket.io');
const { io: connect } = require('socket.io-client');
const db = require('../src/db');
const { attachSocketHandlers } = require('../src/socket');
const { createWordUpdateBroadcaster } = require('../src/wordBroadcasts');
const rateLimits = require('../src/rateLimits');
const { sourceHashForSocket } = require('../src/clientIdentity');

process.env.NODE_ENV = 'test';
const EVENT = { id: '1', slug: 'initialization', locale: 'de',
  expires_at: new Date(Date.now() + 60_000).toISOString() };
const OWNER = 'a'.repeat(32);
const RECEIPT = 'r'.repeat(24);

function deferred() {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
}

function nextEvent(socket, name) {
  return once(socket, name, { signal: AbortSignal.timeout(3_000) });
}

async function harness(t, { lookup = async () => EVENT, words = async () => [],
  receipts = async () => new Map(), add = async () => RECEIPT } = {}) {
  rateLimits.resetForTests();
  t.mock.method(db, 'getEventBySlug', lookup);
  t.mock.method(db, 'getWords', words);
  t.mock.method(db, 'getWordContributionsForOwners', receipts);
  t.mock.method(db, 'addWordContribution', add);
  const server = http.createServer();
  const io = new Server(server);
  const broadcasts = createWordUpdateBroadcaster({ io, getWords: words, windowMs: 10 });
  const runtime = attachSocketHandlers(io, { wordBroadcasts: broadcasts });
  const connected = nextEvent(io, 'connection');
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const client = connect(`http://127.0.0.1:${server.address().port}`, {
    query: { slug: EVENT.slug, guestId: OWNER }, transports: ['websocket'],
    forceNew: true, reconnection: false, autoConnect: false,
  });
  t.after(async () => {
    client.close();
    await new Promise((resolve) => io.close(resolve));
    runtime.stop();
    broadcasts.stop();
    rateLimits.resetForTests();
  });
  return { io, client, broadcasts, connected };
}

test('a submission received during event lookup waits for complete initialization', async (t) => {
  const lookup = deferred();
  let writes = 0;
  const { client, connected } = await harness(t, {
    lookup: () => lookup.promise,
    add: async () => { writes += 1; return RECEIPT; },
  });
  t.after(() => lookup.resolve(EVENT));
  const accepted = nextEvent(client, 'word-accepted');
  client.connect();
  const [serverSocket] = await connected;
  const received = nextEvent(serverSocket, 'submit-word');
  client.emit('submit-word', 'liebe');
  await received;
  assert.equal(writes, 0);
  lookup.resolve(EVENT);
  assert.deepEqual(await accepted, ['liebe', RECEIPT]);
  assert.equal(writes, 1);
});

test('a delayed initial read cannot overwrite a reset or restore deleted receipts', async (t) => {
  const oldWords = deferred();
  const oldReceipts = deferred();
  const readingReceipts = deferred();
  let wordReads = 0;
  let receiptReads = 0;
  const { client, broadcasts } = await harness(t, {
    words: () => ++wordReads === 1 ? oldWords.promise : Promise.resolve([]),
    receipts: () => {
      receiptReads += 1;
      readingReceipts.resolve();
      return receiptReads === 1 ? oldReceipts.promise : Promise.resolve(new Map());
    },
  });
  t.after(() => { oldWords.resolve([]); oldReceipts.resolve(new Map()); });
  const updates = [];
  client.on('word-update', (words) => updates.push(words));
  const own = nextEvent(client, 'own-word-update');
  client.connect();
  await readingReceipts.promise;
  const reset = nextEvent(client, 'word-update');
  broadcasts.resetRoom(EVENT, []);
  await reset;
  oldWords.resolve([['old', 1]]);
  oldReceipts.resolve(new Map([[`${EVENT.id}:${OWNER}`, [{ receipt: RECEIPT, word: 'old' }]]]));
  assert.deepEqual((await own)[0], []);
  assert.deepEqual(updates.at(-1), []);
});

test('initialization queues only a bounded burst and releases its reader after hydration', async (t) => {
  const lookup = deferred();
  let writes = 0;
  const { client, connected, broadcasts } = await harness(t, {
    lookup: () => lookup.promise,
    add: async () => { writes += 1; return RECEIPT; },
  });
  t.after(() => lookup.resolve(EVENT));
  const accepted = [];
  client.on('word-accepted', (word) => accepted.push(word));
  const limited = nextEvent(client, 'word-error');
  client.connect();
  await connected;
  // Oversized payloads cannot occupy one of the three retained action slots.
  client.emit('submit-word', 'x'.repeat(10_000));
  for (const word of ['eins', 'zwei', 'drei', 'vier']) client.emit('submit-word', word);
  assert.deepEqual((await limited)[0], { error: 'rate_limited' });
  assert.equal(writes, 0);
  const complete = new Promise((resolve) => client.on('word-accepted', () => {
    if (accepted.length === 3) resolve();
  }));
  lookup.resolve(EVENT);
  await complete;
  assert.equal(writes, 3);
  assert.deepEqual(accepted, ['eins', 'zwei', 'drei']);
  assert.equal(broadcasts.initialReaderCount, 0);
});

test('a room update while ownership loads is never overwritten by the initial words', async (t) => {
  const oldReceipts = deferred();
  const reading = deferred();
  let wordReads = 0;
  const { client, broadcasts } = await harness(t, {
    words: async () => ++wordReads === 1 ? [['old', 1]] : [['new', 1]],
    receipts: () => { reading.resolve(); return oldReceipts.promise; },
  });
  t.after(() => oldReceipts.resolve(new Map()));
  const updates = [];
  client.on('word-update', (words) => updates.push(words));
  const own = nextEvent(client, 'own-word-update');
  client.connect();
  await reading.promise;
  const fresh = new Promise((resolve) => client.on('word-update', (words) => {
    if (words[0]?.[0] === 'new') resolve();
  }));
  broadcasts.schedule(EVENT, { ownerId: 'b'.repeat(32) });
  await fresh;
  oldReceipts.resolve(new Map());
  await own;
  assert.deepEqual(updates.at(-1), [['new', 1]]);
});

test('disconnecting during lookup cannot consume a socket slot or execute queued submissions', async (t) => {
  const lookup = deferred();
  let writes = 0;
  const { client, connected } = await harness(t, {
    lookup: () => lookup.promise,
    add: async () => { writes += 1; return RECEIPT; },
  });
  t.after(() => lookup.resolve(EVENT));
  client.connect();
  const [serverSocket] = await connected;
  const received = nextEvent(serverSocket, 'submit-word');
  client.emit('submit-word', 'liebe');
  await received;
  const disconnected = nextEvent(serverSocket, 'disconnect');
  client.close();
  await disconnected;
  lookup.resolve(EVENT);
  // Complete the event lookup continuations; the ownership batch has a 15ms window.
  await new Promise((resolve) => setTimeout(resolve, 40));
  const releases = [];
  try {
    for (let i = 0; i < rateLimits.LIMITS.socketSource.max; i += 1) {
      const release = rateLimits.acquireSocket(EVENT.id, sourceHashForSocket(serverSocket));
      if (release) releases.push(release);
    }
    assert.equal(releases.length, rateLimits.LIMITS.socketSource.max);
    assert.equal(writes, 0);
  } finally { releases.forEach((release) => release()); }
});
