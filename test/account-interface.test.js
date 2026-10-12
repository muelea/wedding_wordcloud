'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const vm=require('node:vm');
const crypto=require('node:crypto');
const ejs=require('ejs');
const {JSDOM}=require('jsdom');
const Session=require('../public/js/configurator-session');
const parse5=require('parse5');
const tick=()=>new Promise(resolve=>setImmediate(resolve));
async function settled(){for(let i=0;i<12;i++)await tick();}
function setup(t) {
  const markup=ejs.render(fs.readFileSync('views/partials/account-auth.ejs','utf8'));
  const dom=new JSDOM(`<button data-account-save>Save</button><p data-account-save-note></p>
    <dialog id="account-auth-dialog">${markup}</dialog><dialog id="account-save-dialog"><form>
    <input name="name" required maxlength="80"><button type="submit">Save</button><button type="button" data-account-save-copy>Copy</button><p data-account-save-status></p></form></dialog>`,{url:'https://wolkenworte.io/e/abcdefghijklmnopqrstuv/configure'});
  t.after(()=>dom.window.close());const document=dom.window.document;
  dom.window.HTMLDialogElement.prototype.showModal=function(){this.open=true;};
  dom.window.HTMLDialogElement.prototype.close=function(){this.open=false;this.dispatchEvent(new dom.window.Event('close'));};
  let user={id:crypto.randomUUID(),recovery:false},snapshot={productKey:'p',designs:{front:[{id:'one',text:'Liebe'}],back:[]}},timer;
  const calls=[],navigation=[];let preserve=true,saved,ref=null,loseResponse=false;
  const root={addEventListener(){},WolkenworteI18n:{t:(s,p={})=>s.replace(/\{\{(\w+)\}\}/g,(_,key)=>p[key]||''),getLocale:()=> 'de'}};
  const location={pathname:dom.window.location.pathname,search:'',assign:url=>navigation.push(url)};
  vm.runInNewContext(fs.readFileSync('public/js/account.js','utf8'),{window:root,document,location,
    history:{replaceState(){}},crypto,FormData:dom.window.FormData,URLSearchParams,Intl,AbortSignal,
    setTimeout:fn=>{timer=fn;return 1;},clearTimeout(){},
    fetch:async(url,options)=>{const body=options.body?JSON.parse(options.body):null;calls.push({url,body});
      let data;if(url.endsWith('/session'))data={user};else if(url.endsWith('/google'))data={url:'https://accounts.google.com/test'};
      else if(url.endsWith('/designs')){saved={id:body.designId,name:body.name,version:body.version+1,expiresAt:'2027-01-12T00:00:00Z'};data={design:saved};
        if(loseResponse){loseResponse=false;throw new TypeError('Lost response');}}
      else if(url.endsWith('/load'))data={design:{...saved,snapshot}};else data={ok:true};
      return {ok:true,status:200,json:async()=>data};}});
  const controller=root.WolkenworteAccount.createConfigurator({getSnapshot:()=>snapshot,getFingerprint:()=>JSON.stringify(snapshot),
    prepare:async()=>{},preserve:async()=>preserve,onSourceChange:value=>{ref=value;}});
  return {document,dom,calls,navigation,controller,setUser:v=>{user=v;},setPreserve:v=>{preserve=v;},
    setSnapshot:v=>{snapshot=v;},loseNextResponse:()=>{loseResponse=true;},snapshot:()=>snapshot,flush:()=>timer?.(),source:()=>ref,user:()=>user};
}
test('edits never autosave to the account; only an explicit submit saves the full editable snapshot',async t=>{
  const h=setup(t);h.controller.changed();h.flush();assert.equal(h.calls.length,0);
  h.document.querySelector('[data-account-save]').click();await settled();
  assert.equal(h.document.getElementById('account-save-dialog').open,true);
  assert.equal(h.calls.filter(c=>c.body?.snapshot).length,0);
  const form=h.document.querySelector('#account-save-dialog form');form.dispatchEvent(new h.dom.window.Event('submit',{cancelable:true}));await settled();
  const save=h.calls.find(c=>c.body?.snapshot);assert.deepEqual(save.body.snapshot,h.snapshot());assert.equal(save.body.version,0);
  assert.ok(h.source().id);assert.equal(h.source().ownerId,h.user().id);
  h.setSnapshot({...h.snapshot(),theme:'changed'});h.controller.changed();h.flush();
  assert.match(h.document.querySelector('[data-account-save-note]').textContent,/noch nicht/);
  assert.equal(h.calls.filter(c=>c.body?.snapshot).length,1);
});
test('a copy is a separate explicit save and a different account cannot save an already opened private design',async t=>{
  const h=setup(t);h.document.querySelector('[data-account-save]').click();await settled();
  const form=h.document.querySelector('#account-save-dialog form');form.dispatchEvent(new h.dom.window.Event('submit'));await settled();const first=h.source().id;
  h.document.querySelector('[data-account-save]').click();await settled();h.document.querySelector('[data-account-save-copy]').click();await settled();
  assert.notEqual(h.source().id,first);assert.equal(h.calls.filter(c=>c.body?.snapshot)[1].body.version,0);
  const other={id:crypto.randomUUID()};h.setUser(other);h.document.querySelector('[data-account-save]').click();await settled();
  assert.equal(h.document.getElementById('account-save-dialog').open,false);
  assert.equal(h.calls.filter(c=>c.body?.snapshot).length,2);
});
test('retrying a save with a lost response reuses its idempotency and design IDs',async t=>{
  const h=setup(t);h.document.querySelector('[data-account-save]').click();await settled();h.loseNextResponse();
  const form=h.document.querySelector('#account-save-dialog form');form.dispatchEvent(new h.dom.window.Event('submit'));await settled();
  assert.equal(h.document.getElementById('account-save-dialog').open,true);
  form.dispatchEvent(new h.dom.window.Event('submit'));await settled();
  const writes=h.calls.filter(c=>c.body?.snapshot);assert.equal(writes.length,2);
  assert.equal(writes[0].body.requestId,writes[1].body.requestId);assert.equal(writes[0].body.designId,writes[1].body.designId);
});
test('Google redirection is blocked when the current browser draft cannot be preserved',async t=>{
  const h=setup(t);h.setUser(null);h.setPreserve(false);h.document.querySelector('[data-account-save]').click();await settled();
  h.document.querySelector('[data-auth-google]').click();await settled();assert.equal(h.navigation.length,0);
  assert.equal(h.calls.some(c=>c.url.endsWith('/google')),false);assert.match(h.document.querySelector('[data-auth-status]').textContent,/Browser/);
});
test('account fingerprints include retained product layouts and image bytes; the cart fingerprint contract stays independent',()=>{
  const snapshot={productKey:'p',orientation:'default',theme:'pastel',words:[],designs:{default:[]},productDesignState:{version:1,surfaces:[],layouts:[]}};
  const changed={...snapshot,productDesignState:{version:1,surfaces:[{area:{x:0,y:0,width:100,height:100},design:[{id:'x',type:'image',src:'data:image/png;base64,new'}]}],layouts:[]}};
  assert.notEqual(Session.accountDesignFingerprint(snapshot),Session.accountDesignFingerprint(changed));
});
test('every account page label has a translation in each supported catalog',()=>{
  const labels=new Set();
  for(const file of ['views/account.ejs','views/partials/account-auth.ejs']){
    const doc=parse5.parse(fs.readFileSync(file,'utf8').replace(/<%[\s\S]*?%>/g,''));
    function walk(node){
      if(node.nodeName==='#text'){const value=node.value.replace(/\s+/g,' ').trim();if(value&&value!=='.'&&value!=='×')labels.add(value);}
      for(const attribute of node.attrs||[])if(['aria-label','title'].includes(attribute.name))labels.add(attribute.value);
      for(const child of node.childNodes||[])walk(child);
    }
    walk(doc);
  }
  for(const locale of ['en','fr','it','es','tr']) {
    const catalog=require(`../public/locales/${locale}.json`);
    for(const label of labels)assert.ok(catalog[label],`${locale}: ${label}`);
  }
});
