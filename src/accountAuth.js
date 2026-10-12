'use strict';

const crypto = require('node:crypto');
const { createClient } = require('@supabase/supabase-js');
const db = require('./db');
const { parseCookies, resolvePageLocale } = require('./pageRenderer');
const { sourceHashForRequest } = require('./clientIdentity');
const authSecrets = require('./authSecrets');

const SESSION_MS = 30 * 24 * 60 * 60 * 1000;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
let testAdapter = null;
const localKey = crypto.randomBytes(32);
const digest = value => crypto.createHash('sha256').update(String(value)).digest('hex');
const enabled = () => process.env.DESIGN_ACCOUNTS_ENABLED === 'true';
const isTest = () => process.env.NODE_ENV === 'test';

function encryptionKey() {
  const raw = String(process.env.AUTH_SESSION_SECRET || '');
  const key = authSecrets.sessionKey(raw);
  if (key) return key;
  if (process.env.NODE_ENV !== 'production') return localKey;
  throw db.accountError('account_unavailable', 503);
}

function seal(value, purpose) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', encryptionKey(), iv);
  cipher.setAAD(Buffer.from(purpose));
  const bytes = Buffer.concat([cipher.update(JSON.stringify(value)), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), bytes]).toString('base64');
}

function unseal(value, purpose) {
  const bytes = Buffer.from(value, 'base64');
  const cipher = crypto.createDecipheriv('aes-256-gcm', encryptionKey(), bytes.subarray(0, 12));
  cipher.setAuthTag(bytes.subarray(12, 28));
  cipher.setAAD(Buffer.from(purpose));
  return JSON.parse(Buffer.concat([cipher.update(bytes.subarray(28)), cipher.final()]).toString());
}

function providerReady() {
  return (isTest() ? Boolean(testAdapter) : Boolean(process.env.SUPABASE_URL &&
    process.env.SUPABASE_PUBLISHABLE_KEY && process.env.SUPABASE_SECRET_KEY));
}
function ready() { return enabled() && providerReady(); }

function origin(req) {
  if (process.env.NODE_ENV === 'production') return new URL(process.env.PUBLIC_URL).origin;
  return `${req.protocol}://${req.get('host')}`;
}

function safeReturnTo(value) {
  if (typeof value !== 'string' || value.length > 1200 || !value.startsWith('/') || value.startsWith('//')) return '/konto';
  const url = new URL(value, 'https://wolkenworte.invalid');
  if (url.origin !== 'https://wolkenworte.invalid' || !/^(?:\/konto(?:\/einstellungen)?|\/e\/[A-Za-z0-9_-]{22}\/configure)$/.test(url.pathname)) return '/konto';
  return url.pathname + url.search;
}

function cookieName(kind) {
  return (process.env.NODE_ENV === 'production' ? '__Host-' : '') + `ww-${kind}`;
}

function setCookie(req, res, kind, value, maxAge = SESSION_MS) {
  res.cookie(cookieName(kind), value, { httpOnly: true, secure: process.env.NODE_ENV === 'production' || req.secure,
    sameSite: 'lax', path: '/', maxAge });
}

function clearCookie(req, res, kind = 'account') {
  res.clearCookie(cookieName(kind), { httpOnly: true, secure: process.env.NODE_ENV === 'production' || req.secure,
    sameSite: 'lax', path: '/' });
}

function tokenFromCookie(req, kind = 'account') {
  const value = parseCookies(req.headers.cookie)[cookieName(kind)];
  return /^[A-Za-z0-9_-]{43}$/.test(value || '') ? value : null;
}

function mutationGuard(req, res, next) {
  res.set('Cache-Control', 'private, no-store');
  res.set('Referrer-Policy', 'no-referrer');
  if (!ready()) return res.status(501).json({ error: 'account_unavailable' });
  if (req.get('X-Wolkenworte-Account') !== '1' || req.get('Sec-Fetch-Site') === 'cross-site' ||
      (req.get('Origin') && req.get('Origin') !== origin(req))) return res.status(403).json({ error: 'invalid_request' });
  next();
}

function providerClient(secret = false) {
  return createClient(process.env.SUPABASE_URL, secret ? process.env.SUPABASE_SECRET_KEY : process.env.SUPABASE_PUBLISHABLE_KEY, {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
    global: { fetch: (input, init = {}) => fetch(input, { ...init,
      signal: init.signal ? AbortSignal.any([init.signal, AbortSignal.timeout(5000)]) : AbortSignal.timeout(5000) }) },
  });
}

