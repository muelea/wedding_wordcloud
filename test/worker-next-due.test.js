'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const {startTestServer}=require('./helpers');

test('durable worker wake-ups respect future retries, leases, terminal jobs and smoke exclusion',async t=>{
  const app=await startTestServer();t.after(app.close);
  const db=require('../src/db');
  assert.equal(await db.getNextWorkerJobAt('fulfillment'),null);
  assert.equal(await db.getNextWorkerJobAt('email'),null);
  const order=(await app.query(`INSERT INTO orders(event_slug_snapshot,event_title_snapshot,status,
    paid_at,fulfillment_status,fulfillment_attempts,fulfillment_next_attempt_at)
    VALUES('retry-clock','Zeitplan','paid',now(),'failed',1,now()+interval '30 seconds') RETURNING *`)).rows[0];
  assert.equal(await db.getNextWorkerJobAt('fulfillment'),+order.fulfillment_next_attempt_at);
  const leased=(await app.query(`UPDATE orders SET fulfillment_status='processing',fulfillment_locked_by='current-owner',
    fulfillment_locked_until=now()+interval '90 seconds' WHERE id=$1 RETURNING *`,[order.id])).rows[0];
  assert.equal(await db.getNextWorkerJobAt('fulfillment'),+leased.fulfillment_locked_until);
  await app.query('UPDATE orders SET fulfillment_attempts=3 WHERE id=$1',[order.id]);
  assert.equal(await db.getNextWorkerJobAt('fulfillment'),null);
  await app.query(`INSERT INTO orders(event_slug_snapshot,event_title_snapshot,status,paid_at,provider_smoke)
    VALUES('smoke-clock','Operator','paid',now(),true)`);
  assert.equal(await db.getNextWorkerJobAt('fulfillment'),null);
  const job=(await app.query(`INSERT INTO email_jobs(order_id,kind,dedupe_key,recipient_email,locale,template_version,
    subject,html_body,text_body,status,next_attempt_at)
    VALUES($1,'order_confirmation','retry-clock','local@example.test','de','v1','Test','Test','Test','failed',now()+interval '25 seconds') RETURNING *`,[order.id])).rows[0];
  assert.equal(await db.getNextWorkerJobAt('email'),+job.next_attempt_at);
  await app.query('UPDATE email_jobs SET provider_terminal=true WHERE id=$1',[job.id]);
  assert.equal(await db.getNextWorkerJobAt('email'),null);
  await app.query('UPDATE email_jobs SET provider_terminal=false,attempt_count=4 WHERE id=$1',[job.id]);
  assert.equal(await db.getNextWorkerJobAt('email'),null);
  await app.query('UPDATE email_jobs SET attempt_count=0,provider_smoke=true WHERE id=$1',[job.id]);
  assert.equal(await db.getNextWorkerJobAt('email'),null);
});
