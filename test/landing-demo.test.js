'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
const source = fs.readFileSync(path.join(__dirname, '../public/js/landing-demo.js'), 'utf8');

function harness(reduce = false, config = {}) {
  const nodes = new Map();
  function node(key) {
    if (nodes.has(key)) return nodes.get(key);
    const listeners = new Map(), attributes = new Map();
    const result = {
      textContent: '', hidden: false, style: {}, children: [],
      classList: { add() {}, remove() {}, toggle() {} },
      appendChild(child) { this.children.push(child); },
      setAttribute(k, v) { attributes.set(k, String(v)); },
      getAttribute(k) { return attributes.get(k); },
      addEventListener(k, cb) { listeners.set(k, cb); },
      fire(k, data) { listeners.get(k)?.(data); },
      querySelector(selector) { return node(selector); },
      querySelectorAll() { return []; },
      getBoundingClientRect() { return { left: 0, top: 0, width: 800, height: 450 }; },
    };
    nodes.set(key, result);
    return result;
  }
  const frames = new Map(); let nextId = 0, now = 0, observer;
  const motion = node('motion'); motion.matches = reduce;
  const document = node('document');
  let introActive = !!config.intro, introObserver;
  document.documentElement = node('html');
  document.documentElement.classList.contains = name => name === 'intro-lock' && introActive;
  document.getElementById = () => node('root');
  document.createElementNS = () => node('svg-' + ++nextId);
  const window = node('window');
  Object.assign(window, {
    matchMedia: () => motion,
    getComputedStyle: () => ({ fontSize: '24px' }),
    requestAnimationFrame(cb) { const id = ++nextId; frames.set(id, cb); return id; },
    cancelAnimationFrame(id) { frames.delete(id); },
    IntersectionObserver: true,
    ResizeObserver: true,
    MutationObserver: class { constructor(cb) { introObserver = cb; } observe() {} },
  });
  if (config.speed) node('root').setAttribute('data-demo-speed', config.speed);
  if (config.motion) node('root').setAttribute('data-demo-motion', config.motion);
  if (config.createViewer) Object.assign(window, {
    THREE: {}, PrintfulProductModel: {}, Mug3DViewer: { create: config.createViewer },
    wolkenworteLandingMugProduct: { previewMesh: {}, size: { diameterCm: 8.2 } },
  });
  vm.runInNewContext(source, { window, document,
    IntersectionObserver: class { constructor(cb) { observer = cb; } observe() {} },
    ResizeObserver: class { observe() {} },
  });
  return { node, window, document, motion, frames,
    visible(value, ratio = value ? 1 : 0, bounds = {}) { observer([{ isIntersecting: value, intersectionRatio: ratio, ...bounds }]); },
    intro(value) { introActive = value; introObserver(); },
    advance(ms) { for (let i = 0; i <= ms; i += 50) { now += 50; const pending = [...frames.values()]; frames.clear(); pending.forEach(cb => cb(now)); } },
  };
}

test('each phone types its word, flies it, and reveals its matching cloud destination', () => {
  const h = harness(); h.visible(true); h.advance(500);
  assert.ok(h.node('[data-typing="0"]').textContent.length > 0, 'Anna starts typing immediately');
  const typed = h.node('[data-typing="0"]').textContent;
  assert.ok(typed.length > 0 && typed.length < 'Abenteuer'.length);
  h.advance(1500);
  assert.equal(h.node('[data-flights]').children[0].getAttribute('opacity'), '1');
  const flyingText = h.node('[data-flights]').children[0].children.at(-1);
  assert.equal(flyingText.textContent, 'Abenteuer');
  assert.ok(Number.isFinite(Number(flyingText.getAttribute('x'))));
  h.advance(13000);
  for (const [i, word] of ['Abenteuer', 'Lachen', 'Freundschaft', '🥂', 'Glück', '❤️'].entries()) {
    assert.equal(h.node(`[data-typing="${i}"]`).textContent, word);
    assert.equal(h.node(`[data-arrival="${i}"]`).style.opacity, '1');
  }
  assert.equal(h.node('[data-flights]').children.length, 7, 'six phone flights and one reusable reveal group stay bounded across cycles');
});

