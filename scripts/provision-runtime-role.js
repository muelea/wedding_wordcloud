'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { Pool } = require('pg');

const ENV_PATH = path.join(__dirname, '..', '.env');
require('dotenv').config({ path: ENV_PATH });
const { connectionOptions, parseDatabaseUrl } = require('../src/dbConfig');

function replaceEnvValue(source, name, value) {
  const line = `${name}=${value}`;
  const pattern = new RegExp(`^${name}=.*$`, 'm');
  return pattern.test(source) ? source.replace(pattern, line) : `${source.trimEnd()}\n${line}\n`;
}

async function main() {
  const migrationUrl = process.env.MIGRATION_DATABASE_URL;
  if (!migrationUrl) throw new Error('MIGRATION_DATABASE_URL ist nicht gesetzt.');
  const migrationPool = new Pool(connectionOptions(migrationUrl, {
    schema: 'public',
    applicationName: 'wolkenworte-role-provisioner',
    requireDirect: false,
  }));
  const password = crypto.randomBytes(32).toString('base64url');
  const passwordLiteral = `'${password.replace(/'/g, "''")}'`;
  try {
    const role = await migrationPool.query(
      "SELECT 1 FROM pg_roles WHERE rolname = 'wolkenworte_app'"
    );
    if (!role.rowCount) throw new Error('Runtime-Rolle fehlt; bitte zuerst npm run db:migrate ausführen.');
    await migrationPool.query(
      `ALTER ROLE wolkenworte_app LOGIN PASSWORD ${passwordLiteral} VALID UNTIL 'infinity'`
    );

    const runtimeUrl = parseDatabaseUrl(migrationUrl, 'MIGRATION_DATABASE_URL');
    runtimeUrl.username = 'wolkenworte_app';
    runtimeUrl.password = password;
    runtimeUrl.searchParams.set('sslmode', 'verify-full');

    const runtimePool = new Pool(connectionOptions(runtimeUrl.toString(), {
      schema: 'public',
      applicationName: 'wolkenworte-role-verification',
      requireDirect: true,
    }));
    try {
      const identity = await runtimePool.query(`
        SELECT current_user AS current_user,
               (SELECT max(version)::text FROM app_schema_versions) AS schema_version
      `);
      if (identity.rows[0]?.current_user !== 'wolkenworte_app' || identity.rows[0]?.schema_version !== '2') {
        throw new Error(
          'Runtime-Rolle kann das Wolkenworte-Schema nicht korrekt lesen ' +
          `(user=${identity.rows[0]?.current_user || 'unknown'}, ` +
          `schema=${identity.rows[0]?.schema_version || 'missing'}).`
        );
      }
      let ddlWasBlocked = false;
      try {
        await runtimePool.query('CREATE TABLE runtime_ddl_must_fail (id integer)');
      } catch (error) {
        ddlWasBlocked = error.code === '42501';
      }
      if (!ddlWasBlocked) {
        await migrationPool.query('DROP TABLE IF EXISTS public.runtime_ddl_must_fail');
        throw new Error('Runtime-Rolle besitzt unerwartet DDL-Rechte.');
      }
    } finally {
      await runtimePool.end();
    }

    const currentEnv = fs.readFileSync(ENV_PATH, 'utf8');
    const updatedEnv = replaceEnvValue(currentEnv, 'DATABASE_URL', runtimeUrl.toString());
    const temporaryPath = `${ENV_PATH}.tmp-${process.pid}`;
    fs.writeFileSync(temporaryPath, updatedEnv, { mode: 0o600 });
    fs.renameSync(temporaryPath, ENV_PATH);
    fs.chmodSync(ENV_PATH, 0o600);
    console.log('[database] least-privileged wolkenworte_app role verified; DATABASE_URL updated in .env');
  } finally {
    await migrationPool.end();
  }
}

if (require.main === module) {
  main().catch((error) => {
    console.error('[database] runtime-role provisioning failed:', error.message);
    process.exitCode = 1;
  });
}

module.exports = { main, replaceEnvValue };
