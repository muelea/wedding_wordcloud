'use strict';

const crypto=require('node:crypto');
const express=require('express');
const {Resend}=require('resend');
const db=require('./db');
const {SELLER}=require('./emailTemplates');
const {normalizeLocale}=require('./i18n');
const {emailAddress}=require('./accountAuth');
const {asyncRoute}=require('./asyncRoute');
let testAdapter=null;

const COPY={
  de:{titles:['E-Mail-Adresse bestätigen','Passwort zurücksetzen','E-Mail-Adresse ändern','Änderung bestätigen','Passwort geändert','E-Mail-Adresse geändert','Bei Wolkenworte anmelden'],
    code:'Gib diesen Code bei Wolkenworte ein:',expires:'Der Code ist 10 Minuten gültig. Gib ihn nicht an andere weiter.',
    ignore:'Falls du dies nicht angefordert hast, bestätige es nicht.',changed:'Deine Kontodaten wurden geändert. Falls du das nicht warst, kontaktiere uns sofort.',help:'Bei Fragen'},
  en:{titles:['Confirm your email address','Reset your password','Change your email address','Confirm this change','Password changed','Email address changed','Sign in to Wolkenworte'],
    code:'Enter this code at Wolkenworte:',expires:'This code expires in 10 minutes. Do not share it.',ignore:'If you did not request this, do not confirm it.',changed:'Your account details were changed. If this was not you, contact us immediately.',help:'Questions'},
  fr:{titles:['Confirmer votre adresse e-mail','Réinitialiser votre mot de passe','Modifier votre adresse e-mail','Confirmer cette modification','Mot de passe modifié','Adresse e-mail modifiée','Se connecter à Wolkenworte'],
    code:'Saisissez ce code sur Wolkenworte :',expires:'Ce code expire dans 10 minutes. Ne le partagez pas.',ignore:'Si vous ne l’avez pas demandé, ne confirmez pas.',changed:'Les informations de votre compte ont été modifiées. Si ce n’était pas vous, contactez-nous immédiatement.',help:'Des questions'},
  it:{titles:['Conferma il tuo indirizzo e-mail','Reimposta la password','Modifica il tuo indirizzo e-mail','Conferma questa modifica','Password modificata','Indirizzo e-mail modificato','Accedi a Wolkenworte'],
    code:'Inserisci questo codice su Wolkenworte:',expires:'Il codice scade tra 10 minuti. Non condividerlo.',ignore:'Se non hai richiesto questa operazione, non confermarla.',changed:'I dati del tuo account sono stati modificati. Se non sei stato tu, contattaci subito.',help:'Domande'},
  es:{titles:['Confirma tu dirección de correo','Restablece tu contraseña','Cambia tu dirección de correo','Confirma este cambio','Contraseña cambiada','Dirección de correo cambiada','Inicia sesión en Wolkenworte'],
    code:'Introduce este código en Wolkenworte:',expires:'El código caduca en 10 minutos. No lo compartas.',ignore:'Si no lo has solicitado, no lo confirmes.',changed:'Los datos de tu cuenta se han modificado. Si no has sido tú, contacta con nosotros inmediatamente.',help:'¿Tienes preguntas?'},
  tr:{titles:['E-posta adresini doğrula','Parolanı sıfırla','E-posta adresini değiştir','Bu değişikliği doğrula','Parola değiştirildi','E-posta adresi değiştirildi','Wolkenworte’ye giriş yap'],
    code:'Bu kodu Wolkenworte’de gir:',expires:'Kod 10 dakika geçerlidir. Kimseyle paylaşma.',ignore:'Bu işlemi sen istemediysen doğrulama.',changed:'Hesap bilgilerin değiştirildi. Bu işlemi sen yapmadıysan hemen bizimle iletişime geç.',help:'Soruların için'},
};
const TYPES={signup:0,invite:0,recovery:1,email_change:2,reauthentication:3,password_changed_notification:4,
  email_changed_notification:5,magiclink:6};
const escape=value=>String(value).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));

function signingKey() {
  const value=String(process.env.AUTH_EMAIL_HOOK_SECRET||'').replace(/^(?:v1,)?whsec_/,'');
  const bytes=Buffer.from(value,'base64');
  if(bytes.length!==32||bytes.toString('base64')!==value) throw db.accountError('auth_email_unconfigured',503);
  return bytes;
}

