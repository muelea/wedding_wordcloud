(function (root, factory) {
  'use strict';
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.WolkenwortePrintPreview = api;
})(typeof window !== 'undefined' ? window : globalThis, function () {
  'use strict';

  function create(dialog, { window: browser = window, i18n = browser.WolkenworteI18n } = {}) {
    const document = dialog.ownerDocument;
    const title = dialog.querySelector('[data-preview-title]');
    const surfaces = dialog.querySelector('[data-preview-surfaces]');
    const viewport = dialog.querySelector('[data-preview-viewport]');
    const artwork = dialog.querySelector('[data-preview-artwork]');
    const feedback = dialog.querySelector('[data-preview-feedback]');
    const status = dialog.querySelector('[data-preview-status]');
    const retry = dialog.querySelector('[data-preview-retry]');
    const images = new Map();
    let configuration = null;
    let surfaceKey = '';
    let opener = null;
    let previousOverflow = '';

    function fitPrintArea() {
      const entry = images.get(surfaceKey);
      const loaded = entry?.state === 'loaded';
      if (!dialog.open) return;
      const printWidth = loaded ? entry.image.naturalWidth : configuration?.product.printFile?.width;
      const printHeight = loaded ? entry.image.naturalHeight : configuration?.product.printFile?.height;
      if (!(printWidth > 0 && printHeight > 0)) return;
      const width = Math.max(1, viewport.clientWidth);
      const chromeHeight = Math.max(0, dialog.offsetHeight - viewport.clientHeight);
      const margin = browser.innerWidth <= 620 ? 12 : 48;
      const height = Math.max(1, (browser.visualViewport?.height || browser.innerHeight) - chromeHeight - margin);
      const fitScale = Math.min(width / printWidth, height / printHeight, 1);
      viewport.style.height = `${printHeight * fitScale}px`;
      if (!loaded) return;
      entry.image.style.width = `${printWidth * fitScale}px`;
      entry.image.style.height = `${printHeight * fitScale}px`;
    }

    function showState(entry) {
      if (!dialog.open || images.get(surfaceKey) !== entry) return;
      const loaded = entry.state === 'loaded';
      artwork.hidden = !loaded;
      feedback.hidden = loaded;
      retry.hidden = entry.state !== 'error';
      viewport.setAttribute('aria-busy', String(entry.state === 'loading'));
      i18n.setText(status, entry.state === 'error'
        ? 'Die Druckvorschau konnte nicht geladen werden. Bitte versucht es erneut.'
        : 'Druckvorschau wird geladen…');
      fitPrintArea();
    }

    function chooseSurface(key, reload = false) {
      if (!configuration?.printPreviewUrls?.[key]) return;
      surfaceKey = key;
      viewport.scrollLeft = 0;
      viewport.scrollTop = 0;
      for (const button of surfaces.children) {
        button.setAttribute('aria-pressed', String(button.dataset.surface === key));
      }
      let entry = images.get(key);
      if (!entry || reload) {
        const image = document.createElement('img');
        image.alt = '';
        image.decoding = 'async';
        entry = { image, state: 'loading' };
        images.set(key, entry);
        image.addEventListener('load', () => { entry.state = 'loaded'; showState(entry); });
        image.addEventListener('error', () => { entry.state = 'error'; showState(entry); });
        image.src = configuration.printPreviewUrls[key];
      }
      artwork.replaceChildren(entry.image);
      showState(entry);
    }

    function release() {
      document.documentElement.style.overflow = previousOverflow;
      images.clear();
      artwork.replaceChildren();
      viewport.style.removeProperty('height');
      configuration = null;
      opener?.focus({ preventScroll: true });
      opener = null;
    }

    dialog.querySelector('[data-preview-close]').addEventListener('click', () => dialog.close());
    dialog.addEventListener('close', release);
    dialog.addEventListener('click', (event) => {
      if (event.target !== dialog) return;
      const bounds = dialog.getBoundingClientRect();
      if (event.clientX < bounds.left || event.clientX > bounds.right ||
          event.clientY < bounds.top || event.clientY > bounds.bottom) dialog.close();
    });
    retry.addEventListener('click', () => chooseSurface(surfaceKey, true));
    browser.addEventListener('resize', fitPrintArea);
    browser.addEventListener('wolkenworte:localechange', fitPrintArea);

    return Object.freeze({
      open(item, trigger) {
        const printSurfaces = item.product.printSurfaces.filter(surface => item.printPreviewUrls?.[surface.key]);
        if (!printSurfaces.length) return;
        configuration = item;
        opener = trigger;
        images.clear();
        i18n.setText(title, item.product.displayName);
        surfaces.replaceChildren();
        surfaces.hidden = printSurfaces.length < 2;
        for (const surface of printSurfaces) {
          const button = document.createElement('button');
          button.type = 'button';
          button.dataset.surface = surface.key;
          i18n.setText(button, surface.label);
          button.addEventListener('click', () => chooseSurface(surface.key));
          surfaces.appendChild(button);
        }
        if (!dialog.open) {
          previousOverflow = document.documentElement.style.overflow;
          dialog.showModal();
          document.documentElement.style.overflow = 'hidden';
        }
        chooseSurface(printSurfaces[0].key);
      },
    });
  }

  return Object.freeze({ create });
});
