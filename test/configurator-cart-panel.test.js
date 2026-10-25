'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { JSDOM } = require('jsdom');
const { create } = require('../public/js/configurator-cart-panel');

function harness(t, options = {}) {
  const template = fs.readFileSync(require.resolve('../views/configure.ejs'), 'utf8');
  const markup = template.match(/<dialog class="cart-panel"[\s\S]*?<\/dialog>/)[0];
  const dom = new JSDOM('<button id="cart">Cart</button>' + markup, { pretendToBeVisual: true });
  const { document } = dom.window;
  const dialog = document.querySelector('dialog'), trigger = document.getElementById('cart');
  dialog.showModal = () => dialog.setAttribute('open', '');
  dialog.close = () => { dialog.removeAttribute('open'); dialog.dispatchEvent(new dom.window.Event('close')); };
  let items = [{ id: 'a', name: 'Mug', size: '325 ml' }, { id: 'b', name: 'Poster', size: '30 × 40 cm' }];
  let removed = null;
  const calls = { edit: [], continued: 0 };
  const i18n = {
    setText: (element, source, params = {}) => { element.textContent = source.replace(/\{\{(\w+)\}\}/g, (_, key) => params[key]); },
    setAttribute: (element, attribute, source, params) => {
      const temporary = document.createElement('span'); i18n.setText(temporary, source, params);
      element.setAttribute(attribute, temporary.textContent);
    },
  };
  const panel = create({ dialog, trigger, i18n, items: () => {
    if (options.failRead) throw new Error('storage');
    return items;
  },
    describe: item => item, thumbnail: () => document.createElement('img'), pendingRemoval: () => removed,
    onEdit: async id => { calls.edit.push(id); await options.onEdit?.(id); },
    onRemove: async id => {
      if (options.failRemoval) throw new Error('storage');
      removed = { item: items.find(item => item.id === id) };
      items = items.filter(item => item.id !== id);
    },
    onUndo: () => { items.push(removed.item); removed = null; },
    onContinue: async () => { calls.continued++; await options.onContinue?.(); },
  });
  t.after(() => dom.window.close());
  const settle = () => new Promise(setImmediate);
  return { panel, dialog, trigger, document, calls, settle,
    clear: () => { items = []; },
    button: selector => dialog.querySelector(selector),
  };
}

test('opening the cart is read-only, retains metric variants, and restores toolbar focus on close', t => {
  const h = harness(t);
  h.panel.open();
  assert.equal(h.dialog.open, true);
  assert.equal(h.trigger.getAttribute('aria-controls'), 'cart-panel');
  assert.equal(h.trigger.getAttribute('aria-expanded'), 'true');
  assert.match(h.dialog.textContent, /325 ml/);
  assert.match(h.dialog.textContent, /30 × 40 cm/);
  assert.deepEqual(h.calls, { edit: [], continued: 0 });
  h.button('[data-cart-panel-close]').click();
  assert.equal(h.dialog.open, false);
  assert.equal(h.trigger.getAttribute('aria-expanded'), 'false');
  assert.equal(h.document.activeElement, h.trigger);
});

test('cart editing is a separate explicit action on the chosen position', async t => {
  const h = harness(t);
  h.panel.open();
  h.button('[data-configuration-id="b"] .cart-panel-item-actions button').click();
  await h.settle();
  assert.deepEqual(h.calls.edit, ['b']);
  assert.equal(h.calls.continued, 0);
});

test('removing and undoing a cart position updates the panel without navigation', async t => {
  const h = harness(t);
  h.panel.open();
  h.button('[data-configuration-id="a"] .cart-panel-remove').click();
  await h.settle();
  assert.equal(h.dialog.querySelectorAll('[data-configuration-id]').length, 1);
  assert.equal(h.button('[data-cart-panel-removal]').hidden, false);
  h.button('[data-cart-panel-removal] button').click();
  await h.settle();
  assert.equal(h.dialog.querySelectorAll('[data-configuration-id]').length, 2);
  assert.equal(h.button('[data-cart-panel-removal]').hidden, true);
  assert.equal(h.dialog.open, true);
});

test('failed removal retains the cart and shows an actionable error', async t => {
  const h = harness(t, { failRemoval: true });
  h.panel.open();
  h.button('.cart-panel-remove').click();
  await h.settle();
  assert.equal(h.dialog.querySelectorAll('[data-configuration-id]').length, 2);
  assert.equal(h.button('[data-cart-panel-status]').hidden, false);
  assert.equal(h.button('[data-cart-panel-continue]').disabled, false);
});

test('continuation is explicit and double clicks cannot launch two shipping checks', async t => {
  let finish;
  const h = harness(t, { onContinue: () => new Promise(resolve => { finish = resolve; }) });
  h.panel.open();
  h.button('[data-cart-panel-continue]').click();
  h.button('[data-cart-panel-continue]').click();
  assert.equal(h.calls.continued, 1);
  assert.equal(h.button('[data-cart-panel-continue]').disabled, true);
  finish(); await h.settle();
  h.clear(); h.panel.refresh();
  assert.equal(h.button('[data-cart-panel-continue]').disabled, true);
  assert.equal(h.button('[data-cart-panel-empty]').hidden, false);
});

test('unavailable cart storage shows an error and never offers shipping', t => {
  const h = harness(t, { failRead: true });
  h.panel.open();
  assert.equal(h.dialog.open, true);
  assert.equal(h.button('[data-cart-panel-status]').hidden, false);
  assert.equal(h.button('[data-cart-panel-continue]').disabled, true);
  assert.equal(h.button('[data-cart-panel-empty]').hidden, true);
});
