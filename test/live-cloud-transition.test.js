'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const Transition = require('../public/js/live-cloud-transition');
const Core = require('../public/js/wordcloud-core');

function snapshot(words, x = 50) {
  return { size: { width: 320, height: 400 }, placed: words.map(([word, count], index) => ({
    word, count, x: x + index * 10, y: 80, fontPx: 20, rotated: false, color: '#ed2446',
  })) };
}

function harness(initialWords = []) {
  let time = 0, id = 0, motion = true, valid = () => true;
  const frames = new Map(), commits = [], highlights = [], opacity = [], commitOpacity = [], highlightOpacity = [];
  let clearCount = 0;
  const controller = Transition.create({ initialWords,
    commit: data => { commits.push(data); commitOpacity.push(opacity.at(-1)); },
    highlight: (data, words) => { highlights.push({ data, words }); highlightOpacity.push(opacity.at(-1)); },
    clearHighlights: () => { clearCount++; },
    setOpacity: value => opacity.push(value),
    isValid: data => valid(data), motionAllowed: () => motion,
    requestFrame: callback => { frames.set(++id, callback); return id; },
    cancelFrame: key => frames.delete(key), now: () => time,
  });
  return { controller, frames, commits, highlights, opacity, commitOpacity, highlightOpacity, clearCount: () => clearCount,
    motion(value) { motion = value; }, valid(callback) { valid = callback; },
    frame(value) {
      time = value;
      const callbacks = [...frames.values()]; frames.clear();
      callbacks.forEach(callback => callback(time));
    },
  };
}

test('a ready layout swaps while invisible, then highlights only after the full 300 ms reveal', () => {
  const h = harness([['liebe', 1]]);
  const original = snapshot([['liebe', 1]]);
  const next = snapshot([['liebe', 1], ['❤️', 1]], 90);
  h.controller.present(original);
  assert.deepEqual(h.commits, [original]);
  assert.equal(h.highlights.length, 0, 'a hydrated cloud does not highlight all existing words');
  h.controller.present(next);
  h.frame(60);
  assert.equal(h.commits.length, 1, 'the old geometry remains painted during fade-out');
  assert.ok(h.opacity.at(-1) < 1 && h.opacity.at(-1) > 0);
  h.frame(120);
  assert.equal(h.commits.at(-1), next);
  assert.equal(h.commitOpacity.at(-1), 0, 'the old geometry is fully gone before repainting');
  assert.equal(h.opacity.at(-1), 0, 'the swap frame remains transparent');
  assert.equal(h.highlights.length, 0, 'the glow does not compete with the reveal');
  h.frame(210);
  assert.ok(h.opacity.at(-1) > 0 && h.opacity.at(-1) < 1);
  assert.equal(h.highlights.length, 0);
  h.frame(300);
  assert.equal(h.opacity.at(-1), 1);
  assert.deepEqual(h.highlights.at(-1).words, new Set(['❤️']));
  assert.equal(h.highlightOpacity.at(-1), 1);
  assert.equal(h.frames.size, 0, 'no permanent animation loop');
});

test('a late swap frame still starts the new layout fully transparent', () => {
  const h = harness([['liebe', 1]]);
  h.controller.present(snapshot([['liebe', 1]]));
  h.controller.present(snapshot([['liebe', 2]]));
  h.frame(250);
  assert.equal(h.commitOpacity.at(-1), 0);
  assert.equal(h.opacity.at(-1), 0);
  assert.equal(h.highlights.length, 0);
  h.frame(340);
  assert.ok(h.opacity.at(-1) > 0 && h.opacity.at(-1) < 1);
  h.frame(430);
  assert.equal(h.highlightOpacity.at(-1), 1);
  assert.equal(h.frames.size, 0);
});

test('one first contribution highlights, while only increases receive later emphasis', () => {
  const h = harness();
  h.controller.present(snapshot([['liebe', 1]]));
  assert.deepEqual(h.highlights.at(-1).words, new Set(['liebe']));
  h.controller.present(snapshot([['liebe', 2], ['freude', 1]]));
  h.frame(120); h.frame(300);
  assert.deepEqual(h.highlights.at(-1).words, new Set(['liebe', 'freude']));
  const previous = h.highlights.length;
  h.controller.present(snapshot([['liebe', 1], ['freude', 1]]));
  h.frame(420); h.frame(600);
  assert.equal(h.highlights.length, previous, 'removing a vote does not create a highlight');
});

