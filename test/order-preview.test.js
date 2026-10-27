'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { JSDOM } = require('jsdom');
const Preview = require('../public/js/order-preview');
const tick = () => new Promise(resolve => setImmediate(resolve));
async function settle() { for (let count = 0; count < 12; count++) await tick(); }

function harness(t, { throttle = false, partial = false, empty = false, retryAfter = 3 } = {}) {
  const dom = new JSDOM(`<section><p data-order-preview-progress></p><div data-order-previews></div>
    <input type="checkbox" data-order-preview-consent disabled>
    <dialog data-order-preview-large><button data-order-preview-close>Close</button><img></dialog></section>`, { url: 'https://example.test' });
  t.after(() => dom.window.close());
  const browser = dom.window, root = browser.document.querySelector('section');
  browser.WolkenworteProductMockups = require('../public/js/product-mockup-preview');
  const i18n = { setText(node, text, params = {}) { node.textContent = text.replace(/\{\{(\w+)\}\}/g, (_, key) => params[key]); },
    setAttribute(node, name, value) { node.setAttribute(name, value); } };
  const configurations = ['a','b'].map((id,index) => ({ id: id.repeat(16), product: {
    displayName: `Produkt ${id}`, variantLabel: 'Weiße Variante',
    printSurfaces: index ? [{key:'front',label:'Vorderseite'},{key:'back',label:'Rückseite'}] : [{key:'default',label:'Druckseite'}],
  } }));
  const requests = [], jobs = new Map();
  let jobNumber = 0;
  const timers = new Map();
  let time = Date.now(), timerId = 0;
  browser.setTimeout = (action,delay) => {
    timers.set(++timerId, {action,at:time+delay}); return timerId;
  };
  browser.clearTimeout = id => timers.delete(id);
  async function advance(ms) {
    const target = time + ms;
    for (let count = 0; count < 10000; count++) {
      const next = [...timers].filter(([,timer])=>timer.at<=target).sort((a,b)=>a[1].at-b[1].at)[0];
      if (!next) break;
      time=next[1].at; timers.delete(next[0]); next[1].action(); await settle();
    }
    time=target; await settle();
  }
  browser.fetch = async (url, options = {}) => {
    requests.push({ url, ...options });
    if (throttle) { throttle = false; return { ok: false, status: 429, json: async () => ({retryAfter}) }; }
    if (options.method === 'POST') {
      const body = JSON.parse(options.body);
      const jobId = String(++jobNumber).padStart(24,'j');
      jobs.set(jobId, { jobId, expiresAt:time+12*3600000, configurationIds: body.configurationIds, status: partial ? 'failed' : 'completed', items: body.configurationIds.map(id => ({
        configurationId: id, mockups: empty || (partial && id === configurations[1].id) ? [] :
          configurations.find(value => value.id === id).product.printSurfaces.map(surface => ({surfaceKey:surface.key,url:`https://printful.com/${id}-${surface.key}.png`})),
      })) });
      return {ok:true,json:async()=>({jobs:[{jobId,configurationIds:body.configurationIds}]})};
    }
    return {ok:true,json:async()=>({jobs:[...new URL(url,'https://example.test').searchParams.get('jobs').split(',')].map(id=>jobs.get(id))})};
  };
  const client = Preview.create(root, {window:browser,endpoint:'/api/events/event/cart/mockups',guestId:'a'.repeat(32),i18n,now:()=>time});
  const consent = root.querySelector('input');
  const load = () => root.querySelectorAll('.order-preview-images img').forEach(image => image.dispatchEvent(new browser.Event('load')));
  const approve = () => { consent.checked = true; consent.dispatchEvent(new browser.Event('change')); };
  return {client,root,browser,requests,configurations,consent,load,approve,advance,timers,jobs,now:()=>time,
    elapse(ms) { time+=ms; },
    retryWorks() { partial = false; } };
}

