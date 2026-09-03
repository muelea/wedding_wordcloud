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

test('checkout actions keep only errors visible and use quiet idle and hover states', () => {
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
  assert.doesNotMatch(template, /id="leave-design-cancel"[^>]*autofocus/);
  assert.match(template, /leaveDialog\.showModal\(\);\s*leaveTitle\.focus/);
});

function pageFunction(name) {
  const start = template.search(new RegExp('    (?:async )?function ' + name + '\\('));
  assert.notEqual(start, -1, name);
  return template.slice(start, template.indexOf('\n    }', start) + '\n    }'.length);
}
const id = character => character.repeat(16);
function harness(extra = {}) {
  const local = storage();
  const cart = Session.createCart('event-a', local);
  const calls = { posts: 0, bodies: [], navigations: [], dialogs: [], opened: [], busy: [], replaced: [] };
  const element = () => ({ textContent: '', disabled: false, hidden: false });
  const context = vm.createContext({
    AbortSignal, URLSearchParams, setTimeout, clearTimeout, console: { warn() {} },
    WolkenworteConfiguratorSession: Session, sessionStorage: local, cart,
    CloudLimits: require('../public/js/cloud-limits'),
    slug: 'event-a', guestId: 'a'.repeat(32), product: { key: 'mug' },
    words: [['sonne', 1]], liveWords: [['sonne', 1], ['neu', 1]],
    selectedOrientation: 'default', selectedTheme: 'confetti',
    currentDesignNeedsSave: true, editingOrderItemId: null, designRevision: 0, pendingConfiguration: null,
    workspaceReady: true, restorationFailed: false, orderActionPending: false,
    leavingPage: false, allowNavigation: false, suppressDirty: false,
    saveDesignButton: element(), continueOrderButton: element(), designAnotherButton: element(),
    errorText: element(), saveStatus: element(), retryConfigurator: { hidden: true },
    content: { inert: false }, orderBox: { scrollIntoView() {} },
    getAllSurfaceDesigns: () => ({ default: [{ text: 'sonne' }] }),
    productSurfaces: () => [{ key: 'default', label: 'Druckfläche' }],
    mugEditor: { flushPendingChange() {}, hasPendingTextChange: () => false },
    setText: (element, message) => { element.textContent = message; }, clearText: element => { element.textContent = ''; },
    t: message => message, renderOrderBox() {}, renderAll() {}, initEditor() {}, refreshWorkspaceLayout() {},
    initMug3D: async () => {}, finalizeCurrentText: async () => {},
    loadOrderItems: () => cart.read(),
    addOrderItem: (data, { replaceId }) => cart.replace(data, replaceId),
    setOrderActionsBusy: value => calls.busy.push(value), updateCartActions() {},
    askBeforeLeaving: async options => { calls.dialogs.push(options); return 'cancel'; },
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
  vm.runInContext(['saveCurrentDesign', 'approveCurrentDesign', 'hasUnsavedDesign', 'confirmLeaving',
    'runNavigation', 'saveBeforeLeaving', 'openOrderItem', 'removeOrderItem', 'navigateToShipping',
    'showRestorationError', 'initializeWorkspace'].map(pageFunction).join('\n'), context);
  return { context, cart, local, calls };
}

test('cart storage is tab-scoped, event-isolated, normalized and never contains canvas drafts', () => {
  const firstTab = storage(), secondTab = storage();
  const cart = Session.createCart('one', firstTab);
  cart.replace({ id: id('a'), productKey: 'mug', designs: ['not stored'] });
  assert.equal(cart.read().length, 1);
  assert.equal(cart.read()[0].designs, undefined);
  assert.equal(Session.createCart('one', firstTab).read().length, 1);
  assert.deepEqual(Session.createCart('two', firstTab).read(), []);
  assert.deepEqual(Session.createCart('one', secondTab).read(), []);
  cart.replace({ id: id('b') }, id('a'));
  cart.replace({ id: id('b') });
  assert.deepEqual(cart.read().map(item => item.id), [id('b')]);
  assert.doesNotMatch(fs.readFileSync(require.resolve('../public/js/configurator-session'), 'utf8'), /indexedDB|createDraftStore/);
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

test('empty-cart shipping requires confirmation and never leaves on cancel', async () => {
  const { context: page, calls, cart } = harness();
  await page.runNavigation(page.navigateToShipping, { shipping: true });
  assert.equal(calls.dialogs.length, 1);
  assert.equal(calls.posts, 0);
  assert.equal(calls.navigations.length, 0);
  page.askBeforeLeaving = async () => 'save';
  await page.runNavigation(page.navigateToShipping, { shipping: true });
  assert.equal(cart.read().length, 1);
  assert.equal(calls.posts, 1);
  assert.match(calls.navigations[0], /shipping\?configuration=1111111111111111&edit=1111111111111111/);
});

test('empty-cart dialog offers current-design confirmation and no impossible discard-and-ship', async () => {
  const { context: page } = harness();
  let close;
  page.leaveDescription = {};
  page.leaveSaveButton = {};
  page.leaveDiscardButton = {};
  page.leaveTitle = { focus: () => { page.focusedLeaveElement = 'title'; } };
  page.leaveDialog = { addEventListener: (_, listener) => { close = listener; }, showModal() {} };
  vm.runInContext(pageFunction('askBeforeLeaving'), page);
  const choice = page.askBeforeLeaving({ shipping: true });
  assert.equal(page.focusedLeaveElement, 'title');
  assert.equal(page.leaveDiscardButton.hidden, true);
  assert.match(page.leaveDescription.textContent, /Warenkorb ist noch leer/);
  page.leaveDialog.returnValue = 'cancel'; close();
  assert.equal(await choice, 'cancel');
});

test('saved shipping return does not prompt or approve again', async () => {
  const { context: page, cart, calls } = harness({ currentDesignNeedsSave: false, editingOrderItemId: id('a') });
  cart.replace({ id: id('a') });
  await page.runNavigation(page.navigateToShipping, { shipping: true });
  assert.equal(calls.dialogs.length, 0);
  assert.equal(calls.posts, 0);
  assert.equal(calls.navigations.length, 1);
});

test('nonempty-cart shipping can discard a new design without adding it', async () => {
  const { context: page, cart, calls } = harness({ askBeforeLeaving: async () => 'discard' });
  cart.replace({ id: id('a') });
  await page.runNavigation(page.navigateToShipping, { shipping: true });
  assert.equal(calls.posts, 0);
  assert.deepEqual(cart.read().map(item => item.id), [id('a')]);
  assert.match(calls.navigations[0], /configuration=aaaaaaaaaaaaaaaa/);
});

test('Home and word-cloud links share save/discard/cancel and capture href before awaiting', async () => {
  for (const destination of ['/', '/e/event-a']) {
    for (const choice of ['save', 'discard', 'cancel']) {
      const { context: page, calls } = harness({ askBeforeLeaving: async () => choice });
      const event = { button: 0, currentTarget: { href: destination }, preventDefault() {} };
      const done = page.saveBeforeLeaving(event);
      event.currentTarget = null;
      await done;
      assert.equal(calls.posts, choice === 'save' ? 1 : 0);
      assert.deepEqual(calls.navigations, choice === 'cancel' ? [] : [destination]);
    }
  }
});

test('modified and new-tab links are never intercepted', async () => {
  const { context: page, calls } = harness();
  for (const event of [{ button: 1 }, { button: 0, metaKey: true },
    { button: 0, currentTarget: { href: '/datenschutz', target: '_blank' } }]) {
    await page.saveBeforeLeaving({ preventDefault() { throw new Error('intercepted'); }, ...event });
  }
  assert.equal(calls.dialogs.length, 0);
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

test('save failure keeps the editor and does not navigate or add an item', async () => {
  const { context: page, cart, calls } = harness({
    askBeforeLeaving: async () => 'save', fetch: async () => { throw new Error('offline'); },
  });
  await page.runNavigation(page.navigateToShipping, { shipping: true });
  assert.deepEqual(cart.read(), []);
  assert.equal(calls.navigations.length, 0);
  assert.equal(page.currentDesignNeedsSave, true);
  assert.equal(page.leavingPage, false);
  assert.equal(page.orderActionPending, false);
  assert.match(page.errorText.textContent, /nicht gespeichert/);
});

test('storage failure is detected before a POST and an acknowledged snapshot is reused on storage retry', async () => {
  const { context: page, local, calls } = harness();
  const write = local.setItem;
  local.setItem = () => { throw new Error('blocked'); };
  assert.equal(await page.saveCurrentDesign(page.saveDesignButton), false);
  assert.equal(calls.posts, 0);
  local.setItem = write;
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

test('fresh entry never opens old cart words; explicit edit and cart entry open only saved designs', async () => {
  for (const search of ['', '?edit=aaaaaaaaaaaaaaaa', '?cart=1']) {
    const { context: page, cart, calls } = harness({ workspaceReady: false,
      location: { search }, words: [['sonne', 1], ['neu', 1]] });
    cart.replace({ id: id('a') });
    await page.initializeWorkspace();
    assert.deepEqual(calls.opened, search ? [id('a')] : []);
    assert.equal(page.words.length, 2);
    assert.equal(page.workspaceReady, true);
    assert.equal(page.content.inert, false);
  }
  assert.doesNotMatch(template, /draftStore|persistCurrentDraft|savedActive|currentDraftKey/);
});

test('loading a saved design uses its server snapshot without reading old browser drafts', async () => {
  const { context: page, cart, calls } = harness();
  cart.replace({ id: id('a') });
  let restored;
  page.fetch = async url => { assert.match(url, /aaaaaaaaaaaaaaaa\/edit$/); return {
    ok: true, json: async () => ({ id: id('a'), words: [['alt', 1]], designs: { default: [] } }),
  }; };
  page.applySavedConfiguration = async data => { restored = data; };
  vm.runInContext(pageFunction('loadOrderItem'), page);
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
    content: { inert: true }, leaveDialog: { open: false }, location: { reload: () => reloads++ },
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

test('payment cleanup removes only confirmed purchased IDs in this event and tab', () => {
  const session = storage(), cart = Session.createCart('a', session);
  cart.write([{ id: id('a') }, { id: id('b') }]);
  Session.createCart('other', session).write([{ id: id('a') }]);
  assert.equal(Session.clearPurchased('a', { paymentConfirmed: false, configurationIds: [id('a')] }, { storage: session }), false);
  assert.equal(cart.read().length, 2);
  assert.equal(Session.clearPurchased('a', { paymentConfirmed: true, configurationIds: [id('a')] }, { storage: session }), true);
  assert.deepEqual(cart.read().map(item => item.id), [id('b')]);
  assert.equal(Session.createCart('other', session).read().length, 1);
  assert.deepEqual(Session.purchasedIds('a', session), [id('a')]);
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
