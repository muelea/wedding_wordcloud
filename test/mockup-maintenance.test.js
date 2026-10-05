'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const db = require('../src/db');
const fulfillment = require('../src/fulfillment');
const email = require('../src/emailDelivery');
const lifecycle = require('../src/lifecycle');
const storage = require('../src/privateStorage');
const maintenance = require('../src/maintenance');

function harness(t, elapsed) {
  let clock = 1_000_000;
  const order = [];
  t.mock.method(Date, 'now', () => clock);
  t.mock.method(db, 'startMaintenanceRun', async () => ({ id: 1 }));
  t.mock.method(db, 'cleanupAbandonedQuotes', async () => 0);
  t.mock.method(db, 'cleanupCommerceRecords', async () => ({ checked: 0, unpaid: 0, technical: 0, operational: 0, emails: 0, orders: 0 }));
  t.mock.method(db, 'cleanupRetentionMetadata', async () => 0);
  t.mock.method(fulfillment, 'drainDueJobs', async () => { order.push('fulfillment'); return { claimed: 0, completed: 0 }; });
  t.mock.method(email, 'drainDueJobs', async () => { order.push('email'); return { claimed: 0, completed: 0 }; });
  t.mock.method(lifecycle, 'runRetentionBatch', async () => {
    order.push('retention'); clock += elapsed; return { events: 0, artifacts: 0 };
  });
  const finish = t.mock.method(db, 'finishMaintenanceRun', async () => { order.push('heartbeat'); });
  const cleanup = t.mock.method(storage, 'cleanupExpiredMockupSources', async () => {
    order.push('mockups'); throw Object.assign(new Error('temporary Storage failure'), { code: 'storage_unavailable' });
  });
  return { order, finish, cleanup };
}

test('mockup cleanup failure preserves paid work priority and the successful maintenance heartbeat', async t => {
  const h = harness(t, 1000);
  assert.equal((await maintenance.run()).status, 'ok');
  assert.deepEqual(h.order, ['fulfillment', 'email', 'retention', 'mockups', 'heartbeat']);
  assert.equal(h.cleanup.mock.callCount(), 1);
  assert.equal(h.finish.mock.callCount(), 1);
});

test('mockup cleanup waits for a later wake-up when the maintenance budget is mostly used', async t => {
  const h = harness(t, 8000);
  assert.equal((await maintenance.run()).status, 'ok');
  assert.equal(h.cleanup.mock.callCount(), 0);
  assert.deepEqual(h.order, ['fulfillment', 'email', 'retention', 'heartbeat']);
});
