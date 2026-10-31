'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const vm=require('node:vm');
const ejs=require('ejs');
const {JSDOM}=require('jsdom');
const I18n=require('../src/i18n');
const slug='AbCdEfGhIjKlMnOpQrStUQ';
const owner={id:'41139ef6-90f5-400d-bac5-8b7365f88428',email:'guest@bookmark.invalid'};
const settle=async()=>{for(let n=0;n<25;n++)await new Promise(resolve=>setImmediate(resolve));};
function mount(t,{user=owner,saved=false,search='',saveError=null,intent=null}={}){
  const filename=path.resolve('views/partials/cloud-bookmark-auth.ejs');
  const html=`<details data-ww-site-menu open><button data-cloud-bookmark>Save</button><a data-cloud-bookmark-saved href="/konto#wortwolken" hidden>Saved</a><p data-cloud-bookmark-status hidden></p></details>`+
    ejs.render(fs.readFileSync(filename,'utf8'),{t:source=>I18n.translate(source,'en')},{filename});
  const dom=new JSDOM(html,{url:`https://wolkenworte.invalid/e/${slug}${search}`});t.after(()=>dom.window.close());
  const document=dom.window.document,calls=[],navigation=[],replacements=[];
  if(intent)dom.window.sessionStorage.setItem(`wolkenworte-cloud-save:${slug}`,intent);
  Object.defineProperty(document,'readyState',{value:'complete'});
  dom.window.WolkenworteI18n={getLocale:()=> 'en',ready:async()=>{},setText:(node,source,params)=>{node.textContent=I18n.translate(source,'en',params);}};
  dom.window.HTMLDialogElement.prototype.showModal=function(){this.open=true;};
  dom.window.HTMLDialogElement.prototype.close=function(){this.open=false;this.dispatchEvent(new dom.window.Event('close'));};
  const context={window:dom.window,document,location:{pathname:`/e/${slug}`,search,hash:'',assign:url=>navigation.push(url)},
    history:{replaceState:(_state,_unused,url)=>replacements.push(url)},URLSearchParams,FormData:dom.window.FormData,Intl,AbortSignal,
    setTimeout:dom.window.setTimeout.bind(dom.window),clearTimeout:dom.window.clearTimeout.bind(dom.window),
    fetch:async(url,options={})=>{
      const body=options.body?JSON.parse(options.body):undefined;calls.push({url,options,body});let data={},status=200;
      if(url.endsWith('/session'))data={user};
      else if(url.endsWith(`/clouds/${slug}`))data={cloud:saved?{id:'saved'}:null};
      else if(url.endsWith('/clouds')){
        if(saveError){status=saveError.status||503;data={error:saveError.code};}
        else{saved=true;data={cloud:{id:'saved'}};}
      }else if(url.endsWith('/login')||url.endsWith('/verify')||url.endsWith('/password')){user=owner;data={ok:true};}
      else if(url.endsWith('/google'))data={url:'https://accounts.example.invalid/authorize'};
      else data={sent:true};
      return{ok:status<400,status,json:async()=>data};
    }};
  vm.runInNewContext(fs.readFileSync('public/js/cloud-bookmarks.js','utf8'),context);
  vm.runInNewContext(fs.readFileSync('public/js/account.js','utf8'),context);
  return{dom,document,calls,navigation,replacements,setError:value=>{saveError=value;},setUser:value=>{user=value;},saved:()=>saved};
}

test('a signed-in guest saves once; opening the page and an existing bookmark perform no writes',async t=>{
  const h=mount(t);await settle();
  assert.equal(h.calls.some(c=>c.body),false);
  const button=h.document.querySelector('[data-cloud-bookmark]');button.click();button.click();await settle();
  const saves=h.calls.filter(c=>c.url.endsWith('/clouds'));
  assert.equal(saves.length,1);assert.deepEqual(saves[0].body,{slug,ownerId:owner.id});
  assert.equal(saves[0].options.headers['X-Wolkenworte-Account'],'1');
  assert.equal(button.hidden,true);assert.equal(h.document.querySelector('[data-cloud-bookmark-saved]').hidden,false);
  assert.equal(h.document.querySelector('[data-cloud-bookmark-feedback]').hidden,false);
  const existing=mount(t,{saved:true});await settle();
  assert.equal(existing.document.querySelector('[data-cloud-bookmark]').hidden,true);
  assert.equal(existing.calls.some(c=>c.body),false);
});