test('a lost homepage context releases its viewer and keeps the complete static cloud without retrying', () => {
  let options, creations = 0, destructions = 0;
  const h = harness(false, { createViewer(value) {
    creations++; options = value;
    return { ready: new Promise(() => {}), render() {}, resize() {}, stopAutoRotate() {},
      canvas: { style: {}, getBoundingClientRect: () => ({ left: 0, top: 0, width: 800, height: 450 }) },
      destroy() { destructions++; } };
  } });
  h.visible(true); h.advance(500);
  assert.equal(creations, 1);
  assert.equal(options.maxTextureSize, 1024);
  assert.equal(options.modelOptions.maxTextureSize, 1024);
  assert.equal(h.frames.size, 1);
  options.onStatus('error');
  assert.equal(destructions, 1);
  assert.equal(h.frames.size, 0);
  assert.equal(h.node('root').getAttribute('data-demo-fallback'), 'static');
  for (let index = 0; index < 6; index++) assert.equal(h.node(`[data-arrival="${index}"]`).style.opacity, '1');
  h.visible(false); h.visible(true);
  h.intro(true); h.intro(false);
  h.window.fire('wolkenworte:localechange', { detail: { locale: 'en' } });
  h.node('[data-demo-replay]').fire('click');
  h.node('[data-demo-pause]').fire('click');
  options.onStatus('ready'); options.onStatus('error');
  h.advance(20000);
  assert.equal(creations, 1, 'visibility, locale, replay and restoration never recreate the failed GPU preview');
  assert.equal(destructions, 1);
  assert.equal(h.frames.size, 0);
  assert.equal(h.node('[data-demo-replay]').hidden, true);
  assert.equal(h.node('[data-demo-pause]').hidden, true);
});

test('homepage WebGL initialization failure leaves a static cloud instead of retrying each frame', () => {
  let creations = 0;
  const h = harness(false, { createViewer() { creations++; throw new Error('GPU unavailable'); } });
  h.visible(true); h.advance(30000); h.visible(false); h.visible(true);
  assert.equal(creations, 1);
  assert.equal(h.frames.size, 0);
  assert.equal(h.node('root').getAttribute('data-demo-fallback'), 'static');
});

test('static fallback explicitly disposes the flying-word textures as well as the viewer', () => {
  let texturesDisposed = 0, viewersDestroyed = 0, staticFrames = 0;
  const context = { mugUnavailable: false, frame: 7, window: { cancelAnimationFrame() {} },
    stickers: Array.from({ length: 17 }, () => ({ mesh: { material: { map: { dispose() { texturesDisposed++; } } } } })),
    cupMaterials: [{}], mugViewer: { destroy() { viewersDestroyed++; } },
    staticScene() { staticFrames++; }, pauseButton: {}, replayButton: {}, root: { setAttribute() {} } };
  const start = source.indexOf('  function useStaticFallback('), end = source.indexOf('  function ensureMug(', start);
  vm.createContext(context); vm.runInContext(source.slice(start, end), context);
  context.useStaticFallback(); context.useStaticFallback();
  assert.equal(texturesDisposed, 17);
  assert.equal(viewersDestroyed, 1);
  assert.equal(staticFrames, 1);
  assert.equal(context.stickers.length, 0);
  assert.equal(context.mugViewer, null);
  assert.equal(context.frame, null);
});

test('late completion of a failed homepage viewer cannot touch the disposed model', async () => {
  let options, complete;
  const h = harness(false, { createViewer(value) {
    options = value;
    return { ready: new Promise(resolve => { complete = resolve; }), render() {}, resize() {},
      stopAutoRotate() {}, destroy() {} };
  } });
  h.visible(true);
  options.onStatus('error');
  complete(true);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(h.node('root').getAttribute('data-demo-fallback'), 'static');
  assert.equal(h.frames.size, 0);
});