test('all positive items start together; confirmation waits for actual loading of every printed side', async t => {
  const h = harness(t);
  h.client.sync(h.configurations); await settle();
  assert.equal(h.requests.filter(request => request.method === 'POST').length, 1);
  assert.equal(h.requests[0].headers['X-Wolkenworte-Guest-Id'],'a'.repeat(32),'customers sharing one network keep independent guest limits');
  assert.equal(h.root.querySelectorAll('.order-preview-images img').length, 3);
  assert.equal(h.consent.disabled, true, 'server completion alone cannot enable approval');
  h.approve(); assert.equal(h.client.value(), null);
  h.load(); assert.equal(h.consent.disabled, false);
  assert.equal(h.client.value(), null, 'loading never preselects consent');
  h.approve(); assert.equal(h.client.value().accepted, true);
  h.client.sync(h.configurations); assert.ok(h.client.value(), 'address and positive quantity changes reuse the same design approval');
  h.client.sync([h.configurations[0]]); assert.equal(h.client.value(), null, 'a changed basket requires deliberate confirmation');
  assert.equal(h.requests.filter(request => request.method === 'POST').length, 1, 'excluding an item does not regenerate anything');
});

test('a completed response without every product image ends in a retryable error', async t => {
  const h = harness(t, {empty:true});
  h.client.sync(h.configurations); await settle();
  assert.equal(h.consent.disabled,true);
  assert.equal(h.requests.length,2,'an invalid terminal response cannot leave an idle loading loop');
  for (const article of h.root.querySelectorAll('article')) {
    assert.equal(article.querySelector('button:not(.order-preview-image)').hidden,false);
    assert.match(article.textContent,/konnte nicht erstellt/);
  }
});

test('a stalled image times out; retry ignores late load events from the previous image', async t => {
  const h = harness(t);
  h.client.sync([h.configurations[0]]); await settle();
  const previous = h.root.querySelector('article img');
  await h.advance(Preview.IMAGE_TIMEOUT_MS+1000);
  const retry = h.root.querySelector('article button:not(.order-preview-image)');
  assert.equal(retry.hidden,true,'the image retries automatically first');
  assert.equal(h.consent.disabled,true);
  previous.dispatchEvent(new h.browser.Event('error'));
  previous.dispatchEvent(new h.browser.Event('load'));
  assert.equal(h.consent.disabled,true,'a late image cannot approve its replacement');
  h.load(); h.approve(); assert.ok(h.client.value());
  assert.equal(h.requests.filter(request=>request.method==='POST').length,1,'a slow image never consumes a generation slot');
});

test('leaving the page fences unfinished images and a restored page requires a fresh review', async t => {
  const h = harness(t);
  h.client.sync([h.configurations[0]]); await settle();
  const previous = h.root.querySelector('article img');
  h.browser.dispatchEvent(new h.browser.Event('pagehide'));
  previous.dispatchEvent(new h.browser.Event('load'));
  assert.equal(h.consent.disabled,true);
  h.browser.dispatchEvent(new h.browser.PageTransitionEvent('pageshow',{persisted:true}));
  await settle();
  previous.dispatchEvent(new h.browser.Event('load'));
  assert.equal(h.consent.disabled,true);
  h.load(); h.approve(); assert.ok(h.client.value());
});

test('broken images retry automatically before an explicit item regeneration', async t => {
  const h = harness(t); h.client.sync(h.configurations); await settle();
  const images = [...h.root.querySelectorAll('.order-preview-images img')];
  images[0].dispatchEvent(new h.browser.Event('load'));
  images[1].dispatchEvent(new h.browser.Event('error'));
  assert.equal(h.consent.disabled, true);
  const retry = h.root.querySelectorAll('article')[1].querySelector('button:not(.order-preview-image)');
  assert.equal(retry.hidden,true);
  await h.advance(1000);
  h.root.querySelectorAll('article')[1].querySelector('img').dispatchEvent(new h.browser.Event('error'));
  await h.advance(2000);
  h.root.querySelectorAll('article')[1].querySelector('img').dispatchEvent(new h.browser.Event('error'));
  assert.equal(retry.hidden,false,'image retries are bounded');
  retry.click(); await settle();
  const body = JSON.parse(h.requests.filter(request => request.method === 'POST').at(-1).body);
  assert.deepEqual(body.configurationIds, [h.configurations[1].id]); assert.equal(body.refresh, true);
  h.root.querySelectorAll('article')[1].querySelectorAll('img').forEach(image => image.dispatchEvent(new h.browser.Event('load')));
  assert.equal(h.consent.disabled, false);
});

