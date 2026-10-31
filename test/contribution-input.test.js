'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { JSDOM } = require('jsdom');
const Input = require('../public/js/contribution-input');
const Emoji = require('../public/js/emoji-catalog');
const { normalizeWordInput, normalizeTextInput } = require('../src/words');

function fixture(t, value = '') {
  const dom = new JSDOM('<input>');
  t.after(() => dom.window.close());
  const input = dom.window.document.querySelector('input');
  input.value = value;
  const counts = [];
  const controller = Input.bind(input, { onChange: count => counts.push(count) });
  function type(text) {
    const event = new dom.window.InputEvent('beforeinput', {
      inputType: 'insertText', data: text, bubbles: true, cancelable: true,
    });
    if (input.dispatchEvent(event)) {
      input.setRangeText(text, input.selectionStart, input.selectionEnd, 'end');
      input.dispatchEvent(new dom.window.InputEvent('input', { inputType: 'insertText', data: text }));
    }
  }
  function paste(text) {
    const event = new dom.window.Event('paste', { cancelable: true });
    Object.defineProperty(event, 'clipboardData', { value: { getData: () => text } });
    input.dispatchEvent(event);
    assert.equal(event.defaultPrevented, true);
  }
  return { dom, input, controller, counts, type, paste };
}

test('typing stops at 30 visible characters and permits replacement and deletion at the limit', t => {
  const { input, type, counts } = fixture(t);
  for (const letter of 'abcdefghijklmnopqrstuvwxyz123456789') type(letter);
  assert.equal(input.value, 'abcdefghijklmnopqrstuvwxyz1234');
  assert.equal(counts.at(-1), 30);
  input.setSelectionRange(2, 5);
  type('XYZQ');
  assert.equal(input.value, 'abXYZfghijklmnopqrstuvwxyz1234');
  assert.equal(input.selectionStart, 5);
  input.setRangeText('', 2, 5, 'end');
  type('123');
  assert.equal(input.value, 'ab123fghijklmnopqrstuvwxyz1234');
});

test('paste and picker insertion keep complete emojis and preserve the unselected suffix', t => {
  const family = '👨‍👩‍👧‍👦';
  const { input, paste, controller } = fixture(t, 'A'.repeat(28) + 'Z');
  input.setSelectionRange(28, 28);
  paste(family.repeat(10));
  assert.equal(input.value, 'A'.repeat(28) + family + 'Z');
  assert.equal(Emoji.graphemeLength(input.value), 30);
  controller.insert('❤️');
  assert.equal(input.value, 'A'.repeat(28) + family + 'Z');
  input.setSelectionRange(0, input.value.length);
  controller.insert(family.repeat(30));
  assert.equal(input.value, family.repeat(30));
  assert.equal(normalizeWordInput(input.value).word, input.value);
});

test('combining accents count once and native edits without beforeinput are bounded', t => {
  const { input, type, dom } = fixture(t, 'x'.repeat(29));
  type('e');
  type('\u0301');
  assert.equal(input.value, 'x'.repeat(29) + 'e\u0301');
  assert.equal(Emoji.graphemeLength(input.value), 30);
  input.value = '❤️'.repeat(40);
  input.dispatchEvent(new dom.window.InputEvent('input', { inputType: 'insertReplacementText' }));
  assert.equal(input.value, '❤️'.repeat(30));
});

test('composition is left intact until commit and cannot be submitted midway', t => {
  const { input, dom, controller } = fixture(t, 'A'.repeat(29) + 'Z');
  input.setSelectionRange(29, 29);
  input.dispatchEvent(new dom.window.CompositionEvent('compositionstart'));
  input.value = 'A'.repeat(29) + '日本Z';
  input.dispatchEvent(new dom.window.InputEvent('input', { isComposing: true }));
  assert.equal(input.value, 'A'.repeat(29) + '日本Z');
  assert.equal(controller.enforce(), false);
  input.dispatchEvent(new dom.window.CompositionEvent('compositionend'));
  assert.equal(input.value, 'A'.repeat(29) + 'Z');
});

test('autofill-style replacements preserve the trailing text and clearing resets the counter', t => {
  const { input, dom, controller, counts } = fixture(t, 'A'.repeat(27) + 'YZ');
  input.setSelectionRange(27, 27);
  input.dispatchEvent(new dom.window.InputEvent('beforeinput', { inputType: 'insertReplacementText' }));
  input.value = 'A'.repeat(27) + '123456YZ';
  input.dispatchEvent(new dom.window.InputEvent('input'));
  assert.equal(input.value, 'A'.repeat(27) + '1YZ');
  input.value = '';
  controller.refresh();
  assert.equal(counts.at(-1), 0);
});

test('only contributions have the length cap; shared design sanitation preserves long text', () => {
  const text = 'Persönliche Erinnerungen für immer '.repeat(50).trim();
  assert.ok(text.length > 1024);
  assert.deepEqual(normalizeWordInput(text), { word: '', error: 'word_too_long' });
  assert.deepEqual(normalizeTextInput(text), { word: text, error: null });
  assert.deepEqual(normalizeTextInput('  Café\u0000  ❤  '), { word: 'Café ❤️', error: null });
});
