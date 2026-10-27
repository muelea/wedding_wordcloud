'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const Session = require('../public/js/configurator-session');
const Transfer = require('../public/js/design-transfer');

function storage() {
  const values = new Map();
  return { getItem: key => values.get(key) || null,
    setItem: (key, value) => values.set(key, String(value)), removeItem: key => values.delete(key) };
}
const template = fs.readFileSync(path.join(__dirname, '../views/configure.ejs'), 'utf8');

test('checkout actions are contextual and only ask when current work would be omitted', () => {
  assert.doesNotMatch(template, /cart-action-hint|id="save-status"|Nur ausdrücklich übernommene Designs|Design im Warenkorb gespeichert/);
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
  const calls = { posts: 0, bodies: [], navigations: [], warnings: [], opened: [], busy: [], replaced: [], pushed: [], panels: [] };
  const element = () => ({ textContent: '', disabled: false, hidden: false, dataset: {}, children: [],
    append(...nodes) { this.children.push(...nodes); }, appendChild(node) { this.children.push(node); },
    replaceChildren(...nodes) { this.children = nodes; }, addEventListener() {} });
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
    accountController:null,accountDesignReference:null,
    workingDesignId: 'w'.repeat(32), draftStorageVersion: 0, dismissedCloud: '',
    cloudSourceState: 'ready', cloudCheckPending: false, cloudCheckGeneration: 0, lastCloudCheck: 0,
    cloudRebuildUndo: null, cloudRebuildRedo: null, activeSurface: 'default',
    surfaceStates: new Map([['default', { design: [{ text: 'sonne' }], history: [], historyIndex: -1 }]]),
    AbortSignal, URLSearchParams, setTimeout, clearTimeout, requestAnimationFrame: callback => callback(),
    console: { warn() {} },
    WolkenworteConfiguratorSession: Session, DesignTransfer: Transfer, sessionStorage: local, cart, draftStore,
    WolkenworteProductGallery: require('../public/js/product-gallery'),
    printLayoutJobs: () => ({ pack: require('../public/js/wordcloud-core').layoutBoxesInArea }),
    productDesignState: null,
    savedDesignFingerprint: null, previousProductDraft: null, productTransitionPending: false, cartDrafts: new Map(),
    removedEditingState: null,
    CloudLimits: require('../public/js/cloud-limits'),
    slug: 'event-a', guestId: 'a'.repeat(32), product: { key: 'mug' }, directDesign: false,
    AUTOMATIC_LAYOUT_VERSION: '/js/wordcloud-core.js?v=current|/js/design-layout.js?v=current',
    words: [['sonne', 1]], liveWords: [['sonne', 1], ['neu', 1]],
    selectedOrientation: 'default', selectedTheme: 'confetti', customColors: ['#ff7100'],
    currentDesignNeedsSave: true, currentDesignEdited: false, editingOrderItemId: null, designRevision: 0, pendingConfiguration: null,
    workspaceReady: true, restorationFailed: false, orderActionPending: false, fitAreaPending: false,
    leavingPage: false, allowNavigation: false, suppressDirty: false,
    draftSaveTimer: null, draftSavePromise: null, draftSavedRevision: -1, draftStorageFailed: false,
    saveDesignButton: element(), continueOrderButton: element(), continueOrderLabel: element(), designAnotherButton: element(),
    productSwitchUndo: element(), productInfoButton: element(),
    orderList: { querySelectorAll: () => [] }, cartRemovalNotice: element(), cartRemovalMessage: element(),
    products: [{ key: 'mug', displayName: 'Tasse' }, { key: 'poster', displayName: 'Poster' }],
    document: { createElement: element, querySelectorAll:()=>[], getElementById: () => element() },
    headerCart: { hidden: true }, headerCartCount: element(),
    errorText: element(), saveStatus: element(), retryConfigurator: { hidden: true }, loadingMessage: element(),
    content: { inert: false }, loading: { hidden: false }, editorElement: { hidden: false }, orderBox: { scrollIntoView() {} },
    galleryPendingConfigurations: new Map(),
    productGallery: null, galleryElement: { hidden: true },
    updateProductBackLink() {},
    cartPanel: { open() {}, close() {}, refresh() {}, message() {} },
    cloudUpdateNotice: { hidden: true }, draftLossDialog: { open: false, close() {} },
    cartReview: { show() {}, dispose() {} }, revealReviewedDesign() { calls.opened.push('revealed'); },
    shippingChoiceDialog, shippingChoiceTitle: element(),
    shippingChoiceDescription: element(), shippingChoiceSave: element(), shippingChoiceList: element(),
    workspace: { close() {}, show: (panel) => calls.panels.push(panel) },
    mobileEditorMedia: { matches: false }, mobileDevice: false, setMobileEditorExpanded() {},
    getAllSurfaceDesigns: () => ({ default: [{ text: 'sonne' }] }),
    productDesignSource: designs => ({ productKey: 'mug', orientation: 'default',
      surfaces: [{ key: 'default', area: { x: 0, y: 0, width: 1000, height: 1000 }, design: designs.default }] }),
    productSurfaces: () => [{ key: 'default', label: 'Druckfläche' }],
    mugEditor: { flushPendingChange() {}, hasPendingTextChange: () => false },
    setText: (element, message) => { element.textContent = message; }, clearText: element => { element.textContent = ''; },
    t: message => message, renderOrderBox() {}, renderAll() {}, initEditor() {}, refreshWorkspaceLayout() {},
    productSizeText: () => '11 oz',
    initMug3D: async () => {}, finalizeCurrentText: async () => {},
    scheduleDraftSave() {}, loadLocalDraft: async () => null, applyLocalDraft: async () => {},
    askToLeaveWithoutDraft: async () => { calls.warnings.push('draft-loss'); return 'stay'; },
    askAnotherProductChoice: async () => 'skip',
    loadOrderItems: () => cart.read(),
    addOrderItem: (data, { replaceId }) => cart.replace(data, replaceId),
    setOrderActionsBusy: value => calls.busy.push(value), updateCartActions() {},
    loadOrderItem: async target => calls.opened.push(target),
    history: { replaceState: (_, __, url) => calls.replaced.push(url), pushState: (_, __, url) => calls.pushed.push(url) },
    location: { search: '', assign: url => calls.navigations.push(url) },
    fetch: async (_, options = {}) => {
      calls.posts++;
      if (options.body) calls.bodies.push(JSON.parse(options.body));
      return { ok: true, json: async () => ({ id: id(String(calls.posts)), productKey: 'mug' }) };
    },
    ...extra,
  });
  vm.runInContext(['saveCurrentDesign', 'approveCurrentDesign', 'createConfiguration', 'addGalleryDesign', 'orderItemFromConfiguration',
    'returnToGallery', 'restoreProductHistory', 'updateGalleryEditorLocation', 'updateGalleryLocation', 'showReadyWorkspace', 'continueFromCartPanel', 'openCartPanelDesign',
    'hasUnsavedDesign', 'shippingAction', 'askShippingChoice',
    'draftSnapshot', 'wordsMatch', 'updateCloudNotice', 'setCloudFeedback', 'syncCloudHistory', 'workingCheckpoint',
    'cloneDesign', 'cloneEditorState', 'fetchCloudWords', 'updateCartActions', 'continueToShipping', 'saveReviewedDesigns',
    'currentAccountFingerprint', 'restoreAccountDesign',
    'currentDesignFingerprint', 'updateAccountSaveState', 'updateCartDraftMarkers', 'refreshCartDrafts', 'renderRemovalNotice',
    'hasUnpersistedDraft', 'persistCurrentDraft', 'runNavigation', 'saveBeforeLeaving',
    'openOrderItem', 'removeOrderItem', 'undoCartRemoval', 'navigateToShipping',
    'showRestorationError', 'initializeWorkspace', 'updateHeaderCart'].map(pageFunction).join('\n'), context);
  context.prepareCloudDesigns = async nextWords => {
    await context.ensureDesignFonts?.(['classic']);
    await context.WolkenworteEmoji?.preloadTexts(nextWords.map(([word]) => word));
    if (!nextWords.length) throw new Error('no_words');
    return { default: nextWords.map(([text]) => ({ text })) };
  };
  return { context, cart, local, drafts, calls };
}

test('draft comparisons ignore object identity but retain print content, layers and product choices', () => {
  const first = { productKey: 'mug', theme: 'confetti', designs: { default: [
    { id: 'a', text: 'Sonne', x: 10, color: '#ff7100' }, { id: 'b', type: 'image', src: 'data:image/png;base64,abc' },
  ] } };
  const identical = { theme: 'confetti', orientation: 'default', productKey: 'mug', designs: { default: [
    { color: '#ff7100', x: 10, text: 'Sonne', id: 'different' }, { src: 'data:image/png;base64,abc', type: 'image', id: 'c' },
  ] } };
  assert.equal(Session.designFingerprint(first), Session.designFingerprint(identical));
  for (const changed of [
    { ...first, productKey: 'poster' }, { ...first, orientation: 'landscape' },
    { ...first, designs: { default: [...first.designs.default].reverse() } },
    { ...first, designs: { default: [{ ...first.designs.default[0], text: 'Mond' }] } },
    { ...first, designs: { default: [{ type: 'image', src: 'data:image/png;base64,abd' }] } },
  ]) assert.notEqual(Session.designFingerprint(first), Session.designFingerprint(changed));
});

test('draft pending state and saved comparison survive reload and exact cart reads remain event-scoped', async () => {
  const backend = draftBackend();
  const drafts = Session.createDraftStore('one', { backend });
  const design = { productKey: 'mug', theme: 'confetti', designs: { default: [{ text: 'Sonne' }] } };
  const baseline = Session.designFingerprint(design);
  await drafts.save({ ...design, editingOrderItemId: id('a'), needsCartUpdate: false, savedDesignFingerprint: baseline });
  await drafts.save({ ...design, editingOrderItemId: id('b'), needsCartUpdate: true, savedDesignFingerprint: baseline });
  await drafts.save({ ...design, editingOrderItemId: id('c') }); // Legacy drafts remain conservatively pending.
  const records = await drafts.loadCartDrafts([id('a'), id('b'), id('c'), id('a'), 'invalid']);
  assert.equal(records.length, 3);
  assert.equal(records[0].needsCartUpdate, false);
  assert.equal(records[0].savedDesignFingerprint, baseline);
  assert.equal(records[2].needsCartUpdate, true);
  assert.deepEqual(await Session.createDraftStore('two', { backend }).loadCartDrafts([id('a')]), []);
});