function verify(raw,headers,now=Date.now()) {
  if(!Buffer.isBuffer(raw)) throw db.accountError('invalid_signature',400);
  const id=headers['webhook-id']; const timestamp=headers['webhook-timestamp']; const signatures=headers['webhook-signature'];
  if(typeof id!=='string'||! /^[A-Za-z0-9_-]{1,120}$/.test(id)||typeof timestamp!=='string'||!/^\d{1,12}$/.test(timestamp)||
    Math.abs(now/1000-Number(timestamp))>300||typeof signatures!=='string'||signatures.length>2000) throw db.accountError('invalid_signature',400);
  const expected=crypto.createHmac('sha256',signingKey()).update(`${id}.${timestamp}.`).update(raw).digest();
  const valid=signatures.split(' ').some(value=> {
    const [version,signature]=value.split(','); if(version!=='v1'||!signature) return false;
    const bytes=Buffer.from(signature,'base64');
    return bytes.length===expected.length&&crypto.timingSafeEqual(bytes,expected);
  });
  if(!valid) throw db.accountError('invalid_signature',400);
  return {id,payload:JSON.parse(raw.toString()),payloadHash:crypto.createHmac('sha256',signingKey()).update(raw).digest('hex')};
}

function messages(payload,id) {
  const user=payload.user, data=payload.email_data;
  const type=data?.email_action_type;
  if(!user||!Object.hasOwn(TYPES,type)) throw db.accountError('invalid_auth_email',400);
  const locale=normalizeLocale(user.user_metadata?.language);
  const copy=COPY[locale]; const title=copy.titles[TYPES[type]];
  const destinations=type==='email_change'
    ? [[emailAddress(user.email),data.token,'current'],[emailAddress(user.new_email),data.token_new,'new']]
    : [[emailAddress(type==='email_changed_notification'?data.old_email:user.email),TYPES[type]<4||type==='magiclink'?data.token:null,'primary']];
  return destinations.map(([to,token,suffix])=> {
    if(token!==null&&!/^\d{6}$/.test(token||'')) throw db.accountError('invalid_auth_email',400);
    const paragraphs=token?[copy.code,token,copy.expires,copy.ignore]:[copy.changed];
    const text=['Wolkenworte',title,...paragraphs,`${copy.help}: ${SELLER.email}`].join('\n\n');
    const html=`<div lang="${locale}" style="font-family:Arial,sans-serif;color:#400f26;line-height:1.6;max-width:480px;margin:24px auto;padding:24px"><p style="font-weight:bold">Wolkenworte</p><h2>${escape(title)}</h2>`+
      paragraphs.map(p=>`<p${p===token?' style="font-size:32px;font-weight:bold;letter-spacing:6px"':''}>${escape(p)}</p>`).join('')+
      `<p style="font-size:13px">${escape(copy.help)}: <a href="mailto:${SELLER.email}">${SELLER.email}</a></p></div>`;
    return {payload:{from:process.env.AUTH_RESEND_FROM_EMAIL||'Wolkenworte <konto@mail.wolkenworte.io>',to:[to],
      replyTo:SELLER.email,subject:`${title} · Wolkenworte`,html,text},
      idempotencyKey:`auth:${crypto.createHash('sha256').update(id).digest('hex')}:${suffix}`};
  });
}

async function deliver(message) {
  // Operator SMTP smoke is separate. Automated tests can never send real Auth mail.
  if(process.env.NODE_ENV==='test') { if(testAdapter) await testAdapter(message); return; }
  if(process.env.AUTH_EMAIL_DELIVERY_MODE!=='live'||!process.env.RESEND_API_KEY) throw db.accountError('auth_email_unconfigured',503);
  const result=await new Resend(process.env.RESEND_API_KEY).emails.send(message.payload,{
    idempotencyKey:message.idempotencyKey,signal:AbortSignal.timeout(1800)});
  if(result.error||!result.data?.id) throw db.accountError('auth_email_unavailable',503);
}

function makeAuthEmailRouter() {
  const router=express.Router();
  router.post('/',express.raw({type:'application/json',limit:'64kb'}),asyncRoute(async(req,res)=> {
    res.set('Cache-Control','no-store');
    try {
      const checked=verify(req.body,req.headers);
      const emails=messages(checked.payload,checked.id);
      const hash=crypto.createHash('sha256').update(checked.id).digest('hex');
      const receipt=await db.recordAuthEmailReceipt(hash,checked.payloadHash);
      if(!receipt.delivered) {
        for(const email of emails) await deliver(email);
        await db.recordAuthEmailReceipt(hash,checked.payloadHash,true);
      }
      return res.json({});
    } catch(error) {
      return res.status(error.status||503).json({error:{http_code:error.status||503,message:'Auth email unavailable'}});
    }
  }));
  return router;
}

function setAdapterForTests(adapter) { if(process.env.NODE_ENV!=='test') throw new Error('Test-only Auth email adapter'); testAdapter=adapter; }
module.exports={COPY,TYPES,verify,messages,makeAuthEmailRouter,setAdapterForTests};
