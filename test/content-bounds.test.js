'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const fabric = require('fabric/node');
const { createCanvas, loadImage } = require('canvas');
const Fonts = require('../src/designFonts');
const Core = require('../public/js/wordcloud-core');
const Emoji = require('../public/js/emoji-catalog');
const Icons = require('../public/js/mug-icons');
const Bounds = require('../public/js/design-content-bounds');
const ServerBounds = require('../src/designContentBounds');
const Artwork = require('../public/js/artwork-bounds-data');
const Layout = require('../public/js/design-layout');
const Overlap = require('../public/js/artwork-overlap');
const EmojiData = require('../public/js/emoji-data');
const { loadBrowserSvg } = require('../src/emojiBrowserAssets');
const { isPrintDesignWithinBounds, buildProviderPrintSvg } = require('../src/mugPrint');

function pixels(canvas) {
  const data = canvas.getContext('2d').getImageData(0, 0, canvas.width, canvas.height).data;
  let left = canvas.width, top = canvas.height, right = 0, bottom = 0;
  for (let y = 0; y < canvas.height; y++) for (let x = 0; x < canvas.width; x++) {
    if (!data[(y * canvas.width + x) * 4 + 3]) continue;
    left = Math.min(left, x); top = Math.min(top, y);
    right = Math.max(right, x + 1); bottom = Math.max(bottom, y + 1);
  }
  return right > left ? { left, top, width: right - left, height: bottom - top } : null;
}
function contains(outer, inner, tolerance = 1) {
  assert.ok(inner);
  assert.ok(outer.left <= inner.left + tolerance, JSON.stringify({ outer, inner }));
  assert.ok(outer.top <= inner.top + tolerance, JSON.stringify({ outer, inner }));
  assert.ok(outer.left + outer.width >= inner.left + inner.width - tolerance, JSON.stringify({ outer, inner }));
  assert.ok(outer.top + outer.height >= inner.top + inner.height - tolerance, JSON.stringify({ outer, inner }));
}
async function editor(t) {
  const images = new Map();
  const emoji = { ...Emoji, async preloadTexts(texts) {
    for (const text of texts) for (const run of Emoji.parse(text)) {
      if (run.type === 'emoji' && !images.has(run.asset)) images.set(run.asset,
        await loadImage(Buffer.from(await loadBrowserSvg(run.asset))));
    }
  }, getLoadedImage: run => images.get(run.asset) };
  await emoji.preloadTexts(['🫶❤️🇶🇦🇳🇵']);
  const root = { fabric, WordCloudCore: Core, DesignFonts: Fonts, DesignContentBounds: Bounds,
    WolkenworteEmoji: emoji, MugIcons: Icons };
  vm.runInNewContext(fs.readFileSync(require.resolve('../public/js/mug-editor'), 'utf8'), { window: root });
  const instance = Object.create(root.MugPrintEditor.prototype);
  Object.assign(instance, {
    width: 1200, height: 800, canvasWidth: 1200, canvasHeight: 800, editorScale: 1,
    printMargin: 24, margin: 24, printFileDpi: 300, idCounter: 0,
    measureContext: createCanvas(1, 1).getContext('2d'), textInput: { value: '' }, textChangeRevision: 0,
    imageElements: new Map(), imageRefsBySource: new Map(), imageSourcesByRef: new Map(), imageRefCounter: 0,
    history: [], historyIndex: -1, palette: ['#123456'],
    testEmojiImage: emoji.getLoadedImage,
    canvas: new fabric.Canvas(null, { width: 1200, height: 800, enableRetinaScaling: false }),
  });
  for (const name of ['emitChange', 'flashBoundary', 'updateSelectionPanel', 'updateHistoryButtons', 'setFeedback']) {
    instance[name] = () => {};
  }
  t.after(() => instance.canvas.dispose());
  return instance;
}
const word = (text = 'were', extra = {}) => ({ id: 'word', text, x: 600, y: 400,
  fontSize: 200, color: '#123456', fontFamily: 'classic', angle: 0, ...extra });

test('all pinned artwork has conservative shared ink rectangles', () => {
  assert.equal(Artwork.artworkVersion, EmojiData.artworkVersion);
  assert.deepEqual(Object.keys(Artwork.emoji).sort(), [...new Set(Object.values(EmojiData.canonicalAssets))].sort());
  assert.deepEqual(Object.keys(Artwork.icons).sort(), Icons.ICONS.map(icon => icon.id).sort());
  for (const rectangle of [...Object.values(Artwork.emoji), ...Object.values(Artwork.icons)]) {
    const [left, top, right, bottom] = rectangle;
    assert.ok(left >= 0 && top >= 0 && left < right && top < bottom &&
      right <= Artwork.resolution && bottom <= Artwork.resolution);
  }
});

