'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const ejs = require('ejs');
const {JSDOM} = require('jsdom');
const runtime = fs.readFileSync('public/js/site-header.js', 'utf8');
const settle = () => new Promise(resolve => setTimeout(resolve, 5));
function render(variant, enabled=true) {
  return ejs.render(fs.readFileSync('views/partials/site-header.ejs','utf8'), {
    header:{variant,mobileMenu:true,mobileBackId:'mobile-back-link',backHref:'/previous',paletteOptions:[{key:'warm',label:'Warm',colors:['#ff0000']}]},
    designAccountsEnabled:enabled,analyticsMeasurementId:'',asset:x=>x,t:x=>x,locale:'de',
    languages:[{code:'de',name:'Deutsch',flag:'🇩🇪',href:'?lang=de'}],
  },{filename:'views/partials/site-header.ejs'});
}
function mount(t,variant='landing',floating=false,{user=null,deferredSession=null,deferredLogout=null,failSession=false,failLogout=false,enabled=true}={}) {
  const dom=new JSDOM(render(variant,enabled),{url:'https://wolkenworte.invalid'});
  t.after(()=>dom.window.close());const {document}=dom.window;
  const calls=[],navigation=[],cleared=[];
  dom.window.WolkenworteConfiguratorSession={clearAccountDrafts:async id=>{cleared.push(id);}};
  if(floating)for(const popup of document.querySelectorAll('[data-ww-menu-popup]')){
    let open=false;const matches=popup.matches.bind(popup);
    popup.showPopover=()=>{open=true;};popup.hidePopover=()=>{open=false;};
    popup.matches=selector=>selector===':popover-open'?open:matches(selector);
    Object.defineProperty(popup,'scrollHeight',{value:240});
    popup.getBoundingClientRect=()=>({height:Math.min(240,parseFloat(popup.style.maxHeight)||240)});
    popup.closest('details').querySelector('summary').getBoundingClientRect=()=>({left:800,right:936,top:180,bottom:224,width:136});
  }
  vm.runInNewContext(runtime,{window:dom.window,document,AbortSignal,location:{assign:url=>navigation.push(url)},
    fetch:async(url,options)=>{
      calls.push({url,options});
      if(failSession&&url.endsWith('/session'))throw new Error('Unavailable');
      if(deferredLogout&&url.endsWith('/logout'))await deferredLogout;
      const data=url.endsWith('/session')?(deferredSession?await deferredSession:{user}):{ok:true};
      return {ok:!(failLogout&&url.endsWith('/logout')),json:async()=>data};
    }});
  const menu=document.querySelector('[data-ww-site-menu]');
  return {dom,document,menu,trigger:menu.querySelector('summary'),calls,navigation,cleared,setUser:next=>{user=next;},setFailLogout:next=>{failLogout=next;}};
}
test('all page variants share navigation and preferences, with cloud controls in the display menu',t=>{
  const panels=[];
  for(const variant of ['landing','display','back','brand-only']){
    const h=mount(t,variant);
    const sectionLinks=h.menu.querySelector('.landing-menu-sections');
    assert.equal(Boolean(sectionLinks),variant==='landing');
    if(sectionLinks){assert.equal(sectionLinks.querySelectorAll('a').length,4);sectionLinks.remove();}
    panels.push([...h.menu.querySelector('.ww-site-menu-panel').children].filter(node=>!node.classList.contains('ww-site-menu-cloud')).map(node=>node.outerHTML).join('').replace(/>\s+</g,'><'));
    assert.equal(h.document.querySelectorAll('[data-ww-site-menu]').length,1);
    assert.equal(h.menu.querySelector('[data-account-menu]').getAttribute('href'),'/konto');
    assert.equal(h.menu.querySelectorAll('[data-language-picker]').length,1);
    assert.equal(h.menu.querySelectorAll('[data-ww-install]').length,1);
    assert.equal(Boolean(h.menu.querySelector('#display-palette-picker')),variant==='display');
    assert.equal(h.menu.querySelector('#mobile-back-link'),null);
    assert.equal(h.menu.querySelector('[data-account-menu-logout]').hidden,true);
  }
  assert.ok(panels.every(panel=>panel===panels[0]));
});
test('shared menu preserves inside interactions and closes on outside clicks and navigation',async t=>{
  const h=mount(t);h.menu.open=true;await settle();
  assert.equal(h.trigger.getAttribute('aria-expanded'),'true');
  h.menu.dispatchEvent(new h.dom.window.Event('pointerdown',{bubbles:true}));assert.equal(h.menu.open,true);
  h.document.body.dispatchEvent(new h.dom.window.Event('pointerdown',{bubbles:true}));assert.equal(h.menu.open,false);
  h.menu.open=true;await settle();
  const link=h.menu.querySelector('a');link.addEventListener('click',event=>event.preventDefault());link.click();
  assert.equal(h.menu.open,false);
  await settle();assert.equal(h.trigger.getAttribute('aria-expanded'),'false');
});
test('Escape respects nested language selection and dialogs, then returns focus to the menu trigger',async t=>{
  const h=mount(t),picker=h.menu.querySelector('[data-language-picker]');
  const escape=()=>h.document.dispatchEvent(new h.dom.window.KeyboardEvent('keydown',{key:'Escape',cancelable:true}));
  h.menu.open=true;picker.open=true;escape();assert.equal(h.menu.open,true);
  picker.open=false;const dialog=h.document.createElement('dialog');dialog.open=true;h.document.body.append(dialog);
  escape();assert.equal(h.menu.open,true);
  dialog.remove();escape();assert.equal(h.menu.open,false);assert.equal(h.document.activeElement,h.trigger);
  await settle();assert.equal(h.trigger.getAttribute('aria-label'),'Menü öffnen');
});
test('closing the shared cloud menu closes its nested palette and preserves presentation controls',async t=>{
  const h=mount(t,'display'),palette=h.menu.querySelector('#display-palette-picker');
  assert.equal(h.document.getElementById('display-page-menu'),null);
  assert.ok(h.menu.querySelector('#presentation-mode-button'));
  h.menu.open=true;palette.open=true;await settle();
  assert.equal(h.menu.open,true);
  h.document.dispatchEvent(new h.dom.window.KeyboardEvent('keydown',{key:'Escape',cancelable:true}));
  assert.equal(h.menu.open,true,'nested pickers handle Escape before the global menu');
  h.menu.open=false;await settle();assert.equal(palette.open,false);
});
test('mobile back navigation remains outside the sticky header',t=>{
  const h=mount(t,'back');
  assert.ok(h.document.getElementById('mobile-back-link'));
  assert.equal(h.document.querySelector('header #mobile-back-link'),null);
});
test('language and palette float independently, close with their menu and stay within the viewport',async t=>{
  const h=mount(t,'display',true),language=h.menu.querySelector('[data-language-picker]'),palette=h.menu.querySelector('#display-palette-picker');
  const list=language.querySelector('[data-ww-menu-popup]'),colours=palette.querySelector('[data-ww-menu-popup]');
  h.menu.open=true;language.open=true;await settle();
  assert.equal(list.getAttribute('popover'),'manual');assert.equal(list.matches(':popover-open'),true);
  assert.equal(list.style.top,'232px');assert.equal(list.style.left,'770px');assert.equal(list.style.width,'166px');
  palette.open=true;await settle();await settle();
  assert.equal(language.open,false);assert.equal(list.matches(':popover-open'),false);
  assert.equal(colours.matches(':popover-open'),true);assert.equal(colours.style.width,'224px');
  palette.querySelector('summary').getBoundingClientRect=()=>({left:800,right:936,top:650,bottom:694,width:136});
  h.dom.window.dispatchEvent(new h.dom.window.Event('resize'));
  assert.equal(colours.style.top,'402px','a picker near the bottom opens above its trigger');
  h.menu.open=false;await settle();await settle();
  assert.equal(palette.open,false);assert.equal(colours.matches(':popover-open'),false);
});
const accountUser={id:'41139ef6-90f5-400d-bac5-8b7365f88428',email:'designer@example.invalid'};
test('the global menu shows signed-in identity or Sign in, without exposing privileged actions to guests',async t=>{
  for(const user of [null,{...accountUser,recovery:true},accountUser]){
    const h=mount(t,'landing',false,{user});await settle();
    const signedIn=Boolean(user&&!user.recovery);
    assert.equal(h.menu.querySelector('[data-account-menu-label]').textContent,signedIn?'Mein Konto':'Anmelden');
    assert.equal(h.menu.querySelector('[data-account-menu-email]').hidden,!signedIn);
    assert.equal(h.menu.querySelector('[data-account-menu-email]').textContent,signedIn?accountUser.email:'');
    assert.equal(h.menu.querySelector('[data-account-menu-logout]').hidden,!signedIn);
    assert.equal(h.calls.length,1);assert.equal(h.calls[0].options.cache,'no-store');
  }
  const disabled=mount(t,'landing',false,{enabled:false});await settle();
  assert.equal(disabled.menu.querySelector('[data-account-menu-group]'),null);
  assert.equal(disabled.calls.length,0);
});
test('failed session reads keep the neutral account link usable instead of claiming the visitor is signed out',async t=>{
  const h=mount(t,'landing',false,{failSession:true});await settle();
  assert.equal(h.menu.querySelector('[data-account-menu-label]').textContent,'Mein Konto');
  assert.equal(h.menu.querySelector('[data-account-menu]').getAttribute('href'),'/konto');
  assert.equal(h.menu.querySelector('[data-account-menu-logout]').hidden,true);
});
test('concurrent session reads share one request and cannot overwrite a newer completed sign-in',async t=>{
  let finish;const deferredSession=new Promise(resolve=>{finish=resolve;});
  const h=mount(t,'landing',false,{deferredSession});
  const pending=h.dom.window.WolkenworteAccountMenu.session();
  assert.equal(h.calls.length,1);
  h.dom.window.dispatchEvent(new h.dom.window.CustomEvent('wolkenworte:accountchange',{detail:{user:accountUser}}));
  finish({user:null});await pending;
  assert.equal(h.menu.querySelector('[data-account-menu-email]').textContent,accountUser.email);
  assert.equal(h.menu.querySelector('[data-account-menu-logout]').hidden,false);
});
test('menu sign-out is guarded and deduplicated, clears only its owner drafts and fences stale session responses',async t=>{
  let finish;const deferredSession=new Promise(resolve=>{finish=resolve;});
  const h=mount(t,'landing',false,{deferredSession});
  h.dom.window.dispatchEvent(new h.dom.window.CustomEvent('wolkenworte:accountchange',{detail:{user:accountUser}}));
  const button=h.menu.querySelector('[data-account-menu-logout]');button.click();button.click();await settle();
  const writes=h.calls.filter(call=>call.url.endsWith('/logout'));
  assert.equal(writes.length,1);assert.equal(writes[0].options.method,'POST');
  assert.equal(writes[0].options.headers['X-Wolkenworte-Account'],'1');
  assert.equal(writes[0].options.credentials,'same-origin');assert.equal(writes[0].options.body,'{}');
  assert.deepEqual(h.cleared,[accountUser.id]);assert.deepEqual(h.navigation,['/']);
  finish({user:accountUser});await settle();
  assert.equal(h.menu.querySelector('[data-account-menu-label]').textContent,'Anmelden');
  assert.equal(h.menu.querySelector('[data-account-menu-email]').textContent,'');
  assert.equal(button.hidden,true);
});
test('failed menu sign-out preserves identity and drafts and remains retryable',async t=>{
  const h=mount(t,'landing',false,{user:accountUser,failLogout:true});await settle();
  const button=h.menu.querySelector('[data-account-menu-logout]');button.click();await settle();
  assert.equal(button.disabled,false);assert.equal(button.hidden,false);
  assert.equal(h.menu.querySelector('[data-account-menu-email]').textContent,accountUser.email);
  assert.equal(h.menu.querySelector('[data-account-menu-status]').hidden,false);
  assert.equal(h.cleared.length,0);assert.equal(h.navigation.length,0);
  h.setFailLogout(false);button.click();await settle();
  assert.deepEqual(h.cleared,[accountUser.id]);assert.deepEqual(h.navigation,['/']);
});
test('session refresh waits for an in-flight sign-out and retains identity when sign-out fails',async t=>{
  let finish;const deferredLogout=new Promise(resolve=>{finish=resolve;});
  const h=mount(t,'landing',false,{user:accountUser,failLogout:true,deferredLogout});await settle();
  h.menu.querySelector('[data-account-menu-logout]').click();await settle();
  const pending=h.dom.window.WolkenworteAccountMenu.session();
  finish();assert.deepEqual((await pending).user,accountUser);
  assert.equal(h.calls.filter(call=>call.url.endsWith('/session')).length,1);
  assert.equal(h.menu.querySelector('[data-account-menu-email]').textContent,accountUser.email);
});
test('pages without the configurator load its draft cleaner before sending sign-out',async t=>{
  const h=mount(t,'landing',false,{user:accountUser});await settle();
  delete h.dom.window.WolkenworteConfiguratorSession;
  h.dom.window.indexedDB={};
  h.menu.querySelector('[data-account-menu-logout]').click();await settle();
  assert.equal(h.calls.some(call=>call.url.endsWith('/logout')),false);
  const script=h.document.querySelector('script[src="/js/configurator-session.js"]');assert.ok(script);
  h.dom.window.WolkenworteConfiguratorSession={clearAccountDrafts:async id=>{h.cleared.push(id);}};
  script.onload();await settle();
  assert.equal(h.calls.filter(call=>call.url.endsWith('/logout')).length,1);
  assert.deepEqual(h.cleared,[accountUser.id]);assert.deepEqual(h.navigation,['/']);
});
