'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const { Pool } = require('pg');
const { io } = require('socket.io-client');

require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

const execFileAsync = promisify(execFile);
const { connectionOptions } = require('../src/dbConfig');
const { getProduct, resolveProductOrientation } = require('../src/products');

const DEFAULTS = Object.freeze({
  baseUrl: 'https://wolkenworte.fly.dev',
  app: 'wolkenworte',
  organization: 'personal',
  machineId: '185e6ddc9d1548',
  rooms: 100,
  sockets: 2_000,
  hotRoomSockets: 300,
  submissionsPerSecond: 50,
  durationSeconds: 30,
  pollingSockets: 20,
  configurationSaves: 10,
  estimates: 5,
});
const PIN = '8844';

function parseInteger(value, label) {
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < 0) throw new Error(`${label} must be a non-negative integer.`);
  return number;
}

function parseArgs(argv = process.argv.slice(2)) {
  const options = { ...DEFAULTS, confirm: false, skipRestart: false, quick: false, report: null };
  const valueFlags = new Map([
    ['--url', 'baseUrl'], ['--app', 'app'], ['--organization', 'organization'],
    ['--machine-id', 'machineId'], ['--rooms', 'rooms'], ['--sockets', 'sockets'],
    ['--hot-room-sockets', 'hotRoomSockets'], ['--submissions-per-second', 'submissionsPerSecond'],
    ['--duration-seconds', 'durationSeconds'], ['--polling-sockets', 'pollingSockets'],
    ['--configuration-saves', 'configurationSaves'], ['--estimates', 'estimates'],
    ['--report', 'report'],
  ]);
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    if (flag === '--confirm-capacity-test') options.confirm = true;
    else if (flag === '--skip-restart') options.skipRestart = true;
    else if (flag === '--quick') options.quick = true;
    else if (valueFlags.has(flag)) {
      if (index + 1 >= argv.length) throw new Error(`${flag} requires a value.`);
      options[valueFlags.get(flag)] = argv[index += 1];
    } else {
      throw new Error(`Unknown option: ${flag}`);
    }
  }
  for (const key of [
    'rooms', 'sockets', 'hotRoomSockets', 'submissionsPerSecond', 'durationSeconds',
    'pollingSockets', 'configurationSaves', 'estimates',
  ]) options[key] = parseInteger(options[key], key);
  options.baseUrl = String(options.baseUrl).replace(/\/$/, '');
  return options;
}

function validateOptions(options, env = process.env) {
  if (!options.confirm) throw new Error('Use --confirm-capacity-test to authorize synthetic hosted load.');
  const target = new URL(options.baseUrl);
  if (target.protocol !== 'https:') throw new Error('The hosted capacity target must use HTTPS.');
  if (target.hostname !== 'wolkenworte.fly.dev') {
    throw new Error('The guarded runner accepts only the wolkenworte.fly.dev staging hostname.');
  }
  if (!env.DATABASE_URL) throw new Error('DATABASE_URL is required to create scoped synthetic fixtures.');
  if (String(env.MAINTENANCE_SECRET || '').length < 32) {
    throw new Error('MAINTENANCE_SECRET is required for aggregate performance samples.');
  }
  if (options.hotRoomSockets > options.sockets || options.pollingSockets > options.sockets) {
    throw new Error('Hot-room and polling socket counts cannot exceed the total.');
  }
  if (options.rooms < 2 || options.sockets < options.rooms) {
    throw new Error('The run needs at least two rooms and one socket per room.');
  }
  if (options.estimates > options.configurationSaves) {
    throw new Error('Printful estimates cannot exceed the saved configurations.');
  }
  if (!options.skipRestart && !options.machineId) throw new Error('--machine-id is required for restart testing.');
  if (!options.quick && (
    options.rooms < 100 || options.sockets < 2_000 || options.hotRoomSockets < 300 ||
    options.submissionsPerSecond < 50 || options.durationSeconds < 30 ||
    options.pollingSockets < 20 || options.configurationSaves < 10 || options.estimates < 5
  )) {
    throw new Error(
      'A qualifying run requires 100 rooms, 2,000 sockets, a 300-socket hot room, ' +
      '20 polling sockets, 50 submissions/s for 30 seconds, 10 configuration saves and 5 estimates.'
    );
  }
  return options;
}

function percentile(values, quantile) {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.max(0, Math.ceil(quantile * sorted.length) - 1);
  return Number(sorted[index].toFixed(3));
}

function distribution(values) {
  return {
    count: values.length,
    p50: percentile(values, 0.50),
    p95: percentile(values, 0.95),
    p99: percentile(values, 0.99),
    max: values.length ? Number(Math.max(...values).toFixed(3)) : null,
  };
}

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function hashPin(pin, salt) {
  return new Promise((resolve, reject) => {
    crypto.scrypt(String(pin), salt, 64, (error, bytes) => {
      if (error) reject(error); else resolve(bytes.toString('hex'));
    });
  });
}

function makePool() {
  return new Pool(connectionOptions(process.env.DATABASE_URL, {
    applicationName: 'wolkenworte-socket-capacity-runner',
    requireDirect: false,
  }));
}

