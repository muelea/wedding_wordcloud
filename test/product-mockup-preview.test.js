'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const {JSDOM}=require('jsdom');
const Mockups=require('../public/js/product-mockup-preview');
const endpoint=`/api/events/${'e'.repeat(22)}/configurations/${'c'.repeat(16)}/mockups`;
const operator=`/api/operator/printful-mockups/events/${'e'.repeat(22)}/configurations/${'c'.repeat(16)}`;
const imageUrl='https://printful-upload.s3-accelerate.amazonaws.com/tmp/preview.png';
const jobId='j'.repeat(24);
function harness(t){
  const dom=new JSDOM('',{url:'https://example.test'});t.after(()=>dom.window.close());
  let time=1_000_000;const requests=[],replies=[],progress=[];
  const options={window:dom.window,now:()=>time,wait:async ms=>{time+=ms;},fetchImpl:async(url,init)=>{
    requests.push({url,...init});const next=replies.shift();if(next instanceof Error)throw next;
    assert.ok(next,`unexpected request ${url}`);return{ok:!next.error,status:next.error?(next.httpStatus||429):200,
      headers:{get:()=>next.retryAfter||null},json:async()=>next};
  }};
  const client=Mockups.create(options);client.subscribe((url,state)=>progress.push({...state,url}));
  return{window:dom.window,client,options,requests,replies,progress,advance:ms=>{time+=ms;},
    completed:()=>({status:'completed',expiresAt:time+Mockups.CACHE_MS,mockups:[{url:imageUrl}],mockupWidthPx:1000})};
}

test('explicit requests deduplicate, report progress and cache links without image bytes',async t=>{
  const h=harness(t);assert.equal(h.requests.length,0);
  h.replies.push({jobId},{status:'pending'},h.completed());const first=h.client.load(endpoint);
  assert.equal(h.client.load(endpoint),first);assert.equal(h.client.get(endpoint).status,'loading');
  assert.deepEqual((await first).urls,[imageUrl]);assert.equal(h.requests.filter(r=>r.method==='POST').length,1);
  const cache=JSON.parse(h.window.localStorage.getItem(Mockups.STORAGE_KEY));
  assert.doesNotMatch(JSON.stringify(cache),/data:|base64|design_json/);assert.equal(cache[endpoint].jobId,jobId);
  await Mockups.create(h.options).load(endpoint);assert.equal(h.requests.length,3);
  assert.equal(Object.keys(JSON.parse(h.window.localStorage.getItem(Mockups.PENDING_KEY))).length,0);
});

test('a quota rejection resumes automatically after the cooldown using the same command ID',async t=>{
  const h=harness(t);h.replies.push({error:'mockup_rate_limited',retryAfter:40},{jobId},h.completed());
  await h.client.load(endpoint);
  const posts=h.requests.filter(r=>r.method==='POST');assert.equal(posts.length,2);
  assert.equal(JSON.parse(posts[0].body).requestId,JSON.parse(posts[1].body).requestId);
  assert.ok(h.progress.some(state=>state.phase==='retrying'&&state.retryAfter===40));
  assert.equal(h.client.get(endpoint).status,'completed');
});

test('polling throttling and lost connections never submit the accepted job again',async t=>{
  const h=harness(t);h.replies.push({jobId},{error:'mockup_rate_limited',retryAfter:10},new Error('offline'),h.completed());
  await h.client.load(endpoint);assert.equal(h.requests.filter(r=>r.method==='POST').length,1);
  assert.ok(h.requests.slice(1).every(r=>r.url===`${endpoint}/${jobId}`));
});

test('after a longer outage a fresh page resumes the stored job ID',async t=>{
  const h=harness(t);h.replies.push({jobId},...Array.from({length:8},()=>new Error('offline')));
  await assert.rejects(h.client.load(endpoint));
  const saved=JSON.parse(h.window.localStorage.getItem(Mockups.PENDING_KEY))[endpoint];assert.equal(saved.jobId,jobId);
  const before=h.requests.length;h.replies.push(h.completed());const next=Mockups.create(h.options);
  assert.equal(next.get(endpoint).status,'loading');await next.load(endpoint);
  assert.equal(h.requests.length,before+1);assert.equal(h.requests.at(-1).method,undefined);
});

test('an interrupted application POST retries idempotently even before a job ID was received',async t=>{
  const h=harness(t);h.replies.push(new Error('response lost'),{jobId},h.completed());
  await h.client.load(endpoint);const posts=h.requests.filter(r=>r.method==='POST');
  assert.equal(posts.length,2);assert.deepEqual(JSON.parse(posts[0].body),JSON.parse(posts[1].body));
});

test('operator regeneration sends refresh with a new command, and uses the guarded status URL',async t=>{
  const h=harness(t);h.replies.push({jobId},h.completed());await h.client.load(operator);
  assert.equal(h.requests[0].headers['X-Wolkenworte-Operator'],'printful-mockup');
  assert.equal(h.requests[1].url,`/api/operator/printful-mockups/${jobId}`);
  h.replies.push({jobId:'k'.repeat(24)},h.completed());await h.client.load(operator,{refresh:true});
  assert.equal(JSON.parse(h.requests[2].body).refresh,true);
  assert.notEqual(JSON.parse(h.requests[2].body).requestId,JSON.parse(h.requests[0].body).requestId);
});

test('terminal failures clear the pending command and leave a new explicit attempt available',async t=>{
  const h=harness(t);h.replies.push({jobId},{status:'failed',errorCode:'mockup_daily_limit'});
  await assert.rejects(h.client.load(endpoint),error=>error.errorCode==='mockup_daily_limit');
  assert.equal(h.client.get(endpoint).status,'error');assert.equal(Object.keys(JSON.parse(h.window.localStorage.getItem(Mockups.PENDING_KEY))).length,0);
  h.replies.push({jobId},h.completed());await h.client.load(endpoint);
  assert.notEqual(JSON.parse(h.requests[0].body).requestId,JSON.parse(h.requests[2].body).requestId);
});

test('expiry and broken cached images require a deliberate refresh; unsafe URLs are ignored',async t=>{
  const h=harness(t);h.replies.push({jobId},h.completed());await h.client.load(endpoint);
  h.client.invalidate(endpoint);assert.equal(h.client.get(endpoint).status,'idle');assert.equal(h.requests.length,2);
  h.replies.push({jobId},h.completed());await h.client.load(endpoint);assert.equal(JSON.parse(h.requests[2].body).refresh,true);
  h.advance(Mockups.CACHE_MS+1);assert.equal(h.client.get(endpoint).status,'idle');
  await assert.rejects(h.client.load('https://attacker.test/mockups'));
  const another=endpoint.replace('c'.repeat(16),'d'.repeat(16));assert.equal(h.client.get(another).status,'idle');
});

test('blocked browser storage still retains an accepted job in memory for retry',async t=>{
  const h=harness(t);Object.defineProperty(h.window,'localStorage',{get(){throw new Error('blocked');}});
  h.replies.push({jobId},...Array.from({length:8},()=>new Error('offline')));await assert.rejects(h.client.load(endpoint));
  h.replies.push(h.completed());await h.client.load(endpoint);assert.equal(h.requests.filter(r=>r.method==='POST').length,1);
});
