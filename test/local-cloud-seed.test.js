'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const seedTool = require('../scripts/seed-local-cloud');
const { startTestServer } = require('./helpers');

function fixture(overrides = {}) {
  return {
    version: 1,
    event: { title: 'Marketing Cloud', locale: 'de', pin: '2468' },
    words: [
      { word: 'Liebe', count: 5 },
      { word: 'Glück', count: 3 },
      { word: '❤️', count: 2 },
    ],
    ...overrides,
  };
}

test('local cloud seed parser normalizes and merges weighted words', () => {
  const normalized = seedTool.normalizeSeedDocument(fixture({
    event: { title: '  Marketing   mit Herz  ', locale: 'DE-de', pin: '02468' },
    words: [
      { word: ' Liebe ', count: 5 },
      { word: 'LIEBE', count: 2 },
      { word: 'Glück', count: 3 },
      { word: '❤️', count: 2 },
    ],
  }));

  assert.deepEqual(normalized, {
    title: 'Marketing mit Herz',
    locale: 'de',
    pin: '02468',
    words: [['liebe', 7], ['glück', 3], ['❤️', 2]],
    inputWordCount: 4,
    contributionCount: 12,
  });
});

test('local cloud seed parser rejects ambiguous or over-limit input', () => {
  assert.throws(
    () => seedTool.normalizeSeedDocument({ ...fixture(), extra: true }),
    /unbekannte Felder: extra/
  );
  assert.throws(
    () => seedTool.normalizeSeedDocument(fixture({
      event: { title: 'Cloud', locale: 'de', pin: 2468 },
    })),
    /Zeichenkette aus 4–6 Ziffern/
  );
  assert.throws(
    () => seedTool.normalizeSeedDocument(fixture({
      words: [{ word: 'Liebe', count: 5001 }],
    })),
    /höchstens 5000 Beiträge/
  );
  assert.throws(
    () => seedTool.normalizeSeedDocument(fixture({
      words: [{ word: 'Liebe', count: 1, weight: 20 }],
    })),
    /unbekannte Felder: weight/
  );
});

test('local cloud seed command has explicit environment and database guards', () => {
  const local = {
    APP_ENVIRONMENT: 'local', NODE_ENV: 'development',
    DATABASE_URL: 'postgresql://postgres:postgres@127.0.0.1:54322/postgres',
  };
  assert.deepEqual(seedTool.assertLocalSeedSafety(local), { localDatabase: true });
  assert.throws(
    () => seedTool.assertLocalSeedSafety({ ...local, APP_ENVIRONMENT: 'hosted-test' }),
    /nur mit APP_ENVIRONMENT=local/
  );
  assert.throws(
    () => seedTool.assertLocalSeedSafety({ ...local, NODE_ENV: 'production' }),
    /außerhalb von NODE_ENV=production/
  );
  const remote = { ...local, DATABASE_URL: 'postgresql://app:secret@db.example.com/postgres' };
  assert.throws(() => seedTool.assertLocalSeedSafety(remote), /nicht auf localhost/);
  assert.deepEqual(
    seedTool.assertLocalSeedSafety({ ...remote, ALLOW_REMOTE_MARKETING_SEEDS: 'true' }),
    { localDatabase: false }
  );
});

test('local cloud seed arguments require exactly one file', () => {
  assert.deepEqual(seedTool.parseArgs(['cloud.json']), {
    filename: 'cloud.json', help: false,
  });
  assert.throws(() => seedTool.parseArgs([]), /Seed-Datei fehlt/);
  assert.throws(() => seedTool.parseArgs(['one.json', 'two.json']), /nur eine Seed-Datei/);
  assert.throws(() => seedTool.parseArgs(['--allow-remote-development-db']), /Unbekannte Option/);
  assert.throws(() => seedTool.parseArgs(['--unknown']), /Unbekannte Option/);
});

test('seeded event stores aggregate counts and matching private contributions atomically', async (t) => {
  const app = await startTestServer();
  t.after(app.close);
  const db = require('../src/db');

  const before = await app.query('SELECT count(*)::integer AS count FROM events');
  await assert.rejects(
    db.createSeededEvent({
      title: 'Too Large', pin: '2468', locale: 'de', words: [['liebe', 5001]],
    }),
    (error) => error.code === 'event_contribution_limit'
  );
  const afterRejected = await app.query('SELECT count(*)::integer AS count FROM events');
  assert.equal(afterRejected.rows[0].count, before.rows[0].count);

  const event = await db.createSeededEvent({
    title: 'Atomare Marketing Cloud',
    pin: '2468',
    locale: 'de',
    words: [['liebe', 7], ['glück', 3]],
  });
  assert.deepEqual(await db.getWords(event.id), [['liebe', 7], ['glück', 3]]);

  const stored = await app.query(`
    SELECT count(*)::integer AS contributions,
           count(DISTINCT owner_id)::integer AS owners,
           bool_and(receipt_id ~ '^[A-Za-z0-9_-]{24}$') AS valid_receipts
    FROM word_contributions
    WHERE event_id = $1
  `, [event.id]);
  assert.deepEqual(stored.rows[0], {
    contributions: 10,
    owners: 10,
    valid_receipts: true,
  });
  assert.equal(await db.verifyPin(
    '2468', event.organizer_pin_hash, event.organizer_pin_salt
  ), true);

  const owner = 'a'.repeat(32);
  const receipt = await db.addWordContribution(event.id, 'liebe', owner);
  assert.deepEqual(await db.getWords(event.id), [['liebe', 8], ['glück', 3]]);
  assert.equal(await db.removeWordContribution(event.id, receipt, owner), 'liebe');
  assert.deepEqual(await db.getWords(event.id), [['liebe', 7], ['glück', 3]]);
});
