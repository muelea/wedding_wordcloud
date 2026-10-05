(function (root, factory) {
  'use strict';
  const api = factory(typeof module === 'object' && module.exports
    ? require('./product-mockup-preview') : root.WolkenworteProductMockups);
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.WolkenwortePrintPreview = api;
})(typeof window !== 'undefined' ? window : globalThis, function (Mockups) {
  'use strict';

  function create(dialog, { window: browser = window, i18n = browser.WolkenworteI18n,
    mockups = Mockups.create({ window: browser }),
  } = {}) {
    const document = dialog.ownerDocument;
    const title = dialog.querySelector('[data-preview-title]');
    const surfaces = dialog.querySelector('[data-preview-surfaces]');
    const viewport = dialog.querySelector('[data-preview-viewport]');
    const artwork = dialog.querySelector('[data-preview-artwork]');
    const feedback = dialog.querySelector('[data-preview-feedback]');
    const status = dialog.querySelector('[data-preview-status]');
    const retry = dialog.querySelector('[data-preview-retry]');
    const mockupActions = dialog.querySelector('[data-preview-mockup-actions]');
    const mockupButton = dialog.querySelector('[data-preview-mockup]');
    const mockupStatus = dialog.querySelector('[data-preview-mockup-status]');
    const images = new Map();
    let configuration = null;
    let surfaceKey = '';
    let opener = null;
    let previousOverflow = '';
    let mode = 'print';
    let mockupResult = null;
    let generation = 0;

    function fitPrintArea() {
      const entry = images.get(surfaceKey);
      const loaded = entry?.state === 'loaded';
      if (!dialog.open) return;
      const printWidth = loaded ? entry.image.naturalWidth
        : mode === 'mockup' ? 1000 : configuration?.product.printFile?.width;
      const printHeight = loaded ? entry.image.naturalHeight
        : mode === 'mockup' ? 1000 : configuration?.product.printFile?.height;
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
      if (entry.state === 'error' && mode === 'mockup') {
        mockups.invalidate(configuration.mockupUrl);
        for (const key of images.keys()) if (key.startsWith('mockup:')) images.delete(key);
        showPrint();
        showMockupError();
        return;
      }
      const loaded = entry.state === 'loaded';
      artwork.hidden = !loaded;
      feedback.hidden = loaded;
      retry.hidden = entry.state !== 'error';
      viewport.setAttribute('aria-busy', String(entry.state === 'loading'));
      i18n.setText(status, entry.state === 'error'
        ? 'Die Druckvorschau konnte nicht geladen werden. Bitte versucht es erneut.'
        : mode === 'mockup' ? 'Produktvorschau wird geladen…' : 'Druckvorschau wird geladen…');
      fitPrintArea();
    }

    function chooseSurface(key, reload = false) {
      if (!configuration?.printPreviewUrls?.[key]) return;
      chooseImage(key, configuration.printPreviewUrls[key], reload);
    }

    function chooseImage(key, url, reload = false) {
      surfaceKey = key;
      viewport.scrollLeft = 0;
      viewport.scrollTop = 0;
      for (const button of surfaces.children) {
        button.setAttribute('aria-pressed', String(button.dataset.surface === key));
      }
      let entry = images.get(key);
      if (!entry || reload) {
        const image = document.createElement('img');
        image.alt = mode === 'mockup' ? i18n.t('Produktvorschau') : '';
        image.decoding = 'async';
        entry = { image, state: 'loading' };
        images.set(key, entry);
        image.addEventListener('load', () => { entry.state = 'loaded'; showState(entry); });
        image.addEventListener('error', () => { entry.state = 'error'; showState(entry); });
        image.src = url;
      }
      artwork.replaceChildren(entry.image);
      showState(entry);
    }

    function updateMockupButton() {
      mockupActions.hidden = !configuration?.mockupUrl;
      if (mockupActions.hidden) return;
      const state = mockups.get(configuration.mockupUrl);
      mockupButton.disabled = state.status === 'loading';
      i18n.setText(mockupButton, mode === 'mockup' ? 'Druckdatei ansehen'
        : state.status === 'loading' ? 'Produktvorschau wird erstellt…'
          : state.status === 'completed' ? 'Produktvorschau ansehen' : 'Produktvorschau erstellen');
    }

    function addSurfaceButton(key, label, params, select) {
      const button = document.createElement('button');
      button.type = 'button';
      button.dataset.surface = key;
      i18n.setText(button, label, params);
      button.addEventListener('click', select);
      surfaces.appendChild(button);
    }

    function showPrint() {
      mode = 'print';
      surfaces.replaceChildren();
      const printSurfaces = configuration.product.printSurfaces.filter(surface => configuration.printPreviewUrls?.[surface.key]);
      surfaces.hidden = printSurfaces.length < 2;
      for (const surface of printSurfaces) {
        addSurfaceButton(surface.key, surface.label, {}, () => chooseSurface(surface.key));
      }
      updateMockupButton();
      chooseSurface(printSurfaces[0].key);
    }

    function showMockups(result) {
      mode = 'mockup';
      mockupResult = result;
      surfaces.replaceChildren();
      surfaces.hidden = result.urls.length < 2;
      result.urls.forEach((url, index) => {
        const key = `mockup:${index}`;
        addSurfaceButton(key, 'Ansicht {{number}}', { number: index + 1 }, () => chooseImage(key, url));
      });
      mockupStatus.hidden = true;
      updateMockupButton();
      chooseImage('mockup:0', result.urls[0]);
    }

    function showMockupError(error) {
      mockupStatus.hidden = false;
      i18n.setText(mockupStatus, error?.retryAfter
        ? 'Momentan ist viel los. Bitte versucht es in etwa {{seconds}} Sekunden erneut.'
        : 'Die Produktvorschau ist gerade nicht verfügbar. Bitte versucht es erneut.',
      { seconds: error?.retryAfter });
      updateMockupButton();
      fitPrintArea();
    }

    async function loadMockups() {
      const activeGeneration = generation;
      const pending = mockups.load(configuration.mockupUrl);
      mockupStatus.hidden = true;
      updateMockupButton();
      fitPrintArea();
      try {
        const result = await pending;
        if (dialog.open && generation === activeGeneration) showMockups(result);
      } catch (error) {
        if (dialog.open && generation === activeGeneration) showMockupError(error);
      }
    }

    function release() {
      document.documentElement.style.overflow = previousOverflow;
      images.clear();
      artwork.replaceChildren();
      viewport.style.removeProperty('height');
      generation++;
      mockupResult = null;
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
    mockupButton.addEventListener('click', () => {
      if (mode === 'mockup') showPrint();
      else if (mockupResult && mockups.get(configuration.mockupUrl).status === 'completed') showMockups(mockupResult);
      else void loadMockups();
    });
    browser.addEventListener('resize', fitPrintArea);
    browser.addEventListener('wolkenworte:localechange', fitPrintArea);

    return Object.freeze({
      open(item, trigger) {
        const printSurfaces = item.product.printSurfaces.filter(surface => item.printPreviewUrls?.[surface.key]);
        if (!printSurfaces.length) return;
        configuration = item;
        generation++;
        mode = 'print';
        mockupResult = null;
        mockupStatus.hidden = true;
        opener = trigger;
        images.clear();
        i18n.setText(title, item.product.displayName);
        if (!dialog.open) {
          previousOverflow = document.documentElement.style.overflow;
          dialog.showModal();
          document.documentElement.style.overflow = 'hidden';
        }
        showPrint();
        if (item.mockupUrl && mockups.get(item.mockupUrl).status === 'loading') void loadMockups();
      },
    });
  }

  return Object.freeze({ create });
});