test('Undo returning to the approved artwork clears cart pending state without an approval request', () => {
  let design = [{ text: 'Sonne', x: 10 }];
  const { context: page, calls } = harness({ editingOrderItemId: id('a'),
    getAllSurfaceDesigns: () => ({ default: design }),
  });
  page.savedDesignFingerprint = page.currentDesignFingerprint();
  vm.runInContext(pageFunction('markDirty'), page);
  design = [{ text: 'Sonne', x: 20 }];
  page.markDirty();
  assert.equal(page.currentDesignNeedsSave, true);
  design = [{ text: 'Sonne', x: 10 }];
  page.markDirty();
  assert.equal(page.currentDesignNeedsSave, false);
  assert.equal(page.saveDesignButton.disabled, true);
  assert.equal(calls.posts, 0);
});

test('shipping reviews parked edits and updates only approved choices while restoring the active item', async () => {
  for (const choice of ['save', 'cart', 'cancel', `edit:${id('a')}`]) {
    let currentDesign = [{ text: 'B' }];
    const { context: page, cart, calls } = harness({
      editingOrderItemId: id('b'), currentDesignNeedsSave: false,
      getAllSurfaceDesigns: () => ({ default: currentDesign }),
    });
    cart.write([{ id: id('a'), productKey: 'mug' }, { id: id('b'), productKey: 'mug' }]);
    page.savedDesignFingerprint = page.currentDesignFingerprint();
    const parked = { productKey: 'mug', theme: 'confetti', designs: { default: [{ text: 'A edited' }] },
      editingOrderItemId: id('a'), needsCartUpdate: true };
    await page.draftStore.save(parked);
    let review;
    page.askShippingChoice = async (action, drafts) => { review = { action, drafts }; return choice; };
    page.applyLocalDraft = async draft => {
      currentDesign = draft.designs.default;
      page.editingOrderItemId = draft.editingOrderItemId;
      page.savedDesignFingerprint = draft.savedDesignFingerprint;
      page.currentDesignNeedsSave = draft.needsCartUpdate;
    };
    await page.continueToShipping();
    assert.equal(review.action, 'choose-review');
    assert.equal(review.drafts.length, 1);
    assert.equal(review.drafts[0].editingOrderItemId, id('a'));
    assert.equal(calls.posts, choice === 'save' ? 1 : 0);
    assert.equal(calls.navigations.length, ['save', 'cart'].includes(choice) ? 1 : 0);
    assert.deepEqual(cart.read().map(item => item.id), choice === 'save' ? [id('1'), id('b')] : [id('a'), id('b')]);
    if (choice === 'save') {
      assert.equal(calls.bodies[0].designs.default[0].text, 'A edited');
      assert.equal(page.editingOrderItemId, id('b'));
      assert.equal(currentDesign[0].text, 'B');
    }
    if (choice.startsWith('edit:')) assert.deepEqual(calls.opened, [id('a'), 'revealed']);
  }
});

test('failed approval during a cart-wide review never proceeds and retains remaining pending drafts', async () => {
  const { context: page, cart, calls } = harness({ editingOrderItemId: id('c'), currentDesignNeedsSave: false });
  cart.write(['a', 'b', 'c'].map(character => ({ id: id(character), productKey: 'mug' })));
  for (const character of ['a', 'b']) await page.draftStore.save({
    productKey: 'mug', theme: 'confetti', designs: { default: [{ text: character }] },
    editingOrderItemId: id(character), needsCartUpdate: true,
  });
  page.askShippingChoice = async () => 'save';
  page.applyLocalDraft = async draft => {
    page.editingOrderItemId = draft.editingOrderItemId;
    page.currentDesignNeedsSave = draft.needsCartUpdate;
  };
  page.fetch = async () => {
    calls.posts++;
    return calls.posts === 1 ? { ok: true, json: async () => ({ id: id('1'), productKey: 'mug' }) }
      : { ok: false, json: async () => ({ error: 'save_failed' }) };
  };
  await page.continueToShipping();
  assert.equal(calls.navigations.length, 0);
  assert.deepEqual(cart.read().map(item => item.id), [id('1'), id('b'), id('c')]);
  assert.equal(page.editingOrderItemId, id('b'));
  assert.equal(page.currentDesignNeedsSave, true);
  assert.equal((await page.draftStore.loadCartDrafts([id('b')]))[0].needsCartUpdate, true);
});

test('failed draft review keeps shipping blocked, and unchanged persisted work produces no prompt', async () => {
  const { context: page, cart, calls } = harness({ editingOrderItemId: id('a'), currentDesignNeedsSave: false });
  cart.write([{ id: id('a'), productKey: 'mug' }]);
  page.askShippingChoice = () => { throw new Error('unchanged work must not prompt'); };
  await page.continueToShipping();
  assert.equal(calls.navigations.length, 1);
  page.draftStore.loadCartDrafts = async () => { throw new Error('blocked'); };
  await page.continueToShipping();
  assert.equal(calls.navigations.length, 1);
  assert.equal(calls.posts, 0);
  assert.equal(page.orderActionPending, false);
  assert.match(page.errorText.textContent, /nicht vollständig geprüft/);
});

test('a position removed while its approval is in flight cannot silently re-enter the cart', async () => {
  const { context: page, cart, calls } = harness({ editingOrderItemId: id('a') });
  cart.write([{ id: id('a'), productKey: 'mug' }]);
  page.fetch = async () => {
    cart.write([]); // Another tab removes the position while the server is saving.
    return { ok: true, json: async () => ({ id: id('1'), productKey: 'mug' }) };
  };
  assert.equal(await page.saveCurrentDesign(page.saveDesignButton), false);
  assert.deepEqual(cart.read(), []);
  assert.equal(calls.navigations.length, 0);
  assert.equal(page.currentDesignNeedsSave, true);
  assert.match(page.errorText.textContent, /Warenkorb hat sich geändert/);
});

test('cart removal Undo restores the exact position and quantity, expires, and cannot duplicate or exceed the limit', () => {
  let now = 1000;
  const browser = storage();
  const cart = Session.createCart('one', browser, () => now);
  cart.write([{ id: id('a'), productKey: 'mug' }, { id: id('b'), productKey: 'poster' }]);
  cart.remove(id('a'), { quantity: 3 });
  assert.deepEqual(cart.read().map(item => item.id), [id('b')]);
  assert.equal(Session.createCart('two', browser, () => now).pendingRemoval(), null);
  assert.equal(cart.undoRemoval().quantity, 3);
  assert.deepEqual(cart.read().map(item => item.id), [id('a'), id('b')]);
  assert.equal(cart.undoRemoval(), null);
  cart.remove(id('a'));
  cart.write(Array.from({ length: 20 }, (_, i) => ({ id: String(i).padStart(16, '0') })));
  assert.throws(() => cart.undoRemoval(), /cart_full/);
  assert.equal(cart.read().length, 20);
  now += 10 * 60 * 1000;
  assert.equal(cart.undoRemoval(), null);
});

test('removal Undo keeps the tab address and restores quantity without reviving a trusted price', () => {
  const drafts = Session.createShippingDraft('one', storage());
  drafts.write([{ recipient: { city: 'Berlin' }, items: [{ configurationId: id('a'), quantity: 3 }] }]);
  drafts.removeConfigurations([id('a')], { keepRecipient: true });
  drafts.restoreConfiguration(id('a'), 3);
  const restored = drafts.restore([id('a')]);
  assert.equal(restored[0].recipient.city, 'Berlin');
  assert.deepEqual(restored[0].items, [{ configurationId: id('a'), quantity: 3 }]);
  assert.equal(restored[0].price, undefined);
  drafts.removeConfigurations([id('a')], { keepRecipient: true });
  drafts.restoreConfiguration(id('a'), 0);
  assert.equal(drafts.restore([id('a')])[0].items[0].quantity, 0);
});

test('removing and undoing the active item restores its cart association without creating a duplicate', () => {
  const { context: page, cart, calls } = harness({ editingOrderItemId: id('a'), currentDesignNeedsSave: false });
  cart.write([{ id: id('a'), productKey: 'mug' }]);
  page.savedDesignFingerprint = page.currentDesignFingerprint();
  page.removeOrderItem(id('a'));
  assert.equal(page.editingOrderItemId, null);
  page.undoCartRemoval();
  assert.equal(page.editingOrderItemId, id('a'));
  assert.equal(page.currentDesignNeedsSave, false);
  assert.deepEqual(cart.read().map(item => item.id), [id('a')]);
  assert.equal(calls.posts, 0);
});

test('Undo after last-item removal on shipping reconnects its explicitly opened working copy', () => {
  const { context: page, cart, calls } = harness({ editingOrderItemId: null, location: {
    search: `?edit=${id('a')}`, assign: url => calls.navigations.push(url),
  } });
  page.savedDesignFingerprint = page.currentDesignFingerprint();
  cart.write([{ id: id('a'), productKey: 'mug' }]);
  cart.remove(id('a'));
  page.undoCartRemoval();
  assert.equal(page.editingOrderItemId, id('a'));
  assert.equal(page.currentDesignNeedsSave, false);
  assert.equal(calls.posts, 0);
});

