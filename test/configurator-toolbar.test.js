'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { parse } = require('parse5');
const { renderPage } = require('../src/pageRenderer');
const { translate } = require('../src/i18n');
const { WolkenworteWorkspace } = require('../public/js/configurator-workspace');
const { WolkenworteToolbar, tooltipPosition } = require('../public/js/configurator-toolbar');

const attr = (node, name) => node.attrs?.find(item => item.name === name)?.value;
function nodes(root, predicate) {
  const result = [];
  function visit(node) {
    if (predicate(node)) result.push(node);
    for (const child of node.childNodes || []) visit(child);
  }
  visit(root);
  return result;
}

async function rendered(locale) {
  let html;
  await renderPage({ query: { lang: locale }, headers: {}, originalUrl: '/e/test/configure' }, {
    cookie() {}, status() {}, set() {}, vary() {}, send(value) { html = value; },
  }, 'configure');
  return parse(html);
}

test('every toolbar action renders its intended local mark and a translated accessible name in all languages', async () => {
  for (const locale of ['de', 'en', 'fr', 'it', 'es', 'tr']) {
    const page = await rendered(locale);
    const symbols = new Set(nodes(page, node => node.tagName === 'symbol').map(node => attr(node, 'id')));
    const actions = nodes(page, node => attr(node, 'data-editor-tooltip') !== undefined);
    assert.equal(actions.length, 21);
    for (const action of actions) {
      assert.equal(action.tagName, 'button');
      assert.equal(attr(action, 'type'), 'button');
      const source = attr(action, 'data-i18n-aria-label-source');
      assert.ok(source, `${locale}: ${attr(action, 'id')}`);
      assert.equal(attr(action, 'aria-label'), translate(source, locale));
      const styleAction = (attr(action, 'class') || '').split(/\s+/).includes('editor-style-button');
      const svg = nodes(action, node => node.tagName === 'svg');
      if (styleAction) {
        assert.equal(svg.length, 0);
        const mark = nodes(action, node => ['span', 'strong'].includes(node.tagName))[0];
        assert.ok(mark);
        assert.equal(attr(mark, 'aria-hidden'), 'true');
        assert.match(nodes(mark, node => node.nodeName === '#text')
          .map(node => node.value).join('').trim(), /^[BIUS]$/);
      } else {
        assert.equal(svg.length, 1);
        assert.equal(attr(svg[0], 'aria-hidden'), 'true');
        assert.equal(attr(svg[0], 'focusable'), 'false');
        const use = nodes(svg[0], node => node.tagName === 'use')[0];
        assert.ok(symbols.has(attr(use, 'href').slice(1)));
        assert.equal(nodes(action, node => node.nodeName === '#text')
          .map(node => node.value).join('').trim(), '');
      }
      assert.equal(attr(action, 'title'), undefined, 'one custom tooltip, no competing native title');
    }
    assert.equal(nodes(page, node => attr(node, 'data-editor-tool') !== undefined).length, 4);
    const labels = nodes(page, node => attr(node, 'data-editor-tool-label') !== undefined);
    assert.equal(labels.length, 4);
    assert.ok(labels.every(node => node.childNodes.some(child => child.value?.trim())));
    const reset = nodes(page, node => attr(node, 'id') === 'editor-reset-panel')[0];
    assert.equal(reset.tagName, 'dialog');
    assert.equal(attr(reset, 'aria-describedby'), 'editor-reset-description');
    const safe = nodes(reset, node => attr(node, 'data-panel-initial-focus') !== undefined)[0];
    assert.equal(attr(safe, 'data-panel-close'), '');
    assert.equal(attr(safe, 'autofocus'), '');
  }
});

test('confirmation can be cancelled and consumes an accepted reset exactly once', () => {
  const workspace = Object.create(WolkenworteWorkspace.prototype);
  workspace.resetPanel = {};
  workspace.resetButton = {};
  workspace.active = null;
  const calls = [];
  workspace.close = () => { workspace.active = null; calls.push('close'); };
  workspace.show = (panel, button) => {
    assert.equal(panel, workspace.resetPanel);
    assert.equal(button, workspace.resetButton);
    workspace.active = { panel, trigger: button };
    calls.push('show');
  };
  const reset = () => {
    assert.equal(workspace.active, null, 'consume confirmation before applying reset');
    calls.push('reset');
  };
  workspace.requestReset(reset);
  assert.deepEqual(calls, ['close', 'show']);
  workspace.close();
  workspace.confirmReset();
  assert.ok(!calls.includes('reset'), 'cancellation leaves the design intact');
  workspace.requestReset(reset);
  workspace.confirmReset();
  workspace.confirmReset();
  assert.equal(calls.filter(call => call === 'reset').length, 1);
});

test('tooltip placement clamps to all viewport edges without moving the trigger', () => {
  for (const width of [320, 390, 620, 940, 1440]) {
    for (const height of [320, 844]) {
      for (const left of [0, width - 44]) {
        for (const top of [0, height - 44]) {
          const anchor = { left, top, width: 44, bottom: top + 44 };
          const tip = { width: 200, height: 40 };
          const position = tooltipPosition(anchor, tip, { width, height });
          assert.ok(position.left >= 8 && position.left + tip.width <= width - 8);
          assert.ok(position.top >= 8 && position.top + tip.height <= height - 8);
        }
      }
    }
  }
});

test('tooltips also work without Popover support and never focus or rename their buttons', () => {
  const toolbar = Object.create(WolkenworteToolbar.prototype);
  const tooltip = { hidden: true, style: {}, getBoundingClientRect: () => ({ width: 100, height: 30 }) };
  let mounted;
  toolbar.document = { body: { append: node => { mounted = node; } }, documentElement: { clientWidth: 390 } };
  toolbar.tooltip = tooltip;
  const button = { disabled: false, getClientRects: () => [1], closest: () => null,
    getAttribute: () => 'Ajouter un mot', getBoundingClientRect: () => ({ left: 15, top: 100, bottom: 144, width: 44 }) };
  toolbar.show(button);
  assert.equal(mounted, tooltip);
  assert.equal(tooltip.textContent, 'Ajouter un mot');
  assert.equal(tooltip.hidden, false);
  assert.equal(toolbar.owner, button);
  toolbar.hide();
  assert.equal(tooltip.hidden, true);
  assert.equal(toolbar.owner, null);
  button.disabled = true;
  toolbar.show(button);
  assert.equal(tooltip.hidden, true);
});

test('the vendored SVG subset has valid geometry and retained upstream attribution', () => {
  const sprite = fs.readFileSync(require.resolve('../views/partials/editor-symbols.ejs'), 'utf8');
  const symbols = nodes(parse(sprite), node => node.tagName === 'symbol');
  assert.equal(new Set(symbols.map(node => attr(node, 'id'))).size, symbols.length);
  assert.ok(symbols.every(symbol => nodes(symbol, node => ['path', 'circle', 'rect', 'line'].includes(node.tagName)).length));
  assert.doesNotMatch(sprite, /curl:|<script|onload=|https:\/\/.*\.svg/);
  const license = fs.readFileSync(require.resolve('../public/assets/ui-icons/LICENSE.txt'), 'utf8');
  assert.match(license, /Lucide Icons and Contributors/);
  assert.match(license, /Cole Bemis/);
});
