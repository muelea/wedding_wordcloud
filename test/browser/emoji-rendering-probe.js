(function (root, factory) {
  'use strict';
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.EmojiRenderingProbe = api;
})(typeof window !== 'undefined' ? window : globalThis, function () {
  'use strict';

  const SAMPLES = ['🎲', '❤️', '🫶🏽', '👨‍👩‍👧‍👦', '1️⃣', '🇩🇪', '🇳🇵', '🇶🇦', '🇬🇺', 'Ja 🎲'];

  function createEditor({ fabric, MugPrintEditor, createCanvas }) {
    const editor = Object.create(MugPrintEditor.prototype);
    Object.assign(editor, {
      width: 1280, height: 800, canvasWidth: 640, canvasHeight: 400,
      editorScale: .5, margin: 12, defaultX: 640, defaultY: 400,
      palette: ['#9c1c4c'], idCounter: 0, history: [], historyIndex: -1,
      measureContext: createCanvas(1, 1).getContext('2d'),
      canvas: new fabric.Canvas(null, { width: 640, height: 400, enableRetinaScaling: false }),
    });
    // Toolbar notifications do not affect artwork. Creation, grouping,
    // rendering, transforms, serialization and history use the real editor.
    for (const name of ['updateSelectionPanel', 'emitChange', 'setFeedback', 'closeIconPicker',
      'closeFontPicker', 'updateHistoryButtons', 'flashBoundary']) editor[name] = () => {};
    return editor;
  }

  function comparePixels(editor, { fabric, emoji, WordCloudCore, DesignFonts, createCanvas }) {
    const active = editor.canvas.getActiveObject();
    editor.canvas.discardActiveObject();
    editor.canvas.renderAll();
    const expected = createCanvas(editor.canvasWidth, editor.canvasHeight);
    const context = expected.getContext('2d');
    const mixedEmojiRects = [];
    for (const [itemIndex, item] of editor.getDesign().entries()) {
      if (emoji.parse(item.text).some((run) => run.type === 'text')) {
        // For mixed labels, isolate image rendering from text shaping/line-box
        // metrics: use the real child's transform with a full-image draw call.
        for (const child of editor.canvas.getObjects()[itemIndex].getObjects()) {
          if (!(child instanceof fabric.FabricImage)) continue;
          context.save();
          context.transform(...child.calcTransformMatrix());
          context.drawImage(child.getElement(), -child.width / 2, -child.height / 2, child.width, child.height);
          context.restore();
          mixedEmojiRects.push(child.getBoundingRect());
        }
        continue;
      }
      context.save();
      context.translate(item.x * editor.editorScale, item.y * editor.editorScale);
      context.rotate(item.angle * Math.PI / 180);
      WordCloudCore.drawRichText(context, item.text, 0, 0, item.fontSize * editor.editorScale, {
        color: item.color, fontFamily: DesignFonts.cssFamily(item.fontFamily),
        emojiImage: (run) => emoji.getLoadedImage(run),
      });
      context.restore();
    }
    const actual = editor.canvas.getContext().getImageData(0, 0, expected.width, expected.height).data;
    if (active) editor.canvas.setActiveObject(active);
    const reference = context.getImageData(0, 0, expected.width, expected.height).data;
    let union = 0;
    let difference = 0;
    for (let index = 0; index < actual.length; index += 4) {
      if (mixedEmojiRects.length) {
        const x = (index / 4) % expected.width;
        const y = Math.floor(index / 4 / expected.width);
        if (!mixedEmojiRects.some((rect) => x >= rect.left && x < rect.left + rect.width &&
          y >= rect.top && y < rect.top + rect.height)) continue;
      }
      const aa = actual[index + 3] / 255;
      const ra = reference[index + 3] / 255;
      if (aa || ra) union += 1;
      for (let channel = 0; channel < 3; channel += 1) {
        difference += Math.abs(actual[index + channel] * aa - reference[index + channel] * ra);
      }
      difference += Math.abs(actual[index + 3] - reference[index + 3]);
    }
    return { pixels: union, error: union ? difference / (union * 4 * 255) : 1 };
  }

  async function run(environment, onResult = () => {}) {
    const editor = createEditor(environment);
    const results = [];
    function check(label) {
      const result = { label, ...comparePixels(editor, environment) };
      // Allow only edge antialiasing/cache resampling, not missing quadrants.
      result.passed = result.pixels > 100 && result.error < .025;
      results.push(result);
      onResult(result);
      if (!result.passed) throw new Error(`${label}: pixel error ${result.error}`);
    }
    try {
      for (const text of SAMPLES) {
        await environment.emoji.preloadTexts([text]);
        for (const fontSize of [96, 300, 480]) {
          editor.setDesign([{ id: 'imported', text, x: 640, y: 400, fontSize, angle: 0, color: '#9c1c4c' }]);
          check(`${text} at ${fontSize}`);
        }
      }
      editor.setDesign([], { resetHistory: true });
      const object = await editor.addEmoji('🎲');
      check('added');
      object.set({ scaleX: 2, scaleY: 2, angle: 30 });
      object.setCoords();
      editor.recordHistory();
      check('rotated/scaled');
      const saved = JSON.parse(JSON.stringify(editor.getDesign()));
      editor.undo();
      check('undo');
      editor.redo();
      check('redo');
      editor.setDesign(saved, { resetHistory: true });
      if (editor.getDesign()[0].text !== '🎲') throw new Error('Emoji was lost on reload');
      check('serialized reload');
      return results;
    } finally {
      await editor.canvas.dispose();
    }
  }

  return { run };
});
