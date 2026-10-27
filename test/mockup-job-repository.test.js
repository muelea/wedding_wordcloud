'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const crypto=require('node:crypto');
const {startTestServer,createEvent,productDesignPayload}=require('./helpers');
const {harness}=require('./support/mockup-queue-harness');

test('Postgres mockup jobs preserve commands, quota and lease ownership across service instances',async t=>{
  const app=await startTestServer();t.after(app.close);
  const db=require('../src/db');
  const event=await createEvent(app.baseUrl);
  const response=await fetch(`${app.baseUrl}/api/events/${event.slug}/configurations`,{
    method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({productKey:'cork-back-coaster',theme:'pastel',words:[['liebe',1]],...productDesignPayload('cork-back-coaster')}),
  });
  assert.equal(response.status,201);const saved=await response.json();
  const configuration=await db.getEventConfiguration(event.slug,saved.id);
  function setup(){return harness({repository:db,time:Date.now(),scope:crypto.randomBytes(32).toString('hex')});}

  await t.test('concurrent requests and idempotent refreshes have one durable identity',async()=>{
    const h=setup(),other=h.restart();
    const [a,b]=await Promise.all([h.service.createForConfiguration(configuration),other.createForConfiguration(configuration)]);
    assert.equal(a.jobId,b.jobId);
    assert.equal((await app.query('SELECT count(*)::int AS n FROM mockup_jobs WHERE scope=$1',[h.settings.scope])).rows[0].n,1);
    await h.run(2);
    const requestId='r'.repeat(24),regenerated=await h.service.createForConfiguration(configuration,{refresh:true,requestId});
    assert.notEqual(regenerated.jobId,a.jobId);h.advance(30501);await h.run(2);
    const repeated=await other.createForConfiguration(configuration,{refresh:true,requestId});
    assert.equal(repeated.jobId,regenerated.jobId);assert.equal(h.payloads.length,2);
  });

  await t.test('an expired lease fences old commits and another process can resume',async()=>{
    const h=setup(),job=await h.service.createForConfiguration(configuration);
    const first=crypto.randomUUID(),second=crypto.randomUUID();
    const claim={scope:h.settings.scope,lease:first,now:h.now(),leaseMs:1000,operator:true};
    const row=await db.claimMockupJob(claim);assert.equal(row.id,job.jobId);
    assert.equal(await db.claimMockupJob({...claim,lease:second}),null);
    h.advance(1001);
    const newer=await db.claimMockupJob({...claim,lease:second,now:h.now()});assert.equal(newer.id,job.jobId);
    assert.equal(await db.saveMockupJob({...row,status:'failed'},first,h.now()),false);
    assert.equal(await db.saveMockupJob(newer,second,h.now()),true);
    await db.releaseMockupLease(h.settings.scope,job.jobId,first);
    assert.equal(await db.reserveMockupRequest(h.settings.scope,second,h.now(),'create'),h.now());
    await db.releaseMockupLease(h.settings.scope,job.jobId,second);
  });

  await t.test('a second tab joining an active job remains idempotent after completion and worker checkpoints',async()=>{
    const h=setup(),original=await h.service.createForConfiguration(configuration);
    const lease=crypto.randomUUID();
    const claimed=await db.claimMockupJob({scope:h.settings.scope,lease,now:h.now(),leaseMs:180000,operator:true});
    const requestId='s'.repeat(24);
    const joined=await h.restart().createForConfiguration(configuration,{refresh:true,requestId});
    assert.equal(joined.jobId,original.jobId);
    // This checkpoint uses a snapshot captured before the other tab joined.
    assert.equal(await db.saveMockupJob(claimed,lease,h.now()),true);
    await db.releaseMockupLease(h.settings.scope,original.jobId,lease);
    await h.run(2);
    const retried=await h.restart().createForConfiguration(configuration,{refresh:true,requestId});
    assert.equal(retried.jobId,original.jobId);assert.equal(retried.status,'completed');
    assert.equal(h.payloads.length,1);
  });

  await t.test('accepted task IDs survive a service restart without storing signed URLs or artwork',async()=>{
    const h=setup(),job=await h.service.createForConfiguration(configuration);await h.run();
    const data=(await app.query('SELECT data FROM mockup_jobs WHERE id=$1',[job.jobId])).rows[0].data;
    assert.deepEqual(data.taskIds,[1]);assert.doesNotMatch(JSON.stringify(data),/https:\/\/|design_json|data:image/);
    const other=h.restart();await other.runDue();assert.equal((await other.getJob(job.jobId)).status,'completed');assert.equal(h.payloads.length,1);
  });

  await t.test('operator and customer jobs share the persisted dispatch allowance',async()=>{
    const h=setup();await h.service.createForConfiguration(configuration);await h.run(2);
    const job=await h.service.createForConfiguration(configuration,{customer:true});
    await h.restart().runDue();assert.equal(h.payloads.length,1);
    assert.equal((await h.service.getJob(job.jobId,configuration)).status,'queued');
    h.advance(30501);await h.restart().runDue({maxJobs:2});
    assert.equal(h.payloads.length,2);assert.equal(h.payloads[1].mockup_width_px,1000);
  });

  await t.test('Postgres admission reserves time for generation before accepting more work',async()=>{
    const h=setup(),first=await h.service.createForConfiguration(configuration);
    const original=await db.getMockupJob(first.jobId);
    const candidate=()=>{
      const id=crypto.randomBytes(18).toString('base64url');
      return {...original,id,requestId:id,cacheKey:crypto.createHash('sha256').update(id).digest('hex')};
    };
    for(let index=1;index<39;index++)assert.ok(await db.enqueueMockupJob(candidate()));
    assert.equal(await db.enqueueMockupJob(candidate()),null);
    assert.equal(h.payloads.length,0);
    // Rejoining existing work still succeeds when admission is saturated.
    assert.equal((await h.restart().createForConfiguration(configuration)).jobId,first.jobId);
  });

  await t.test('a long persisted provider cooldown prevents doomed new admissions',async()=>{
    const h=setup(),first=await h.service.createForConfiguration(configuration);
    await app.query('UPDATE mockup_provider_budgets SET next_create_at=$2 WHERE scope=$1',[h.settings.scope,new Date(h.now()+1200000)]);
    const original=await db.getMockupJob(first.jobId),id=crypto.randomBytes(18).toString('base64url');
    assert.equal(await db.enqueueMockupJob({...original,id,requestId:id,cacheKey:crypto.createHash('sha256').update(id).digest('hex')}),null);
  });
});
