'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const { JSDOM } = require('jsdom');
const ejs = require('ejs');

function fixture({ mobile = true } = {}) {
  const markup = ejs.render(fs.readFileSync(require.resolve('../views/partials/mobile-canvas.ejs'), 'utf8'), { designAccountsEnabled: false });
  const dom = new JSDOM(markup);
  const document = dom.window.document;
  const root = { innerWidth: 844, innerHeight: 390,
    WolkenworteDevice: require('../public/js/device'), navigator: { userAgent: mobile ? 'iPhone Safari' : 'Macintosh Safari' },
    visualViewport: { width: 844, height: 72, offsetTop: 180, offsetLeft: 0 } };
  vm.runInNewContext(fs.readFileSync(require.resolve('../public/js/mobile-canvas-workspace'), 'utf8'), {
    window: root, requestAnimationFrame: callback => callback(),
  });
  const workspace = Object.create(root.MobileCanvasWorkspace.prototype);
  Object.assign(workspace, { document, dialog: document.querySelector('dialog'), active: true,
    chooseView() {}, onLayout() {} });
  return { dom, document, root, workspace };
}

test('desktop cannot open the mobile canvas even when compact or coarse media matches', t => {
  const { dom, document, workspace } = fixture({ mobile: false });
  t.after(() => dom.window.close());
  workspace.media = { matches: true };
  workspace.active = false;
  let mutations = 0;
  workspace.workspace = { close: () => { mutations++; } };
  workspace.onEnter = () => { mutations++; };
  assert.equal(workspace.open(document.createElement('button')), false);
  assert.equal(mutations, 0);
  assert.equal(workspace.active, false);
  assert.equal(document.documentElement.classList.contains('mobile-canvas-open'), false);
});

test('mobile text entry follows the visual viewport height and keyboard scroll offset', t => {
  const { dom, document, root, workspace } = fixture();
  t.after(() => dom.window.close());
  const object = { editorKind: 'text', text: 'Liebe' };
  workspace.editor = { selectedObjects: () => [object], objectText: target => target.text };
  assert.equal(workspace.openTextEditor(), true);
  assert.equal(document.activeElement.id, 'mobile-canvas-text');
  assert.equal(document.activeElement.value, 'Liebe');
  assert.equal(workspace.dialog.dataset.entry, 'word');
  assert.equal(workspace.dialog.hasAttribute('data-keyboard'), true);
  assert.equal(workspace.dialog.style.getPropertyValue('--mobile-viewport-height'), '72px');
  assert.equal(workspace.dialog.style.getPropertyValue('--mobile-viewport-top'), '180px');
  root.visualViewport.offsetTop = 215;
  root.visualViewport.height = 64;
  workspace.syncViewport();
  assert.equal(workspace.dialog.style.getPropertyValue('--mobile-viewport-height'), '64px');
  assert.equal(workspace.dialog.style.getPropertyValue('--mobile-viewport-top'), '215px');
  document.activeElement.value = 'Discard this';
  workspace.closeKeyboardEditor();
  assert.equal(object.text, 'Liebe');
  assert.equal(workspace.keyboardSession, null);
  assert.equal(workspace.dialog.dataset.entry, undefined);
  assert.equal(workspace.dialog.hasAttribute('data-keyboard'), false);
  assert.equal(document.getElementById('mobile-canvas-text-editor').hidden, true);
});

test('rotation and font size use isolated drafts, retain units and commit only on Done', async t => {
  for (const kind of ['rotation', 'font-size']) {
    const { dom, document, root, workspace } = fixture();
    t.after(() => dom.window.close());
    const id = kind === 'rotation' ? 'editor-angle' : 'editor-font-size';
    document.querySelector('.mobile-canvas-body').insertAdjacentHTML('beforeend', `<input id="${id}" type="number" value="12.5" readonly>`);
    const source = document.getElementById(id), object = { editorId: 'word', editorKind: 'text' };
    const commits = [];
    workspace.editor = { selectedObjects: () => [object], updateSelectionPanel() {},
      setActiveAngle: value => { commits.push(value); source.value = value; return true; },
      setActiveFontSize: value => { commits.push(value); source.value = value; return true; },
      displayPointSize: value => String(value), feedback: { textContent: '' } };
    workspace.tool = 'properties';
    assert.equal(workspace.openNumericEditor(kind), true);
    assert.equal(workspace.dialog.dataset.entry, kind);
    assert.equal(document.activeElement.id, 'mobile-canvas-text');
    assert.equal(document.activeElement.inputMode, 'decimal');
    assert.equal(document.getElementById('mobile-canvas-entry-unit').textContent, kind === 'rotation' ? '°' : 'pt');
    document.activeElement.value = '23,5';
    root.visualViewport.height = 64; root.visualViewport.offsetTop = 205;
    workspace.syncViewport();
    assert.equal(document.activeElement.value, '23,5', 'viewport changes must not overwrite the draft');
    assert.equal(source.value, '12.5');
    workspace.closeKeyboardEditor({ cancel: true });
    assert.deepEqual(commits, []);
    assert.equal(source.value, '12.5');
    assert.equal(workspace.tool, 'properties');
    workspace.openNumericEditor(kind);
    document.activeElement.value = '23,5';
    assert.equal(await workspace.saveKeyboardEditor(), true);
    assert.deepEqual(commits, [23.5]);
    assert.equal(workspace.keyboardSession, null);
    assert.equal(workspace.dialog.hasAttribute('data-keyboard'), false);
    assert.equal(workspace.tool, 'properties');
  }
});

