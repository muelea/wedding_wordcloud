'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { testEnvironment, validateTestDatabaseUrl } = require('./support/local-postgres');
const { startTestServer } = require('./helpers');

test('test database validation rejects hosted targets and connection parameter overrides', () => {
  for (const value of [
    'postgresql://postgres:secret@db.example.com:5432/wolkenworte_test',
    'postgresql://postgres:secret@127.0.0.1:5432/postgres',
    'postgresql://postgres:secret@127.0.0.1:5432/wolkenworte_test?host=db.example.com',
    'postgresql://postgres:secret@127.0.0.1:5432/wolkenworte_test?dbname=postgres',
    'not-a-url',
  ]) assert.throws(() => validateTestDatabaseUrl(value));
  for (const host of ['127.0.0.1', 'localhost', '[::1]']) {
    const url = `postgresql://postgres:disposable@${host}:5432/wolkenworte_test`;
    assert.equal(validateTestDatabaseUrl(url), url);
  }
});

test('test environment removes hosted credentials and prevents dotenv from reimporting them', () => {
  const local = 'postgresql://postgres:disposable@127.0.0.1:5432/wolkenworte_test';
  const source = { PATH: '/bin', DATABASE_URL: 'hosted', MIGRATION_DATABASE_URL: 'privileged',
    SUPABASE_URL: 'https://real-project.supabase.co',
    SUPABASE_SECRET_KEY: 'real-storage-key', STRIPE_LIVE_SECRET_KEY: 'real-payment-key',
    EMAIL_DELIVERY_MODE: 'live', PRINTFUL_ALLOW_ORDER_WRITES: 'true' };
  const env = testEnvironment(source, local);
  require('dotenv').populate(env, { DATABASE_URL: 'hosted', MIGRATION_DATABASE_URL: 'privileged',
    SUPABASE_SECRET_KEY: 'real-storage-key', STRIPE_LIVE_SECRET_KEY: 'real-payment-key' });
  assert.equal(env.DATABASE_URL, local);
  assert.equal(env.MIGRATION_DATABASE_URL, '');
  assert.equal(env.SUPABASE_SECRET_KEY, '');
  assert.equal(new URL(env.SUPABASE_URL).hostname, 'supabase.wolkenworte.invalid');
  assert.equal(env.STRIPE_LIVE_SECRET_KEY, '');
  assert.equal(env.EMAIL_DELIVERY_MODE, 'mock');
  assert.equal(env.PRINTFUL_ALLOW_ORDER_WRITES, 'false');
  assert.equal(env.PATH, '/bin');
  assert.equal(source.DATABASE_URL, 'hosted');
});

test('application pool refuses hosted connections even if a test overwrites DATABASE_URL', () => {
  const { connectionOptions } = require('../src/dbConfig');
  assert.throws(() => connectionOptions('postgresql://postgres:secret@db.example.com:5432/postgres'), /nur lokales Postgres/);
  assert.throws(() => connectionOptions('postgresql://postgres:secret@localhost:5432/wolkenworte_test?host=db.example.com'), /nur lokales Postgres/);
  const previous = process.env.NODE_ENV;
  try {
    // Some tests simulate production settings. Node's test-worker marker must
    // keep database isolation in force even then.
    for (const mode of ['development', 'production']) {
      process.env.NODE_ENV = mode;
      assert.throws(() => connectionOptions('postgresql://postgres:secret@db.example.com:5432/postgres'), /nur lokales Postgres/);
    }
  } finally { process.env.NODE_ENV = previous; }
});

test('workstation dotenv imports are skipped even with override enabled', () => {
  assert.deepEqual(require('dotenv').config({ override: true }), { parsed: {} });
  assert.equal(process.env.MIGRATION_DATABASE_URL, '');
  assert.equal(process.env.SUPABASE_SECRET_KEY, '');
});

test('local fixtures clean up failed startup and allow repeated close calls', async t => {
  const app = await startTestServer();
  t.after(app.close);
  assert.equal((await app.query('SELECT current_database() AS name')).rows[0].name, 'wolkenworte_test');
  const schemas = async () => (await app.query('SELECT nspname FROM pg_namespace WHERE nspname LIKE $1 ORDER BY nspname',
    [`test_${process.pid}_%`])).rows;
  const before = await schemas();
  const previous = process.env.APP_ENVIRONMENT;
  try {
    process.env.APP_ENVIRONMENT = 'production';
    await assert.rejects(startTestServer(), /NODE_ENV=production/);
  } finally { process.env.APP_ENVIRONMENT = previous; }
  assert.deepEqual(await schemas(), before);
  await assert.rejects(startTestServer({ host: 'invalid.invalid' }), /ENOTFOUND|EAI_AGAIN/);
  assert.deepEqual(await schemas(), before);
  await Promise.all([app.close(), app.close()]);
});
