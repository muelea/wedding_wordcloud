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
  return {dom,document,calls,navigation,cleared,setUser:next=>{user=next;},run:file=>{
    if(file==='public/js/account.js')vm.runInNewContext(fs.readFileSync('public/js/site-header.js','utf8'),context);
    return vm.runInNewContext(fs.readFileSync(file,'utf8'),context);
  }};
}
test('rename titles are localized and deletion initially focuses Cancel without deleting anything', async t => {
  for (const locale of locales) {
    await t.test(locale, async t => {
      const h = mount(t, {locale, designs: [{id:'focus-fixture', name:'My design',
        productName:'Tasse', byteSize:1024, savedAt:'2026-10-12', expiresAt:'2027-01-12', version:1}]});
      h.run('public/js/account.js');await settle();
      const [rename, remove] = h.document.querySelectorAll('.ww-account-design-menu-panel button');
      const dialog = h.document.getElementById('account-confirm-dialog');
      rename.click();await settle();
      assert.equal(rename.textContent, I18n.translate('Umbenennen', locale));
      if (locale !== 'de') assert.notEqual(rename.textContent, 'Umbenennen');
      const title = dialog.querySelector('[data-confirm-title]').textContent;
      assert.equal(title, I18n.translate('Design umbenennen', locale));
      if (locale !== 'de') assert.notEqual(title, 'Design umbenennen');
      assert.equal(h.document.activeElement, dialog.querySelector('input'));
      dialog.close();await settle();
      assert.equal(h.document.activeElement, h.document.querySelector('.ww-account-design-menu > summary'));
      remove.click();await settle();
      assert.equal(h.document.activeElement, dialog.querySelector('[data-confirm-cancel]'));
      assert.equal(dialog.querySelector('[data-confirm-action]') === h.document.activeElement, false);
      dialog.close();await settle();
      assert.equal(h.document.activeElement, h.document.querySelector('.ww-account-design-menu > summary'));
      assert.equal(h.calls.some(call => /\/(rename|delete)$/.test(call.url)), false);
    });
  }
});
test('one homepage hamburger contains the account entry in all six languages; disabled accounts expose no account menu', () => {
  for (const locale of locales) {
    const dom = new JSDOM(render('partials/site-header.ejs',locale));
    const doc = dom.window.document;
    assert.equal(doc.querySelectorAll('[data-ww-site-menu-trigger]').length,1);
    assert.equal(doc.querySelectorAll('.ww-menu-trigger').length,1);
    assert.equal(doc.querySelector('[data-ww-site-menu-trigger]').getAttribute('aria-controls'),'site-menu-panel');
    assert.equal(doc.querySelector('#site-menu-panel [data-account-menu-label]').textContent,I18n.translate('Mein Konto',locale));
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
  const h = mount(t,{user:null});h.run('public/js/account.js');await settle();
  assert.ok(h.document.getElementById('account-page').classList.contains('is-signin'));
  assert.equal(h.document.querySelector('[data-account-signin]').hidden,false);
  assert.equal(h.document.querySelector('[data-account-library]').hidden,true);
  assert.equal(h.document.querySelector('[data-account-navigation]').hidden,true);
  assert.equal(h.document.querySelector('[data-account-menu]').getAttribute('href'),'/konto');
  assert.equal(h.document.querySelector('[data-account-menu-label]').textContent,'Sign in');
  assert.equal(h.document.querySelector('[data-account-menu-email]').hidden,true);
  assert.equal(h.document.querySelector('[data-account-menu-logout]').hidden,true);
  assert.equal(h.document.querySelector('[data-account-email]').hidden,true);
  assert.equal(h.document.querySelector('[data-account-logout]').hidden,true);
});
test('an empty signed-in collection presents its creation action and combined usage line', async t => {
  const h = mount(t);h.run('public/js/account.js');await settle();
  assert.equal(h.document.querySelector('[data-account-empty]').hidden,false);
  assert.equal(h.document.querySelector('[data-account-library-toolbar]').hidden,true);
  assert.equal(h.document.querySelector('[data-account-usage]').textContent,'0 of 20 designs · 0 of 100 MB');
  assert.equal(h.document.querySelector('[data-account-navigation]').hidden,false);
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
test('settings omit storage usage and retain the localized account title', async t => {
  const h = mount(t,{page:'settings',designs:[{id:'saved',name:'Test',byteSize:1048576,savedAt:'2026-10-12',expiresAt:'2027-01-12',productName:'Tasse',previewUrl:'/preview'}]});h.run('public/js/account.js');await settle();
  assert.equal(h.document.querySelector('[data-account-settings]').hidden,false);
  assert.equal(h.document.querySelector('[data-account-settings] [data-account-storage]'),null);
  assert.equal(h.document.querySelector('[data-account-settings] [data-account-logout]'),null);
  assert.equal(h.document.querySelector('[data-account-settings] [data-account-email]'),null);
  assert.equal(h.document.querySelector('[data-account-library] [data-account-storage]').textContent,'1 of 100 MB');
  assert.equal(h.document.title,'My account – Wolkenworte');
  assert.equal(h.document.querySelector('[data-account-library]').hidden,true);
});
test('the design library combines the count and total storage with locale-specific number formatting', async t => {
  const designs=Array.from({length:3},(_,index)=>({id:`saved-${index}`,name:'Test',byteSize:104858,
    savedAt:'2026-10-12',expiresAt:'2027-01-12',productName:'Tasse',previewUrl:'/preview'}));
  for(const locale of locales){
    const h=mount(t,{designs,locale});h.run('public/js/account.js');await settle();
    const usage=h.document.querySelector('[data-account-usage]');
    const count=I18n.translate('{{count}} von 20 Designs',locale,{count:3});
    const size=new Intl.NumberFormat(locale,{maximumFractionDigits:1}).format(0.3);
    const storage=I18n.translate('{{size}} von 100 MB',locale,{size});
    assert.equal(usage.textContent,`${count} · ${storage}`);
    assert.equal(usage.hidden,false);
    assert.equal(usage.closest('[data-account-library]').hidden,false);
    assert.equal(h.document.querySelectorAll('[data-account-storage]').length,1);
  }
});
test('one account page switches sections with clicks, arrow keys and an addressable settings section', async t => {
  const h=mount(t);h.run('public/js/account.js');await settle();
  const designs=h.document.getElementById('account-designs-tab'),settings=h.document.getElementById('account-settings-tab');
  settings.click();
  assert.equal(h.document.querySelector('[data-account-settings]').hidden,false);
  assert.equal(h.document.querySelector('[data-account-library]').hidden,true);
  assert.equal(settings.getAttribute('aria-selected'),'true');
  settings.dispatchEvent(new h.dom.window.KeyboardEvent('keydown',{key:'ArrowLeft',bubbles:true}));
  assert.equal(h.document.activeElement,designs);
  assert.equal(h.document.querySelector('[data-account-library]').hidden,false);
  assert.equal(settings.tabIndex,-1);
  assert.equal(h.calls.filter(call=>call.url.endsWith('/designs')).length,1,'switching sections reuses the same loaded collection');
  assert.equal(h.calls.some(call=>call.options.method==='POST'),false);
});
test('the global account entry does not depend on a delayed session response', async t => {
  let finish;const pending=new Promise(resolve=>{finish=resolve;});
  const h=mount(t,{deferredSession:pending});h.run('public/js/account.js');
  const entry=h.document.querySelector('[data-account-menu]');
  assert.equal(entry.hidden,false);assert.equal(entry.querySelector('[data-account-menu-label]').textContent,'My account');
  assert.equal(h.document.querySelector('[data-account-menu-logout]').hidden,true);
  finish({user:null});await settle();assert.equal(entry.hidden,false);
  assert.equal(entry.querySelector('[data-account-menu-label]').textContent,'Sign in');
});
test('signed-in identity and both sign-out actions stay localized and visible above either account tab', async t => {
  for(const locale of locales){
    const h=mount(t,{locale});h.run('public/js/account.js');await settle();
    const email=h.document.querySelector('.ww-account-heading [data-account-email]');
    const logout=h.document.querySelector('.ww-account-heading [data-account-logout]');
    assert.equal(email.textContent,owner.email);assert.equal(email.hidden,false);
    assert.equal(logout.textContent,I18n.translate('Abmelden',locale));assert.equal(logout.hidden,false);
    assert.equal(h.document.querySelector('[data-account-menu-email]').textContent,owner.email);
    assert.equal(h.document.querySelector('[data-account-menu-email]').hidden,false);
    assert.equal(h.document.querySelector('[data-account-menu-label]').textContent,I18n.translate('Mein Konto',locale));
    assert.equal(h.document.querySelector('[data-account-menu-logout]').textContent,I18n.translate('Abmelden',locale));
    assert.equal(h.document.querySelector('[data-account-menu-logout]').hidden,false);
    h.document.getElementById('account-settings-tab').click();
    assert.equal(email.hidden,false);assert.equal(logout.hidden,false);
    assert.equal(h.calls.filter(call=>call.url.endsWith('/session')).length,1);
  }
});
test('menu sign-out and account-heading sign-out share one guarded operation', async t => {
  const h=mount(t);h.run('public/js/account.js');await settle();
  const menu=h.document.querySelector('[data-account-menu-logout]'),heading=h.document.querySelector('[data-account-logout]');
  menu.click();heading.click();await settle();
  assert.equal(h.calls.filter(call=>call.url.endsWith('/logout')).length,1);
  assert.deepEqual(h.cleared,[owner.id]);assert.deepEqual(h.navigation,['/']);
  assert.equal(h.document.querySelector('[data-account-menu-email]').textContent,'');
});
test('account sign-out sends one guarded request and clears only the current account drafts', async t => {
  const h = mount(t);h.run('public/js/account.js');await settle();
  const button = h.document.querySelector('[data-account-logout]');button.click();button.click();await settle();
  const writes = h.calls.filter(call=>call.url.endsWith('/logout'));
  assert.equal(writes.length,1);
  assert.equal(writes[0].options.method,'POST');
  assert.equal(writes[0].options.headers['X-Wolkenworte-Account'],'1');
  assert.deepEqual(h.cleared,[owner.id]);assert.deepEqual(h.navigation,['/']);
});
test('failed account sign-out remains retryable and preserves local drafts', async t => {
  const h = mount(t,{failLogout:true});h.run('public/js/account.js');await settle();
  const button = h.document.querySelector('[data-account-logout]');button.click();await settle();
  assert.equal(button.disabled,false);assert.equal(h.cleared.length,0);assert.equal(h.navigation.length,0);
  assert.match(h.document.querySelector('#account-page-status').textContent,/try again/i);
});
