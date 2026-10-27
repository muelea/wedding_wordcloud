'use strict';

// Hosted connections perform catalog queries and harmless reads only. Expected
// schemas are built by applying the candidate migrations to disposable Docker
// Postgres, never by creating a test schema on the application database.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { Client } = require('pg');
const { connectionOptions } = require('../src/dbConfig');
const { cleanupTargetFingerprint } = require('../src/cleanupTarget');
const { startLocalPostgres } = require('../test/support/local-postgres');

const ROOT = path.join(__dirname, '..');
const PUBLIC_URL = 'https://wolkenworte.io';
const quote = value => `"${String(value).replaceAll('"', '""')}"`;
function migrations() {
  return fs.readdirSync(path.join(ROOT, 'supabase/migrations'))
    .filter(name => /^\d+_[a-z0-9_]+\.sql$/.test(name)).sort().map(version => {
      const sql = fs.readFileSync(path.join(ROOT, 'supabase/migrations', version), 'utf8');
      return { version, sql, checksum: crypto.createHash('sha256').update(sql).digest('hex') };
    });
}

function migrationPrefix(rows, files, { current = false } = {}) {
  if (!rows.length || rows.length > files.length) throw new Error('Unexpected target migration history.');
  rows.forEach((row, index) => {
    if (row.version !== files[index].version || row.checksum !== files[index].checksum) {
      throw new Error(`Target migration history differs at position ${index + 1}.`);
    }
  });
  if (current && rows.length !== files.length) throw new Error('Target still has pending migrations.');
  return rows.length;
}

function validateTargetUrls(env) {
  const project = new URL(env.SUPABASE_URL);
  const runtime = new URL(env.DATABASE_URL);
  const operator = new URL(env.MIGRATION_DATABASE_URL);
  const match = /^([a-z0-9]+)\.supabase\.co$/.exec(project.hostname);
  if (!match || project.protocol !== 'https:' || runtime.hostname !== `db.${match[1]}.supabase.co` ||
      runtime.username !== 'wolkenworte_app' || runtime.pathname !== '/postgres' ||
      !['postgres:', 'postgresql:'].includes(runtime.protocol) ||
      !['postgres:', 'postgresql:'].includes(operator.protocol) ||
      operator.pathname !== runtime.pathname ||
      !(operator.hostname === runtime.hostname ||
        (operator.hostname.endsWith('.pooler.supabase.com') &&
          decodeURIComponent(operator.username) === `postgres.${match[1]}`))) {
    throw new Error('Database connections do not identify the same Supabase target and restricted runtime role.');
  }
}

async function verifyTargetIdentity(env, fetchImpl = fetch) {
  validateTargetUrls(env);
  const response = await fetchImpl(`${PUBLIC_URL}/internal/performance/cleanup-target`, {
    headers: { Authorization: `Bearer ${env.MAINTENANCE_SECRET}` },
    redirect: 'error', signal: AbortSignal.timeout(15_000),
  });
  const target = response.ok ? await response.json() : null;
  if (target?.fingerprint !== cleanupTargetFingerprint(env)) {
    throw new Error('Local database identity does not match the deployed application.');
  }
}

async function readOnly(client, work) {
  await client.query('BEGIN READ ONLY');
  try {
    await client.query("SET LOCAL statement_timeout = '5s'");
    await client.query("SET LOCAL lock_timeout = '1s'");
    await client.query("SET LOCAL idle_in_transaction_session_timeout = '10s'");
    return await work(client);
  } finally { await client.query('ROLLBACK'); }
}