async function seedFixtures(pool, options, runId) {
  const salt = crypto.randomBytes(16).toString('hex');
  const pinHash = await hashPin(PIN, salt);
  const slugs = Array.from({ length: options.rooms }, (_, index) =>
    `capacity-${runId}-r${String(index).padStart(3, '0')}`
  );
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const rows = await client.query(`
      WITH fixture(slug, room_index) AS (
        SELECT * FROM unnest($1::text[]) WITH ORDINALITY AS item(slug, room_index)
      ), reserved AS (
        INSERT INTO reserved_event_slugs (slug, original_created_at)
        SELECT slug, transaction_timestamp() FROM fixture
        RETURNING slug
      )
      INSERT INTO events (
        slug, couple_name, admin_pin_hash, admin_pin_salt, locale, created_at, expires_at
      )
      SELECT fixture.slug, 'Socket Capacity ' || fixture.room_index,
             $2, $3, 'de', transaction_timestamp(), transaction_timestamp() + interval '365 days'
      FROM fixture JOIN reserved USING (slug)
      ORDER BY fixture.room_index
      RETURNING id, slug
    `, [slugs, pinHash, salt]);
    const bySlug = new Map(rows.rows.map((row) => [row.slug, row]));
    const rooms = slugs.map((slug, index) => ({
      index,
      id: bySlug.get(slug).id,
      slug,
      prefix: `r${String(index).padStart(3, '0')}-`,
    }));
    const hot = rooms[0];
    await client.query(`
      INSERT INTO words (event_id, word, count)
      SELECT $1, $2 || 'seed-' || lpad(value::text, 3, '0'), 10
      FROM generate_series(1, 495) value
    `, [hot.id, hot.prefix]);
    await client.query(`
      INSERT INTO word_contributions (receipt_id, event_id, word, owner_id)
      SELECT substr(md5($1 || ':' || value::text), 1, 24), $2,
             $3 || 'seed-' || lpad(ceil(value / 10.0)::integer::text, 3, '0'),
             md5('owner:' || $1 || ':' || value::text)
      FROM generate_series(1, 4950) value
    `, [runId, hot.id, hot.prefix]);
    await client.query('COMMIT');
    return rooms;
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}

async function cleanupFixtures(pool, rooms) {
  if (!rooms.length) return;
  const ids = rooms.map((room) => room.id);
  const slugs = rooms.map((room) => room.slug);
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('DELETE FROM orders WHERE event_id = ANY($1::bigint[])', [ids]);
    await client.query('DELETE FROM configurations WHERE event_id = ANY($1::bigint[])', [ids]);
    await client.query('DELETE FROM events WHERE id = ANY($1::bigint[])', [ids]);
    await client.query('DELETE FROM reserved_event_slugs WHERE slug = ANY($1::text[])', [slugs]);
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}

async function waitUntilReady(baseUrl) {
  const deadline = Date.now() + 120_000;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`${baseUrl}/health/ready`, { signal: AbortSignal.timeout(10_000) });
      if (response.status === 200) return;
    } catch { /* cold start */ }
    await delay(1_000);
  }
  throw new Error('Hosted readiness did not become healthy.');
}

async function performanceSnapshot(baseUrl) {
  const response = await fetch(`${baseUrl}/internal/performance/snapshot`, {
    headers: { Authorization: `Bearer ${process.env.MAINTENANCE_SECRET}` },
    signal: AbortSignal.timeout(10_000),
  });
  if (response.status !== 200) throw new Error(`performance snapshot failed (${response.status})`);
  return response.json();
}

function assignRooms(rooms, options) {
  const assignments = Array(options.sockets);
  for (let index = 0; index < options.hotRoomSockets; index += 1) assignments[index] = rooms[0];
  for (let index = options.hotRoomSockets; index < options.sockets; index += 1) {
    assignments[index] = rooms[1 + ((index - options.hotRoomSockets) % (rooms.length - 1))];
  }
  return assignments;
}

function wordsAreScoped(words, room) {
  return Array.isArray(words) && words.every((entry) =>
    Array.isArray(entry) && typeof entry[0] === 'string' && entry[0].startsWith(room.prefix) &&
    Number.isInteger(Number(entry[1])) && Number(entry[1]) > 0
  );
}