test('dragging reuses text measurements and content/style changes invalidate the bounded cache', () => {
  const ctx = createCanvas(1, 1).getContext('2d');
  const measure = ctx.measureText.bind(ctx); let measurements = 0;
  ctx.measureText = text => { measurements++; return measure(text); };
  const item = word();
  Bounds.bounds(item, ctx);
  const initial = measurements;
  for (let x = 0; x < 100; x++) Bounds.bounds({ ...item, x, angle: x }, ctx);
  assert.equal(measurements, initial, 'moving or rotating only transforms the cached rectangle');
  Bounds.bounds({ ...item, text: 'Ägyp' }, ctx);
  Bounds.bounds({ ...item, fontWeight: 700 }, ctx);
  Bounds.bounds({ ...item, underline: true }, ctx);
  assert.ok(measurements > initial);
  for (let n = 0; n < 600; n++) Bounds.bounds({ ...item, text: 'were' + n }, ctx);
  const afterEviction = measurements;
  Bounds.bounds(item, ctx);
  assert.ok(measurements > afterEviction, 'old entries are evicted');
});

test('text boxes follow actual lettering in every font while preserving the original Fabric pixels', async t => {
  const e = await editor(t);
  for (const font of Fonts.FONTS) for (const text of ['were', 'fsfs', 'Ägyp', 'Çéğış']) {
    const item = word(text, { fontFamily: font.key });
    const object = e.makeObject(item);
    object.objectCaching = false;
    e.canvas.clear(); e.canvas.add(object); e.canvas.renderAll();
    const ink = pixels(e.canvas.lowerCanvasEl);
    const box = object.getBoundingRect();
    contains(box, ink);
    assert.ok(box.height <= ink.height + 2, `${font.key}/${text}: vertical whitespace`);
    assert.ok(box.width <= ink.width + 3, `${font.key}/${text}: horizontal whitespace`);
    const reference = new fabric.StaticCanvas(null, { width: 1200, height: 800, enableRetinaScaling: false });
    try {
      reference.add(new fabric.IText(text, { left: item.x, top: item.y, originX: 'center', originY: 'center',
        fontSize: item.fontSize, fontFamily: font.family, fill: item.color, objectCaching: false }));
      reference.renderAll();
      assert.deepEqual(Buffer.from(e.canvas.getContext().getImageData(0, 0, 1200, 800).data),
        Buffer.from(reference.getContext().getImageData(0, 0, 1200, 800).data), `${font.key}/${text}: unchanged pixels`);
    } finally { await reference.dispose(); }
    assert.deepEqual(JSON.parse(JSON.stringify(e.getDesign()))[0], { ...item,
      fontWeight: 400, fontStyle: 'normal', underline: false, linethrough: false });
  }
});

test('editing accents and descenders grows and shrinks the box without moving the saved anchor or caret', async t => {
  const e = await editor(t);
  const object = e.makeObject(word()); e.canvas.add(object);
  const initial = object.height;
  await e.applyTextChange(object, 'Ägyp');
  assert.ok(object.height > initial * 1.8);
  assert.deepEqual([e.getDesign()[0].x, e.getDesign()[0].y], [600, 400]);
  await e.applyTextChange(object, 'were');
  assert.equal(object.height, initial);
  e.canvas.setActiveObject(object); object.enterEditing();
  object.selectionStart = 1; object.selectionEnd = 3;
  e.canvas.renderAll();
  const left = object._getLeftOffset();
  const matrix = object.calcTransformMatrix();
  const first = new fabric.Point(left + 1, object._getTopOffset() + 20).transform(matrix);
  assert.equal(object.getSelectionStartFromPointer({ clientX: first.x, clientY: first.y }), 0);
  assert.ok(pixels(e.canvas.upperCanvasEl), 'typing highlight is visible');
  object.exitEditing();
  assert.equal(pixels(e.canvas.upperCanvasEl), null, 'typing highlight leaves no pixels outside the tight box');
});

test('formatting and rotated frames contain the actual text and its decorations in every font', async t => {
  const e = await editor(t);
  for (const font of Fonts.FONTS) for (const angle of [0, 27, 90]) {
    const object = e.makeObject(word('Ägyp', { fontFamily: font.key, fontWeight: 700,
      fontStyle: 'italic', underline: true, linethrough: true, angle }));
    e.canvas.clear(); e.canvas.add(object); e.canvas.renderAll();
    contains(object.getBoundingRect(), pixels(e.canvas.lowerCanvasEl));
    const item = e.getDesign()[0];
    assert.deepEqual([item.x, item.y], [600, 400]);
    const before = buildProviderPrintSvg({ printFile: { width: 1200, height: 800 }, designSafeMargin: 24 }, [item]);
    e.setDesign([item]);
    assert.equal(buildProviderPrintSvg({ printFile: { width: 1200, height: 800 }, designSafeMargin: 24 }, e.getDesign()), before);
  }
});

