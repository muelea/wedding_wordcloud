'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const db = require('../src/db');
const fulfillment = require('../src/fulfillment');
const email = require('../src/emailDelivery');
const dailyRetention = require('../src/dailyRetention');
const mockups = require('../src/printfulMockups');
const storage = require('../src/privateStorage');
const maintenance = require('../src/maintenance');

function harness(t, elapsed) {
  let clock = 1_000_000;
  const order = [];
  t.mock.method(Date, 'now', () => clock);
  t.mock.method(db, 'startMaintenanceRun', async () => ({ id: 1 }));
  t.mock.method(db, 'cleanupAbandonedQuotes', async () => 0);
  t.mock.method(mockups, 'wake', () => { order.push('recover_mockups'); });
  t.mock.method(fulfillment, 'drainDueJobs', async () => { order.push('fulfillment'); return { claimed: 0, completed: 0 }; });
  t.mock.method(email, 'drainDueJobs', async () => { order.push('email'); return { claimed: 0, completed: 0 }; });
  t.mock.method(dailyRetention, 'run', async () => {
    order.push('retention'); clock += elapsed; return { status:'completed',counts:{} };
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
  assert.deepEqual(h.order, ['recover_mockups', 'retention', 'fulfillment', 'email', 'mockups', 'heartbeat']);
  assert.equal(h.cleanup.mock.callCount(), 1);
  assert.equal(h.finish.mock.callCount(), 1);
});

test('mockup cleanup waits for a later wake-up when the maintenance budget is mostly used', async t => {
  const h = harness(t, 8000);
  assert.equal((await maintenance.run()).status, 'ok');
  assert.equal(h.cleanup.mock.callCount(), 0);
  assert.deepEqual(h.order, ['recover_mockups', 'retention', 'fulfillment', 'email', 'heartbeat']);
});

test('daily scan failure is reported without blocking payment/email recovery',async t=>{
  const h=harness(t,0);
  t.mock.method(dailyRetention,'run',async()=>{throw Object.assign(new Error('query failed'),{code:'57014'});});
  const result=await maintenance.run();
  assert.equal(result.status,'ok');
  assert.equal(result.summary.dailyRetentionStatus,'failed');
  assert.equal(result.summary.dailyRetentionFailed,1);
  assert.ok(h.order.includes('fulfillment'));assert.ok(h.order.includes('email'));
  assert.equal(h.finish.mock.callCount(),1);
});
