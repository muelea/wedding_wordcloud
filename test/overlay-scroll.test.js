'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const { JSDOM } = require('jsdom');
const { renderPage } = require('../src/pageRenderer');
const runtime = fs.readFileSync('public/js/overlay-scroll.js', 'utf8');

function mount(t, html = '') {
  const dom = new JSDOM(html, { url: 'https://example.test/' });
  t.after(() => dom.window.close());
  const { window } = dom, { document } = window;
  const refreshers = [], roots = [];
  const Observer = window.MutationObserver;
  window.MutationObserver = class extends Observer {
    constructor(callback) {
      super(callback);
      refreshers.push(() => callback(this.takeRecords(), this));
    }
  };
  const add = document.addEventListener.bind(document), remove = document.removeEventListener.bind(document);
  document.addEventListener = (type, listener, options) => {
    if (options?.passive === false) roots.push({ type, listener });
    add(type, listener, options);
  };
  document.removeEventListener = (type, listener, options) => {
    const index = roots.findIndex(item => item.type === type && item.listener === listener);
    if (index >= 0) roots.splice(index, 1);
    remove(type, listener, options);
  };
  // JSDOM has no native top layer. Keep modal state distinct from [open], just
  // as a real browser does for show(), showModal() and showPopover().
  const modals = new Set();
  const matches = window.Element.prototype.matches;
  window.Element.prototype.matches = function (selector) {
    return selector === 'dialog:modal' ? modals.has(this) : matches.call(this, selector);
  };
  const query = document.querySelector.bind(document);
  document.querySelector = selector => selector === 'dialog:modal' ? [...modals].at(-1) || null : query(selector);
  vm.runInNewContext(runtime, { window, document });
  function wheel(target, options = {}) {
    // Real user input is a later task, after DOM mutation observers run.
    refreshers.forEach(refresh => refresh());
    const event = new window.WheelEvent('wheel', { bubbles: true, cancelable: true, deltaY: 100, clientX: 20, clientY: 20, ...options });
    target.dispatchEvent(event);
    return event.defaultPrevented;
  }
  function touch(target, type, points) {
    refreshers.forEach(refresh => refresh());
    const event = new window.Event(type, { bubbles: true, cancelable: true });
    Object.defineProperty(event, 'touches', { value: points.map(([x, y, id = 1]) => ({ clientX: x, clientY: y, identifier: id })) });
    target.dispatchEvent(event);
    return event.defaultPrevented;
  }
  return { window, document, modals, wheel, touch, roots };
}

test('ordinary pages and non-modal menus have no root scroll-blocking listeners', t => {
  const h = mount(t, '<main>Gallery</main><div role="menu"><button>Choice</button></div><dialog>Modal</dialog>');
  const page = h.document.querySelector('main'), modal = h.document.querySelector('dialog');
  assert.equal(h.roots.length, 0);
  assert.equal(h.wheel(h.document.querySelector('button')), true);
  assert.equal(h.roots.length, 0, 'menu containment is scoped to the menu');
  h.modals.add(modal);
  assert.equal(h.wheel(page), true);
  assert.deepEqual(h.roots.map(item => item.type).sort(), ['touchmove', 'wheel']);
  h.modals.delete(modal);
  assert.equal(h.wheel(page), false);
  assert.equal(h.roots.length, 0, 'closing the last modal restores asynchronous page scrolling');
});

test('changing a dynamic surface role adds and removes its own containment', t => {
  const h = mount(t, '<main><div><button>Choice</button></div></main>');
  const surface = h.document.querySelector('div'), button = surface.firstElementChild;
  assert.equal(h.wheel(button), false);
  surface.setAttribute('role', 'listbox');
  assert.equal(h.wheel(button), true);
  surface.removeAttribute('role');
  assert.equal(h.wheel(button), false);
  assert.equal(h.roots.length, 0);
});

function scrolling(node, { top = 0, left = 0, height = 300, width = 100, clientHeight = 100, clientWidth = 100 } = {}) {
  node.style.overflowY = node.style.overflowX = 'auto';
  Object.defineProperties(node, {
    scrollHeight: { configurable: true, value: height }, clientHeight: { configurable: true, value: clientHeight },
    scrollWidth: { configurable: true, value: width }, clientWidth: { configurable: true, value: clientWidth },
  });
  node.scrollTop = top; node.scrollLeft = left;
}

