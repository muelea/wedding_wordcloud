'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const template = fs.readFileSync(path.join(__dirname, '../views/display.ejs'), 'utf8');

function pageFunction(name) {
  const start = template.search(new RegExp('  function ' + name + '\\('));
  assert.notEqual(start, -1, name);
  return template.slice(start, template.indexOf('\n  }', start) + '\n  }'.length);
}

test('clicking the cloud opens existing own words and remains inert before a contribution', () => {
  const calls = [];
  const context = vm.createContext({
    ownContributions: new Map(),
    displayOwnWordsDialog: { open: false, showModal() { this.open = true; calls.push('open'); } },
    displayOwnWordsError: {},
    closeDisplayMenu() { calls.push('close-menu'); },
    clearText(element) { assert.equal(element, context.displayOwnWordsError); calls.push('clear-error'); },
    renderOwnContributions() { calls.push('render'); },
  });
  vm.runInContext(`${pageFunction('openOwnWordsDialog')}; result = openOwnWordsDialog`, context);

  assert.equal(context.result(), false);
  assert.deepEqual(calls, []);

  context.ownContributions.set('receipt-a', 'Liebe');
  assert.equal(context.result(), true);
  assert.deepEqual(calls, ['close-menu', 'clear-error', 'render', 'open']);
  assert.equal(context.result(), false, 'an already-open modal is not opened twice');
  assert.equal(calls.length, 4);
});

test('the cloud and the existing menu action share one dialog-opening path', () => {
  assert.match(template, /displayOwnWordsButton\.addEventListener\('click', openOwnWordsDialog\)/);
  assert.match(template, /container\.addEventListener\('click', openOwnWordsDialog\)/);
  assert.equal((template.match(/id="display-own-words-dialog"/g) || []).length, 1);
});
