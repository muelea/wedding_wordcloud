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
function render(view, locale = 'en', page = 'library', enabled = true, {user = null, available = enabled} = {}) {
  const filename = path.join(__dirname, '..', 'views', view);
  const html = ejs.render(fs.readFileSync(filename, 'utf8'), {
    locale, localeSource: 'query', localeCatalogUrl: '', localeCatalogUrls: {},
    header: {variant: view.includes('site-header') ? 'landing' : 'back', id: 'site-header', mobileMenu: true},
    pageData: {accountPage: page, accountAvailable: available, accountUser: user, returnTo: '/konto'},
    designAccountsEnabled: enabled, analyticsMeasurementId: '',
    languages: locales.map(code => ({code, name: Renderer.LANGUAGE_NAMES[code], flag: Renderer.LANGUAGE_FLAGS[code], href: `?lang=${code}`})),
    asset: publicAssetUrl, siteFontAssets: SITE_FONT_ASSETS, siteFontPreloads,
    t: (source, params) => I18n.translate(source, locale, params),
  }, {filename});
  return localizeHtml(html, locale);
}
const settle = async () => {for (let i = 0; i < 20; i++) await new Promise(resolve => setImmediate(resolve));};
function mount(t, {user = owner, serverUser = user, designs = [], page = 'library', locale = 'en', deferredSession = null,
  deferredDesigns = null, clouds = [], deferredClouds = null, failRequest = null, failLogout = false} = {}) {
  const dom = new JSDOM(render('account.ejs', locale, page, true, {user:serverUser}), {url: 'https://wolkenworte.invalid/konto'});
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
      if(failRequest && url.endsWith(`/${failRequest}`))throw new TypeError('Unavailable');
      let data = {ok:true};
      if (url.endsWith('/session')) data = deferredSession ? await deferredSession : {user};
      if (url.endsWith('/designs')) data = deferredDesigns ? await deferredDesigns : {designs};
      if (url.endsWith('/clouds')) data = deferredClouds ? await deferredClouds : {clouds};
      if (/\/clouds\/[^/]+\/delete$/.test(url)) clouds = clouds.filter(cloud => !url.includes('/'+cloud.id+'/'));
      if (url.endsWith('/open')) data = {url:'/e/new-workspace/configure?accountDesign=private'};
      return {ok: !(failLogout && url.endsWith('/logout')),json:async()=>data};
    }};
  return {dom,document,calls,navigation,cleared,context,setFailure:value=>{failRequest=value;},setUser:next=>{user=next;},run:file=>{
    if(file==='public/js/account.js'){
      vm.runInNewContext(fs.readFileSync('public/js/site-header.js','utf8'),context);
      vm.runInNewContext(fs.readFileSync('public/js/cloud-bookmarks.js','utf8'),context);
    }
    return vm.runInNewContext(fs.readFileSync(file,'utf8'),context);
  }};
}
test('the first server render shows the verified account layout before JavaScript runs', t => {
  for(const locale of locales)for(const page of ['library','signin']){
    const h=mount(t,{locale,page}),account=h.document.getElementById('account-page');
    assert.equal(account.classList.contains('is-signin'),false);
    assert.equal(h.document.querySelector('[data-account-signin]').hidden,true);
    assert.equal(h.document.querySelector('[data-account-navigation]').hidden,false);
    assert.equal(h.document.querySelector('[data-account-email]').textContent,owner.email);
    assert.equal(h.document.querySelector('[data-account-email]').hidden,false);
    assert.equal(h.document.querySelector('[data-account-logout]').hidden,false);
    const loading=h.document.querySelector('[data-account-loading]');
    assert.equal(loading.hidden,false);
    assert.equal(loading.textContent,I18n.translate('Deine Designs werden geladen…',locale));
    if(locale!=='de')assert.notEqual(loading.textContent,'Deine Designs werden geladen…');
    assert.equal(h.calls.length,0);
  }
});
test('server account data is escaped and signed-out, recovery and unavailable pages retain the sign-in layout', t => {
  const user={...owner,email:'<img src=x onerror=alert(1)>"&'};
  const h=mount(t,{user});
  assert.equal(h.document.querySelector('[data-account-email]').textContent,user.email);
  assert.equal(h.document.querySelector('[data-account-email] img'),null);
  assert.deepEqual(JSON.parse(h.document.getElementById('account-page').dataset.accountUser),user);
  for(const {user,available} of [{user:null,available:true},{user:{...owner,recovery:true},available:true},{user:owner,available:false}]){
    const dom=new JSDOM(render('account.ejs','en','library',true,{user,available}));
    t.after(()=>dom.window.close());const doc=dom.window.document;
    assert.equal(doc.getElementById('account-page').classList.contains('is-signin'),true);
    assert.equal(doc.querySelector('[data-account-signin]').hidden,!available);
    for(const selector of ['[data-account-navigation]','[data-account-email]','[data-account-logout]','[data-account-loading]']){
      assert.equal(doc.querySelector(selector).hidden,true);
    }
  }
});
test('delayed session and design responses never reveal sign-in or a provisional empty library', async t => {
  let finishSession,finishDesigns;
  const deferredSession=new Promise(resolve=>{finishSession=resolve;});
  const deferredDesigns=new Promise(resolve=>{finishDesigns=resolve;});
  const h=mount(t,{deferredSession,deferredDesigns});
  h.run('public/js/account.js');await settle();
  const signin=h.document.querySelector('[data-account-signin]'),loading=h.document.querySelector('[data-account-loading]');
  const library=h.document.querySelector('[data-account-library]');
  assert.equal(signin.hidden,true);assert.equal(loading.hidden,false);assert.equal(library.hidden,true);
  finishSession({user:owner});await settle();
  assert.equal(signin.hidden,true);assert.equal(loading.hidden,false);assert.equal(library.hidden,true);
  h.document.getElementById('account-settings-tab').click();
  assert.equal(h.document.querySelector('[data-account-settings]').hidden,false);
  assert.equal(loading.hidden,true);assert.equal(signin.hidden,true);
  h.document.getElementById('account-designs-tab').click();assert.equal(loading.hidden,false);
  finishDesigns({designs:[]});await settle();
  assert.equal(signin.hidden,true);assert.equal(loading.hidden,true);assert.equal(library.hidden,false);
  assert.equal(h.document.querySelector('[data-account-empty]').hidden,false);
});
test('failed initial account requests clear the loading state without flashing the login form', async t => {
  for(const failRequest of ['session','designs']){
    const h=mount(t,{failRequest});h.run('public/js/account.js');await settle();
    assert.equal(h.document.querySelector('[data-account-signin]').hidden,true);
    assert.equal(h.document.querySelector('[data-account-loading]').hidden,true);
    assert.equal(h.document.querySelector('[data-account-library]').hidden,true);
    assert.equal(h.document.getElementById('account-page-status').dataset.error,'true');
    assert.match(h.document.getElementById('account-page-status').textContent,/try again/i);
    h.document.getElementById('account-settings-tab').click();
    h.document.getElementById('account-designs-tab').click();
    assert.equal(h.document.querySelector('[data-account-loading]').hidden,true);
  }
});
test('session revalidation still reveals sign-in when the server-rendered session has ended', async t => {
  const h=mount(t,{user:null,serverUser:owner});h.run('public/js/account.js');await settle();
  assert.equal(h.document.querySelector('[data-account-signin]').hidden,false);
  assert.equal(h.document.querySelector('[data-account-navigation]').hidden,true);
  assert.equal(h.document.querySelector('[data-account-loading]').hidden,true);
  assert.equal(h.document.getElementById('account-page').classList.contains('is-signin'),true);
  assert.equal(h.calls.some(call=>call.url.endsWith('/designs')),false);
});
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
    assert.equal(forms.length,3);
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
  settings.dispatchEvent(new h.dom.window.KeyboardEvent('keydown',{key:'Home',bubbles:true}));
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

