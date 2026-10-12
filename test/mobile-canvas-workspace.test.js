'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const { JSDOM } = require('jsdom');

function fixture() {
  const dom = new JSDOM('<dialog id="mobile-canvas-dialog"><form id="mobile-canvas-text-editor" hidden><input id="mobile-canvas-text"></form></dialog>');
  const document = dom.window.document;
  const root = { innerWidth: 844, innerHeight: 390,
    visualViewport: { width: 844, height: 72, offsetTop: 180, offsetLeft: 0 } };
  vm.runInNewContext(fs.readFileSync(require.resolve('../public/js/mobile-canvas-workspace'), 'utf8'), {
    window: root, requestAnimationFrame: callback => callback(),
  });
  const workspace = Object.create(root.MobileCanvasWorkspace.prototype);
  Object.assign(workspace, { document, dialog: document.querySelector('dialog'), active: true,
    chooseView() {}, onLayout() {} });
  return { dom, document, root, workspace };
}

test('mobile text entry follows the visual viewport height and keyboard scroll offset', t => {
  const { dom, document, root, workspace } = fixture();
  t.after(() => dom.window.close());
  const object = { editorKind: 'text', text: 'Liebe' };
  workspace.editor = { selectedObjects: () => [object], objectText: target => target.text };
  assert.equal(workspace.openTextEditor(), true);
  assert.equal(document.activeElement.id, 'mobile-canvas-text');
  assert.equal(document.activeElement.value, 'Liebe');
  assert.equal(workspace.dialog.dataset.textEditing, 'true');
  assert.equal(workspace.dialog.style.getPropertyValue('--mobile-viewport-height'), '72px');
  assert.equal(workspace.dialog.style.getPropertyValue('--mobile-viewport-top'), '180px');
  root.visualViewport.offsetTop = 215;
  root.visualViewport.height = 64;
  workspace.syncViewport();
  assert.equal(workspace.dialog.style.getPropertyValue('--mobile-viewport-height'), '64px');
  assert.equal(workspace.dialog.style.getPropertyValue('--mobile-viewport-top'), '215px');
  document.activeElement.value = 'Discard this';
  workspace.closeTextEditor();
  assert.equal(object.text, 'Liebe');
  assert.equal(workspace.textSession, null);
  assert.equal(workspace.dialog.dataset.textEditing, undefined);
  assert.equal(document.getElementById('mobile-canvas-text-editor').hidden, true);
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
  const session = workspace.textSession;
  assert.equal(workspace.openTextEditor(), true);
  assert.equal(workspace.textSession, session);
});

test('narrow phones reuse the warning button in the rail and return it to the top toolbar after resizing', t => {
  const { dom, document, root, workspace } = fixture();
  t.after(() => dom.window.close());
  document.body.insertAdjacentHTML('beforeend', '<button id="editor-overlap-trigger">! 1</button><div id="mobile-canvas-overlap-rail"></div><div id="mobile-canvas-overlaps"></div>');
  const trigger = document.getElementById('editor-overlap-trigger');
  root.innerWidth = 320;
  workspace.placeOverlapTrigger();
  assert.equal(trigger.parentElement.id, 'mobile-canvas-overlap-rail');
  root.innerWidth = 390;
  workspace.placeOverlapTrigger();
  assert.equal(trigger.parentElement.id, 'mobile-canvas-overlaps');
  assert.equal(document.querySelectorAll('#editor-overlap-trigger').length, 1);
});