async function provider(method, args = {}) {
  if (isTest()) {
    if (!testAdapter) throw db.accountError('account_unavailable', 503);
    return testAdapter.call(method, args);
  }
  const admin = ['deleteUser', 'listUsers', 'signOut'].includes(method);
  const client = providerClient(admin);
  let result;
  if (method === 'exchangeCode') {
    const response = await fetch(`${process.env.SUPABASE_URL}/auth/v1/token?grant_type=pkce`, {
      method: 'POST', headers: { apikey: process.env.SUPABASE_PUBLISHABLE_KEY, 'Content-Type': 'application/json' },
      body: JSON.stringify({ auth_code: args.code, code_verifier: args.verifier }), signal: AbortSignal.timeout(5000),
    });
    const data = await response.json();
    if (!response.ok) throw db.accountError('invalid_credentials', 401);
    return { user: data.user, session: data };
  }
  if (args.tokens && method !== 'getUser' && method !== 'signOut') {
    const established = await client.auth.setSession(args.tokens);
    if (established.error) throw db.accountError('account_unauthorized', 401);
  }
  switch (method) {
    case 'getUser': result = await client.auth.getUser(args.accessToken); break;
    case 'refreshSession': result = await client.auth.refreshSession({ refresh_token: args.refreshToken }); break;
    case 'signUp': result = await client.auth.signUp(args); break;
    case 'signInWithPassword': result = await client.auth.signInWithPassword(args); break;
    case 'verifyOtp': result = await client.auth.verifyOtp(args); break;
    case 'resend': result = await client.auth.resend(args); break;
    case 'resetPasswordForEmail': result = await client.auth.resetPasswordForEmail(args.email, args.options); break;
    case 'updateUser': result = await client.auth.updateUser(args.attributes, args.options); break;
    case 'reauthenticate': result = await client.auth.reauthenticate(); break;
    case 'deleteUser': result = await client.auth.admin.deleteUser(args.id, false); break;
    case 'listUsers': result = await client.auth.admin.listUsers({ page: args.page, perPage: 50 }); break;
    case 'signOut': result = await client.auth.admin.signOut(args.accessToken, 'local'); break;
    default: throw new Error('Unknown Auth operation');
  }
  if (result.error) {
    if (method === 'deleteUser' && result.error.status === 404) return {};
    const allowed = new Set(['invalid_credentials','email_not_confirmed','otp_expired','weak_password',
      'over_email_send_rate_limit','over_request_rate_limit','same_password','reauthentication_needed','user_already_exists']);
    throw db.accountError(allowed.has(result.error.code) ? result.error.code : 'account_unavailable',
      [400,401,403,422,429].includes(result.error.status) ? result.error.status : 503);
  }
  return result.data || {};
}

async function installSession(req, res, data, { purpose = 'signin', reauthenticated = false } = {}) {
  const user = data.user || data.session?.user;
  const session = data.session;
  if (!UUID.test(user?.id || '') || !user.email_confirmed_at || !session?.access_token || !session.refresh_token) {
    throw db.accountError('email_not_confirmed', 401);
  }
  // Validate against the provider's current user record, never decoded JWT claims.
  const verified = await provider('getUser', { accessToken: session.access_token });
  if (verified.user?.id !== user.id || !verified.user.email_confirmed_at) throw db.accountError('account_unauthorized', 401);
  const account = await db.ensureDesignAccount({ id: user.id, verified: true,
    locale: resolvePageLocale(req).locale, createdAt: user.created_at });
  if (!account) throw db.accountError('account_unauthorized', 401);
  const token = crypto.randomBytes(32).toString('base64url');
  const hash = digest(token);
  const tokens = { access_token: session.access_token, refresh_token: session.refresh_token };
  if (!await db.createAccountSession({ hash, accountId: user.id, ciphertext: seal(tokens, hash),
    accessExpiresAt: new Date((session.expires_at || Math.floor(Date.now()/1000) + 3600)*1000).toISOString(),
    purpose, reauthenticatedAt: reauthenticated ? new Date().toISOString() : null })) throw db.accountError('account_unauthorized', 401);
  const previous = tokenFromCookie(req);
  if (previous) await db.deleteAccountSession(digest(previous));
  await db.touchDesignAccount(user.id, resolvePageLocale(req).locale);
  setCookie(req,res,'account',token,purpose==='recovery'?10*60_000:SESSION_MS);
  return user;
}

