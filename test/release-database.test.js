'use strict';

require('./support/test-environment');
const test = require('node:test');
const assert = require('node:assert/strict');
const { Client } = require('pg');
const { startLocalPostgres, validateTestDatabaseUrl } = require('./support/local-postgres');
const verifier = require('../scripts/verify-release-database');
const { cleanupTargetFingerprint } = require('../src/cleanupTarget');

const target = {
  SUPABASE_URL: 'https://fixtureproject.supabase.co',
  DATABASE_URL: 'postgresql://wolkenworte_app:fixture@db.fixtureproject.supabase.co/postgres',
  MIGRATION_DATABASE_URL: 'postgresql://postgres:fixture@db.fixtureproject.supabase.co/postgres',
  MAINTENANCE_SECRET: 'fixture-secret',
};

test('release target identity binds both database connections to the authenticated deployed target', async () => {
  verifier.validateTargetUrls(target);
  verifier.validateTargetUrls({ ...target, MIGRATION_DATABASE_URL:
    'postgresql://postgres.fixtureproject:fixture@aws-0-eu.pooler.supabase.com/postgres' });
  for (const override of [
    { DATABASE_URL: 'postgresql://postgres:fixture@db.fixtureproject.supabase.co/postgres' },
    { MIGRATION_DATABASE_URL: 'postgresql://postgres:fixture@db.other.supabase.co/postgres' },
    { MIGRATION_DATABASE_URL: 'postgresql://postgres.other:fixture@aws-0-eu.pooler.supabase.com/postgres' },
    { DATABASE_URL: 'postgresql://wolkenworte_app:fixture@localhost/postgres' },
  ]) assert.throws(() => verifier.validateTargetUrls({ ...target, ...override }), /same Supabase target/);
  await verifier.verifyTargetIdentity(target, async (url, options) => {
    assert.equal(url, 'https://wolkenworte.io/internal/performance/cleanup-target');
    assert.equal(options.redirect, 'error');
    assert.equal(options.headers.Authorization, 'Bearer fixture-secret');
    return Response.json({ fingerprint: cleanupTargetFingerprint(target) });
  });
  await assert.rejects(verifier.verifyTargetIdentity(target, async () => Response.json({ fingerprint: 'different' })), /does not match/);
  await assert.rejects(verifier.verifyTargetIdentity(target, async () => new Response('', { status: 404 })), /does not match/);
});

test('migration history accepts only an exact checksum prefix and requires completion after migration', () => {
  const files = verifier.migrations();
  const applied = files.map(({ version, checksum }) => ({ version, checksum }));
  assert.equal(verifier.migrationPrefix(applied.slice(0, -1), files), files.length - 1);
  assert.equal(verifier.migrationPrefix(applied, files, { current: true }), files.length);
  for (const rows of [[], applied.slice(1), [...applied, applied[0]],
    applied.map((row, index) => index === 0 ? { ...row, checksum: 'changed' } : row)]) {
    assert.throws(() => verifier.migrationPrefix(rows, files), /migration history/);
  }
  assert.throws(() => verifier.migrationPrefix(applied.slice(0, -1), files, { current: true }), /pending migrations/);
});

test('real Postgres rejects writes in hosted checks and detects schema drift and lost runtime privileges', async () => {
  // Own disposable database: role setup cannot interfere with other test files.
  const database = await startLocalPostgres();
  const client = new Client({ connectionString: validateTestDatabaseUrl(database.url) });
  try {
    await client.connect();
    await client.query('CREATE SCHEMA release_contract');
    await client.query('SET search_path TO release_contract, public');
    for (const file of verifier.migrations()) await client.query(file.sql);
    const expected = await verifier.schemaSnapshot(client, 'release_contract');
    assert.equal(expected.versions.at(-1).version, '10');
    assert.ok(expected.tables.some(table => table.name === 'prepared_print_files'));
    await verifier.readOnly(client, async read => {
      assert.equal((await read.query('SHOW transaction_read_only')).rows[0].transaction_read_only, 'on');
      verifier.compareSchema(await verifier.schemaSnapshot(read, 'release_contract'), expected);
    });
    await assert.rejects(verifier.readOnly(client, read => read.query('CREATE TABLE must_not_exist(id int)')), { code: '25006' });
    assert.equal((await client.query("SELECT to_regclass('release_contract.must_not_exist') AS name")).rows[0].name, null);
    await client.query('ALTER TABLE events ADD COLUMN accidental_drift text');
    assert.throws(() => verifier.compareSchema({ ...expected, columns: [] }, expected), /drift in columns/);
    await assert.rejects(verifier.readOnly(client, async read => {
      verifier.compareSchema(await verifier.schemaSnapshot(read, 'release_contract'), expected);
    }), /drift in columns/);
    await client.query('ALTER TABLE events DROP COLUMN accidental_drift');
    await client.query('CREATE ROLE wolkenworte_app NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS');
    await client.query('GRANT USAGE ON SCHEMA release_contract TO wolkenworte_app');
    await client.query('GRANT SELECT,INSERT,UPDATE,DELETE ON ALL TABLES IN SCHEMA release_contract TO wolkenworte_app');
    await client.query('GRANT USAGE,SELECT ON ALL SEQUENCES IN SCHEMA release_contract TO wolkenworte_app');
    for (const table of expected.tables) {
      await client.query(`ALTER TABLE release_contract."${table.name}" ENABLE ROW LEVEL SECURITY`);
      await client.query(`CREATE POLICY runtime_all ON release_contract."${table.name}" FOR ALL TO wolkenworte_app USING(true) WITH CHECK(true)`);
    }
    await client.query('SET ROLE wolkenworte_app');
    await verifier.readOnly(client, read => verifier.verifyRuntime(read, expected, 'release_contract'));
    await client.query('RESET ROLE');
    await client.query('REVOKE UPDATE ON release_contract.orders FROM wolkenworte_app');
    await client.query('SET ROLE wolkenworte_app');
    await assert.rejects(verifier.readOnly(client, read => verifier.verifyRuntime(read, expected, 'release_contract')), /table privileges/);
    await client.query('RESET ROLE');
    await client.query('GRANT UPDATE ON release_contract.orders TO wolkenworte_app');
    await client.query('GRANT CREATE ON SCHEMA release_contract TO wolkenworte_app');
    await client.query('SET ROLE wolkenworte_app');
    await assert.rejects(verifier.readOnly(client, read => verifier.verifyRuntime(read, expected, 'release_contract')), /least-privileged/);
  } finally {
    await client.end().catch(() => {});
    await database.close();
  }
});
