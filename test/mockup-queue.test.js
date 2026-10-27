'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const {harness}=require('./support/mockup-queue-harness');
const {LEASE_MS}=require('../src/mockupQueue');
const limited=(seconds=40)=>Object.assign(new Error('provider busy'),{providerStatus:429,retryAfter:seconds});

test('notebook previews select the requested camera style for each side, independent of response ordering',async()=>{
  const h=harness({productKey:'spiral-notebook-dotted'}),configuration=h.configuration();
  const job=await h.service.createForConfiguration(configuration,{customer:true});
  const image=(placement,style_id,view)=>({placement,style_id,
    mockup_url:`https://printful-upload.s3-accelerate.amazonaws.com/tmp/${view}.png`});
  h.pollReplies.push([{id:1,status:'completed',catalog_variant_mockups:[{
    catalog_variant_id:h.product.printful.variantId,mockups:[
      image('front',2,'wrong-back'),image('front',1,'front'),
      image('back',1,'wrong-front'),image('back',2,'back'),
    ],
  }]}]);
  await h.run(2);
  const result=await h.service.getJob(job.jobId,configuration);
  assert.equal(result.status,'completed');
  assert.deepEqual(result.items[0].mockups.map(value=>[value.surfaceKey,value.styleId]),[['front',1],['back',2]]);
  assert.deepEqual(result.items[0].mockups.map(value=>value.url.split('/').at(-1)),['front.png','back.png']);
  assert.equal(h.uploaded.length,2,'one prepared PNG per print side, irrespective of returned camera views');
  assert.ok(h.uploaded.every(value=>value.key.startsWith('prepared-prints/')));
});

test('one explicit command queues and deduplicates before any rendering or provider work',async()=>{
  const h=harness(),configuration=h.configuration();
  const [a,b]=await Promise.all([h.service.createForConfiguration(configuration),h.service.createForConfiguration(configuration)]);
  assert.equal(a.jobId,b.jobId);assert.equal(a.status,'queued');assert.equal(h.uploaded.length,0);
  await h.run(2);assert.equal((await h.service.getJob(a.jobId)).status,'completed');assert.equal(h.payloads.length,1);
  assert.deepEqual(h.removed,h.uploaded.map(item=>item.key));
  const repeated=await h.service.createForConfiguration(configuration);assert.equal(repeated.jobId,a.jobId);
});

test('quota rejection automatically waits and retries with no repeated user request',async()=>{
  const h=harness(),job=await h.service.createForConfiguration(h.configuration());h.createReplies.push(limited(40));
  await h.run();assert.equal((await h.service.getJob(job.jobId)).status,'retrying');assert.equal(h.payloads.length,1);
  h.advance(40000);await h.run();assert.equal(h.payloads.length,1);
  h.advance(251);await h.run(2);assert.equal(h.payloads.length,2);assert.equal((await h.service.getJob(job.jobId)).status,'completed');
});

test('2000px quota cost falls back to 1000px through the same creation budget',async()=>{
  const h=harness(),job=await h.service.createForConfiguration(h.configuration());
  h.createReplies.push(Object.assign(new Error('Request would exceed available attempts'),{providerStatus:429,rateLimitRemaining:2,retryAfter:1}));
  await h.run();h.advance(2000);await h.run();assert.equal(h.payloads.length,1);
  h.advance(30000);await h.run(2);
  assert.deepEqual(h.payloads.map(item=>item.mockup_width_px),[2000,1000]);
  const result=await h.service.getJob(job.jobId);assert.equal(result.status,'completed');assert.equal(result.resolutionFallback,true);
});

test('status throttling and network failures keep polling the accepted task without another submission',async()=>{
  const h=harness(),job=await h.service.createForConfiguration(h.configuration());await h.run();
  h.pollReplies.push(limited(20),new Error('network offline'));
  await h.run();h.advance(20251);await h.run();h.advance(5000);await h.run();
  assert.equal((await h.service.getJob(job.jobId)).status,'completed');assert.equal(h.payloads.length,1);
  assert.ok(h.reads.every(ids=>ids[0]===1));
});

