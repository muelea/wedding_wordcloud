'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const source = fs.readFileSync(require.resolve('../public/js/landing-header.js'), 'utf8');

test('header action follows hero visibility on scroll, resize and history restoration', () => {
  let rect = { top: 60, bottom: 900 }, visible, headerHeight;
  const listeners = {};
  const header = { getBoundingClientRect: () => ({ bottom: 60, height: 60 }), classList: {
    toggle(name, value) { assert.equal(name, 'hero-visible'); visible = value; },
  } };
  vm.runInNewContext(source, {
    document: { documentElement: { style: { setProperty(name, value) { headerHeight = value; } } }, querySelector: () => ({ getBoundingClientRect: () => rect }), getElementById: () => header },
    window: { innerHeight: 844, addEventListener(name, handler) { listeners[name] = handler; } },
  });
  assert.equal(visible, true);
  assert.equal(headerHeight, '60px');
  rect = { top: -800, bottom: 60 }; listeners.scroll(); assert.equal(visible, false);
  rect = { top: -100, bottom: 200 }; listeners.pageshow(); assert.equal(visible, true);
  rect = { top: 900, bottom: 1400 }; listeners.resize(); assert.equal(visible, false);
});
