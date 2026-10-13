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
    header:{variant,mobileMenu:true,mobileBackId:'mobile-back-link',backHref:'/previous',paletteOptions:[]},
    designAccountsEnabled:true,analyticsMeasurementId:'',asset:x=>x,t:x=>x,locale:'de',
    languages:[{code:'de',name:'Deutsch',flag:'🇩🇪',href:'?lang=de'}],
  },{filename:'views/partials/site-header.ejs'});
}
function mount(t,variant='landing') {
  const dom=new JSDOM(render(variant),{url:'https://wolkenworte.invalid'});
  t.after(()=>dom.window.close());const {document}=dom.window;
  vm.runInNewContext(runtime,{window:dom.window,document});
  const menu=document.querySelector('[data-ww-site-menu]');
  return {dom,document,menu,trigger:menu.querySelector('summary')};
}
test('all page variants render exactly the same global menu and one stable account destination',t=>{
  const panels=[];
  for(const variant of ['landing','display','back','brand-only']){
    const h=mount(t,variant);
    panels.push(h.menu.querySelector('.ww-site-menu-panel').innerHTML);
    assert.equal(h.document.querySelectorAll('[data-ww-site-menu]').length,1);
    assert.equal(h.menu.querySelector('[data-account-menu]').getAttribute('href'),'/konto');
    assert.equal(h.menu.querySelectorAll('[data-language-picker]').length,1);
    assert.equal(h.menu.querySelectorAll('[data-ww-install]').length,1);
    assert.equal(h.menu.querySelector('#display-palette-picker'),null);
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
test('opening global navigation closes the separate cloud settings',async t=>{
  const h=mount(t,'display');const settings=h.document.getElementById('display-page-menu');
  settings.open=true;h.menu.open=true;await settle();
  assert.equal(settings.open,false);
  assert.ok(settings.querySelector('#presentation-mode-button'));
});
