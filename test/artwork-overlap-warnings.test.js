'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const { JSDOM } = require('jsdom');

function setup(t) {
  const dom = new JSDOM(`<button id="editor-overlap-trigger"><span id="editor-overlap-count"></span></button>
    <dialog id="editor-overlap-panel"></dialog><p id="editor-overlap-status"></p><div id="editor-overlap-list"></div>`);
  t.after(() => dom.window.close());
  let timer, surfaces = [{ key: 'front', label: 'Vorderseite', design: [
    { id: 'a', text: 'Liebe' }, { id: 'b', text: '❤️' }] }];
  const listeners = {}, calls = [];
  const checker = { key: item => JSON.stringify(item), check: async () => ({ findings: [{ ids: ['a', 'b'] }], truncated: false }) };
  const root = { ArtworkOverlap: { create: () => checker }, WolkenworteEmoji: {},
    addEventListener: (name, fn) => listeners[name] = fn };
  vm.runInNewContext(fs.readFileSync(require.resolve('../public/js/artwork-overlap-warnings'), 'utf8'), {
    window: root, setTimeout: fn => { timer = fn; return 1; }, clearTimeout: () => {},
    requestAnimationFrame: fn => fn(),
  });
  const workspace = { close: restore => calls.push(['close', restore]),
    mobileCanvas: { active: true, chooseView: view => calls.push(['view', view]) } };
  const editor = { getImageElement() {}, touchController: { finish: () => calls.push(['finish']) },
    focusArtworkElement: (id, ids) => calls.push(['focus', id, Array.from(ids)]) };
  const warnings = new root.ArtworkOverlapWarnings({ document: dom.window.document, editor, workspace,
    getSurfaces: () => surfaces, selectSurface: (key, opts) => calls.push(['surface', key, opts.announce]) });
  return { warnings, checker, calls, workspace, document: dom.window.document, listeners,
    run: () => timer(), setSurfaces: next => surfaces = next };
}

test('advisory list names both elements and selects either one in the mobile canvas', async t => {
  const f = setup(t);
  f.warnings.schedule();
  await f.run();
  const buttons = f.document.querySelectorAll('#editor-overlap-list button');
  assert.equal(buttons.length, 2);
  assert.equal(f.document.getElementById('editor-overlap-trigger').hidden, false);
  assert.equal(f.document.getElementById('editor-overlap-count').textContent, '1');
  assert.match(f.document.getElementById('editor-overlap-status').textContent, /beabsichtigt.*bestellen/);
  assert.equal(f.document.querySelector('.artwork-overlap-finding strong').textContent, 'Liebe überlagert ❤️');
  buttons[1].click();
  assert.deepEqual(f.calls, [['finish'], ['close', false], ['surface', 'front', false], ['view', 'canvas'], ['focus', 'b', ['a', 'b']]]);
});

test('checks each side separately and jumps to the finding’s print side', async t => {
  const f = setup(t);
  f.setSurfaces([{ key: 'front', label: 'Vorderseite', design: [{ id: 'a', text: 'Liebe' }] },
    { key: 'back', label: 'Rückseite', design: [{ id: 'a', text: 'Glück' }, { id: 'b', text: '❤️' }] }]);
  const lengths = [];
  f.checker.check = async design => {
    lengths.push(design.length);
    return { findings: design.length > 1 ? [{ ids: ['a', 'b'] }] : [], truncated: false };
  };
  f.warnings.schedule(); await f.run();
  assert.deepEqual(lengths, [1, 2]);
  assert.equal(f.document.querySelector('.artwork-overlap-finding span').textContent, 'Rückseite');
  f.document.querySelector('#editor-overlap-list button').click();
  assert.ok(f.calls.some(call => call[0] === 'surface' && call[1] === 'back'));
});

test('superseded asynchronous results and stale navigation cannot target another design', async t => {
  const f = setup(t);
  let finish;
  f.checker.check = () => new Promise(resolve => finish = resolve);
  f.warnings.schedule();
  const old = f.run();
  f.setSurfaces([{ key: 'back', label: 'Rückseite', design: [] }]);
  f.warnings.schedule();
  finish({ findings: [{ ids: ['a', 'b'] }], truncated: false });
  await old;
  assert.equal(f.document.querySelectorAll('#editor-overlap-list button').length, 0);
  f.warnings.navigate('front', 'a', ['a', 'b']);
  assert.deepEqual(f.calls, []);
  f.checker.check = async () => ({ findings: [], truncated: false });
  await f.run();
  assert.equal(f.document.getElementById('editor-overlap-trigger').hidden, true);
});

test('resolved findings disappear and viewport-only refreshes reuse the completed check', async t => {
  const f = setup(t);
  let count = 0;
  f.checker.check = async () => { count++; return { findings: [], truncated: false }; };
  f.warnings.schedule(); await f.run(); f.warnings.schedule();
  assert.equal(count, 1);
  assert.equal(f.document.getElementById('editor-overlap-trigger').hidden, true);
  assert.equal(f.document.getElementById('editor-overlap-status').textContent, 'Keine Überlagerungen gefunden.');
});

test('a failed artwork check remains advisory and does not report a clean design', async t => {
  const f = setup(t);
  f.checker.check = async () => { throw new Error('image decode'); };
  f.warnings.schedule(); await f.run();
  assert.equal(f.document.getElementById('editor-overlap-trigger').hidden, false);
  assert.equal(f.document.getElementById('editor-overlap-count').textContent, '?');
  assert.match(f.document.getElementById('editor-overlap-status').textContent, /konnten nicht geprüft/);
});