const savedCloud = (overrides={}) => ({id:'bookmark-one',slug:'AbCdEfGhIjKlMnOpQrStUQ',title:'Our celebration',available:true,
  expiresAt:'2027-01-31',previewWords:[['Liebe',3],['Freude',1]],url:'/e/AbCdEfGhIjKlMnOpQrStUQ',
  designUrl:'/e/AbCdEfGhIjKlMnOpQrStUQ/configure?view=products',...overrides});

test('the cloud tab shows shared live contents, existing gallery links and account-only removal', async t => {
  const cloud=savedCloud(),h=mount(t,{clouds:[cloud]});h.run('public/js/account.js');await settle();
  const tab=h.document.getElementById('account-clouds-tab');tab.click();await settle();
  const panel=h.document.querySelector('[data-account-clouds]');
  assert.equal(panel.hidden,false);assert.equal(tab.getAttribute('aria-selected'),'true');
  assert.equal(h.document.querySelector('[data-account-library]').hidden,true);
  assert.equal(panel.querySelector('h2').textContent,'Saved word clouds');
  assert.equal(panel.querySelector('.ww-cloud-card h2').textContent,cloud.title);
  assert.equal(panel.querySelector('.ww-cloud-preview').textContent,'LiebeFreude');
  assert.equal(panel.querySelectorAll('a')[0].getAttribute('href'),cloud.url);
  assert.equal(panel.querySelectorAll('a')[1].getAttribute('href'),cloud.designUrl);
  panel.querySelector('.ww-cloud-remove').click();await settle();
  const write=h.calls.find(call=>call.url.endsWith('/delete'));
  assert.equal(write.url,`/api/account/clouds/${cloud.id}/delete`);
  assert.equal(write.options.headers['X-Wolkenworte-Account'],'1');
  assert.equal(h.document.querySelector('[data-account-clouds-empty]').hidden,false);
  assert.equal(h.navigation.length,0);
});