test('absorbing scale preserves the text anchor and the minimum font size', async t => {
  const e = await editor(t);
  const object = e.makeObject(word('were', { fontSize: 100, angle: 27, fontStyle: 'italic' }));
  e.canvas.add(object); e.canvas.setActiveObject(object);
  object.set({ scaleX: 1.7, scaleY: 1.7 });
  const before = e.getDesign();
  e.absorbScale(object);
  assert.deepEqual(e.getDesign(), before);
  await e.applyTextChange(object, 'Ägyp');
  assert.deepEqual([e.getDesign()[0].x, e.getDesign()[0].y], [before[0].x, before[0].y]);
  object.set({ scaleX: .00001, scaleY: .00001 });
  e.absorbScale(object);
  assert.equal(e.getDesign()[0].fontSize, 1);
});

test('emoji and mixed text use visible artwork bounds and retain exact saved transforms', async t => {
  const e = await editor(t);
  for (const text of ['🫶', '🇶🇦', '🇳🇵', 'were 🫶']) for (const angle of [0, 37, 90]) {
    const item = word(text, { angle });
    const object = e.makeObject(item);
    e.canvas.clear(); e.canvas.add(object); e.canvas.renderAll();
    contains(object.getBoundingRect(), pixels(e.canvas.lowerCanvasEl));
    if (text === '🫶' && angle === 0) assert.ok(object.height < 140, 'remove the oversized emoji line box');
    assert.deepEqual([e.getDesign()[0].x, e.getDesign()[0].y], [600, 400]);
    const saved = e.getDesign(); e.setDesign(saved);
    assert.deepEqual(e.getDesign(), saved);
  }
});

test('transparent image margins shrink selection and hit targets while opaque white pixels stay selectable', async t => {
  const e = await editor(t);
  const image = createCanvas(100, 80), ctx = image.getContext('2d');
  ctx.fillStyle = '#123456'; ctx.fillRect(10, 30, 25, 20);
  const src = image.toDataURL(); e.imageElements.set(src, image);
  const item = { id: 'image', type: 'image', src, x: 600, y: 400, width: 300, height: 240, angle: 0 };
  const object = e.makeObject(item); e.canvas.add(object); e.canvas.renderAll();
  assert.ok(Math.abs(object.width * object.scaleX - 78) < 1e-6);
  assert.ok(Math.abs(object.height * object.scaleY - 63) < 1e-6);
  assert.equal(object.containsPoint(new fabric.Point(460, 300)), false, 'transparent margin does not steal clicks');
  assert.equal(object.containsPoint(new fabric.Point(500, 400)), true);
  assert.deepEqual(JSON.parse(JSON.stringify(e.getDesign()[0])), item);
  contains(object.getBoundingRect(), pixels(e.canvas.lowerCanvasEl));
  assert.deepEqual(ServerBounds.imageBounds(src), Bounds.image(image, createCanvas));
  for (const angle of [0, 27]) {
    e.canvas.clear();
    const enlarged = e.makeObject({ ...item, width: 800, height: 640, angle });
    enlarged.objectCaching = false;
    e.canvas.add(enlarged); e.canvas.renderAll();
    const reference = new fabric.StaticCanvas(null, { width: 1200, height: 800, enableRetinaScaling: false });
    try {
      reference.add(new fabric.FabricImage(image, { left: item.x, top: item.y, originX: 'center', originY: 'center',
        scaleX: 8, scaleY: 8, angle, objectCaching: false }));
      reference.renderAll();
      assert.deepEqual(Buffer.from(e.canvas.getContext().getImageData(0, 0, 1200, 800).data),
        Buffer.from(reference.getContext().getImageData(0, 0, 1200, 800).data), 'preserve enlarged image interpolation');
    } finally { await reference.dispose(); }
  }
  ctx.fillStyle = '#ffffff'; ctx.fillRect(0, 0, 100, 80);
  const opaque = await loadImage(image.toDataURL());
  assert.deepEqual(Bounds.image(opaque, createCanvas), { left: -.5, top: -.5, width: 1, height: 1 });
});

test('tight content can reach the safe area and the server rejects visible pixels outside it', async t => {
  const e = await editor(t);
  for (const text of ['were', 'Ägyp', '🫶', 'were 🫶']) for (const angle of [0, 27, 90]) {
    const object = e.makeObject(word(text, { x: 0, y: 0, angle }));
    e.canvas.clear(); e.canvas.add(object); e.keepInside(object);
    const item = e.getDesign()[0];
    assert.ok(isPrintDesignWithinBounds([item], 1200, 800, 24));
    const b = ServerBounds.bounds(item);
    assert.ok(Math.min(b.left, b.top) < 30, 'visible content reaches the safe edge');
    const outside = { ...item, x: item.x - b.left + 23 };
    assert.equal(isPrintDesignWithinBounds([outside], 1200, 800, 24), false);
  }
});