test('closing sign-in cancels saving; completing email login resumes the exact bookmark',async t=>{
  const h=mount(t,{user:null});await settle();const button=h.document.querySelector('[data-cloud-bookmark]');
  button.click();await settle();const dialog=h.document.getElementById('cloud-bookmark-auth');
  assert.equal(dialog.open,true);assert.equal(h.document.querySelector('[data-ww-site-menu]').open,false);
  h.document.querySelector('[data-cloud-auth-close]').click();assert.equal(dialog.open,false);assert.equal(h.saved(),false);
  button.click();await settle();
  const form=h.document.querySelector('[data-auth-form]');form.elements.email.value=owner.email;form.elements.password.value='a fixture password';
  form.dispatchEvent(new h.dom.window.Event('submit'));await settle();
  assert.equal(dialog.open,false);assert.equal(h.saved(),true);
  assert.equal(h.calls.filter(c=>c.url.endsWith('/clouds')).length,1);
  assert.equal(h.navigation.length,0);
});

test('registration saves only after code verification',async t=>{
  const h=mount(t,{user:null});await settle();h.document.querySelector('[data-cloud-bookmark]').click();await settle();
  h.document.querySelector('[data-auth-mode="signup"]').click();
  const form=h.document.querySelector('[data-auth-form]');form.elements.email.value=owner.email;form.elements.password.value='a fixture password';
  form.dispatchEvent(new h.dom.window.Event('submit'));await settle();assert.equal(h.saved(),false);
  const code=h.document.querySelector('[data-auth-code-form]');code.elements.code.value='123456';
  code.dispatchEvent(new h.dom.window.Event('submit'));await settle();assert.equal(h.saved(),true);
});

test('Google sign-in preserves its save intent and return completes it without retaining the query marker',async t=>{
  const h=mount(t,{user:null});await settle();h.document.querySelector('[data-cloud-bookmark]').click();await settle();
  h.document.querySelector('[data-auth-google]').click();await settle();
  const returnTo=h.calls.find(c=>c.url.endsWith('/google')).body.returnTo;
  assert.ok(returnTo.startsWith(`/e/${slug}?cloudSave=`));
  assert.equal(h.saved(),false);assert.deepEqual(h.navigation,['https://accounts.example.invalid/authorize']);
  const token=new URLSearchParams(returnTo.split('?')[1]).get('cloudSave');
  const returned=mount(t,{search:`?lang=en&cloudSave=${token}`,intent:h.dom.window.sessionStorage.getItem(`wolkenworte-cloud-save:${slug}`)});await settle();
  assert.equal(returned.saved(),true);assert.deepEqual(returned.replacements,[`/e/${slug}?lang=en`]);
  assert.equal(returned.calls.filter(c=>c.url.endsWith('/clouds')).length,1);
});

test('failed writes remain retryable and unavailable-cloud feedback never claims a successful save',async t=>{
  const h=mount(t,{saveError:{code:'cloud_not_found',status:404}});await settle();
  const button=h.document.querySelector('[data-cloud-bookmark]');button.click();await settle();
  assert.equal(button.disabled,false);assert.equal(button.hidden,false);assert.equal(h.saved(),false);
  assert.match(h.document.querySelector('[data-cloud-bookmark-feedback]').textContent,/no longer available/i);
  h.setError(null);button.click();await settle();assert.equal(h.saved(),true);
});


test('a crafted or expired return marker cannot silently save a cloud',async t=>{
  for(const intent of [null,JSON.stringify({token:'untrusted',expiresAt:Date.now()-1000})]){
    const h=mount(t,{search:'?cloudSave=untrusted',intent});await settle();
    assert.equal(h.saved(),false);assert.equal(h.calls.some(c=>c.body),false);
    assert.deepEqual(h.replacements,[`/e/${slug}`]);
  }
});
