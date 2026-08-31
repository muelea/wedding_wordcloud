'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { io: ioClient } = require('socket.io-client');
const { createWordUpdateBroadcaster } = require('../src/wordBroadcasts');
const { createSocketEventCache } = require('../src/socketEventCache');
const { createSocketOwnershipLoader, requestKey } = require('../src/socketOwnershipLoader');
const { startTestServer, createEvent } = require('./helpers');
const {
  DEFAULTS,
  distribution,
  flyAuthorization,
  flyAuthorizations,
  flyTokenFromJson,
  parseArgs,
  summarizeFulfillmentRecovery,
  validateOptions,
  wordsAreScoped,
} = require('../scripts/socket-capacity');

const delay = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));

function fakeIo(emissions, roomSizes = {}) {
  const rooms = new Map(Object.entries(roomSizes).map(([slug, size]) => [
    slug,
    new Set(Array.from({ length: size }, (_, index) => `${slug}-${index}`)),
  ]));
  return {
    sockets: { adapter: { rooms } },
    to(slug) {
      return {
        emit(event, payload) { emissions.push({ slug, event, payload, at: Date.now() }); },
      };
    },
  };
}

function connectSocket(baseUrl, slug, guestId, options = {}) {
  return new Promise((resolve, reject) => {
    const socket = ioClient(baseUrl, {
      query: { slug, guestId },
      transports: options.transports || ['websocket'],
      upgrade: options.upgrade,
      forceNew: true,
      reconnection: false,
    });
    let words;
    let ownWords;
    const timer = setTimeout(() => finish(new Error('initial snapshot timed out')), 8_000);
    function cleanup() {
      clearTimeout(timer);
      socket.off('word-update', onWords);
      socket.off('own-word-update', onOwnWords);
      socket.off('fatal-error', onFatal);
      socket.off('connect_error', finish);
    }
    function finish(error) {
      if (error) {
        cleanup();
        socket.close();
        reject(error);
      } else if (words !== undefined && ownWords !== undefined) {
        cleanup();
        resolve({ socket, words, ownWords });
      }
    }
    function onWords(value) { words = value; finish(); }
    function onOwnWords(value) { ownWords = value; finish(); }
    function onFatal(message) { finish(new Error(`fatal-error: ${message}`)); }
    socket.once('word-update', onWords);
    socket.once('own-word-update', onOwnWords);
    socket.once('fatal-error', onFatal);
    socket.once('connect_error', finish);
  });
}

