'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const crypto=require('node:crypto');
const {startTestServer}=require('./helpers');

test('activity expiry and durable daily retention',async t=>{
  const app=await startTestServer();t.after(app.close);
  const db=require('../src/db'),daily=require('../src/dailyRetention');
  const event=()=>db.createEvent({title:'Aufbewahrung',pin:'1234'});
  const age=id=>app.query("UPDATE events SET updated_at=now()-interval '1 month' WHERE id=$1",[id]);
  const row=async id=>(await app.query('SELECT * FROM events WHERE id=$1',[id])).rows[0];

  await t.test('migration gives active legacy clouds a transition period without reviving expired ones',async()=>{
    const client=await db.getPool().connect();
    try {
      await client.query('BEGIN');
      await client.query('CREATE SCHEMA activity_upgrade_test');
      await client.query('SET LOCAL search_path TO activity_upgrade_test');
      const directory=path.join(__dirname,'../supabase/migrations');
      const migration='20261027000000_activity_retention.sql';
      const migrations=fs.readdirSync(directory).filter(name=>name.endsWith('.sql')&&name<migration).sort();
      for(const filename of migrations)await client.query(fs.readFileSync(path.join(directory,filename),'utf8'));
      await client.query(`INSERT INTO events(slug,title,created_at,expires_at) VALUES
        ('active','Aktiv',now()-interval '6 months',now()),
        ('expired','Abgelaufen',now()-interval '2 years',now())`);
      await client.query(fs.readFileSync(path.join(directory,migration),'utf8'));
      const rows=(await client.query(`SELECT slug,expires_at>now() AS active,
        expires_at=updated_at+interval '3 months' AS exact, updated_at=now() AS transition FROM events ORDER BY slug`)).rows;
      assert.deepEqual(rows,[{slug:'active',active:true,exact:true,transition:true},{slug:'expired',active:false,exact:true,transition:false}]);
      await client.query("UPDATE events SET updated_at='2028-01-31T12:00:00Z' WHERE slug='active'");
      assert.equal((await client.query("SELECT expires_at='2028-04-30T12:00:00Z'::timestamptz AS calendar FROM events WHERE slug='active'")).rows[0].calendar,true);
    } finally {await client.query('ROLLBACK');client.release();}
  });

  await t.test('only committed edits renew expiry; reads and rejected removal do not',async()=>{
    const e=await event();await age(e.id);const before=await row(e.id);
    await db.getEventBySlug(e.slug);await db.getWords(e.id);
    assert.equal(+new Date((await row(e.id)).updated_at),+before.updated_at);
    await db.updateEventTitle({eventId:e.id,title:e.title});
    assert.equal(+new Date((await row(e.id)).updated_at),+before.updated_at);
    assert.equal(await db.removeWordContribution(e.id,'unknown','owner'),null);
    assert.equal(+new Date((await row(e.id)).updated_at),+before.updated_at);
    const receipt=await db.addWordContribution(e.id,'Liebe','owner');
    assert.ok(+(await row(e.id)).updated_at>+before.updated_at);
    await age(e.id);await db.removeWordContribution(e.id,receipt,'owner');
    assert.ok(+(await row(e.id)).updated_at>+before.updated_at);
    await age(e.id);await db.updateEventTitle({eventId:e.id,title:'Neuer Titel'});
    assert.ok(+(await row(e.id)).updated_at>+before.updated_at);
    await age(e.id);const client=await db.getPool().connect();
    try {await client.query('BEGIN');await client.query("INSERT INTO words(event_id,word,count,updated_at) VALUES($1,'Rollback',1,now())",[e.id]);await client.query('ROLLBACK');}
    finally {client.release();}
    assert.ok(+(await row(e.id)).updated_at< Date.now()-20*86400000);
    await app.query("UPDATE events SET updated_at=now()-interval '4 months' WHERE id=$1",[e.id]);
    assert.equal(await db.getEventBySlug(e.slug),null);
    await assert.rejects(db.addWordContribution(e.id,'Zu spät','owner'),/event not found/);
  });

  await t.test('daily run deletes all 350 clouds and skips a locked first candidate without starvation',async()=>{
    await app.query('DELETE FROM retention_deferrals');await app.query('DELETE FROM retention_runs');
    const inserted=await app.query(`INSERT INTO events(slug,title,created_at,updated_at,expires_at)
      SELECT 'retention-'||n,'Test',now()-interval '4 months',now()-interval '4 months',now()
      FROM generate_series(1,351) n RETURNING id`);
    const blocked=inserted.rows[0].id;
    const lock=await db.getPool().connect();
    try {
      await lock.query('BEGIN');await lock.query('SELECT id FROM events WHERE id=$1 FOR UPDATE',[blocked]);
      for(let n=0;n<20;n++) {const result=await daily.run();if(result.status.startsWith('completed'))break;}
      assert.equal((await app.query("SELECT count(*)::int AS n FROM events WHERE slug LIKE 'retention-%'")).rows[0].n,1);
      const status=await db.getRetentionStatus();
      assert.equal(status.latest.status,'completed_with_deferrals');assert.ok(status.deferred>=1);
      assert.ok(status.latest.progress.events.checked>=351);
      assert.equal(await db.claimDailyRetentionRun(),null,'completed day is not started a second time');
    } finally {await lock.query('ROLLBACK');lock.release();}
    await app.query('UPDATE retention_deferrals SET next_attempt_at=now()');
    for(let n=0;n<5;n++)await daily.run();
    assert.equal((await app.query("SELECT count(*)::int AS n FROM events WHERE slug LIKE 'retention-%'")).rows[0].n,0);
  });

  await t.test('checkpoint survives a short slice and an expired lease cannot commit',async st=>{
    await app.query('DELETE FROM retention_deferrals');await app.query('DELETE FROM retention_runs');
    await app.query(`INSERT INTO events(slug,title,created_at,updated_at,expires_at)
      SELECT 'resume-'||n,'Test',now()-interval '4 months',now()-interval '4 months',now() FROM generate_series(1,70) n`);
    const lifecycle=require('../src/lifecycle'),original=lifecycle.cleanupExpiredEvent;
    let clock=Date.now();st.mock.method(Date,'now',()=>clock);
    const delayed=st.mock.method(lifecycle,'cleanupExpiredEvent',async id=>{const result=await original(id);clock+=300;return result;});
    assert.equal((await daily.run({deadline:clock+3000})).status,'running');
    delayed.mock.restore();st.mock.restoreAll();
    assert.equal((await db.getRetentionStatus()).latest.status,'running');
    const first=await db.claimDailyRetentionRun();assert.ok(first);
    assert.equal(await db.claimDailyRetentionRun(),null);
    await app.query("UPDATE retention_runs SET lease_until=now()-interval '1 second'");
    const second=await db.claimDailyRetentionRun();assert.ok(second);assert.notEqual(first.lease,second.lease);
    await assert.rejects(db.checkpointDailyRetention(first,{}),{code:'RETENTION_LEASE_LOST'});
    await db.releaseDailyRetention(first);
    assert.equal(await db.claimDailyRetentionRun(),null,'stale release must not unlock the successor');
    await db.releaseDailyRetention(second);
    delete require.cache[require.resolve('../src/dailyRetention')];
    const restarted=require('../src/dailyRetention');
    for(let n=0;n<10;n++) {if((await restarted.run()).status.startsWith('completed'))break;}
    assert.equal((await app.query("SELECT count(*)::int AS n FROM events WHERE slug LIKE 'resume-%'")).rows[0].n,0);
  });

  await t.test('all expired designs, inactive accounts and their files drain beyond the old five/forty limits',async st=>{
    await app.query('DELETE FROM retention_deferrals');await app.query('DELETE FROM retention_runs');
    const auth=require('../src/accountAuth'),designs=require('../src/savedDesigns');
    const ids=Array.from({length:70},()=>crypto.randomUUID());
    const owner=crypto.randomUUID();
    await app.query("INSERT INTO design_accounts(id,verified) VALUES($1,true)",[owner]);
    await app.query("INSERT INTO design_accounts(id,created_at,last_activity_at) SELECT id,now()-interval '8 days',now()-interval '8 days' FROM unnest($1::uuid[]) id",[ids]);
    await app.query(`INSERT INTO saved_designs(id,account_id,name,product_key,orientation,snapshot_key,preview_key,snapshot_sha256,byte_size,expires_at)
      SELECT id,$2,'Alt','cork-back-coaster','default',id||'.json',id||'.png',repeat('a',64),100,now()-interval '1 day'
      FROM unnest($1::uuid[]) id`,[ids,owner]);
    await app.query(`INSERT INTO saved_design_objects(object_key,account_id,state,upload_deadline)
      SELECT key,$1,'active',now() FROM (SELECT snapshot_key AS key FROM saved_designs UNION SELECT preview_key FROM saved_designs) keys`,[owner]);
    const removed=[],deleted=[];
    st.mock.method(auth,'providerReady',()=>true);
    st.mock.method(auth,'provider',async(method,args)=>{
      if(method==='listUsers')return {users:[]};
      assert.equal(method,'deleteUser');deleted.push(args.id);return {};
    });
    designs.setStorageForTests({remove:async key=>{removed.push(key);}});
    st.after(()=>designs.setStorageForTests(null));
    for(let n=0;n<20;n++){if((await daily.run()).status.startsWith('completed'))break;}
    assert.equal((await app.query('SELECT count(*)::int AS n FROM saved_designs')).rows[0].n,0);
    assert.equal((await app.query('SELECT count(*)::int AS n FROM saved_design_objects')).rows[0].n,0);
    assert.equal(removed.length,140);assert.equal(deleted.length,70);
    assert.equal((await app.query("SELECT count(*)::int AS n FROM design_accounts WHERE id=ANY($1::uuid[])",[ids])).rows[0].n,0);
    assert.equal((await db.getRetentionStatus()).latest.status,'completed');
  });

  await t.test('prepared files drain completely, keep paid/ambiguous references and retry Storage failures',async st=>{
    await app.query('DELETE FROM retention_deferrals');await app.query('DELETE FROM retention_runs');
    const storage=require('../src/privateStorage');
    const ids=Array.from({length:74},()=>crypto.randomBytes(18).toString('base64url'));
    const [paid,ambiguous,failed,linked]=ids.slice(-4);
    await app.query(`INSERT INTO prepared_print_files(id,surface_key,spec_hash,object_key,status,expires_at)
      SELECT id,'default','hash','prepared/'||id,'active',now()-interval '1 day' FROM unnest($1::text[]) id`,[ids]);
    await app.query(`INSERT INTO orders(event_slug_snapshot,event_title_snapshot,status,paid_at,fulfillment_status,mockup_approval_json)
      VALUES('paid-source','Bezahlt','paid',now(),'pending',$1)`,[{fileIds:[paid]}]);
    await app.query(`INSERT INTO orders(event_slug_snapshot,event_title_snapshot,status,checkout_first_attempt_at,checkout_session_expires_at,mockup_approval_json)
      VALUES('ambiguous-source','Ungeklärt','checkout_pending',now()-interval '2 days',now()-interval '1 day',$1)`,[{fileIds:[ambiguous]}]);
    const linkedOrder=(await app.query(`INSERT INTO orders(event_slug_snapshot,event_title_snapshot,status,paid_at,fulfillment_status)
      VALUES('linked-source','Bezahlte Quelle','paid',now(),'mocked') RETURNING id`)).rows[0];
    const item=(await app.query(`INSERT INTO order_items(order_id,shipment_index,item_index,product_key,printful_variant_id,quantity,configuration_snapshot_json)
      VALUES($1,0,0,'cork-back-coaster',15662,1,'{}') RETURNING id`,[linkedOrder.id])).rows[0];
    const artifact=await db.getOrCreatePrintArtifact({id:crypto.randomBytes(18).toString('base64url'),
      orderId:linkedOrder.id,orderItemId:item.id,surfaceKey:'default',objectKey:`prepared/${linked}`,
      mimeType:'image/png',byteSize:3,sha256:'a'.repeat(64),accessNonce:crypto.randomBytes(24).toString('base64url'),
      expiresAt:new Date(Date.now()+90*86400000),sourceFileId:linked});
    let failing=true;
    const removed=[];
    st.mock.method(storage,'remove',async key=>{
      if(failing&&key===`prepared/${failed}`)throw new Error('Storage offline');
      removed.push(key);
    });
    for(let n=0;n<20;n++){if((await daily.run()).status.startsWith('completed'))break;}
    const remaining=(await app.query('SELECT id FROM prepared_print_files ORDER BY id')).rows.map(row=>row.id);
    assert.deepEqual(remaining,[paid,ambiguous,failed,linked].sort());
    assert.equal((await app.query("SELECT 1 FROM retention_deferrals WHERE category='preparedFiles' AND target_id=$1",[linked])).rowCount,0,
      'routine paid-file retention must not create a recurring deletion retry');
    assert.equal(removed.length,70);
    assert.equal((await db.getRetentionStatus()).latest.status,'completed_with_deferrals');
    failing=false;
    await app.query("UPDATE retention_deferrals SET next_attempt_at=now() WHERE category='preparedFiles'");
    await app.query("UPDATE prepared_print_files SET lease_until=now()-interval '1 second' WHERE id=$1",[failed]);
    await daily.run();
    assert.equal((await app.query('SELECT 1 FROM prepared_print_files WHERE id=$1',[failed])).rowCount,0);
    assert.equal((await app.query('SELECT count(*)::int AS n FROM prepared_print_files')).rows[0].n,3);
    assert.equal(removed.length,71);
    await app.query('DELETE FROM print_artifacts WHERE id=$1',[artifact.id]);
    await app.query('DELETE FROM retention_runs');
    for(let n=0;n<20;n++){if((await daily.run()).status.startsWith('completed'))break;}
    assert.equal((await app.query('SELECT 1 FROM prepared_print_files WHERE id=$1',[linked])).rowCount,0,
      'the source becomes eligible when its last paid artifact is removed');
  });

  await t.test('metadata drains past a single batch and keeps current daily history',async()=>{
    await app.query('DELETE FROM retention_runs');await app.query('DELETE FROM retention_deferrals');
    const e=await event(),configurationId=crypto.randomBytes(12).toString('base64url');
    await app.query(`INSERT INTO configurations(id,event_id,product_key,printful_variant_id,theme,words_json,design_json,print_width,print_height,expires_at)
      VALUES($1,$2,'white-glossy-mug-duo-11oz',1320,'pastel','[]','{}',2700,1120,now()+interval '1 day')`,[configurationId,e.id]);
    await app.query("INSERT INTO mockup_provider_budgets(scope) VALUES(repeat('f',64)) ON CONFLICT DO NOTHING");
    await app.query(`INSERT INTO mockup_jobs(id,scope,event_id,configuration_id,mode,cache_key,status,data,next_at,created_at,expires_at)
      SELECT left(md5(n::text),24),repeat('f',64),$1,$2,'customer',repeat('c',64),'completed','{"sourceObjectKeys":[]}',now(),now()-interval '13 hours',now()-interval '1 hour'
      FROM generate_series(1,250)n`,[e.id,configurationId]);
    await app.query(`INSERT INTO stripe_webhook_events(stripe_event_id,event_type,processed_at)
      SELECT 'old-event-'||n,'checkout.session.expired',now()-interval '100 days' FROM generate_series(1,350)n`);
    await app.query(`INSERT INTO maintenance_runs(status,completed_at)
      SELECT 'succeeded',now()-interval '100 days' FROM generate_series(1,350)`);
    await app.query(`INSERT INTO retention_runs(day,cutoff,status,completed_at)
      VALUES(current_date-120,now()-interval '120 days','completed',now()-interval '120 days')`);
    for(let n=0;n<20;n++){if((await daily.run()).status.startsWith('completed'))break;}
    assert.equal((await app.query("SELECT count(*)::int AS n FROM stripe_webhook_events WHERE stripe_event_id LIKE 'old-event-%'")).rows[0].n,0);
    assert.equal((await app.query("SELECT count(*)::int AS n FROM maintenance_runs WHERE completed_at<now()-interval '90 days'")).rows[0].n,0);
    assert.equal((await app.query('SELECT count(*)::int AS n FROM retention_runs')).rows[0].n,1);
    assert.equal((await app.query("SELECT count(*)::int AS n FROM mockup_jobs WHERE scope=repeat('f',64)")).rows[0].n,0);
  });
});
