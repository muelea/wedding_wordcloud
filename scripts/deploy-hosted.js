'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const ROOT = path.join(__dirname, '..');
const APP_NAME = 'wolkenworte';
const PUBLIC_URL = 'https://wolkenworte.io';
const MAINTENANCE_URL = 'https://wolkenworte.fly.dev';
const EXPECTED_ENV = Object.freeze({
  NODE_ENV: 'production',
  APP_ENVIRONMENT: 'hosted-test',
  PUBLIC_URL,
  EMAIL_DELIVERY_MODE: 'mock',
  MAINTENANCE_MODE: 'false',
  ALLOW_TEST_DATA_RESET: 'false',
  STRIPE_PAYMENT_MODE: 'test',
  STRIPE_LIVE_PAYMENTS_ENABLED: 'false',
  PRINTFUL_FULFILLMENT_MODE: 'mock',
  PRINTFUL_ALLOW_ORDER_WRITES: 'false',
  PRINTFUL_CONFIRM_LIVE_ORDERS: 'false',
});
const REQUIRED_FLY_SECRETS = Object.freeze([
  'DATABASE_URL',
  'SUPABASE_URL',
  'SUPABASE_SECRET_KEY',
  'RATE_LIMIT_HMAC_SECRET',
  'MAINTENANCE_SECRET',
]);
const FORBIDDEN_FLY_SECRETS = new Set([
  ...Object.keys(EXPECTED_ENV),
  'DATABASE_CA_CERT_PATH',
  'MIGRATION_DATABASE_URL',
  'TEST_DATABASE_URL',
]);

function fail(message) {
  throw new Error(message);
}

function runCapture(command, args) {
  const result = spawnSync(command, args, {
    cwd: ROOT,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    env: process.env,
  });
  if (result.error) fail(`${command} konnte nicht gestartet werden: ${result.error.message}`);
  if (result.status !== 0) {
    fail(`${command} ist fehlgeschlagen (Exit ${result.status}).`);
  }
  return String(result.stdout || '').trim();
}

function runStep({ label, command, args }) {
  console.log(`\n[deploy:hosted] ${label}`);
  const result = spawnSync(command, args, {
    cwd: ROOT,
    stdio: 'inherit',
    env: process.env,
  });
  if (result.error) fail(`${label} konnte nicht gestartet werden: ${result.error.message}`);
  if (result.status !== 0) fail(`${label} ist fehlgeschlagen (Exit ${result.status}).`);
}

function parseQuotedAssignments(text, sectionName = null) {
  const values = {};
  let activeSection = null;
  for (const line of String(text).split(/\r?\n/)) {
    const section = line.match(/^\s*\[([^\]]+)\]\s*$/);
    if (section) {
      activeSection = section[1];
      continue;
    }
    if (activeSection !== sectionName) continue;
    const assignment = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*"([^"]*)"\s*$/);
    if (assignment) {
      if (Object.hasOwn(values, assignment[1])) {
        fail(`fly.toml enthält ${assignment[1]} mehrfach.`);
      }
      values[assignment[1]] = assignment[2];
    }
  }
  return values;
}

function validateHostedConfig(text) {
  const root = parseQuotedAssignments(text);
  const hosted = parseQuotedAssignments(text, 'env');
  if (root.app !== APP_NAME) fail(`fly.toml muss fest auf die Fly-App ${APP_NAME} zeigen.`);
  if (root.primary_region !== 'fra') fail('fly.toml muss die Hosted-Test-App in der Region fra halten.');
  for (const [name, expected] of Object.entries(EXPECTED_ENV)) {
    if (hosted[name] !== expected) {
      fail(`fly.toml muss ${name}="${expected}" setzen.`);
    }
  }
  if (/^\s*(?:MIGRATION_DATABASE_URL|MAINTENANCE_SECRET)\s*=/m.test(text)) {
    fail('Privilegierte Operator-Secrets dürfen nicht in fly.toml stehen.');
  }
  if (/^\s*release_command\s*=/m.test(text)) {
    fail('Datenbankmigrationen dürfen nicht als Fly release_command laufen.');
  }
}

function validateOperatorEnvironment(env = process.env, nodeVersion = process.versions.node) {
  if (Number.parseInt(nodeVersion, 10) < 22) fail('Der lokale Deployment-Befehl benötigt Node 22 oder neuer.');
  if (/^(?:1|true)$/i.test(String(env.CI || ''))) {
    fail('Dieser Deployment-Befehl ist ausschließlich für eine freigegebene lokale Operator-Workstation bestimmt.');
  }
  if (env.FLY_APP_NAME && env.FLY_APP_NAME !== APP_NAME) {
    fail(`FLY_APP_NAME darf für diesen Befehl nur ${APP_NAME} sein.`);
  }
  if (!String(env.MIGRATION_DATABASE_URL || '').trim()) {
    fail('MIGRATION_DATABASE_URL fehlt in der lokalen .env.');
  }
  if (String(env.MAINTENANCE_SECRET || '').length < 32) {
    fail('MAINTENANCE_SECRET fehlt in der lokalen .env oder ist kürzer als 32 Zeichen.');
  }
}