test('transparent images and motifs retain dimensions through groups, transforms, undo and reload', async t => {
  const e = await editor(t);
  const source = createCanvas(100, 100); source.getContext('2d').fillRect(10, 20, 40, 30);
  const src = source.toDataURL(); e.imageElements.set(src, source);
  e.setDesign([{ id: 'image', type: 'image', src, x: 300, y: 300, width: 200, height: 200, angle: 0 },
    { id: 'heart', type: 'icon', icon: 'heart', x: 600, y: 300, size: 180, angle: 0, color: '#123456' },
    word('were', { x: 850, y: 500, fontSize: 80 })], { resetHistory: true });
  const original = e.getDesign(); e.selectAll(); e.resizeActive(1.15); e.rotateActive(15);
  const transformed = e.getDesign();
  assert.equal(transformed[0].width, 230); assert.equal(transformed[1].size, 207);
  e.undo(); e.undo(); assert.deepEqual(e.getDesign(), original);
  e.redo(); e.redo(); assert.deepEqual(e.getDesign(), transformed);
  e.setDesign(transformed); assert.deepEqual(e.getDesign(), transformed);
});

test('outlined print pixels stay inside the safe area after tight edge placement in every font', async t => {
  const e = await editor(t);
  const surface = createCanvas(1200, 800), ctx = surface.getContext('2d');
  const product = { printFile: { width: 1200, height: 800 }, designSafeMargin: 24 };
  for (const font of Fonts.FONTS) for (const text of ['were', 'office', 'Ägyp']) for (const angle of [0, 27, 90]) {
    e.canvas.clear();
    const object = e.makeObject(word(text, { fontFamily: font.key, fontWeight: 700,
      fontStyle: 'italic', underline: true, linethrough: true, angle, x: 0, y: 0 }));
    e.canvas.add(object); e.keepInside(object);
    ctx.clearRect(0, 0, 1200, 800);
    ctx.drawImage(await loadImage(Buffer.from(buildProviderPrintSvg(product, e.getDesign()))), 0, 0);
    const ink = pixels(surface);
    assert.ok(ink.left >= 24 && ink.top >= 24 && ink.left + ink.width <= 1176 && ink.top + ink.height <= 776,
      `${font.key}/${text}/${angle}: ${JSON.stringify(ink)}`);
  }
});

test('placement, editor restoration, print validation and actual-pixel overlap checks agree', async t => {
  const e = await editor(t);
  const source = createCanvas(100, 80); source.getContext('2d').fillRect(40, 20, 20, 20);
  const src = source.toDataURL(); e.imageElements.set(src, source);
  const slot = { x: 24, y: 24, width: 1152, height: 752, optimize: true };
  const options = { fontFamily: item => Fonts.cssFamily(item.fontFamily), printDpi: 150 };
  const checker = Overlap.create({ createCanvas, assets: {
    image: value => e.getImageElement(value), emojiImage: e.testEmojiImage,
  } });
  for (const font of Fonts.FONTS) {
    const input = ['were', 'j', 'Ägyp', '🫶', '🇳🇵'].map((text, index) => word(text, {
      id: `word-${index}`, fontSize: 120, x: 400, y: 300, fontFamily: font.key,
      fontWeight: index % 2 ? 700 : 400, fontStyle: index === 2 ? 'italic' : 'normal',
      underline: index === 1, angle: index === 0 ? 90 : 0,
    }));
    input.push({ id: 'image', type: 'image', src, width: 150, height: 120, x: 400, y: 300, angle: 27 });
    const placed = Layout.applyLayoutAction(input, [slot], e.measureContext, options);
    assert.ok(isPrintDesignWithinBounds(placed, 1200, 800, 24), font.key);
    assert.equal((await checker.check(placed)).findings.length, 0, `${font.key}: no painted collisions`);
    assert.deepEqual(Layout.applyLayoutAction(placed, [slot], e.measureContext, options), placed,
      `${font.key}: repeat Fill keeps the arrangement stable`);
    e.setDesign(placed, { resetHistory: true });
    const restored = e.getDesign();
    for (let index = 0; index < placed.length; index++) {
      assert.deepEqual([restored[index].x, restored[index].y], [placed[index].x, placed[index].y],
        `${font.key}: restoration does not move individual elements`);
    }
    assert.ok(isPrintDesignWithinBounds(restored, 1200, 800, 24));
    assert.equal((await checker.check(restored)).findings.length, 0);
    const collision = { ...restored[0], id: 'collision' };
    assert.ok((await checker.check([...restored, collision])).findings.some(finding =>
      finding.ids.includes('collision') && finding.ids.includes(restored[0].id)),
    `${font.key}: a real collision is still reported`);
  }
});
