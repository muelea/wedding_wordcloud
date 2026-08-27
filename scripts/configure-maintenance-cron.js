'use strict';

const path = require('path');
const { Pool } = require('pg');

require('dotenv').config({ path: path.join(__dirname, '..', '.env') });
const { connectionOptions } = require('../src/dbConfig');

async function upsertVaultSecret(client, name, secret, description) {
  const existing = await client.query('SELECT id FROM vault.secrets WHERE name = $1', [name]);
  if (existing.rows[0]) {
    await client.query('SELECT vault.update_secret($1, $2, $3, $4)', [
      existing.rows[0].id, secret, name, description,
    ]);
  } else {
    await client.query('SELECT vault.create_secret($1, $2, $3)', [secret, name, description]);
  }
}

async function main() {
  const databaseUrl = String(process.env.MIGRATION_DATABASE_URL || '');
  const urlIndex = process.argv.indexOf('--url');
  const explicitUrl = urlIndex >= 0 ? process.argv[urlIndex + 1] : '';
  const publicUrl = String(explicitUrl || process.env.PUBLIC_URL || '').replace(/\/$/, '');
  const maintenanceSecret = String(process.env.MAINTENANCE_SECRET || '');
  if (!databaseUrl) throw new Error('MIGRATION_DATABASE_URL ist nicht gesetzt.');
  if (!/^https:\/\//.test(publicUrl)) throw new Error('PUBLIC_URL muss eine öffentliche HTTPS-URL sein.');
  if (maintenanceSecret.length < 32) throw new Error('MAINTENANCE_SECRET muss mindestens 32 Zeichen lang sein.');

  const pool = new Pool(connectionOptions(databaseUrl, {
    schema: 'public',
    applicationName: 'wolkenworte-maintenance-cron-setup',
    requireDirect: false,
  }));
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await upsertVaultSecret(
      client,
      'wolkenworte_maintenance_url',
      `${publicUrl}/internal/maintenance/run`,
      'Wolkenworte Fly maintenance endpoint'
    );
    await upsertVaultSecret(
      client,
      'wolkenworte_maintenance_secret',
      maintenanceSecret,
      'Bearer secret shared with the Wolkenworte Fly application'
    );
    const scheduled = await client.query('SELECT public.configure_wolkenworte_maintenance_cron() AS job_id');
    const definition = await client.query(`
      SELECT schedule, command FROM cron.job WHERE jobname = 'wolkenworte-maintenance'
    `);
    const job = definition.rows[0];
    if (!scheduled.rows[0]?.job_id || job?.schedule !== '*/5 * * * *' ||
        !job.command.includes('timeout_milliseconds := 30000') ||
        job.command.includes(maintenanceSecret)) {
      throw new Error('Die installierte Wartungs-Cron-Definition ist ungültig.');
    }
    await client.query('COMMIT');
    console.log('[maintenance-cron] Vault-Konfiguration aktualisiert; 5-Minuten-Cron mit 30-Sekunden-Timeout aktiv.');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
    await pool.end();
  }
}

if (require.main === module) {
  main().catch((error) => {
    console.error('[maintenance-cron] Einrichtung fehlgeschlagen:', error.message);
    process.exitCode = 1;
  });
}

module.exports = { main };