async function schemaSnapshot(client, schema, names = null) {
  const tables = (await client.query(`SELECT c.relname AS name FROM pg_class c
    JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname=$1 AND c.relkind IN ('r','p')
    AND ($2::text[] IS NULL OR c.relname=ANY($2)) ORDER BY c.relname COLLATE "C"`, [schema, names])).rows;
  const tableNames = tables.map(table => table.name);
  const columns = (await client.query(`SELECT c.relname AS table_name,a.attname AS name,
    format_type(a.atttypid,a.atttypmod) AS type,a.attnotnull AS not_null,
    a.attidentity AS identity,a.attgenerated AS generated,pg_get_expr(d.adbin,d.adrelid) AS default_value
    FROM pg_attribute a JOIN pg_class c ON c.oid=a.attrelid JOIN pg_namespace n ON n.oid=c.relnamespace
    LEFT JOIN pg_attrdef d ON d.adrelid=c.oid AND d.adnum=a.attnum
    WHERE n.nspname=$1 AND c.relname=ANY($2) AND a.attnum>0 AND NOT a.attisdropped
    ORDER BY c.relname COLLATE "C",a.attnum`, [schema, tableNames])).rows;
  const constraints = (await client.query(`SELECT c.relname AS table_name,k.conname AS name,
    pg_get_constraintdef(k.oid,true) AS definition FROM pg_constraint k
    JOIN pg_class c ON c.oid=k.conrelid JOIN pg_namespace n ON n.oid=c.relnamespace
    WHERE n.nspname=$1 AND c.relname=ANY($2) ORDER BY c.relname COLLATE "C",k.conname COLLATE "C"`,
  [schema, tableNames])).rows;
  const indexes = (await client.query(`SELECT c.relname AS table_name,i.relname AS name,
    pg_get_indexdef(i.oid) AS definition,x.indisvalid AS valid FROM pg_index x
    JOIN pg_class c ON c.oid=x.indrelid JOIN pg_class i ON i.oid=x.indexrelid
    JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname=$1 AND c.relname=ANY($2)
    ORDER BY c.relname COLLATE "C",i.relname COLLATE "C"`, [schema, tableNames])).rows;
  const sequences = (await client.query(`SELECT c.relname AS name FROM pg_class c
    JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname=$1 AND c.relkind='S'
    ORDER BY c.relname COLLATE "C"`, [schema])).rows;
  const functions = (await client.query(`SELECT p.proname AS name,
    pg_get_function_identity_arguments(p.oid) AS arguments,p.prosrc AS body,
    p.prosecdef AS security_definer,p.provolatile AS volatility,l.lanname AS language
    FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace JOIN pg_language l ON l.oid=p.prolang
    WHERE n.nspname=$1 AND p.proname=ANY($2)
    ORDER BY p.proname COLLATE "C",pg_get_function_identity_arguments(p.oid) COLLATE "C"`,
  [schema, ['set_event_expiry', 'touch_word_events', 'touch_configuration_event']])).rows;
  const triggers = (await client.query(`SELECT c.relname AS table_name,t.tgname AS name,
    pg_get_triggerdef(t.oid,true) AS definition,t.tgenabled AS enabled FROM pg_trigger t
    JOIN pg_class c ON c.oid=t.tgrelid JOIN pg_namespace n ON n.oid=c.relnamespace
    WHERE n.nspname=$1 AND c.relname=ANY($2) AND NOT t.tgisinternal
    ORDER BY c.relname COLLATE "C",t.tgname COLLATE "C"`, [schema, tableNames])).rows;
  const versions = (await client.query(`SELECT version::text FROM ${quote(schema)}.app_schema_versions ORDER BY version`)).rows;
  // pg_get_* qualifies names when the inspected schema is not on search_path.
  const normalize = value => JSON.parse(JSON.stringify(value).replaceAll(`${schema}.`, '').replaceAll(`${quote(schema)}.`, ''));
  return normalize({ tables, columns, constraints, indexes, sequences, functions, triggers, versions });
}

function compareSchema(actual, expected) {
  for (const section of Object.keys(expected)) {
    if (JSON.stringify(actual[section]) !== JSON.stringify(expected[section])) {
      throw new Error(`Target schema drift in ${section}.`);
    }
  }
}

async function expectedSchema(files, prefix) {
  const database = await startLocalPostgres();
  const client = new Client({ connectionString: database.url });
  try {
    await client.connect();
    await client.query('CREATE SCHEMA release_reference');
    await client.query('SET search_path TO release_reference, public');
    for (const file of files.slice(0, prefix)) await client.query(file.sql);
    return await schemaSnapshot(client, 'release_reference');
  } finally {
    await client.end().catch(() => {});
    await database.close();
  }
}