function connectClient(baseUrl, room, index, state, transport) {
  return new Promise((resolve, reject) => {
    const guestId = crypto.createHash('md5').update(`${state.runId}:${index}`).digest('hex');
    const client = {
      index, room, guestId, socket: null, initialWords: null, initialOwn: null,
      connectedOnce: false, restartDisconnected: false, reconnectSnapshotAt: null,
      reconnectConnectedAt: null,
      restartDisconnectedAt: null,
      reconnectSnapshotCorrect: false, themeEvents: 0, resetEvents: 0,
    };
    const transportOptions = transport === 'polling'
      ? { transports: ['polling'], upgrade: false }
      : transport === 'websocket'
        ? { transports: ['websocket'], upgrade: false }
        : { transports: ['websocket', 'polling'], tryAllTransports: true };
    const socket = io(baseUrl, {
      query: { slug: room.slug, guestId },
      ...transportOptions,
      forceNew: true,
      reconnection: true,
      // Match the production pages. A 100 ms retry loop creates a proxy-level
      // flood; the seven-second attempt bound leaves time to retry via polling
      // inside the 15-second recovery SLO.
      reconnectionDelay: 1_000,
      reconnectionDelayMax: 5_000,
      randomizationFactor: 0.5,
      timeout: transport === 'default' ? 7_000 : 20_000,
    });
    client.socket = socket;
    let settled = false;
    const timeout = setTimeout(() => fail(new Error(`socket ${index} initial snapshot timed out`)), 60_000);
    function fail(error) {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      socket.close();
      reject(error);
    }
    function ready() {
      if (client.initialWords === null || client.initialOwn === null) return;
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      resolve(client);
    }
    socket.on('connect', () => {
      if (transport === 'default') socket.io.opts.transports = ['websocket', 'polling'];
      if (state.restarting && client.restartDisconnected) client.reconnectConnectedAt ||= Date.now();
      client.connectedOnce = true;
    });
    socket.on('disconnect', () => {
      if (state.restarting) {
        client.restartDisconnected = true;
        client.restartDisconnectedAt ||= Date.now();
      }
      else if (!state.closing) state.unexpectedErrors.push(`disconnect:${room.index}`);
    });
    socket.on('connect_error', (error) => {
      if (transport === 'default' && !client.connectedOnce) {
        socket.io.opts.transports = ['polling', 'websocket'];
      }
      if (!client.connectedOnce) {
        if (transport !== 'default') fail(error);
        return;
      }
      if (!state.restarting && !state.closing) state.unexpectedErrors.push(`connect:${error.message}`);
    });
    socket.on('fatal-error', (error) => {
      state.unexpectedErrors.push(`fatal:${error}`);
      fail(new Error(`fatal-error: ${error}`));
    });
    socket.on('word-error', (error) => state.wordErrors.push(error?.error || 'unknown'));
    socket.on('word-accepted', (word, receipt) => {
      const pending = state.pendingAcks.get(word);
      if (!pending) return;
      state.pendingAcks.delete(word);
      state.acknowledgements.push(performance.now() - pending.startedAt);
      state.accepted.push({ word, receipt, client });
    });
    socket.on('word-update', (words) => {
      state.inboundApplicationBytes += Buffer.byteLength(JSON.stringify(words));
      if (!wordsAreScoped(words, room)) state.crossBoundaryErrors.push(`word:${room.index}`);
      if (client.initialWords === null) {
        client.initialWords = words;
        if (room.index === 0 && state.hotSnapshotBytes === null) {
          state.hotSnapshotBytes = Buffer.byteLength(JSON.stringify(words));
        }
        ready();
      }
      if (state.observers.get(room.index) === client) {
        for (const [word, pending] of state.pendingVisible) {
          if (pending.room.index === room.index && words.some(([value]) => value === word)) {
            state.pendingVisible.delete(word);
            state.roomUpdateDelays.push(performance.now() - pending.startedAt);
          }
        }
      }
      if (state.restarting && client.restartDisconnected && client.reconnectSnapshotAt === null) {
        client.reconnectSnapshotAt = Date.now();
        client.reconnectSnapshotCorrect = JSON.stringify(words) === room.expectedSnapshot;
      }
    });
    socket.on('own-word-update', (words) => {
      if (client.initialOwn === null) {
        client.initialOwn = words;
        ready();
      }
    });
    socket.on('theme-change', () => { client.themeEvents += 1; });
    socket.on('round-reset', () => { client.resetEvents += 1; });
  });
}

async function connectAll(baseUrl, rooms, options, state) {
  const assignments = assignRooms(rooms, options);
  const clients = [];
  for (let offset = 0; offset < assignments.length; offset += 50) {
    const batch = assignments.slice(offset, offset + 50).map((room, relative) => {
      const index = offset + relative;
      const transport = index >= assignments.length - options.pollingSockets ? 'polling' : 'default';
      return connectClient(baseUrl, room, index, state, transport);
    });
    clients.push(...await Promise.all(batch));
    await delay(50);
  }
  for (const room of rooms) {
    state.observers.set(room.index, clients.find((client) => client.room.index === room.index));
  }
  return clients;
}

function configurationPayload(index) {
  const product = resolveProductOrientation(getProduct('white-glossy-mug-duo-11oz'), 'default');
  return {
    productKey: product.key,
    quantity: 1,
    theme: 'pastel',
    designs: Object.fromEntries(product.printSurfaces.map((surface) => [surface.key, [{
      id: `capacity-word-${index}-${surface.key}`,
      text: 'belastungstest',
      x: product.printFile.width / 2,
      y: product.printFile.height / 2,
      fontSize: 72,
      angle: 0,
      color: '#a40e4c',
      fontFamily: 'classic',
    }]])),
  };
}

async function runApiWork(baseUrl, rooms, options, state) {
  const configurations = [];
  const saves = Array.from({ length: options.configurationSaves }, async (_, index) => {
    await delay(index * 150);
    const room = rooms[1 + (index % (rooms.length - 1))];
    const startedAt = performance.now();
    const response = await fetch(`${baseUrl}/api/events/${room.slug}/configurations`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Wolkenworte-Guest-Id': crypto.createHash('md5').update(`config:${state.runId}:${index}`).digest('hex'),
      },
      body: JSON.stringify(configurationPayload(index)),
      signal: AbortSignal.timeout(20_000),
    });
    state.apiLatencies.push(performance.now() - startedAt);
    if (response.status !== 201) {
      state.unexpectedErrors.push(`configuration:${response.status}`);
      return null;
    }
    const configuration = await response.json();
    configurations.push({ configuration, room, index });
    return { configuration, room, index };
  });
  const saved = (await Promise.all(saves)).filter(Boolean);
  const estimates = saved.slice(0, options.estimates).map(async ({ configuration, room, index }) => {
    const startedAt = performance.now();
    const response = await fetch(
      `${baseUrl}/api/events/${room.slug}/configurations/${configuration.id}/estimate-costs`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Wolkenworte-Guest-Id': crypto.createHash('md5').update(`estimate:${state.runId}:${index}`).digest('hex'),
        },
        body: JSON.stringify({
          recipient: {
            name: 'Socket Lasttest', address1: 'Testweg 7', city: 'Berlin',
            zip: '10115', country_code: 'DE',
          },
        }),
        signal: AbortSignal.timeout(30_000),
      }
    );
    state.estimateLatencies.push(performance.now() - startedAt);
    if (response.status !== 200) state.unexpectedErrors.push(`estimate:${response.status}`);
  });
  await Promise.all(estimates);
  return configurations;
}

