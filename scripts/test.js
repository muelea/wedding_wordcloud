'use strict';

const { spawn } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const { ensureEnvironment } = require('./check-environment');
const { startLocalPostgres, testEnvironment, validateTestDatabaseUrl } = require('../test/support/local-postgres');

async function main(args = process.argv.slice(2)) {
  let database;
  let child;
  const explicitUrl = process.env.TEST_DATABASE_URL?.trim();
  try {
    // Validate an explicit local URL before any installation or Docker action.
    if (explicitUrl) validateTestDatabaseUrl(explicitUrl);
    await ensureEnvironment('test', { offerInstall: true, dockerRequired: !explicitUrl });
    const url = explicitUrl ? validateTestDatabaseUrl(explicitUrl) :
      (database = await startLocalPostgres({ onSignal(signal) {
        if (!child?.pid) return;
        try {
          if (process.platform === 'win32') child.kill(signal);
          else process.kill(-child.pid, signal);
        } catch { /* the owned test process has already exited */ }
      } })).url;
    const files = args.length ? args : fs.readdirSync(path.join(__dirname, '../test'))
      .filter(name => name.endsWith('.test.js')).sort().map(name => `test/${name}`);
    console.log('[tests] Lokales Postgres bereit; Hosted-Zugangsdaten sind für den Testprozess entfernt.');
    child = spawn(process.execPath, ['--require', path.join(__dirname, '../test/support/test-environment.js'),
      '--test', '--test-concurrency=4', ...files], {
      cwd: path.join(__dirname, '..'), stdio: 'inherit', detached: process.platform !== 'win32',
      env: testEnvironment(process.env, url),
    });
    process.exitCode = await new Promise((resolve, reject) => {
      child.once('error', reject);
      child.once('exit', (code, signal) => resolve(signal ? 1 : code ?? 1));
    });
  } finally {
    if (database) await database.close();
  }
}

if (require.main === module) main().catch(error => { console.error(error.message); process.exitCode = 1; });
module.exports = { main };
