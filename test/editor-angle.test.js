'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const fabric = require('fabric/node');
const { createCanvas } = require('canvas');
const { CanvasTouch } = require('../public/js/canvas-touch');
const DesignFonts = require('../src/designFonts');
const WordCloudCore = require('../public/js/wordcloud-core');
const EmojiCatalog = require('../public/js/emoji-catalog');
const MugIcons = require('../public/js/mug-icons');
const ConfiguratorSession = require('../public/js/configurator-session');
const { isPrintDesignWithinBounds } = require('../src/mugPrint');
const IMAGE_SOURCE = createCanvas(100, 100).toDataURL();

function control() {
  const listeners = {}, classes = new Set();
  return { value: '', disabled: true, hidden: true, textContent: '',
    classList: { add: name => classes.add(name), remove: name => classes.delete(name),
      contains: name => classes.has(name) },
    addEventListener: (name, listener) => { listeners[name] = listener; },
    fire: (name, event = {}) => listeners[name]?.({ preventDefault() {}, stopPropagation() {}, ...event }),
    select() {}, blur() { this.fire('blur'); }, setAttribute() {},
  };
}

function setup(t) {
  const timers = new Map();
  let timerId = 0;
  const document = { addEventListener() {}, querySelector: () => null };
  const root = { fabric, DesignContentBounds: require('../public/js/design-content-bounds'), CanvasTouch, DesignFonts, WordCloudCore, MugIcons,
    WolkenworteDevice: require('../public/js/device'), navigator: { userAgent: 'Android Chrome' },
    WolkenworteEmoji: { ...EmojiCatalog, getLoadedImage: () => createCanvas(72, 72), async preloadTexts() {} },
    PointerEvent: function () {}, matchMedia: () => ({ matches: true, addEventListener() {} }),
  };
  vm.runInNewContext(fs.readFileSync(require.resolve('../public/js/mug-editor'), 'utf8'), {
    window: root, document,
    setTimeout: callback => { timers.set(++timerId, callback); return timerId; },
    clearTimeout: id => timers.delete(id),
  });
  const editor = Object.create(root.MugPrintEditor.prototype);
  Object.assign(editor, {
    width: 2700, height: 1050, canvasWidth: 1350, canvasHeight: 525,
    editorScale: .5, printMargin: 24, margin: 12, idCounter: 0,
    textInput: control(), angleInput: control(), angleBadge: control(),
    fontButton: control(), fontMenu: control(), iconMenu: control(), styleButtons: {},
    history: [], historyIndex: -1, palette: ['#2455f5'],
    imageElements: new Map([[IMAGE_SOURCE, createCanvas(100, 100)]]),
    imageRefsBySource: new Map(), imageSourcesByRef: new Map(),
    measureContext: createCanvas(1, 1).getContext('2d'),
    canvas: new fabric.Canvas(null, { width: 1350, height: 525, enableRetinaScaling: false }),
    scroll: { addEventListener() {}, getBoundingClientRect: () => ({ left: 0, top: 0, width: 1350, height: 525 }) },
    shell: { getBoundingClientRect: () => ({ left: 0, top: 0, width: 1350, height: 525 }) },
  });
  for (const name of ['emitChange', 'updateHistoryButtons', 'flashBoundary', 'setFeedback']) editor[name] = () => {};
  editor.updateSelectionPanel = () => editor.syncAngleInput();
  editor.bindCanvasEvents();
  editor.bindTouchEvents();
  const options = {};
  for (const name of ['addButton', 'imageButton', 'imageInput', 'iconButton', 'undoButton', 'redoButton',
    'resetButton', 'selectAllButton', 'zoomOutButton', 'zoomInButton', 'moveUpButton', 'moveDownButton',
    'moveLeftButton', 'moveRightButton', 'smallerButton', 'largerButton', 'rotateLeftButton',
    'rotateRightButton', 'angleResetButton', 'duplicateButton', 'bringFrontButton', 'deleteButton', 'colorInput']) {
    options[name] = control();
  }
  editor.bindControls(options);
  t.after(() => editor.canvas.dispose());
  return { editor, timers, options };
}

const word = (id = 'word', angle = 0, x = 1350) => ({ id, text: 'Liebe', x, y: 525,
  fontSize: 150, color: '#2455f5', fontFamily: 'classic', angle });