test('Socket.io coalescing, bounded snapshots and performance probe', async (t) => {
  await t.test('capacity tooling is guarded and cannot silently lower the qualifying target', () => {
    const env = {
      DATABASE_URL: 'postgresql://runtime@example.invalid/postgres',
      MAINTENANCE_SECRET: 'm'.repeat(32),
    };
    assert.throws(() => validateOptions(parseArgs([]), env), /confirm-capacity-test/);
    assert.throws(() => validateOptions(parseArgs([
      '--confirm-capacity-test', '--url', 'https://example.com',
    ]), env), /wolkenworte\.fly\.dev/);
    assert.throws(() => validateOptions(parseArgs([
      '--confirm-capacity-test', '--sockets', '1999',
    ]), env), /qualifying run/);
    const quick = validateOptions(parseArgs([
      '--confirm-capacity-test', '--quick', '--rooms', '2', '--sockets', '2',
      '--hot-room-sockets', '1', '--polling-sockets', '1', '--skip-restart',
    ]), env);
    assert.equal(quick.quick, true);
    assert.equal(quick.sockets, 2);
  });

  await t.test('capacity statistics and room validators are deterministic', () => {
    const env = {
      DATABASE_URL: 'postgresql://runtime@example.invalid/postgres',
      MAINTENANCE_SECRET: 'm'.repeat(32),
    };
    assert.deepEqual(distribution([1, 2, 3, 4, 100]), {
      count: 5, p50: 3, p95: 100, p99: 100, max: 100,
    });
    const room = { prefix: 'r007-' };
    assert.equal(wordsAreScoped([['r007-liebe', 1], ['r007-glueck', 2]], room), true);
    assert.equal(wordsAreScoped([['r008-geheim', 1]], room), false);
    assert.equal(flyTokenFromJson(JSON.stringify({ token: 'FlyV1 test' })), 'FlyV1 test');
    assert.equal(flyAuthorization('FlyV1 test'), 'FlyV1 test');
    assert.equal(flyAuthorization('short-lived-token'), 'Bearer short-lived-token');
    assert.deepEqual(flyAuthorizations('short-lived-token'), [
      'Bearer short-lived-token', 'FlyV1 short-lived-token',
    ]);
    assert.equal(DEFAULTS.rooms, 100);
    assert.equal(DEFAULTS.sockets, 2_000);
    assert.equal(DEFAULTS.pollingSockets, 20);
    assert.equal(DEFAULTS.configurationSaves, 10);
    assert.equal(DEFAULTS.estimates, 5);
    assert.throws(() => validateOptions({
      ...parseArgs(['--confirm-capacity-test']), configurationSaves: 9,
    }, env), /10 configuration saves/);
    assert.throws(() => validateOptions({
      ...parseArgs(['--confirm-capacity-test']), estimates: 11,
    }, env), /cannot exceed/);
    for (const page of ['display.ejs']) {
      const source = fs.readFileSync(path.join(__dirname, '..', 'views', page), 'utf8');
      assert.match(source, /transports:\s*\['websocket', 'polling'\]/);
      assert.match(source, /tryAllTransports:\s*true/);
      assert.match(source, /timeout:\s*7000/);
      assert.match(source, /connect_error[\s\S]*?\['polling', 'websocket'\]/);
      assert.match(source, /if \(!socketHasConnected\)/);
    }
  });

  await t.test('interrupted fulfillment recovery requires a completed mock and a cleared lease', () => {
    const fixture = { initialStatus: 'processing', seededAt: 1_000 };
    assert.deepEqual(summarizeFulfillmentRecovery(fixture, {
      fulfillment_status: 'mocked', fulfillment_attempts: 2,
      fulfillment_locked_by: null, fulfillment_locked_until: null,
    }, 2_500), {
      initialStatus: 'processing', finalStatus: 'mocked', leaseCleared: true,
      attempts: 2, recoveryMs: 1_500, recovered: true,
    });
    assert.equal(summarizeFulfillmentRecovery(fixture, {
      fulfillment_status: 'processing', fulfillment_attempts: 1,
      fulfillment_locked_by: 'old-worker', fulfillment_locked_until: new Date(),
    }, 2_500).recovered, false);
  });

  await t.test('restart ownership hydration batches exact event-owner pairs without caching', async () => {
    const batches = [];
    const loader = createSocketOwnershipLoader({
      windowMs: 5,
      maxPending: 3,
      loadBatch: async (requests) => {
        batches.push(requests);
        return new Map(requests.map(({ eventId, ownerId }) => [
          requestKey(eventId, ownerId),
          ownerId === 'owner-a' ? [{ receipt: 'receipt-a', word: 'alpha' }] : [],
        ]));
      },
    });
    const [ownerA, ownerADuplicate, ownerB] = await Promise.all([
      loader.load('event-1', 'owner-a'),
      loader.load('event-1', 'owner-a'),
      loader.load('event-2', 'owner-b'),
    ]);
    assert.equal(batches.length, 1);
    assert.equal(batches[0].length, 2);
    assert.deepEqual(ownerA, [{ receipt: 'receipt-a', word: 'alpha' }]);
    assert.deepEqual(ownerADuplicate, ownerA);
    assert.deepEqual(ownerB, []);

    await loader.load('event-1', 'owner-a');
    assert.equal(batches.length, 2, 'completed ownership results must not become stale cache entries');
    loader.stop();
    await assert.rejects(loader.load('event-1', 'owner-c'), /stopped/);

    let activeBatches = 0;
    let peakBatches = 0;
    const serialLoader = createSocketOwnershipLoader({
      windowMs: 1,
      batchSize: 1,
      loadBatch: async (requests) => {
        activeBatches += 1;
        peakBatches = Math.max(peakBatches, activeBatches);
        await delay(5);
        activeBatches -= 1;
        return new Map(requests.map(({ eventId, ownerId }) => [
          requestKey(eventId, ownerId), [],
        ]));
      },
    });
    await Promise.all([
      serialLoader.load('event-1', 'owner-a'),
      serialLoader.load('event-1', 'owner-b'),
      serialLoader.load('event-2', 'owner-c'),
    ]);
    assert.equal(peakBatches, 1, 'database ownership batches must stay serial and bounded');
    serialLoader.stop();
  });

  await t.test('one room burst performs one fetch/emission and never merges slugs', async () => {
    const emissions = [];
    const calls = new Map();
    const broadcaster = createWordUpdateBroadcaster({
      io: fakeIo(emissions, { alpha: 3, beta: 2 }),
      windowMs: 25,
      getWords: async (eventId) => {
        calls.set(eventId, (calls.get(eventId) || 0) + 1);
        return [[`event-${eventId}`, 1]];
      },
    });
    for (let index = 0; index < 30; index += 1) {
      assert.equal(broadcaster.schedule({ id: 1, slug: 'alpha' }), true);
    }
    assert.equal(broadcaster.schedule({ id: 2, slug: 'beta' }), true);
    assert.equal(broadcaster.pendingRoomCount, 2);
    await delay(80);
    assert.equal(calls.get(1), 1);
    assert.equal(calls.get(2), 1);
    assert.deepEqual(emissions.map(({ slug, payload }) => ({ slug, payload })), [
      { slug: 'alpha', payload: [['event-1', 1]] },
      { slug: 'beta', payload: [['event-2', 1]] },
    ]);
    assert.equal(broadcaster.pendingRoomCount, 0);
    broadcaster.stop();
  });

  await t.test('connection storms share bounded event and initial-room lookups', async () => {
    let eventCalls = 0;
    const eventCache = createSocketEventCache({
      getEventBySlug: async (slug) => {
        eventCalls += 1;
        await delay(10);
        return { id: 1, slug, expires_at: new Date(Date.now() + 60_000).toISOString() };
      },
      ttlMs: 1_000,
      maxEvents: 2,
    });
    const events = await Promise.all(Array.from({ length: 300 }, () => eventCache.get('alpha')));
    assert.equal(eventCalls, 1);
    assert.ok(events.every((event) => event.slug === 'alpha'));
    assert.equal(eventCache.size, 1);

    let wordCalls = 0;
    const broadcaster = createWordUpdateBroadcaster({
      io: fakeIo([]),
      getWords: async () => {
        wordCalls += 1;
        await delay(10);
        return [['alpha-word', 1]];
      },
    });
    const event = events[0];
    const snapshots = await Promise.all(Array.from({ length: 300 }, () => broadcaster.loadInitial(event)));
    assert.equal(wordCalls, 1);
    assert.ok(snapshots.every((words) => words[0][0] === 'alpha-word'));
    await broadcaster.loadInitial(event);
    assert.equal(wordCalls, 2, 'completed loads are not a stale snapshot cache');
    broadcaster.stop();
    eventCache.stop();
    assert.equal(eventCache.size, 0);
  });

  await t.test('reset invalidation fences an older in-flight snapshot', async () => {
    const emissions = [];
    let releaseOld;
    let calls = 0;
    const broadcaster = createWordUpdateBroadcaster({
      io: fakeIo(emissions),
      windowMs: 10,
      getWords: async () => {
        calls += 1;
        if (calls === 1) {
          return new Promise((resolve) => { releaseOld = () => resolve([['stale', 1]]); });
        }
        return [['fresh', 1]];
      },
    });
    const event = { id: 1, slug: 'alpha' };
    broadcaster.schedule(event);
    await delay(25);
    broadcaster.resetRoom(event, []);
    broadcaster.schedule(event);
    releaseOld();
    await delay(50);
    assert.deepEqual(emissions.map(({ payload }) => payload), [[], [['fresh', 1]]]);
    assert.equal(broadcaster.pendingRoomCount, 0);
    broadcaster.stop();
  });

  await t.test('the pending-room ceiling is explicit and entries are reusable after cleanup', async () => {
    const broadcaster = createWordUpdateBroadcaster({
      io: fakeIo([]),
      windowMs: 10,
      maxPendingRooms: 1,
      getWords: async () => [],
      logger: { error() {} },
    });
    assert.equal(broadcaster.schedule({ id: 1, slug: 'alpha' }), true);
    assert.equal(broadcaster.schedule({ id: 2, slug: 'beta' }), false);
    await delay(30);
    assert.equal(broadcaster.pendingRoomCount, 0);
    assert.equal(broadcaster.schedule({ id: 2, slug: 'beta' }), true);
    broadcaster.stop();
    assert.equal(broadcaster.pendingRoomCount, 0);
  });

  await t.test('three committed submissions coalesce into one isolated complete room update', async () => {
    const app = await startTestServer();
    t.after(app.close);
    const eventA = await createEvent(app.baseUrl, { coupleName: 'Coalesce Alpha' });
    const eventB = await createEvent(app.baseUrl, { coupleName: 'Coalesce Beta' });
    const sender = await connectSocket(app.baseUrl, eventA.slug, 'a'.repeat(32));
    const display = await connectSocket(app.baseUrl, eventA.slug, 'b'.repeat(32));
    const foreign = await connectSocket(app.baseUrl, eventB.slug, 'c'.repeat(32));
    t.after(() => {
      sender.socket.close();
      display.socket.close();
      foreign.socket.close();
    });

    const updates = [];
    const foreignUpdates = [];
    const accepted = [];
    display.socket.on('word-update', (words) => updates.push({ words, at: Date.now() }));
    foreign.socket.on('word-update', (words) => foreignUpdates.push(words));
    sender.socket.on('word-accepted', (word) => accepted.push(word));
    sender.socket.emit('submit-word', 'eins');
    sender.socket.emit('submit-word', 'zwei');
    sender.socket.emit('submit-word', 'drei');
    const deadline = Date.now() + 4_000;
    while ((accepted.length < 3 || !updates.some((snapshot) => snapshot.words.length === 3)) &&
      Date.now() < deadline) await delay(10);
    await delay(120);

    assert.deepEqual(accepted.sort(), ['drei', 'eins', 'zwei']);
    assert.ok(updates.length >= 1 && updates.length <= 3);
    for (let index = 1; index < updates.length; index += 1) {
      // Remote Postgres commits can straddle coalescing windows; emissions
      // must still be separated by the production 100 ms bound.
      assert.ok(updates[index].at - updates[index - 1].at >= 90);
    }
    assert.deepEqual(new Map(updates.at(-1).words), new Map([
      ['drei', 1], ['eins', 1], ['zwei', 1],
    ]));
    assert.deepEqual(foreignUpdates, []);
  });

  await t.test('shutdown-style transport closure preserves automatic reconnection', async () => {
    const app = await startTestServer();
    t.after(app.close);
    const event = await createEvent(app.baseUrl, { coupleName: 'Reconnect Transport' });
    const socket = ioClient(app.baseUrl, {
      query: { slug: event.slug, guestId: 'e'.repeat(32) },
      transports: ['websocket'],
      forceNew: true,
      reconnection: true,
      reconnectionDelay: 10,
      reconnectionDelayMax: 50,
    });
    t.after(() => socket.close());
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('initial reconnect test snapshot timed out')), 5_000);
      socket.once('word-update', () => { clearTimeout(timer); resolve(); });
    });
    const recovered = new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('transport closure did not reconnect')), 5_000);
      socket.once('disconnect', () => {
        socket.once('word-update', (words) => {
          clearTimeout(timer);
          resolve(words);
        });
      });
    });
    require('../server').closeSocketTransports();
    assert.deepEqual(await recovered, []);
    assert.equal(socket.connected, true);
  });

  await t.test('polling fallback receives a complete maximum-size initial snapshot', async () => {
    const app = await startTestServer();
    t.after(app.close);
    const event = await createEvent(app.baseUrl, { coupleName: 'Polling Grenze' });
    const db = require('../src/db');
    const stored = await db.getEventBySlug(event.slug);
    await app.query(`
      INSERT INTO words (event_id, word, count)
      SELECT $1, 'polling-' || lpad(value::text, 3, '0'), 1
      FROM generate_series(1, 500) value
    `, [stored.id]);
    await app.query(`
      INSERT INTO word_contributions (receipt_id, event_id, word, owner_id)
      SELECT 'poll' || lpad(value::text, 20, '0'), $1,
             'polling-' || lpad(value::text, 3, '0'), $2
      FROM generate_series(1, 100) value
    `, [stored.id, 'd'.repeat(32)]);
    const client = await connectSocket(
      app.baseUrl,
      event.slug,
      'd'.repeat(32),
      { transports: ['polling'], upgrade: false }
    );
    t.after(() => client.socket.close());
    assert.equal(client.words.length, 500);
    assert.equal(client.ownWords.length, 100);
    assert.equal(client.socket.io.engine.transport.name, 'polling');
  });

  await t.test('performance snapshots are secret-bound and expose no room or buyer data', async () => {
    const app = await startTestServer();
    t.after(app.close);
    const hidden = await fetch(`${app.baseUrl}/internal/performance/snapshot`);
    assert.equal(hidden.status, 404);
    const visible = await fetch(`${app.baseUrl}/internal/performance/snapshot`, {
      headers: { Authorization: `Bearer ${process.env.MAINTENANCE_SECRET}` },
    });
    assert.equal(visible.status, 200);
    const body = await visible.json();
    assert.ok(Number.isFinite(body.process.cpuPercent));
    assert.ok(Number.isInteger(body.process.rssBytes));
    assert.deepEqual(Object.keys(body.postgresPool).sort(), ['idle', 'total', 'waiting']);
    assert.equal(JSON.stringify(body).includes('@'), false);
    assert.equal(JSON.stringify(body).includes('slug'), false);
  });
});
