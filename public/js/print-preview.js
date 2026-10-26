(function (root, factory) {
  'use strict';
  const api = factory(typeof module === 'object' && module.exports
    ? require('./product-mockup-preview') : root.WolkenworteProductMockups,
    typeof module === 'object' && module.exports ? require('./cart-product-preview') : root.WolkenworteCartProductPreview);
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.WolkenwortePrintPreview = api;
})(typeof window !== 'undefined' ? window : globalThis, function (Mockups, Products) {
  'use strict';

  function create(dialog, { window: browser = window, i18n = browser.WolkenworteI18n,
    mockups = Mockups.create({ window: browser }), allowMockups = false, render3D = Products.render3D,
  } = {}) {
    const document = dialog.ownerDocument;
    const query = selector => dialog.querySelector(selector);
    const title = query('[data-preview-title]');
    const detail = query('[data-preview-detail]');
    const description = query('[data-preview-description]');
    const surfaces = query('[data-preview-surfaces]');
    const modelCard = query('[data-preview-model-card]');
    const modelHost = query('[data-preview-model]');
    const modelFeedback = query('[data-preview-model-feedback]');
    const modelStatus = query('[data-preview-model-status]');
    const modelRetry = query('[data-preview-model-retry]');
    const mockupActions = query('[data-preview-mockup-actions]');
    const mockupButton = query('[data-preview-mockup]');
    const mockupStatus = query('[data-preview-mockup-status]');
    const mockupCard = query('[data-preview-mockup-card]');
    const mockupSurfaces = query('[data-preview-mockup-surfaces]');
    const panels = {
      print: { viewport: query('[data-preview-viewport]'), artwork: query('[data-preview-artwork]'),
        feedback: query('[data-preview-feedback]'), status: query('[data-preview-status]'), retry: query('[data-preview-retry]') },
      photo: { viewport: query('[data-preview-photo]'), artwork: query('[data-preview-photo-artwork]'),
        feedback: query('[data-preview-photo-feedback]'), status: query('[data-preview-photo-status]'), retry: query('[data-preview-photo-retry]') },
      mockup: { viewport: query('[data-preview-mockup-viewport]'), artwork: query('[data-preview-mockup-artwork]'),
        feedback: query('[data-preview-generated-feedback]'), status: query('[data-preview-generated-status]') },
    };
    const images = new Map();
    let configuration = null;
    let surfaceKey = '';
    let opener = null;
    let generation = 0;
    let modelGeneration = 0;
    let viewer = null;

    function showDescription() {
      const locale = i18n.getLocale?.() || 'de';
      const text = configuration.product.information?.[locale] ||
        configuration.product.information?.de || i18n.t(configuration.product.description || '');
      description.replaceChildren();
      let list = null;
      for (const line of text.split('\n').map(line => line.trim())) {
        if (!line) { list = null; continue; }
        if (/^[•-]\s/.test(line)) {
          if (!list) { list = document.createElement('ul'); description.append(list); }
          const item = document.createElement('li');
          item.textContent = line.replace(/^[•-]\s+/, '');
          list.append(item);
        } else {
          list = null;
          const paragraph = document.createElement('p');
          paragraph.textContent = line;
          description.append(paragraph);
        }
      }
      description.scrollTop = 0;
    }

    function fitPreviews() {
      if (!dialog.open) return;
      for (const panel of Object.values(panels)) {
        const entry = panel.entry;
        if (entry?.state !== 'loaded') continue;
        const { naturalWidth: width, naturalHeight: height } = entry.image;
        if (!(width > 0 && height > 0)) continue;
        const scale = Math.min(panel.viewport.clientWidth / width, panel.viewport.clientHeight / height, 1);
        entry.image.style.width = `${width * scale}px`;
        entry.image.style.height = `${height * scale}px`;
      }
      viewer?.resize();
    }

    function showState(panel, entry) {
      if (!dialog.open || panel.entry !== entry) return;
      if (panel === panels.mockup && entry.state === 'error') {
        mockups.invalidate(configuration.mockupUrl);
        mockupCard.hidden = true;
        for (const key of images.keys()) if (key.startsWith('mockup:')) images.delete(key);
        showMockupError();
        return;
      }
      const loaded = entry.state === 'loaded';
      panel.artwork.hidden = !loaded;
      panel.viewport.setAttribute('aria-busy', String(entry.state === 'loading'));
      if (panel.feedback) {
        panel.feedback.hidden = loaded;
        if (panel.retry) panel.retry.hidden = entry.state !== 'error';
        i18n.setText(panel.status, entry.state === 'error'
          ? 'Diese Vorschau konnte nicht geladen werden. Bitte versucht es erneut.'
          : panel === panels.print ? 'Druckvorschau wird geladen…' : 'Produktvorschau wird geladen…');
      }
      fitPreviews();
    }

    function chooseImage(panel, key, url, reload = false) {
      let entry = images.get(key);
      if (!entry || reload) {
        const image = document.createElement('img');
        image.alt = '';
        image.decoding = 'async';
        entry = { image, state: 'loading' };
        images.set(key, entry);
        image.addEventListener('load', () => { entry.state = 'loaded'; showState(panel, entry); });
        image.addEventListener('error', () => { entry.state = 'error'; showState(panel, entry); });
        image.src = url;
      }
      panel.entry = entry;
      panel.artwork.replaceChildren(entry.image);
      showState(panel, entry);
    }

    function chooseSurface(key, reload = false) {
      if (!configuration?.printPreviewUrls?.[key]) return;
      surfaceKey = key;
      for (const button of surfaces.children) button.setAttribute('aria-pressed', String(button.dataset.surface === key));
      chooseImage(panels.print, key, configuration.printPreviewUrls[key], reload);
    }

    function addSurfaceButton(parent, key, label, params, select) {
      const button = document.createElement('button');
      button.type = 'button';
      button.dataset.surface = key;
      i18n.setText(button, label, params);
      button.addEventListener('click', select);
      parent.appendChild(button);
    }

    function modelError() {
      modelFeedback.hidden = false;
      modelRetry.hidden = false;
      modelHost.setAttribute('aria-busy', 'false');
      i18n.setText(modelStatus, 'Die 3D-Vorschau ist gerade nicht verfügbar. Euer Design bleibt erhalten.');
    }

    async function showModel() {
      const activeModel = ++modelGeneration;
      const activeGeneration = generation;
      viewer?.destroy();
      viewer = null;
      modelHost.replaceChildren();
      modelFeedback.hidden = false;
      modelRetry.hidden = true;
      modelHost.setAttribute('aria-busy', 'true');
      i18n.setText(modelStatus, '3D-Vorschau wird geladen…');
      const host = document.createElement('div');
      host.className = 'print-preview-model-stage';
      host.tabIndex = 0;
      host.setAttribute('aria-label', i18n.t('Interaktive 3D-Vorschau. Ziehen oder Pfeiltasten zum Drehen.'));
      modelHost.append(host);
      const current = () => dialog.open && generation === activeGeneration && modelGeneration === activeModel;
      try {
        const rendered = await render3D({ host, item: configuration, window: browser,
          onStatus: state => { if (state === 'error' && current()) modelError(); },
        });
        if (!current()) { rendered.destroy(); return; }
        viewer = rendered;
        modelFeedback.hidden = true;
        modelHost.setAttribute('aria-busy', 'false');
        fitPreviews();
      } catch { if (current()) modelError(); }
    }

    function updateMockupButton() {
      mockupActions.hidden = !allowMockups || !configuration?.mockupUrl;
      if (mockupActions.hidden) return;
      const state = mockups.get(configuration.mockupUrl);
      mockupButton.disabled = state.status === 'loading';
      i18n.setText(mockupButton, state.status === 'loading' ? 'Produktvorschau wird erstellt…'
        : state.status === 'completed' ? 'Produktvorschau ansehen' : 'Produktvorschau erstellen');
    }

    function showMockups(result) {
      mockupCard.hidden = false;
      mockupSurfaces.replaceChildren();
      mockupSurfaces.hidden = result.urls.length < 2;
      const choose = index => {
        const key = `mockup:${index}`;
        for (const button of mockupSurfaces.children) button.setAttribute('aria-pressed', String(button.dataset.surface === key));
        chooseImage(panels.mockup, key, result.urls[index]);
      };
      result.urls.forEach((url, index) => addSurfaceButton(mockupSurfaces, `mockup:${index}`,
        'Ansicht {{number}}', { number: index + 1 }, () => choose(index)));
      mockupStatus.hidden = true;
      updateMockupButton();
      choose(0);
      mockupCard.scrollIntoView?.({ block: 'nearest' });
    }

    function showMockupError(error) {
      mockupStatus.hidden = false;
      i18n.setText(mockupStatus, error?.retryAfter
        ? 'Momentan ist viel los. Bitte versucht es in etwa {{seconds}} Sekunden erneut.'
        : 'Die Produktvorschau ist gerade nicht verfügbar. Bitte versucht es erneut.', { seconds: error?.retryAfter });
      updateMockupButton();
    }

    async function loadMockups({ rejoin = false } = {}) {
      if (!allowMockups || !configuration?.mockupUrl) return;
      const activeGeneration = generation;
      const pending = mockups.load(configuration.mockupUrl);
      mockupStatus.hidden = true;
      updateMockupButton();
      try {
        const result = await pending;
        if (!dialog.open || generation !== activeGeneration) return;
        if (!rejoin) showMockups(result);
        else updateMockupButton();
      } catch (error) {
        if (dialog.open && generation === activeGeneration) showMockupError(error);
      }
    }

    function clearPreviews() {
      generation++;
      modelGeneration++;
      viewer?.destroy();
      viewer = null;
      modelHost.replaceChildren();
      images.clear();
      for (const panel of Object.values(panels)) {
        panel.entry = null;
        panel.artwork.replaceChildren();
      }
      mockupCard.hidden = true;
    }

    query('[data-preview-close]').addEventListener('click', () => dialog.close());
    dialog.addEventListener('close', () => {
      clearPreviews();
      configuration = null;
      opener?.focus({ preventScroll: true });
      opener = null;
    });
    dialog.addEventListener('click', event => {
      if (event.target !== dialog) return;
      const bounds = dialog.getBoundingClientRect();
      if (event.clientX < bounds.left || event.clientX > bounds.right ||
          event.clientY < bounds.top || event.clientY > bounds.bottom) dialog.close();
    });
    panels.print.retry.addEventListener('click', () => chooseSurface(surfaceKey, true));
    panels.photo.retry.addEventListener('click', () => chooseImage(panels.photo, 'photo', Products.photo(configuration.product), true));
    modelRetry.addEventListener('click', () => void showModel());
    mockupButton.addEventListener('click', () => { void loadMockups(); });
    browser.addEventListener('resize', fitPreviews);
    browser.addEventListener('wolkenworte:localechange', () => {
      if (configuration) {
        detail.textContent = Products.variant(configuration.product, i18n);
        showDescription();
      }
      fitPreviews();
    });

    return Object.freeze({
      close() { if (dialog.open) dialog.close(); },
      open(item, trigger) {
        const printSurfaces = item.product.printSurfaces.filter(surface => item.printPreviewUrls?.[surface.key]);
        if (!printSurfaces.length) return;
        clearPreviews();
        configuration = item;
        opener = trigger;
        i18n.setText(title, item.product.displayName);
        detail.textContent = Products.variant(item.product, i18n);
        showDescription();
        mockupStatus.hidden = true;
        surfaces.replaceChildren();
        surfaces.hidden = printSurfaces.length < 2;
        for (const surface of printSurfaces) addSurfaceButton(surfaces, surface.key, surface.label, {}, () => chooseSurface(surface.key));
        query('[data-preview-photo-card]').hidden = !Products.photo(item.product);
        modelCard.hidden = !Products.is3D(item.product);
        updateMockupButton();
        if (!dialog.open) {
          dialog.showModal();
        }
        query('[data-preview-content]').scrollTop = 0;
        title.focus({ preventScroll: true });
        chooseSurface(printSurfaces[0].key);
        if (Products.photo(item.product)) chooseImage(panels.photo, 'photo', Products.photo(item.product));
        if (!modelCard.hidden) void showModel();
        // Only rejoin an already-running, explicitly requested job; the client
        // returns its existing promise without starting another generation.
        if (allowMockups && item.mockupUrl && mockups.get(item.mockupUrl).status === 'loading') void loadMockups({ rejoin: true });
      },
    });
  }
  return Object.freeze({ create });
});
