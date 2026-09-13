'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const runtime = fs.readFileSync(path.join(__dirname, '..', 'public', 'js', 'site-header.js'), 'utf8');

function listeners() {
  const values = new Map();
  return {
    add(type, listener) {
      const registered = values.get(type) || [];
      registered.push(listener);
      values.set(type, registered);
    },
    dispatch(type, event = {}) {
      for (const listener of values.get(type) || []) listener(event);
    },
  };
}

function classList() {
  const values = new Set();
  return {
    contains: (name) => values.has(name),
    remove: (name) => values.delete(name),
    toggle(name, force) {
      const active = force === undefined ? !values.has(name) : Boolean(force);
      if (active) values.add(name);
      else values.delete(name);
      return active;
    },
  };
}

function mountHeader() {
  const documentEvents = listeners();
  const windowEvents = listeners();
  const toggleEvents = listeners();
  const linkEvents = listeners();
  const header = { classList: classList() };
  const menuTarget = {};
  const toggleTarget = {};
  const sectionLink = { addEventListener: linkEvents.add };
  const menu = {
    contains: (target) => target === menuTarget,
    querySelectorAll: () => [sectionLink],
  };
  const attributes = new Map([['aria-controls', 'landing-section-links']]);
  const toggle = {
    addEventListener: toggleEvents.add,
    closest: () => header,
    contains: (target) => target === toggleTarget,
    getAttribute: (name) => attributes.get(name),
    setAttribute: (name, value) => attributes.set(name, value),
  };
  const document = {
    addEventListener: documentEvents.add,
    getElementById: () => menu,
    querySelectorAll(selector) {
      if (selector === '.ww-site-header') return [header];
      if (selector === '.landing-menu-toggle') return [toggle];
      return [];
    },
  };
  const window = { addEventListener: windowEvents.add, scrollY: 0 };
  vm.runInNewContext(runtime, { document, window });
  return {
    attributes,
    documentEvents,
    header,
    linkEvents,
    menuTarget,
    toggleEvents,
    toggleTarget,
  };
}

function mountMobileHeaderMenu() {
  const documentEvents = listeners();
  const menuEvents = listeners();
  const linkEvents = listeners();
  const attributes = new Map();
  const header = { classList: classList() };
  const insideTarget = {};
  const nestedLanguagePicker = { open: false };
  const trigger = {
    focused: false,
    focus() { this.focused = true; },
    setAttribute(name, value) { attributes.set(name, value); },
  };
  const link = { addEventListener: linkEvents.add };
  const menu = {
    open: false,
    addEventListener: menuEvents.add,
    contains: (target) => target === insideTarget,
    querySelector(selector) {
      if (selector === '[data-ww-mobile-header-menu-trigger]') return trigger;
      if (selector === '[data-language-picker][open]') {
        return nestedLanguagePicker.open ? nestedLanguagePicker : null;
      }
      return null;
    },
    querySelectorAll(selector) {
      if (selector === '[data-language-picker]') return [nestedLanguagePicker];
      if (selector === 'a') return [link];
      return [];
    },
  };
  const document = {
    addEventListener: documentEvents.add,
    querySelectorAll(selector) {
      if (selector === '.ww-site-header') return [header];
      if (selector === '.landing-menu-toggle') return [];
      if (selector === '[data-ww-mobile-header-menu]') return [menu];
      return [];
    },
  };
  const window = { addEventListener() {}, scrollY: 0 };
  vm.runInNewContext(runtime, { document, window });
  return {
    attributes,
    documentEvents,
    insideTarget,
    linkEvents,
    menu,
    menuEvents,
    nestedLanguagePicker,
    trigger,
  };
}

test('landing menu closes on an outside pointer while preserving inside interactions', () => {
  const page = mountHeader();
  const isOpen = () => page.header.classList.contains('landing-menu-open');

  page.toggleEvents.dispatch('click');
  assert.equal(isOpen(), true);
  assert.equal(page.attributes.get('aria-expanded'), 'true');
  assert.equal(page.attributes.get('aria-label'), 'Seitennavigation schließen');

  page.documentEvents.dispatch('pointerdown', { target: page.menuTarget });
  assert.equal(isOpen(), true, 'using the menu must not dismiss it before the click completes');
  page.documentEvents.dispatch('pointerdown', { target: page.toggleTarget });
  assert.equal(isOpen(), true, 'the toggle handles its own pointer interaction');

  page.documentEvents.dispatch('pointerdown', { target: {} });
  assert.equal(isOpen(), false);
  assert.equal(page.attributes.get('aria-expanded'), 'false');
  assert.equal(page.attributes.get('aria-label'), 'Seitennavigation öffnen');
});

test('landing menu still closes through section links and Escape', () => {
  const page = mountHeader();
  const isOpen = () => page.header.classList.contains('landing-menu-open');

  page.toggleEvents.dispatch('click');
  page.linkEvents.dispatch('click');
  assert.equal(isOpen(), false);

  page.toggleEvents.dispatch('click');
  page.documentEvents.dispatch('keydown', { key: 'Escape' });
  assert.equal(isOpen(), false);
  assert.equal(page.attributes.get('aria-expanded'), 'false');
});

test('compact header menu updates its label and closes through links and outside interactions', () => {
  const page = mountMobileHeaderMenu();
  page.menu.open = true;
  page.menuEvents.dispatch('toggle');
  assert.equal(page.attributes.get('aria-label'), 'Menü schließen');

  page.documentEvents.dispatch('pointerdown', { target: page.insideTarget });
  assert.equal(page.menu.open, true);
  page.documentEvents.dispatch('pointerdown', { target: {} });
  assert.equal(page.menu.open, false);

  page.menu.open = true;
  page.linkEvents.dispatch('click');
  assert.equal(page.menu.open, false);
  assert.equal(page.nestedLanguagePicker.open, false);
});

test('compact header menu lets an open language picker consume Escape first', () => {
  const page = mountMobileHeaderMenu();
  page.menu.open = true;
  page.nestedLanguagePicker.open = true;
  page.documentEvents.dispatch('keydown', { key: 'Escape' });
  assert.equal(page.menu.open, true);

  page.nestedLanguagePicker.open = false;
  page.documentEvents.dispatch('keydown', { key: 'Escape' });
  assert.equal(page.menu.open, false);
  assert.equal(page.trigger.focused, true);
});
