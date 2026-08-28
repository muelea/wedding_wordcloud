'use strict';

const path = require('path');
const { Pool } = require('pg');

require('dotenv').config({ path: path.join(__dirname, '..', '.env') });
const { connectionOptions } = require('../src/dbConfig');

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function main() {
  if (!process.argv.includes('--confirm-maintenance-run')) {
    throw new Error('Explizite Freigabe fehlt: --confirm-maintenance-run');
  }
  const databaseUrl = String(process.env.MIGRATION_DATABASE_URL || '');
  if (!databaseUrl) throw new Error('MIGRATION_DATABASE_URL ist nicht gesetzt.');
  const pool = new Pool(connectionOptions(databaseUrl, {
    schema: 'public',
    applicationName: 'wolkenworte-maintenance-cron-verify',
    requireDirect: false,
  }));
  try {
    const definition = await pool.query(`
      SELECT schedule, command FROM cron.job WHERE jobname = 'wolkenworte-maintenance'
    `);
    const job = definition.rows[0];
    if (!job || job.schedule !== '*/5 * * * *' ||
        !job.command.includes('timeout_milliseconds := 30000') ||
        !job.command.includes('vault.decrypted_secrets')) {
      throw new Error('Die installierte Cron-Definition entspricht nicht der geprüften Wartungskonfiguration.');
    }
    const before = await pool.query('SELECT coalesce(max(id), 0)::bigint AS id FROM maintenance_runs');
    const request = await pool.query(`
      SELECT net.http_post(
        url := (
          SELECT decrypted_secret FROM vault.decrypted_secrets
          WHERE name = 'wolkenworte_maintenance_url'
        ),
        headers := jsonb_build_object(
          'Content-Type', 'application/json',
          'Authorization', 'Bearer ' || (
            SELECT decrypted_secret FROM vault.decrypted_secrets
            WHERE name = 'wolkenworte_maintenance_secret'
          )
        ),
        body := '{}'::jsonb,
        timeout_milliseconds := 30000
      ) AS request_id
    `);
    const requestId = request.rows[0]?.request_id;
    if (!requestId) throw new Error('pg_net hat keine Request-ID geliefert.');

    const deadline = Date.now() + 35_000;
    while (Date.now() < deadline) {
      const heartbeat = await pool.query(`
        SELECT id, status, completed_at
        FROM maintenance_runs
        WHERE id > $1 AND status IN ('succeeded', 'failed')
        ORDER BY id DESC LIMIT 1
      `, [before.rows[0].id]);
      if (heartbeat.rows[0]) {
        if (heartbeat.rows[0].status !== 'succeeded' || !heartbeat.rows[0].completed_at) {
          throw new Error('Fly hat den Wartungslauf als fehlgeschlagen gespeichert.');
        }
        const response = await pool.query(`
          SELECT status_code, timed_out, error_msg
          FROM net._http_response WHERE id = $1
        `, [requestId]);
        if (response.rows[0] &&
            (Number(response.rows[0].status_code) !== 200 || response.rows[0].timed_out || response.rows[0].error_msg)) {
          throw new Error('pg_net hat keinen erfolgreichen HTTP-Abschluss gespeichert.');
        }
        console.log('[maintenance-cron] pg_net-Aufruf und neuer Fly-Abschluss-Heartbeat erfolgreich verifiziert.');
        return;
      }
      await delay(1_000);
    }
    throw new Error('Kein abgeschlossener Wartungs-Heartbeat innerhalb von 35 Sekunden.');
  } finally {
    await pool.end();
  }
}

if (require.main === module) {
  main().catch((error) => {
    console.error('[maintenance-cron] Verifikation fehlgeschlagen:', error.message);
    process.exitCode = 1;
  });
}

module.exports = { main };