test('new design choices browse the same saved clouds without creating workspaces or designs', async t => {
  const cloud=savedCloud(),h=mount(t,{clouds:[cloud]});h.run('public/js/account.js');await settle();
  const form=h.document.querySelector('[data-account-new-design]');
  const event=new h.dom.window.Event('submit',{cancelable:true});form.dispatchEvent(event);
  assert.equal(event.defaultPrevented,true);
  const dialog=h.document.getElementById('account-design-picker');assert.equal(dialog.open,true);
  assert.equal(dialog.querySelector('form').action,'https://wolkenworte.invalid/design/start');
  assert.equal(dialog.querySelector('form').method,'post');
  dialog.querySelector('[data-design-picker-clouds]').click();await settle();
  assert.equal(dialog.querySelector('.ww-cloud-card h2').textContent,cloud.title);
  assert.equal(dialog.querySelector('.ww-cloud-card a').getAttribute('href'),cloud.designUrl);
  assert.equal(h.calls.some(call=>call.options.method==='POST'),false);
  dialog.querySelector('[data-design-picker-close]').click();assert.equal(dialog.open,false);
});

test('unavailable and empty clouds have clear states and never offer a design action', async t => {
  const h=mount(t,{clouds:[savedCloud({title:'<img src=x onerror=alert(1)>',available:false,url:null,designUrl:null,previewWords:[['private old words',1]]}),
    savedCloud({id:'empty',previewWords:[]})]});h.run('public/js/account.js');await settle();
  h.document.getElementById('account-clouds-tab').click();await settle();
  const cards=h.document.querySelectorAll('[data-account-cloud-list] .ww-cloud-card');
  assert.equal(cards[0].querySelector('img'),null);assert.equal(cards[0].querySelectorAll('a').length,0);
  assert.equal(cards[0].querySelector('.ww-cloud-preview').textContent,'No longer available');
  assert.ok(!cards[0].textContent.includes('private old words'));
  assert.equal(cards[1].querySelectorAll('a').length,1);assert.equal(cards[1].querySelector('a').textContent,'Open word cloud');
});

test('cloud failures have a retry and leave the design library available', async t => {
  const h=mount(t,{clouds:[savedCloud()],failRequest:'clouds'});h.run('public/js/account.js');await settle();
  h.document.getElementById('account-clouds-tab').click();await settle();
  assert.equal(h.document.querySelector('[data-account-clouds-retry]').hidden,false);
  assert.equal(h.document.querySelector('[data-account-clouds-empty]').hidden,true);
  h.document.getElementById('account-designs-tab').click();
  assert.equal(h.document.querySelector('[data-account-library]').hidden,false);
  h.setFailure(null);h.document.getElementById('account-clouds-tab').click();await settle();
  assert.equal(h.document.querySelectorAll('.ww-cloud-card').length,1);
});

test('late cloud responses cannot restore a signed-out account collection', async t => {
  let finish;const deferredClouds=new Promise(resolve=>{finish=resolve;});
  const h=mount(t,{deferredClouds});h.run('public/js/account.js');await settle();
  h.document.getElementById('account-clouds-tab').click();await settle();
  h.setUser(null);h.dom.window.dispatchEvent(new h.dom.window.Event('wolkenworte:localechange'));await settle();
  finish({clouds:[savedCloud()]});await settle();
  assert.equal(h.document.querySelector('[data-account-clouds]').hidden,true);
  assert.equal(h.document.querySelectorAll('.ww-cloud-card').length,0);
});

test('bookmark cards and the picker are localized in all supported languages', async t => {
  for(const locale of locales){
    const h=mount(t,{locale,clouds:[savedCloud()]});h.run('public/js/account.js');await settle();
    h.document.getElementById('account-clouds-tab').click();await settle();
    assert.equal(h.document.querySelector('.ww-cloud-card a').textContent,I18n.translate('Wortwolke öffnen',locale));
    assert.equal(h.document.querySelector('[data-design-picker-clouds]').textContent,I18n.translate('Mit einer Wortwolke starten',locale));
    const date=I18n.translate('Verfügbar bis {{date}}, sofern keine weiteren Änderungen erfolgen.',locale,{date:'DATE'});
    assert.match(date,/DATE/);if(locale!=='de')assert.notEqual(date,'Verfügbar bis DATE, sofern keine weiteren Änderungen erfolgen.');
  }
});
