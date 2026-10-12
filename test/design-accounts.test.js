'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const crypto=require('node:crypto');
const {startTestServer,productDesignPayload,createEvent,stripeTaxPaymentSession}=require('./helpers');

function fakeProvider(){
  const users=new Map(),tokens=new Map();let failDeletion=false;
  const session=user=>{const token=crypto.randomUUID();tokens.set(token,user.id);return {user,session:{access_token:token,refresh_token:token,expires_at:Math.floor(Date.now()/1000)+3600}};};
  const error=(code='invalid_credentials')=>Object.assign(new Error(code),{code,status:401});
  return {users,tokens,set failDeletion(value){failDeletion=value;},async call(method,args){
    let user;
    if(method==='signUp'){
      if([...users.values()].some(u=>u.email===args.email))return {user:{id:crypto.randomUUID(),identities:[]},session:null};
      user={id:crypto.randomUUID(),email:args.email,password:args.password,created_at:new Date().toISOString(),
        user_metadata:args.options?.data||{},app_metadata:{providers:['email']},identities:[{provider:'email'}]};users.set(user.id,user);return {user,session:null};
    }
    if(method==='signInWithPassword'){
      user=[...users.values()].find(u=>u.email===args.email&&u.password===args.password);
      if(!user)throw error();if(!user.email_confirmed_at)throw error('email_not_confirmed');return session(user);
    }
    if(method==='getUser'){
      user=users.get(tokens.get(args.accessToken));if(!user)throw error();return {user};
    }
    if(method==='verifyOtp'){
      if(args.token!=='123456')throw error('otp_expired');user=[...users.values()].find(u=>u.email===args.email||u.new_email===args.email);
      if(!user)throw error();user.email_confirmed_at=new Date().toISOString();
      if(args.type==='email_change'){user.email=user.new_email;user.new_email=null;}
      return session(user);
    }
    if(method==='refreshSession'){user=users.get(tokens.get(args.refreshToken));if(!user)throw error();return session(user);}
    if(method==='updateUser'){
      user=users.get(tokens.get(args.tokens.access_token));if(!user)throw error();
      if(args.attributes.email)user.new_email=args.attributes.email;
      if(args.attributes.password)user.password=args.attributes.password;return {user};
    }
    if(method==='deleteUser'){if(failDeletion)throw Object.assign(new Error('provider unavailable'),{status:503});users.delete(args.id);return {};}
    if(method==='listUsers')return {users:[...users.values()]};
    if(['resend','resetPasswordForEmail','signOut','reauthenticate'].includes(method))return {};
    if(method==='exchangeCode'){
      if(args.code!=='google-code'||args.verifier.length!==43)throw error();
      user=[...users.values()].find(u=>u.app_metadata.providers.includes('google'));if(!user)throw error();return session(user);
    }
    throw new Error(`Unhandled ${method}`);
  }};
}

function memoryStorage(){const objects=new Map();let failUpload=false,failRemove=false,waitUpload=null;
  return {objects,set failUpload(v){failUpload=v;},set failRemove(v){failRemove=v;},set waitUpload(v){waitUpload=v;},
    async upload(key,bytes){if(waitUpload)await waitUpload;if(failUpload)throw Object.assign(new Error('failed'),{code:'account_storage_unavailable',status:503});objects.set(key,Buffer.from(bytes));},
    async download(key){if(!objects.has(key))throw new Error('missing');return objects.get(key);},
    async remove(key){if(failRemove)throw new Error('remove failed');objects.delete(key);}};
}

function snapshot(){return {productKey:'white-glossy-mug-duo-11oz',orientation:'default',theme:'pastel',words:[['Liebe',1]],customColors:[],...productDesignPayload()};}
const saveBody=(name='Mein Design')=>({name,requestId:crypto.randomUUID(),designId:crypto.randomUUID(),version:0,snapshot:snapshot()});

