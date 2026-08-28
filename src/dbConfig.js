'use strict';

const fs = require('fs');

const LOCAL_DATABASE_HOSTS = new Set(['localhost', '127.0.0.1', '::1']);
const SCHEMA_RE = /^[a-z_][a-z0-9_]{0,62}$/;

function parseDatabaseUrl(connectionString, label = 'DATABASE_URL') {
  if (!connectionString) throw new Error(`${label} ist nicht gesetzt.`);
  try {
    return new URL(connectionString);
  } catch {
    throw new Error(`${label} ist keine gültige Postgres-Verbindungs-URL.`);
  }
}

function isLocalDatabaseUrl(connectionString) {
  return LOCAL_DATABASE_HOSTS.has(parseDatabaseUrl(connectionString).hostname);
}

function readDatabaseCa() {
  const certPath = String(process.env.DATABASE_CA_CERT_PATH || '').trim();
  if (!certPath) return null;
  try {
    return fs.readFileSync(certPath, 'utf8');
  } catch (error) {
    throw new Error(`Postgres-CA-Zertifikat konnte nicht gelesen werden: ${error.message}`);
  }
}

function connectionOptions(connectionString, {
  schema = process.env.DATABASE_SCHEMA || 'public',
  applicationName = process.env.DATABASE_APPLICATION_NAME || 'wolkenworte-web',
  requireDirect = process.env.NODE_ENV === 'production',
} = {}) {
  if (!SCHEMA_RE.test(schema)) throw new Error('DATABASE_SCHEMA ist ungültig.');
  const parsed = parseDatabaseUrl(connectionString);
  if (!['postgres:', 'postgresql:'].includes(parsed.protocol)) {
    throw new Error('DATABASE_URL muss das Postgres-Protokoll verwenden.');
  }
  if (requireDirect && parsed.hostname.includes('pooler.supabase.com')) {
    throw new Error('DATABASE_URL muss für den Fly-Webprozess die direkte Supabase-Verbindung verwenden.');
  }

  const local = LOCAL_DATABASE_HOSTS.has(parsed.hostname);
  const requestedSslMode = parsed.searchParams.get('sslmode');
  for (const key of ['sslmode', 'sslrootcert', 'sslcert', 'sslkey']) {
    parsed.searchParams.delete(key);
  }

  let ssl = false;
  if (!local) {
    if (requestedSslMode && requestedSslMode !== 'verify-full') {
      throw new Error('Hosted Postgres-Verbindungen müssen sslmode=verify-full verwenden.');
    }
    const ca = readDatabaseCa();
    if (!ca) {
      throw new Error(
        'Für Hosted Postgres fehlt DATABASE_CA_CERT_PATH.'
      );
    }
    ssl = { ca, rejectUnauthorized: true };
  }

  return {
    connectionString: parsed.toString(),
    ssl,
    // One hosted Machine is intentionally bounded to 20 direct connections.
    // This leaves ample Supabase headroom while allowing a reconnect storm to
    // hydrate per-browser contribution ownership without a long five-lane queue.
    max: process.env.NODE_ENV === 'test' ? 10 : 20,
    connectionTimeoutMillis: process.env.NODE_ENV === 'test' ? 30_000 : 5_000,
    idleTimeoutMillis: 10_000,
    query_timeout: 10_000,
    statement_timeout: 10_000,
    lock_timeout: 5_000,
    application_name: applicationName,
    options: `-c search_path=${schema},public`,
  };
}

module.exports = {
  SCHEMA_RE,
  connectionOptions,
  isLocalDatabaseUrl,
  parseDatabaseUrl,
};
