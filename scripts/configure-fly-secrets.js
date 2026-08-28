'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');

require('dotenv').config({ path: path.join(__dirname, '..', '.env') });
const { parseDatabaseUrl } = require('../src/dbConfig');

const APP = process.env.FLY_APP_NAME || 'wolkenworte';
const REQUIRED = [
  'DATABASE_URL',
  'SUPABASE_URL',
  'SUPABASE_SECRET_KEY',
  'RATE_LIMIT_HMAC_SECRET',
  'MAINTENANCE_SECRET',
];
const OPTIONAL = [
  'STRIPE_TEST_SECRET_KEY',
  'RESEND_API_KEY',
  'RESEND_FROM_EMAIL',
  'RESEND_WEBHOOK_SECRET',
  'RESEND_SMOKE_RECIPIENTS',
  'PRINTFUL_API_KEY',
  'PRINTFUL_STORE_ID',
  'PRINTFUL_WEBHOOK_SECRET',
  'PRINTFUL_WEBHOOK_PUBLIC_KEY',
];

function databaseCa() {
  const inline = String(process.env.DATABASE_CA_CERT || '').trim();
  if (inline) return inline.replace(/\\n/g, '\n');
  const certPath = String(process.env.DATABASE_CA_CERT_PATH || '').trim();
  if (!certPath) throw new Error('DATABASE_CA_CERT oder DATABASE_CA_CERT_PATH fehlt.');
  return fs.readFileSync(certPath, 'utf8').trim();
}

function runtimeSecrets() {
  const missing = REQUIRED.filter((name) => !String(process.env[name] || '').trim());
  if (missing.length) throw new Error(`Fehlende Fly-Laufzeitwerte: ${missing.join(', ')}`);

  const databaseUrl = parseDatabaseUrl(process.env.DATABASE_URL);
  if (databaseUrl.username !== 'wolkenworte_app') {
    throw new Error('DATABASE_URL muss die eingeschränkte wolkenworte_app-Rolle verwenden.');
  }
  if (process.env.STRIPE_TEST_SECRET_KEY && !process.env.STRIPE_TEST_SECRET_KEY.startsWith('sk_test_')) {
    throw new Error('Die Hosted-Testumgebung akzeptiert für STRIPE_TEST_SECRET_KEY nur einen sk_test_-Key.');
  }

  const values = Object.fromEntries(REQUIRED.map((name) => [name, process.env[name]]));
  values.DATABASE_CA_CERT = databaseCa();
  for (const name of OPTIONAL) {
    if (String(process.env[name] || '').trim()) values[name] = process.env[name];
  }
  return values;
}

function importSecrets(values) {
  return new Promise((resolve, reject) => {
    const child = spawn('flyctl', ['secrets', 'import', '--stage', '--app', APP], {
      cwd: path.join(__dirname, '..'),
      stdio: ['pipe', 'inherit', 'inherit'],
    });
    child.once('error', reject);
    child.once('exit', (code, signal) => {
      if (code === 0) resolve();
      else reject(new Error(`flyctl secrets import failed (${signal || code}).`));
    });
    const payload = Object.entries(values)
      .map(([name, value]) => `${name}=${String(value).replace(/\r?\n/g, '\\n')}`)
      .join('\n');
    child.stdin.end(`${payload}\n`);
  });
}

async function main() {
  const secrets = runtimeSecrets();
  if (Object.hasOwn(secrets, 'MIGRATION_DATABASE_URL')) {
    throw new Error('MIGRATION_DATABASE_URL darf niemals an Fly übertragen werden.');
  }
  await importSecrets(secrets);
  console.log(`[fly] ${Object.keys(secrets).length} Laufzeit-Secrets für ${APP} staged; kein Migration-Credential übertragen.`);
}

if (require.main === module) {
  main().catch((error) => {
    console.error('[fly] secret configuration failed:', error.message);
    process.exitCode = 1;
  });
}

module.exports = { databaseCa, importSecrets, main, runtimeSecrets };
