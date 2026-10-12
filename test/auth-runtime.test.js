'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const crypto=require('node:crypto');
const {validateRuntimeConfig}=require('../src/runtimeConfig');
const {designAccountSettings}=require('../scripts/production-cutover');
const authSecrets=require('../src/authSecrets');

function withProductionAccounts(overrides,check) {
  const values={NODE_ENV:'production',APP_ENVIRONMENT:'production',PORT:'8080',
    STRIPE_PAYMENT_MODE:'live',STRIPE_LIVE_PAYMENTS_ENABLED:'true',MAINTENANCE_MODE:'false',
    STRIPE_LIVE_SECRET_KEY:'sk_live_fixture',STRIPE_LIVE_WEBHOOK_SECRET:'whsec_fixture',
    STRIPE_TEST_SECRET_KEY:undefined,STRIPE_TEST_LOCAL_WEBHOOK_SECRET:undefined,STRIPE_TEST_HOSTED_WEBHOOK_SECRET:undefined,
    STRIPE_SECRET_KEY:undefined,STRIPE_WEBHOOK_SECRET:undefined,STRIPE_ALLOW_LIVE_PAYMENTS:undefined,
    MIGRATION_DATABASE_URL:undefined,PUBLIC_URL:'https://wolkenworte.io',SUPABASE_URL:'https://fixture.supabase.co',
    SUPABASE_SECRET_KEY:'sb_secret_fixture',SUPABASE_PUBLISHABLE_KEY:'sb_publishable_fixture',
    SUPABASE_STORAGE_BUCKET:'wolkenworte-private',SUPABASE_DESIGNS_BUCKET:'wolkenworte-designs',
    RATE_LIMIT_HMAC_SECRET:'r'.repeat(32),MAINTENANCE_SECRET:'m'.repeat(32),
    EMAIL_DELIVERY_MODE:'live',RESEND_API_KEY:'re_fixture',RESEND_FROM_EMAIL:'Wolkenworte <konto@mail.wolkenworte.io>',
    RESEND_WEBHOOK_SECRET:'whsec_fixture',DESIGN_ACCOUNTS_ENABLED:'true',AUTH_EMAIL_DELIVERY_MODE:'live',
    AUTH_SESSION_SECRET:Buffer.alloc(32,3).toString('base64'),AUTH_EMAIL_HOOK_SECRET:'v1,whsec_'+Buffer.alloc(60,4).toString('base64'),
    PRINTFUL_FULFILLMENT_MODE:'live',PRINTFUL_ALLOW_ORDER_WRITES:'true',PRINTFUL_CONFIRM_LIVE_ORDERS:'true',
    PRINTFUL_WEBHOOK_SECRET:'fixture',PRINTFUL_WEBHOOK_PUBLIC_KEY:'fixture',PRINTFUL_MOCKUP_TOOLS_ENABLED:'false',
    ALLOW_REMOTE_MARKETING_SEEDS:'false',ALLOW_TEST_DATA_RESET:'false',GA4_MEASUREMENT_ID:'',...overrides};
  const previous=Object.fromEntries(Object.keys(values).map(name=>[name,process.env[name]]));
  const apply=env=>{for(const [name,value] of Object.entries(env)){if(value===undefined)delete process.env[name];else process.env[name]=value;}};
  apply(values);try{return check(values);}finally{apply(previous);}
}

test('production startup and release activation accept the actual 60-byte Supabase dashboard hook key',()=>{
  withProductionAccounts({},values=>{
    assert.equal(validateRuntimeConfig(),true);
    assert.equal(designAccountSettings(values).AUTH_EMAIL_HOOK_SECRET,values.AUTH_EMAIL_HOOK_SECRET);
    assert.equal(authSecrets.emailHookKey(values.AUTH_EMAIL_HOOK_SECRET).length,60);
  });
});
test('production startup and release activation reject weak hook keys, invalid AES keys and reused keys',()=>{
  for(const length of [31,129])withProductionAccounts({AUTH_EMAIL_HOOK_SECRET:'v1,whsec_'+crypto.randomBytes(length).toString('base64')},values=>{
    assert.throws(()=>validateRuntimeConfig(),/AUTH_EMAIL_HOOK_SECRET/);
    assert.throws(()=>designAccountSettings(values),/AUTH_EMAIL_HOOK_SECRET/);
  });
  const session=Buffer.alloc(32,3).toString('base64');
  for(const value of ['whsec_'+session,Buffer.alloc(60).toString('base64')])withProductionAccounts({AUTH_SESSION_SECRET:value},values=>{
    assert.throws(()=>validateRuntimeConfig(),/AUTH_SESSION_SECRET/);
    assert.throws(()=>designAccountSettings(values),/AUTH_SESSION_SECRET/);
  });
  withProductionAccounts({AUTH_EMAIL_HOOK_SECRET:'v1,whsec_'+session},values=>{
    assert.throws(()=>validateRuntimeConfig(),/unabhängig/);
    assert.throws(()=>designAccountSettings(values),/independent/);
  });
});