test('rapid updates keep only the latest pending layout without restarting the fade', () => {
  const h = harness([['liebe', 1]]);
  h.controller.present(snapshot([['liebe', 1]]));
  for (let index = 2; index <= 50; index++) h.controller.present(snapshot([['liebe', index]]));
  assert.equal(h.frames.size, 1);
  h.frame(120);
  assert.equal(h.commits.at(-1).placed[0].count, 50);
  for (let index = 51; index <= 100; index++) h.controller.present(snapshot([['liebe', index]]));
  h.frame(300);
  assert.equal(h.frames.size, 1);
  assert.equal(h.highlights.length, 0, 'a superseded layout does not flash its glow before the next fade');
  h.frame(420);
  assert.equal(h.commits.at(-1).placed[0].count, 100);
  h.frame(600);
  assert.deepEqual(h.commits.map(data => data.placed[0].count), [1, 50, 100]);
  assert.equal(h.frames.size, 0);
});

test('reset and removal invalidate deferred geometry and its highlights', () => {
  const h = harness([['liebe', 1]]);
  h.controller.present(snapshot([['liebe', 1]]));
  h.controller.present(snapshot([['liebe', 1], ['freude', 1]]));
  h.frame(60);
  h.controller.reset();
  h.frame(300);
  assert.equal(h.commits.length, 1, 'no pending snapshot can repaint a reset cloud');
  assert.equal(h.opacity.at(-1), 1);
  h.controller.present(snapshot([['liebe', 1]]));
  assert.deepEqual(h.highlights.at(-1).words, new Set(['liebe']), 'a new cloud starts a fresh count baseline');
  h.controller.present(snapshot([['liebe', 1], ['freude', 1]]));
  h.controller.invalidate();
  h.frame(600);
  assert.equal(h.commits.length, 2);
  h.controller.present(snapshot([['liebe', 1]]));
  assert.equal(h.commits.length, 2, 'history restoration with identical geometry does not animate again');
});

test('validity is checked again at swap time for removed words and changed viewport bounds', () => {
  const h = harness([['liebe', 1]]);
  h.controller.present(snapshot([['liebe', 1]]));
  h.controller.present(snapshot([['liebe', 1], ['freude', 1]]));
  h.valid(data => data.placed.length === 1);
  h.frame(120);
  assert.equal(h.commits.length, 1);
  assert.equal(h.opacity.at(-1), 1);
  assert.equal(h.frames.size, 0);
  h.valid(() => true);
  h.controller.present(snapshot([['liebe', 1]], 100));
  h.valid(data => data.size.width === 390);
  h.frame(240);
  assert.equal(h.commits.length, 1);
  assert.equal(h.frames.size, 0);
});

test('reduced motion and background tabs commit the latest state without fades or glow', () => {
  const h = harness();
  h.motion(false);
  h.controller.present(snapshot([['liebe', 1]]));
  assert.equal(h.commits.length, 1);
  assert.equal(h.frames.size, 0);
  assert.equal(h.highlights.length, 0);
  h.motion(true);
  h.controller.present(snapshot([['liebe', 2]]));
  h.frame(60);
  h.motion(false); h.controller.finish();
  assert.equal(h.commits.at(-1).placed[0].count, 2);
  assert.equal(h.opacity.at(-1), 1);
  assert.equal(h.frames.size, 0);
  assert.equal(h.highlights.length, 0);
});

test('removal or reduced motion during the reveal cancels the deferred highlight', () => {
  for (const action of ['invalidate', 'finish']) {
    const h = harness([['liebe', 1]]);
    h.controller.present(snapshot([['liebe', 1]]));
    h.controller.present(snapshot([['liebe', 2]]));
    h.frame(120);
    h.controller[action]();
    h.frame(300);
    assert.equal(h.highlights.length, 0);
    assert.equal(h.opacity.at(-1), 1);
    assert.equal(h.frames.size, 0);
  }
});

