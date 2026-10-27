'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { JSDOM } = require('jsdom');
const { createLoader } = require('../public/js/configurator-runtime');

function fixture(t, extra = {}) {
  const dom = new JSDOM('<!doctype html><head></head>');
  t.after(() => dom.window.close());
  const load = createLoader({ document: dom.window.document, src: '/vendor/fabric.min.js?v=7.4.0',
    ready: () => Boolean(dom.window.fabric), ...extra });
  return { window: dom.window, load, scripts: () => [...dom.window.document.scripts] };
}

test('browsing does not request the editor runtime and concurrent editor entries share one load', async t => {
  const h = fixture(t);
  assert.equal(h.scripts().length, 0);
  const first = h.load(), second = h.load();
  assert.equal(first, second);
  assert.equal(h.scripts().length, 1);
  assert.equal(h.scripts()[0].getAttribute('src'), '/vendor/fabric.min.js?v=7.4.0');
  h.window.fabric = {};
  h.scripts()[0].dispatchEvent(new h.window.Event('load'));
  await Promise.all([first, second]);
  await h.load();
  assert.equal(h.scripts().length, 1);
});

for (const failure of ['error', 'missing-global', 'timeout']) {
  test(`an editor runtime ${failure} releases its failed script and permits an explicit retry`, async t => {
    const h = fixture(t, { timeoutMs: failure === 'timeout' ? 5 : 1000 });
    const first = h.load();
    const rejected = assert.rejects(first, /editor_runtime_/);
    if (failure !== 'timeout') h.scripts()[0].dispatchEvent(new h.window.Event(failure === 'error' ? 'error' : 'load'));
    await rejected;
    assert.equal(h.scripts().length, 0);
    const retry = h.load();
    assert.equal(h.scripts().length, 1);
    h.window.fabric = {};
    h.scripts()[0].dispatchEvent(new h.window.Event('load'));
    await retry;
  });
}

test('an already available editor does not insert another script', async t => {
  const h = fixture(t);
  h.window.fabric = {};
  await h.load();
  assert.equal(h.scripts().length, 0);
});
