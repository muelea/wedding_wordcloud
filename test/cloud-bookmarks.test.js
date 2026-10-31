'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const {startTestServer, createEvent} = require('./helpers');

test('private account cloud bookmarks preserve shared event and design behavior', async t => {
  process.env.DESIGN_ACCOUNTS_ENABLED = 'true';
  process.env.AUTH_SESSION_SECRET = Buffer.alloc(32, 9).toString('base64');
  const app = await startTestServer(); t.after(app.close);
  const auth = require('../src/accountAuth'), db = require('../src/db');
  const users = new Map(), tokens = new Map(); let oauthUser;
  const user = email => {
    const value = {id:crypto.randomUUID(), email, created_at:new Date().toISOString(),
      email_confirmed_at:new Date().toISOString(), app_metadata:{providers:['email']}};
    users.set(value.id, value); return value;
  };
  const session = value => {
    const token = crypto.randomUUID(); tokens.set(token, value.id);
    return {user:value,session:{access_token:token,refresh_token:token,expires_at:Math.floor(Date.now()/1000)+3600}};
  };
  auth.setAdapterForTests({async call(method,args) {
    if (method === 'signInWithPassword') return session([...users.values()].find(u => u.email === args.email));
    if (method === 'getUser') return {user:users.get(tokens.get(args.accessToken))};
    if (method === 'exchangeCode') return session(oauthUser);
    if (method === 'deleteUser') { users.delete(args.id); return {}; }
    if (method === 'signOut') return {};
    throw new Error(method);
  }});
  require('../src/savedDesigns').setStorageForTests({async removeMany() {}});
  async function request(path, body, cookie = '', headers = {}) {
    const response = await fetch(`${app.baseUrl}/api/account/${path}`, {
      method:body === undefined ? 'GET' : 'POST', headers:{Cookie:cookie,
        ...(body === undefined ? {} : {'Content-Type':'application/json','X-Wolkenworte-Account':'1'}),...headers},
      ...(body === undefined ? {} : {body:JSON.stringify(body)}),
    });
    return {status:response.status, data:await response.json(), response,
      cookie:response.headers.get('set-cookie')?.split(';')[0] || cookie};
  }
  const first = user('first@bookmark.test'), second = user('second@bookmark.test');
  const login = async value => (await request('login', {email:value.email,password:'a fixture password'})).cookie;
  const firstCookie = await login(first), secondCookie = await login(second);
  const cloud = await createEvent(app.baseUrl), source = await db.getEventBySlug(cloud.slug);
  await db.addWordContribution(source.id, 'Liebe', 'browser-owner');
  const bookmark = (value = first) => ({slug:cloud.slug,ownerId:value.id});
  let saved;

  await t.test('authenticated, same-origin writes validate the public live cloud and owner', async () => {
    assert.equal((await request('clouds')).status, 401);
    assert.equal((await request('clouds', bookmark())).status, 401);
    assert.equal((await request('clouds', bookmark(), firstCookie, {Origin:'https://attacker.invalid'})).status, 403);
    assert.equal((await request('clouds', bookmark(), firstCookie, {'X-Wolkenworte-Account':''})).status, 403);
    assert.equal((await request('clouds', bookmark(second), firstCookie)).status, 401);
    for (const slug of ['https://example.com/cloud', cloud.slug.toLowerCase(), crypto.randomBytes(16).toString('base64url')]) {
      if (slug === cloud.slug) continue;
      assert.equal((await request('clouds', {slug,ownerId:first.id}, firstCookie)).status, 404);
    }
    const direct = await db.createEvent({title:'Private design',pin:null});
    assert.equal((await request('clouds', {slug:direct.slug,ownerId:first.id}, firstCookie)).status, 404);
    const before = await db.getEventBySlug(cloud.slug);
    const results = await Promise.all(Array.from({length:6}, () => request('clouds', bookmark(), firstCookie)));
    assert.ok(results.every(r => r.status === 201)); saved = results[0].data.cloud;
    assert.ok(results.every(r => r.data.cloud.id === saved.id));
    assert.equal((await app.query('SELECT count(*)::integer AS n FROM saved_clouds WHERE account_id=$1',[first.id])).rows[0].n,1);
    assert.equal((await db.getEventBySlug(cloud.slug)).expires_at, before.expires_at);
    assert.equal((await db.getEventBySlug(cloud.slug)).updated_at, before.updated_at);
  });

  await t.test('collections are private and cards use current words and the existing keepsake URL', async () => {
    assert.deepEqual((await request('clouds', undefined, secondCookie)).data.clouds, []);
    assert.equal((await request(`clouds/${cloud.slug}`, undefined, secondCookie)).data.cloud,null);
    const own = await request('clouds', undefined, firstCookie);
    assert.match(own.response.headers.get('cache-control'), /private.*no-store/);
    assert.deepEqual(own.data.clouds[0].previewWords,[['Liebe',1]]);
    assert.equal(saved.url,`/e/${cloud.slug}`);
    assert.equal(saved.designUrl,`/e/${cloud.slug}/configure?view=products`);
    const page = await fetch(`${app.baseUrl}/e/${cloud.slug}`).then(r => r.text());
    assert.match(page,/data-cloud-bookmark/);
    assert.match(page,/configure\?view=products/);
    const gallery=await fetch(`${app.baseUrl}${saved.designUrl}`);
    assert.equal(gallery.status,200);
    const galleryHtml=await gallery.text();
    assert.match(galleryHtml,/const directDesign = false/);
    assert.match(galleryHtml,/id="check-live-words"/);
    assert.deepEqual((await fetch(`${app.baseUrl}/api/events/${cloud.slug}/configurator`).then(r=>r.json())).words,[['Liebe',1]]);
    const counts = (await app.query('SELECT (SELECT count(*) FROM events)::integer AS events,(SELECT count(*) FROM configurations)::integer AS configurations')).rows[0];
    await request('clouds', undefined, firstCookie);
    await request(`clouds/${cloud.slug}`, undefined, firstCookie);
    assert.deepEqual((await app.query('SELECT (SELECT count(*) FROM events)::integer AS events,(SELECT count(*) FROM configurations)::integer AS configurations')).rows[0],counts);
    await db.addWordContribution(source.id,'Freude','another-browser');
    await db.updateEventTitle({eventId:source.id,title:'Updated cloud title'});
    const updated = (await request('clouds',undefined,firstCookie)).data.clouds[0];
    assert.equal(updated.title,'Updated cloud title'); assert.equal(updated.previewWords.length,2);
    await db.archiveAndClearWords(source.id);
    assert.deepEqual((await request('clouds',undefined,firstCookie)).data.clouds[0].previewWords,[]);
    const other = (await request('clouds',bookmark(second),secondCookie)).data.cloud;
    assert.notEqual(other.id,saved.id);
    await request(`clouds/${saved.id}/delete`,{},secondCookie);
    assert.equal((await request('clouds',undefined,firstCookie)).data.clouds.length,1);
    await request(`clouds/${other.id}/delete`,{},secondCookie);
    assert.equal((await request('clouds',undefined,secondCookie)).data.clouds.length,0);
    assert.ok(await db.getEventBySlug(cloud.slug));
  });

  await t.test('expired and deleted sources retain only an unavailable bookmark', async () => {
    await app.query("UPDATE events SET updated_at=now()-interval '4 months' WHERE id=$1",[source.id]);
    const unavailable = (await request('clouds',undefined,firstCookie)).data.clouds[0];
    assert.equal(unavailable.available,false);assert.equal(unavailable.url,null);assert.equal(unavailable.designUrl,null);
    assert.deepEqual(unavailable.previewWords,[]);
    assert.equal((await request('clouds',bookmark(),firstCookie)).status,404);
    assert.equal((await fetch(`${app.baseUrl}/e/${cloud.slug}`)).status,404);
    await require('../src/lifecycle').cleanupExpiredEvent(source.id);
    const deleted = (await request('clouds',undefined,firstCookie)).data.clouds[0];
    assert.equal(deleted.available,false);assert.deepEqual(deleted.previewWords,[]);
    assert.equal((await app.query('SELECT event_id FROM saved_clouds WHERE id=$1',[saved.id])).rows[0].event_id,null);
    const exported = await request('export',undefined,firstCookie);
    assert.equal(exported.data.clouds[0].slug,cloud.slug);
    assert.equal(exported.data.clouds[0].id,saved.id);
    assert.equal(exported.data.clouds[0].previewWords,undefined);
  });

  await t.test('the separate quota is serialized and duplicate saves at the limit still succeed', async () => {
    const value = user('quota@bookmark.test'),cookie = await login(value);
    for(let n=0;n<99;n++)await app.query('INSERT INTO saved_clouds(id,account_id,slug,title) VALUES($1,$2,$3,$4)',
      [crypto.randomUUID(),value.id,crypto.randomBytes(16).toString('base64url'),'Old bookmark']);
    const one = await createEvent(app.baseUrl), two = await createEvent(app.baseUrl);
    const results = await Promise.all([one,two].map(event => request('clouds',{slug:event.slug,ownerId:value.id},cookie)));
    assert.deepEqual(results.map(r=>r.status).sort(),[201,413]);
    const accepted = results.find(r=>r.status===201).data.cloud;
    assert.equal((await request('clouds',{slug:accepted.slug,ownerId:value.id},cookie)).status,201);
    assert.equal((await request('clouds',undefined,cookie)).data.clouds.length,100);
    assert.equal((await db.listSavedDesigns(value.id)).length,0);
  });

  await t.test('Google sign-in returns to the live cloud without permitting external redirects', async () => {
    oauthUser=first;
    const next=`/e/${cloud.slug}?cloudSave=1`;
    const begin=await request('google',{returnTo:next});
    const callback=await fetch(`${app.baseUrl}/auth/callback?code=fixture`,{headers:{Cookie:begin.cookie},redirect:'manual'});
    assert.equal(callback.headers.get('location'),next);
    assert.equal(auth.safeReturnTo('//attacker.invalid'),'/konto');
    assert.equal(auth.safeReturnTo('/e/not-a-slug?cloudSave=1'),'/konto');
    assert.equal(auth.safeReturnTo('/konto#wortwolken'),'/konto#wortwolken');
  });

  await t.test('only active cloud bookmarks protect dormant accounts; deletion leaves shared clouds intact', async () => {
    const value=user('dormant@bookmark.test'), cookie=await login(value);
    const live=await createEvent(app.baseUrl);
    await request('clouds',{slug:live.slug,ownerId:value.id},cookie);
    await app.query("UPDATE design_accounts SET last_activity_at=now()-interval '13 months' WHERE id=$1",[value.id]);
    assert.equal(await db.expireDesignAccount(value.id),false);
    assert.ok(!(await db.retentionPage('accounts',new Date())).includes(value.id));
    const removal=await request('delete',{confirm:true},cookie);assert.equal(removal.status,200);
    assert.equal((await app.query('SELECT count(*)::integer AS n FROM saved_clouds WHERE account_id=$1',[value.id])).rows[0].n,0);
    assert.ok(await db.getEventBySlug(live.slug));
    await app.query("UPDATE design_accounts SET last_activity_at=now()-interval '13 months' WHERE id=$1",[first.id]);
    assert.equal(await db.expireDesignAccount(first.id),true,'an unavailable bookmark cannot retain a dormant account forever');
    assert.equal((await db.listSavedClouds(first.id)).length,0);
    assert.equal((await app.query("SELECT relrowsecurity FROM pg_class WHERE relnamespace=$1::regnamespace AND relname='saved_clouds'",[app.schema])).rows[0].relrowsecurity,true);
  });
});