test('absolute rotation survives repeated rotation, reselection, undo, redo and reload', t => {
  const { editor, options } = setup(t);
  editor.setDesign([word('word', 20)], { resetHistory: true });
  const object = editor.canvas.getObjects()[0];
  editor.canvas.setActiveObject(object);
  assert.equal(editor.angleInput.value, '20');
  options.rotateRightButton.fire('click');
  assert.equal(editor.angleInput.value, '35');
  editor.clearSelection();
  assert.equal(editor.angleInput.disabled, true);
  assert.equal(editor.angleBadge.hidden, true);
  editor.canvas.setActiveObject(object);
  assert.equal(editor.angleInput.value, '35');
  options.rotateRightButton.fire('click');
  assert.equal(editor.angleInput.value, '50');
  editor.mobileViewport = true;
  editor.undo();
  assert.equal(editor.angleInput.value, '35');
  editor.redo();
  assert.equal(editor.angleInput.value, '50');
  const saved = editor.getDesign();
  editor.setDesign(saved);
  editor.canvas.setActiveObject(editor.canvas.getObjects()[0]);
  assert.equal(editor.angleInput.value, '50');
});

test('decimal input, signed wrapping, invalid input and Escape preserve predictable angles', t => {
  const { editor } = setup(t);
  editor.setDesign([word()], { resetHistory: true });
  editor.canvas.setActiveObject(editor.canvas.getObjects()[0]);
  editor.angleInput.value = '24.2';
  assert.equal(editor.hasPendingAngleChange(), true);
  editor.angleInput.fire('keydown', { key: 'Enter' });
  assert.equal(editor.angleInput.value, '24.2');
  assert.equal(editor.getDesign()[0].angle, 24.2);
  assert.equal(editor.hasPendingAngleChange(), false);
  const length = editor.history.length;
  editor.angleInput.fire('change');
  assert.equal(editor.history.length, length, 'Enter followed by blur must not add another Undo step');
  editor.angleInput.value = '355';
  editor.angleInput.fire('change');
  assert.equal(editor.angleInput.value, '-5');
  for (const value of ['', 'not-a-number', 'Infinity']) {
    editor.angleInput.value = value;
    editor.angleInput.fire('change');
    assert.equal(editor.angleInput.value, '-5');
    assert.equal(editor.getDesign()[0].angle, -5);
  }
  editor.angleInput.value = '80';
  editor.angleInput.fire('keydown', { key: 'Escape' });
  assert.equal(editor.angleInput.value, '-5');
  assert.equal(editor.getDesign()[0].angle, -5);
  editor.setActiveAngle(-.2);
  assert.equal(editor.angleBadge.textContent, 'Drehung 0°', 'the badge never shows negative zero');
  editor.setActiveAngle(-180);
  assert.equal(editor.angleInput.value, '180');
  assert.equal(editor.hasPendingAngleChange(), false);
});

test('reset restores the unrotated orientation of text, emoji, motifs and uploaded images', t => {
  const { editor, options } = setup(t);
  const items = [word(), { ...word('emoji'), text: '❤️' },
    { id: 'motif', type: 'icon', icon: 'heart', x: 1350, y: 525, size: 200, angle: 90, color: '#2455f5' },
    { id: 'image', type: 'image', src: IMAGE_SOURCE, x: 1350, y: 525, width: 200, height: 150, angle: 90 }];
  for (const item of items) {
    editor.setDesign([{ ...item, angle: 90 }], { resetHistory: true });
    editor.canvas.setActiveObject(editor.canvas.getObjects()[0]);
    const before = editor.getDesign()[0];
    options.angleResetButton.fire('click');
    const after = editor.getDesign()[0];
    assert.equal(after.angle, 0, item.id);
    assert.equal(after.x, before.x);
    assert.equal(after.y, before.y);
    assert.equal(editor.angleInput.value, '0');
    assert.equal(editor.history.length, 2);
    options.angleResetButton.fire('click');
    assert.equal(editor.history.length, 2, 'resetting an upright element is a no-op');
    assert.ok(isPrintDesignWithinBounds(editor.getDesign(), 2700, 1050, 24), item.id);
  }
});

test('multi-selection reads world angles and absolute reset unrotates each child', t => {
  const { editor } = setup(t);
  editor.setDesign([word('one', 20, 800), word('two', 20, 1800)], { resetHistory: true });
  editor.selectAll();
  assert.equal(editor.canvas.getActiveObject().angle, 0);
  assert.equal(editor.angleInput.value, '20', 'a temporary selection is not a new zero');
  editor.rotateActive(15);
  assert.equal(editor.angleInput.value, '35');
  editor.setActiveAngle(0);
  assert.deepEqual(Array.from(editor.getDesign(), item => item.angle), [0, 0]);
  editor.setDesign([word('one', 20, 800), word('two', -15, 1800)], { resetHistory: true });
  editor.selectAll();
  assert.equal(editor.angleInput.value, '');
  editor.rotateActive(15);
  assert.equal(editor.angleInput.value, '');
  assert.equal(editor.angleBadge.textContent, 'Auswahl +15°');
  const positions = Array.from(editor.getDesign(), ({ x, y }) => [x, y]);
  editor.setActiveAngle(-25);
  assert.deepEqual(Array.from(editor.getDesign(), item => item.angle), [-25, -25]);
  assert.deepEqual(Array.from(editor.getDesign(), ({ x, y }) => [x, y]), positions);
  editor.setActiveAngle(0);
  assert.deepEqual(Array.from(editor.getDesign(), item => item.angle), [0, 0]);
});