test('partial failure keeps successful previews and later retries preserve their images', async t => {
  const h = harness(t, {partial:true}); h.client.sync(h.configurations); await settle();
  h.load(); assert.equal(h.consent.disabled,true);
  const firstImage = h.root.querySelector('img');
  assert.equal(h.root.querySelectorAll('article')[0].querySelector('button:not(.order-preview-image)').hidden,true);
  h.retryWorks(); h.root.querySelectorAll('article')[1].querySelector('button:not(.order-preview-image)').click(); await settle();
  h.root.querySelectorAll('article')[1].querySelectorAll('img').forEach(image=>image.dispatchEvent(new h.browser.Event('load')));
  assert.equal(h.root.querySelector('img'),firstImage); assert.equal(h.consent.disabled,false);
});

test('throttling retries automatically with the same command and provider-neutral progress', async t => {
  const h = harness(t, {throttle:true}); h.client.sync(h.configurations); await settle();
  assert.match(h.root.textContent,/3 Sekunden/); assert.doesNotMatch(h.root.textContent,/Printful/);
  await h.advance(3000);
  const posts = h.requests.filter(request=>request.method==='POST');
  assert.equal(posts.length,2); assert.equal(JSON.parse(posts[0].body).requestId,JSON.parse(posts[1].body).requestId);
  h.load(); h.approve(); assert.ok(h.client.value());
});

test('an application rate limit without a cooldown waits a full minute before retrying', async t => {
  const h = harness(t, {throttle:true,retryAfter:0}); h.client.sync(h.configurations); await settle();
  await h.advance(59000);
  assert.equal(h.requests.length,1,'the minute-long application window must clear before another request');
  await h.advance(1000);
  assert.equal(h.requests.filter(request=>request.method==='POST').length,2);
  h.load(); h.approve(); assert.ok(h.client.value());
});

test('more than eight status failures recover on reconnection using the accepted job', async t => {
  const h=harness(t), original=h.browser.fetch;
  let offline=true, reads=0;
  h.browser.fetch=(url,options)=>{
    if(options?.method!=='POST'&&offline){reads++;return Promise.reject(new Error('offline'));}
    return original(url,options);
  };
  h.client.sync(h.configurations);await settle();
  await h.advance(10*60000);
  assert.ok(reads>8);
  assert.equal(h.root.querySelector('article button').hidden,true);
  offline=false;h.browser.dispatchEvent(new h.browser.Event('online'));await settle();
  h.load();h.approve();assert.ok(h.client.value());
  assert.equal(h.requests.filter(request=>request.method==='POST').length,1);
});

test('focus and online events cannot bypass an explicit provider cooldown', async t => {
  const h=harness(t,{throttle:true,retryAfter:90});h.client.sync(h.configurations);await settle();
  await h.advance(60000);
  h.browser.dispatchEvent(new h.browser.Event('online'));h.browser.dispatchEvent(new h.browser.Event('focus'));await settle();
  assert.equal(h.requests.length,1);
  await h.advance(30000);assert.equal(h.requests.filter(request=>request.method==='POST').length,2);
  h.load();h.approve();assert.ok(h.client.value());
});

test('stalled requests and JSON bodies time out without AbortSignal.timeout', async t => {
  for(const stalledBody of [false,true]){
    const h=harness(t), original=h.browser.fetch;
    h.browser.AbortSignal.timeout=undefined;
    let first=true, signal;
    h.browser.fetch=(url,options)=>{
      if(first){first=false;signal=options.signal;return stalledBody?Promise.resolve({ok:true,json:()=>new Promise(()=>{})}):new Promise(()=>{});}
      return original(url,options);
    };
    h.client.sync(h.configurations);await settle();
    await h.advance(Preview.REQUEST_TIMEOUT_MS);assert.equal(signal.aborted,true);
    await h.advance(5000);h.load();h.approve();assert.ok(h.client.value());
  }
});

test('expiry renews previews and requires a new deliberate approval', async t => {
  const h=harness(t);h.client.sync(h.configurations);await settle();h.load();h.approve();
  const previous=h.client.value().jobIds[0];
  await h.advance(12*3600000+1);
  assert.equal(h.client.value(),null);assert.equal(h.consent.checked,false);assert.equal(h.consent.disabled,true);
  const post=JSON.parse(h.requests.filter(request=>request.method==='POST').at(-1).body);
  assert.equal(post.refresh,false);
  h.load();assert.equal(h.client.value(),null);h.approve();assert.notEqual(h.client.value().jobIds[0],previous);
});