test('offscreen and hidden-document states stop frames without resetting progress', () => {
  const h = harness(); h.visible(true); h.advance(500);
  const typed = h.node('[data-typing="0"]').textContent;
  h.visible(false); assert.equal(h.frames.size, 0);
  h.advance(500); assert.equal(h.node('[data-typing="0"]').textContent, typed);
  h.visible(true); h.document.hidden = true; h.document.fire('visibilitychange'); assert.equal(h.frames.size, 0);
  h.document.hidden = false; h.document.fire('visibilitychange'); assert.equal(h.frames.size, 1);
});

test('reduced motion shows the completed cloud without autoplay and responds to preference changes', () => {
  const h = harness(true); h.visible(true);
  assert.equal(h.frames.size, 0);
  for (let i = 0; i < 6; i++) assert.equal(h.node(`[data-arrival="${i}"]`).style.opacity, '1');
  h.motion.matches = false; h.motion.fire('change'); assert.equal(h.frames.size, 1);
  h.advance(2000); h.motion.matches = true; h.motion.fire('change'); assert.equal(h.frames.size, 0);
  for (const group of h.node('[data-flights]').children) assert.equal(group.getAttribute('opacity'), '0');
});

test('sent words stay absent during typing and flight, then appear in the cloud and reset next loop', () => {
  const h = harness(); h.visible(true);
  function visibleInCloud(index, expected) {
    assert.equal(h.node(`[data-arrival="${index}"]`).style.opacity, expected);
  }
  visibleInCloud(0, '0');
  h.advance(2000); visibleInCloud(0, '0');
  h.advance(2100); visibleInCloud(0, '1'); visibleInCloud(1, '0');
  h.advance(12000);
  for (let i = 0; i < 6; i++) visibleInCloud(i, '1');
  h.advance(46400);
  for (let i = 0; i < 6; i++) visibleInCloud(i, '0');
});

