'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const CloudWordActions = require('../public/js/cloud-word-actions');

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
    closeCloudWordActions() { calls.push('close-actions'); },
    closeDisplayMenu() { calls.push('close-menu'); },
    clearText(element) { assert.equal(element, context.displayOwnWordsError); calls.push('clear-error'); },
    renderOwnContributions() { calls.push('render'); },
  });
  vm.runInContext(`${pageFunction('openOwnWordsDialog')}; result = openOwnWordsDialog`, context);

  assert.equal(context.result(), false);
  assert.deepEqual(calls, []);

  context.ownContributions.set('receipt-a', 'Liebe');
  assert.equal(context.result(), true);
  assert.deepEqual(calls, ['close-actions', 'close-menu', 'clear-error', 'render', 'open']);
  assert.equal(context.result(), false, 'an already-open modal is not opened twice');
  assert.equal(calls.length, 5);
});

test('empty cloud space and both management actions share one dialog-opening path', () => {
  assert.match(template, /displayOwnWordsButton\.addEventListener\('click', openOwnWordsDialog\)/);
  assert.match(template, /displayOwnWordsShortcut\.addEventListener\('click', openOwnWordsDialog\)/);
  assert.match(template, /container\.addEventListener\('click', handleCloudInteraction\)/);
  assert.match(template, /if \(item\)[\s\S]*?openCloudWordActions\(item\.word,[\s\S]*?openOwnWordsDialog\(\)/);
  assert.match(template, /displayOwnWordsShortcut\.disabled = total === 0/);
  assert.equal((template.match(/id="display-own-words-dialog"/g) || []).length, 1);
});

test('word hit testing uses the scaled painted box and only then its larger touch target', () => {
  const painted = { word: 'painted', x: 50, y: 50, width: 40, height: 10, scale: 2 };
  const nearby = { word: 'nearby', x: 98, y: 50, width: 8, height: 8, scale: 1 };

  assert.equal(CloudWordActions.containsPoint(painted, { x: 89, y: 59 }), true);
  assert.equal(CloudWordActions.containsPoint(painted, { x: 91, y: 50 }), false);
  assert.equal(CloudWordActions.hitTestPlacedWord([painted, nearby], { x: 89, y: 50 }, 8), painted,
    'a real painted hit must win over a later item reached only by touch padding');
  assert.equal(CloudWordActions.hitTestPlacedWord([painted, nearby], { x: 104, y: 50 }, 8), nearby);
  assert.equal(CloudWordActions.hitTestPlacedWord([painted], { x: 110, y: 50 }, 8), null);
});

test('the selected word exposes support and receipt-bound removal actions', () => {
  assert.match(template, /cloudWordSupport\.addEventListener\('click',[\s\S]*?submitDisplayWord\(activeCloudWord, 'cloud'\)/);
  assert.match(template, /const receipt = latestOwnReceipt\(activeCloudWord\)[\s\S]*?removeOwnContribution\(receipt, cloudWordRemove/);
  assert.match(template, /cloudWordRemove\.hidden = !receipt/);
  assert.doesNotMatch(template, /socket\.emit\('remove-word',\s*\{\s*word/,
    'word actions must never bypass the browser-owned removal receipt');
});
