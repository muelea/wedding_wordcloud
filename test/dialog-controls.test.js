'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { parse } = require('parse5');
const { renderPage } = require('../src/pageRenderer');

const attr = (node, name) => node.attrs?.find(item => item.name === name)?.value;
function nodes(root, predicate) {
  const found = [];
  function visit(node) {
    if (predicate(node)) found.push(node);
    (node.childNodes || []).forEach(visit);
  }
  visit(root);
  return found;
}

test('every page uses named shared close controls without automatically focusing the X', async () => {
  let checked = 0;
  for (const template of ['landing', 'display', 'configure', 'shipping', 'account']) {
    let html;
    await renderPage({ query: { lang: 'en' }, headers: {}, originalUrl: '/' }, {
      cookie() {}, status() {}, set() {}, vary() {}, send(value) { html = value; },
    }, template, { pageData: { eventUrl: 'https://example.test/e/a', cloudTitle: 'Dialog audit',
      initialWords: [], qrSvg: '', accountAvailable: false } });
    for (const dialog of nodes(parse(html), node => node.tagName === 'dialog')) {
      const closeControls = nodes(dialog, node => (attr(node, 'class') || '').split(/\s+/).includes('ww-close-button'));
      for (const close of closeControls) {
        checked++;
        assert.ok(attr(close, 'class').split(/\s+/).includes('ww-icon-button'), template);
        assert.ok(attr(close, 'aria-label')?.trim(), template);
        assert.equal(attr(close, 'autofocus'), undefined, `${template}: ${attr(dialog, 'id')}`);
      }
      const heading = nodes(dialog, node => node.tagName === 'h2' && attr(node, 'autofocus') !== undefined)[0];
      if (heading) assert.equal(attr(heading, 'tabindex'), '-1', 'an opening heading must accept programmatic focus');
    }
  }
  assert.ok(checked >= 20, 'the audit covers close controls across all public page templates');
});