test('accepted jobs resume from durable IDs after a service restart',async()=>{
  const h=harness(),configuration=h.configuration(),job=await h.service.createForConfiguration(configuration);await h.run();
  const restarted=h.restart();const same=await restarted.createForConfiguration(configuration);assert.equal(same.jobId,job.jobId);
  await restarted.runDue();assert.equal((await restarted.getJob(job.jobId)).status,'completed');assert.equal(h.payloads.length,1);
});

test('a longer status outage retains the accepted task until recovery or the overall deadline',async()=>{
  const h=harness(),job=await h.service.createForConfiguration(h.configuration());await h.run();
  for(let attempt=0;attempt<8;attempt++){
    h.pollReplies.push(new Error('status service offline'));h.advance(60251);await h.run();
    assert.equal((await h.service.getJob(job.jobId)).status,'pending');
  }
  h.advance(60251);await h.restart().runDue();
  assert.equal((await h.service.getJob(job.jobId)).status,'completed');assert.equal(h.payloads.length,1);

  const other=harness(),timed=await other.service.createForConfiguration(other.configuration());await other.run();
  other.pollReplies.push(limited(3500));await other.run();
  assert.equal((await other.service.getJob(timed.jobId)).nextAttemptAt,other.repository.jobs.get(timed.jobId).deadlineAt);
  other.advance(1800000);await other.run();
  assert.equal((await other.service.getJob(timed.jobId)).errorCode,'mockup_timeout');
  assert.equal(other.payloads.length,1);assert.equal(other.removed.length,0);
});

test('source preparation cannot submit new provider work after the overall deadline',async()=>{
  const h=harness(),job=await h.service.createForConfiguration(h.configuration());
  h.advance(1799500);
  h.settings.renderPng=async()=>{h.advance(1000);return Buffer.from('PNG');};
  // Reconstruct the worker with the deliberately slow renderer.
  await h.restart().runDue();
  assert.equal((await h.service.getJob(job.jobId)).errorCode,'mockup_timeout');
  assert.equal(h.payloads.length,0);assert.equal(h.removed.length,1);
});

test('a stale provider task gets one fresh attempt, then a clear final failure',async()=>{
  const h=harness(),job=await h.service.createForConfiguration(h.configuration());await h.run();
  h.pollReplies.push([{id:1,status:'pending'}]);h.advance(600001);await h.run();
  const waiting=await h.service.getJob(job.jobId);assert.equal(waiting.status,'retrying');assert.equal(waiting.errorCode,'mockup_stalled');
  h.advance(30501);await h.run();assert.equal(h.payloads.length,2);
  h.pollReplies.push([{id:2,status:'pending'}]);h.advance(600001);await h.run();
  const result=await h.service.getJob(job.jobId);assert.equal(result.status,'failed');assert.equal(result.errorCode,'mockup_stalled');
  assert.equal(h.payloads.length,2);assert.ok(!h.removed.includes(h.uploaded[0].key),'an abandoned accepted task retains its source until expiry');
  h.advance(3600000);await h.run();assert.ok(h.removed.includes(h.uploaded[0].key));
});

test('missing or unrelated task results cannot complete another design and recover after three reads',async()=>{
  const h=harness(),job=await h.service.createForConfiguration(h.configuration());await h.run();
  for(let i=0;i<3;i++){h.pollReplies.push([{id:999,status:'completed'}]);h.advance(4001);await h.run();}
  const result=await h.service.getJob(job.jobId);assert.equal(result.status,'retrying');assert.equal(result.mockups.length,0);
  h.advance(30501);await h.run(2);assert.equal((await h.service.getJob(job.jobId)).status,'completed');
});

test('creation ambiguity is recorded and replacement attempts remain bounded',async()=>{
  const h=harness(),job=await h.service.createForConfiguration(h.configuration());
  h.createReplies.push(new Error('response lost'),new Error('response lost'));
  await h.run();assert.equal((await h.service.getJob(job.jobId)).errorCode,'mockup_submission_unknown');
  assert.equal(h.removed.length,0);h.advance(30501);await h.run();
  assert.equal((await h.service.getJob(job.jobId)).status,'failed');assert.equal(h.payloads.length,2);
});

