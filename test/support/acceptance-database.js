'use strict';

// Runs only in a disposable Docker database pod. Never loads
// .env or accepts a hosted database. Setup credentials never reach the web app.
const fs = require('node:fs');
const path = require('node:path');
const { Client } = require('pg');

async function main() {
  const connection = new URL(process.env.ACCEPTANCE_DATABASE_URL || '');
  if (process.env.WW_BROWSER_ACCEPTANCE !== '1' || connection.hostname !== '127.0.0.1' ||
      connection.pathname !== '/ww_acceptance' || !process.env.ACCEPTANCE_APP_PASSWORD) {
    throw new Error('Acceptance setup requires its disposable loopback database.');
  }
  const client = new Client({ connectionString: connection.href });
  await client.connect();
  try {
    await client.query('CREATE SCHEMA acceptance');
    await client.query('SET search_path TO acceptance, public');
    const migrations = fs.readdirSync('/acceptance-migrations').filter(name => name.endsWith('.sql')).sort();
    for (const migration of migrations) {
      await client.query(fs.readFileSync(path.join('/acceptance-migrations', migration), 'utf8'));
    }
    const password = process.env.ACCEPTANCE_APP_PASSWORD;
    if (!/^[a-f0-9]{48}$/.test(password)) throw new Error('Invalid generated acceptance credential.');
    await client.query(`CREATE ROLE wolkenworte_app LOGIN PASSWORD '${password}' NOSUPERUSER NOCREATEDB NOCREATEROLE`);
    await client.query('GRANT USAGE ON SCHEMA acceptance TO wolkenworte_app');
    await client.query('GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA acceptance TO wolkenworte_app');
    await client.query('GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA acceptance TO wolkenworte_app');
    await client.query('GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA acceptance TO wolkenworte_app');
    console.log('Isolated migrations and restricted runtime role ready.');
  } finally { await client.end(); }
}
main().catch(error => { console.error(error.message); process.exitCode = 1; });