test('unchanged snapshots are inert and disposal cancels the remaining frame', () => {
  const h = harness([['liebe', 1]]);
  h.controller.present(snapshot([['liebe', 1]]));
  h.controller.present(snapshot([['liebe', 1]]));
  assert.equal(h.commits.length, 1);
  assert.equal(h.frames.size, 0);
  h.controller.present(snapshot([['liebe', 2]]));
  h.controller.present(snapshot([['liebe', 1]]));
  assert.equal(h.frames.size, 0, 'a superseded update does not leave the old cloud dimmed');
  h.controller.present(snapshot([['liebe', 3]]));
  h.controller.dispose();
  h.controller.present(snapshot([['liebe', 4]]));
  h.frame(300);
  assert.equal(h.frames.size, 0);
  assert.equal(h.commits.length, 1);
  assert.ok(h.clearCount() > 0);
});

const template = fs.readFileSync(path.join(__dirname, '../views/display.ejs'), 'utf8');
function pageFunction(name) {
  const start = template.search(new RegExp('  function ' + name + '\\('));
  assert.notEqual(start, -1, name);
  return template.slice(start, template.indexOf('\n  }', start) + '\n  }'.length);
}

test('the page carries exact counts through packing, rejects removed votes and commits hit targets with the paint', () => {
  const canvas = { style: {}, classList: { add() {} } };
  const placed = [{ word: 'liebe', count: 2, color: '#ed2446' }];
  const size = { width: 320, height: 400 };
  const drawn = [];
  const page = vm.createContext({ currentWords: [['liebe', 2]], desiredCloudSize: size,
    canvas, window: { devicePixelRatio: 2 }, MAX_CANVAS_PIXEL_RATIO: 3,
    ctx: { setTransform() {}, clearRect() {} },
    WordCloudCore: { drawPlacedWord(ctx, item) { drawn.push(item); } },
    WolkenworteEmoji: { getLoadedImage() {} }, setI18nAttribute() {},
    interactiveCloudWords: [], interactiveCloudSize: null, activeCloudWord: '',
  });
  vm.runInContext([pageFunction('validCloudSnapshot'), pageFunction('paintCloud')].join('\n'), page);
  assert.equal(page.validCloudSnapshot({ placed, size }), true);
  page.currentWords = [['liebe', 1]];
  assert.equal(page.validCloudSnapshot({ placed, size }), false, 'an in-flight extra vote cannot return after removal');
  page.currentWords = [];
  assert.equal(page.validCloudSnapshot({ placed, size }), false);
  page.currentWords = [['liebe', 2]];
  page.paintCloud({ placed, size });
  assert.equal(page.interactiveCloudWords, placed);
  assert.equal(page.interactiveCloudSize, size);
  assert.deepEqual(drawn, placed);
  assert.equal(canvas.width, 640);
  assert.equal(canvas.height, 800);
  const measured = [{ word: 'liebe', fontPx: 1000, width: 100, height: 100, count: 2,
    scale: .2, textBox: { width: 100, height: 100, runs: [] } }];
  assert.equal(Core.finalizeWords(measured)[0].count, 2, 'the shared worker/finalizer preserve the snapshot count');
});

test('the glow layer is inert, bounded and follows rotated word bounds', () => {
  let callback, delay;
  const layer = { style: {}, replaceChildren(...children) { this.children = children; } };
  const page = vm.createContext({ cloudHighlights: layer, cloudHighlightTimer: null,
    document: { createElement() { return { style: { setProperty(key, value) { this[key] = value; } } }; } },
    setTimeout(fn, ms) { callback = fn; delay = ms; return 1; }, clearTimeout() {},
  });
  vm.runInContext([pageFunction('clearCloudHighlights'), pageFunction('highlightCloudWords')].join('\n'), page);
  const placed = Array.from({ length: 100 }, (_, index) => ({ word: 'wort' + index,
    x1: 10, y1: 20, x2: 30, y2: 100, fontPx: 25, rotated: true, color: '#ed2446' }));
  page.highlightCloudWords({ placed, size: { width: 320, height: 400 } }, new Set(placed.map(item => item.word)));
  assert.equal(layer.children.length, 12);
  assert.equal(layer.children[0].style.left, '5px');
  assert.equal(layer.children[0].style.height, '90px');
  assert.equal(delay, 1000);
  callback();
  assert.equal(layer.children.length, 0);
  assert.match(template, /id="cloud-word-highlights" aria-hidden="true"/);
});