test('an ambiguous submission retains its sources even after earlier preparation failures',async()=>{
  const h=harness(),job=await h.service.createForConfiguration(h.configuration());
  h.repository.jobs.get(job.jobId).failures=5;h.createReplies.push(new Error('response lost'));
  await h.run();
  assert.equal((await h.service.getJob(job.jobId)).status,'retrying');
  assert.equal((await h.service.getJob(job.jobId)).errorCode,'mockup_submission_unknown');
  assert.equal(h.uploaded.length,1);assert.equal(h.removed.length,0);
});

test('crashing in the submission window does not dispatch immediately on restart',async()=>{
  const h=harness(),job=await h.service.createForConfiguration(h.configuration());
  const stored=h.repository.jobs.get(job.jobId);Object.assign(stored,{status:'submitting',attempt:1,submittedAt:h.now()});
  await h.restart().runDue();assert.equal(h.payloads.length,0);
  assert.equal((await h.service.getJob(job.jobId)).errorCode,'mockup_submission_unknown');
  h.advance(30501);await h.run(2);assert.equal(h.payloads.length,1);
});

test('daily quotas and invalid requests stop instead of retrying forever',async()=>{
  for(const failure of [Object.assign(new Error('Daily limit 20,000 files'),{providerStatus:429}),Object.assign(new Error('invalid placement'),{providerStatus:422})]){
    const h=harness(),job=await h.service.createForConfiguration(h.configuration());h.createReplies.push(failure);
    await h.run();const result=await h.service.getJob(job.jobId);assert.equal(result.status,'failed');
    assert.equal(result.errorCode,failure.providerStatus===429?'mockup_daily_limit':'mockup_provider_unavailable');
    h.advance(60000);await h.run();assert.equal(h.payloads.length,1);
  }
});

test('regeneration is idempotent per command and a new saved design gets its own job',async()=>{
  const h=harness(),configuration=h.configuration(),a=await h.service.createForConfiguration(configuration);await h.run(2);
  const requestId='r'.repeat(24),b=await h.service.createForConfiguration(configuration,{refresh:true,requestId});assert.notEqual(a.jobId,b.jobId);
  h.advance(30501);await h.run(2);
  const repeated=await h.service.createForConfiguration(configuration,{refresh:true,requestId});assert.equal(repeated.jobId,b.jobId);
  const changed=await h.service.createForConfiguration(h.configuration('Glück'));assert.notEqual(changed.jobId,b.jobId);
});

test('customers and operators share dispatch quota, but customer capabilities stay configuration-bound',async()=>{
  const h=harness(),configuration=h.configuration();await h.service.createForConfiguration(configuration);await h.run(2);
  const customer=await h.service.createForConfiguration(configuration,{customer:true});await h.run();assert.equal(h.payloads.length,1);
  h.advance(30501);await h.run(2);assert.equal(h.payloads[1].mockup_width_px,1000);
  await assert.rejects(h.service.getJob(customer.jobId,{...configuration,id:'another'}),e=>e.status===404);
  assert.equal((await h.service.getJob(customer.jobId,configuration)).status,'completed');
});

test('a joined refresh command cannot create another task when its application response is lost',async()=>{
  const h=harness(),configuration=h.configuration(),original=await h.service.createForConfiguration(configuration);
  const requestId='s'.repeat(24);
  const joined=await h.service.createForConfiguration(configuration,{refresh:true,requestId});
  assert.equal(joined.jobId,original.jobId);await h.run(2);
  const retried=await h.restart().createForConfiguration(configuration,{refresh:true,requestId});
  assert.equal(retried.jobId,original.jobId);assert.equal(retried.status,'completed');assert.equal(h.payloads.length,1);
});