test('optional accounts, private manual saves and deletion are independent of guest commerce',async t=>{
  process.env.DESIGN_ACCOUNTS_ENABLED='true';
  process.env.AUTH_SESSION_SECRET=Buffer.alloc(32,9).toString('base64');
  const h=await startTestServer();t.after(()=>h.close());
  const auth=require('../src/accountAuth'),designs=require('../src/savedDesigns'),db=require('../src/db');
  const provider=fakeProvider(),storage=memoryStorage();auth.setAdapterForTests(provider);designs.setStorageForTests(storage);
  async function request(path,body,cookie='',extra={}){
    const response=await fetch(`${h.baseUrl}/api/account/${path}`,{method:body===undefined?'GET':'POST',headers:{
      ...(body===undefined?{}:{'Content-Type':'application/json','X-Wolkenworte-Account':'1'}),Cookie:cookie,...extra},
      ...(body===undefined?{}:{body:JSON.stringify(body)})});
    const data=response.headers.get('content-type')?.includes('json')?await response.json():await response.arrayBuffer();
    return {response,data,cookie:response.headers.get('set-cookie')?.split(';')[0]||cookie};
  }
  async function register(email){const signup=await request('signup',{email,password:'A good long password'});assert.equal(signup.response.status,200);
    const verified=await request('verify',{email,code:'123456'});assert.equal(verified.response.status,200);return verified.cookie;}
  let first,second,body,design;

  await t.test('verification is mandatory; cookie is opaque and CSRF is enforced',async()=>{
    assert.equal((await request('designs')).response.status,401);
    const blocked=await request('signup',{email:'first@account.test',password:'A good long password'},'',{Origin:'https://attacker.example'});
    assert.equal(blocked.response.status,403);
    await request('signup',{email:'first@account.test',password:'A good long password'});
    assert.equal((await request('login',{email:'first@account.test',password:'A good long password'})).data.error,'email_not_confirmed');
    assert.equal((await request('verify',{email:'first@account.test',code:'000000'})).data.error,'otp_expired');
    const verified=await request('verify',{email:'first@account.test',code:'123456'});first=verified.cookie;
    assert.match(verified.response.headers.get('set-cookie'),/HttpOnly/i);assert.match(verified.response.headers.get('set-cookie'),/SameSite=Lax/i);
    assert.doesNotMatch(JSON.stringify(verified.data),/access_token|refresh_token/);
    const sessions=await h.query('SELECT tokens_ciphertext FROM account_sessions');
    assert.ok(![...provider.tokens.keys()].some(token=>sessions.rows[0].tokens_ciphertext.includes(token)));
    second=await register('second@account.test');
  });

  await t.test('manual save retains full editable artwork; retry is idempotent and foreign access is unknown',async()=>{
    body=saveBody();const result=await request('designs',body,first);assert.equal(result.response.status,201);design=result.data.design;
    assert.equal(storage.objects.size,2);assert.equal(design.version,1);
    const retry=await request('designs',body,first);assert.equal(retry.data.design.id,design.id);assert.equal(storage.objects.size,2);
    const loaded=await request(`designs/${design.id}/load`,{},first);
    assert.equal(loaded.data.design.snapshot.designs.default[0].text,snapshot().designs.default[0].text);
    assert.equal((await request(`designs/${design.id}/load`,{},second)).response.status,404);
    assert.equal((await request(`designs/${design.id}/preview`,undefined,second)).response.status,404);
    assert.equal((await request(`designs/${crypto.randomUUID()}/preview`,undefined,second)).response.status,404);
    assert.equal((await request(`designs/${design.id}/delete`,{confirm:true},second)).response.status,200);
    assert.equal((await request('designs',undefined,first)).data.designs.length,1);
  });

  await t.test('overview and login do not renew designs; full opening uses calendar months',async()=>{
    await h.query("UPDATE saved_designs SET expires_at=transaction_timestamp()+interval '1 day' WHERE id=$1",[design.id]);
    const before=(await h.query('SELECT expires_at FROM saved_designs WHERE id=$1',[design.id])).rows[0].expires_at;
    await request('session',undefined,first);await request('designs',undefined,first);
    assert.equal(+(await h.query('SELECT expires_at FROM saved_designs WHERE id=$1',[design.id])).rows[0].expires_at,+before);
    await request(`designs/${design.id}/load`,{},first);
    assert.equal((await h.query("SELECT expires_at=last_activity_at+interval '3 months' AS calendar FROM saved_designs WHERE id=$1",[design.id])).rows[0].calendar,true);
  });

  await t.test('reopening survives expiry of the original event; new workspace contains no private artwork',async()=>{
    const opened=await request(`designs/${design.id}/open`,{},first);assert.equal(opened.response.status,200);
    const slug=opened.data.url.split('/')[2];const publicData=await fetch(`${h.baseUrl}/api/events/${slug}/configurator`).then(r=>r.json());
    assert.deepEqual(publicData.words,[]);assert.equal(publicData.event.directDesign,true);
    await h.query("UPDATE events SET created_at=transaction_timestamp()-interval '366 days' WHERE slug=$1",[slug]);
    assert.notEqual((await request(`designs/${design.id}/open`,{},first)).data.url,opened.data.url);
    assert.equal((await request(`designs/${design.id}/load`,{},first)).response.status,200);
  });

  await t.test('explicit updates reject a stale version and failed upload preserves the last saved copy',async()=>{
    const update={...body,requestId:crypto.randomUUID(),version:1,name:'Neue Version'};
    update.snapshot={...snapshot(),theme:'ocean'};
    const saved=await request('designs',update,first);assert.equal(saved.response.status,201);assert.equal(saved.data.design.version,2);
    assert.equal((await request('designs',{...update,requestId:crypto.randomUUID()},first)).data.error,'design_conflict');
    storage.failUpload=true;
    assert.equal((await request('designs',{...update,requestId:crypto.randomUUID(),version:2},first)).response.status,503);
    storage.failUpload=false;
    assert.equal((await request(`designs/${design.id}/load`,{},first)).data.design.version,2);
  });

  await t.test('PKCE OAuth consumes its browser-bound flow once and refuses a different identity during reauthentication',async()=>{
    const google={id:crypto.randomUUID(),email:'google@account.test',email_confirmed_at:new Date().toISOString(),
      created_at:new Date().toISOString(),app_metadata:{providers:['google']},user_metadata:{language:'fr'},identities:[{provider:'google'}]};provider.users.set(google.id,google);
    const begin=await request('google',{returnTo:'https://attacker.example'});
    const url=new URL(begin.data.url);assert.equal(url.searchParams.get('code_challenge_method'),'s256');assert.equal(url.searchParams.get('code_challenge').length,43);
    const callback=await fetch(`${h.baseUrl}/auth/callback?code=google-code`,{headers:{Cookie:begin.cookie},redirect:'manual'});
    assert.equal(callback.status,303);assert.equal(callback.headers.get('location'),'/konto');
    assert.ok(callback.headers.getSetCookie().some(c=>c.startsWith('ww-account=')));
    const replay=await fetch(`${h.baseUrl}/auth/callback?code=google-code`,{headers:{Cookie:begin.cookie},redirect:'manual'});
    assert.equal(replay.headers.get('location'),'/anmelden?error=callback');
    const proof=await request('google',{purpose:'reauth',returnTo:'/konto/einstellungen'},first);
    const wrong=await fetch(`${h.baseUrl}/auth/callback?code=google-code`,{headers:{Cookie:proof.cookie+'; '+first},redirect:'manual'});
    assert.equal(wrong.headers.get('location'),'/anmelden?error=callback');
    assert.ok(!wrong.headers.getSetCookie().some(c=>c.startsWith('ww-account=')));
  });

  await t.test('a lost commit response and cleanup failure preserve committed private files',async()=>{
    const finish=db.finishSavedDesignWrite,claim=db.claimDesignObjectDeletionBatch;
    const body=saveBody('Commit-Antwort verloren');
    db.finishSavedDesignWrite=async(...args)=>{await finish(...args);throw Object.assign(new Error('lost commit response'),{status:503});};
    try{const saved=await request('designs',body,first);assert.equal(saved.response.status,201);
      assert.equal((await request(`designs/${body.designId}/load`,{},first)).response.status,200);
    }finally{db.finishSavedDesignWrite=finish;}
    db.claimDesignObjectDeletionBatch=async()=>{throw new Error('cleanup unavailable');};
    try{const saved=await request('designs',{...body,requestId:crypto.randomUUID(),version:1},first);assert.equal(saved.response.status,201);
      assert.equal((await request(`designs/${body.designId}/load`,{},first)).response.status,200);
    }finally{db.claimDesignObjectDeletionBatch=claim;}
    await request(`designs/${body.designId}/delete`,{confirm:true},first);await designs.drainObjects({maxObjects:40});
  });

  await t.test('password recovery is a restricted ten-minute session until a successful password change',async()=>{
    await register('recover@account.test');
    const reset=await request('verify',{email:'recover@account.test',code:'123456',purpose:'recovery'});
    assert.equal(reset.data.recovery,true);assert.equal((await request('designs',undefined,reset.cookie)).response.status,401);
    assert.equal((await request('delete',{confirm:true},reset.cookie)).response.status,401);
    assert.equal((await request('password',{password:'short'},reset.cookie)).response.status,400);
    const changed=await request('password',{password:'My new longer password'},reset.cookie);assert.equal(changed.response.status,200);
    assert.equal((await request('designs',undefined,changed.cookie)).response.status,200);
    assert.equal((await request('login',{email:'recover@account.test',password:'A good long password'})).response.status,401);
  });

  await t.test('an upload finishing after account deletion cannot resurrect a design or orphan private files',async()=>{
    const cookie=await register('upload@account.test');const user=[...provider.users.values()].find(u=>u.email==='upload@account.test');
    let release,arrived;const blocked=new Promise(resolve=>{release=resolve;});const uploading=new Promise(resolve=>{arrived=resolve;});
    const original=storage.upload;storage.upload=async(key,bytes)=>{arrived();await blocked;await original(key,bytes);};
    const pending=request('designs',saveBody(),cookie);await uploading;
    assert.equal((await request('delete',{confirm:true},cookie)).response.status,200);
    release();assert.equal((await pending).response.status,401);storage.upload=original;
    assert.equal((await h.query('SELECT 1 FROM saved_designs WHERE account_id=$1',[user.id])).rowCount,0);
    assert.ok(![...storage.objects.keys()].some(key=>key.startsWith(user.id+'/')));
    await h.query("UPDATE saved_design_objects SET delete_after=transaction_timestamp(),next_attempt_at=transaction_timestamp() WHERE account_id=$1",[user.id]);
    await designs.drainObjects({maxObjects:40});
    assert.equal((await h.query('SELECT 1 FROM saved_design_objects WHERE account_id=$1',[user.id])).rowCount,0);
  });

  await t.test('only a verified payment renews the library entry; deleting it leaves the immutable purchased copy usable',async()=>{
    const event=await createEvent(h.baseUrl);const eventRow=await db.getEventBySlug(event.slug);
    await h.query("UPDATE saved_designs SET expires_at=transaction_timestamp()+interval '1 day' WHERE id=$1",[design.id]);
    const before=(await db.getSavedDesign([...provider.users.values()].find(u=>u.email==='first@account.test').id,design.id)).expires_at;
    const response=await fetch(`${h.baseUrl}/api/events/${event.slug}/configurations`,{method:'POST',headers:{'Content-Type':'application/json',Cookie:first},
      body:JSON.stringify({...snapshot(),quantity:1,accountDesignId:design.id})});assert.equal(response.status,201);const config=await response.json();
    assert.equal((await h.query('SELECT expires_at FROM saved_designs WHERE id=$1',[design.id])).rows[0].expires_at.toISOString(),before);
    const quote=await db.createCheckoutQuote({eventId:eventRow.id,configurationId:config.id,
      recipient:{name:'Test Account',address1:'Testweg 1',city:'Berlin',zip:'10115',country_code:'DE'},
      printfulCosts:{currency:'EUR',subtotal:10,shipping:5,total:15},quote:{currency:'EUR',quantity:1,itemsCents:1000,shippingCents:500,taxCents:0,totalCents:1500}});
    const {order}=await db.createCheckoutOrder({eventId:eventRow.id,configurationId:config.id,quote,mode:'test'});
    const sessionId='cs_test_account_retention',customerId='cus_accountretention';
    await db.attachStripeCustomer(order.id,customerId);await db.attachStripeSession(order.id,{id:sessionId,url:'https://checkout.stripe.test/account'});
    const payment={stripeEventId:'evt_account_retention',eventType:'checkout.session.completed',stripeSessionId:sessionId,livemode:false,
      ...stripeTaxPaymentSession({order,sessionId,customerId,taxCents:0,shippingTaxCents:0})};
    await db.recordSuccessfulPayment(payment);const renewed=(await h.query('SELECT expires_at FROM saved_designs WHERE id=$1',[design.id])).rows[0].expires_at;
    assert.ok(renewed>Date.parse(before));await db.recordSuccessfulPayment(payment);
    assert.equal(+(await h.query('SELECT expires_at FROM saved_designs WHERE id=$1',[design.id])).rows[0].expires_at,+renewed);
    const secondUser=[...provider.users.values()].find(u=>u.email==='second@account.test');
    const own=await request('designs',saveBody('Bestellkopie bleibt'),second);const independentId=own.data.design.id;
    await h.query('UPDATE configurations SET saved_design_id=$1,saved_design_owner_id=$2 WHERE id=$3',[independentId,secondUser.id,config.id]);
    await request(`designs/${independentId}/delete`,{confirm:true},second);
    assert.ok(await db.getConfiguration(config.id));assert.equal((await db.getConfiguration(config.id)).saved_design_id,null);
  });

  await t.test('signed Auth emails deduplicate delivery and reject a signed replay with a changed body',async()=>{
    const email=require('../src/authEmail'),key=Buffer.alloc(32,4),delivered=[];
    process.env.AUTH_EMAIL_HOOK_SECRET='v1,whsec_'+key.toString('base64');email.setAdapterForTests(async message=>delivered.push(message));
    const payload={user:{email:'first@account.test',user_metadata:{language:'en'}},email_data:{email_action_type:'signup',token:'123456'}};
    async function send(value){const raw=JSON.stringify(value),timestamp=String(Math.floor(Date.now()/1000)),id='account_hook_test';return fetch(`${h.baseUrl}/auth/email-hook`,{
      method:'POST',headers:{'Content-Type':'application/json','webhook-id':id,'webhook-timestamp':timestamp,
        'webhook-signature':'v1,'+crypto.createHmac('sha256',key).update(`${id}.${timestamp}.${raw}`).digest('base64')},body:raw});}
    assert.equal((await send(payload)).status,200);assert.equal((await send(payload)).status,200);assert.equal(delivered.length,1);
    assert.equal((await send({...payload,email_data:{...payload.email_data,token:'654321'}})).status,400);assert.equal(delivered.length,1);
  });

  await t.test('unfinished blank sides can be saved; storage quota and reservation accounting are enforced',async()=>{
    const blank=saveBody('Noch in Arbeit');blank.snapshot.designs.default=[];
    assert.equal((await request('designs',blank,second)).response.status,201);
    const original=await db.listSavedDesigns([...provider.users.values()].find(u=>u.email==='second@account.test').id);
    await h.query('UPDATE saved_designs SET byte_size=20971520 WHERE account_id=$1',[original[0].account_id]);
    for(let index=0;index<4;index++)await h.query(`INSERT INTO saved_designs(id,account_id,name,product_key,orientation,snapshot_key,preview_key,snapshot_sha256,byte_size)
      SELECT $1,account_id,name,product_key,orientation,snapshot_key,preview_key,snapshot_sha256,20971520 FROM saved_designs WHERE id=$2`,[crypto.randomUUID(),original[0].id]);
    assert.equal((await request('designs',saveBody(),second)).data.error,'design_quota');
    await h.query('DELETE FROM saved_designs WHERE account_id=$1 AND id<>$2',[original[0].account_id,original[0].id]);
    await h.query('UPDATE saved_designs SET byte_size=$2 WHERE id=$1',[original[0].id,original[0].byte_size]);
  });

  await t.test('export is owner-only and does not renew retention; permanent deletion retries object failure',async()=>{
    const exported=await request('export',undefined,first);assert.equal(exported.data.account.email,'first@account.test');assert.equal(exported.data.designs.length,1);
    assert.equal(exported.data.designs[0].snapshot.theme,'ocean');
    storage.failRemove=true;
    assert.equal((await request(`designs/${design.id}/delete`,{confirm:true},first)).response.status,200);
    assert.equal((await request(`designs/${design.id}/load`,{},first)).response.status,404);
    assert.ok((await h.query("SELECT 1 FROM saved_design_objects WHERE state='delete_pending'")).rowCount>0);
    storage.failRemove=false;await h.query("UPDATE saved_design_objects SET next_attempt_at=transaction_timestamp(),delete_after=transaction_timestamp() WHERE state='delete_pending'");
    await designs.drainObjects({maxObjects:20});
    assert.equal(storage.objects.size,2,'only the second account remains');
  });

  await t.test('account deletion blocks stale sessions immediately even while Auth deletion fails',async()=>{
    const user=[...provider.users.values()].find(u=>u.email==='second@account.test');
    await h.query("UPDATE account_sessions SET reauthenticated_at=transaction_timestamp()-interval '11 minutes' WHERE account_id=$1",[user.id]);
    assert.equal((await request('delete',{confirm:true},second)).data.error,'reauthentication_needed');
    second=(await request('reauthenticate',{password:'A good long password'},second)).cookie;
    provider.failDeletion=true;assert.equal((await request('delete',{confirm:true},second)).response.status,200);
    assert.equal((await request('designs',undefined,second)).response.status,401);
    assert.equal((await request('login',{email:user.email,password:user.password})).response.status,401);
    assert.equal((await h.query('SELECT 1 FROM saved_designs WHERE account_id=$1',[user.id])).rowCount,0);
    provider.failDeletion=false;await h.query('UPDATE account_deletions SET next_attempt_at=transaction_timestamp()');
    await designs.maintenance({deadline:Date.now()+14000});assert.equal(provider.users.has(user.id),false);
    assert.equal(storage.objects.size,0);
  });

  await t.test('unverified registrations expire and ordinary guest checkout configuration still works',async()=>{
    await request('signup',{email:'old@account.test',password:'A good long password'});
    await h.query("UPDATE design_accounts SET created_at=transaction_timestamp()-interval '8 days' WHERE NOT verified");
    await designs.maintenance({deadline:Date.now()+14000});
    assert.ok(![...provider.users.values()].some(u=>u.email==='old@account.test'));
    const event=await createEvent(h.baseUrl);
    const response=await fetch(`${h.baseUrl}/api/events/${event.slug}/configurations`,{method:'POST',headers:{'Content-Type':'application/json'},
      body:JSON.stringify({...snapshot(),accountDesignId:crypto.randomUUID()})});
    assert.equal(response.status,201);
    assert.equal((await fetch(`${h.baseUrl}/auth/callback?code=forged`,{redirect:'manual'})).status,303);
  });

  await t.test('expiry revokes access before cleanup, and retention keeps running if the account UI is disabled',async()=>{
    const saved=await request('designs',saveBody('Abgelaufen'),first);assert.equal(saved.response.status,201);
    await h.query("UPDATE saved_designs SET expires_at=transaction_timestamp()-interval '1 second' WHERE id=$1",[saved.data.design.id]);
    assert.equal((await request(`designs/${saved.data.design.id}/load`,{},first)).response.status,404);
    const recover=[...provider.users.values()].find(u=>u.email==='recover@account.test');
    await h.query("UPDATE design_accounts SET last_activity_at=transaction_timestamp()-interval '13 months' WHERE id=$1",[recover.id]);
    process.env.DESIGN_ACCOUNTS_ENABLED='false';
    assert.equal((await request('designs',saveBody(),first)).response.status,501);
    for(let index=0;index<3;index++)await designs.maintenance({deadline:Date.now()+20000});
    assert.equal(provider.users.has(recover.id),false);
    assert.equal((await h.query('SELECT 1 FROM saved_designs WHERE id=$1',[saved.data.design.id])).rowCount,0);
    process.env.DESIGN_ACCOUNTS_ENABLED='true';
    const flags=await h.query("SELECT bool_and(relrowsecurity) AS protected FROM pg_class WHERE relnamespace=$1::regnamespace AND relname IN('saved_designs','account_sessions','design_accounts')",[h.schema]);
    assert.equal(flags.rows[0].protected,true);
  });
});
