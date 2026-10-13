'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const ejs = require('ejs');
const {JSDOM} = require('jsdom');
const runtime = fs.readFileSync('public/js/site-header.js', 'utf8');
const settle = () => new Promise(resolve => setTimeout(resolve, 5));
function render(variant) {
  return ejs.render(fs.readFileSync('views/partials/site-header.ejs','utf8'), {
    header:{variant,mobileMenu:true,mobileBackId:'mobile-back-link',backHref:'/previous',paletteOptions:[{key:'warm',label:'Warm',colors:['#ff0000']}]},
    designAccountsEnabled:true,analyticsMeasurementId:'',asset:x=>x,t:x=>x,locale:'de',
    languages:[{code:'de',name:'Deutsch',flag:'🇩🇪',href:'?lang=de'}],
  },{filename:'views/partials/site-header.ejs'});
}
function mount(t,variant='landing',floating=false) {
  const dom=new JSDOM(render(variant),{url:'https://wolkenworte.invalid'});
  t.after(()=>dom.window.close());const {document}=dom.window;
  if(floating)for(const popup of document.querySelectorAll('[data-ww-menu-popup]')){
    let open=false;const matches=popup.matches.bind(popup);
    popup.showPopover=()=>{open=true;};popup.hidePopover=()=>{open=false;};
    popup.matches=selector=>selector===':popover-open'?open:matches(selector);
    Object.defineProperty(popup,'scrollHeight',{value:240});
    popup.getBoundingClientRect=()=>({height:Math.min(240,parseFloat(popup.style.maxHeight)||240)});
    popup.closest('details').querySelector('summary').getBoundingClientRect=()=>({left:800,right:936,top:180,bottom:224,width:136});
  }
  vm.runInNewContext(runtime,{window:dom.window,document});
  const menu=document.querySelector('[data-ww-site-menu]');
  return {dom,document,menu,trigger:menu.querySelector('summary')};
}
test('all page variants share navigation and preferences, with cloud controls in the display menu',t=>{
  const panels=[];
  for(const variant of ['landing','display','back','brand-only']){
    const h=mount(t,variant);
    panels.push([...h.menu.querySelector('.ww-site-menu-panel').children].filter(node=>!node.classList.contains('ww-site-menu-cloud')).map(node=>node.outerHTML).join(''));
    assert.equal(h.document.querySelectorAll('[data-ww-site-menu]').length,1);
    assert.equal(h.menu.querySelector('[data-account-menu]').getAttribute('href'),'/konto');
    assert.equal(h.menu.querySelectorAll('[data-language-picker]').length,1);
    assert.equal(h.menu.querySelectorAll('[data-ww-install]').length,1);
    assert.equal(Boolean(h.menu.querySelector('#display-palette-picker')),variant==='display');
    assert.equal(h.menu.querySelector('#mobile-back-link'),null);
    assert.equal(h.menu.querySelector('[data-account-logout]'),null);
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