function interruptedFulfillmentSnapshot(configuration) {
  const product = resolveProductOrientation(
    getProduct(configuration.product_key),
    configuration.orientation
  );
  if (!product || product.printful.variantId !== Number(configuration.printful_variant_id)) {
    throw new Error('The interrupted-fulfillment fixture has an invalid product.');
  }
  return {
    version: 1,
    configurationId: configuration.id,
    productKey: configuration.product_key,
    printfulVariantId: Number(configuration.printful_variant_id),
    printfulPlacements: product.printful.placements,
    printfulOptions: product.printful.options,
    orientation: configuration.orientation,
    theme: configuration.theme,
    printWidth: Number(configuration.print_width),
    printHeight: Number(configuration.print_height),
    words: configuration.words_json,
    design: configuration.design_json,
    createdAt: configuration.created_at,
  };
}

async function seedInterruptedFulfillment(pool, room, configurationId, runId) {
  const recipient = {
    name: 'Socket Lasttest', address1: 'Testweg 7', city: 'Berlin',
    zip: '10115', country_code: 'DE',
  };
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const configurationResult = await client.query(
      'SELECT * FROM configurations WHERE id = $1 AND event_id = $2 FOR UPDATE',
      [configurationId, room.id]
    );
    const configuration = configurationResult.rows[0];
    if (!configuration) throw new Error('The interrupted-fulfillment configuration is missing.');
    const snapshot = interruptedFulfillmentSnapshot(configuration);
    const quoteId = `socket_capacity_${runId}`;
    const orderResult = await client.query(`
      INSERT INTO orders (
        event_id, event_slug_snapshot, event_label_snapshot, configuration_id,
        configuration_ids_json, quote_id, status, shipping_json, currency,
        items_cents, shipping_cents, tax_cents, total_cents, mode, paid_at,
        fulfillment_status, fulfillment_mode, fulfillment_attempts,
        fulfillment_next_attempt_at, fulfillment_locked_by,
        fulfillment_locked_until, fulfillment_lease_version
      ) VALUES (
        $1, $2, 'Socket Capacity', $3, $4::jsonb, $5, 'paid_test',
        $6::jsonb, 'EUR', 0, 0, 0, 0, 'test', transaction_timestamp(),
        'processing', 'mock', 1, transaction_timestamp(), $7,
        transaction_timestamp() + interval '15 seconds', 1
      ) RETURNING id, fulfillment_status, fulfillment_locked_until
    `, [
      room.id, room.slug, configuration.id, JSON.stringify([configuration.id]),
      quoteId, JSON.stringify(recipient), `socket-capacity-${runId}`,
    ]);
    const order = orderResult.rows[0];
    await client.query(`
      INSERT INTO checkout_order_shipments (
        order_id, shipment_index, quantity, items_json, recipient_json,
        printful_costs_json, currency, shipping_cents, tax_cents,
        fulfillment_status, fulfillment_mode
      ) VALUES ($1, 0, 1, $2::jsonb, $3::jsonb, '{}'::jsonb, 'EUR', 0, 0, 'pending', 'mock')
    `, [order.id, JSON.stringify([{ configurationId: configuration.id, quantity: 1 }]), JSON.stringify(recipient)]);
    await client.query(`
      INSERT INTO order_items (
        order_id, configuration_id, shipment_index, item_index, product_key,
        printful_variant_id, quantity, configuration_snapshot_json
      ) VALUES ($1, $2, 0, 0, $3, $4, 1, $5::jsonb)
    `, [
      order.id, configuration.id, configuration.product_key,
      configuration.printful_variant_id, JSON.stringify(snapshot),
    ]);
    await client.query('COMMIT');
    return {
      orderId: String(order.id),
      seededAt: Date.now(),
      initialStatus: order.fulfillment_status,
      leaseExpiresAt: new Date(order.fulfillment_locked_until).toISOString(),
    };
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}

function summarizeFulfillmentRecovery(fixture, row, finishedAt = Date.now()) {
  const recovered = row?.fulfillment_status === 'mocked' &&
    row.fulfillment_locked_by === null && row.fulfillment_locked_until === null;
  return {
    initialStatus: fixture.initialStatus,
    finalStatus: row?.fulfillment_status || 'missing',
    leaseCleared: row?.fulfillment_locked_by === null && row?.fulfillment_locked_until === null,
    attempts: Number(row?.fulfillment_attempts || 0),
    recoveryMs: finishedAt - fixture.seededAt,
    recovered,
  };
}

async function waitForFulfillmentRecovery(pool, fixture) {
  const deadline = Date.now() + 45_000;
  let row = null;
  while (Date.now() < deadline) {
    const result = await pool.query(`
      SELECT fulfillment_status, fulfillment_attempts,
             fulfillment_locked_by, fulfillment_locked_until
      FROM orders WHERE id = $1
    `, [fixture.orderId]);
    row = result.rows[0] || null;
    if (!row || ['mocked', 'blocked'].includes(row.fulfillment_status)) break;
    await delay(250);
  }
  return summarizeFulfillmentRecovery(fixture, row);
}

