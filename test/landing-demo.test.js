'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
const source = fs.readFileSync(path.join(__dirname, '../public/js/landing-demo.js'), 'utf8');

function harness(reduce = false) {
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
  });
  vm.runInNewContext(source, { window, document,
    IntersectionObserver: class { constructor(cb) { observer = cb; } observe() {} },
    ResizeObserver: class { observe() {} },
  });
  return { node, window, document, motion, frames,
    visible(value) { observer([{ isIntersecting: value }]); },
    advance(ms) { for (let i = 0; i <= ms; i += 50) { now += 50; const pending = [...frames.values()]; frames.clear(); pending.forEach(cb => cb(now)); } },
  };
}

test('each phone types its word, flies it, and reveals its matching cloud destination', () => {
  const h = harness(); h.visible(true); h.advance(500);
  const typed = h.node('[data-typing="0"]').textContent;
  assert.ok(typed.length > 0 && typed.length < 'Abenteuer'.length);
  h.advance(1500);
  assert.equal(h.node('[data-flights]').children[0].getAttribute('opacity'), '1');
  const flyingText = h.node('[data-flights]').children[0].children.at(-1);
  assert.equal(flyingText.textContent, 'Abenteuer');
  assert.ok(Number.isFinite(Number(flyingText.getAttribute('x'))));
  h.advance(13000);
  for (const [i, word] of ['Abenteuer', 'Lachen', 'Freundschaft', '🥂', 'Gesundheit', '❤️'].entries()) {
    assert.equal(h.node(`[data-typing="${i}"]`).textContent, word);
    assert.equal(h.node(`[data-arrival="${i}"]`).style.opacity, '1');
  }
  assert.equal(h.node('[data-flights]').children.length, 6, 'particles stay bounded across cycles');
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
  h.advance(1500); visibleInCloud(0, '1'); visibleInCloud(1, '0');
  h.advance(12000);
  for (let i = 0; i < 6; i++) visibleInCloud(i, '1');
  h.advance(1000);
  for (let i = 0; i < 6; i++) visibleInCloud(i, '0');
});

test('emoji is typed as a whole character and contributor count advances only on arrival', () => {
  const h = harness(); h.visible(true);
  h.advance(7000);
  assert.equal(h.node('[data-typing="3"]').textContent, '🥂');
  assert.equal(h.node('[data-arrival="3"]').style.opacity, '0');
  h.advance(2300);
  assert.equal(h.node('[data-arrival="3"]').style.opacity, '1');
});

test('heart emoji is sent as one character and arrives as the sixth contribution', () => {
  const h = harness(); h.visible(true); h.advance(12800);
  assert.equal(h.node('[data-typing="5"]').textContent, '❤️');
  assert.equal(h.node('[data-arrival="5"]').style.opacity, '0');
  h.advance(1900);
  assert.equal(h.node('[data-arrival="5"]').style.opacity, '1');
});
