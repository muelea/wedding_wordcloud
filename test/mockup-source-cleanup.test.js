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

test('expired customer sources are removed in one bounded prefix-specific batch after restart', async t => {
  const removed = [];
  storage.setAdapterForTests({
    async listPage(prefix, options) {
      assert.equal(prefix, 'customer-mockup-sources');
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
  assert.equal(await storage.cleanupExpiredMockupSources(1_000_000), 1);
  assert.deepEqual(removed, [`customer-mockup-sources/900-${'a'.repeat(24)}.png`]);
});
