'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { Pool } = require('pg');

require('dotenv').config({ path: path.join(__dirname, '..', '.env') });
const { connectionOptions } = require('../src/dbConfig');

const MIGRATIONS_DIR = path.join(__dirname, '..', 'supabase', 'migrations');

function migrationFiles() {
  return fs.readdirSync(MIGRATIONS_DIR)
    .filter((name) => /^\d+_[a-z0-9_]+\.sql$/.test(name))
    .sort();
}

async function main() {
  const connectionString = process.env.MIGRATION_DATABASE_URL;
  if (!connectionString) throw new Error('MIGRATION_DATABASE_URL ist nicht gesetzt.');
  const pool = new Pool(connectionOptions(connectionString, {
    schema: 'public',
    applicationName: 'wolkenworte-migrations',
    requireDirect: false,
  }));
  const client = await pool.connect();
  try {
    await client.query('SELECT pg_advisory_lock($1)', ['817264091']);
    await client.query(`
      CREATE TABLE IF NOT EXISTS public.wolkenworte_migrations (
        version text primary key,
        checksum text not null,
        applied_at timestamptz not null default transaction_timestamp()
      )
    `);
    for (const filename of migrationFiles()) {
      const sql = fs.readFileSync(path.join(MIGRATIONS_DIR, filename), 'utf8');
      const checksum = crypto.createHash('sha256').update(sql).digest('hex');
      const existing = await client.query(
        'SELECT checksum FROM public.wolkenworte_migrations WHERE version = $1',
        [filename]
      );
      if (existing.rows[0]) {
        if (existing.rows[0].checksum !== checksum) {
          throw new Error(`Bereits angewendete Migration wurde verändert: ${filename}`);
        }
        continue;
      }
      await client.query('BEGIN');
      try {
        await client.query('SET LOCAL search_path TO public');
        await client.query(sql);
        await client.query(
          'INSERT INTO public.wolkenworte_migrations (version, checksum) VALUES ($1, $2)',
          [filename, checksum]
        );
        await client.query('COMMIT');
        console.log(`[migration] applied ${filename}`);
      } catch (error) {
        await client.query('ROLLBACK');
        throw error;
      }
    }
    console.log('[migration] database is current');
  } finally {
    try { await client.query('SELECT pg_advisory_unlock($1)', ['817264091']); } catch { /* ignore */ }
    client.release();
    await pool.end();
  }
}

if (require.main === module) {
  main().catch((error) => {
    console.error('[migration] failed:', error.message);
    process.exitCode = 1;
  });
}

module.exports = { main, migrationFiles };