async function runSubmissionLoad(clients, options, state) {
  const candidates = clients.filter((client) => client.room.index !== 0);
  const total = options.submissionsPerSecond * options.durationSeconds;
  const intervalMs = 1_000 / options.submissionsPerSecond;
  const startedAt = performance.now();
  for (let sequence = 0; sequence < total; sequence += 1) {
    const dueAt = startedAt + sequence * intervalMs;
    const wait = dueAt - performance.now();
    if (wait > 0) await delay(wait);
    const client = candidates[sequence % candidates.length];
    const word = `${client.room.prefix}burst-${String(sequence).padStart(6, '0')}`;
    const pending = { room: client.room, startedAt: performance.now() };
    state.pendingAcks.set(word, pending);
    state.pendingVisible.set(word, pending);
    client.socket.emit('submit-word', word);
  }
  const deadline = Date.now() + 15_000;
  while ((state.pendingAcks.size || state.pendingVisible.size) && Date.now() < deadline) await delay(50);
  return total;
}

async function sampleResources(baseUrl, state, stopSignal) {
  while (!stopSignal.done) {
    try { state.resourceSamples.push(await performanceSnapshot(baseUrl)); }
    catch (error) { state.unexpectedErrors.push(`metrics:${error.message}`); }
    await delay(1_000);
  }
}

async function sampleReconnectResources(baseUrl, state, stopSignal) {
  while (!stopSignal.done) {
    try { state.reconnectResourceSamples.push(await performanceSnapshot(baseUrl)); }
    catch { /* the performance endpoint is intentionally unreachable mid-restart */ }
    await delay(500);
  }
}

