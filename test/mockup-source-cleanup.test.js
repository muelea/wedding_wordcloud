'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const storage = require('../src/privateStorage');

test('automated maintenance never uses real Storage credentials without a test adapter', async t => {
  const previous = { url: process.env.SUPABASE_URL, secret: process.env.SUPABASE_SECRET_KEY };
  process.env.SUPABASE_URL = 'https://storage.example.test';
  process.env.SUPABASE_SECRET_KEY = 'test-placeholder';
  t.after(() => {
    for (const [key, value] of [['SUPABASE_URL', previous.url], ['SUPABASE_SECRET_KEY', previous.secret]]) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });
  const network = t.mock.method(globalThis, 'fetch', async () => { throw new Error('real Storage must not be called'); });
  assert.equal(await storage.cleanupExpiredMockupSources(), 0);
  assert.equal(network.mock.callCount(), 0);
});

test('expired operator and customer sources are removed in one bounded batch after restart', async t => {
  const removed = [];
  storage.setAdapterForTests({
    async listPage(prefix, options) {
      assert.ok(['customer-mockup-sources','operator-mockup-sources'].includes(prefix));
      assert.deepEqual(options, { limit: 100, offset: 0 });
      return [
        { name: `900-${'a'.repeat(24)}.png` },
        { name: `1100-${'b'.repeat(24)}.png` },
        { name: 'paid-print-artifact.png' },
        { name: '900-invalid-id.png' },
      ];
    },
    async removeMany(keys) { removed.push(...keys); },
  });
  t.after(() => storage.resetAdapterForTests());
  assert.equal(await storage.cleanupExpiredMockupSources(1_000_000), 2);
  assert.deepEqual(removed, ['customer','operator'].map(mode => `${mode}-mockup-sources/900-${'a'.repeat(24)}.png`));
});

test('one unavailable source prefix does not prevent cleanup of the other prefix', async t => {
  const removed = [];
  storage.setAdapterForTests({
    async listPage(prefix) {
      if (prefix === 'customer-mockup-sources') throw new Error('customer listing unavailable');
      return [{ name: `900-${'a'.repeat(24)}.png` }];
    },
    async removeMany(keys) { removed.push(...keys); },
  });
  t.after(() => storage.resetAdapterForTests());
  await assert.rejects(storage.cleanupExpiredMockupSources(1_000_000), /customer listing unavailable/);
  assert.deepEqual(removed, [`operator-mockup-sources/900-${'a'.repeat(24)}.png`]);
});

test('a cleanup pass remains bounded even with a backlog in both prefixes', async t => {
  const batches = [];
  storage.setAdapterForTests({
    async listPage() {
      return Array.from({ length: 100 }, (_, index) => ({
        name: `900-${String(index).padStart(24, '0')}.png`,
      }));
    },
    async removeMany(keys) { batches.push(keys); },
  });
  t.after(() => storage.resetAdapterForTests());
  assert.equal(await storage.cleanupExpiredMockupSources(1_000_000), 100);
  assert.equal(batches.length, 1);
  assert.equal(batches[0].filter(key => key.startsWith('operator-')).length, 50);
  assert.equal(batches[0].filter(key => key.startsWith('customer-')).length, 50);
});