async function resolveSession(req, res, { allowRecovery = false } = {}) {
  if (req.designAccountContext !== undefined) {
    if (!allowRecovery && req.designAccountContext?.session.purpose === 'recovery') return null;
    return req.designAccountContext;
  }
  req.designAccountContext = null;
  if (!ready()) return null;
  const token = tokenFromCookie(req);
  if (!token) return null;
  const hash = digest(token);
  let session = await db.getAccountSession(hash);
  if (!session) { clearCookie(req,res); return null; }
  let tokens;
  try { tokens = unseal(session.tokens_ciphertext,hash); }
  catch { await db.deleteAccountSession(hash); clearCookie(req,res); return null; }
  if (+new Date(session.access_expires_at) < Date.now()+60_000) {
    const lease = crypto.randomUUID();
    if (await db.claimAccountSessionRefresh(hash,lease)) {
      try {
        const fresh = await provider('refreshSession',{ refreshToken: tokens.refresh_token });
        if (!fresh.session?.access_token) throw db.accountError('account_unauthorized',401);
        tokens = { access_token: fresh.session.access_token, refresh_token: fresh.session.refresh_token };
        if (!await db.finishAccountSessionRefresh(hash,lease,seal(tokens,hash),
          new Date(fresh.session.expires_at*1000).toISOString())) throw db.accountError('account_unavailable',503);
      } catch(error) {
        if(error.status && error.status<500) {await db.deleteAccountSession(hash);clearCookie(req,res);return null;}
        await db.releaseAccountSessionRefresh(hash,lease);throw error;
      }
    } else {
      // Another request owns refresh-token rotation. Never replay its old token.
      for (let attempt=0; attempt<15; attempt++) {
        await new Promise(resolve=>setTimeout(resolve,100));
        session=await db.getAccountSession(hash);
        if (!session) return null;
        if (+new Date(session.access_expires_at)>Date.now()+60_000) break;
      }
      if (+new Date(session.access_expires_at)<=Date.now()+60_000) throw db.accountError('account_unavailable',503);
      tokens=unseal(session.tokens_ciphertext,hash);
    }
  }
  let result;
  try { result=await provider('getUser',{ accessToken: tokens.access_token }); }
  catch(error) {
    if(error.status>=500) throw error;
    await db.deleteAccountSession(hash); clearCookie(req,res); return null;
  }
  if (result.user?.id!==session.account_id || !result.user.email_confirmed_at || !await db.getDesignAccount(session.account_id)) {
    await db.deleteAccountSession(hash); clearCookie(req,res); return null;
  }
  req.designAccountContext={ session, hash, tokens, user: result.user };
  if (!allowRecovery && session.purpose==='recovery') return null;
  await db.touchDesignAccount(session.account_id);
  return req.designAccountContext;
}

async function requireAccount(req,res,options) {
  const context=await resolveSession(req,res,options);
  if(!context) throw db.accountError('account_unauthorized',401);
  return context;
}

function requireRecent(context) {
  if (!context.session.reauthenticated_at || Date.now()-Date.parse(context.session.reauthenticated_at)>10*60_000) {
    throw db.accountError('reauthentication_needed',403);
  }
}

async function limit(req, action, { max = 10, windowMs = 15*60_000, email = null, accountId = null } = {}) {
  const values=[sourceHashForRequest(req)];
  if(email) values.push(crypto.createHmac('sha256',encryptionKey()).update(email).digest('hex'));
  if(accountId) values.push(accountId);
  return db.consumeAccountRateLimits(values.map(value=>({ hash:digest(`${action}:${value}`),max,windowMs })));
}

function emailAddress(value) {
  if(typeof value!=='string') throw db.accountError('invalid_email',400);
  const email=value.trim().toLowerCase();
  if(email.length>254 || !/^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/.test(email)) throw db.accountError('invalid_email',400);
  return email;
}

function password(value, newPassword = false) {
  if(typeof value!=='string'||value.length>256||value.length<(newPassword?12:1)) throw db.accountError('weak_password',400);
  return value;
}

function setAdapterForTests(adapter) {
  if(!isTest()) throw new Error('Auth adapter overrides are test-only.');
  testAdapter=adapter;
}

module.exports={ enabled,ready,providerReady,UUID,digest,seal,unseal,origin,safeReturnTo,cookieName,setCookie,clearCookie,
  tokenFromCookie,mutationGuard,provider,installSession,resolveSession,requireAccount,requireRecent,
  limit,emailAddress,password,setAdapterForTests };