test('a stale lease cannot commit or remove a newer worker’s source files',async()=>{
  const h=harness();let stolen=false;
  h.settings.storageClient.upload=async()=>{h.advance(LEASE_MS+1);stolen=true;};
  const job=await h.service.createForConfiguration(h.configuration());await h.run();
  assert.equal(stolen,true);assert.equal(h.payloads.length,0);assert.equal(h.removed.length,0);
  assert.equal((await h.service.getJob(job.jobId)).status,'preparing');
});

test('successful response quota headers defer other creations across the shared scheduler',async()=>{
  const h=harness();const original=h.settings.printfulClient.createMockupTasks;
  h.settings.printfulClient.createMockupTasks=async(payload,options)=>{
    const result=await original(payload);await options.onRateLimit({status:200,remaining:0,reset:120});return result;
  };
  await h.service.createForConfiguration(h.configuration());await h.run(2);
  const next=await h.service.createForConfiguration(h.configuration('Glück'));await h.run();
  assert.ok((await h.service.getJob(next.jobId)).retryAfter>=119);h.advance(60000);await h.run();assert.equal(h.payloads.length,1);
  h.advance(60001);await h.run();assert.equal(h.payloads.length,2);
});

test('failed cleanup stays journaled and retries after a restart without generating another task',async()=>{
  const h=harness();let unavailable=true;
  h.settings.storageClient.remove=async key=>{if(unavailable)throw new Error('Storage offline');h.removed.push(key);};
  const job=await h.service.createForConfiguration(h.configuration());await h.run(2);
  assert.equal((await h.service.getJob(job.jobId)).status,'completed');assert.equal(h.repository.jobs.get(job.jobId).sourceObjectKeys.length,1);
  unavailable=false;h.advance(60001);await h.restart().runDue();assert.equal(h.removed.length,1);assert.equal(h.payloads.length,1);
});

test('active queue admission is bounded before any source work',async()=>{
  const h=harness();
  for(let i=0;i<39;i++)await h.service.createForConfiguration(h.configuration());
  await assert.rejects(h.service.createForConfiguration(h.configuration()),error=>error.code==='mockup_queue_full'&&error.status===429);
  assert.equal(h.uploaded.length,0);assert.equal(h.payloads.length,0);
});

test('admission leaves a generation window and rejects work behind a long provider cooldown',async()=>{
  const h=harness();
  const first=await h.service.createForConfiguration(h.configuration());
  const job=h.repository.jobs.get(first.jobId);
  assert.ok(job.deadlineAt-job.latestStartAt>600000);
  h.repository.budgets.get(h.settings.scope).nextCreate=h.now()+1200000;
  await assert.rejects(h.service.createForConfiguration(h.configuration()),error=>error.code==='mockup_queue_full');
  assert.equal(h.uploaded.length,0);
});

test('a failed provider generation gets one bounded replacement before a terminal failure',async()=>{
  const h=harness(),job=await h.service.createForConfiguration(h.configuration());
  await h.run();h.pollReplies.push([{id:1,status:'failed',failure_reasons:[{detail:'temporary rendering failure'}]}]);
  await h.run();assert.equal((await h.service.getJob(job.jobId)).status,'retrying');
  h.advance(30501);await h.run();
  h.pollReplies.push([{id:2,status:'failed',failure_reasons:[{detail:'temporary rendering failure'}]}]);
  await h.run();assert.equal((await h.service.getJob(job.jobId)).status,'failed');
  assert.equal(h.payloads.length,2);
});

test('the background worker advances an explicitly queued job without status requests',async t=>{
  const h=harness({autoStart:true});t.after(()=>h.service.stop());
  let reached;const polled=new Promise(resolve=>{reached=resolve;});const original=h.settings.printfulClient.getMockupTasks;
  h.settings.printfulClient.getMockupTasks=async ids=>{const result=await original(ids);reached();return result;};
  const job=await h.service.createForConfiguration(h.configuration());
  let timeout;try{await Promise.race([polled,new Promise((resolve,reject)=>{timeout=setTimeout(()=>reject(new Error('worker did not resume')),5000);})]);}
  finally{clearTimeout(timeout);}
  await h.service.runDue();assert.equal((await h.service.getJob(job.jobId)).status,'completed');assert.equal(h.payloads.length,1);
});