test('invalid numeric drafts and font sizes outside the print area remain editable without committing', async t => {
  const { dom, document, workspace } = fixture();
  t.after(() => dom.window.close());
  document.querySelector('.mobile-canvas-body').insertAdjacentHTML('beforeend', '<input id="editor-angle" type="number" value="0"><input id="editor-font-size" type="number" value="12">');
  let commits = 0;
  workspace.editor = { selectedObjects: () => [{ editorId: 'word' }],
    setActiveAngle() { commits++; },
    setActiveFontSize() { return false; }, displayPointSize: value => String(value),
    feedback: { textContent: 'Diese Schriftgröße passt nicht auf die aktuelle Druckfläche.' } };
  for (const [kind, value] of [['rotation', ''], ['rotation', 'Infinity'], ['font-size', '0'], ['font-size', '5000']]) {
    workspace.openNumericEditor(kind);
    document.getElementById('mobile-canvas-text').value = value;
    assert.equal(await workspace.saveKeyboardEditor(), false);
    assert.equal(workspace.keyboardSession.kind, kind);
    assert.equal(document.getElementById('mobile-canvas-entry-error').hidden, false);
    assert.equal(document.getElementById('mobile-canvas-text').getAttribute('aria-invalid'), 'true');
    workspace.closeKeyboardEditor({ cancel: true });
  }
  assert.equal(commits, 0);
});

test('an async word save cannot dismiss or unlock a newer keyboard session', async t => {
  const { dom, document, workspace } = fixture();
  t.after(() => dom.window.close());
  document.querySelector('.mobile-canvas-body').insertAdjacentHTML('beforeend', '<input id="editor-angle" type="number" value="0">');
  let finish;
  const object = { editorKind: 'text', editorId: 'word' };
  workspace.editor = { selectedObjects: () => [object], objectText: () => 'Liebe',
    applyTextChange: () => new Promise(resolve => { finish = resolve; }), updateSelectionPanel() {} };
  workspace.openTextEditor();
  const saving = workspace.saveKeyboardEditor();
  workspace.closeKeyboardEditor({ cancel: true });
  assert.equal(workspace.keyboardSession.saving, true, 'Cancel is unavailable while a confirmed change is saving');
  workspace.closeKeyboardEditor();
  workspace.openNumericEditor('rotation');
  document.getElementById('mobile-canvas-text').value = '25';
  assert.equal(document.getElementById('mobile-canvas-text-done').disabled, false);
  const current = workspace.keyboardSession;
  finish(); await saving;
  assert.equal(workspace.keyboardSession, current);
  assert.equal(document.activeElement.value, '25');
});

test('both search fields reuse their actual results and restore nodes and query on Cancel', async t => {
  for (const kind of ['emoji', 'elements']) {
    const { dom, document, workspace } = fixture();
    t.after(() => dom.window.close());
    let source, results;
    if (kind === 'emoji') {
      document.getElementById('mobile-canvas-emoji').innerHTML = '<div class="ww-emoji-picker"><input type="search" value="old"><div class="ww-emoji-grid"></div></div>';
      results = document.querySelector('.ww-emoji-picker'); source = results.querySelector('input');
      workspace.emojiPicker = { picker: { panel: results, renderVirtualWindow() {} } };
    } else {
      source = document.getElementById('mobile-canvas-search'); source.value = 'old';
      results = document.getElementById('mobile-canvas-element-list');
    }
    const parent = results.parentElement;
    const queries = [];
    source.addEventListener('input', () => queries.push(source.value));
    workspace.editor = { selectedObjects: () => [] };
    workspace.openSearchEditor(kind, source);
    assert.equal(document.activeElement.id, 'mobile-canvas-text');
    assert.equal(document.activeElement.type, 'search');
    assert.equal(results.parentElement.id, 'mobile-canvas-keyboard-results');
    document.activeElement.value = 'new'; workspace.updateKeyboardSearch();
    assert.equal(source.value, 'new');
    workspace.closeKeyboardEditor({ cancel: true });
    assert.deepEqual(queries, ['new', 'old']);
    assert.equal(source.value, 'old');
    assert.equal(results.parentElement, parent);
    workspace.openSearchEditor(kind, source);
    document.activeElement.value = 'keep'; workspace.updateKeyboardSearch();
    assert.equal(await workspace.saveKeyboardEditor(), true);
    assert.equal(source.value, 'keep');
    assert.equal(results.parentElement, parent);
    assert.equal(workspace.dialog.hasAttribute('data-entry-search'), false);
    assert.equal(document.activeElement.id, '');
  }
});

