'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const Session = require('../public/js/configurator-session');

function storage() {
  const values = new Map();
  return { getItem: key => values.get(key) || null,
    setItem: (key, value) => values.set(key, String(value)), removeItem: key => values.delete(key) };
}
const template = fs.readFileSync(path.join(__dirname, '../views/configure.ejs'), 'utf8');

test('checkout actions are contextual and only ask when current work would be omitted', () => {
  assert.doesNotMatch(template, /cart-action-hint|save-status|Nur ausdrücklich übernommene Designs|Design im Warenkorb gespeichert/);
  assert.match(template, /\.primary-button:disabled\s*\{[^}]*cursor:\s*default/);
  assert.match(template, /\.primary-button\.ww-is-busy:disabled\s*\{[^}]*cursor:\s*wait/);
  const secondaryHover = template.match(/\.secondary-button:hover:not\(:disabled\)\s*\{([^}]*)\}/)?.[1] || '';
  assert.match(secondaryHover, /background:/);
  assert.doesNotMatch(secondaryHover, /border(?:-color)?:/);
  assert.match(template, /\.secondary-button:focus\s*\{[^}]*outline:\s*none/);
  const secondaryFocus = template.match(/\.secondary-button:focus-visible\s*\{([^}]*)\}/)?.[1] || '';
  assert.match(secondaryFocus, /background:/);
  assert.doesNotMatch(secondaryFocus, /border|outline|box-shadow/);
  assert.doesNotMatch(template, /leave-design-dialog|askBeforeLeaving|confirmLeaving/);
  assert.match(template, /id="draft-loss-dialog"/);
  assert.match(template, /draftLossDialog\.showModal\(\);\s*draftLossTitle\.focus/);
  assert.match(template, /id="shipping-choice-dialog"/);
  assert.match(template, /Dieses Design ist noch nicht im Warenkorb/);
  assert.match(template, /Mit aktuellem Warenkorb weiter/);
  assert.match(template, /'Änderungen übernehmen & zur Lieferadresse'/);
  assert.match(template, /'In den Warenkorb & zur Lieferadresse'/);
  assert.match(template, /id="cloud-update-notice"/);
});

function pageFunction(name) {
  const start = template.search(new RegExp('    (?:async )?function ' + name + '\\('));
  assert.notEqual(start, -1, name);
  return template.slice(start, template.indexOf('\n    }', start) + '\n    }'.length);
}
const id = character => character.repeat(16);
function draftBackend() {
  const records = new Map();
  return {
    records,
    get: async key => records.get(key),
    put: async record => records.set(record.key, JSON.parse(JSON.stringify(record))),
    delete: async key => records.delete(key),
  };
}
function harness(extra = {}) {
  const local = storage();
  const cart = Session.createCart('event-a', local);
  const drafts = draftBackend();
  const draftStore = Session.createDraftStore('event-a', { backend: drafts });
  const calls = { posts: 0, bodies: [], navigations: [], warnings: [], opened: [], busy: [], replaced: [], panels: [] };
  const element = () => ({ textContent: '', disabled: false, hidden: false });
  let shippingChoiceCloseListener = null;
  const shippingChoiceDialog = {
    returnValue: 'cancel',
    addEventListener: (name, listener) => {
      if (name === 'close') shippingChoiceCloseListener = listener;
    },
    close(value) {
      this.returnValue = value;
      shippingChoiceCloseListener?.();
      shippingChoiceCloseListener = null;
    },
  };
  const context = vm.createContext({
    AbortSignal, URLSearchParams, setTimeout, clearTimeout, requestAnimationFrame: callback => callback(),
    console: { warn() {} },
    WolkenworteConfiguratorSession: Session, sessionStorage: local, cart, draftStore,
    CloudLimits: require('../public/js/cloud-limits'),
    slug: 'event-a', guestId: 'a'.repeat(32), product: { key: 'mug' },
    AUTOMATIC_LAYOUT_VERSION: '/js/wordcloud-core.js?v=current|/js/design-layout.js?v=current',
    words: [['sonne', 1]], liveWords: [['sonne', 1], ['neu', 1]],
    selectedOrientation: 'default', selectedTheme: 'confetti', customColors: ['#ff7100'],
    currentDesignNeedsSave: true, currentDesignEdited: false, editingOrderItemId: null, designRevision: 0, pendingConfiguration: null,
    workspaceReady: true, restorationFailed: false, orderActionPending: false,
    leavingPage: false, allowNavigation: false, suppressDirty: false,
    draftSaveTimer: null, draftSavePromise: null, draftSavedRevision: -1, draftStorageFailed: false,
    saveDesignButton: element(), continueOrderButton: element(), continueOrderLabel: element(), designAnotherButton: element(),
    headerCart: { hidden: true }, headerCartCount: element(),
    errorText: element(), saveStatus: element(), retryConfigurator: { hidden: true },
    content: { inert: false }, orderBox: { scrollIntoView() {} },
    cloudUpdateNotice: { hidden: true }, draftLossDialog: { open: false, close() {} },
    shippingChoiceDialog, shippingChoiceTitle: element(),
    shippingChoiceDescription: element(), shippingChoiceSave: element(),
    workspace: { close() {}, show: (panel) => calls.panels.push(panel) },
    mobileEditorMedia: { matches: false }, setMobileEditorExpanded() {},
    getAllSurfaceDesigns: () => ({ default: [{ text: 'sonne' }] }),
    productSurfaces: () => [{ key: 'default', label: 'Druckfläche' }],
    mugEditor: { flushPendingChange() {}, hasPendingTextChange: () => false },
    setText: (element, message) => { element.textContent = message; }, clearText: element => { element.textContent = ''; },
    t: message => message, renderOrderBox() {}, renderAll() {}, initEditor() {}, refreshWorkspaceLayout() {},
    initMug3D: async () => {}, finalizeCurrentText: async () => {},
    scheduleDraftSave() {}, loadLocalDraft: async () => null, applyLocalDraft: async () => {},
    askToLeaveWithoutDraft: async () => { calls.warnings.push('draft-loss'); return 'stay'; },
    loadOrderItems: () => cart.read(),
    addOrderItem: (data, { replaceId }) => cart.replace(data, replaceId),
    setOrderActionsBusy: value => calls.busy.push(value), updateCartActions() {},
    loadOrderItem: async target => calls.opened.push(target),
    history: { replaceState: (_, __, url) => calls.replaced.push(url) },
    location: { search: '', assign: url => calls.navigations.push(url) },
    fetch: async (_, options = {}) => {
      calls.posts++;
      if (options.body) calls.bodies.push(JSON.parse(options.body));
      return { ok: true, json: async () => ({ id: id(String(calls.posts)), productKey: 'mug' }) };
    },
    ...extra,
  });
  vm.runInContext(['saveCurrentDesign', 'approveCurrentDesign', 'hasUnsavedDesign', 'shippingAction', 'askShippingChoice',
    'draftSnapshot', 'updateCartActions', 'continueToShipping',
    'hasUnpersistedDraft', 'persistCurrentDraft', 'runNavigation', 'saveBeforeLeaving',
    'openOrderItem', 'removeOrderItem', 'navigateToShipping',
    'showRestorationError', 'initializeWorkspace', 'updateHeaderCart'].map(pageFunction).join('\n'), context);
  return { context, cart, local, drafts, calls };
}

