'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const {create}=require('../src/workerPoller');
const flush=()=>new Promise(setImmediate);

test('safety polling backs off when idle, speeds up for work and stops cleanly',async t=>{
  t.mock.timers.enable({apis:['setTimeout']});
  let calls=0;
  const poller=create({run:async()=>++calls===1?1:0,onError:error=>{throw error;}});
  assert.equal(poller.start(),true);assert.equal(poller.start(),false);
  t.mock.timers.tick(59_999);await flush();assert.equal(calls,0);
  t.mock.timers.tick(1);await flush();assert.equal(calls,1);
  t.mock.timers.tick(5_000);await flush();assert.equal(calls,2);
  t.mock.timers.tick(59_999);await flush();assert.equal(calls,2);
  t.mock.timers.tick(1);await flush();assert.equal(calls,3);
  poller.active();t.mock.timers.tick(5_000);await flush();assert.equal(calls,4);
  poller.stop();t.mock.timers.tick(120_000);await flush();assert.equal(calls,4);
});

test('mockup worker has no recurring timer after an empty startup or completed work',async t=>{
  const {harness}=require('./support/mockup-queue-harness');
  t.mock.timers.enable({apis:['setTimeout']});
  const h=harness({autoStart:true});t.after(()=>h.service.stop());
  let claims=0;const original=h.repository.claimMockupJob;
  h.repository.claimMockupJob=async options=>{claims++;return original(options);};
  h.service.start();t.mock.timers.tick(0);await flush();await flush();
  assert.equal(claims,1);t.mock.timers.tick(60_000);await flush();assert.equal(claims,1);
  await h.service.createForConfiguration(h.configuration());t.mock.timers.tick(0);await flush();await flush();
  h.advance(5000);t.mock.timers.tick(5000);await flush();await flush();
  assert.equal(h.payloads.length,1);
  const completedClaims=claims;
  t.mock.timers.tick(60_000);await flush();assert.equal(claims,completedClaims);
});

test('a scheduled retry is not delayed by the empty-queue backoff',async t=>{
  t.mock.timers.enable({apis:['setTimeout','Date']});
  let calls=0;
  const poller=create({run:async()=>{calls++;return {nextAt:Date.now()+25_000};},onError:error=>{throw error;}});
  t.after(()=>poller.stop());
  poller.start();poller.active();
  t.mock.timers.tick(5_000);await flush();assert.equal(calls,1);
  t.mock.timers.tick(24_999);await flush();assert.equal(calls,1);
  t.mock.timers.tick(1);await flush();assert.equal(calls,2);
});

test('reading a later queued mockup cannot postpone an earlier pending mockup wake-up',async t=>{
  const {harness}=require('./support/mockup-queue-harness');
  const {createService}=require('../src/printfulMockups');
  const h=harness();
  const a=await h.service.createForConfiguration(h.configuration('A'));
  const b=await h.service.createForConfiguration(h.configuration('B'));
  Object.assign(h.repository.jobs.get(a.jobId),{status:'pending',nextAt:h.now()+4_000});
  Object.assign(h.repository.jobs.get(b.jobId),{status:'queued',nextAt:h.now()+30_000});
  let claims=0;h.repository.claimMockupJob=async()=>{claims++;return null;};
  const service=createService({...h.settings,autoStart:true});t.after(()=>service.stop());
  t.mock.timers.enable({apis:['setTimeout']});
  await service.getJob(a.jobId);await service.getJob(b.jobId);
  t.mock.timers.tick(3_999);await flush();assert.equal(claims,0);
  h.advance(4_000);t.mock.timers.tick(1);await flush();assert.equal(claims,1);
});

test('queue backpressure wakes older durable jobs after a scheduler outage',async t=>{
  const {harness}=require('./support/mockup-queue-harness');
  const {createService}=require('../src/printfulMockups');
  const h=harness();
  for(let index=0;index<39;index++)await h.service.createForConfiguration(h.configuration());
  const service=createService({...h.settings,autoStart:true});t.after(()=>service.stop());
  t.mock.timers.enable({apis:['setTimeout']});
  await assert.rejects(service.createForConfiguration(h.configuration()),error=>error.code==='mockup_queue_full');
  t.mock.timers.tick(0);await flush();await flush();
  assert.equal(h.payloads.length,1,'rejected new work must still wake the older admitted jobs');
});
