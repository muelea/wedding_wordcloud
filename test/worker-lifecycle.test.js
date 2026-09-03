'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const db = require('../src/db');

function deferred() {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
}

for (const kind of ['fulfillment', 'email']) {
  test(`${kind} keeps one active job and waits for it during shutdown`, async (t) => {
    const modulePath = kind === 'fulfillment' ? '../src/fulfillment' : '../src/emailDelivery';
    delete require.cache[require.resolve(modulePath)];
    const worker = require(modulePath);
    const entered = deferred();
    const release = deferred();
    const work = [];
    let claims = 0;
    const claim = async () => {
      claims += 1;
      return { id: '1', order_id: '1', mode: 'test', status: 'paid_test' };
    };
    if (kind === 'fulfillment') {
      t.mock.method(db, 'claimFulfillmentOrder', claim);
      t.mock.method(db, 'getOrderItems', async () => {
        entered.resolve();
        await release.promise;
        return [];
      });
      t.mock.method(db, 'failFulfillment', async () => ({ fulfillment_status: 'failed' }));
      t.mock.method(db, 'getOrderById', async () => ({ id: '2' }));
    } else {
      t.mock.method(db, 'claimEmailJob', claim);
      t.mock.method(db, 'getOrderById', async () => {
        entered.resolve();
        await release.promise;
        return { mode: 'test', status: 'paid_test' };
      });
      t.mock.method(db, 'getEmailJobById', async () => ({ id: '2' }));
      t.mock.method(db, 'completeMockEmail', async () => ({ status: 'delivered' }));
    }
    t.after(async () => {
      release.resolve();
      await Promise.allSettled(work);
      await worker.stop();
    });
    const processOne = kind === 'fulfillment' ? worker.processOrder : worker.processJob;
    work.push(processOne('1'));
    await entered.promise;
    await new Promise(setImmediate);
    work.push(processOne('2'));
    // A webhook and the periodic poll may both arrive while a job is waiting.
    await worker.drainDueJobs();
    assert.equal(claims, 1, 'a second caller must not claim another job');
    const timedOut = await worker.stop({ timeoutMs: 5 });
    assert.equal(timedOut.drained, false);
    assert.equal(timedOut[kind === 'fulfillment' ? 'activeOrders' : 'activeJobs'], 1);
    let stopped = false;
    const stopping = worker.stop({ timeoutMs: 1_000 }).then((result) => {
      stopped = true;
      return result;
    });
    await new Promise(setImmediate);
    assert.equal(stopped, false, 'shutdown must wait for the pending job');
    release.resolve();
    await Promise.all(work);
    assert.equal((await stopping).drained, true);
  });
}