test('cart storage is event-isolated, normalized, expiring and contains only approved references', () => {
  const browser = storage();
  let now = 1000;
  const cart = Session.createCart('one', browser, () => now);
  cart.replace({ id: id('a'), productKey: 'mug', designs: ['not stored'] });
  assert.equal(cart.read().length, 1);
  assert.equal(cart.read()[0].designs, undefined);
  assert.equal(Session.createCart('one', browser, () => now).read().length, 1);
  assert.deepEqual(Session.createCart('two', browser).read(), []);
  cart.replace({ id: id('b') }, id('a'));
  cart.replace({ id: id('b') });
  assert.deepEqual(cart.read().map(item => item.id), [id('b')]);
  now += Session.CART_TTL_MS + 1;
  assert.deepEqual(cart.read(), []);
  assert.match(fs.readFileSync(require.resolve('../public/js/configurator-session'), 'utf8'), /indexedDB|createDraftStore/);
});

test('the header cart appears only for saved designs and keeps an exact numeric badge', () => {
  const { context: page } = harness();
  page.updateHeaderCart([]);
  assert.equal(page.headerCart.hidden, true);
  assert.equal(page.headerCartCount.textContent, '');
  page.updateHeaderCart([{ id: id('a') }, { id: id('b') }]);
  assert.equal(page.headerCart.hidden, false);
  assert.equal(page.headerCartCount.textContent, '2');
  page.updateHeaderCart([]);
  assert.equal(page.headerCart.hidden, true, 'removing the last item hides the entry point immediately');
});

test('the former tab cart migrates once into the device-local cart', () => {
  const local = storage(), session = storage();
  session.setItem('wolkenworte-order:migration', JSON.stringify([{ id: id('a'), productKey: 'mug' }]));
  const previousLocal = global.localStorage;
  const previousSession = global.sessionStorage;
  global.localStorage = local;
  global.sessionStorage = session;
  try {
    assert.deepEqual(Session.createCart('migration').read().map(item => item.id), [id('a')]);
    assert.equal(session.getItem('wolkenworte-order:migration'), null);
    assert.ok(Number(local.getItem('wolkenworte-order:migration:expires')) > Date.now());
  } finally {
    if (previousLocal === undefined) delete global.localStorage;
    else global.localStorage = previousLocal;
    if (previousSession === undefined) delete global.sessionStorage;
    else global.sessionStorage = previousSession;
  }
});

test('local drafts restore by active design or product and expire without entering the cart', async () => {
  const backend = draftBackend();
  let now = 1000;
  const store = Session.createDraftStore('event-a', { backend, now: () => now });
  await store.save({ productKey: 'mug', orientation: 'default', theme: 'confetti',
    words: [['Liebe', 2]], designs: { default: [{ text: 'Liebe' }] },
    layoutVersion: '/js/wordcloud-core.js?v=current', designRevision: 4 });
  assert.equal((await store.loadActive()).designRevision, 4);
  assert.equal((await store.loadActive()).layoutVersion, '/js/wordcloud-core.js?v=current');
  assert.equal((await store.loadFor({ productKey: 'mug' })).words[0][0], 'Liebe');
  assert.deepEqual(Session.createCart('event-a', storage()).read(), []);
  await store.save({ productKey: 'poster', orientation: 'landscape', theme: 'confetti',
    words: [['Neu', 1]], designs: { default: [{ text: 'Neu' }] } });
  await store.clearActive();
  assert.equal(await store.loadActive(), null);
  assert.equal((await store.loadFor({ productKey: 'mug' })).designRevision, 4,
    'clearing the current draft does not erase unrelated product drafts');
  now += Session.DRAFT_TTL_MS + 1;
  assert.equal(await store.loadFor({ productKey: 'mug' }), null);
  assert.equal(typeof store.close, 'function');
});

