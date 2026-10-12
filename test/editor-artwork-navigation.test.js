'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const fabric = require('fabric/node');
const { createCanvas } = require('canvas');
const fonts = require('../src/designFonts');
const core = require('../public/js/wordcloud-core');

function fixture(t, mobileViewport) {
  const root = { fabric, DesignFonts: fonts, WordCloudCore: core, WolkenworteEmoji: { hasEmoji: () => false } };
  vm.runInNewContext(fs.readFileSync(require.resolve('../public/js/mug-editor'), 'utf8'), { window: root, setTimeout, clearTimeout });
  const editor = Object.create(root.MugPrintEditor.prototype);
  Object.assign(editor, { editorScale: .5, canvasWidth: 500, canvasHeight: 300, mobileViewport,
    history: ['unchanged history'], historyIndex: 0,
    canvas: new fabric.Canvas(null, { width: 500, height: 300, enableRetinaScaling: false }),
    shell: { clientWidth: 1000, clientHeight: 600 }, scroll: { clientWidth: 300, clientHeight: 240 },
    touchController: { finish() {} }, updateSelectionPanel() {}, refreshViewport() {},
    setZoom(zoom) { this.zoom = Math.max(1, zoom); },
  });
  const a = editor.makeDesignObject({ id: 'a', text: 'Liebe', x: 400, y: 200, fontSize: 80, color: '#000000', angle: 30 });
  const b = editor.makeDesignObject({ id: 'b', text: 'Glück', x: 450, y: 230, fontSize: 80, color: '#000000' });
  editor.canvas.add(a, b);
  t.after(async () => { editor.clearArtworkHighlight?.(); await editor.canvas.dispose(); });
  return { editor, a, b };
}
for (const mobile of [false, true]) test(`artwork navigation selects one element, fits the pair and preserves design/history (${mobile ? 'mobile' : 'desktop'})`, t => {
  const { editor, a, b } = fixture(t, mobile);
  const before = JSON.stringify(editor.getDesign());
  const history = editor.history;
  editor.canvas.setActiveObject(a);
  assert.equal(editor.focusArtworkElement('b', ['a', 'b']), true);
  assert.equal(editor.canvas.getActiveObject(), b);
  assert.equal(editor.canvas.getObjects().length, 2);
  assert.equal(JSON.stringify(editor.getDesign()), before);
  assert.equal(editor.history, history);
  assert.equal(editor.historyIndex, 0);
  assert.ok(editor.zoom >= 1 && editor.zoom <= (mobile ? 4 : 2));
  if (mobile) assert.ok(Number.isFinite(editor.mobilePanX) && Number.isFinite(editor.mobilePanY));
  else assert.ok(Number.isFinite(editor.scroll.scrollLeft) && Number.isFinite(editor.scroll.scrollTop));
  editor.canvas.renderAll();
  assert.equal(JSON.stringify(editor.getDesign()), before);
  editor.clearArtworkHighlight();
  assert.equal(editor.focusArtworkElement('deleted', ['deleted']), false);
});
