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

test('selection capabilities update without opening or resizing a panel', () => {
  const workspace = Object.create(WolkenworteWorkspace.prototype);
  workspace.active = null;
  for (const capabilities of [
    { text: false, font: false, color: false, transform: false },
    { text: true, font: true, color: true, transform: true },
    { text: false, font: true, color: true, transform: true },
    { text: false, font: false, color: false, transform: true },
  ]) {
    workspace.updateSelection(capabilities);
    assert.equal(workspace.capabilities, capabilities);
    assert.equal(workspace.active, null);
  }
});

test('desktop text editing remains on the canvas', () => {
  const workspace = Object.create(WolkenworteWorkspace.prototype);
  workspace.media = { matches: false };
  assert.equal(workspace.openTextEditor(), false);
});

test('compact text editing focuses the directly visible field', () => {
  const calls = [];
  const input = {
    disabled: false,
    focus: options => calls.push(['focus', options]),
    select: () => calls.push(['select']),
  };
  const workspace = Object.create(WolkenworteWorkspace.prototype);
  workspace.document = { getElementById: id => id === 'editor-text' ? input : null };
  workspace.media = { matches: true };
  workspace.capabilities = { text: true };
  assert.equal(workspace.openTextEditor(), true);
  assert.deepEqual(calls, [['focus', { preventScroll: true }], ['select']]);
  input.disabled = true;
  assert.equal(workspace.openTextEditor(), false);
  workspace.capabilities.text = false;
  input.disabled = false;
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

test('closing a chooser restores focus without scrolling', () => {
  const workspace = Object.create(WolkenworteWorkspace.prototype);
  const calls = [];
  workspace.active = {
    panel: { style: { removeProperty() {} }, removeAttribute() {} },
    trigger: { disabled: false, getClientRects: () => [1], setAttribute() {},
      focus: options => calls.push(['focus', options]) },
  };
  workspace.finishClose();
  assert.deepEqual(calls, [['focus', { preventScroll: true }]]);
  assert.equal(workspace.active, null);
});

test('closing a chooser blurs its focused field before the panel closes', () => {
  const workspace = Object.create(WolkenworteWorkspace.prototype);
  const calls = [];
  workspace.document = { activeElement: { blur: () => calls.push('blur') } };
  workspace.active = { mode: 'modal', panel: {
    open: true, contains: () => true, close: () => calls.push('close'),
  } };
  workspace.finishClose = () => calls.push('restore');
  workspace.close();
  assert.deepEqual(calls, ['blur', 'close', 'restore']);
});

test('responsive inspector exposes one direct copy of every editor control', () => {
  const source = fs.readFileSync(require.resolve('../views/configure.ejs'), 'utf8');
  for (const id of ['editor-text', 'editor-font-picker', 'editor-font-toggle', 'editor-font-menu',
    'editor-font-size', 'editor-bold', 'editor-italic', 'editor-underline', 'editor-linethrough',
    'editor-color']) {
    assert.equal(source.split(`id="${id}"`).length - 1, 1, id);
  }
  assert.doesNotMatch(source, /editor-font-select|id="editor-font"|fontSelect:/);
  for (const id of ['editor-smaller', 'editor-delete']) assert.equal(source.split(`id: '${id}'`).length - 1, 1, id);
  for (const name of ['theme', 'orientation']) {
    assert.ok(source.includes(`<dialog class="config-panel" id="${name}-panel"`));
    assert.ok(source.includes(`data-panel-trigger="${name}-panel"`));
  }
  assert.doesNotMatch(source, /data-editor-tool=|id="editor-tool-panel"/);
  assert.match(source, /id="editor-compact-inspector"/);
  assert.match(source, /class="editor-properties" id="editor-properties"/);
  assert.match(source, /class="editor-format-controls"/);
  assert.match(source, /data-editor-section="transform" role="group" aria-label="Anpassen"/);
  assert.doesNotMatch(source, /<details class="toolbar-menu"/);
  assert.doesNotMatch(source, /\.editor-selection:not\(\.is-active\)/);
  for (const locale of ['en', 'fr', 'it', 'es', 'tr']) {
    const catalog = require(`../public/locales/${locale}.json`);
    for (const label of ['Farbe', 'Anpassen',
      'Text formatieren', 'Schriftgröße', 'Schriftgröße in pt', 'Fett', 'Kursiv', 'Unterstrichen',
      'Durchgestrichen']) assert.ok(catalog[label]);
  }
});
