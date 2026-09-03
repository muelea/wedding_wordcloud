'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const DesignFonts = require('../public/js/design-fonts');

function createPicker(locale = 'de') {
  const document = { activeElement: null, created: [] };
  document.createElement = tagName => {
    const element = {
      tagName, children: [], style: {}, dataset: {}, attributes: {}, listeners: {}, hidden: false,
      append(...children) { this.children.push(...children); },
      appendChild(child) { this.append(child); },
      replaceChildren() { this.children = []; },
      setAttribute(name, value) { this.attributes[name] = value; },
      getAttribute(name) { return this.attributes[name]; },
      addEventListener(name, handler) { this.listeners[name] = handler; },
      querySelectorAll() { return this.children.filter(child => child.className === 'editor-font-option'); },
      focus() { document.activeElement = this; },
      click() { this.listeners.click?.(); },
    };
    document.created.push(element);
    return element;
  };
  const catalog = locale === 'de' ? {} : require(`../public/locales/${locale}.json`);
  const window = { DesignFonts, WolkenworteI18n: { t: text => catalog[text] || text } };
  vm.runInNewContext(fs.readFileSync(require.resolve('../public/js/mug-editor.js'), 'utf8'), { window, document });
  const editor = Object.create(window.MugPrintEditor.prototype);
  editor.fontButton = document.createElement('button');
  editor.fontCurrent = document.createElement('span');
  editor.fontMenu = document.createElement('div');
  editor.fontPickerInline = false;
  editor.closeIconPicker = () => {};
  editor.setFeedback = text => { editor.feedback = text; };
  const changes = [];
  editor.setActiveFont = async key => { changes.push(key); editor.syncFontPicker(key, '', false); };
  editor.renderFontOptions();
  return { editor, document, changes, catalog };
}

function key(editor, value) {
  const event = { key: value, prevented: false, stopped: false,
    preventDefault() { this.prevented = true; }, stopPropagation() { this.stopped = true; } };
  editor.onFontPickerKeyDown(event);
  return event;
}

test('one custom option set comes from the shared catalog, in all six languages', () => {
  for (const locale of ['de', 'en', 'fr', 'it', 'es', 'tr']) {
    const { editor, document, catalog } = createPicker(locale);
    assert.equal(editor.fontOptionButtons.length, DesignFonts.FONTS.length);
    assert.equal(document.created.some(element => ['select', 'option'].includes(element.tagName)), false);
    for (const [index, font] of DesignFonts.FONTS.entries()) {
      const option = editor.fontOptionButtons[index];
      assert.equal(option.getAttribute('role'), 'option');
      assert.equal(option.dataset.fontKey, font.key);
      assert.equal(option.children[0].textContent, catalog[font.label] || font.label);
      assert.equal(option.children[0].style.fontFamily, font.cssFamily);
      assert.equal(option.children[1].textContent, catalog[font.description] || font.description);
    }
  }
});

test('dropdown and inline sheet reuse options and the same change handler', () => {
  const { editor, document, changes } = createPicker();
  const options = editor.fontOptionButtons;
  editor.syncFontPicker('classic', '', false);
  editor.openFontPicker();
  options[1].click();
  assert.equal(editor.fontMenu.hidden, true);
  assert.equal(document.activeElement, editor.fontButton);
  editor.setFontPickerInline(true);
  options[2].focus();
  options[2].click();
  assert.equal(editor.fontMenu.hidden, false);
  assert.equal(editor.fontButton.hidden, true);
  assert.equal(document.activeElement, options[2]);
  assert.deepEqual(changes, ['lora', 'montserrat']);
  editor.closeFontPicker(true); // outside clicks cannot collapse an inline list
  assert.equal(editor.fontMenu.hidden, false);
  editor.setFontPickerInline(false);
  assert.equal(editor.fontMenu.hidden, true);
  assert.equal(editor.fontButton.hidden, false);
  assert.equal(editor.fontButton.getAttribute('aria-expanded'), 'false');
  assert.equal(editor.fontOptionButtons, options);
  assert.equal(editor.selectedFontKey, 'montserrat');
});