test('all site surfaces contain wheel gestures even with no overflowing content', t => {
  const h = mount(t);
  for (const markup of ['<dialog open>', '<div popover>', '<div role="dialog">', '<div role="menu">',
    '<div role="listbox">', '<div class="ww-site-menu-panel">', '<nav class="ww-language-menu">',
    '<div class="mobile-canvas-drawer">', '<div class="cloud-word-actions">',
    '<div class="product-gallery-price-info" role="note">']) {
    h.document.body.innerHTML = `${markup}<button>Choice</button>`;
    assert.equal(h.wheel(h.document.querySelector('button')), true, markup);
    assert.equal(h.wheel(h.document.querySelector('button'), { deltaX: 100, deltaY: 0 }), true, markup);
  }
});

test('native scrolling works inside a panel and is contained in both directions at its edges', t => {
  const h = mount(t, '<dialog open><header>Title</header><div><button>Choice</button></div></dialog>');
  const scroller = h.document.querySelector('dialog > div'), button = scroller.firstElementChild;
  scrolling(scroller);
  assert.equal(h.wheel(button), false);
  assert.equal(h.wheel(button, { deltaY: -100 }), true);
  scroller.scrollTop = 80;
  assert.equal(h.wheel(button), false);
  assert.equal(h.wheel(button, { deltaY: -100 }), false);
  scroller.scrollTop = 199.5;
  assert.equal(h.wheel(button), true, 'fractional bottom edge');
  scroller.scrollTop = -10;
  assert.equal(h.wheel(button, { deltaY: -100 }), true, 'Safari overscroll at the top');
  assert.equal(h.wheel(h.document.querySelector('header')), true, 'non-scrolling header');
});

test('a nested language picker cannot scroll its parent navigation menu', t => {
  const h = mount(t, '<div class="ww-site-menu-panel"><nav class="ww-language-menu"><a>English</a></nav></div>');
  scrolling(h.document.querySelector('.ww-site-menu-panel'), { height: 900 });
  const picker = h.document.querySelector('nav');
  scrolling(picker);
  assert.equal(h.wheel(picker.firstElementChild), false);
  picker.scrollTop = 200;
  assert.equal(h.wheel(picker.firstElementChild), true);
  assert.equal(h.document.querySelector('.ww-site-menu-panel').scrollTop, 0);
});

test('horizontal and Shift-wheel scrolling stay within the current overlay', t => {
  const h = mount(t, '<div role="dialog"><nav><button>Category</button></nav></div>');
  const list = h.document.querySelector('nav'), button = list.firstElementChild;
  scrolling(list, { width: 400, height: 100 });
  assert.equal(h.wheel(button, { deltaX: 100, deltaY: 0 }), false);
  assert.equal(h.wheel(button, { shiftKey: true }), false);
  list.scrollLeft = 300;
  assert.equal(h.wheel(button, { deltaX: 100, deltaY: 0 }), true);
  assert.equal(h.wheel(button, { shiftKey: true }), true);
  assert.equal(h.wheel(button, { deltaX: -100, deltaY: 0 }), false);
});

test('scrolling outside non-modal menus stays available and dynamically added panels are covered', t => {
  const h = mount(t, '<main>Page</main>');
  assert.equal(h.wheel(h.document.querySelector('main')), false);
  h.document.body.insertAdjacentHTML('beforeend', '<div popover><button>New panel</button></div>');
  assert.equal(h.wheel(h.document.querySelector('button')), true);
  assert.equal(h.wheel(h.document.querySelector('main')), false);
});

test('zoom gestures and events already handled by a control are preserved', t => {
  const h = mount(t, '<div role="listbox"><button>Font</button></div>'), button = h.document.querySelector('button');
  assert.equal(h.wheel(button, { ctrlKey: true }), false);
  assert.equal(h.wheel(button, { metaKey: true }), false);
  assert.equal(h.wheel(button, { deltaX: 0, deltaY: 0 }), false);
  // A control may handle its own wheel behavior after the delegated guard.
  button.addEventListener('wheel', event => event.preventDefault());
  assert.equal(h.wheel(button), true);
});

