'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { io: connectSocket } = require('socket.io-client');
const { startTestServer, createEvent } = require('./helpers');

const OWNER_A = 'a'.repeat(32);
const OWNER_B = 'b'.repeat(32);

function waitFor(socket, eventName, timeoutMs = 4000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`timeout waiting for ${eventName}`)), timeoutMs);
    socket.once(eventName, (...args) => {
      clearTimeout(timer);
      resolve(args.length > 1 ? args : args[0]);
    });
  });
}

function simpleDesign(assetId = null) {
  return {
    version: 2,
    surfaces: {
      default: assetId
        ? [{ id: 'photo', type: 'image', assetId }]
        : [{ id: 'word', text: 'liebe', x: 100, y: 100, fontSize: 40, angle: 0, color: '#000000' }],
    },
  };
}

async function createPersonalConfiguration(db, eventId, assetId = null) {
  return db.createConfiguration({
    eventId,
    productKey: 'white-glossy-mug-duo-11oz',
    printfulVariantId: 1320,
    quantity: 2,
    unitPriceCents: 0,
    theme: 'blush',
    words: [],
    design: simpleDesign(assetId),
    configurationType: 'personal_memory',
    orientation: 'default',
    printWidth: 2700,
    printHeight: 1120,
  });
}

async function insertAsset(query, eventId, id, ownerId = OWNER_A) {
  await query(`
    INSERT INTO design_assets (
      id, event_id, uploader_owner_id, object_key, mime_type, byte_size,
      sha256, storage_status, expires_at
    ) VALUES ($1, $2, $3, $4, 'image/png', 4, $5, 'active', transaction_timestamp() + interval '30 days')
  `, [id, eventId, ownerId, `photos/${eventId}/${id}.png`, 'a'.repeat(64)]);
}

async function expireEvent(query, eventId) {
  await query(`
    UPDATE events SET created_at = transaction_timestamp() - interval '366 days'
    WHERE id = $1
  `, [eventId]);
}

