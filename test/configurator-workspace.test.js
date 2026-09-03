'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { placePanel, WolkenworteWorkspace } = require('../public/js/configurator-workspace');

test('chooser placement stays inside the viewport and flips above when necessary', () => {
  assert.deepEqual(placePanel({ top: 100, bottom: 180, right: 800 },
    { width: 560, height: 300 }, { width: 1000, height: 900 }),
  { left: 240, top: 188, maxHeight: 700 });
  assert.deepEqual(placePanel({ top: 650, bottom: 730, right: 980 },
    { width: 560, height: 300 }, { width: 1000, height: 800 }),
  { left: 420, top: 342, maxHeight: 630 });
  for (const width of [320, 390, 620, 621, 940, 941, 1180, 1440]) {
    for (const height of [320, 640, 900]) {
      for (const top of [0, height / 2, height - 80]) {
        const result = placePanel({ top, bottom: top + 80, right: width + 100 },
          { width: 560, height: 1200 }, { width, height });
        assert.ok(result.left >= 12);
        assert.ok(result.left + Math.min(560, width - 24) <= width - 12);
        assert.ok(result.top >= 12);
        assert.ok(result.top + result.maxHeight <= height - 12);
      }
    }
  }
});

test('selection only enables dock tools; it never opens or resizes a panel', async () => {
  const workspace = Object.create(WolkenworteWorkspace.prototype);
  workspace.toolButtons = ['text', 'font', 'color', 'transform'].map(tool => ({ dataset: { editorTool: tool } }));
  workspace.active = null;
  for (const capabilities of [
    { text: false, font: false, color: false, transform: false },
    { text: true, font: true, color: true, transform: true },
    { text: false, font: true, color: true, transform: true },
    { text: false, font: false, color: false, transform: true },
  ]) {
    workspace.updateSelection(capabilities);
    await Promise.resolve();
    for (const button of workspace.toolButtons) {
      assert.equal(button.disabled, !capabilities[button.dataset.editorTool]);
    }
    assert.equal(workspace.active, null);
  }
});

test('transient Fabric deselection does not close a tool, but final deselection does', async () => {
  const workspace = Object.create(WolkenworteWorkspace.prototype);
  workspace.toolButtons = [];
  workspace.active = { tool: 'transform' };
  let closed = 0;
  workspace.close = () => { closed++; workspace.active = null; };
  workspace.updateSelection({ transform: false });
  workspace.updateSelection({ transform: true });
  await Promise.resolve();
  assert.equal(closed, 0);
  workspace.updateSelection({ transform: false });
  await Promise.resolve();
  assert.equal(closed, 1);
});

test('desktop text editing does not open the compact sheet', () => {
  const workspace = Object.create(WolkenworteWorkspace.prototype);
  workspace.media = { matches: false };
  assert.equal(workspace.openTextEditor(), false);
});

test('choosers use a native modal fallback when Popover is unavailable', () => {
  const workspace = Object.create(WolkenworteWorkspace.prototype);
  const trigger = { dataset: { panelTrigger: 'theme-panel' } };
  const panel = {};
  const presentations = [];
  workspace.document = { getElementById: () => panel };
  workspace.media = { matches: false };
  workspace.close = () => {};
  workspace.show = (element, invoker, popover) => presentations.push(popover);
  workspace.toggleChooser(trigger);
  panel.showPopover = () => {};
  workspace.toggleChooser(trigger);
  workspace.media.matches = true;
  workspace.toggleChooser(trigger);
  assert.deepEqual(presentations, [false, true, false]);
});

test('closing restores the same controls and focus without scrolling', () => {
  const workspace = Object.create(WolkenworteWorkspace.prototype);
  const calls = [];
  const section = {};
  const next = {};
  workspace.active = {
    panel: { style: { removeProperty() {} }, removeAttribute() {}, dataset: { tool: 'font' } },
    trigger: { disabled: false, getClientRects: () => [1], setAttribute() {},
      focus: options => calls.push(['focus', options]) },
    tool: 'font',
  };
  workspace.sectionHome = { section, next, parent: { insertBefore: (...args) => calls.push(['restore', ...args]) } };
  workspace.setFontPickerInline = inline => calls.push(['inline', inline]);
  workspace.finishClose();
  assert.deepEqual(calls, [['restore', section, next], ['inline', false], ['focus', { preventScroll: true }]]);
  assert.equal(workspace.active, null);
  assert.equal(workspace.sectionHome, null);
});

test('text sheet closure commits before moving the focused field', () => {
  const workspace = Object.create(WolkenworteWorkspace.prototype);
  const calls = [];
  workspace.document = { activeElement: { blur: () => calls.push('blur') } };
  workspace.commitText = () => calls.push('commit');
  workspace.active = { tool: 'text', mode: 'modal', panel: {
    open: true, contains: () => true, close: () => calls.push('close'),
  } };
  workspace.finishClose = () => calls.push('restore');
  workspace.close();
  assert.deepEqual(calls, ['blur', 'commit', 'close', 'restore']);
});

test('responsive choosers and inspector use native panels and one copy of each control', () => {
  const source = fs.readFileSync(require.resolve('../views/configure.ejs'), 'utf8');
  for (const id of ['editor-text', 'editor-font-picker', 'editor-font-toggle', 'editor-font-menu', 'editor-color']) {
    assert.equal(source.split(`id="${id}"`).length - 1, 1, id);
  }
  assert.doesNotMatch(source, /editor-font-select|id="editor-font"|fontSelect:/);
  for (const id of ['editor-smaller', 'editor-delete']) assert.equal(source.split(`id: '${id}'`).length - 1, 1, id);
  for (const name of ['theme', 'orientation', 'placement']) {
    assert.ok(source.includes(`<dialog class="config-panel" id="${name}-panel"`));
    assert.ok(source.includes(`data-panel-trigger="${name}-panel"`));
  }
  assert.doesNotMatch(source, /<details class="toolbar-menu"/);
  assert.doesNotMatch(source, /\.editor-selection:not\(\.is-active\)/);
  for (const locale of ['en', 'fr', 'it', 'es', 'tr']) {
    const catalog = require(`../public/locales/${locale}.json`);
    for (const label of ['Text', 'Schrift', 'Farbe', 'Anpassen', 'Schließen', 'Fertig']) assert.ok(catalog[label]);
  }
});