async function verifyRuntime(client, expected, schema = 'public') {
  const role = (await client.query(`SELECT current_user AS name,rolsuper,rolcreaterole,rolcreatedb,
    rolreplication,rolbypassrls,has_schema_privilege(current_user,$1,'USAGE') AS usage,
    has_schema_privilege(current_user,$1,'CREATE') AS create_objects
    FROM pg_roles WHERE rolname=current_user`, [schema])).rows[0];
  const elevated = (await client.query(`SELECT rolname FROM pg_roles WHERE
    (rolsuper OR rolcreaterole OR rolcreatedb OR rolreplication OR rolbypassrls)
    AND pg_has_role(current_user,oid,'USAGE')`)).rows;
  if (role?.name !== 'wolkenworte_app' || !role.usage || role.create_objects || elevated.length) {
    throw new Error('Runtime database role is not least-privileged.');
  }
  const names = expected.tables.map(table => table.name);
  const privileges = (await client.query(`SELECT c.relname AS name,c.relrowsecurity AS rls,
    has_table_privilege(current_user,c.oid,'SELECT') AND has_table_privilege(current_user,c.oid,'INSERT')
    AND has_table_privilege(current_user,c.oid,'UPDATE') AND has_table_privilege(current_user,c.oid,'DELETE') AS dml,
    has_table_privilege(current_user,c.oid,'TRUNCATE') OR has_table_privilege(current_user,c.oid,'TRIGGER') AS ddl,
    EXISTS(SELECT 1 FROM pg_policy p WHERE p.polrelid=c.oid AND p.polcmd='*' AND p.polpermissive
      AND pg_get_expr(p.polqual,p.polrelid)='true' AND pg_get_expr(p.polwithcheck,p.polrelid)='true'
      AND EXISTS(SELECT 1 FROM unnest(p.polroles) r WHERE r=0 OR pg_has_role(current_user,r,'USAGE'))) AS policy
    FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
    WHERE n.nspname=$1 AND c.relname=ANY($2)`, [schema, names])).rows;
  if (privileges.length !== names.length || privileges.some(row => !row.rls || !row.dml || row.ddl || !row.policy)) {
    throw new Error('Runtime table privileges or row security differ from the application contract.');
  }
  for (const sequence of expected.sequences) {
    const value = (await client.query(`SELECT has_sequence_privilege(current_user,$1,'USAGE')
      AND has_sequence_privilege(current_user,$1,'SELECT') AS ok`, [`${quote(schema)}.${quote(sequence.name)}`])).rows[0];
    if (!value.ok) throw new Error(`Runtime sequence access is missing: ${sequence.name}.`);
  }
  for (const fn of expected.functions) {
    const value = (await client.query('SELECT has_function_privilege(current_user,$1,\'EXECUTE\') AS ok',
      [`${quote(schema)}.${quote(fn.name)}(${fn.arguments})`])).rows[0];
    if (!value.ok) throw new Error(`Runtime function access is missing: ${fn.name}.`);
  }
  if (schema === 'public') {
    const forbidden = (await client.query(`SELECT
      has_table_privilege(current_user,'public.wolkenworte_migrations','SELECT') AS migrations,
      has_function_privilege(current_user,'public.configure_wolkenworte_maintenance_cron()','EXECUTE') AS cron`)).rows[0];
    if (forbidden.migrations || forbidden.cron) throw new Error('Runtime can access privileged operator objects.');
  }
  // Resolve every application table through the real role, without reading
  // customer content, advancing sequences or invoking functions/triggers.
  for (const name of names) await client.query(`SELECT * FROM ${quote(schema)}.${quote(name)} LIMIT 0`);
}

async function run({ env = process.env, current = false, fetchImpl = fetch, output = console.log } = {}) {
  await verifyTargetIdentity(env, fetchImpl);
  const files = migrations();
  const operator = new Client({ ...connectionOptions(env.MIGRATION_DATABASE_URL, {
    schema: 'public', requireDirect: false, applicationName: 'wolkenworte-release-catalog',
  }), query_timeout: 10_000 });
  const runtime = new Client(connectionOptions(env.DATABASE_URL, {
    schema: 'public', requireDirect: true, applicationName: 'wolkenworte-release-runtime',
  }));
  try {
    await operator.connect();
    const prefix = await readOnly(operator, async client => migrationPrefix((await client.query(
      'SELECT version,checksum FROM public.wolkenworte_migrations ORDER BY version LIMIT 1000',
    )).rows, files, { current }));
    const expected = await expectedSchema(files, prefix);
    await readOnly(operator, async client => {
      // Fence concurrent migration changes while the local reference was built.
      migrationPrefix((await client.query(
        'SELECT version,checksum FROM public.wolkenworte_migrations ORDER BY version LIMIT 1000',
      )).rows, files.slice(0, prefix), { current: true });
      compareSchema(await schemaSnapshot(client, 'public', expected.tables.map(table => table.name)), expected);
    });
    await runtime.connect();
    await readOnly(runtime, async client => {
      compareSchema(await schemaSnapshot(client, 'public', expected.tables.map(table => table.name)), expected);
      await verifyRuntime(client, expected);
    });
    const result = { targetIdentity: 'matched', migrations: prefix, pending: files.slice(prefix).map(file => file.version),
      schema: 'matched', runtimePrivileges: 'verified', hostedWrites: false };
    output(JSON.stringify(result, null, 2));
    return result;
  } finally {
    await Promise.allSettled([operator.end(), runtime.end()]);
  }
}

if (require.main === module) {
  require('dotenv').config({ path: path.join(ROOT, '.env'), override: true });
  const args = process.argv.slice(2);
  if (args.length !== 1 || !['--before-migrations', '--current'].includes(args[0])) {
    console.error('Use exactly --before-migrations or --current.');
    process.exitCode = 1;
  } else run({ current: args[0] === '--current' }).catch(error => {
    console.error('[release:database] verification failed:', error.message);
    process.exitCode = 1;
  });
}
module.exports = { migrations, migrationPrefix, validateTargetUrls, verifyTargetIdentity, readOnly,
  schemaSnapshot, compareSchema, expectedSchema, verifyRuntime, run };