function emitWithAck(socket, event, payload, timeoutMs = 5_000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${event} acknowledgement timed out`)), timeoutMs);
    socket.emit(event, payload, (result) => { clearTimeout(timer); resolve(result); });
  });
}

async function verifyIsolation(baseUrl, clients, rooms, state) {
  const themeRoom = rooms[1];
  const themeBaseline = clients.map((client) => client.themeEvents);
  clients.find((client) => client.room.index === themeRoom.index).socket.emit('theme-change', 'neon');
  await delay(500);
  const sameRoomTheme = clients.filter((client) => client.room.index === themeRoom.index)
    .some((client, index) => client.themeEvents > themeBaseline[clients.indexOf(client)]);
  const foreignTheme = clients.some((client, index) =>
    client.room.index !== themeRoom.index && client.themeEvents !== themeBaseline[index]
  );
  if (!sameRoomTheme || foreignTheme) state.crossBoundaryErrors.push('theme');

  const owned = state.accepted[0];
  const foreign = clients.find((client) => client.room.index !== owned.client.room.index);
  const foreignRemoval = await emitWithAck(foreign.socket, 'remove-word', { receipt: owned.receipt });
  if (foreignRemoval?.error !== 'not_found') state.crossBoundaryErrors.push('receipt');

  const resetRoom = rooms[2];
  const resetBaseline = clients.map((client) => client.resetEvents);
  const response = await fetch(`${baseUrl}/api/events/${resetRoom.slug}/reset`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ pin: PIN }),
    signal: AbortSignal.timeout(20_000),
  });
  if (response.status !== 200) state.unexpectedErrors.push(`reset:${response.status}`);
  await delay(500);
  const sameRoomReset = clients.filter((client) => client.room.index === resetRoom.index)
    .every((client) => client.resetEvents > resetBaseline[clients.indexOf(client)]);
  const foreignReset = clients.some((client, index) =>
    client.room.index !== resetRoom.index && client.resetEvents !== resetBaseline[index]
  );
  if (!sameRoomReset || foreignReset) state.crossBoundaryErrors.push('reset');
}

async function loadExpectedSnapshots(pool, rooms) {
  const result = await pool.query(`
    SELECT event.id, coalesce(
      jsonb_agg(jsonb_build_array(words.word, words.count)
        ORDER BY words.count DESC, words.word ASC) FILTER (WHERE words.word IS NOT NULL),
      '[]'::jsonb
    ) AS words
    FROM events event LEFT JOIN words ON words.event_id = event.id
    WHERE event.id = ANY($1::bigint[])
    GROUP BY event.id
  `, [rooms.map((room) => room.id)]);
  const snapshots = new Map(result.rows.map((row) => [String(row.id), JSON.stringify(row.words)]));
  for (const room of rooms) room.expectedSnapshot = snapshots.get(String(room.id)) || '[]';
}

async function restartMachine(options) {
  await execFileAsync('flyctl', ['machine', 'restart', options.machineId, '--app', options.app], {
    timeout: 120_000,
    maxBuffer: 1024 * 1024,
  });
}

async function verifyReconnect(clients, options, state) {
  if (options.skipRestart) return { skipped: true, within15Seconds: null, eventual: null };
  state.restarting = true;
  state.restartStartedAt = Date.now();
  const stopSampling = { done: false };
  const sampler = sampleReconnectResources(options.baseUrl, state, stopSampling);
  await restartMachine(options);
  const deadline = Date.now() + 45_000;
  while (clients.some((client) => client.reconnectSnapshotAt === null) && Date.now() < deadline) await delay(100);
  stopSampling.done = true;
  await sampler;
  const reconnectEndedAt = Date.now();
  const correct = clients.filter((client) => client.reconnectSnapshotCorrect);
  const within15 = correct.filter((client) =>
    client.restartDisconnectedAt && client.reconnectSnapshotAt - client.restartDisconnectedAt <= 15_000
  );
  state.restarting = false;
  return {
    skipped: false,
    startedAt: new Date(state.restartStartedAt).toISOString(),
    endedAt: new Date(reconnectEndedAt).toISOString(),
    within15Seconds: within15.length / clients.length * 100,
    eventual: correct.length / clients.length * 100,
    latencyFromDisconnectMs: distribution(correct.map((client) =>
      client.reconnectSnapshotAt - client.restartDisconnectedAt
    )),
    latencyFromCommandMs: distribution(correct.map((client) =>
      client.reconnectSnapshotAt - state.restartStartedAt
    )),
    transportConnectFromDisconnectMs: distribution(correct.map((client) =>
      client.reconnectConnectedAt - client.restartDisconnectedAt
    )),
    snapshotAfterTransportConnectMs: distribution(correct.map((client) =>
      client.reconnectSnapshotAt - client.reconnectConnectedAt
    )),
  };
}

async function verifyProductionLimits(baseUrl, clients, rooms) {
  const room = rooms[3];
  const client = clients.find((entry) => entry.room.index === room.index);
  const probe = await connectClient(baseUrl, room, clients.length + 1, {
    runId: `abuse-${Date.now()}`, restarting: false, closing: false,
    unexpectedErrors: [], wordErrors: [], crossBoundaryErrors: [], pendingAcks: new Map(),
    pendingVisible: new Map(), acknowledgements: [], roomUpdateDelays: [], accepted: [],
    inboundApplicationBytes: 0, hotSnapshotBytes: null, observers: new Map(),
  }, 'websocket');
  let accepted = 0;
  let rejected = 0;
  probe.socket.on('word-accepted', () => { accepted += 1; });
  probe.socket.on('word-error', (error) => { if (error?.error === 'rate_limited') rejected += 1; });
  for (let index = 0; index < 4; index += 1) probe.socket.emit('submit-word', `${room.prefix}abuse-${index}`);
  const burstDeadline = Date.now() + 10_000;
  while (accepted + rejected < 4 && Date.now() < burstDeadline) await delay(50);
  probe.socket.close();

  const hotClients = clients.filter((entry) => entry.room.index === 0);
  const connectedDeadline = Date.now() + 5_000;
  while (hotClients.some((entry) => !entry.socket.connected) && Date.now() < connectedDeadline) {
    await delay(50);
  }
  const hotConnected = hotClients.filter((entry) => entry.socket.connected).length;

  // The load generator can legitimately alternate between IPv4 and IPv6,
  // producing two source identities. Probe the event-wide 500-socket ceiling
  // instead of assuming all 300 hot-room clients share one source hash. With
  // 300 established clients, at most 200 of these 220 may be accepted.
  const ceilingSockets = [];
  const ceilingOutcomes = await Promise.all(Array.from({ length: 220 }, () =>
    new Promise((resolve) => {
      const socket = io(baseUrl, {
        query: { slug: rooms[0].slug, guestId: crypto.randomBytes(16).toString('hex') },
        transports: ['websocket'], forceNew: true, reconnection: false,
      });
      ceilingSockets.push(socket);
      const timer = setTimeout(() => finish('timeout'), 15_000);
      let settled = false;
      function finish(outcome) {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(outcome);
      }
      socket.once('fatal-error', (value) => finish(value));
      socket.once('word-update', () => finish('accepted'));
      socket.once('connect_error', () => finish('connect_error'));
    })
  ));
  for (const socket of ceilingSockets) socket.close();
  const socketCeiling = {
    attempted: ceilingOutcomes.length,
    hotConnectedBeforeProbe: hotConnected,
    accepted: ceilingOutcomes.filter((outcome) => outcome === 'accepted').length,
    rateLimited: ceilingOutcomes.filter((outcome) => outcome === 'rate_limited').length,
    other: ceilingOutcomes.filter((outcome) => !['accepted', 'rate_limited'].includes(outcome)),
  };
  return {
    burstAccepted: accepted,
    burstRateLimited: rejected,
    sourceSocketOverflow: socketCeiling,
    passed: accepted === 3 && rejected === 1 && hotConnected === 300 &&
      socketCeiling.accepted <= 200 && socketCeiling.rateLimited >= 20 &&
      socketCeiling.other.length === 0 && client.socket.connected,
  };
}

function flyTokenFromJson(stdout) {
  const parsed = JSON.parse(stdout);
  if (typeof parsed === 'string') return parsed;
  return parsed.token || parsed.Token || parsed.access_token || parsed.accessToken;
}

function flyAuthorization(token) {
  const value = String(token || '').trim();
  return value.startsWith('FlyV1 ') ? value : `Bearer ${value}`;
}

function flyAuthorizations(token) {
  const value = String(token || '').trim();
  return [...new Set([
    flyAuthorization(value),
    value.startsWith('FlyV1 ') ? value : `FlyV1 ${value}`,
  ])];
}

async function queryFlyRange(options, query, start, end, step = 5) {
  const { stdout } = await execFileAsync('flyctl', ['auth', 'token', '--json'], {
    timeout: 20_000, maxBuffer: 1024 * 1024,
  });
  const token = flyTokenFromJson(stdout);
  if (!token) throw new Error('Could not obtain a Fly metrics token.');
  const url = new URL(`https://api.fly.io/prometheus/${options.organization}/api/v1/query_range`);
  url.searchParams.set('query', query);
  url.searchParams.set('start', String(start / 1_000));
  url.searchParams.set('end', String(end / 1_000));
  url.searchParams.set('step', String(step));
  let response;
  for (const authorization of flyAuthorizations(token)) {
    response = await fetch(url, {
      headers: { Authorization: authorization },
      signal: AbortSignal.timeout(30_000),
    });
    if (response.status !== 401) break;
  }
  if (!response?.ok) throw new Error(`Fly metrics query failed (${response?.status || 'unreachable'})`);
  const body = await response.json();
  const values = body?.data?.result?.flatMap((series) => series.values || []) || [];
  return values.map((entry) => Number(entry[1])).filter(Number.isFinite);
}

