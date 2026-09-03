'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const fabric = require('fabric/node');
const { createCanvas } = require('canvas');
const DesignFonts = require('../src/designFonts');
const WordCloudCore = require('../public/js/wordcloud-core');
const WolkenworteEmoji = require('../public/js/emoji-catalog');

function setup(t) {
  const downloads = [];
  const root = { fabric, DesignFonts, WordCloudCore, WolkenworteEmoji };
  vm.runInNewContext(fs.readFileSync(require.resolve('../public/js/mug-editor'), 'utf8'), {
    window: root, document: { fonts: { load: () => new Promise((resolve, reject) => downloads.push({
      resolve: () => resolve([{ status: 'loaded' }]), reject,
    })) } },
  });
  const editor = Object.create(root.MugPrintEditor.prototype);
  Object.assign(editor, {
    width: 2700, height: 1050, canvasWidth: 1350, canvasHeight: 525,
    editorScale: .5, printMargin: 24, margin: 12, idCounter: 0,
    textInput: { value: 'test' }, measureContext: createCanvas(1, 1).getContext('2d'),
    canvas: new fabric.Canvas(null, { width: 1350, height: 525, enableRetinaScaling: false }),
  });
  for (const method of ['updateSelectionPanel', 'emitChange', 'recordHistory', 'flashBoundary', 'setFeedback']) editor[method] = () => {};
  editor.setDesign([{ id: 'word', text: 'test', x: 1350, y: 525, fontSize: 100, color: '#2455f5', fontFamily: 'classic' }]);
  editor.canvas.setActiveObject(editor.canvas.getObjects()[0]);
  t.after(() => editor.canvas.dispose());
  return { editor, downloads };
}

test('the latest font choice wins even when the earlier font downloads last', async t => {
  const { editor, downloads } = setup(t);
  const first = editor.setActiveFont('lora');
  const second = editor.setActiveFont('caveat');
  assert.equal(editor.hasPendingTextChange(), true, 'Navigation must notice the pending choice');
  assert.equal(editor.pendingFontChange, second, 'Saving must await the latest selected font');
  downloads[1].resolve(); await second;
  downloads[0].resolve(); await first;
  assert.equal(editor.getDesign()[0].fontFamily, 'caveat');
  assert.equal(editor.pendingFontChange, null);
});

test('a downloaded font cannot resurrect a deleted object or overwrite a restored design', async t => {
  const { editor, downloads } = setup(t);
  const pending = editor.setActiveFont('lora');
  editor.canvas.remove(editor.canvas.getObjects()[0]);
  downloads[0].resolve(); await pending;
  assert.equal(editor.getDesign().length, 0);
  editor.setDesign([{ id: 'new-word', text: 'neu', x: 1350, y: 525, fontSize: 100, color: '#2455f5', fontFamily: 'classic' }]);
  editor.canvas.setActiveObject(editor.canvas.getObjects()[0]);
  const next = editor.setActiveFont('montserrat');
  editor.setDesign(editor.getDesign()); // Undo/reset/restore fences previous downloads.
  downloads[1].resolve(); await next;
  assert.equal(editor.getDesign()[0].fontFamily, 'classic');
});

test('font download failure leaves the existing design intact and permits a retry', async t => {
  const { editor, downloads } = setup(t);
  const before = JSON.stringify(editor.getDesign());
  const first = editor.setActiveFont('baloo-2');
  downloads[0].reject(new Error('offline'));
  await assert.rejects(first, /offline/);
  assert.equal(editor.pendingFontChange, null);
  assert.equal(JSON.stringify(editor.getDesign()), before);
  const retry = editor.setActiveFont('baloo-2');
  downloads[1].resolve(); await retry;
  assert.equal(editor.getDesign()[0].fontFamily, 'baloo-2');
});