test('Safari-stalled draft reads are retried and can never leave restoration pending forever', async () => {
  let reads = 0;
  let closes = 0;
  const context = vm.createContext({
    draftStore: {
      loadActive: () => { reads += 1; return new Promise(() => {}); },
      loadFor: () => { reads += 1; return new Promise(() => {}); },
      close: () => { closes += 1; },
    },
    WolkenworteConfiguratorSession: {
      withTimeout: async () => { throw new Error('operation_timeout'); },
    },
    console: { warn() {} },
    draftStorageFailed: false,
    AUTOMATIC_LAYOUT_VERSION: '/js/wordcloud-core.js?v=current|/js/design-layout.js?v=current',
  });
  vm.runInContext(pageFunction('loadLocalDraft'), context);
  assert.equal(await context.loadLocalDraft(), null);
  assert.equal(reads, 2);
  assert.equal(closes, 2);
  assert.equal(context.draftStorageFailed, true);
});

test('transient startup work retries once but permanent empty clouds do not', async () => {
  const context = vm.createContext({ setTimeout, Promise });
  vm.runInContext(pageFunction('retryStartupTask'), context);
  let attempts = 0;
  assert.equal(await context.retryStartupTask(async () => {
    attempts += 1;
    if (attempts === 1) throw new Error('temporary');
    return 'ready';
  }), 'ready');
  assert.equal(attempts, 2);

  attempts = 0;
  await assert.rejects(context.retryStartupTask(async () => {
    attempts += 1;
    throw new Error('no_words');
  }), /no_words/);
  assert.equal(attempts, 1);
  assert.match(template, /fetch\(`\/api\/events\/\$\{encodeURIComponent\(slug\)\}\/configurator`, \{\s*cache: 'no-store'/);
  assert.match(template, /id="loading-message"[\s\S]*?id="retry-configurator-loading"/);
});

test('a layout release replaces only untouched automatic drafts', async () => {
  for (const edited of [false, true]) {
    const backend = draftBackend();
    const draftStore = Session.createDraftStore('event-a', { backend });
    await draftStore.save({
      productKey: 'mug', orientation: 'default', theme: 'confetti',
      words: [['Liebe', 1]], designs: { default: [{ text: 'Liebe' }] },
      layoutVersion: '/js/wordcloud-core.js?v=previous',
      currentDesignEdited: edited,
    });
    const { context: page } = harness({ draftStore });
    vm.runInContext(pageFunction('loadLocalDraft'), page);
    const restored = await page.loadLocalDraft();
    assert.equal(Boolean(restored), edited);
    assert.equal(Boolean(await draftStore.loadActive()), edited);
  }
});

test('a resized local draft restores after the word-cloud round trip and unlocks the workspace', async () => {
  const backend = draftBackend();
  const draftStore = Session.createDraftStore('event-a', { backend });
  await draftStore.save({
    productKey: 'mug', orientation: 'default', theme: 'confetti',
    words: [['tanzen', 1]],
    designs: { default: [{ id: 'tanzen', text: 'tanzen', fontSize: 406 }] },
    currentDesignEdited: true, designRevision: 1,
  });
  let restored = null;
  const { context: page } = harness({
    draftStore,
    workspaceReady: false,
    location: { search: '' },
    applyLocalDraft: async draft => { restored = draft; },
  });
  vm.runInContext(pageFunction('loadLocalDraft'), page);
  await page.initializeWorkspace();
  assert.equal(restored.designs.default[0].fontSize, 406);
  assert.equal(page.workspaceReady, true);
  assert.equal(page.restorationFailed, false);
  assert.equal(page.content.inert, false);
});

test('draft connections close whenever Safari suspends or replaces a configurator page', () => {
  const sessionSource = fs.readFileSync(require.resolve('../public/js/configurator-session'), 'utf8');
  assert.match(sessionSource, /database\.onversionchange\s*=\s*\(\)\s*=>\s*\{[\s\S]*?database\.close\(\)/);
  assert.match(template, /window\.addEventListener\('pagehide',[\s\S]*?draftStore\.close\(\)/);
  assert.match(template, /visibilitychange[\s\S]*?persistCurrentDraft\([\s\S]*?\.finally\(\(\)\s*=>\s*draftStore\.close\(\)\)/);
});

test('full carts reject an addition but allow replacing a position', () => {
  const cart = Session.createCart('full', storage());
  cart.write(Array.from({ length: 20 }, (_, i) => ({ id: String(i).padStart(16, '0') })));
  assert.throws(() => cart.replace({ id: id('a') }), /cart_full/);
  cart.replace({ id: id('a') }, '0'.repeat(16));
  assert.equal(cart.read().length, 20);
  assert.equal(cart.read()[0].id, id('a'));
});

test('explicit Add saves once; unchanged repeats do not duplicate; edits replace the position', async () => {
  const { context: page, cart, calls } = harness();
  assert.equal(await page.saveCurrentDesign(page.saveDesignButton), true);
  assert.equal(await page.saveCurrentDesign(page.saveDesignButton), true);
  assert.equal(calls.posts, 1);
  page.currentDesignNeedsSave = true;
  page.designRevision++;
  assert.equal(await page.saveCurrentDesign(page.saveDesignButton), true);
  assert.equal(calls.posts, 2);
  assert.deepEqual(cart.read().map(item => item.id), [id('2')]);
});

test('explicit approval sends every whole-word style in the immutable surface snapshot', async () => {
  const styled = [{ id: 'word', text: 'Liebe ❤️', x: 1200, y: 500, fontSize: 140,
    angle: 12, color: '#2455f5', fontFamily: 'montserrat', fontWeight: 700,
    fontStyle: 'italic', underline: true, linethrough: true }];
  const { context: page, calls } = harness({
    getAllSurfaceDesigns: () => ({ default: styled }),
  });
  assert.equal(await page.saveCurrentDesign(page.saveDesignButton), true);
  assert.equal(calls.bodies.length, 1);
  assert.deepEqual(JSON.parse(JSON.stringify(calls.bodies[0].designs.default)), styled);
});

test('an empty cart never navigates, while the explicit continuation action adds then continues', async () => {
  const { context: page, calls, cart } = harness();
  await page.runNavigation(page.navigateToShipping);
  assert.equal(calls.posts, 0);
  assert.equal(calls.navigations.length, 0);
  assert.match(page.errorText.textContent, /zuerst ein Design/);
  await page.continueToShipping();
  assert.equal(cart.read().length, 1);
  assert.equal(calls.posts, 1);
  assert.match(calls.navigations[0], /shipping\?configuration=1111111111111111&edit=1111111111111111/);
  assert.match(template, /if \(action === 'add'\) \{\s*if \(!await saveCurrentDesign\(continueOrderButton\)\) return/);
});

test('shipping action reflects whether the cart can continue without omitting current work', () => {
  const { context: page, cart } = harness();
  assert.equal(page.shippingAction(), 'add');
  page.updateCartActions();
  assert.equal(page.continueOrderLabel.textContent, 'In den Warenkorb & zur Lieferadresse');

  cart.replace({ id: id('a') });
  assert.equal(page.shippingAction(), 'choose-add');
  page.updateCartActions();
  assert.equal(page.continueOrderLabel.textContent, 'Zur Lieferadresse');

  page.editingOrderItemId = id('a');
  page.currentDesignNeedsSave = false;
  assert.equal(page.shippingAction(), 'continue');
  page.currentDesignNeedsSave = true;
  assert.equal(page.shippingAction(), 'choose-update');
});

test('the shipping choice explains add and update cases and resolves the explicit selection', async () => {
  for (const action of ['choose-add', 'choose-update']) {
    const { context: page, calls } = harness();
    const choice = page.askShippingChoice(action);
    assert.equal(calls.panels.length, 1);
    assert.match(page.shippingChoiceDescription.textContent, action === 'choose-update'
      ? /Änderungen.*gespeicherten Version/ : /noch nicht im Warenkorb/);
    assert.equal(page.shippingChoiceSave.textContent, action === 'choose-update'
      ? 'Änderungen übernehmen und weiter' : 'In den Warenkorb und weiter');
    page.shippingChoiceDialog.close('cart');
    assert.equal(await choice, 'cart');
  }
});

test('a new draft can be added or left outside an existing cart when continuing', async () => {
  for (const choice of ['save', 'cart']) {
    const { context: page, cart, calls, drafts } = harness();
    cart.replace({ id: id('a') });
    page.askShippingChoice = async action => {
      assert.equal(action, 'choose-add');
      return choice;
    };
    await page.continueToShipping();
    assert.equal(calls.posts, choice === 'save' ? 1 : 0);
    assert.deepEqual(cart.read().map(item => item.id), choice === 'save'
      ? [id('a'), id('1')] : [id('a')]);
    assert.equal(calls.navigations.length, 1);
    if (choice === 'cart') {
      assert.ok([...drafts.records.values()].some(record => record.type === 'draft'));
    }
  }
});

test('unchanged cart work continues directly, while edited work can retain or replace its saved version', async () => {
  for (const choice of ['direct', 'cart', 'save']) {
    const edited = choice !== 'direct';
    const { context: page, cart, calls } = harness({
      editingOrderItemId: id('a'), currentDesignNeedsSave: edited,
    });
    cart.replace({ id: id('a') });
    page.askShippingChoice = async action => {
      assert.equal(action, 'choose-update');
      return choice;
    };
    await page.continueToShipping();
    assert.equal(calls.posts, choice === 'save' ? 1 : 0);
    assert.deepEqual(cart.read().map(item => item.id), choice === 'save' ? [id('1')] : [id('a')]);
    assert.equal(calls.navigations.length, 1);
  }
});

test('only failed local persistence opens the focused leave-without-draft warning', async () => {
  const { context: page } = harness();
  let close;
  page.draftLossTitle = { focus: () => { page.focusedLeaveElement = 'title'; } };
  page.draftLossDialog = { returnValue: '', addEventListener: (_, listener) => { close = listener; }, showModal() {} };
  vm.runInContext(pageFunction('askToLeaveWithoutDraft'), page);
  const choice = page.askToLeaveWithoutDraft();
  assert.equal(page.focusedLeaveElement, 'title');
  page.draftLossDialog.returnValue = 'stay'; close();
  assert.equal(await choice, 'stay');
});

test('saved shipping return does not prompt or approve again', async () => {
  const { context: page, cart, calls } = harness({ currentDesignNeedsSave: false, editingOrderItemId: id('a') });
  cart.replace({ id: id('a') });
  await page.runNavigation(page.navigateToShipping);
  assert.equal(calls.warnings.length, 0);
  assert.equal(calls.posts, 0);
  assert.equal(calls.navigations.length, 1);
});

function switchingHarness(extra = {}) {
  const state = harness(extra);
  const page = state.context;
  page.startingAnotherProduct = false;
  page.productDialogCloseReason = 'cancel';
  page.dialogSelectedProduct = () => ({ key: 'pillow' });
  page.resetProductDialogSelection = () => {};
  page.closeProductDialog = () => {};
  page.updateProductOptionSelection = () => {};
  page.closeToolbarMenus = () => {};
  page.buildOrientationOptions = () => {};
  state.calls.switches = [];
  page.startProductDesign = async (product, orientation, options) =>
    state.calls.switches.push([product.key, orientation, options]);
  vm.runInContext(['confirmProductDialog', 'activateOrientation', 'markDirty'].map(pageFunction).join('\n'), page);
  return state;
}

test('an untouched automatic product switches directly, while selecting the same product is a no-op', async () => {
  const { context: page, calls } = switchingHarness();
  await page.confirmProductDialog();
  assert.equal(calls.switches[0][0], 'pillow');
  assert.equal(calls.switches[0][1], undefined);
  assert.equal(calls.switches[0][2].preserveEditingItem, false);
  assert.equal(calls.warnings.length, 0);
  assert.equal(calls.posts, 0, 'an automatic design is not silently added to the basket');
  page.dialogSelectedProduct = () => page.product;
  await page.confirmProductDialog();
  assert.equal(calls.switches.length, 1);
});

test('edited product and orientation changes autosave locally and switch without cart writes or routine dialogs', async () => {
  for (const action of ['product', 'orientation']) {
    const { context: page, calls, cart, drafts } = switchingHarness({ currentDesignEdited: true });
    if (action === 'product') await page.confirmProductDialog();
    else await page.activateOrientation({ key: 'landscape' });
    assert.equal(calls.warnings.length, 0, action);
    assert.equal(calls.switches.length, 1, action);
    assert.equal(cart.read().length, 0);
    assert.equal(calls.posts, 0, 'draft autosave never creates a server configuration');
    assert.ok([...drafts.records.values()].some(record => record.type === 'draft'));
    assert.equal(page.leavingPage, false);
  }
});

test('pending text is finalized into the local draft before switching, and failed persistence retains the design', async () => {
  const { context: page, calls } = switchingHarness();
  page.finalizeCurrentText = async () => page.markDirty();
  await page.confirmProductDialog();
  assert.equal(calls.switches.length, 1);
  page.finalizeCurrentText = async () => { throw new Error('font failed'); };
  page.dialogSelectedProduct = () => ({ key: 'poster' });
  await page.confirmProductDialog();
  assert.equal(calls.switches.length, 1);
  assert.match(page.errorText.textContent, /Entwurf konnte/);
});

test('Design another product starts a separate design even when choosing the same product', async () => {
  const { context: page, calls } = switchingHarness({ currentDesignEdited: true });
  page.startingAnotherProduct = true;
  page.dialogSelectedProduct = () => page.product;
  await page.confirmProductDialog();
  assert.equal(calls.warnings.length, 0);
  assert.deepEqual(calls.switches, [['mug', undefined, undefined]]);
  assert.match(template, /designAnotherButton\.addEventListener\('click',[\s\S]*?openProductDialog\(\)/);
  assert.doesNotMatch(template, /designAnotherButton\.addEventListener[\s\S]{0,200}runNavigation/);
});

test('new product designs refresh the cloud and detach from a saved basket item only after loading succeeds', async () => {
  for (const failure of [null, 'network', 'empty', 'font']) {
    const { context: page, cart, calls } = switchingHarness({ editingOrderItemId: id('a'), currentDesignEdited: true });
    cart.replace({ id: id('a'), productKey: 'mug' });
    const previousWords = page.words;
    page.fetch = async () => {
      if (failure === 'network') throw new Error('offline');
      return { ok: true, json: async () => ({ words: failure === 'empty' ? [] : [['neu', 2]] }) };
    };
    page.DesignFonts = { DEFAULT_FONT_KEY: 'classic' };
    page.ensureDesignFonts = async () => { if (failure === 'font') throw new Error('font failed'); };
    page.WolkenworteEmoji = { preloadTexts: async () => {} };
    page.selectProduct = (product, orientation) => {
      calls.switches.push([product.key, orientation, page.words]);
      page.product = product;
    };
    vm.runInContext(pageFunction('startProductDesign'), page);
    const result = await page.startProductDesign({ key: 'poster' }, 'landscape');
    assert.equal(result, !failure);
    assert.equal(calls.switches.length, failure ? 0 : 1);
    assert.equal(page.editingOrderItemId, failure ? id('a') : null);
    assert.equal(page.currentDesignEdited, Boolean(failure));
    assert.deepEqual(cart.read().map(item => item.id), [id('a')], 'approved work stays in the cart');
    if (failure) assert.equal(page.words, previousWords);
    else assert.deepEqual(calls.switches[0], ['poster', 'landscape', [['neu', 2]]]);
    assert.equal(page.orderActionPending, false);
    assert.equal(page.suppressDirty, false);
  }
});

test('a new draft stays outside a nonempty cart when navigating to shipping', async () => {
  const { context: page, cart, calls, drafts } = harness();
  cart.replace({ id: id('a') });
  await page.runNavigation(page.navigateToShipping);
  assert.equal(calls.posts, 0);
  assert.deepEqual(cart.read().map(item => item.id), [id('a')]);
  assert.match(calls.navigations[0], /configuration=aaaaaaaaaaaaaaaa/);
  assert.ok([...drafts.records.values()].some(record => record.type === 'draft'));
});

test('Home and word-cloud links autosave locally, capture href and navigate without a routine dialog', async () => {
  for (const destination of ['/', '/e/event-a']) {
    const { context: page, calls, drafts } = harness();
    const event = { button: 0, currentTarget: { href: destination }, preventDefault() {} };
    const done = page.saveBeforeLeaving(event);
    event.currentTarget = null;
    await done;
    assert.equal(calls.posts, 0);
    assert.deepEqual(calls.navigations, [destination]);
    assert.equal(calls.warnings.length, 0);
    assert.ok([...drafts.records.values()].some(record => record.type === 'draft'));
  }
});

test('a failed draft write is the only leave warning and the user remains in control', async () => {
  for (const choice of ['stay', 'leave']) {
    const failingDraftStore = { save: async () => { throw new Error('blocked'); } };
    const { context: page, calls } = harness({ draftStore: failingDraftStore,
      askToLeaveWithoutDraft: async () => { calls.warnings.push('draft-loss'); return choice; } });
    await page.saveBeforeLeaving({ button: 0, currentTarget: { href: '/e/event-a' }, preventDefault() {} });
    assert.deepEqual(calls.navigations, choice === 'leave' ? ['/e/event-a'] : []);
    assert.deepEqual(calls.warnings, ['draft-loss']);
  }
});

test('modified and new-tab links are never intercepted', async () => {
  const { context: page, calls } = harness();
  for (const event of [{ button: 1 }, { button: 0, metaKey: true },
    { button: 0, currentTarget: { href: '/datenschutz', target: '_blank' } }]) {
    await page.saveBeforeLeaving({ preventDefault() { throw new Error('intercepted'); }, ...event });
  }
  assert.equal(calls.warnings.length, 0);
});

test('a pending save blocks repeated clicks and navigation until it succeeds', async () => {
  let finish;
  const { context: page, calls } = harness({ fetch: () => new Promise(resolve => { finish = resolve; }) });
  const first = page.saveCurrentDesign(page.saveDesignButton);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(await page.saveCurrentDesign(page.saveDesignButton), false);
  await page.runNavigation(page.navigateToShipping, { shipping: true });
  assert.equal(calls.navigations.length, 0);
  finish({ ok: true, json: async () => ({ id: id('a') }) });
  assert.equal(await first, true);
  assert.equal(page.orderActionPending, false);
});

test('server approval failure keeps the editor and does not navigate or add an item', async () => {
  const { context: page, cart, calls } = harness({
    fetch: async () => { throw new Error('offline'); },
  });
  assert.equal(await page.saveCurrentDesign(page.continueOrderButton), false);
  assert.deepEqual(cart.read(), []);
  assert.equal(calls.navigations.length, 0);
  assert.equal(page.currentDesignNeedsSave, true);
  assert.equal(page.leavingPage, false);
  assert.equal(page.orderActionPending, false);
  assert.match(page.errorText.textContent, /nicht gespeichert/);
});

test('cart storage failure is detected before a POST and an acknowledged snapshot is reused on storage retry', async () => {
  const { context: page, local, calls } = harness();
  const read = local.getItem;
  local.getItem = () => { throw new Error('blocked'); };
  assert.equal(await page.saveCurrentDesign(page.saveDesignButton), false);
  assert.equal(calls.posts, 0);
  local.getItem = read;
  const add = page.addOrderItem;
  page.addOrderItem = () => { throw new Error('quota after response'); };
  assert.equal(await page.saveCurrentDesign(page.saveDesignButton), false);
  assert.equal(calls.posts, 1);
  page.addOrderItem = add;
  assert.equal(await page.saveCurrentDesign(page.saveDesignButton), true);
  assert.equal(calls.posts, 1);
});

test('removing an active position cannot silently re-add it on navigation', async () => {
  const { context: page, cart, calls } = harness({ editingOrderItemId: id('a'), currentDesignNeedsSave: false });
  cart.replace({ id: id('a') });
  page.removeOrderItem(id('a'));
  assert.equal(page.editingOrderItemId, null);
  assert.equal(page.currentDesignNeedsSave, true);
  await page.runNavigation(page.navigateToShipping, { shipping: true });
  assert.equal(calls.posts, 0);
  assert.deepEqual(cart.read(), []);
});

test('fresh entry restores the active local draft while explicit edit and cart entry open saved designs', async () => {
  for (const search of ['', '?edit=aaaaaaaaaaaaaaaa', '?cart=1']) {
    let restoredDraft = false;
    const { context: page, cart, calls } = harness({ workspaceReady: false,
      location: { search }, words: [['sonne', 1], ['neu', 1]],
      loadLocalDraft: async () => ({ productKey: 'mug' }),
      applyLocalDraft: async () => { restoredDraft = true; },
    });
    cart.replace({ id: id('a') });
    await page.initializeWorkspace();
    assert.deepEqual(calls.opened, search ? [id('a')] : []);
    assert.equal(restoredDraft, search === '');
    assert.equal(page.words.length, 2);
    assert.equal(page.workspaceReady, true);
    assert.equal(page.content.inert, false);
  }
  assert.match(template, /const localDraft = await loadLocalDraft\(\)/);
});

test('loading a saved design uses a matching local working copy before its immutable server snapshot', async () => {
  const { context: page, cart, calls } = harness();
  cart.replace({ id: id('a') });
  let restored;
  let local = true;
  page.loadLocalDraft = async () => local ? ({ editingOrderItemId: id('a'), productKey: 'mug' }) : null;
  page.applyLocalDraft = async data => { restored = data; };
  page.fetch = async url => { assert.match(url, /aaaaaaaaaaaaaaaa\/edit$/); return {
    ok: true, json: async () => ({ id: id('a'), words: [['alt', 1]], designs: { default: [] } }),
  }; };
  page.applySavedConfiguration = async data => { restored = data; };
  vm.runInContext(pageFunction('loadOrderItem'), page);
  await page.loadOrderItem(id('a'));
  assert.equal(restored.editingOrderItemId, id('a'));
  assert.equal(calls.posts, 0);
  local = false;
  restored = null;
  await page.loadOrderItem(id('a'));
  assert.deepEqual(restored.words, [['alt', 1]]);
  assert.equal(page.currentDesignNeedsSave, false);
  assert.equal(page.editingOrderItemId, id('a'));
  assert.equal(calls.posts, 0);
  assert.equal(page.orderActionPending, false);
});

test('failed initialization always unlocks and blocks approving a partial design', async () => {
  for (const stage of ['editor', 'saved']) {
    const { context: page } = harness({ workspaceReady: false,
      location: { search: '?edit=aaaaaaaaaaaaaaaa' },
      initEditor() { if (stage === 'editor') throw new Error('editor failure'); },
      loadOrderItem: async () => { throw new Error('restore failure'); },
    });
    await page.initializeWorkspace();
    assert.equal(page.restorationFailed, true);
    assert.equal(page.content.inert, false);
    assert.equal(await page.saveCurrentDesign(), false);
    assert.equal(page.retryConfigurator.hidden, false);
  }
});

test('page-history return reloads authoritative state without a second leave warning', () => {
  const start = template.indexOf("    window.addEventListener('pageshow'");
  const source = template.slice(start, template.indexOf('\n    });', start) + '\n    });'.length);
  let callback, reloads = 0;
  const context = vm.createContext({
    window: { addEventListener: (_, fn) => { callback = fn; } },
    allowNavigation: false, leavingPage: true, orderActionPending: true, workspaceReady: true,
    content: { inert: true }, draftLossDialog: { open: false }, location: { reload: () => reloads++ },
  });
  vm.runInContext(source, context);
  callback({ persisted: true });
  assert.equal(reloads, 1);
  assert.equal(context.allowNavigation, true);
  assert.equal(context.content.inert, false);
});

test('shipping drafts retain addresses and quantities across replacement, never trusted prices', () => {
  const session = storage();
  const shipping = Session.createShippingDraft('a', session);
  shipping.write([{ recipient: { name: 'Test', city: 'Berlin' }, items: [
    { configurationId: id('a'), quantity: 3 }, { configurationId: id('b'), quantity: 0 },
  ], totalCents: 999 }]);
  shipping.replaceConfiguration(id('a'), id('c'));
  const restored = shipping.restore([id('c'), id('b')])[0];
  assert.equal(restored.recipient.name, 'Test');
  assert.equal(restored.items[0].quantity, 3);
  assert.equal(restored.items[0].configurationId, id('c'));
  assert.equal(restored.items[1].quantity, 0);
  assert.equal(restored.totalCents, undefined);
  assert.equal(Session.createShippingDraft('other', session).restore([id('c')]), null);
});

test('payment cleanup removes only confirmed purchased IDs and expires the device-local receipt fence', () => {
  const session = storage(), cart = Session.createCart('a', session);
  cart.write([{ id: id('a') }, { id: id('b') }]);
  Session.createCart('other', session).write([{ id: id('a') }]);
  assert.equal(Session.clearPurchased('a', { paymentConfirmed: false, configurationIds: [id('a')] }, { storage: session }), false);
  assert.equal(cart.read().length, 2);
  assert.equal(Session.clearPurchased('a', { paymentConfirmed: true, configurationIds: [id('a')] }, { storage: session }), true);
  assert.deepEqual(cart.read().map(item => item.id), [id('b')]);
  assert.equal(Session.createCart('other', session).read().length, 1);
  assert.deepEqual(Session.purchasedIds('a', session), [id('a')]);
  assert.ok(Number(session.getItem('wolkenworte-purchased:a:expires')) > Date.now());
});

test('legacy address splits are discarded instead of silently moving products to the first address', () => {
  const session = storage();
  session.setItem('wolkenworte-shipping-draft:a', JSON.stringify({ version: 1,
    expiresAt: Date.now() + 10000, shipments: [
      { recipient: { city: 'Berlin' }, items: [{ configurationId: id('a'), quantity: 2 }] },
      { recipient: { city: 'Paris' }, items: [{ configurationId: id('b'), quantity: 3 }] },
    ] }));
  const draft = Session.createShippingDraft('a', session);
  assert.equal(draft.restore([id('a'), id('b')]), null);
  assert.equal(session.getItem('wolkenworte-shipping-draft:a'), null);
  assert.equal(draft.write([{}, {}]), false);
});

test('reorder preserves other basket positions and quantities but starts with an empty address', () => {
  const session = storage(), cart = Session.createCart('a', session);
  cart.write([{ id: id('a') }]);
  const shipping = Session.createShippingDraft('a', session);
  shipping.write([{ recipient: { name: 'Alte Adresse', city: 'Berlin' },
    items: [{ configurationId: id('a'), quantity: 4 }] }]);
  const copies = [{ id: id('b'), productKey: 'mug', quantity: 2 }];
  assert.deepEqual(Session.prepareReorder('a', copies, session), [id('a'), id('b')]);
  const draft = shipping.restore([id('a'), id('b')])[0];
  assert.ok(Object.values(draft.recipient).every((value) => value === ''));
  assert.deepEqual(draft.items.map((item) => item.quantity), [4, 2]);
  assert.deepEqual(Session.prepareReorder('a', copies, session), [id('a'), id('b')], 'storage retries do not duplicate copies');
  assert.deepEqual(Session.createCart('other', session).read(), []);
});

test('reorder never silently truncates a full basket or navigates with unsaved shipping state', () => {
  const session = storage(), cart = Session.createCart('a', session);
  const full = Array.from({ length: 20 }, (_, index) => ({ id: String(index).padStart(16, 'a') }));
  cart.write(full);
  assert.throws(() => Session.prepareReorder('a', [{ id: id('z'), quantity: 1 }], session), /cart_full/);
  assert.equal(cart.read().length, 20);
  cart.write([{ id: id('a') }]);
  const failing = { ...session, setItem(key, value) {
    if (key.includes('shipping-draft')) throw new Error('quota');
    session.setItem(key, value);
  } };
  assert.throws(() => Session.prepareReorder('a', [{ id: id('b'), quantity: 1 }], failing), /storage_unavailable/);
  assert.deepEqual(cart.read().map((item) => item.id), [id('a')]);
});

test('final text is awaited before capture and unchanged text does not dirty a restored design', async () => {
  let design = [{ text: 'liebe' }];
  let dirty = 0;
  const context = vm.createContext({ WolkenworteConfiguratorSession: Session, suppressDirty: false, markDirty() { dirty += 1; },
    mugEditor: {
      flushPendingChange() {}, getDesign: () => design,
      commitFontSizeInput() {},
      async commitTextInput() { await new Promise((resolve) => setTimeout(resolve, 1)); },
    },
  });
  vm.runInContext(pageFunction('finalizeCurrentText'), context);
  await context.finalizeCurrentText();
  assert.equal(dirty, 0);
  context.mugEditor.commitTextInput = async () => {
    await new Promise((resolve) => setTimeout(resolve, 1));
    design = [{ text: 'letzte Eingabe' }];
  };
  await context.finalizeCurrentText();
  assert.equal(dirty, 1);
  assert.equal(context.suppressDirty, false);
  let finishFont;
  context.mugEditor.pendingFontChange = new Promise(resolve => { finishFont = resolve; });
  let committed = false;
  context.mugEditor.commitTextInput = async () => { committed = true; };
  const finalizing = context.finalizeCurrentText();
  await Promise.resolve();
  assert.equal(committed, false, 'Save must wait for a pending font download before reading the design');
  finishFont();
  await finalizing;
  assert.equal(committed, true);
});

test('restoration flushes its scheduled editor change while dirty tracking is suppressed', () => {
  const frames = new Map();
  let frameId = 0, dirty = 0, suppressed = true;
  const root = {};
  const context = vm.createContext({ window: root,
    requestAnimationFrame(callback) { const id = ++frameId; frames.set(id, callback); return id; },
    cancelAnimationFrame(id) { frames.delete(id); },
  });
  vm.runInContext(fs.readFileSync(path.join(__dirname, '../public/js/mug-editor.js'), 'utf8'), context);
  const editor = Object.create(root.MugPrintEditor.prototype);
  editor.getDesign = () => [{ text: 'liebe' }];
  editor.onChange = () => { if (!suppressed) dirty += 1; };
  editor.emitChange();
  editor.flushPendingChange();
  suppressed = false;
  assert.equal(frames.size, 0);
  assert.equal(dirty, 0);
  editor.emitChange();
  editor.flushPendingChange();
  assert.equal(dirty, 1);
  assert.match(pageFunction('applySavedConfiguration'), /finally \{\s*mugEditor\.flushPendingChange\(\);\s*suppressDirty = false/);
});


test('a failed 3D initialization exposes retry and never introduces a flat mug', async () => {
  const states = [];
  const page = vm.createContext({ product: { previewType: 'mug', key: 'mug' },
    mug3D: null, mug3DLoadPromise: null, mug3DGeneration: 0, mugViewer: {},
    window: { THREE: {} }, console: { warn() {} },
    Mug3DViewer: { create() { throw new Error('WebGL unavailable'); } },
    setMugPreviewState: state => states.push(state), updateMug3DTexture() {},
    destroyMug3D() { page.mug3D = null; page.mug3DLoadPromise = null; page.mug3DGeneration += 1; },
  });
  vm.runInContext(pageFunction('initMug3D'), page);
  await page.initMug3D();
  assert.deepEqual(states, ['loading', 'error']);
  page.Mug3DViewer.create = () => ({});
  await page.initMug3D();
  assert.equal(states.at(-1), 'ready');
  assert.doesNotMatch(template, /mug-fallback|mug-art|using 2D fallback/);
  assert.match(template, /id="retry-mug-preview"/);
});