test('a stale landscape visual viewport never restricts ordinary portrait editing', t => {
  const { dom, root, workspace } = fixture();
  t.after(() => dom.window.close());
  root.innerWidth = 390;
  root.innerHeight = 844;
  workspace.syncViewport();
  assert.equal(workspace.dialog.hasAttribute('data-keyboard'), false);
  const css = fs.readFileSync(require.resolve('../public/configurator-workspace.css'), 'utf8');
  const normal = css.match(/\.mobile-canvas-dialog \{[\s\S]*?\n\}/)[0];
  assert.match(normal, /height: 100dvh/);
  assert.doesNotMatch(normal, /--mobile-viewport-height/);
});

test('quick text entry requires a single text object and keeps the existing session', t => {
  const { dom, workspace } = fixture();
  t.after(() => dom.window.close());
  for (const objects of [[], [{ editorKind: 'image' }], [{ editorKind: 'text' }, { editorKind: 'text' }]]) {
    workspace.editor = { selectedObjects: () => objects };
    assert.equal(workspace.openTextEditor(), false);
  }
  const object = { editorKind: 'text' };
  workspace.editor = { selectedObjects: () => [object], objectText: () => 'Test' };
  workspace.openTextEditor();
  const session = workspace.keyboardSession;
  assert.equal(workspace.openTextEditor(), true);
  assert.equal(workspace.keyboardSession, session);
});

test('narrow phones reuse the warning button in the rail and return it to the top toolbar after resizing', t => {
  const { dom, document, root, workspace } = fixture();
  t.after(() => dom.window.close());
  document.body.insertAdjacentHTML('beforeend', '<button id="editor-overlap-trigger">! 1</button><div id="mobile-canvas-overlap-rail"></div><div id="mobile-canvas-overlaps"></div>');
  const trigger = document.getElementById('editor-overlap-trigger');
  root.innerWidth = 320;
  workspace.placeOverlapTrigger();
  assert.equal(trigger.parentElement.id, 'mobile-canvas-overlap-rail');
  root.innerWidth = 621;
  workspace.placeOverlapTrigger();
  assert.equal(trigger.parentElement.id, 'mobile-canvas-overlaps');
  assert.equal(document.querySelectorAll('#editor-overlap-trigger').length, 1);
});

test('rotation guidance follows the active print area and device viewport, not the product preview or stale visual viewport',t=>{
  const {dom,document,root,workspace}=fixture();t.after(()=>dom.window.close());
  workspace.view='canvas';workspace.editor={width:2700,height:1050};
  const hint=document.getElementById('mobile-canvas-orientation-hint');
  root.innerWidth=390;root.innerHeight=844;
  workspace.syncOrientationHint();assert.equal(hint.hidden,false,'wide mug artwork benefits from landscape');
  workspace.editor={width:2400,height:3600};workspace.syncOrientationHint();assert.equal(hint.hidden,true,'portrait poster stays upright');
  workspace.editor={width:2400,height:2400};workspace.syncOrientationHint();assert.equal(hint.hidden,true,'square artwork needs no preference');
  workspace.editor={width:3600,height:2400};workspace.syncOrientationHint();assert.equal(hint.hidden,false,'landscape poster uses the same print-area rule');
  root.innerWidth=844;root.innerHeight=390;workspace.syncOrientationHint();assert.equal(hint.hidden,true);
  root.innerWidth=390;root.innerHeight=844;workspace.view='product';workspace.syncOrientationHint();assert.equal(hint.hidden,true);
  workspace.view='canvas';workspace.keyboardSession={kind:'word'};workspace.syncOrientationHint();assert.equal(hint.hidden,true);
  workspace.keyboardSession=null;workspace.syncOrientationHint();assert.equal(hint.hidden,false);
  workspace.active=false;workspace.syncOrientationHint();assert.equal(hint.hidden,true);
});
test('rotation guidance can be dismissed for the session without changing the artwork or locking orientation',t=>{
  const {dom,document,root,workspace}=fixture();t.after(()=>dom.window.close());
  root.innerWidth=390;root.innerHeight=844;workspace.view='canvas';workspace.editor=Object.freeze({width:2700,height:1050});
  const writes=[];root.sessionStorage={setItem:(...args)=>writes.push(args)};
  workspace.syncOrientationHint();workspace.dismissOrientationHint();
  assert.equal(document.getElementById('mobile-canvas-orientation-hint').hidden,true);
  assert.deepEqual(writes,[['ww-canvas-orientation-dismissed','1']]);
  root.innerWidth=844;root.innerHeight=390;workspace.syncOrientationHint();
  root.innerWidth=390;root.innerHeight=844;workspace.syncOrientationHint();
  assert.equal(document.getElementById('mobile-canvas-orientation-hint').hidden,true);
});
