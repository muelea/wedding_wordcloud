'use strict';

const express=require('express');
const crypto=require('node:crypto');
const db=require('../db');
const auth=require('../accountAuth');
const designs=require('../savedDesigns');
const {renderPage,resolvePageLocale}=require('../pageRenderer');
const {asyncRoute}=require('../asyncRoute');

const code=value=> {
  if(typeof value!=='string'||!/^\d{6}$/.test(value)) throw db.accountError('otp_expired',400);
  return value;
};

function makeAccountRouter() {
  const router=express.Router();
  router.use((req,res,next)=> {
    if (!req.path.startsWith('/api/account/') && req.path !== '/auth/callback' &&
        !['/anmelden','/konto','/konto/einstellungen'].includes(req.path)) return next('router');
    res.set('Cache-Control','private, no-store'); res.vary('Cookie');
    res.set('Referrer-Policy','no-referrer'); res.set('X-Content-Type-Options','nosniff');
    next();
  });
  const json=express.json({limit:'4kb'});
  const post=(path,handler)=>router.post(`/api/account/${path}`,auth.mutationGuard,json,asyncRoute(handler));

  router.get(['/anmelden','/konto','/konto/einstellungen'],asyncRoute(async(req,res)=> {
    if(req.path==='/konto/einstellungen') {
      const query=req.originalUrl.includes('?')?req.originalUrl.slice(req.originalUrl.indexOf('?')):'';
      return res.redirect(303,`/konto${query}#einstellungen`);
    }
    const context=await auth.resolveSession(req,res,{allowRecovery:true});
    const page=req.path==='/konto'?'library':'signin';
    return renderPage(req,res,'account',{cacheControl:'private, no-store',
      header:{variant:'back',mobileMenu:true},pageData:{accountPage:page,accountAvailable:auth.ready(),
        returnTo:auth.safeReturnTo(req.query.next),accountUser:context?publicUser(context):null}});
  }));

  router.get('/api/account/session',asyncRoute(async(req,res)=> {
    const context=await auth.resolveSession(req,res,{allowRecovery:true});
    res.json({enabled:auth.ready(),user:context?publicUser(context):null});
  }));

  post('signup',async(req,res)=> {
    const email=auth.emailAddress(req.body?.email);
    await auth.limit(req,'signup',{email});
    const data=await auth.provider('signUp',{email,password:auth.password(req.body?.password,true),
      options:{emailRedirectTo:`${auth.origin(req)}/auth/callback`,data:{language:resolvePageLocale(req).locale}}});
    // Supabase obfuscates existing accounts. Never persist its decoy UUID.
    if(auth.UUID.test(data.user?.id||'')&&data.user.identities?.length&&!data.user.email_confirmed_at) {
      await db.ensureDesignAccount({id:data.user.id,locale:resolvePageLocale(req).locale,createdAt:data.user.created_at});
    }
    if(data.session) throw db.accountError('account_confirmation_required',503);
    res.json({sent:true});
  });

  post('verify',async(req,res)=> {
    const email=auth.emailAddress(req.body?.email);
    await auth.limit(req,'verify',{email,max:10,windowMs:10*60_000});
    const purpose=req.body?.purpose==='recovery'?'recovery':'signin';
    const data=await auth.provider('verifyOtp',{email,token:code(req.body?.code),type:purpose==='recovery'?'recovery':'email'});
    await auth.installSession(req,res,data,{purpose,reauthenticated:true});
    res.json({ok:true,recovery:purpose==='recovery'});
  });

  post('login',async(req,res)=> {
    const email=auth.emailAddress(req.body?.email);
    await auth.limit(req,'login',{email});
    const data=await auth.provider('signInWithPassword',{email,password:auth.password(req.body?.password)});
    await auth.installSession(req,res,data,{reauthenticated:true});
    res.json({ok:true});
  });

  post('resend',async(req,res)=> {
    const email=auth.emailAddress(req.body?.email);
    await auth.limit(req,'resend',{email,max:1,windowMs:60_000});
    await auth.provider('resend',{email,type:'signup'});
    res.json({sent:true});
  });

  post('recovery',async(req,res)=> {
    const email=auth.emailAddress(req.body?.email);
    await auth.limit(req,'recovery',{email,max:1,windowMs:60_000});
    await auth.provider('resetPasswordForEmail',{email,options:{redirectTo:`${auth.origin(req)}/auth/callback`}});
    res.json({sent:true});
  });

  post('google',async(req,res)=> {
    await auth.limit(req,'google',{max:20});
    const purpose=req.body?.purpose==='reauth'?'reauth':'signin';
    const context=purpose==='reauth'?await auth.requireAccount(req,res):null;
    const flow=crypto.randomBytes(32).toString('base64url');
    const verifier=crypto.randomBytes(32).toString('base64url');
    const hash=auth.digest(flow);
    const returnTo=auth.safeReturnTo(req.body?.returnTo);
    await db.createAccountOAuthFlow({hash,ciphertext:auth.seal(verifier,hash),returnTo,purpose,accountId:context?.user.id});
    auth.setCookie(req,res,'oauth',flow,10*60_000);
    const url=new URL(`${process.env.SUPABASE_URL}/auth/v1/authorize`);
    url.searchParams.set('provider','google');
    url.searchParams.set('redirect_to',`${auth.origin(req)}/auth/callback`);
    url.searchParams.set('code_challenge',crypto.createHash('sha256').update(verifier).digest('base64url'));
    url.searchParams.set('code_challenge_method','s256');
    url.searchParams.set('prompt','select_account');
    res.json({url:url.href});
  });

  router.get('/auth/callback',asyncRoute(async(req,res)=> {
    const token=auth.tokenFromCookie(req,'oauth');
    auth.clearCookie(req,res,'oauth');
    if(!auth.ready()||!token||typeof req.query.code!=='string'||req.query.code.length>1024) {
      return res.redirect(303,'/anmelden?error=callback');
    }
    const hash=auth.digest(token);
    const flow=await db.consumeAccountOAuthFlow(hash);
    if(!flow) return res.redirect(303,'/anmelden?error=callback');
    try {
      const data=await auth.provider('exchangeCode',{code:req.query.code,verifier:auth.unseal(flow.verifier_ciphertext,hash)});
      if(flow.purpose==='reauth'&&data.user?.id!==flow.account_id) throw db.accountError('account_unauthorized',401);
      await auth.installSession(req,res,data,{reauthenticated:true});
      return res.redirect(303,flow.return_to);
    } catch { return res.redirect(303,'/anmelden?error=callback'); }
  }));

  post('logout',async(req,res)=> {
    const context=await auth.resolveSession(req,res,{allowRecovery:true});
    if(context) {
      await db.deleteAccountSession(context.hash);
      // Revoke refresh access at the provider too. Local revocation is already durable.
      try { await auth.provider('signOut',{accessToken:context.tokens.access_token}); } catch {}
    }
    auth.clearCookie(req,res); res.json({ok:true});
  });

  post('reauthenticate',async(req,res)=> {
    const context=await auth.requireAccount(req,res);
    await auth.limit(req,'reauth',{accountId:context.user.id});
    const data=await auth.provider('signInWithPassword',{email:context.user.email,password:auth.password(req.body?.password)});
    if(data.user?.id!==context.user.id) throw db.accountError('invalid_credentials',401);
    await auth.installSession(req,res,data,{reauthenticated:true}); res.json({ok:true});
  });

  post('password',async(req,res)=> {
    const context=await auth.requireAccount(req,res,{allowRecovery:true});
    await auth.limit(req,'password',{accountId:context.user.id});
    await auth.provider('updateUser',{tokens:context.tokens,attributes:{password:auth.password(req.body?.password,true),
      ...(req.body?.code?{nonce:code(req.body.code)}:{})}});
    await db.deleteOtherAccountSessions(context.user.id,context.hash);
    if(context.session.purpose==='recovery') {
      await db.completeAccountRecovery(context.hash);
      auth.setCookie(req,res,'account',auth.tokenFromCookie(req));
    }
    res.json({ok:true});
  });

  post('password-code',async(req,res)=> {
    const context=await auth.requireAccount(req,res);
    await auth.limit(req,'password-code',{accountId:context.user.id,max:1,windowMs:60_000});
    await auth.provider('reauthenticate',{tokens:context.tokens}); res.json({sent:true});
  });

  post('email',async(req,res)=> {
    const context=await auth.requireAccount(req,res);
    const email=auth.emailAddress(req.body?.email);
    await auth.limit(req,'email-change',{accountId:context.user.id,max:1,windowMs:60_000});
    await auth.provider('updateUser',{tokens:context.tokens,attributes:{email},options:{emailRedirectTo:`${auth.origin(req)}/auth/callback`}});
    res.json({sent:true,currentEmail:context.user.email,newEmail:email});
  });

  post('email-verify',async(req,res)=> {
    const context=await auth.requireAccount(req,res);
    const email=auth.emailAddress(req.body?.email);
    if(email!==context.user.email&&email!==context.user.new_email) throw db.accountError('invalid_request',400);
    await auth.limit(req,'email-verify',{accountId:context.user.id,max:10,windowMs:10*60_000});
    const data=await auth.provider('verifyOtp',{email,token:code(req.body?.code),type:'email_change'});
    if(data.user&&data.user.id!==context.user.id) throw db.accountError('account_unauthorized',401);
    const completed=Boolean(data.session&&data.user?.email===context.user.new_email);
    if(completed) await auth.installSession(req,res,data,{reauthenticated:true});
    res.json({ok:true,completed});
  });

  post('delete',async(req,res)=> {
    const context=await auth.requireAccount(req,res);
    auth.requireRecent(context);
    if(req.body?.confirm!==true) throw db.accountError('invalid_request',400);
    await designs.deleteAccount(context.user.id);
    auth.clearCookie(req,res); res.json({ok:true});
  });

  router.get('/api/account/designs',asyncRoute(async(req,res)=> {
    const context=await auth.requireAccount(req,res);
    res.json({designs:(await db.listSavedDesigns(context.user.id)).map(designs.summary),limits:{designs:20,bytes:100*1024*1024}});
  }));

  router.post('/api/account/designs',auth.mutationGuard,
    asyncRoute(async(req,res,next)=> { await auth.requireAccount(req,res); next(); }),
    express.json({limit:'40mb'}),asyncRoute(async(req,res)=> {
      const context=await auth.requireAccount(req,res);
      await auth.limit(req,'design-save',{accountId:context.user.id,max:30,windowMs:60_000});
      try { req.body=require('../../public/js/design-image-data').unpack(req.body); }
      catch { throw db.accountError('invalid_design',400); }
      if(req.body?.ownerId&&req.body.ownerId!==context.user.id) throw db.accountError('account_unauthorized',401);
      const design=await designs.save(context.user.id,req.body,resolvePageLocale(req).locale);
      res.status(201).json({design});
    }));

  router.get('/api/account/designs/:id/preview',asyncRoute(async(req,res)=> {
    const context=await auth.requireAccount(req,res);
    if(!auth.UUID.test(req.params.id)) throw db.accountError('design_not_found',404);
    const row=await db.getSavedDesign(context.user.id,req.params.id);
    if(!row) throw db.accountError('design_not_found',404);
    const bytes=await designs.storage().download(row.preview_key);
    const current=await db.getSavedDesign(context.user.id,row.id);
    if(!current) throw db.accountError('design_not_found',404);
    if(current.preview_key!==row.preview_key) throw db.accountError('design_conflict');
    res.type('png').send(bytes);
  }));

  post('designs/:id/load',async(req,res)=> {
    const context=await auth.requireAccount(req,res);
    res.json({design:await designs.load(context.user.id,req.params.id,{touch:true})});
  });

  post('designs/:id/open',async(req,res)=> {
    const context=await auth.requireAccount(req,res);
    if(!auth.UUID.test(req.params.id)) throw db.accountError('design_not_found',404);
    const slug=await db.savedDesignWorkspace(context.user.id,req.params.id);
    res.json({url:`/e/${slug}/configure?accountDesign=${req.params.id}`});
  });

  post('designs/:id/rename',async(req,res)=> {
    const context=await auth.requireAccount(req,res);
    if(!auth.UUID.test(req.params.id)||!Number.isInteger(req.body.version)) throw db.accountError('invalid_request',400);
    res.json({design:designs.summary(await db.renameSavedDesign(context.user.id,req.params.id,designs.designName(req.body.name),req.body.version))});
  });

  post('designs/:id/delete',async(req,res)=> {
    const context=await auth.requireAccount(req,res);
    if(!auth.UUID.test(req.params.id)||req.body?.confirm!==true) throw db.accountError('invalid_request',400);
    await db.deleteSavedDesign(context.user.id,req.params.id);
    await designs.drainObjects({accountId:context.user.id,maxObjects:2});
    res.json({ok:true});
  });

  router.get('/api/account/export',asyncRoute(async(req,res)=> {
    const context=await auth.requireAccount(req,res);
    await auth.limit(req,'export',{accountId:context.user.id,max:2,windowMs:60_000});
    const rows=await db.listSavedDesigns(context.user.id);
    const account=await db.getDesignAccount(context.user.id);
    res.set('Content-Disposition','attachment; filename="wolkenworte-designs.json"'); res.type('json');
    res.write(JSON.stringify({version:1,exportedAt:new Date().toISOString(),account:{email:context.user.email,
      newEmail:context.user.new_email||null,locale:account.locale,createdAt:account.created_at,lastActivityAt:account.last_activity_at,
      lastSignInAt:context.user.last_sign_in_at||null,profile:context.user.user_metadata||{},
      identities:(context.user.identities||[]).map(identity=>({provider:identity.provider,id:identity.id,createdAt:identity.created_at,profile:identity.identity_data})),
      providers:context.user.app_metadata?.providers||[]}}).slice(0,-1)+',"designs":[');
    try {
      for(let index=0;index<rows.length;index++) {
        const design=await designs.load(context.user.id,rows[index].id);
        if(res.destroyed)return;
        if(!res.write((index?',':'')+JSON.stringify(design))) {
          await new Promise((resolve,reject)=>{
            const done=()=>{res.off('close',closed);resolve();};
            const closed=()=>{res.off('drain',done);reject(new Error('Export closed'));};
            res.once('drain',done);res.once('close',closed);
          });
        }
      }
      res.end(']}');
    } catch { res.destroy(); }
  }));

  router.use((error,req,res,next)=> {
    if(!req.path.startsWith('/api/account/')) return next(error);
    const status=Number.isInteger(error.status)?error.status:503;
    if(status===429) res.set('Retry-After','60');
    return res.status(status).json({error: /^[a-z_]+$/.test(error.code||'')?error.code:'account_unavailable'});
  });
  return router;
}

function publicUser(context) {
  return {id:context.user.id,email:context.user.email,newEmail:context.user.new_email||null,
    providers:context.user.app_metadata?.providers||[],recovery:context.session.purpose==='recovery',
    recent:Boolean(context.session.reauthenticated_at&&Date.now()-Date.parse(context.session.reauthenticated_at)<10*60_000)};
}

module.exports={makeAccountRouter,publicUser};
