'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const crypto=require('node:crypto');
const email=require('../src/authEmail');
const {SELLER}=require('../src/emailTemplates');
const key=Buffer.alloc(32,4);
process.env.AUTH_EMAIL_HOOK_SECRET='v1,whsec_'+key.toString('base64');
function fixture(type='signup',language='de') {return {user:{email:'old@example.test',new_email:'new@example.test',user_metadata:{language}},
  email_data:{email_action_type:type,token:'123456',token_new:'654321',old_email:'previous@example.test',redirect_to:'https://attacker.example'}};}
function signed(payload,id='hook_test',seconds=Math.floor(Date.now()/1000)) {
  const raw=Buffer.from(JSON.stringify(payload));const headers={'webhook-id':id,'webhook-timestamp':String(seconds),
    'webhook-signature':'v1,'+crypto.createHmac('sha256',key).update(`${id}.${seconds}.`).update(raw).digest('base64')};
  return {raw,headers};
}
test('Auth mail verifies the exact signed body and rejects expired, modified and missing signatures',()=>{
  const {raw,headers}=signed(fixture());assert.equal(email.verify(raw,headers).id,'hook_test');
  assert.throws(()=>email.verify(Buffer.from(raw.toString().replace('signup','recovery')),headers),/invalid_signature/);
  assert.throws(()=>email.verify(raw,{...headers,'webhook-signature':'v1,invalid'}),/invalid_signature/);
  assert.throws(()=>email.verify(raw,{}),/invalid_signature/);
  const expired=signed(fixture(),'hook_expired',Math.floor(Date.now()/1000)-301);
  assert.throws(()=>email.verify(expired.raw,expired.headers),/invalid_signature/);
});
test('secure email change sends the correct OTP to each address and notifications go to the former address',()=>{
  const messages=email.messages(fixture('email_change'),'test-id');assert.equal(messages.length,2);
  assert.deepEqual(messages[0].payload.to,['old@example.test']);assert.match(messages[0].payload.text,/123456/);
  assert.doesNotMatch(messages[0].payload.text,/654321/);
  assert.deepEqual(messages[1].payload.to,['new@example.test']);assert.match(messages[1].payload.text,/654321/);
  assert.notEqual(messages[0].idempotencyKey,messages[1].idempotencyKey);
  const notification=email.messages(fixture('email_changed_notification'),'other-id')[0];
  assert.deepEqual(notification.payload.to,['previous@example.test']);assert.doesNotMatch(notification.payload.text,/123456/);
});
test('all six languages provide code and security mail with the canonical seller reply address and no supplied redirects',()=>{
  for(const locale of ['de','en','fr','it','es','tr'])for(const type of ['signup','recovery','email_change','reauthentication','password_changed_notification','email_changed_notification']) {
    for(const {payload,idempotencyKey} of email.messages(fixture(type,locale),'same-id')) {
      assert.equal(payload.replyTo,SELLER.email);assert.ok(payload.subject&&payload.html&&payload.text);
      assert.match(payload.html,new RegExp(`lang="${locale}"`));assert.doesNotMatch(payload.html,/attacker|token_hash/);
      assert.match(idempotencyKey,/^auth:[a-f0-9]{64}:/);
    }
  }
  assert.throws(()=>email.messages(fixture('unknown'),'id'),/invalid_auth_email/);
  const unsafe=fixture();unsafe.email_data.token='<svg>';assert.throws(()=>email.messages(unsafe,'id'),/invalid_auth_email/);
});