test('returning after suspended timers renews expired previews before payment can be enabled', async t => {
  const h=harness(t);h.client.sync(h.configurations);await settle();h.load();h.approve();
  h.elapse(12*3600000+1);assert.equal(h.client.value(),null);
  h.browser.dispatchEvent(new h.browser.Event('focus'));await settle();
  assert.equal(h.consent.disabled,true);assert.equal(h.consent.checked,false);
  assert.equal(h.requests.filter(request=>request.method==='POST').length,2);
  h.load();h.approve();assert.ok(h.client.value());
});

test('unavailable browser randomness produces an actionable error instead of an unhandled loading state', async t => {
  const h=harness(t);h.browser.crypto.getRandomValues=()=>{throw new Error('unsupported');};
  h.client.sync(h.configurations);await settle();
  assert.equal(h.root.querySelector('article button').hidden,false);
  assert.equal(h.root.querySelector('.order-preview-spinner').hidden,true);
  assert.equal(h.requests.length,0);
});

test('a rejected server approval renews the selected previews instead of recycling the old jobs', async t => {
  const h=harness(t);h.client.sync(h.configurations);await settle();h.load();h.approve();
  const previous=h.client.value().jobIds[0];h.client.reset();await settle();
  assert.equal(h.client.value(),null);assert.equal(h.consent.disabled,true);
  const post=JSON.parse(h.requests.filter(request=>request.method==='POST').at(-1).body);
  assert.equal(post.refresh,true);h.load();h.approve();assert.notEqual(h.client.value().jobIds[0],previous);
});

test('an expired job during polling is reconciled with a new command without forced regeneration', async t => {
  const h=harness(t), original=h.browser.fetch;
  let missing=true;
  h.browser.fetch=(url,options)=>options?.method!=='POST'&&missing
    ?(missing=false,Promise.resolve({ok:false,status:404,json:async()=>({error:'mockup_job_not_found'})}))
    :original(url,options);
  h.client.sync(h.configurations);await settle();
  const posts=h.requests.filter(request=>request.method==='POST').map(request=>JSON.parse(request.body));
  assert.equal(posts.length,2);assert.notEqual(posts[0].requestId,posts[1].requestId);assert.equal(posts[1].refresh,false);
  h.load();h.approve();assert.ok(h.client.value());
});

test('loaded partial images cannot approve a job whose remaining task is still pending', async t => {
  const h=harness(t), original=h.browser.fetch;
  h.browser.fetch=async(url,options)=>{
    const response=await original(url,options);
    if(options?.method!=='POST')return{ok:true,json:async()=>{const data=await response.json();data.jobs[0].status='pending';return data;}};
    return response;
  };
  h.client.sync([h.configurations[0]]);await settle();h.load();h.approve();assert.equal(h.client.value(),null);
  for(const job of h.jobs.values())job.status='completed';
  h.browser.fetch=original;await h.advance(3000);h.approve();assert.ok(h.client.value());
});

test('a sustained outage ends with a retry action at the overall deadline', async t => {
  const h=harness(t);h.browser.fetch=()=>Promise.reject(new Error('offline'));
  h.client.sync(h.configurations);await settle();await h.advance(Preview.DEADLINE_MS);
  assert.equal(h.consent.disabled,true);assert.equal(h.root.querySelector('article button').hidden,false);
  assert.equal(h.root.querySelector('.order-preview-spinner').hidden,true);
  assert.equal(h.timers.size,0);
});

test('the spinner stops after every image has loaded and page exit cancels pending requests', async t => {
  const h=harness(t);h.client.sync(h.configurations);await settle();
  assert.equal(h.root.querySelector('.order-preview-spinner').hidden,false);
  h.load();assert.equal(h.root.querySelector('.order-preview-spinner').hidden,true);
  let signal;h.browser.fetch=(url,options)=>{signal=options.signal;return new Promise(()=>{});};
  h.client.reset();await settle();h.browser.dispatchEvent(new h.browser.Event('pagehide'));await settle();
  assert.equal(signal.aborted,true);assert.equal(h.timers.size,0);
});
