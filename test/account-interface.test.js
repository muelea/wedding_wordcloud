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
    <dialog id="mobile-canvas-dialog"><button data-account-save>Save</button><p data-account-save-note></p></dialog>
    <dialog id="account-auth-dialog">${markup}</dialog><dialog id="account-save-dialog"><form>
    <input name="name" required maxlength="80"><button type="submit">Save</button><button type="button" data-account-save-copy>Copy</button>
    <button type="button" data-account-save-existing>Choose existing</button><div data-account-save-targets hidden></div>
    <button type="button" data-account-open-latest hidden>Latest</button><p data-account-save-status></p></form></dialog>`,{url:'https://wolkenworte.io/e/abcdefghijklmnopqrstuv/configure'});
  t.after(()=>dom.window.close());const document=dom.window.document;
  dom.window.HTMLDialogElement.prototype.showModal=function(){this.open=true;};
  dom.window.HTMLDialogElement.prototype.close=function(){this.open=false;this.dispatchEvent(new dom.window.Event('close'));};
  let user={id:crypto.randomUUID(),recovery:false},snapshot={productKey:'p',designs:{front:[{id:'one',text:'Liebe'}],back:[]}},timer;
  const calls=[],navigation=[],accountChanges=[];let preserve=true,saved,ref=null,loseResponse=false,available=true,saveGate=null,designList=[],saveError=null;
  const root={addEventListener(){},CustomEvent:dom.window.CustomEvent,dispatchEvent:event=>accountChanges.push(event.detail.user),
    WolkenworteI18n:{t:(s,p={})=>s.replace(/\{\{(\w+)\}\}/g,(_,key)=>p[key]||''),getLocale:()=> 'de'}};
  const location={pathname:dom.window.location.pathname,search:'',assign:url=>navigation.push(url)};
  vm.runInNewContext(fs.readFileSync('public/js/account.js','utf8'),{window:root,document,location,
    history:{replaceState(){}},crypto,FormData:dom.window.FormData,URLSearchParams,Intl,AbortSignal,
    setTimeout:fn=>{timer=fn;return 1;},clearTimeout(){},
    fetch:async(url,options)=>{const body=options.body?JSON.parse(options.body):null;calls.push({url,body});
      let data;if(url.endsWith('/session'))data={user};else if(url.endsWith('/google'))data={url:'https://accounts.google.com/test'};
      else if(url.endsWith('/designs')&&!body)data={designs:designList};
      else if(url.endsWith('/designs')){if(saveGate)await saveGate;if(saveError)return {ok:false,status:409,json:async()=>({error:saveError})};saved={id:body.designId,name:body.name,version:body.version+1,expiresAt:'2027-01-12T00:00:00Z'};data={design:saved};
        if(loseResponse){loseResponse=false;throw new TypeError('Lost response');}}
      else if(url.endsWith('/load'))data={design:{...saved,snapshot}};else data={ok:true};
      return {ok:true,status:200,json:async()=>data};}});
  const controller=root.WolkenworteAccount.createConfigurator({getSnapshot:()=>snapshot,getFingerprint:()=>JSON.stringify(snapshot),
    canSave:()=>available,prepare:async()=>{},preserve:async()=>preserve,onSourceChange:value=>{ref=value;}});
  return {document,dom,calls,navigation,accountChanges,controller,setUser:v=>{user=v;},setPreserve:v=>{preserve=v;},
    setAvailable:v=>{available=v;},holdSave:v=>{saveGate=v;},setSnapshot:v=>{snapshot=v;},setDesigns:v=>{designList=v;},setSaveError:v=>{saveError=v;},loseNextResponse:()=>{loseResponse=true;},snapshot:()=>snapshot,flush:()=>timer?.(),source:()=>ref,user:()=>user};
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
  assert.equal(h.document.querySelector('[data-account-save]').disabled,false);
  assert.equal(h.document.querySelector('[data-account-save-note]').textContent,'');
  assert.equal(h.calls.filter(c=>c.body?.snapshot).length,1);
});
test('signing in through the configurator publishes the new identity for the global account menu',async t=>{
  const h=setup(t);h.setUser(null);
  h.document.querySelector('[data-account-save]').click();await settled();
  assert.equal(h.accountChanges.at(-1),null);
  const user={id:crypto.randomUUID(),email:'designer@example.invalid'};h.setUser(user);
  const form=h.document.querySelector('[data-auth-form]');form.elements.email.value=user.email;form.elements.password.value='fixture-password';
  form.dispatchEvent(new h.dom.window.Event('submit',{cancelable:true}));await settled();
  assert.deepEqual(h.accountChanges.at(-1),user);
  assert.equal(h.document.getElementById('account-save-dialog').open,true);
  assert.equal(h.calls.some(call=>call.body?.snapshot),false);
});
test('canvas save shares availability and feedback while its workspace stays open', async t=>{
  const h=setup(t),canvas=h.document.getElementById('mobile-canvas-dialog');canvas.showModal();
  const buttons=[...h.document.querySelectorAll('[data-account-save]')];
  buttons[1].click();await settled();
  assert.equal(canvas.open,true);assert.equal(h.document.getElementById('account-save-dialog').open,true);
  h.document.getElementById('account-save-dialog').close();await settled();
  assert.equal(canvas.open,true);assert.equal(h.calls.filter(c=>c.body?.snapshot).length,0);
  buttons[1].click();await settled();
  h.document.querySelector('#account-save-dialog form').dispatchEvent(new h.dom.window.Event('submit'));await settled();
  assert.equal(canvas.open,true);assert.ok(buttons.every(button=>button.disabled));
  assert.ok([...h.document.querySelectorAll('[data-account-save-note]')].every(note=>note.textContent==='In deinen Designs gespeichert.'));
  h.setSnapshot({...h.snapshot(),theme:'changed'});h.controller.changed();
  assert.ok(buttons.every(button=>!button.disabled));
  h.flush();
  assert.ok([...h.document.querySelectorAll('[data-account-save-note]')].every(note=>!note.textContent));
});
test('a copy is a separate explicit save and a different account cannot save an already opened private design',async t=>{
  const h=setup(t);h.document.querySelector('[data-account-save]').click();await settled();
  const form=h.document.querySelector('#account-save-dialog form');form.dispatchEvent(new h.dom.window.Event('submit'));await settled();const first=h.source().id;
  h.setSnapshot({...h.snapshot(),theme:'copy'});h.controller.changed();
  h.document.querySelector('[data-account-save]').click();await settled();h.document.querySelector('[data-account-save-copy]').click();await settled();
  assert.notEqual(h.source().id,first);assert.equal(h.calls.filter(c=>c.body?.snapshot)[1].body.version,0);
  const other={id:crypto.randomUUID()};h.setUser(other);h.setSnapshot({...h.snapshot(),theme:'other'});h.controller.changed();h.document.querySelector('[data-account-save]').click();await settled();
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
      if(node.nodeName==='#text'){const value=node.value.replace(/\s+/g,' ').trim();if(value&&!/^[.·×]$/.test(value))labels.add(value);}
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

test('save availability follows saved content, Undo, workspace readiness and restore without autosaving',async t=>{
  const h=setup(t),button=h.document.querySelector('[data-account-save]'),original=structuredClone(h.snapshot());
  assert.equal(button.disabled,false,'new designs can be saved');
  button.click();await settled();
  h.document.querySelector('#account-save-dialog form').dispatchEvent(new h.dom.window.Event('submit'));await settled();
  assert.equal(button.disabled,true,'successful save disables update');
  h.controller.changed();assert.equal(button.disabled,true,'view-only refreshes do not dirty the saved content');
  h.setSnapshot({...original,theme:'changed'});h.controller.changed();assert.equal(button.disabled,false);
  h.setAvailable(false);h.controller.changed();assert.equal(button.disabled,true,'unavailable workspace still blocks saving');
  h.setAvailable(true);h.controller.changed();assert.equal(button.disabled,false);
  h.setSnapshot(original);h.controller.changed();assert.equal(button.disabled,true,'Undo to the saved snapshot disables update');
  h.controller.restored();assert.equal(button.disabled,true,'loading a saved design starts clean');
  h.controller.detach();assert.equal(button.disabled,false,'an independent new design can be saved');
  assert.equal(h.calls.filter(c=>c.body?.snapshot).length,1);
});
test('edits during an in-flight manual save remain unsaved and enable update after completion',async t=>{
  const h=setup(t),button=h.document.querySelector('[data-account-save]');
  button.click();await settled();
  let release;h.holdSave(new Promise(resolve=>{release=resolve;}));
  h.document.querySelector('#account-save-dialog form').dispatchEvent(new h.dom.window.Event('submit'));await settled();
  assert.equal(button.disabled,true);assert.equal(button.getAttribute('aria-busy'),'true');
  h.setSnapshot({...h.snapshot(),theme:'edited-during-request'});h.controller.changed();assert.equal(button.disabled,true);
  release();await settled();assert.equal(button.disabled,false);assert.equal(button.getAttribute('aria-busy'),'false');
  assert.equal(h.calls.filter(c=>c.body?.snapshot).length,1);
});

test('account restoration detects newer saves and distinguishes clean old copies from conflicting edits',async t=>{
  const h=setup(t),button=h.document.querySelector('[data-account-save]'),form=h.document.querySelector('#account-save-dialog form');
  button.click();await settled();form.dispatchEvent(new h.dom.window.Event('submit'));await settled();
  const old=structuredClone(h.source());
  h.setSnapshot({...h.snapshot(),theme:'new server version'});h.controller.changed();
  button.click();await settled();form.dispatchEvent(new h.dom.window.Event('submit'));await settled();
  assert.equal(h.source().version,2);
  assert.equal(await h.controller.validateLocal(old),false);
  const clean=await h.controller.inspectLocal(old,old.fingerprint);
  assert.equal(clean.status,'newer');assert.equal(clean.snapshot.theme,'new server version');
  const conflict=await h.controller.inspectLocal(old,'different local artwork');
  assert.equal(conflict.status,'conflict');assert.equal(h.source().version,2);
  const other={...old,ownerId:crypto.randomUUID()};
  const reads=h.calls.filter(call=>call.url.endsWith('/load')).length;
  await assert.rejects(h.controller.inspectLocal(other,'edited'),error=>error.code==='account_unauthorized');
  assert.equal(h.calls.filter(call=>call.url.endsWith('/load')).length,reads);
});

test('an account commit remains successful when browser recovery fails, and later edits stay pending',async t=>{
  const h=setup(t),button=h.document.querySelector('[data-account-save]');
  h.setPreserve(false);button.click();await settled();
  h.document.querySelector('#account-save-dialog form').dispatchEvent(new h.dom.window.Event('submit'));await settled();
  assert.equal(h.source().version,1);
  assert.match(h.document.querySelector('[data-account-save-note]').textContent,/Im Konto gespeichert/);
  assert.equal(h.document.getElementById('account-save-dialog').open,false);
  h.setSnapshot({...h.snapshot(),theme:'changed after commit'});h.controller.changed();
  assert.equal(button.disabled,false);
});

test('an existing library destination changes only after an explicit versioned save',async t=>{
  const h=setup(t),target={id:crypto.randomUUID(),name:'Existing design',version:8};
  h.setDesigns([target]);
  const button=h.document.querySelector('[data-account-save]'),dialog=h.document.getElementById('account-save-dialog');
  const choose=async()=>{
    h.document.querySelector('[data-account-save-existing]').click();await settled();
    h.document.querySelector('[data-account-save-targets] button').click();await settled();
  };
  button.click();await settled();await choose();
  assert.equal(h.source(),null);assert.equal(h.calls.filter(call=>call.body?.snapshot).length,0);
  dialog.close();button.click();await settled();
  assert.equal(h.source(),null,'cancelling never connects the purchase copy to the library');
  await choose();h.document.querySelector('#account-save-dialog form').dispatchEvent(new h.dom.window.Event('submit'));await settled();
  const write=h.calls.find(call=>call.body?.snapshot);
  assert.equal(write.body.designId,target.id);assert.equal(write.body.version,8);
  assert.equal(h.source().id,target.id);assert.equal(h.source().version,9);
});

test('opening the latest library version after a save conflict preserves local work first',async t=>{
  const h=setup(t),target={id:crypto.randomUUID(),name:'Existing design',version:2};
  h.setDesigns([target]);h.document.querySelector('[data-account-save]').click();await settled();
  h.document.querySelector('[data-account-save-existing]').click();await settled();
  h.document.querySelector('[data-account-save-targets] button').click();h.setSaveError('design_conflict');
  h.document.querySelector('#account-save-dialog form').dispatchEvent(new h.dom.window.Event('submit'));await settled();
  const latest=h.document.querySelector('[data-account-open-latest]');assert.equal(latest.hidden,false);
  assert.equal(h.source(),null,'conflicts do not accept the attempted destination');
  h.setPreserve(false);latest.click();await settled();assert.equal(h.navigation.length,0);
  h.setPreserve(true);latest.click();await settled();
  assert.equal(h.navigation[0],`${h.dom.window.location.pathname}?accountDesign=${target.id}&accountLatest=1`);
});
