'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ejs = require('ejs');
const {JSDOM} = require('jsdom');
const I18n = require('../src/i18n');
const Renderer = require('../src/pageRenderer');
const {localizeHtml} = require('../src/htmlLocalizer');
const {publicAssetUrl} = require('../src/publicAssets');
const {SITE_FONT_ASSETS, siteFontPreloads} = require('../src/siteFonts');
const locales = ['de', 'en', 'fr', 'it', 'es', 'tr'];
const owner = {id: '41139ef6-90f5-400d-bac5-8b7365f88428', email: 'test@example.invalid'};
function render(view, locale = 'en', page = 'library', enabled = true) {
  const filename = path.join(__dirname, '..', 'views', view);
  const html = ejs.render(fs.readFileSync(filename, 'utf8'), {
    locale, localeSource: 'query', localeCatalogUrl: '', localeCatalogUrls: {},
    header: {variant: view.includes('site-header') ? 'landing' : 'back', id: 'site-header', mobileMenu: true},
    pageData: {accountPage: page, accountAvailable: true, returnTo: '/konto'},
    designAccountsEnabled: enabled, analyticsMeasurementId: '',
    languages: locales.map(code => ({code, name: Renderer.LANGUAGE_NAMES[code], flag: Renderer.LANGUAGE_FLAGS[code], href: `?lang=${code}`})),
    asset: publicAssetUrl, siteFontAssets: SITE_FONT_ASSETS, siteFontPreloads,
    t: (source, params) => I18n.translate(source, locale, params),
  }, {filename});
  return localizeHtml(html, locale);
}
const settle = async () => {for (let i = 0; i < 20; i++) await new Promise(resolve => setImmediate(resolve));};
function mount(t, {user = owner, designs = [], page = 'library', locale = 'en', deferredSession = null, failLogout = false} = {}) {
  const dom = new JSDOM(render('account.ejs', locale, page), {url: 'https://wolkenworte.invalid/konto'});
  t.after(() => dom.window.close());
  const document = dom.window.document;
  Object.defineProperty(document, 'readyState', {value: 'complete'});
  const calls = [], navigation = [], cleared = [];
  dom.window.WolkenworteI18n = {
    getLocale: () => locale, ready: async () => {}, t: (s,p) => I18n.translate(s,locale,p),
    setText: (element,s,p) => {element.textContent = I18n.translate(s,locale,p);},
    setAttribute: (element,a,s) => element.setAttribute(a,I18n.translate(s,locale)),
  };
  dom.window.WolkenworteConfiguratorSession = {clearAccountDrafts: async id => {cleared.push(id);}};
  dom.window.HTMLDialogElement.prototype.showModal = function () {this.open = true;};
  dom.window.HTMLDialogElement.prototype.close = function () {this.open = false;this.dispatchEvent(new dom.window.Event('close'));};
  const context = {window: dom.window, document, location: {pathname:'/konto',search:'',assign:url=>navigation.push(url)},
    history:{replaceState(){}}, crypto:require('node:crypto'), FormData:dom.window.FormData,
    URLSearchParams, Intl, AbortSignal, setTimeout, clearTimeout,
    fetch: async (url, options) => {
      calls.push({url, options});
      let data = {ok:true};
      if (url.endsWith('/session')) data = deferredSession ? await deferredSession : {user};
      if (url.endsWith('/designs')) data = {designs};
      if (url.endsWith('/open')) data = {url:'/e/new-workspace/configure?accountDesign=private'};
      return {ok: !(failLogout && url.endsWith('/logout')),json:async()=>data};
    }};
  return {dom,document,calls,navigation,cleared,setUser:next=>{user=next;},run:file=>vm.runInNewContext(fs.readFileSync(file,'utf8'),context)};
}
test('one homepage hamburger contains the account entry in all six languages; disabled accounts expose no account menu', () => {
  for (const locale of locales) {
    const dom = new JSDOM(render('partials/site-header.ejs',locale));
    const doc = dom.window.document;
    assert.equal(doc.querySelectorAll('.landing-menu-toggle').length,1);
    assert.equal(doc.querySelectorAll('.ww-menu-trigger').length,1);
    assert.equal(doc.querySelector('.landing-menu-toggle').getAttribute('aria-controls'),'landing-overflow-menu');
    assert.equal(doc.querySelector('#landing-overflow-menu [data-account-library-link]').textContent,I18n.translate('Meine Designs',locale));
    assert.equal(doc.querySelector('.ww-account-entry'),null);
    dom.window.close();
  }
  const dom = new JSDOM(render('partials/site-header.ejs','en','library',false));
  assert.equal(dom.window.document.querySelector('[data-account-menu]'),null);
  assert.equal(dom.window.document.querySelector('script[src*="account-menu.js"]'),null);
  dom.window.close();
});
test('both empty and populated collection actions deliberately POST a fresh workspace, with localized labels', () => {
  for (const locale of locales) {
    const dom = new JSDOM(render('account.ejs',locale));
    const forms = [...dom.window.document.querySelectorAll('.ww-account-create')];
    assert.equal(forms.length,2);
    for (const form of forms) {
      assert.equal(form.getAttribute('action'),'/design/start');
      assert.equal(form.method,'post');
      assert.ok(form.textContent.includes(I18n.translate('Ein neues Design gestalten',locale)));
    }
    assert.equal(dom.window.document.querySelector('[data-account-signin]').classList.contains('ww-account-card'),false);
    dom.window.close();
  }
});
test('new account labels translate in every catalog and retain their count and storage placeholders', () => {
  const messages=['Deine Ideen finden hier ihren Platz.','Gestalte dein erstes Erinnerungsstück und speichere es hier, um später weiterzumachen.',
    'Speicherplatz','{{count}} von 20 Designs','{{size}} von 100 MB','Designoptionen','Abmelden…','Mein Konto – Wolkenworte'];
  for(const locale of locales.filter(code=>code!=='de'))for(const message of messages){
    const translated=I18n.translate(message,locale);
    assert.notEqual(translated,message,`${locale}: ${message}`);
    assert.deepEqual(translated.match(/\{\{\w+\}\}/g)||[],message.match(/\{\{\w+\}\}/g)||[]);
  }
});
test('signed-out visitors see the unboxed auth form and no signed-in header actions', async t => {
  const h = mount(t,{user:null});h.run('public/js/account-menu.js');h.run('public/js/account.js');await settle();
  assert.ok(h.document.getElementById('account-page').classList.contains('is-signin'));
  assert.equal(h.document.querySelector('[data-account-signin]').hidden,false);
  assert.equal(h.document.querySelector('[data-account-library]').hidden,true);
  assert.equal(h.document.querySelector('[data-account-menu-signed-in]').hidden,true);
});
test('an empty signed-in collection presents its creation action and quiet count without a storage counter', async t => {
  const h = mount(t);h.run('public/js/account-menu.js');h.run('public/js/account.js');await settle();
  assert.equal(h.document.querySelector('[data-account-empty]').hidden,false);
  assert.equal(h.document.querySelector('[data-account-library-toolbar]').hidden,true);
  assert.equal(h.document.querySelector('[data-account-usage]').textContent,'0 of 20 designs');
  assert.equal(h.document.querySelector('[data-account-menu-signed-in]').hidden,false);
  assert.equal(h.calls.some(call=>call.options.method==='POST'),false,'viewing an empty collection never creates or saves a design');
});
test('populated designs retain their private previews and open action, with secondary actions in each menu', async t => {
  const h = mount(t,{designs:[{id:'private-id',name:'Wedding memories',previewUrl:'/api/account/designs/private-id/preview',
    productName:'Tasse',byteSize:1024,savedAt:'2026-10-12',expiresAt:'2027-01-12',version:3}]});
  h.run('public/js/account.js');await settle();
  const card = h.document.querySelector('.ww-account-design');
  assert.equal(card.querySelector('h2').textContent,'Wedding memories');
  assert.equal(card.querySelector('img').getAttribute('src'),'/api/account/designs/private-id/preview');
  assert.equal(card.querySelectorAll('.ww-account-design-menu-panel button').length,2);
  assert.equal(h.document.querySelector('[data-account-empty]').hidden,true);
  assert.equal(h.document.querySelector('[data-account-library-toolbar]').hidden,false);
  card.querySelector('.ww-account-primary').click();await settle();
  assert.equal(h.calls.at(-1).url,'/api/account/designs/private-id/open');
  assert.deepEqual(h.navigation,['/e/new-workspace/configure?accountDesign=private']);
});
test('settings display storage usage and the localized account title', async t => {
  const h = mount(t,{page:'settings',designs:[{byteSize:1048576}]});h.run('public/js/account.js');await settle();
  assert.equal(h.document.querySelector('[data-account-settings]').hidden,false);
  assert.equal(h.document.querySelector('[data-account-storage]').textContent,'1 of 100 MB');
  assert.equal(h.document.title,'My account – Wolkenworte');
  assert.equal(h.document.querySelector('[data-account-usage]').hidden,true);
});
test('a delayed initial menu read cannot override a successful sign-in', async t => {
  let resolve;const pending = new Promise(done=>{resolve=done;});
  const h = mount(t,{deferredSession:pending});h.run('public/js/account-menu.js');
  h.dom.window.dispatchEvent(new h.dom.window.CustomEvent('wolkenworte:accountchange',{detail:{user:owner}}));
  resolve({user:null});await settle();
  assert.equal(h.document.querySelector('[data-account-menu-signed-in]').hidden,false);
});
test('returning through browser history refreshes the account actions without changing the current page', async t => {
  const h=mount(t,{user:null});h.run('public/js/account-menu.js');await settle();
  assert.equal(h.document.querySelector('[data-account-menu-signed-in]').hidden,true);
  h.setUser(owner);
  const event=new h.dom.window.Event('pageshow');Object.defineProperty(event,'persisted',{value:true});
  h.dom.window.dispatchEvent(event);await settle();
  assert.equal(h.document.querySelector('[data-account-menu-signed-in]').hidden,false);
  assert.equal(h.navigation.length,0);
});
test('header sign-out sends one guarded request and clears only the current account drafts', async t => {
  const h = mount(t);h.run('public/js/account-menu.js');await settle();
  const button = h.document.querySelector('[data-account-menu-logout]');button.click();button.click();await settle();
  const writes = h.calls.filter(call=>call.url.endsWith('/logout'));
  assert.equal(writes.length,1);
  assert.equal(writes[0].options.method,'POST');
  assert.equal(writes[0].options.headers['X-Wolkenworte-Account'],'1');
  assert.deepEqual(h.cleared,[owner.id]);assert.deepEqual(h.navigation,['/']);
});
test('failed header sign-out remains retryable and preserves local drafts', async t => {
  const h = mount(t,{failLogout:true});h.run('public/js/account-menu.js');await settle();
  const button = h.document.querySelector('[data-account-menu-logout]');button.click();await settle();
  assert.equal(button.disabled,false);assert.equal(h.cleared.length,0);assert.equal(h.navigation.length,0);
  assert.match(h.document.querySelector('[data-account-menu-status]').textContent,/try again/i);
});