async function collectFlyMetrics(options, startedAt, endedAt) {
  await delay(20_000);
  const matcher = `{app="${options.app}"}`;
  const cpuQuery = `100 * sum(rate(fly_instance_cpu${matcher.replace('}', ',mode!="idle"}')}[30s])) / sum(rate(fly_instance_cpu${matcher}[30s]))`;
  const memoryQuery = `100 * (fly_instance_memory_mem_total${matcher} - fly_instance_memory_mem_available${matcher}) / fly_instance_memory_mem_total${matcher}`;
  const outboundQuery = `sum(rate(fly_instance_net_sent_bytes{app="${options.app}",device="eth0"}[30s]))`;
  const [cpu, memory, outbound] = await Promise.all([
    queryFlyRange(options, cpuQuery, startedAt, endedAt),
    queryFlyRange(options, memoryQuery, startedAt, endedAt),
    queryFlyRange(options, outboundQuery, startedAt, endedAt),
  ]);
  return {
    cpuPercent: distribution(cpu),
    memoryPercent: distribution(memory),
    outboundBytesPerSecond: distribution(outbound),
    approximateOutboundBytes: Math.round(outbound.reduce((sum, value) => sum + value * 5, 0)),
  };
}

function emptyFlyMetrics() {
  return {
    cpuPercent: distribution([]),
    memoryPercent: distribution([]),
    outboundBytesPerSecond: distribution([]),
    approximateOutboundBytes: 0,
  };
}

function summarizeInternalResources(samples) {
  return {
    processCpuPercent: distribution(samples.map((sample) => sample.process.cpuPercent)),
    rssBytes: distribution(samples.map((sample) => sample.process.rssBytes)),
    eventLoopP95Ms: distribution(samples.map((sample) => sample.eventLoopDelayMs.p95)),
    eventLoopP99Ms: distribution(samples.map((sample) => sample.eventLoopDelayMs.p99)),
    maxPoolTotal: Math.max(0, ...samples.map((sample) => sample.postgresPool.total)),
    maxPoolWaiting: Math.max(0, ...samples.map((sample) => sample.postgresPool.waiting)),
    finalBroadcastCounters: samples.at(-1)?.wordBroadcasts || null,
  };
}

function buildPasses({
  options, state, reconnect, fulfillmentRecovery, abuse,
  flyMetrics, reconnectFlyMetrics, offered,
}) {
  const ack = distribution(state.acknowledgements);
  const visible = distribution(state.roomUpdateDelays);
  const operationCount = options.sockets + offered + options.configurationSaves + options.estimates;
  const errorRate = (state.unexpectedErrors.length + state.wordErrors.length + state.crossBoundaryErrors.length) /
    Math.max(1, operationCount) * 100;
  const internal = summarizeInternalResources(state.resourceSamples);
  const reconnectInternal = summarizeInternalResources(state.reconnectResourceSamples);
  return {
    acknowledgementLatency: ack.p95 <= 300 && ack.p99 <= 1_000,
    roomUpdateLatency: visible.p95 <= 700 && visible.p99 <= 1_500,
    applicationErrorRate: errorRate < 0.5,
    reconnect: reconnect.skipped ? false : reconnect.within15Seconds >= 99,
    cpu: flyMetrics.cpuPercent.p95 !== null && reconnectFlyMetrics.cpuPercent.p95 !== null &&
      Math.max(flyMetrics.cpuPercent.p95, reconnectFlyMetrics.cpuPercent.p95) < 70,
    memory: flyMetrics.memoryPercent.max !== null && reconnectFlyMetrics.memoryPercent.max !== null &&
      Math.max(flyMetrics.memoryPercent.max, reconnectFlyMetrics.memoryPercent.max) < 75,
    databasePool: Math.max(internal.maxPoolWaiting, reconnectInternal.maxPoolWaiting) === 0,
    acceptedLoad: state.acknowledgements.length === offered && state.wordErrors.length === 0,
    isolation: state.crossBoundaryErrors.length === 0,
    fulfillmentRecovery: fulfillmentRecovery.recovered,
    productionLimits: abuse.passed,
  };
}