test('modal backdrops cannot scroll the dialog or the page and nested dialogs retain their lock', t => {
  const h = mount(t, '<main>Page</main><dialog open>Outer</dialog><dialog open>Inner</dialog>');
  const [outer, inner] = h.document.querySelectorAll('dialog');
  scrolling(inner);
  inner.getBoundingClientRect = () => ({ left: 100, right: 400, top: 100, bottom: 400 });
  h.modals.add(outer); h.modals.add(inner);
  assert.equal(h.wheel(inner), true, 'backdrop targets a scrollable dialog');
  assert.equal(h.wheel(inner, { clientX: 200, clientY: 200 }), false, 'dialog content scrolls');
  assert.equal(h.wheel(h.document.querySelector('main')), true);
  h.modals.delete(inner);
  assert.equal(h.wheel(h.document.querySelector('main')), true, 'outer modal is still open');
  h.modals.delete(outer);
  assert.equal(h.wheel(h.document.querySelector('main')), false, 'last modal closed');
});

test('touch scrolling stays native within a panel and stops at both edges or over a header', t => {
  const h = mount(t, '<div role="dialog"><header>Title</header><section><button>Choice</button></section></div>');
  const scroller = h.document.querySelector('section'), button = scroller.firstElementChild;
  scrolling(scroller);
  h.touch(button, 'touchstart', [[20, 200]]);
  assert.equal(h.touch(button, 'touchmove', [[20, 150]]), false);
  scroller.scrollTop = 200;
  assert.equal(h.touch(button, 'touchmove', [[20, 100]]), true);
  assert.equal(h.touch(button, 'touchmove', [[20, 150]]), false, 'reversing direction works immediately');
  scroller.scrollTop = 0;
  assert.equal(h.touch(button, 'touchmove', [[20, 200]]), true);
  const header = h.document.querySelector('header');
  h.touch(header, 'touchstart', [[20, 200]]);
  assert.equal(h.touch(header, 'touchmove', [[20, 150]]), true);
});

test('touches outside popovers scroll normally, while modal backdrops block them', t => {
  const h = mount(t, '<main>Page</main><dialog open>Modal</dialog>'), page = h.document.querySelector('main');
  h.touch(page, 'touchstart', [[20, 200]]);
  assert.equal(h.touch(page, 'touchmove', [[20, 150]]), false);
  h.modals.add(h.document.querySelector('dialog'));
  assert.equal(h.touch(page, 'touchmove', [[20, 100]]), true);
});

test('pinch gestures, cancelled touches and new touch identifiers are not mistaken for scrolling', t => {
  const h = mount(t, '<div role="menu">Menu</div>'), menu = h.document.querySelector('div');
  h.touch(menu, 'touchstart', [[20, 200]]);
  assert.equal(h.touch(menu, 'touchmove', [[20, 150], [80, 150, 2]]), false);
  assert.equal(h.touch(menu, 'touchmove', [[20, 100]]), false);
  h.touch(menu, 'touchstart', [[20, 200]]);
  h.touch(menu, 'touchcancel', []);
  assert.equal(h.touch(menu, 'touchmove', [[20, 100]]), false);
  h.touch(menu, 'touchstart', [[20, 200]]);
  assert.equal(h.touch(menu, 'touchmove', [[20, 100, 2]]), false);
});

test('every public page loads the shared modal policy and scroll guard', async () => {
  for (const template of ['landing', 'display', 'configure', 'shipping', 'account', 'order-confirmation',
    'impressum', 'datenschutz', 'bestellinformationen', '404']) {
    let html;
    await renderPage({ query: {}, headers: {}, originalUrl: '/' }, {
      cookie() {}, status() {}, set() {}, vary() {}, send(value) { html = value; },
    }, template, { pageData: { eventUrl: 'https://example.test/e/a', cloudTitle: 'Scroll audit',
      initialWords: [], qrSvg: '', accountAvailable: false,
      seller: { name: 'Test seller', address: [], email: 'test@example.invalid', phone: '000' },
      purchaseTerms: require('../src/purchaseTerms') } });
    const document = new JSDOM(html).window.document;
    assert.equal(document.querySelectorAll('script[src^="/js/overlay-scroll.js?"]').length, 1, template);
    assert.ok(document.querySelector('link[href^="/site-header.css?"]'), template);
    document.defaultView.close();
  }
});
