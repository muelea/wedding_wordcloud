(function () {
  'use strict';

  const surfaces = [
    'dialog', '[popover]', '[role="dialog"]', '[role="menu"]', '[role="listbox"]',
    '.ww-site-menu-panel', '.ww-language-menu', '.mobile-canvas-drawer', '.cloud-word-actions',
    '.product-gallery-price-info',
  ].join(',');
  const bound = new WeakSet();
  let modalGuard = false, touch = null;

  function surfaceFor(target) {
    return target?.closest?.(surfaces);
  }

  function canScroll(target, surface, delta, horizontal) {
    if (!delta) return false;
    for (let node = target; node; node = node.parentElement) {
      const style = window.getComputedStyle(node);
      const overflow = horizontal ? style.overflowX : style.overflowY;
      if (/^(auto|scroll)$/.test(overflow)) {
        const position = horizontal ? node.scrollLeft : node.scrollTop;
        const extent = horizontal ? node.scrollWidth - node.clientWidth : node.scrollHeight - node.clientHeight;
        if (delta < 0 ? position > 0 : position < extent - 1) return true;
      }
      if (node === surface) break;
    }
    return false;
  }

  function contain(event, target, dx, dy, x, y) {
    if (event.defaultPrevented || (!dx && !dy)) return;
    const surface = surfaceFor(target);
    // Only the innermost surface handles the gesture. Root listeners exist
    // solely while a modal is open, for gestures targeting its backdrop.
    if (surface ? event.currentTarget !== surface : event.currentTarget !== document) return;
    if (!surface) {
      if (modalGuard) event.preventDefault();
      return;
    }
    const rect = surface.getBoundingClientRect();
    const backdrop = surface.matches('dialog:modal') &&
      (x < rect.left || x > rect.right || y < rect.top || y > rect.bottom);
    const horizontal = Math.abs(dx) > Math.abs(dy);
    if (backdrop || !canScroll(target, surface, horizontal ? dx : dy, horizontal)) event.preventDefault();
  }

  function wheel(event) {
    if (event.ctrlKey || event.metaKey) return;
    const horizontalWheel = event.shiftKey && !event.deltaX;
    contain(event, event.target, horizontalWheel ? event.deltaY : event.deltaX,
      horizontalWheel ? 0 : event.deltaY, event.clientX, event.clientY);
  }

  function moveTouch(event) {
    if (!touch || event.touches.length !== 1 || event.touches[0].identifier !== touch.id) {
      touch = null;
      return;
    }
    const surface = surfaceFor(touch.target);
    if (surface ? event.currentTarget !== surface : event.currentTarget !== document) return;
    const point = event.touches[0];
    contain(event, touch.target, touch.x - point.clientX, touch.y - point.clientY, point.clientX, point.clientY);
    touch.x = point.clientX;
    touch.y = point.clientY;
  }

  const blocking = { capture: true, passive: false };
  function bind(element) {
    if (!element?.matches) return;
    if (element.matches(surfaces)) {
      if (bound.has(element)) return;
      bound.add(element);
      element.addEventListener('wheel', wheel, blocking);
      element.addEventListener('touchmove', moveTouch, blocking);
    } else if (bound.delete(element)) {
      element.removeEventListener('wheel', wheel, blocking);
      element.removeEventListener('touchmove', moveTouch, blocking);
    }
  }
  function bindTree(element) {
    bind(element);
    element.querySelectorAll?.(surfaces).forEach(bind);
  }
  function syncModal() {
    const open = Boolean(document.querySelector('dialog:modal'));
    if (open === modalGuard) return;
    modalGuard = open;
    const action = open ? 'addEventListener' : 'removeEventListener';
    document[action]('wheel', wheel, blocking);
    document[action]('touchmove', moveTouch, blocking);
  }

  // A page-wide non-passive wheel/touchmove handler makes ordinary scrolling
  // wait for the main thread even when no overlay needs to contain a gesture.
  // Attach blockers only to the actual surfaces, including dynamic pickers.
  bindTree(document);
  syncModal();
  new window.MutationObserver(records => {
    for (const record of records) {
      if (record.type === 'attributes') bind(record.target);
      else for (const node of record.addedNodes) if (node.nodeType === 1) bindTree(node);
    }
    syncModal();
  }).observe(document.documentElement, { subtree: true, childList: true, attributes: true,
    attributeFilter: ['open', 'popover', 'role', 'class'] });

  document.addEventListener('touchstart', event => {
    const point = event.touches.length === 1 ? event.touches[0] : null;
    touch = point ? { id: point.identifier, target: event.target, x: point.clientX, y: point.clientY } : null;
  }, { capture: true, passive: true });
  const endTouch = () => { touch = null; };
  document.addEventListener('touchend', endTouch, { capture: true, passive: true });
  document.addEventListener('touchcancel', endTouch, { capture: true, passive: true });
})();