test('desktop badge stays live until release, rounds only its display and dismisses on selection changes', t => {
  const { editor, timers } = setup(t);
  editor.setDesign([word()]);
  const object = editor.canvas.getObjects()[0];
  editor.canvas.setActiveObject(object);
  object.rotate(27.4);
  editor.canvas.fire('object:rotating', { target: object });
  assert.equal(editor.angleBadge.hidden, false);
  assert.equal(editor.angleBadge.textContent, 'Drehung 27°');
  assert.equal(editor.angleInput.value, '27.4');
  assert.equal(timers.size, 0, 'a held rotation does not time out');
  editor.canvas.fire('mouse:up');
  assert.equal(timers.size, 1);
  object.rotate(30.2);
  editor.canvas.fire('object:rotating', { target: object });
  assert.equal(timers.size, 0, 'the next rotation cancels the old dismissal');
  editor.canvas.fire('mouse:up');
  [...timers.values()][0]();
  assert.equal(editor.angleBadge.hidden, true);
  editor.rotateActive(15);
  editor.clearSelection();
  assert.equal(timers.size, 0);
  assert.equal(editor.angleBadge.hidden, true);
});

test('touch twists update the absolute badge live across separate gestures and commit once each', t => {
  const { editor, timers } = setup(t);
  editor.setDesign([word('word', 20)], { resetHistory: true });
  editor.canvas.setActiveObject(editor.canvas.getObjects()[0]);
  const touch = editor.touchController;
  for (let index = 0; index < 2; index += 1) {
    touch.down(1, { x: 200, y: 200 });
    touch.down(2, { x: 300, y: 200 });
    touch.move(2, { x: 200, y: 300 });
    assert.equal(editor.angleInput.value, index === 0 ? '110' : '-160');
    assert.equal(editor.angleBadge.hidden, false);
    assert.equal(timers.size, 0);
    touch.up(2); touch.up(1);
    assert.equal(editor.history.length, 2 + index);
    assert.equal(timers.size, 1);
  }
  editor.setActiveAngle(0);
  assert.equal(editor.angleInput.value, '0');
  assert.ok(isPrintDesignWithinBounds(editor.getDesign(), 2700, 1050, 24));
});

test('an unblurred angle field is committed before draft or cart capture', async t => {
  const { editor } = setup(t);
  editor.setDesign([word()], { resetHistory: true });
  editor.canvas.setActiveObject(editor.canvas.getObjects()[0]);
  editor.textInput.value = 'Liebe';
  editor.angleInput.value = '-33.5';
  assert.equal(editor.hasPendingTextChange(), true);
  const page = fs.readFileSync(require.resolve('../views/configure.ejs'), 'utf8');
  const finalize = page.match(/    async function finalizeCurrentText\(\) \{[\s\S]*?\n    \}/)[0];
  let dirty = 0;
  const context = vm.createContext({ mugEditor: editor, WolkenworteConfiguratorSession: ConfiguratorSession,
    suppressDirty: false, markDirty: () => { dirty += 1; } });
  vm.runInContext(finalize, context);
  await context.finalizeCurrentText();
  assert.equal(editor.getDesign()[0].angle, -33.5);
  assert.equal(editor.hasPendingTextChange(), false);
  assert.equal(dirty, 1);
  assert.equal(editor.history.length, 2, 'capturing the field creates one Undo step');
  await context.finalizeCurrentText();
  assert.equal(dirty, 1, 'unchanged captures do not dirty an approved design');
  assert.equal(editor.history.length, 2);
});

test('angle entry near the print edge keeps all artwork within the trusted bounds', t => {
  const { editor } = setup(t);
  editor.setDesign([{ ...word(), x: 100, y: 100, fontSize: 450 }], { resetHistory: true });
  editor.canvas.setActiveObject(editor.canvas.getObjects()[0]);
  editor.angleInput.value = '45';
  editor.angleInput.fire('change');
  assert.equal(editor.getDesign().length, 1);
  assert.equal(editor.getDesign()[0].angle, 45);
  assert.ok(isPrintDesignWithinBounds(editor.getDesign(), 2700, 1050, 24));
  editor.setActiveAngle(0);
  assert.ok(isPrintDesignWithinBounds(editor.getDesign(), 2700, 1050, 24));
});