test('listbox has one tab stop and separates keyboard focus from selected font', () => {
  const { editor, document, changes } = createPicker();
  editor.syncFontPicker('lora', '', false);
  editor.openFontPicker(-1);
  assert.equal(document.activeElement, editor.fontOptionButtons[1]);
  key(editor, 'ArrowDown');
  assert.equal(document.activeElement, editor.fontOptionButtons[2]);
  assert.equal(editor.selectedFontKey, 'lora');
  assert.equal(changes.length, 0);
  assert.equal(editor.fontOptionButtons.filter(button => button.tabIndex === 0).length, 1);
  key(editor, 'End');
  assert.equal(document.activeElement, editor.fontOptionButtons[4]);
  key(editor, 'ArrowDown');
  assert.equal(document.activeElement, editor.fontOptionButtons[0]);
  key(editor, 'ArrowUp');
  assert.equal(document.activeElement, editor.fontOptionButtons[4]);
  key(editor, 'Home');
  key(editor, 'Enter');
  assert.deepEqual(changes, ['classic']);
  editor.setFontPickerInline(true);
  editor.focusFontOption(3);
  key(editor, ' ');
  assert.deepEqual(changes, ['classic', 'caveat']);
  assert.equal(editor.fontMenu.hidden, false);
});

test('Escape and Tab defer to the modal in inline mode, dismiss only the dropdown otherwise', () => {
  const { editor, document } = createPicker();
  editor.syncFontPicker('classic', '', false);
  editor.openFontPicker();
  assert.equal(key(editor, 'Escape').prevented, true);
  assert.equal(editor.fontMenu.hidden, true);
  assert.equal(document.activeElement, editor.fontButton);
  editor.openFontPicker();
  assert.equal(key(editor, 'Tab').prevented, false);
  assert.equal(editor.fontMenu.hidden, true);
  assert.equal(document.activeElement, editor.fontButton);
  editor.setFontPickerInline(true);
  editor.focusFontOption(0);
  for (const value of ['Escape', 'Tab']) {
    const event = key(editor, value);
    assert.equal(event.prevented, false);
    assert.equal(event.stopped, false);
    assert.equal(editor.fontMenu.hidden, false);
    assert.equal(document.activeElement, editor.fontOptionButtons[0]);
  }
});

test('mixed selection, disabled state and programmatic updates stay authoritative', () => {
  const { editor, changes } = createPicker();
  editor.syncFontPicker('', 'Mehrere Schriften', false);
  assert.equal(editor.fontCurrent.textContent, 'Mehrere Schriften');
  assert.equal(editor.fontOptionButtons.some(button => button.getAttribute('aria-selected') === 'true'), false);
  editor.syncFontPicker('caveat', '', false);
  assert.equal(editor.fontOptionButtons[3].getAttribute('aria-selected'), 'true');
  assert.equal(editor.fontOptionButtons[3].tabIndex, 0);
  editor.syncFontPicker('lora', '', false); // e.g. Undo/Redo or selection replacement
  assert.equal(editor.fontOptionButtons[1].getAttribute('aria-selected'), 'true');
  assert.equal(editor.fontOptionButtons[3].getAttribute('aria-selected'), 'false');
  editor.syncFontPicker('', 'Nur für Text', true);
  editor.openFontPicker();
  editor.fontOptionButtons[1].click();
  assert.equal(editor.fontMenu.hidden, true);
  assert.equal(changes.length, 0);
});

test('failed font changes show feedback without changing the selected font', async () => {
  const { editor } = createPicker();
  editor.syncFontPicker('classic', '', false);
  editor.setFontPickerInline(true);
  editor.setActiveFont = async () => { throw new Error('load failed'); };
  editor.fontOptionButtons[1].click();
  await Promise.resolve();
  assert.equal(editor.feedback, 'Schrift konnte nicht geladen werden');
  assert.equal(editor.selectedFontKey, 'classic');
  assert.equal(editor.fontMenu.hidden, false);
});