test('copying over an existing back requires consent and preserves the prior artwork for Undo', async () => {
  const browserRoot = {};
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../public/js/mug-editor.js'), 'utf8'), { window: browserRoot });
  const editor = Object.create(browserRoot.MugPrintEditor.prototype);
  const objects = [{ id: 'back', text: 'Original back', x: 120, y: 30, fontSize: 100, angle: 0, color: '#ff7100' }];
  editor.canvas = { getObjects: () => objects, discardActiveObject() {}, requestRenderAll() {},
    remove: object => objects.splice(objects.indexOf(object), 1), add: object => objects.push(object) };
  editor.serializeObject = object => ({ ...object });
  editor.makeObject = item => ({ ...item });
  editor.keepInside = editor.updateSelectionPanel = editor.emitChange = editor.setFeedback = () => {};
  editor.history = [editor.historySnapshot()];
  editor.historyIndex = 0;
  const before = JSON.stringify(editor.getDesign());
  let accepted = false;
  let handler;
  const scope = vm.createContext({
    mugEditor: editor, orderActionPending: false, leavingPage: false, activeSurface: 'back', product: {},
    surfaceCopy: { addEventListener: (_, callback) => { handler = callback; } },
    surfaceStates: new Map([['front', { design: [{ id: 'front', text: 'Front', x: 20, y: 30, fontSize: 100, angle: 0, color: '#ff7100' }] }]]),
    storeActiveSurfaceState() {}, askDesignReplacement: async () => accepted,
    productView: (_, __, side) => ({ safeArea: { x: side === 'front' ? 0 : 100, y: 0 } }),
    markDirty() {}, renderAll() {},
  });
  scope.surfaceStates.set('back', editor.getState());
  const start = template.indexOf("    surfaceCopy.addEventListener('click', async () => {");
  assert.notEqual(start, -1);
  const listener = template.slice(start, template.indexOf('\n    });', start) + 8);
  vm.runInContext(['cloneDesign', 'cloneEditorState'].map(pageFunction).join('\n') + '\n' + listener, scope);
  await handler();
  assert.equal(JSON.stringify(editor.getDesign()), before);
  accepted = true;
  await handler();
  assert.equal(editor.getDesign()[0].text, 'Front');
  assert.equal(editor.getDesign()[0].x, 120);
  editor.undo();
  assert.equal(JSON.stringify(editor.getDesign()), before);
});

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
  assert.match(template, /fetch\(`\/api\/events\/\$\{encodeURIComponent\(slug\)\}\/configurator\?restore=1`, \{\s*cache: 'no-store'/);
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

test('layout work disables purchase actions and cannot approve a partial arrangement', async () => {
  const { context: page, calls } = harness({ fitAreaPending: true });
  page.updateCartActions();
  assert.equal(page.saveDesignButton.disabled, true);
  assert.equal(page.continueOrderButton.disabled, true);
  assert.equal(page.designAnotherButton.disabled, true);
  assert.equal(await page.saveCurrentDesign(page.saveDesignButton), false);
  assert.equal(calls.posts, 0);
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

test('gallery approval freezes every previewed side without changing the current editor target', async () => {
  const { context: page, cart, calls } = harness({ workspaceReady: false });
  const preview = { productKey: 'poster', orientation: 'landscape', theme: 'confetti', words: [['sonne', 1]],
    designs: { front: [{ text: 'sonne', x: 321.4 }], back: [{ text: 'Back', color: '#123456' }] } };
  const saved = await page.addGalleryDesign(preview);
  assert.equal(calls.posts, 1);
  assert.deepEqual(calls.bodies[0], preview);
  assert.equal(cart.read().length, 1);
  assert.equal(page.editingOrderItemId, null);
  assert.equal(saved.editingOrderItemId, cart.read()[0].id);
  assert.equal(saved.needsCartUpdate, false);
  assert.deepEqual(JSON.parse(JSON.stringify((await page.draftStore.loadActive()).designs)), preview.designs);
  await page.addGalleryDesign(saved);
  assert.equal(calls.posts, 1);
  assert.equal(cart.read().length, 1);
});

test('gallery cart retries reuse the immutable snapshot after a local storage failure', async () => {
  const { context: page, cart, calls } = harness({ workspaceReady: false });
  const preview = { productKey: 'mug', theme: 'confetti', words: [['sonne', 1]],
    designs: { default: [{ text: 'sonne' }] } };
  const replace = cart.replace;
  cart.replace = () => { throw new Error('storage'); };
  await assert.rejects(page.addGalleryDesign(preview));
  assert.equal(calls.posts, 1);
  assert.equal(cart.read().length, 0);
  cart.replace = replace;
  await page.addGalleryDesign(preview);
  assert.equal(calls.posts, 1);
  assert.equal(cart.read().length, 1);
});

test('gallery limits and failed storage are checked before creating print snapshots', async () => {
  const { context: page, cart, calls } = harness();
  cart.write(Array.from({ length: Session.MAX_CART_ITEMS }, (_, index) => ({
    id: `gallery${String(index).padStart(9, '0')}`, productKey: 'mug',
  })));
  const preview = { productKey: 'mug', designs: { default: [{ text: 'sonne' }] } };
  await assert.rejects(page.addGalleryDesign(preview), error => /20 Designs/.test(error.userMessage));
  assert.equal(calls.posts, 0);
  cart.read = () => { throw new Error('storage'); };
  await assert.rejects(page.addGalleryDesign(preview), error => /Warenkorb/.test(error.userMessage));
  assert.equal(calls.posts, 0);
});

test('gallery return persists the current edits and never asks for ordinary cart approval', async () => {
  const { context: page, calls } = harness();
  let shown, destroyed = false;
  page.showProductGallery = snapshot => { shown = snapshot; };
  page.destroyMug3D = () => { destroyed = true; };
  page.document.getElementById = () => ({ focus() {}, scrollIntoView() {} });
  await page.returnToGallery();
  assert.equal(destroyed, true);
  assert.equal(shown.workingDesignId, page.workingDesignId);
  assert.equal((await page.draftStore.loadActive()).workingDesignId, page.workingDesignId);
  assert.equal(calls.posts, 0);
  assert.equal(calls.warnings.length, 0);
  page.persistCurrentDraft = async () => false;
  shown = null;
  await page.returnToGallery();
  assert.equal(shown, null, 'failed recovery keeps the editor open unless leaving is explicitly chosen');
  assert.equal(calls.warnings.length, 1);
});

test('ordinary and basket entries retain drafts in the gallery without opening the editor', async () => {
  for (const directDesign of [false,true]) for (const search of ['', '?cart=1']) {
    const {context:page,cart,calls}=harness({workspaceReady:false,directDesign,location:{search}});
    const saved={workingDesignId:'d'.repeat(32),productKey:'mug',designs:{default:[{text:'Edited'}]}};
    let shown,opened=0;
    page.loadLocalDraft=async()=>saved;
    page.showProductGallery=value=>{shown=value;};
    page.cartPanel.open=()=>opened++;
    cart.write([{id:id('a'),productKey:'mug'}]);
    page.initializeWorkspace=async()=>{throw new Error('ordinary entries must not open the designer');};
    await page.showReadyWorkspace();
    assert.deepEqual(shown,saved);
    assert.equal(opened,search?1:0);
    assert.equal(calls.posts,0);
  }
});

test('editor navigation preserves a gallery history entry and browser return saves the draft without rewriting its destination', async () => {
  const {context:page,calls}=harness();
  const gallery='/e/event-a/configure?view=products';
  page.location.search='?view=products';
  page.updateGalleryEditorLocation({from:gallery});
  assert.equal(calls.replaced.at(-1),gallery);
  assert.equal(calls.pushed.length,1);
  const editor=new URL(calls.pushed[0],'http://example.test');
  assert.equal(editor.searchParams.get('draft'),page.workingDesignId);
  assert.equal(editor.searchParams.has('view'),false);
  page.location.href='http://example.test'+gallery;
  page.location.search='?view=products';
  page.location.replace=url=>calls.navigations.push(url);
  const replacements=calls.replaced.length;
  await page.restoreProductHistory();
  assert.equal(calls.replaced.length,replacements,'saving must not overwrite the selected history entry');
  assert.equal(calls.navigations.at(-1),'http://example.test'+gallery);
  assert.equal((await page.draftStore.loadActive()).workingDesignId,page.workingDesignId);
});

test('gallery selection replaces stale cart and library entry intent while retaining the chosen draft', () => {
  const { context: page, calls } = harness();
  page.location.search = '?lang=de&view=products&edit=old&cart=1&draft=old&accountDesign=old&accountLatest=1';
  page.updateGalleryEditorLocation();
  let query = new URL(calls.replaced.at(-1), 'http://example.test').searchParams;
  assert.equal(query.get('draft'), page.workingDesignId);
  assert.equal(query.get('lang'), 'de');
  for (const key of ['view', 'edit', 'cart', 'accountDesign', 'accountLatest']) assert.equal(query.has(key), false);
  page.editingOrderItemId = id('b');
  page.updateGalleryEditorLocation();
  query = new URL(calls.replaced.at(-1), 'http://example.test').searchParams;
  assert.equal(query.get('edit'), id('b'));
});

test('reloading a gallery restores its exact retained draft without initializing the editor', async () => {
  const { context: page, calls } = harness();
  let shown = null;
  page.location.search = '?lang=en&edit=accepted&draft=old&accountDesign=old&accountLatest=1';
  page.showProductGallery = snapshot => { shown = snapshot; page.updateGalleryLocation(snapshot); };
  page.destroyMug3D = () => {};
  page.document.getElementById = () => ({ focus() {}, scrollIntoView() {} });
  await page.returnToGallery();
  const saved = await page.draftStore.loadActive();
  let query = new URL(calls.replaced.at(-1), 'http://example.test').searchParams;
  assert.equal(query.get('view'), 'products');
  assert.equal(query.get('draft'), saved.workingDesignId);
  assert.equal(query.get('lang'), 'en');
  for (const key of ['edit', 'cart', 'accountDesign', 'accountLatest']) assert.equal(query.has(key), false);

  // A visibility/background save must retain the gallery location too.
  page.location.search = `?${query}`;
  await page.persistCurrentDraft({ finalize: false });
  query = new URL(calls.replaced.at(-1), 'http://example.test').searchParams;
  assert.equal(query.get('view'), 'products');
  const { context: reloaded, calls: reloadCalls } = harness({ location: { search: `?${query}` } });
  let openedEditor = false, recovered;
  reloaded.initializeWorkspace = async () => { openedEditor = true; };
  reloaded.loadLocalDraft = async criteria => {
    assert.equal(criteria.workingDesignId, saved.workingDesignId);
    return saved;
  };
  reloaded.showProductGallery = snapshot => { recovered = snapshot; };
  await reloaded.showReadyWorkspace();
  assert.equal(openedEditor, false);
  assert.deepEqual(recovered, saved);

  reloaded.updateGalleryEditorLocation();
  const editorLocation = new URL(reloadCalls.replaced.at(-1), 'http://example.test');
  assert.equal(editorLocation.searchParams.has('view'), false);
  reloaded.location.search = editorLocation.search;
  recovered = null;
  await reloaded.showReadyWorkspace();
  assert.equal(openedEditor, true, 'reloading an editor still restores the editor');
  assert.equal(recovered, null);
});

test('a gallery reload after adding a product stays in the gallery and recovers its cart draft', async () => {
  const { context: page } = harness({ workspaceReady: false });
  const accepted = await page.addGalleryDesign({ productKey: 'mug', orientation: 'default', theme: 'confetti',
    words: [['sonne', 1]], designs: { default: [{ text: 'sonne' }] } });
  page.location.search = '?view=products';
  page.loadLocalDraft = () => page.draftStore.loadActive();
  let recovered;
  page.showProductGallery = snapshot => { recovered = snapshot; };
  page.initializeWorkspace = () => { throw new Error('gallery reload must not open an editor'); };
  await page.showReadyWorkspace();
  assert.equal(recovered.editingOrderItemId, accepted.editingOrderItemId);
  assert.deepEqual(recovered.designs, accepted.designs);
});

test('Create a keepsake opens the gallery before a retained editor draft on desktop and mobile', async () => {
  const display = fs.readFileSync(path.join(__dirname, '../views/display.ejs'), 'utf8');
  const listener = display.match(/memoryCta\.addEventListener\('click', \(\) => \{[\s\S]*?\n  \}\);/)[0];
  let click;
  const source = vm.createContext({
    slug: 'event-a', currentWords: [['sonne', 1]], encodeURIComponent,
    memoryCta: { disabled: false, addEventListener: (_name, callback) => { click = callback; } },
    location: { href: '', search: '?edit=old&cart=1' },
  });
  vm.runInContext(listener, source);
  source.memoryCta.disabled = true; click();
  assert.equal(source.location.href, '');
  source.memoryCta.disabled = false; source.currentWords = []; click();
  assert.equal(source.location.href, '', 'the empty-cloud guard remains in place');
  source.currentWords = [['sonne', 1]]; click();
  const destination = new URL(source.location.href, 'http://example.test');
  assert.equal(destination.pathname, '/e/event-a/configure');
  assert.equal(destination.searchParams.get('view'), 'products');
  for (const key of ['draft', 'edit', 'cart', 'accountDesign']) assert.equal(destination.searchParams.has(key), false);

  for (const mobileDevice of [false, true]) {
    const { context: page, cart, calls } = harness({ workspaceReady: false, mobileDevice,
      location: { search: destination.search } });
    await page.draftStore.save({ workingDesignId: 'f'.repeat(32), productKey: 'mug',
      orientation: 'default', theme: 'confetti', words: [['sonne', 1]],
      designs: { default: [{ text: 'Edited', x: 321.4, fontSize: 68 }] }, currentDesignEdited: true });
    const before = await page.draftStore.loadActive();
    cart.replace({ id: id('a'), productKey: 'mug' });
    page.loadLocalDraft = () => page.draftStore.loadActive();
    let shown;
    page.showProductGallery = snapshot => { shown = snapshot; };
    page.initializeWorkspace = () => { throw new Error('the keepsake entry must not open the editor'); };
    await page.showReadyWorkspace();
    assert.deepEqual(shown, before, 'the gallery recovers the exact edited draft');
    assert.deepEqual(await page.draftStore.loadActive(), before);
    assert.deepEqual(cart.read().map(item => item.id), [id('a')]);
    assert.equal(calls.posts, 0, 'entering the gallery approves no new configuration');
    assert.equal(page.workspaceReady, false);
  }
});

test('gallery approval cannot silently restore a position removed during the save', async () => {
  const { context: page, cart } = harness({ workspaceReady: false });
  cart.write([{ id: id('a'), productKey: 'mug' }]);
  page.fetch = async () => {
    cart.remove(id('a'));
    return { ok: true, json: async () => ({ id: id('b'), productKey: 'mug' }) };
  };
  await assert.rejects(page.addGalleryDesign({ productKey: 'mug', editingOrderItemId: id('a'),
    needsCartUpdate: true, designs: { default: [{ text: 'sonne' }] } }),
  error => /Warenkorb hat sich geändert/.test(error.userMessage));
  assert.equal(cart.read().length, 0);
});

test('the cart panel can continue from a fresh gallery without initializing or approving an editor', async () => {
  const { context: page, cart, calls } = harness({ workspaceReady: false });
  cart.write([{ id: id('a'), productKey: 'mug' }]);
  await page.continueFromCartPanel();
  assert.equal(calls.posts, 0);
  assert.equal(page.workspaceReady, false);
  assert.equal(calls.navigations.length, 1);
  assert.match(calls.navigations[0], /shipping\?configuration=aaaaaaaaaaaaaaaa/);
});

test('cart-panel shipping retains pending drafts and purchases only the accepted cart', async () => {
  for (const workspaceReady of [false, true]) {
    const { context: page, cart, calls } = harness({ workspaceReady, galleryElement: { hidden: false } });
    cart.write([{ id: id('a'), productKey: 'mug' }]);
    await page.draftStore.save({ productKey: 'mug', orientation: 'default', theme: 'confetti',
      words: [['sonne', 1]], designs: { default: [{ text: 'Edited' }] },
      editingOrderItemId: id('a'), needsCartUpdate: true });
    page.askShippingChoice = async () => { throw new Error('browsing must not prompt to add a design'); };
    await page.continueFromCartPanel();
    assert.equal(calls.posts, 0);
    assert.equal(calls.navigations.length, 1);
    assert.equal(page.workspaceReady, workspaceReady);
    assert.equal(cart.read()[0].id, id('a'));
    assert.equal((await page.draftStore.loadCartDrafts([id('a')]))[0].designs.default[0].text, 'Edited');
  }
});

test('cart shipping cannot lose a draft when local persistence fails', async () => {
  const { context: page, cart, calls } = harness({ workspaceReady: true });
  cart.write([{ id: id('a'), productKey: 'mug' }]);
  page.persistCurrentDraft = async () => false;
  let error = '';
  page.cartPanel.message = message => { error = message; };
  await page.continueFromCartPanel();
  assert.equal(calls.navigations.length, 0);
  assert.equal(calls.posts, 0);
  assert.equal(cart.read()[0].id, id('a'));
  assert.match(error, /Entwurf/);
});

test('cart continuation ignores the currently viewed unsubmitted size after returning from an editor', async () => {
  const { context: page, cart, calls } = harness({ workspaceReady: true, galleryElement: { hidden: false } });
  cart.write([{ id: id('a'), productKey: 'mug' }, { id: id('b'), productKey: 'poster' }]);
  page.product = { key: 'white-glossy-mug-20oz' };
  page.askShippingChoice = async () => { throw Error('unexpected addition'); };
  await page.continueFromCartPanel();
  assert.equal(calls.posts, 0);
  assert.match(calls.navigations[0], /configurations=aaaaaaaaaaaaaaaa%2Cbbbbbbbbbbbbbbbb/);
  assert.equal((await page.draftStore.loadActive()).productKey, 'white-glossy-mug-20oz');
  assert.deepEqual(cart.read().map(item => item.id), [id('a'), id('b')]);
});

test('choosing Customize in the panel opens the exact cart target and clears unrelated entry intent', async () => {
  const { context: page, calls } = harness({ workspaceReady: false });
  page.location.search = '?lang=de&draft=old&accountDesign=old&cart=1';
  let initialized = 0;
  page.initializeWorkspace = async () => {
    initialized++;
    const query = new URL(calls.replaced.at(-1), 'http://example.test').searchParams;
    assert.equal(query.get('edit'), id('a'));
    for (const key of ['draft', 'cart', 'accountDesign']) assert.equal(query.has(key), false);
    page.workspaceReady = true;
    page.editingOrderItemId = id('a');
  };
  await page.openCartPanelDesign(id('a'));
  assert.equal(initialized, 1);
  assert.equal(page.galleryElement.hidden, true);
  assert.equal(page.editorElement.hidden, false);
  assert.deepEqual(calls.opened, ['revealed']);
  assert.equal(calls.posts, 0);
});

test('approving manual work retains its edited provenance so layout releases cannot regenerate it', async () => {
  const { context: page } = harness({ currentDesignEdited: true });
  assert.equal(await page.saveCurrentDesign(page.saveDesignButton), true);
  assert.equal(page.currentDesignNeedsSave, false);
  assert.equal(page.currentDesignEdited, true);
  await page.persistCurrentDraft();
  const saved = await page.draftStore.loadActive();
  assert.equal(saved.currentDesignEdited, true);
  assert.equal(saved.productDesignState.version, 1);
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

test('cart updates are offered only for pending changes while new designs can always be added', () => {
  const { context: page, cart } = harness();
  page.updateCartActions();
  assert.equal(page.saveDesignButton.hidden, false);
  assert.equal(page.designAnotherButton.hidden, true);
  cart.replace({ id: id('a') });
  page.editingOrderItemId = id('a');
  page.currentDesignNeedsSave = false;
  page.updateCartActions();
  assert.equal(page.saveDesignButton.hidden, true);
  assert.equal(page.designAnotherButton.hidden, false);
  assert.equal(page.continueOrderButton.disabled, false);
  page.currentDesignNeedsSave = true;
  page.updateCartActions();
  assert.equal(page.saveDesignButton.hidden, false);
  assert.equal(page.saveDesignButton.disabled, false);
});

test('the shipping choice explains add and update cases and resolves the explicit selection', async () => {
  for (const action of ['choose-add', 'choose-update']) {
    const { context: page, calls } = harness();
    const choice = page.askShippingChoice(action);
    assert.equal(calls.panels.length, 1);
    assert.match(page.shippingChoiceDescription.textContent, action === 'choose-update'
      ? /Designs ersetzen.*bisherigen Version/ : /noch nicht im Warenkorb/);
    assert.equal(page.shippingChoiceSave.textContent, action === 'choose-update'
      ? 'Warenkorb aktualisieren und weiter' : 'Hinzufügen und weiter');
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
  assert.equal(calls.switches.length, 1);
  assert.equal(calls.switches[0][0], 'mug');
  assert.equal(calls.switches[0][2].independent, true);
  assert.match(template, /designAnotherButton\.addEventListener\('click',[\s\S]*?openProductDialog\(\)/);
  assert.doesNotMatch(template, /designAnotherButton\.addEventListener[\s\S]{0,200}runNavigation/);
});

test('starting another product explicitly resolves pending edits; cancellation or approval failure never switches', async () => {
  for (const choice of ['save', 'skip', 'cancel', 'failure']) {
    const { context: page, cart, calls } = switchingHarness({ editingOrderItemId: id('a'), currentDesignEdited: true });
    cart.write([{ id: id('a'), productKey: 'mug' }]);
    page.startingAnotherProduct = true;
    page.askAnotherProductChoice = async () => choice === 'failure' ? 'save' : choice;
    if (choice === 'failure') page.fetch = async () => ({ ok: false, json: async () => ({ error: 'save_failed' }) });
    await page.confirmProductDialog();
    assert.equal(calls.switches.length, ['save', 'skip'].includes(choice) ? 1 : 0);
    assert.deepEqual(cart.read().map(item => item.id), choice === 'save' ? [id('1')] : [id('a')]);
    if (calls.switches.length) assert.equal(calls.switches[0][2].independent, true);
    assert.equal(page.productTransitionPending, false);
  }
});

test('live-cloud replacement requires consent for manual work and leaves the cart unchanged', async () => {
  const { context: page, cart, calls } = switchingHarness({ currentDesignEdited: true });
  page.applyLiveWordsButton = {};
  page.fetch = async () => ({ ok: true, json: async () => ({ words: [['neu', 2]] }) });
  cart.write([{ id: id('a'), productKey: 'mug' }]);
  let accept = false;
  page.askDesignReplacement = async () => accept;
  vm.runInContext(pageFunction('refreshDesignFromCloud'), page);
  await page.refreshDesignFromCloud();
  assert.equal(calls.switches.length, 0);
  accept = true;
  await page.refreshDesignFromCloud();
  assert.equal(calls.switches.length, 1);
  assert.equal(calls.switches[0][2].refreshCloud, true);
  assert.deepEqual(cart.read().map(item => item.id), [id('a')]);
  assert.equal(calls.posts, 0);
});

test('independent saved-design workspaces cannot request a live-cloud replacement', async () => {
  const { context: page, calls } = switchingHarness({ directDesign: true, currentDesignEdited: true, liveWords: [] });
  page.applyLiveWordsButton = {};
  page.askDesignReplacement = async () => { throw new Error('independent artwork must not offer replacement'); };
  vm.runInContext(pageFunction('refreshDesignFromCloud'), page);
  await page.refreshDesignFromCloud();
  assert.equal(calls.switches.length, 0);
  page.fetch = async () => { throw new Error('independent workspaces have no live word source'); };
  vm.runInContext(pageFunction('startProductDesign'), page);
  assert.equal(await page.startProductDesign(page.product, 'default', { refreshCloud: true }), false);
  assert.equal(calls.busy.length, 0);
  assert.equal(page.errorText.textContent, '');
});

function artworkRestorationHarness(extra) {
  const state = harness(extra);
  const page = state.context;
  const noop = () => {};
  Object.assign(page, {
    products: [{ key: 'mug', familyKey: 'mugs', themes: [{ key: 'confetti' }] }],
    selectedOrientationOption: () => null,
    selectedProductSlot: () => ({ x: 0, y: 0, width: 1000, height: 1000 }),
    productView: () => ({ printFile: { width: 1000, height: 1000, dpi: 300 },
      safeArea: { x: 0, y: 0, width: 1000, height: 1000 } }),
    buildProductOptions: noop, buildOrientationOptions: noop, buildThemeOptions: noop,
    renderCustomColorControls: noop, buildSurfaceControls: noop, updateSurfaceControlSelection: noop,
    updateProductOptionSelection: noop, updateProductPresentation: noop, destroyMug3D: noop,
    ensureDesignFonts: async () => {},
    cloneDesign: structuredClone, cloneEditorState: value => structuredClone(value),
    DesignFonts: { cssFamily: () => 'serif' },
    DesignLayout: { fitDesignToSafeArea: design => ({ design, adjusted: false }) },
    mug3D: null,
  });
  Object.assign(page.mugEditor, { resizePrintArea: noop, preloadImages: async () => {},
    setState: value => { state.artwork = value.design; } });
  vm.runInContext(['designsForProductSurfaces', 'applySavedConfiguration', 'applyLocalDraft', 'loadOrderItem'].map(pageFunction).join('\n'), page);
  return state;
}

test('server snapshots and local drafts apply the same live-cloud notice rule without altering artwork', async t => {
  const savedWords = [['sonne', 1]];
  const design = [{ id: 'manual', text: 'Unser eigener Text', x: 400, y: 500 }];
  for (const source of ['account snapshot', 'cart snapshot', 'local draft']) {
    for (const [scenario, directDesign, currentWords, expectedHidden] of [
      ['independent account workspace', true, [], true],
      ['unchanged live cloud', false, savedWords, true],
      ['added live word', false, [['sonne', 1], ['neu', 1]], false],
      ['changed live count', false, [['sonne', 2]], false],
      ['removed live word', false, [], false],
    ]) {
      await t.test(`${source}: ${scenario}`, async () => {
        const state = artworkRestorationHarness({ directDesign, liveWords: currentWords });
        const page = state.context;
        page.cloudUpdateNotice.hidden = !expectedHidden;
        const snapshot = { productKey: 'mug', theme: 'confetti', words: savedWords,
          designs: { default: design }, currentDesignEdited: true };
        if (directDesign) {
          snapshot.accountDesign = { id: 'private-design', ownerId: 'fixture-owner' };
          page.accountController = { validateLocal: async () => true, detach() {} };
        }
        if (source === 'local draft') await page.applyLocalDraft(snapshot);
        else if (source === 'cart snapshot') {
          page.fetch = async () => ({ ok: true, json: async () => ({ ...snapshot, id: id('a') }) });
          await page.loadOrderItem(id('a'));
        } else await page.applySavedConfiguration(snapshot);
        assert.equal(page.cloudUpdateNotice.hidden, expectedHidden);
        assert.deepEqual(page.words, savedWords);
        assert.deepEqual(state.artwork, design);
        assert.equal(state.calls.posts, 0);
      });
    }
  }
});

test('only explicit cloud refresh replaces contents and failed refresh keeps the edited design', async () => {
  for (const failure of [null, 'network', 'empty', 'font']) {
    const { context: page, cart, calls } = switchingHarness({ editingOrderItemId: id('a'), currentDesignEdited: true });
    cart.replace({ id: id('a'), productKey: 'mug' });
    page.cloudUpdateNotice.hidden = false;
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
    const result = await page.startProductDesign({ key: 'poster' }, 'landscape', { refreshCloud: true });
    assert.equal(result, !failure);
    assert.equal(calls.switches.length, failure ? 0 : 1);
    assert.equal(page.editingOrderItemId, failure ? id('a') : null);
    assert.equal(page.currentDesignEdited, Boolean(failure));
    assert.deepEqual(cart.read().map(item => item.id), [id('a')], 'approved work stays in the cart');
    if (failure) assert.equal(page.words, previousWords);
    else assert.deepEqual(calls.switches[0], ['poster', 'landscape', [['neu', 2]]]);
    assert.equal(page.orderActionPending, false);
    assert.equal(page.suppressDirty, false);
    assert.equal(page.cloudUpdateNotice.hidden, !failure);
  }
});

test('product changes transfer edited artwork offline without consulting unrelated product drafts', async () => {
  for (const failure of [null, 'font', 'image']) {
    const { context: page, calls, cart } = switchingHarness({ editingOrderItemId: id('a'), currentDesignEdited: true });
    cart.replace({ id: id('a'), productKey: 'mug' });
    const artwork = [{ id: 'added', text: 'Unser Wort ❤️', x: 400, y: 400, fontSize: 80,
      fontFamily: 'classic', color: '#ff7100', fontWeight: 700, underline: true },
    { id: 'photo', type: 'image', src: 'data:image/png;base64,photo', x: 700, y: 650, width: 120, height: 80 }];
    page.getAllSurfaceDesigns = () => ({ default: artwork });
    page.fetch = async () => { throw new Error('must not fetch live words'); };
    page.loadLocalDraft = async () => { throw new Error('must not replace current contents with an old product draft'); };
    page.DesignFonts = { cssFamily: () => 'serif' };
    page.ensureDesignFonts = async () => { if (failure === 'font') throw new Error('font failed'); };
    page.WolkenworteEmoji = { preloadTexts: async () => {} };
    page.mugEditor.preloadImages = async () => { if (failure === 'image') throw new Error('image failed'); };
    page.productView = () => ({ safeArea: { x: 0, y: 0, width: 1500, height: 1000 } });
    page.selectProduct = (product, orientation, designs) => {
      calls.switches.push({ product, orientation, designs });
      page.product = product;
    };
    vm.runInContext([pageFunction('wordsMatch'), pageFunction('startProductDesign')].join('\n'), page);
    const beforeWords = page.words;
    const result = await page.startProductDesign({ key: 'poster' }, 'landscape', { preserveEditingItem: true });
    assert.equal(result, !failure);
    assert.equal(calls.switches.length, failure ? 0 : 1);
    assert.equal(page.words, beforeWords, 'event seed stays separate from edited canvas contents');
    assert.equal(page.editingOrderItemId, id('a'));
    assert.deepEqual(cart.read().map(item => item.id), [id('a')], 'conversion never rewrites an approved basket item');
    if (!failure) {
      const transferred = calls.switches[0].designs.default;
      assert.deepEqual(transferred.map(item => item.id), ['added', 'photo']);
      assert.equal(transferred[0].text, artwork[0].text);
      assert.equal(transferred[0].underline, true);
      assert.equal(transferred[1].src, artwork[1].src);
      assert.equal(page.currentDesignEdited, true);
    }
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
});

test('recovering a manual draft never generates temporary automatic artwork from a dense live cloud', async () => {
  const draft = { productKey: 'mug', designs: { default: [{ id: 'manual', text: 'Klein', fontSize: 20 }] } };
  let initialized, restored;
  const { context: page } = harness({ workspaceReady: false,
    words: Array.from({ length: 500 }, (_, i) => [`Wort ${i}`, 1]),
    loadLocalDraft: async () => draft,
    initEditor: async designs => { initialized = designs; assert.ok(designs, 'recovery must not request automatic placement'); },
    applyLocalDraft: async value => { restored = value; },
  });
  await page.initializeWorkspace();
  assert.deepEqual(Object.keys(initialized), ['default']);
  assert.equal(initialized.default.length, 0, 'the explicit empty side must bypass initEditor’s automatic fallback');
  assert.equal(restored, draft);
  assert.equal(page.restorationFailed, false);
  assert.equal(page.workspaceReady, true);
});

test('an explicit smaller-text gallery choice starts with edited provenance', async () => {
  const { context: page } = harness({ workspaceReady: false, selectedFamilyKey: 'mugs',
    buildOrientationOptions() {}, updateProductOptionSelection() {}, updateProductPresentation() {},
  });
  const designs = { default: [{ id: 'manual', text: 'Klein', fontSize: 20 }] };
  await page.initializeWorkspace({ productKey: 'mug', orientation: 'default', theme: 'confetti',
    words: [['Klein', 1]], customColors: ['#123456'], designs, currentDesignEdited: true });
  assert.equal(page.workspaceReady, true);
  assert.equal(page.currentDesignEdited, true, 'automatic recovery and product transfer must preserve the deliberate choice');
});

test('initial print capacity failure opens the product gallery without labelling saved artwork as broken', async () => {
  let gallery = 0;
  const { context: page } = harness({ workspaceReady: false,
    initEditor: async () => { throw new Error('print_capacity'); },
    showProductGallery: () => gallery++,
  });
  await page.initializeWorkspace();
  assert.equal(gallery, 1);
  assert.equal(page.workspaceReady, false);
  assert.equal(page.restorationFailed, false);
  assert.equal(page.content.inert, false);
});

test('a direct design opens its blank mobile editor and approves custom content without live words', async () => {
  const expanded = [];
  const { context: page, calls } = harness({
    directDesign: true, workspaceReady: false, words: [], liveWords: [],
    mobileEditorMedia: { matches: true }, mobileDevice: true,
    setMobileEditorExpanded: value => expanded.push(value),
  });
  await page.initializeWorkspace();
  assert.equal(page.restorationFailed, false);
  assert.equal(page.workspaceReady, true);
  assert.deepEqual(expanded, [true]);
  assert.equal(await page.saveCurrentDesign(page.saveDesignButton), true);
  assert.deepEqual(calls.bodies[0].words, []);
  assert.equal(calls.bodies[0].designs.default[0].text, 'sonne');
});

test('a direct design in a narrow desktop window does not auto-open mobile canvas mode', async () => {
  let opened = 0, expanded = 0;
  const { context: page } = harness({
    directDesign: true, workspaceReady: false, words: [], liveWords: [],
    mobileEditorMedia: { matches: true }, mobileDevice: false,
    workspace: { mobileCanvas: { open() { opened++; } } },
    setMobileEditorExpanded: () => { expanded++; },
  });
  await page.initializeWorkspace();
  assert.equal(page.workspaceReady, true);
  assert.equal(opened, 0);
  assert.equal(expanded, 0);
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
  const start = template.indexOf("    window.addEventListener('pageshow', (event) => {");
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

test('cart quantity edits initialize and share the shipping draft without losing addresses or other items', () => {
  const session = storage();
  const cartDraft = Session.createShippingDraft('cart', session);
  assert.equal(cartDraft.setQuantity(id('a'), 3), true);
  const shipping = Session.createShippingDraft('cart', session);
  const shipment = shipping.restore([id('a')])[0];
  assert.equal(shipment.items[0].quantity, 3);
  shipment.recipient.city = 'Berlin';
  shipping.write([shipment]);
  assert.equal(cartDraft.setQuantity(id('b'), 2), true);
  shipping.setQuantity(id('a'), 0);
  const updated = cartDraft.restore([id('a'), id('b')])[0];
  assert.equal(updated.recipient.city, 'Berlin');
  assert.deepEqual(updated.items.map(item => item.quantity), [0, 2]);
  for (const quantity of [-1, 100, 1.5, NaN]) assert.equal(cartDraft.setQuantity(id('a'), quantity), false);
  assert.equal(cartDraft.setQuantity('invalid', 2), false);
  cartDraft.replaceConfiguration(id('a'), id('c'));
  assert.equal(shipping.restore([id('c')])[0].items[0].quantity, 0);
  assert.equal(Session.createShippingDraft('other', session).restore([id('b')]), null);
  assert.equal(Session.createShippingDraft('cart', { getItem() {}, setItem() { throw new Error('blocked'); } }).setQuantity(id('a'), 2), false);
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
      hasPendingFontSizeChange: () => false,
      hasPendingAngleChange: () => false,
      hasPendingTextChange: () => false,
      commitFontSizeInput() { throw new Error('An unchanged rounded display value must not resize the selected artwork'); },
      commitAngleInput() { throw new Error('An unchanged rounded display angle must not rotate the selected artwork'); },
      commitTextInput() { throw new Error('An unchanged text/emoji selection must not be rebuilt'); },
    },
  });
  vm.runInContext(pageFunction('finalizeCurrentText'), context);
  await context.finalizeCurrentText();
  assert.equal(dirty, 0);
  context.mugEditor.hasPendingTextChange = () => true;
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
  const commits = [];
  context.mugEditor.hasPendingFontSizeChange = () => true;
  context.mugEditor.hasPendingAngleChange = () => true;
  context.mugEditor.commitFontSizeInput = () => commits.push('size');
  context.mugEditor.commitAngleInput = () => commits.push('angle');
  await context.finalizeCurrentText();
  assert.deepEqual(commits, ['size', 'angle'], 'Save still commits explicitly edited numeric controls');
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


test('editing a notebook or pillow back keeps its stored front on the front of the preview', () => {
  const { getProduct, getPublicProduct } = require('../src/products');
  for (const key of ['spiral-notebook-dotted', 'all-over-basic-pillow-18in', 'all-over-basic-pillow-49853']) {
    const front = [{ text: 'Vorne' }], back = [{ text: 'Hinten bearbeitet' }], seen = [];
    const page = vm.createContext({ product: getPublicProduct(getProduct(key)), activeSurface: 'back',
      surfaceStates: new Map([['front', { design: front }]]), getCurrentDesign: () => back,
      drawDesign: (_ctx, _x, _y, _scale, design) => seen.push(design),
      mug3D: { updateTexture: draw => draw({}, { offsetX: 0, offsetY: 0 }) },
      setMugPreviewState: () => assert.fail('preview update must succeed'),
    });
    vm.runInContext(pageFunction('updateMug3DTexture'), page);
    page.updateMug3DTexture();
    assert.equal(seen.at(-1), front, key);
    page.activeSurface = 'front'; page.getCurrentDesign = () => front;
    page.updateMug3DTexture();
    assert.equal(seen.at(-1), front, key);
  }
});

test('a failed 3D initialization exposes retry and never introduces a flat mug', async () => {
  const states = [];
  const page = vm.createContext({ product: { previewType: 'mug', key: 'mug' },
    editorElement: { hidden: false }, selectedOrientation: 'default', productView() { return page.product; },
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

test('cloud comparison ignores ordering but detects case, counts and invalid snapshots', () => {
  assert.equal(Session.wordSignature([['Liebe', 2], ['wir', 1]]), Session.wordSignature([['wir', 1], ['Liebe', 2]]));
  assert.notEqual(Session.wordSignature([['Liebe', 2]]), Session.wordSignature([['liebe', 2]]));
  assert.notEqual(Session.wordSignature([['Liebe', 2]]), Session.wordSignature([['Liebe', 3]]));
  for (const invalid of [null, [['a', 0]], [['a', '1']], [['a', 1], ['a', 2]]]) assert.throws(() => Session.wordSignature(invalid));
});

test('independent working identities survive product changes without overwriting another same-product draft', async () => {
  const backend = draftBackend(), store = Session.createDraftStore('one', { backend });
  const first = await store.save({ productKey: 'mug', theme: 'pastel', designs: { default: [{ text: 'first' }] },
    workingDesignId: 'a'.repeat(32), storageVersion: 0 });
  await store.save({ ...first, workingDesignId: 'b'.repeat(32), storageVersion: 0, designs: { default: [{ text: 'second' }] } });
  const moved = await store.save({ ...first, productKey: 'poster' });
  assert.equal(moved.key, first.key);
  assert.equal((await store.loadFor({ workingDesignId: first.workingDesignId })).productKey, 'poster');
  assert.equal((await store.loadFor({ productKey: 'mug' })).designs.default[0].text, 'second');
  assert.equal((await store.loadFor({ workingDesignId: 'b'.repeat(32) })).designs.default[0].text, 'second');
  assert.equal(await Session.createDraftStore('two', { backend }).loadFor({ workingDesignId: first.workingDesignId }), null);
});

test('simultaneous browser writes reject the stale revision without changing accepted artwork', async () => {
  const backend = draftBackend(), first = Session.createDraftStore('one', { backend }), second = Session.createDraftStore('one', { backend });
  const original = await first.save({ productKey: 'mug', theme: 'pastel', designs: { default: [{ text: 'original' }] },
    workingDesignId: 'a'.repeat(32), storageVersion: 0 });
  const outcomes = await Promise.allSettled([
    first.save({ ...original, designs: { default: [{ text: 'first edit' }] } }),
    second.save({ ...original, designs: { default: [{ text: 'second edit' }] } }),
  ]);
  assert.equal(outcomes.filter(result => result.status === 'fulfilled').length, 1);
  assert.match(outcomes.find(result => result.status === 'rejected').reason.message, /draft_conflict/);
  assert.equal((await first.loadActive()).designs.default[0].text, 'first edit');
  const fork = await second.save({ ...original, workingDesignId: 'b'.repeat(32), storageVersion: 0 });
  assert.equal((await first.loadFor({ workingDesignId: original.workingDesignId })).designs.default[0].text, 'first edit');
  assert.equal(fork.designs.default[0].text, 'original');
});

test('explicit cloud checks preserve artwork and distinguish empty, failed and unavailable sources', async () => {
  for (const result of ['changed', 'empty', 'offline', 'unavailable']) {
    const { context: page, calls } = harness();
    const before = page.draftSnapshot();
    let feedback = '';
    page.document.querySelectorAll = () => [{ set textContent(value) { feedback = value; } }];
    page.fetch = async () => {
      if (result === 'offline') throw new Error('offline');
      return { ok: result !== 'unavailable', status: result === 'unavailable' ? 404 : 200,
        json: async () => ({ words: result === 'empty' ? [] : [['neu', 2]] }) };
    };
    vm.runInContext(pageFunction('checkLiveWords'), page);
    await page.checkLiveWords({ explicit: true });
    assert.deepEqual(page.draftSnapshot(), before);
    assert.equal(page.cloudSourceState, { changed: 'ready', empty: 'empty', offline: 'error', unavailable: 'unavailable' }[result]);
    assert.equal(page.cloudCheckPending, false);
    assert.equal(calls.posts, 0);
    assert.ok(feedback.length);
  }
});

test('a background source recovery replaces stale empty or failed feedback without editing artwork', async () => {
  for (const state of ['empty', 'error']) {
    const { context: page } = harness();
    const before = JSON.stringify(page.draftSnapshot());
    page.cloudSourceState = state;page.liveWords = [];
    let feedback = 'Old failure';
    page.document.querySelectorAll = () => [{ set textContent(value) { feedback = value; } }];
    page.fetch = async () => ({ ok: true, json: async () => ({ words: page.words }) });
    vm.runInContext(pageFunction('checkLiveWords'), page);
    await page.checkLiveWords();
    assert.equal(feedback, 'Die Wortwolke hat keine neuen Änderungen.');
    assert.equal(page.cloudSourceState, 'ready');
    assert.equal(JSON.stringify(page.draftSnapshot()), before);
  }
});

test('keeping the current design persists only that source dismissal and leaves accepted snapshots unchanged', async () => {
  const { context: page, cart } = harness();
  cart.write([{ id: id('a'), productKey: 'mug' }]);
  const before = Session.accountDesignFingerprint(Session.accountSnapshot(page.draftSnapshot()));
  page.dismissedCloud = Session.wordSignature(page.liveWords);page.updateCloudNotice();
  assert.equal(page.cloudUpdateNotice.hidden, true);
  assert.equal(await page.persistCurrentDraft(), true);
  assert.equal((await page.draftStore.loadActive()).dismissedCloud, page.dismissedCloud);
  assert.equal(Session.accountDesignFingerprint(Session.accountSnapshot(page.draftSnapshot())), before);
  assert.deepEqual(cart.read().map(item => item.id), [id('a')]);
  page.liveWords = [['sonne', 1], ['neu', 2]];page.updateCloudNotice();
  assert.equal(page.cloudUpdateNotice.hidden, false, 'a later contribution shows a new notice');
});

test('a deliberate source recheck reopens dismissed choices without replacing the design', async () => {
  const { context: page } = harness();
  const before = JSON.stringify(page.words);
  page.dismissedCloud = Session.wordSignature(page.liveWords);page.updateCloudNotice();
  page.scheduleDraftSave = () => {};
  page.fetch = async () => ({ ok: true, json: async () => ({ words: page.liveWords }) });
  vm.runInContext(pageFunction('checkLiveWords'), page);
  await page.checkLiveWords({ explicit: true });
  assert.equal(page.cloudUpdateNotice.hidden, false);
  assert.equal(page.dismissedCloud, '');
  assert.equal(JSON.stringify(page.words), before);
});

test('cloud replacement validates and prepares before asking; empty, unchanged and cancellation are safe no-ops', async () => {
  for (const result of ['empty', 'unchanged', 'cancel', 'font']) {
    const { context: page, calls } = switchingHarness({ currentDesignEdited: true });
    const before = page.draftSnapshot();
    let prompts = 0;
    page.fetch = async () => ({ ok: true, json: async () => ({ words: result === 'empty' ? []
      : result === 'unchanged' ? page.words : [['neu', 2]] }) });
    page.prepareCloudDesigns = async () => { if (result === 'font') throw new Error('font'); return { default: [{ text: 'neu' }] }; };
    page.askDesignReplacement = async () => { prompts++; return false; };
    page.applyLiveWordsButton = {};
    vm.runInContext(pageFunction('refreshDesignFromCloud'), page);
    await page.refreshDesignFromCloud();
    assert.equal(JSON.stringify({ ...page.draftSnapshot(), storageVersion: before.storageVersion }), JSON.stringify(before));
    assert.equal(prompts, result === 'cancel' ? 1 : 0);
    assert.equal(calls.switches.length, 0);
    assert.equal(page.orderActionPending, false);
  }
});

function rebuildHarness() {
  const state = artworkRestorationHarness({ currentDesignEdited: true, editingOrderItemId: id('a') });
  const page = state.context;
  state.cart.write([{ id: id('a'), productKey: 'mug' }]);
  page.product = page.products[0];
  page.product.printSurfaces = [{ key: 'front' }, { key: 'back' }];
  page.productSurfaces = () => page.product.printSurfaces;
  page.activeSurface = 'front';
  page.surfaceStates = new Map([
    ['front', { design: [{ id: 'front', text: 'manual front', x: 400, y: 400 }], history: ['old front history'], historyIndex: 0 }],
    ['back', { design: [{ id: 'back', type: 'image', src: 'data:image/png;base64,photo', width: 100, height: 100, x: 400, y: 400 }], history: ['old back history'], historyIndex: 0 }],
  ]);
  page.productDesignState = { version: 1, surfaces: [], layouts: [{ productKey: 'hidden', surfaces: [] }] };
  page.storeActiveSurfaceState = () => {};
  page.getAllSurfaceDesigns = () => Object.fromEntries([...page.surfaceStates].map(([key, value]) => [key, structuredClone(value.design)]));
  page.productDesignSource = designs => ({ productKey: 'mug', orientation: 'default',
    surfaces: page.productSurfaces().map(surface => ({ key: surface.key, area: page.productView().safeArea, design: designs[surface.key] })) });
  page.mugEditor.setSafeArea = () => {};
  page.mugEditor.getState = () => page.surfaceStates.get(page.activeSurface);
  page.selectProduct = (product, orientation, designs) => {
    page.product = product; page.selectedOrientation = orientation;
    page.surfaceStates = new Map(Object.entries(designs).map(([key, design]) => [key, { design, history: ['new history'], historyIndex: 0 }]));
  };
  page.fetch = async () => ({ ok: true, json: async () => ({ words: [['neu', 2]] }) });
  page.prepareCloudDesigns = async () => ({ front: [{ text: 'neu front' }], back: [{ text: 'neu back' }] });
  vm.runInContext(['startProductDesign', 'restoreWorkingCheckpoint', 'restoreCloudHistory', 'markDirty'].map(pageFunction).join('\n'), page);
  return state;
}

test('rebuild Undo restores all sides, image bytes, retained layouts and source words without changing the cart', async () => {
  const { context: page, cart } = rebuildHarness();
  const before = JSON.stringify(page.workingCheckpoint());
  const accepted = structuredClone(cart.read());
  assert.equal(await page.startProductDesign(page.product, 'default', { refreshCloud: true, preserveEditingItem: true }), true);
  assert.equal(page.surfaceStates.get('back').design[0].text, 'neu back');
  assert.equal(page.cloudUpdateNotice.hidden, true);
  await page.restoreCloudHistory('undo');
  assert.equal(page.surfaceStates.get('back').design[0].src, 'data:image/png;base64,photo');
  assert.equal(page.surfaceStates.get('front').history[0], 'old front history');
  assert.deepEqual(page.words, [['sonne', 1]]);
  assert.equal(page.productDesignState.layouts[0].productKey, 'hidden');
  assert.equal(page.cloudUpdateNotice.hidden, false);
  assert.deepEqual(cart.read(), accepted);
  assert.ok(page.cloudRebuildRedo);
  await page.restoreCloudHistory('redo');
  assert.equal(page.surfaceStates.get('front').design[0].text, 'neu front');
  assert.notEqual(JSON.stringify(page.workingCheckpoint()), before);
  assert.deepEqual(cart.read(), accepted);
});

test('design replacement retains explicit entry intent for version-aware restoration on reload', async () => {
  const { context: page, calls } = rebuildHarness();
  page.location.search = '?accountDesign=00000000-0000-4000-8000-000000000001&lang=en';
  assert.equal(await page.startProductDesign(page.product, 'default', { refreshCloud: true, preserveEditingItem: true }), true);
  const query = new URLSearchParams(calls.replaced.at(-1).split('?')[1]);
  assert.equal(query.get('accountDesign'), '00000000-0000-4000-8000-000000000001');
  assert.equal(query.get('draft'), page.workingDesignId);
  assert.equal(query.get('lang'), 'en');
});

test('a mid-commit rebuild failure rolls back artwork, source words and save targets atomically', async () => {
  const { context: page, cart } = rebuildHarness();
  const before = page.workingCheckpoint();
  const select = page.selectProduct;
  page.selectProduct = (...args) => { select(...args); throw new Error('editor commit failed'); };
  assert.equal(await page.startProductDesign(page.product, 'default', { refreshCloud: true, preserveEditingItem: true }), false);
  assert.deepEqual(page.words, before.draft.words);
  assert.equal(JSON.stringify([...page.surfaceStates]), JSON.stringify(before.states));
  assert.equal(page.editingOrderItemId, before.draft.editingOrderItemId);
  assert.equal(page.orderActionPending, false);
  assert.equal(page.suppressDirty, false);
  assert.deepEqual(cart.read().map(item => item.id), [id('a')]);
  assert.equal(page.cloudRebuildUndo, null);
});

test('Undo after an accepted cart update restores only working artwork and retains the new cart target', async () => {
  const { context: page, cart } = rebuildHarness();
  await page.startProductDesign(page.product, 'default', { refreshCloud: true, preserveEditingItem: true });
  cart.replace({ id: id('b'), productKey: 'mug' }, id('a'));
  page.editingOrderItemId = id('b');
  page.savedDesignFingerprint = page.currentDesignFingerprint();
  await page.restoreCloudHistory('undo');
  assert.equal(page.editingOrderItemId, id('b'));
  assert.equal(page.currentDesignNeedsSave, true);
  assert.deepEqual(cart.read().map(item => item.id), [id('b')]);
});

test('local and server cart restoration both detach account update targets', async () => {
  for (const local of [false, true]) {
    const { context: page, cart } = harness();
    cart.write([{ id: id('a'), productKey: 'mug' }]);
    let detached = 0;
    page.accountController = { detach() { detached++; }, changed() {} };
    page.loadLocalDraft = async () => local ? { editingOrderItemId: id('a'), productKey: 'mug', accountDesign: null } : null;
    page.fetch = async () => ({ ok: true, json: async () => ({ id: id('a'), productKey: 'mug' }) });
    page.applySavedConfiguration = async () => false;
    vm.runInContext(pageFunction('loadOrderItem'), page);
    await page.loadOrderItem(id('a'));
    assert.equal(detached, 1);
  }
});

test('cart review applies only selected parked changes and can leave the active draft outside the cart', async () => {
  const { context: page, cart, calls } = harness({ editingOrderItemId: id('b'), currentDesignNeedsSave: true });
  cart.write([{ id: id('a'), productKey: 'mug' }, { id: id('b'), productKey: 'mug' }]);
  page.applyLocalDraft = async draft => { page.editingOrderItemId = draft.editingOrderItemId; page.currentDesignNeedsSave = draft.needsCartUpdate; };
  await page.saveReviewedDesigns([{ productKey: 'mug', theme: 'confetti', designs: { default: [{ text: 'edited' }] },
    editingOrderItemId: id('a'), needsCartUpdate: true }], { includeCurrent: false });
  assert.equal(calls.posts, 1);
  assert.equal(page.editingOrderItemId, id('b'));
  assert.equal(page.currentDesignNeedsSave, true);
  assert.deepEqual(cart.read().map(item => item.id), [id('1'), id('b')]);
});

test('purchase recovery clones an authenticated library draft and preserves its separate library lookup', async () => {
  const { context: page } = harness();
  const reference = { id: '00000000-0000-4000-8000-000000000001', ownerId: '00000000-0000-4000-8000-000000000002', version: 1 };
  const original = await page.draftStore.save({ ...page.draftSnapshot(), accountDesign: reference, editingOrderItemId: id('a') });
  page.accountController = { validateLocal: async () => true };
  vm.runInContext(pageFunction('loadLocalDraft'), page);
  const purchase = await page.loadLocalDraft({ editingOrderItemId: id('a'), productKey: '_cart_' });
  assert.equal(purchase.accountDesign, null);
  assert.notEqual(purchase.workingDesignId, original.workingDesignId);
  assert.equal(purchase.storageVersion, 0);
  await page.draftStore.save(purchase);
  const library = await page.draftStore.loadFor({ accountDesignId: reference.id });
  assert.equal(library.workingDesignId, original.workingDesignId);
  assert.deepEqual(library.designs, original.designs);
});

test('unavailable private recovery falls back to the accepted guest cart snapshot', async () => {
  const { context: page } = harness();
  await page.draftStore.save({ ...page.draftSnapshot(), editingOrderItemId: id('a'),
    accountDesign: { id: '00000000-0000-4000-8000-000000000001', ownerId: '00000000-0000-4000-8000-000000000002', version: 1 } });
  page.accountController = { validateLocal: async () => false };
  vm.runInContext(pageFunction('loadLocalDraft'), page);
  assert.equal(await page.loadLocalDraft({ editingOrderItemId: id('a'), productKey: '_cart_' }), null);
  assert.ok(await page.draftStore.loadActive(), 'private working data is preserved for its owner');
});

test('library entry clears cart targets for both resumed and newer saved artwork', async () => {
  for (const status of ['same', 'newer', 'conflict']) {
    const { context: page, cart } = harness();
    const snapshot = { ...page.draftSnapshot(), editingOrderItemId: id('a'),
      accountDesign: { id: 'private', ownerId: 'owner', version: 1, fingerprint: 'original' } };
    cart.write([{ id: id('a'), productKey: 'mug' }]);
    page.loadLocalDraft = async () => snapshot;
    page.document.querySelector = () => ({ textContent: '' });
    let local, saved, restores = 0;
    page.applyLocalDraft = async value => { local = value; page.editingOrderItemId = value.editingOrderItemId; };
    page.applySavedConfiguration = async value => { saved = value; };
    page.accountController = { inspectLocal: async () => ({ status }), restore: async () => { restores++; return { ...snapshot, words: [['newer', 1]] }; },
      restored() {}, detach() {} };
    page.askDesignStateChoice = async () => 'copy';
    await page.restoreAccountDesign('private');
    assert.equal(page.editingOrderItemId, null);
    assert.deepEqual(cart.read().map(item => item.id), [id('a')]);
    if (status === 'newer') { assert.equal(restores, 1); assert.deepEqual(saved.words, [['newer', 1]]); }
    else { assert.equal(local.editingOrderItemId, null); if (status === 'conflict') assert.equal(local.accountDesign, null); }
    if (status !== 'newer') {
      const purchaseDraft = await page.draftStore.loadFor({ editingOrderItemId: id('a'), productKey: '_cart_' });
      assert.equal(purchaseDraft.accountDesign, null);
      assert.notEqual(purchaseDraft.workingDesignId, snapshot.workingDesignId);
      assert.deepEqual(purchaseDraft.designs, snapshot.designs, 'pending cart artwork survives library entry');
    }
  }
});

test('successful cart approval retains a failed local recovery warning and does not navigate', async () => {
  const { context: page, cart, calls } = harness();
  page.persistCurrentDraft = async () => { page.draftStorageFailed = true; page.errorText.textContent = 'Browser recovery failed'; return false; };
  assert.equal(await page.approveCurrentDesign(), false);
  assert.equal(cart.read().length, 1, 'the accepted immutable cart snapshot remains');
  assert.equal(calls.posts, 1);
  assert.equal(page.draftStorageFailed, true);
  assert.equal(page.errorText.textContent, 'Browser recovery failed');
  assert.deepEqual(calls.navigations, []);
});

test('choosing an existing purchase from the library records cart-entry intent for reload', async () => {
  const { context: page, cart, calls } = harness();
  const accountId = '00000000-0000-4000-8000-000000000001';
  page.accountDesignReference = { id: accountId };
  cart.write([{ id: id('a'), productKey: 'mug', accountDesignId: accountId }]);
  page.askDesignStateChoice = async () => `edit:${id('a')}`;
  page.loadOrderItem = async value => { page.editingOrderItemId = value; };
  assert.equal(await page.approveCurrentDesign(), false);
  assert.equal(calls.posts, 0);
  assert.equal(calls.replaced.at(-1), `/e/event-a/configure?edit=${id('a')}`);
  assert.equal(cart.read().length, 1);
});

test('source and rebuild history actions re-enable when the workspace leaves its busy state', () => {
  const { context: page } = harness();
  const nodes = new Map();
  page.document.getElementById = id => { if (!nodes.has(id)) nodes.set(id, {}); return nodes.get(id); };
  page.content.querySelectorAll = () => [];
  page.checkoutPanel = { setAttribute() {} };
  page.WolkenworteActions = { setBusy() {} };
  vm.runInContext(pageFunction('setOrderActionsBusy'), page);
  page.cloudRebuildUndo = {};
  page.orderActionPending = true;
  page.setOrderActionsBusy(true); page.updateCloudNotice();
  assert.equal(nodes.get('check-live-words').disabled, true);
  page.orderActionPending = false;
  page.setOrderActionsBusy(false);
  assert.equal(nodes.get('check-live-words').disabled, false);
  assert.equal(nodes.get('undo-cloud-rebuild').disabled, false);
});

test('the active cart item is a status rather than an indistinguishable Open action', async () => {
  const {JSDOM}=require('jsdom'),{translate}=require('../src/i18n');
  const dom=new JSDOM('<div id="list"></div><span id="count"></span>');
  try {
    const {context:page,cart,calls}=harness();
    cart.write([{id:id('a'),productKey:'mug'},{id:id('b'),productKey:'mug'}]);
    const before=JSON.stringify(cart.read());
    page.document=dom.window.document;page.orderList=page.document.getElementById('list');page.orderCount=page.document.getElementById('count');
    page.updateHeaderCart=()=>{};page.selectedOrientationOption=()=>null;page.createOrderItemThumbnail=()=>page.document.createElement('img');
    page.printfulMockupStates=new Map();page.PRINTFUL_MOCKUP_TOOLS_ENABLED=false;
    page.setText=(element,source,params)=>{element.textContent=translate(source,'en',params);};
    page.setTranslatedAttribute=(element,name,source,params)=>element.setAttribute(name,translate(source,'en',params));
    page.editingOrderItemId=id('a');vm.runInContext(pageFunction('productPriceText')+'\n'+pageFunction('renderOrderBox'),page);page.renderOrderBox();
    const current=page.orderList.querySelector('[aria-current="true"]');
    assert.equal(current.tagName,'SPAN');assert.equal(current.textContent,'Currently editing');
    assert.equal(page.orderList.querySelectorAll('.order-edit').length,1);
    assert.equal(page.orderList.querySelector('.order-edit').textContent,'Open');
    page.orderList.querySelector('.order-edit').click();await new Promise(setImmediate);assert.deepEqual(calls.opened,[id('b')]);
    page.editingOrderItemId=id('b');page.renderOrderBox();
    assert.equal(page.orderList.children[1].querySelector('[aria-current="true"]').tagName,'SPAN');
    assert.equal(page.orderList.children[0].querySelector('.order-edit').disabled,false);
    assert.equal(JSON.stringify(cart.read()),before);
  } finally {dom.window.close();}
});

test('ordinary source feedback stays in options while actionable feedback can occupy a compact notice', () => {
  const {JSDOM}=require('jsdom');
  const dom=new JSDOM('<div id="cloud-source-status" hidden><p data-cloud-feedback="notice" hidden></p></div><p id="options-feedback" data-cloud-feedback hidden></p>');
  try {
    const {context:page}=harness();page.document=dom.window.document;
    vm.runInContext(pageFunction('setCloudFeedback'),page);
    page.setCloudFeedback('No new words');
    assert.equal(page.document.getElementById('cloud-source-status').hidden,true);
    assert.equal(page.document.getElementById('options-feedback').hidden,false);
    page.setCloudFeedback('Please retry',{notice:true});
    assert.equal(page.document.getElementById('cloud-source-status').hidden,false);
    assert.equal(page.document.querySelector('[data-cloud-feedback="notice"]').hidden,false);
    page.setCloudFeedback('');
    assert.equal(page.document.getElementById('cloud-source-status').hidden,true);
    assert.ok([...page.document.querySelectorAll('[data-cloud-feedback]')].every(element=>element.hidden));
  } finally {dom.window.close();}
});