function validateFlySecretBoundary(json) {
  let records;
  try {
    const parsed = JSON.parse(json);
    records = Array.isArray(parsed) ? parsed : parsed.secrets;
  } catch {
    fail('Die Fly-Secretliste konnte nicht sicher ausgewertet werden.');
  }
  if (!Array.isArray(records)) fail('Die Fly-Secretliste hat ein unerwartetes Format.');

  const names = records.map((record) => record?.Name || record?.name || record?.NAME);
  if (names.some((name) => typeof name !== 'string' || !name)) {
    fail('Die Fly-Secretliste enthält einen Eintrag ohne auswertbaren Namen.');
  }
  const configured = new Set(names);
  const missing = REQUIRED_FLY_SECRETS.filter((name) => !configured.has(name));
  if (missing.length) fail(`Erforderliche Fly-Laufzeit-Secrets fehlen: ${missing.join(', ')}.`);
  const forbidden = names.filter((name) => FORBIDDEN_FLY_SECRETS.has(name));
  if (forbidden.length) {
    fail(`Fly Secrets dürfen Sicherheitskonfiguration oder Operator-Zugänge nicht überschreiben: ${forbidden.join(', ')}.`);
  }
}

function assertGitReleaseCandidate(run = runCapture) {
  const branch = run('git', ['branch', '--show-current']);
  if (branch !== 'main') fail('Deployments sind ausschließlich vom Branch main erlaubt.');

  const changes = run('git', ['status', '--porcelain', '--untracked-files=all']);
  if (changes) fail('Das Arbeitsverzeichnis ist nicht sauber. Änderungen zuerst committen oder entfernen.');

  const head = run('git', ['rev-parse', 'HEAD']);
  const remoteLine = run('git', ['ls-remote', '--exit-code', 'origin', 'refs/heads/main']);
  const remoteHead = remoteLine.split(/\s+/)[0];
  if (!/^[a-f0-9]{40}$/.test(remoteHead) || remoteHead !== head) {
    fail('Der lokale main-Commit entspricht nicht exakt origin/main. Den freigegebenen Commit zuerst pushen bzw. aktualisieren.');
  }
  return head;
}

function releaseSteps(shortSha) {
  return [
    { label: 'Abhängigkeiten reproduzierbar installieren', command: 'npm', args: ['ci'] },
    { label: 'Vollständige Tests', command: 'npm', args: ['test'] },
    {
      label: 'Produktionsimage lokal bauen',
      command: 'docker',
      args: ['build', '--platform', 'linux/amd64', '--tag', `${APP_NAME}:${shortSha}`, '.'],
    },
    {
      label: 'Fly-Konfiguration streng validieren',
      command: 'flyctl',
      args: ['config', 'validate', '--strict', '--config', 'fly.toml', '--app', APP_NAME],
    },
    {
      label: 'Datenbankmigrationen anwenden',
      command: 'npm',
      args: ['run', 'db:migrate'],
      releaseBoundary: true,
    },
    {
      label: 'Freigegebenes Image zu Fly deployen',
      command: 'flyctl',
      args: ['deploy', '--remote-only', '--ha=false', '--config', 'fly.toml', '--app', APP_NAME, '--yes'],
    },
    {
      label: 'Wartungs-Cron aktualisieren',
      command: 'npm',
      args: ['run', 'maintenance:configure-cron', '--', '--url', MAINTENANCE_URL],
    },
    {
      label: 'Hosted-Smoke-Test ausführen',
      command: 'npm',
      args: ['run', 'smoke:hosted', '--', PUBLIC_URL],
    },
    { label: 'Finalen Fly-Status prüfen', command: 'flyctl', args: ['status', '--app', APP_NAME] },
  ];
}

function loadLocalEnvironment() {
  const envPath = path.join(ROOT, '.env');
  if (!fs.existsSync(envPath)) fail('Die lokale, gitignorierte .env fehlt.');
  const loaded = require('dotenv').config({ path: envPath, override: true });
  if (loaded.error) fail(`Die lokale .env konnte nicht geladen werden: ${loaded.error.message}`);
}

function main() {
  if (process.argv.length > 2) fail('Dieser Befehl akzeptiert keine Argumente; Ziel und Sicherheitsmodus sind fest vorgegeben.');

  console.log(`[deploy:hosted] Prüfe den lokalen Release-Kandidaten für ${APP_NAME}.`);
  loadLocalEnvironment();
  validateOperatorEnvironment();
  validateHostedConfig(fs.readFileSync(path.join(ROOT, 'fly.toml'), 'utf8'));
  const commit = assertGitReleaseCandidate();

  runCapture('flyctl', ['auth', 'whoami']);
  validateFlySecretBoundary(runCapture('flyctl', ['secrets', 'list', '--app', APP_NAME, '--json']));
  runCapture('docker', ['info', '--format', '{{.ServerVersion}}']);
  console.log(`[deploy:hosted] Vorprüfung erfolgreich; Release-Commit ${commit.slice(0, 12)}.`);

  for (const step of releaseSteps(commit.slice(0, 12))) {
    if (step.releaseBoundary) {
      const recheckedCommit = assertGitReleaseCandidate();
      if (recheckedCommit !== commit) fail('Der Release-Commit hat sich während der Verifikation verändert.');
      console.log('[deploy:hosted] Release-Commit direkt vor Migration und Deployment erneut bestätigt.');
    }
    runStep(step);
  }

  console.log(`\n[deploy:hosted] Erfolgreich: ${APP_NAME} @ ${commit}`);
  console.log(`[deploy:hosted] ${PUBLIC_URL}`);
}

if (require.main === module) {
  try {
    main();
  } catch (error) {
    console.error(`\n[deploy:hosted] Abbruch: ${error.message}`);
    process.exitCode = 1;
  }
}

module.exports = {
  APP_NAME,
  EXPECTED_ENV,
  MAINTENANCE_URL,
  PUBLIC_URL,
  assertGitReleaseCandidate,
  main,
  releaseSteps,
  validateHostedConfig,
  validateFlySecretBoundary,
  validateOperatorEnvironment,
};
