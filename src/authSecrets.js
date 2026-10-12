'use strict';

function base64Key(value,minBytes,maxBytes) {
  const raw=String(value||'');
  const key=Buffer.from(raw,'base64');
  return key.length>=minBytes&&key.length<=maxBytes&&key.toString('base64')===raw?key:null;
}

function sessionKey(value) { return base64Key(value,32,32); }
function emailHookKey(value) {
  // Standard Webhooks HMAC keys are not restricted to AES's 32-byte key size.
  return base64Key(String(value||'').replace(/^(?:v1,)?whsec_/,''),32,128);
}

module.exports={sessionKey,emailHookKey};
