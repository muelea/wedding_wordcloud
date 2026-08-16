'use strict';

const path = require('path');
const fs = require('fs');
const crypto = require('crypto');

/**
 * Boots a fresh server instance backed by its own scratch SQLite file, on an
 * ephemeral port. Each test FILE gets its own process under `node --test`
 * (that's the test runner's default isolation model), so setting
 * process.env.DB_PATH before requiring server.js/db.js here is safe — no
 * cross-file DB collisions, and every call to startTestServer() within the
 * same file still shares one process-wide `node:sqlite` connection (module
 * caching), which is fine since each test creates its own uniquely-slugged
 * events rather than relying on a clean table.
 */
function startTestServer() {
  const dbPath = path.join(__dirname, `.tmp-${crypto.randomBytes(6).toString('hex')}.sqlite`);
  process.env.DB_PATH = dbPath;
  process.env.ADMIN_TOKEN_SECRET = 'test-secret';
  delete require.cache[require.resolve('../src/db')];
  delete require.cache[require.resolve('../server')];

  const { server, io } = require('../server');

  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      resolve({
        port,
        baseUrl: `http://127.0.0.1:${port}`,
        server,
        io,
        dbPath,
        async close() {
          await new Promise((res) => io.close(() => res()));
          await new Promise((res) => server.close(() => res()));
          for (const suffix of ['', '-journal', '-wal', '-shm']) {
            try { fs.unlinkSync(dbPath + suffix); } catch { /* ignore */ }
          }
        },
      });
    });
  });
}

let counter = 0;
function uniqueCoupleName() {
  counter += 1;
  return `Test Couple ${Date.now()}-${counter}`;
}

async function createEvent(baseUrl, overrides = {}) {
  const coupleName = overrides.coupleName || uniqueCoupleName();
  const res = await fetch(`${baseUrl}/api/events`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      coupleName,
      eventTitle: overrides.eventTitle || 'Hochzeit',
      weddingDate: overrides.weddingDate || null,
      slug: overrides.slug,
      pin: overrides.pin || '1234',
    }),
  });
  const body = await res.json();
  if (!res.ok) throw new Error(`createEvent failed: ${res.status} ${JSON.stringify(body)}`);
  return { ...body, coupleName, pin: overrides.pin || '1234' };
}

module.exports = { startTestServer, createEvent, uniqueCoupleName };