test('Phase 4 lifecycle and abuse boundaries', async (t) => {
  const app = await startTestServer();
  t.after(app.close);
  const db = require('../src/db');
  const lifecycle = require('../src/lifecycle');
  const storage = require('../src/privateStorage');
  const rateLimits = require('../src/rateLimits');
  const clientIdentity = require('../src/clientIdentity');

  await t.test('source identities normalize IPv4/IPv6 and ignore X-Forwarded-For', () => {
    assert.equal(clientIdentity.normalizeSourceAddress('127.0.0.1'), 'ipv4:127.0.0.1');
    assert.equal(clientIdentity.normalizeSourceAddress('::ffff:127.0.0.1'), 'ipv4:127.0.0.1');
    assert.equal(
      clientIdentity.normalizeSourceAddress('2001:db8:abcd:1234:1111:2222:3333:4444'),
      clientIdentity.normalizeSourceAddress('2001:db8:abcd:1234:aaaa:bbbb:cccc:dddd')
    );
    assert.notEqual(
      clientIdentity.normalizeSourceAddress('2001:db8:abcd:1234::1'),
      clientIdentity.normalizeSourceAddress('2001:db8:abcd:1235::1')
    );
    const request = {
      headers: { 'x-forwarded-for': '203.0.113.99' },
      socket: { remoteAddress: '192.0.2.10' },
    };
    assert.equal(clientIdentity.sourceAddressForRequest(request), 'ipv4:192.0.2.10');
    assert.match(clientIdentity.sourceHashForRequest(request), /^[a-f0-9]{64}$/);
    const previousEnvironment = process.env.NODE_ENV;
    process.env.NODE_ENV = 'production';
    try {
      assert.equal(clientIdentity.sourceAddressForRequest({
        headers: { 'fly-client-ip': '203.0.113.8', 'x-forwarded-for': '192.0.2.99' },
        socket: { remoteAddress: '10.0.0.1' },
      }), 'ipv4:203.0.113.8');
    } finally {
      process.env.NODE_ENV = previousEnvironment;
    }
  });

  await t.test('all process limits use the specified defaults and socket counts release cleanly', () => {
    rateLimits.resetForTests();
    for (const [name, limit] of Object.entries(rateLimits.LIMITS)) {
      assert.ok(Number.isInteger(limit.max) && limit.max > 0, `${name} needs a positive maximum`);
      if (!limit.windowMs) continue;
      for (let index = 0; index < limit.max; index += 1) {
        assert.equal(rateLimits.consume([{ name, key: 'same', ...limit }], 1000), true, name);
      }
      assert.equal(rateLimits.consume([{ name, key: 'same', ...limit }], 1000), false, name);
      rateLimits.resetForTests();
    }

    const wordRules = [{ name: 'word-token', key: 'guest', ...rateLimits.LIMITS.wordBurst }];
    assert.equal(rateLimits.consumeTokens(wordRules, 1000), true);
    assert.equal(rateLimits.consumeTokens(wordRules, 1000), true);
    assert.equal(rateLimits.consumeTokens(wordRules, 1000), true);
    assert.equal(rateLimits.consumeTokens(wordRules, 1000), false);
    assert.equal(rateLimits.consumeTokens(wordRules, 2000), true);
    rateLimits.resetForTests();

    const releases = Array.from({ length: 300 }, () => rateLimits.acquireSocket('event-a', 'one-source'));
    assert.ok(releases.every(Boolean));
    assert.equal(rateLimits.acquireSocket('event-a', 'one-source'), null);
    releases.forEach((release) => release());

    const eventReleases = Array.from(
      { length: 500 },
      (_, index) => rateLimits.acquireSocket('event-b', `source-${index}`)
    );
    assert.ok(eventReleases.every(Boolean));
    assert.equal(rateLimits.acquireSocket('event-b', 'source-overflow'), null);
    eventReleases.forEach((release) => release());
    rateLimits.resetForTests();
  });

  await t.test('event creation is limited to five per source per hour', async () => {
    rateLimits.resetForTests();
    const statuses = [];
    for (let index = 0; index < 6; index += 1) {
      const response = await fetch(`${app.baseUrl}/api/events`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Wolkenworte-Test-Client-IP': '198.51.100.20',
        },
        body: JSON.stringify({ coupleName: `Limit Paar ${index}`, pin: '1234' }),
      });
      statuses.push(response.status);
    }
    assert.deepEqual(statuses, [201, 201, 201, 201, 201, 429]);
    rateLimits.resetForTests();
  });

  await t.test('reset failures are durable, generic and store no raw address', async () => {
    const created = await createEvent(app.baseUrl, { coupleName: 'Reset Schutz', pin: '7788' });
    const event = await db.getEventBySlug(created.slug);
    const headers = {
      'Content-Type': 'application/json',
      'X-Wolkenworte-Test-Client-IP': '198.51.100.44',
    };
    for (let attempt = 0; attempt < 5; attempt += 1) {
      const response = await fetch(`${app.baseUrl}/api/events/${created.slug}/reset`, {
        method: 'POST', headers, body: JSON.stringify({ pin: '0000' }),
      });
      assert.equal(response.status, 401);
      assert.deepEqual(await response.json(), { error: 'invalid_pin' });
    }
    rateLimits.resetForTests();
    const blocked = await fetch(`${app.baseUrl}/api/events/${created.slug}/reset`, {
      method: 'POST', headers, body: JSON.stringify({ pin: '7788' }),
    });
    assert.equal(blocked.status, 429);
    assert.deepEqual(await blocked.json(), { error: 'rate_limited' });

    const bucket = await app.query(`
      SELECT source_ip_hash, failed_attempts, blocked_until
      FROM admin_pin_failures WHERE event_id = $1
    `, [event.id]);
    assert.equal(bucket.rowCount, 1);
    assert.match(bucket.rows[0].source_ip_hash, /^[a-f0-9]{64}$/);
    assert.equal(bucket.rows[0].source_ip_hash.includes('198.51.100.44'), false);
    assert.equal(bucket.rows[0].failed_attempts, 5);
    assert.ok(bucket.rows[0].blocked_until);

    const allowedElsewhere = await fetch(`${app.baseUrl}/api/events/${created.slug}/reset`, {
      method: 'POST',
      headers: { ...headers, 'X-Wolkenworte-Test-Client-IP': '198.51.100.45' },
      body: JSON.stringify({ pin: '7788' }),
    });
    assert.equal(allowedElsewhere.status, 200);
  });

  await t.test('PIN derivation is asynchronous and preserves the stored hash format', async () => {
    const stored = await db.hashPin('4455');
    assert.match(stored.hash, /^[a-f0-9]{128}$/);
    assert.match(stored.salt, /^[a-f0-9]{32}$/);
    let timerRan = false;
    const timer = new Promise((resolve) => setTimeout(() => { timerRan = true; resolve(); }, 0));
    const verification = Promise.all(
      Array.from({ length: 8 }, () => db.verifyPin('4455', stored.hash, stored.salt))
    );
    await timer;
    assert.equal(timerRan, true);
    assert.deepEqual(await verification, Array(8).fill(true));
  });

  await t.test('expired events are indistinguishable from unknown events and slugs remain reserved', async () => {
    const created = await createEvent(app.baseUrl, { coupleName: 'Ablauf Privat', pin: '1234' });
    const event = await db.getEventBySlug(created.slug);
    await expireEvent(app.query, event.id);

    assert.equal((await fetch(`${app.baseUrl}/api/events/${created.slug}`)).status, 404);
    assert.equal((await fetch(`${app.baseUrl}/e/${created.slug}`)).status, 404);
    const socket = connectSocket(app.baseUrl, {
      transports: ['websocket'],
      forceNew: true,
      query: { slug: created.slug, guestId: OWNER_A },
    });
    assert.equal(await waitFor(socket, 'fatal-error'), 'unknown event');
    socket.close();

    const result = await lifecycle.cleanupExpiredEvent(event.id);
    assert.equal(result.deleted, true);
    assert.equal(await db.slugExists(created.slug), true);
    const rows = await app.query('SELECT count(*)::integer AS count FROM events WHERE id = $1', [event.id]);
    assert.equal(rows.rows[0].count, 0);
  });

  await t.test('personal revisions expire after 30 days but a paid reference remains retained', async () => {
    const created = await createEvent(app.baseUrl, { coupleName: 'Entwurf Ablauf', pin: '1234' });
    const event = await db.getEventBySlug(created.slug);
    const configuration = await createPersonalConfiguration(db, event.id);
    const lifetime = Date.parse(configuration.expires_at) - Date.parse(configuration.created_at);
    assert.equal(lifetime, 30 * 24 * 60 * 60 * 1000);

    await app.query(`UPDATE configurations SET expires_at = transaction_timestamp() - interval '1 minute' WHERE id = $1`, [configuration.id]);
    assert.equal(
      (await fetch(`${app.baseUrl}/api/events/${created.slug}/configurations/${configuration.id}`)).status,
      404
    );

    const order = await app.query(`
      INSERT INTO orders (
        event_id, event_slug_snapshot, event_label_snapshot, status, mode
      ) VALUES ($1, $2, $3, 'paid_test', 'test') RETURNING id
    `, [event.id, created.slug, created.coupleName]);
    await app.query(`
      INSERT INTO order_items (
        order_id, configuration_id, shipment_index, item_index, product_key,
        printful_variant_id, quantity, configuration_snapshot_json
      ) VALUES ($1, $2, 0, 0, 'white-glossy-mug-duo-11oz', 1320, 2, '{}'::jsonb)
    `, [order.rows[0].id, configuration.id]);
    assert.equal(
      (await fetch(`${app.baseUrl}/api/events/${created.slug}/configurations/${configuration.id}`)).status,
      200
    );
  });

  await t.test('event cleanup deletes unpaid objects first and detaches paid configuration data', async () => {
    const created = await createEvent(app.baseUrl, { coupleName: 'Retention Paar', pin: '1234' });
    const event = await db.getEventBySlug(created.slug);
    const paidAssetId = `p${'1'.repeat(23)}`;
    const unpaidAssetId = `u${'2'.repeat(23)}`;
    await insertAsset(app.query, event.id, paidAssetId);
    await insertAsset(app.query, event.id, unpaidAssetId, OWNER_B);
    const paidConfiguration = await createPersonalConfiguration(db, event.id, paidAssetId);
    const unpaidConfiguration = await createPersonalConfiguration(db, event.id, unpaidAssetId);

    const order = await app.query(`
      INSERT INTO orders (
        event_id, event_slug_snapshot, event_label_snapshot, status, mode
      ) VALUES ($1, $2, $3, 'paid_test', 'test') RETURNING id
    `, [event.id, created.slug, created.coupleName]);
    await app.query(`
      INSERT INTO order_items (
        order_id, configuration_id, shipment_index, item_index, product_key,
        printful_variant_id, quantity, configuration_snapshot_json
      ) VALUES ($1, $2, 0, 0, 'white-glossy-mug-duo-11oz', 1320, 2, '{}'::jsonb)
    `, [order.rows[0].id, paidConfiguration.id]);
    await expireEvent(app.query, event.id);

    const removedKeys = [];
    storage.setAdapterForTests({
      async remove(key) { removedKeys.push(key); },
    });
    const result = await lifecycle.cleanupExpiredEvent(event.id);
    storage.resetAdapterForTests();
    assert.deepEqual(result, {
      eligible: true,
      deleted: true,
      retainedConfigurations: 1,
      failedAssets: 0,
    });
    assert.deepEqual(removedKeys, [`photos/${event.id}/${unpaidAssetId}.png`]);

    const retained = await app.query(`
      SELECT
        (SELECT event_id FROM orders WHERE id = $1) AS order_event_id,
        (SELECT event_id FROM configurations WHERE id = $2) AS configuration_event_id,
        (SELECT event_id FROM design_assets WHERE id = $3) AS asset_event_id,
        EXISTS (SELECT 1 FROM configurations WHERE id = $4) AS unpaid_configuration_exists,
        EXISTS (SELECT 1 FROM design_assets WHERE id = $5) AS unpaid_asset_exists
    `, [order.rows[0].id, paidConfiguration.id, paidAssetId, unpaidConfiguration.id, unpaidAssetId]);
    assert.equal(retained.rows[0].order_event_id, null);
    assert.equal(retained.rows[0].configuration_event_id, null);
    assert.equal(retained.rows[0].asset_event_id, null);
    assert.equal(retained.rows[0].unpaid_configuration_exists, false);
    assert.equal(retained.rows[0].unpaid_asset_exists, false);
    assert.equal(await db.slugExists(created.slug), true);
  });

  await t.test('failed Storage deletion keeps the expired event retryable', async () => {
    const created = await createEvent(app.baseUrl, { coupleName: 'Retry Ablauf', pin: '1234' });
    const event = await db.getEventBySlug(created.slug);
    const assetId = `r${'3'.repeat(23)}`;
    await insertAsset(app.query, event.id, assetId);
    await expireEvent(app.query, event.id);
    storage.setAdapterForTests({ async remove() { throw new Error('offline'); } });
    const failed = await lifecycle.cleanupExpiredEvent(event.id);
    assert.equal(failed.deleted, false);
    assert.equal(failed.failedAssets, 1);
    const failedRow = await app.query('SELECT storage_status, object_key FROM design_assets WHERE id = $1', [assetId]);
    assert.equal(failedRow.rows[0].storage_status, 'delete_failed');
    assert.ok(failedRow.rows[0].object_key);

    storage.setAdapterForTests({ async remove() {} });
    const retried = await lifecycle.cleanupExpiredEvent(event.id);
    storage.resetAdapterForTests();
    assert.equal(retried.deleted, true);
    assert.equal(retried.failedAssets, 0);
  });

  await t.test('database ceilings are atomic and increments at the unique-word ceiling still work', async () => {
    const created = await createEvent(app.baseUrl, { coupleName: 'Wort Grenzen', pin: '1234' });
    const event = await db.getEventBySlug(created.slug);
    await app.query(`
      INSERT INTO words (event_id, word, count)
      SELECT $1, 'wort-' || value, 1 FROM generate_series(1, 500) value
    `, [event.id]);
    const receipt = await db.addWordContribution(event.id, 'wort-1', OWNER_A);
    assert.match(receipt, /^[A-Za-z0-9_-]{24}$/);
    await assert.rejects(
      db.addWordContribution(event.id, 'wort-neu', OWNER_B),
      (error) => error.code === 'unique_word_limit'
    );
    const counts = await app.query(`
      SELECT count(*)::integer AS words,
             (SELECT count(*)::integer FROM word_contributions WHERE event_id = $1) AS contributions
      FROM words WHERE event_id = $1
    `, [event.id]);
    assert.equal(counts.rows[0].words, 500);
    assert.equal(counts.rows[0].contributions, 1);

    const ownerCreated = await createEvent(app.baseUrl, { coupleName: 'Gast Grenze', pin: '1234' });
    const ownerEvent = await db.getEventBySlug(ownerCreated.slug);
    await app.query(`INSERT INTO words (event_id, word, count) VALUES ($1, 'liebe', 100)`, [ownerEvent.id]);
    await app.query(`
      INSERT INTO word_contributions (receipt_id, event_id, word, owner_id)
      SELECT 'owner-' || lpad(value::text, 18, '0'), $1, 'liebe', $2
      FROM generate_series(1, 100) value
    `, [ownerEvent.id, OWNER_A]);
    await assert.rejects(
      db.addWordContribution(ownerEvent.id, 'liebe', OWNER_A),
      (error) => error.code === 'guest_contribution_limit'
    );

    const totalCreated = await createEvent(app.baseUrl, { coupleName: 'Event Grenze', pin: '1234' });
    const totalEvent = await db.getEventBySlug(totalCreated.slug);
    await app.query(`INSERT INTO words (event_id, word, count) VALUES ($1, 'freude', 5000)`, [totalEvent.id]);
    await app.query(`
      INSERT INTO word_contributions (receipt_id, event_id, word, owner_id)
      SELECT 'event-' || lpad(value::text, 18, '0'), $1, 'freude', $2
      FROM generate_series(1, 5000) value
    `, [totalEvent.id, 'c'.repeat(32)]);
    await assert.rejects(
      db.addWordContribution(totalEvent.id, 'freude', 'd'.repeat(32)),
      (error) => error.code === 'event_contribution_limit'
    );

    const configEventCreated = await createEvent(app.baseUrl, { coupleName: 'Konfig Grenzen', pin: '1234' });
    const configEvent = await db.getEventBySlug(configEventCreated.slug);
    await app.query(`
      INSERT INTO configurations (
        id, event_id, product_key, printful_variant_id, quantity, unit_price_cents,
        theme, words_json, design_json, configuration_type, orientation,
        print_width, print_height, expires_at
      )
      SELECT lpad(value::text, 16, 'c'), $1, 'white-glossy-mug-duo-11oz', 1320,
             2, 0, 'blush', '[]'::jsonb, '{}'::jsonb, 'personal_memory',
             'default', 2700, 1120, transaction_timestamp() + interval '30 days'
      FROM generate_series(1, 2000) value
    `, [configEvent.id]);
    await assert.rejects(
      createPersonalConfiguration(db, configEvent.id),
      (error) => error.code === 'configuration_limit'
    );

    const assetEventCreated = await createEvent(app.baseUrl, { coupleName: 'Asset Grenzen', pin: '1234' });
    const assetEvent = await db.getEventBySlug(assetEventCreated.slug);
    await app.query(`
      INSERT INTO design_assets (
        id, event_id, uploader_owner_id, object_key, mime_type, byte_size,
        sha256, storage_status, expires_at
      )
      SELECT 'asset' || lpad(value::text, 19, '0'), $1, md5(value::text),
             'photos/limit/' || value || '.png', 'image/png', 1,
             repeat('a', 64), 'active', transaction_timestamp() + interval '30 days'
      FROM generate_series(1, 2000) value
    `, [assetEvent.id]);
    await assert.rejects(
      db.beginDesignAssetUpload({
        eventId: assetEvent.id,
        ownerId: 'e'.repeat(32),
        mimeType: 'image/png',
        byteSize: 1,
        sha256: 'f'.repeat(64),
        extension: 'png',
      }),
      (error) => error.code === 'asset_limit'
    );
  });

  await t.test('socket word burst limit rejects the fourth immediate submission without a write', async () => {
    rateLimits.resetForTests();
    const created = await createEvent(app.baseUrl, { coupleName: 'Socket Grenze', pin: '1234' });
    const event = await db.getEventBySlug(created.slug);
    const socket = connectSocket(app.baseUrl, {
      transports: ['websocket'], forceNew: true,
      query: { slug: created.slug, guestId: OWNER_A },
    });
    await waitFor(socket, 'word-update');
    const limited = waitFor(socket, 'word-error');
    socket.emit('submit-word', 'eins');
    socket.emit('submit-word', 'zwei');
    socket.emit('submit-word', 'drei');
    socket.emit('submit-word', 'vier');
    assert.deepEqual(await limited, { error: 'rate_limited' });
    await new Promise((resolve) => setTimeout(resolve, 250));
    const stored = await app.query(`
      SELECT count(*)::integer AS count FROM word_contributions WHERE event_id = $1
    `, [event.id]);
    assert.equal(stored.rows[0].count, 3);
    socket.close();
    rateLimits.resetForTests();
  });
});