test('completed cloud transitions toward the shared 3D mug renderer', () => {
  assert.match(source, /Mug3DViewer\.create/);
  assert.match(source, /DesignLayout\.optimizeDesign/);
  assert.match(source, /attachSticker\(sticker/);
  assert.match(source, /demo-mug-flight/);
  assert.match(source, /previousFacePosition < \.30 && facePosition >= \.30/);
});

test('emoji is typed as a whole character and contributor count advances only on arrival', () => {
  const h = harness(); h.visible(true);
  h.advance(5700);
  assert.equal(h.node('[data-typing="3"]').textContent, '', 'emoji composer has the same perceptible empty pause');
  h.advance(600);
  assert.equal(h.node('[data-typing="3"]').textContent, '🥂');
  assert.equal(h.node('[data-arrival="3"]').style.opacity, '0');
  h.advance(2300);
  assert.equal(h.node('[data-arrival="3"]').style.opacity, '1');
});

test('heart emoji is sent as one character and arrives as the sixth contribution', () => {
  const h = harness(); h.visible(true); h.advance(10800);
  assert.equal(h.node('[data-typing="5"]').textContent, '❤️');
  assert.equal(h.node('[data-arrival="5"]').style.opacity, '0');
  h.advance(1900);
  assert.equal(h.node('[data-arrival="5"]').style.opacity, '1');
});

test('motion studies land on the right-front quadrant and finish with centred artwork', () => {
  const start = source.indexOf('  function printFacingYaw(');
  const end = source.indexOf('  function magneticOffset(', start);
  const yaw = vm.runInNewContext('(' + source.slice(start, end).trim() + ')');
  for (const [duration, sweep] of [[3200, 7000], [3600, 7000], [2800, 5000], [2800, 9500]]) {
    const first = .3, last = 2.9;
    assert.equal(yaw(650, first, last, duration, sweep), yaw(1150, first, last, duration, sweep));
    assert.ok(yaw(1450, first, last, duration, sweep) < yaw(1150, first, last, duration, sweep), 'cup follows the first departing words');
    let previousYaw = yaw(1150, first, last, duration, sweep);
    for (let age = 1200; age <= 650 + duration; age += 50) {
      const nextYaw = yaw(age, first, last, duration, sweep);
      assert.ok(nextYaw < previousYaw, 'opening rotation never reverses');
      previousYaw = nextYaw;
    }
    for (const fraction of [0, .12, .4, .75, 1]) {
      const angle = first + (last - first) * fraction;
      const landing = 650 + duration + sweep * fraction;
      assert.ok(Math.abs(angle + yaw(landing, first, last, duration, sweep) - .55) < 1e-9);
    }
    const finished = 650 + duration + sweep + 3200;
    assert.ok(Math.abs((first + last) / 2 + yaw(finished, first, last, duration, sweep)) < 1e-9);
    for (const boundary of [1150, 1750, 650 + duration, 650 + duration + sweep, finished]) {
      const before = yaw(boundary - .01, first, last, duration, sweep);
      const after = yaw(boundary + .01, first, last, duration, sweep);
      assert.ok(Math.abs(after - before) < .00002, 'rotation remains continuous at phase boundaries');
    }
  }
});


test('ceramic and sparkle reveal begin invisible and respect reduced motion', () => {
  const h = harness();
  const reveal = h.node('[data-flights]').children.at(-1);
  assert.equal(reveal.getAttribute('opacity'), '0');
  h.visible(true); h.advance(15500);
  assert.ok(Number(reveal.getAttribute('opacity')) > 0);
  const opacity = Number(h.node('[data-demo-mug]').style.opacity);
  assert.ok(opacity > 0 && opacity < 1, 'the complete cup layer fades instead of popping');
  h.advance(3500);
  assert.equal(reveal.getAttribute('opacity'), '0');
  h.motion.matches = true; h.motion.fire('change');
  assert.equal(reveal.getAttribute('opacity'), '0');
});

test('magnetic variations keep smooth handoffs and bounded, distinct flight paths', () => {
  const start = source.indexOf('  function magneticOffset(');
  const end = source.indexOf('  function element(', start);
  const offset = vm.runInNewContext('(' + source.slice(start, end).trim() + ')');
  const signatures = new Set();
  for (const kind of ['magnetic', 'magnetic-vortex', 'magnetic-wave', 'magnetic-braid']) {
    signatures.add(JSON.stringify(offset(kind, .35, 2)));
    for (const rank of [0, 1, 7, 15]) {
      for (const edge of [0, 1]) {
        const endpoint = offset(kind, edge, rank);
        const nearby = offset(kind, edge ? .99999 : .00001, rank);
        for (const axis of ['x', 'y', 'z']) {
          assert.ok(Math.abs(endpoint[axis]) < 1e-10);
          assert.ok(Math.abs(nearby[axis] - endpoint[axis]) < 1e-7, 'no velocity jump at either handoff');
        }
      }
      for (const progress of [.1, .3, .5, .7, .9]) {
        for (const value of Object.values(offset(kind, progress, rank))) {
          assert.ok(Number.isFinite(value) && Math.abs(value) < 2);
        }
      }
    }
  }
  assert.equal(signatures.size, 4);
});


test('calm magnetic paths have no vertical bounce or sideways reversals', () => {
  const start = source.indexOf('  function magneticOffset(');
  const end = source.indexOf('  function element(', start);
  const offset = vm.runInNewContext('(' + source.slice(start, end).trim() + ')');
  for (const kind of ['magnetic-glide', 'magnetic-fan', 'magnetic-orbit']) {
    for (let rank = 0; rank < 16; rank++) {
      let previousMagnitude = 0;
      for (let step = 0; step <= 100; step++) {
        const p = step / 100;
        const point = offset(kind, p, rank);
        assert.equal(point.y, 0, 'no vertical bobbing');
        assert.ok(Object.values(point).every(Number.isFinite));
        const magnitude = Math.hypot(point.x, point.z);
        if (step <= 50) assert.ok(magnitude >= previousMagnitude - 1e-10);
        else assert.ok(magnitude <= previousMagnitude + 1e-10);
        previousMagnitude = magnitude;
      }
    }
  }
});


test('rotation delay slider changes the start while preserving right-front landings', () => {
  const start = source.indexOf('  function printFacingYaw(');
  const end = source.indexOf('  function magneticOffset(', start);
  const yaw = vm.runInNewContext('(' + source.slice(start, end).trim() + ')');
  for (const delay of [0, 500, 1500]) {
    const rotationStart = 650 + delay;
    assert.equal(yaw(0, .3, 2.9, 2800, 5000, delay), yaw(rotationStart, .3, 2.9, 2800, 5000, delay));
    assert.ok(yaw(rotationStart + 300, .3, 2.9, 2800, 5000, delay) < yaw(rotationStart, .3, 2.9, 2800, 5000, delay));
    assert.ok(Math.abs(.3 + yaw(3450, .3, 2.9, 2800, 5000, delay) - .55) < 1e-9);
  }
});

test('finished story offers replay without making the mug rotatable or focusable', () => {
  const start = source.indexOf('  function setStoryFinished(');
  const end = source.indexOf('  function ensureMug(', start);
  const replayButton = { hidden: true }, attributes = {};
  const context = { replayButton, pauseButton: null, reduced: { matches: false }, storyFinished: false,
    mugHost: { setAttribute(name, value) { attributes[name] = value; } } };
  vm.createContext(context);
  vm.runInContext(source.slice(start, end), context);
  context.setStoryFinished(true);
  assert.equal(context.storyFinished, true);
  assert.equal(replayButton.hidden, false);
  assert.equal(attributes.tabindex, '-1');
  context.setStoryFinished(false);
  assert.equal(context.storyFinished, false);
  assert.equal(replayButton.hidden, true);
  assert.doesNotMatch(source, /is-interactive|limitCupView|Zum Drehen ziehen/);
});

test('homepage honors its configured pace', () => {
  const h = harness(false, { speed: '1.8', motion: 'ribbon-airy' });
  h.visible(true); h.advance(450);
  assert.ok(h.node('[data-typing="0"]').textContent.length > 0, 'configured homepage speed advances typing');

});




test('Lena contributes Glück while Gesundheit is present in the initial cloud', () => {
  const h = harness(); h.visible(true); h.advance(8800);
  assert.equal(h.node('[data-typing="4"]').textContent, 'Glück');
  assert.equal(h.node('[data-arrival="4"]').style.opacity, '0');
  h.advance(1800);
  assert.equal(h.node('[data-arrival="4"]').style.opacity, '1');
  const markup = fs.readFileSync(path.join(__dirname, '../views/partials/landing-demo.ejs'), 'utf8');
  assert.match(markup, /class="cloud-arrival cloud-happiness" data-arrival="4">Glück/);
  assert.match(markup, /class="cloud-health">Gesundheit/);
});

test('slow frames preserve the configured story clock while hidden time stays paused', () => {
  const h = harness(); h.visible(true); h.advance(0);
  const pending = [...h.frames.values()]; h.frames.clear();
  pending.forEach(cb => cb(1050));
  assert.equal(h.node('[data-typing="0"]').textContent, 'Abenteuer', 'a one-second frame gap advances one second');
  h.visible(false); h.advance(5000); h.visible(true); h.advance(0);
  assert.equal(h.node('[data-typing="0"]').textContent, 'Abenteuer', 'offscreen time is excluded');
});

test('word strips invert once per update and stop uploading hidden or settled geometry', () => {
  const Three = require('three');
  let inversions = 0;
  class Matrix4 extends Three.Matrix4 { invert() { inversions++; return super.invert(); } }
  const group = new Three.Group();
  group.rotation.y = .7; group.scale.setScalar(1.216); group.updateMatrixWorld(true);
  const geometry = new Three.PlaneGeometry(2, 1, 60, 1);
  const sticker = { mesh: new Three.Mesh(geometry, new Three.MeshBasicMaterial()),
    original: geometry.attributes.position.array.slice(), width: 2, angle: .5, y: .3,
    startWorld: new Three.Vector3(1, 2, 8), startScale: 1, textureWidth: 200, textureHeight: 100,
    blurUniform: { value: new Three.Vector2() } };
  const start = source.indexOf('  function attachSticker(');
  const end = source.indexOf('  function measure(', start);
  const context = { window: { THREE: { ...Three, Matrix4 } }, mugViewer: { group },
    motionStudy: null, magneticMotion: false, airyRibbon: false, ribbonMotion: false, singleWord: false, revealDuration: 6000,
    openingDelay: 6000, atmosphereFade: .8, atmosphereBlur: 1.8 };
  vm.createContext(context); vm.runInContext(source.slice(start, end), context);
  const positions = geometry.attributes.position;
  context.attachSticker(sticker, 0, 0);
  assert.equal(inversions, 0); assert.equal(positions.version, 0); assert.equal(sticker.mesh.visible, false);
  context.attachSticker(sticker, .5, 8000);
  assert.equal(inversions, 1, 'one inverse for all 122 vertices');
  assert.ok(sticker.mesh.material.opacity >= .2 - 1e-9, 'mesh retains source opacity immediately instead of fading in from zero');
  assert.ok([...positions.array].every(Number.isFinite));
  context.attachSticker(sticker, 1, 15000);
  assert.equal(inversions, 2);
  for (let i = 0; i < positions.count; i++) {
    const angle = sticker.angle + sticker.original[i * 3] / 4.1;
    assert.ok(Math.abs(positions.getX(i) - Math.sin(angle) * 4.115) < 1e-6);
    assert.ok(Math.abs(positions.getZ(i) - Math.cos(angle) * 4.115) < 1e-6);
  }
  const version = positions.version;
  context.attachSticker(sticker, 1, 16000);
  assert.equal(positions.version, version); assert.equal(inversions, 2);
  context.attachSticker(sticker, 0, 0);
  context.attachSticker(sticker, .1, 6500);
  assert.equal(positions.version, version + 1, 'replay resumes geometry updates');
  let pathCalls = 0;
  context.motionStudy = 'magnetic'; context.magneticMotion = true;
  context.smoother = value => { const v = Math.max(0, Math.min(1, value)); return v*v*v*(v*(v*6-15)+10); };
  context.magneticOffset = () => { pathCalls++; return { x: .2, y: 0, z: .3 }; };
  context.attachSticker(sticker, .4, 8000);
  assert.equal(pathCalls, 1, 'trajectory offset is shared by every vertex in the strip');
  assert.ok([...positions.array].every(Number.isFinite));

});


test('departure scale matches the source at small and full-window camera framings', () => {
  const Three = require('three');
  const start = source.indexOf('  function matchSourceScale(');
  const end = source.indexOf('  function attachSticker(', start);
  const context = {}; vm.createContext(context); vm.runInContext(source.slice(start, end), context);
  for (const [width, height, distance] of [[350, 500, 35], [1920, 1080, 27], [3840, 2160, 45]]) {
    const camera = new Three.PerspectiveCamera(31, width / height, .1, 100);
    camera.position.set(0, 2.35, distance); camera.lookAt(0, 0, 0); camera.updateMatrixWorld(true);
    const sticker = { width: 3, startWorld: new Three.Vector3(2, 1, 8) };
    const sourceWidth = width * .12;
    const scale = context.matchSourceScale(sticker, sourceWidth, { width, height }, camera);
    const a = sticker.startWorld.clone(), b = a.clone();
    a.x -= sticker.width * 1.216 * scale / 2;
    b.x += sticker.width * 1.216 * scale / 2;
    a.project(camera); b.project(camera);
    assert.ok(Math.abs((b.x - a.x) * width / 2 - sourceWidth) < 1e-8,
      'the first mesh frame has the same projected width as its DOM source');
  }
});

test('cloud handoff hides the frozen source on the first visible mesh frame', () => {
  const start = source.indexOf('    cloudNodes.forEach(function (node, index) {', source.indexOf('  function draw()'));
  const end = source.indexOf('    mugFlights.forEach(', start);
  const node = { style: {}, classList: { contains: () => false } };
  const context = { cloudNodes: [node], stickers: [{ departureAge: 1000 }], mugAge: 1000,
    mugActive: true, airyRibbon: true, openingDelay: 650, revealDuration: 2600,
    atmosphereFade: .55, atmosphereBlur: 1, waitingDrift: () => ({ x: 12, y: 8 }) };
  vm.createContext(context);
  vm.runInContext(source.slice(start, end), context);
  assert.ok(Number(node.style.opacity) > 0, 'source owns the exact departure frame while mesh progress is zero');
  context.mugAge = 1001;
  vm.runInContext(source.slice(start, end), context);
  assert.equal(node.style.opacity, '0', 'no frozen second copy overlaps the flying word');
  assert.match(node.style.transform, /translate3d/);
});


test('replay hides the overlay control and resumes the story', () => {
  const h = harness(false, { speed: '1.8', motion: 'ribbon-airy' });
  h.visible(true); h.advance(10000);
  h.node('[data-demo-replay]').fire('click');
  assert.equal(h.node('[data-demo-replay]').hidden, true);
  assert.equal(h.frames.size, 1);
});


test('landing word textures retain the product preview filtering at oblique angles', () => {
  const Three = require('three');
  const camera = new Three.PerspectiveCamera(31, 1, .1, 100);
  camera.position.set(0, 2.35, 27); camera.lookAt(0, 0, 0); camera.updateMatrixWorld(true);
  const rect = { left: 0, top: 0, width: 500, height: 500 };
  const node = { textContent: 'Liebe', classList: { contains: () => false }, getBoundingClientRect: () => rect };
  const ink = { measureText: () => ({ width: 100, actualBoundingBoxLeft: 0, actualBoundingBoxRight: 100,
    actualBoundingBoxAscent: 50, actualBoundingBoxDescent: 10 }), fillText() {} };
  const start = source.indexOf('  function buildStickers(');
  const end = source.indexOf('  function matchSourceScale(', start);
  for (const anisotropy of [1, 4, 8]) {
    const productTexture = new Three.Texture(); productTexture.anisotropy = anisotropy;
    const context = { window: { THREE: Three, DesignLayout: {}, getComputedStyle: () => ({ fontSize: '24px', color: '#9c1c4c' }) },
      document: { createElement: () => ({ getContext: () => ink }) },
      printSources: [node], cloudNodes: [node], t: value => value, singleWord: true,
      mugHost: { setAttribute() {} }, scene: { getBoundingClientRect: () => rect },
      mugViewer: { group: new Three.Group(), camera, canvas: { getBoundingClientRect: () => rect }, texture: productTexture }, stickers: [] };
    vm.createContext(context); vm.runInContext(source.slice(start, end), context); context.buildStickers();
    assert.equal(context.stickers.length, 1);
    const wordTexture = context.stickers[0].mesh.material.map;
    assert.equal(wordTexture.anisotropy, productTexture.anisotropy, 'word textures use the same hardware-bounded filtering as the product print');
    assert.equal(wordTexture.generateMipmaps, true);
    assert.equal(wordTexture.minFilter, Three.LinearMipmapLinearFilter);
  }
});


test('the restored intro holds the new story at its opening frame until dismissal', () => {
  const h = harness(false, { intro: true }); h.visible(true);
  assert.equal(h.frames.size, 0);
  h.advance(10000);
  assert.equal(h.node('[data-typing="0"]').textContent, '');
  h.intro(false);
  assert.equal(h.frames.size, 1);
  h.advance(500);
  assert.ok(h.node('[data-typing="0"]').textContent.length > 0);
  assert.equal(h.node('[data-arrival="0"]').style.opacity, '0');
});

test('landing attaches its unchanged word animation only after the catalog mug is ready', async () => {
  const THREE = require('three');
  const products = require('../src/products');
  const product = products.getPublicProduct(products.MUG_11);
  const start = source.indexOf('  function ensureMug(');
  const end = source.indexOf('  function buildStickers(', start);
  for (const success of [true, false]) {
    let finish, createdOptions, attached = 0;
    const ready = new Promise(resolve => { finish = resolve; });
    const group = new THREE.Group();
    const material = new THREE.MeshStandardMaterial();
    const viewer = { group, ready, render() {} };
    const context = {
      window: { THREE, PrintfulProductModel: {}, wolkenworteLandingMugProduct: product,
        Mug3DViewer: { create(options) { createdOptions = options; return viewer; } } },
      document: { fonts: { status: 'loaded' } },
      mugViewer: null, mugUnavailable: false, mugHost: { addEventListener() {}, setAttribute() {} }, cupMaterials: [],
      useStaticFallback() { context.mugUnavailable = true; },
      limitCupView() {}, buildStickers() { attached++; },
    };
    vm.createContext(context); vm.runInContext(source.slice(start, end), context);
    context.ensureMug();
    assert.equal(createdOptions.product.previewMesh.file, product.previewMesh.file);
    assert.equal(createdOptions.product.previewMesh.rotateY, 180);
    assert.equal(createdOptions.product.previewMesh.diameter, 8.2);
    assert.equal(product.previewMesh.rotateY, 135, 'the gallery keeps its original model orientation');
    assert.equal(group.scale.x, 1);
    assert.equal(attached, 0, 'word geometry waits for the asynchronous mesh');
    group.add(new THREE.Mesh(new THREE.BoxGeometry(), [material]));
    finish(success); await ready;
    assert.equal(attached, success ? 1 : 0);
    if (success) {
      assert.equal(group.scale.x, 1.216, 'the existing animation scale is preserved');
      assert.equal(material.opacity, 0, 'the loaded ceramic starts inside the existing reveal');
      assert.equal(material.transparent, true);
      assert.equal(context.cupMaterials[0], material);
    }
  }
});

test('a partially visible demo waits until most of the scene can be seen', () => {
  const h = harness();
  h.visible(true, .2);
  h.advance(2000);
  assert.equal(h.frames.size, 0);
  assert.equal(h.node('[data-typing="0"]').textContent, '');
  h.visible(true, .7);
  h.advance(500);
  assert.ok(h.node('[data-typing="0"]').textContent.length > 0);
  h.visible(true, .3);
  assert.equal(h.frames.size, 0);
});


test('a demo taller than a landscape viewport can still play and pause', () => {
  const h = harness();
  h.visible(true, .4, { rootBounds: { height: 320 }, boundingClientRect: { height: 600 } });
  h.advance(500);
  assert.ok(h.node('[data-typing="0"]').textContent.length > 0);
  h.node('[data-demo-pause]').fire('click');
  assert.equal(h.frames.size, 0);
  assert.equal(h.node('[data-demo-pause]').getAttribute('aria-pressed'), 'true');
  h.node('[data-demo-pause]').fire('click');
  assert.ok(h.frames.size > 0);
});


test('input windows appear sequentially at the quicker interval', () => {
  const h = harness(); h.visible(true); h.advance(1900);
  assert.ok(h.node('[data-typing="0"]').textContent.length > 0);
  assert.equal(h.node('[data-typing="1"]').textContent, '', 'next input keeps its original empty pause');
  h.advance(650);
  assert.ok(h.node('[data-typing="1"]').textContent.length > 0);
  assert.equal(h.node('[data-typing="2"]').textContent, '', 'later users still wait their turn');
});