async function main(argv = process.argv.slice(2)) {
  const options = validateOptions(parseArgs(argv));
  const runId = `${Date.now().toString(36)}-${crypto.randomBytes(4).toString('hex')}`;
  const state = {
    runId, restarting: false, closing: false, unexpectedErrors: [], wordErrors: [],
    crossBoundaryErrors: [], pendingAcks: new Map(), pendingVisible: new Map(),
    acknowledgements: [], roomUpdateDelays: [], apiLatencies: [], estimateLatencies: [],
    accepted: [], inboundApplicationBytes: 0, hotSnapshotBytes: null,
    resourceSamples: [], reconnectResourceSamples: [], observers: new Map(),
  };
  const pool = makePool();
  let rooms = [];
  let clients = [];
  let report = null;
  try {
    await waitUntilReady(options.baseUrl);
    await performanceSnapshot(options.baseUrl);
    rooms = await seedFixtures(pool, options, runId);
    clients = await connectAll(options.baseUrl, rooms, options, state);
    if (state.hotSnapshotBytes === null || clients.filter((client) => client.room.index === 0).length < 300 && !options.quick) {
      throw new Error('The hot-room connection/snapshot precondition was not met.');
    }

    const stopSampling = { done: false };
    const sampler = sampleResources(options.baseUrl, state, stopSampling);
    const steadyStartedAt = Date.now();
    const apiWork = runApiWork(options.baseUrl, rooms, options, state);
    const offered = await runSubmissionLoad(clients, options, state);
    const configurations = await apiWork;
    const steadyEndedAt = Date.now();
    stopSampling.done = true;
    await sampler;

    await verifyIsolation(options.baseUrl, clients, rooms, state);
    await loadExpectedSnapshots(pool, rooms);
    const interruptedFulfillment = await seedInterruptedFulfillment(
      pool, rooms[1], configurations[0]?.configuration?.id, runId
    );
    const reconnect = await verifyReconnect(clients, options, state);
    const fulfillmentRecovery = await waitForFulfillmentRecovery(pool, interruptedFulfillment);
    const abuse = await verifyProductionLimits(options.baseUrl, clients, rooms);
    const [flyMetrics, reconnectFlyMetrics] = await Promise.all([
      collectFlyMetrics(options, steadyStartedAt, steadyEndedAt),
      reconnect.skipped
        ? Promise.resolve(emptyFlyMetrics())
        : collectFlyMetrics(options, Date.parse(reconnect.startedAt), Date.parse(reconnect.endedAt)),
    ]);
    const internal = summarizeInternalResources(state.resourceSamples);
    const reconnectInternal = summarizeInternalResources(state.reconnectResourceSamples);
    const operationCount = options.sockets + offered + options.configurationSaves + options.estimates;
    const errorRate = (state.unexpectedErrors.length + state.wordErrors.length + state.crossBoundaryErrors.length) /
      Math.max(1, operationCount) * 100;
    const passes = buildPasses({
      options, state, reconnect, fulfillmentRecovery, abuse,
      flyMetrics, reconnectFlyMetrics, offered,
    });
    report = {
      version: 2,
      runId,
      target: options.baseUrl,
      startedAt: new Date(steadyStartedAt).toISOString(),
      endedAt: new Date(steadyEndedAt).toISOString(),
      workload: {
        rooms: options.rooms, sockets: options.sockets, hotRoomSockets: options.hotRoomSockets,
        hotRoomSeed: { uniqueWords: 495, contributions: 4_950 },
        pollingSockets: options.pollingSockets,
        offeredSubmissions: offered,
        offeredPerSecond: options.submissionsPerSecond,
        acceptedSubmissions: state.acknowledgements.length,
        configurationSaves: options.configurationSaves,
        estimates: options.estimates,
        interruptedFulfillments: 1,
      },
      latencyMs: {
        acknowledgement: distribution(state.acknowledgements),
        roomUpdate: distribution(state.roomUpdateDelays),
        applicationApi: distribution(state.apiLatencies),
        externalPrintfulEstimate: distribution(state.estimateLatencies),
      },
      resources: {
        steady: { internal, fly: flyMetrics },
        reconnect: { internal: reconnectInternal, fly: reconnectFlyMetrics },
      },
      transport: {
        inboundApplicationBytes: state.inboundApplicationBytes,
        hotRoomSnapshotBytes: state.hotSnapshotBytes,
      },
      reconnect,
      fulfillmentRecovery,
      isolationErrors: state.crossBoundaryErrors,
      unexpectedErrors: state.unexpectedErrors,
      capacityWordErrors: state.wordErrors,
      unexpectedErrorRatePercent: Number(errorRate.toFixed(4)),
      productionRateLimits: abuse,
      gates: passes,
      passed: Object.values(passes).every(Boolean),
    };
    const reportPath = path.resolve(
      options.report || path.join(__dirname, '..', 'reports', 'socket-capacity-latest.json')
    );
    fs.mkdirSync(path.dirname(reportPath), { recursive: true });
    fs.writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600 });
    console.log(`[capacity] report written to ${reportPath}`);
    console.log(JSON.stringify(report, null, 2));
    if (!report.passed) process.exitCode = 1;
  } finally {
    state.closing = true;
    for (const client of clients) client.socket.close();
    await delay(250);
    if (rooms.length) await cleanupFixtures(pool, rooms);
    await pool.end();
  }
  return report;
}

if (require.main === module) {
  main().catch((error) => {
    console.error('[capacity] failed:', error.message);
    process.exitCode = 1;
  });
}

module.exports = {
  DEFAULTS,
  distribution,
  flyAuthorization,
  flyAuthorizations,
  flyTokenFromJson,
  main,
  parseArgs,
  percentile,
  queryFlyRange,
  summarizeFulfillmentRecovery,
  validateOptions,
  wordsAreScoped,
};
