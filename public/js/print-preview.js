(function (root, factory) {
  'use strict';

  const api = factory(typeof module === 'object' && module.exports
    ? require('./product-mockup-preview') : root.WolkenworteProductMockups,
    typeof module === 'object' && module.exports ? require('./cart-product-preview') : root.WolkenworteCartProductPreview);
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.WolkenwortePrintPreview = api;
})(typeof window !== 'undefined' ? window : globalThis, function (Mockups, Products) {
  'use strict';

  function visibleArtworkBounds({ data, width, height }) {
    let left = width, top = height, right = -1, bottom = -1;
    for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
      if (data[(y * width + x) * 4 + 3] === 0) continue;
      left = Math.min(left, x); top = Math.min(top, y);
      right = Math.max(right, x); bottom = Math.max(bottom, y);
    }
    if (right < left || bottom < top) return null;
    const padding = Math.max(right - left + 1, bottom - top + 1) * .04 + 2;
    const x = Math.max(0, left - padding), y = Math.max(0, top - padding);
    return [x / width, y / height,
      (Math.min(width, right + 1 + padding) - x) / width,
      (Math.min(height, bottom + 1 + padding) - y) / height];
  }

  function create(dialog, { window: browser = window, i18n = browser.WolkenworteI18n,
    mockups = Mockups.create({ window: browser }), allowMockups = false, render3D = Products.render3D,
    renderPhoto = Products.renderPhoto,
  } = {}) {
    const document = dialog.ownerDocument;
    const query = selector => dialog.querySelector(selector);
    const title = query('[data-preview-title]');
    const detail = query('[data-preview-detail]');
    const description = query('[data-preview-description]');
    const surfaces = query('[data-preview-surfaces]');
    const views = query('[data-preview-views]');
    const photoNavigation = query('[data-preview-photo-navigation]');
    const photoThumbnails = query('[data-preview-photo-thumbnails]');
    const caption = query('[data-preview-caption]');
    const expand = query('[data-preview-expand]');
    const printFit = query('[data-preview-print-fit]');
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
    let activeView = '';
    let photoIndex = 0;
    let productPhotos = [];
    let fullPrintArea = false;

    function measureArtwork(image) {
      try {
        const canvas = document.createElement('canvas');
        const scale = Math.min(1, 1024 / Math.max(image.naturalWidth, image.naturalHeight));
        canvas.width = Math.max(1, Math.round(image.naturalWidth * scale));
        canvas.height = Math.max(1, Math.round(image.naturalHeight * scale));
        const context = canvas.getContext('2d');
        context.drawImage(image, 0, 0, canvas.width, canvas.height);
        const frame = visibleArtworkBounds(context.getImageData(0, 0, canvas.width, canvas.height));
        canvas.width = canvas.height = 1;
        return frame;
      } catch { return null; }
    }

    function localizePhotos() {
      for (const [index, button] of [...photoThumbnails.children].entries()) button.setAttribute('aria-label',
        i18n.t('Produktfoto {{number}}: {{view}}', { number: index + 1, view: i18n.t(productPhotos[index].label) }));
      if (panels.photo.entry) panels.photo.entry.image.alt =
        `${i18n.t(configuration.product.displayName)} · ${i18n.t(productPhotos[photoIndex].label)}`;
    }

    function updateCaption() {
      if (activeView === 'photo') i18n.setText(caption, '{{number}} von {{total}} · {{view}}', {
        number: photoIndex + 1, total: productPhotos.length, view: i18n.t(productPhotos[photoIndex]?.label || 'Produktfoto'),
      });
      else i18n.setText(caption, activeView === 'model'
        ? Products.isPhoto(configuration.product) ? 'Produktvorschau' : 'Ziehen oder Pfeiltasten zum Drehen'
        : fullPrintArea ? 'Druckfläche' : 'Dein Design');
    }

    function choosePhoto(index, reload = false) {
      if (!productPhotos.length) return;
      photoIndex = (index + productPhotos.length) % productPhotos.length;
      for (const [i, button] of [...photoThumbnails.children].entries()) {
        button.setAttribute('aria-pressed', String(i === photoIndex));
        if (i === photoIndex && activeView === 'photo') button.scrollIntoView?.({ block: 'nearest', inline: 'nearest' });
      }
      chooseImage(panels.photo, `photo:${photoIndex}`, productPhotos[photoIndex].src, reload, productPhotos[photoIndex].frame);
      panels.photo.entry.image.alt = `${i18n.t(configuration.product.displayName)} · ${i18n.t(productPhotos[photoIndex].label)}`;
      updateCaption();
    }

    function chooseView(key) {
      activeView = key;
      for (const button of views.children) {
        const selected = button.dataset.previewView === key;
        button.setAttribute('aria-selected', String(selected));
        button.tabIndex = selected ? 0 : -1;
      }
      query('[data-preview-photo-card]').hidden = key !== 'photo';
      query('[data-preview-print-card]').hidden = key !== 'print';
      modelCard.hidden = key !== 'model';
      photoNavigation.hidden = key !== 'photo' || productPhotos.length < 2;
      updateCaption();
      if (key === 'model' && !viewer && !modelHost.children.length) void showModel();
      fitPreviews();
    }

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
        const availableWidth = panel.artwork.clientWidth || panel.viewport.clientWidth;
        const availableHeight = panel.artwork.clientHeight || panel.viewport.clientHeight;
        if (!availableWidth || !availableHeight) continue;
        if ((panel === panels.photo || panel === panels.print && !fullPrintArea) && entry.frame) {
          const [left, top, frameWidth, frameHeight] = entry.frame;
          const scale = Math.min(availableWidth / (width * frameWidth), availableHeight / (height * frameHeight));
          Object.assign(entry.image.style, { position: 'absolute', maxWidth: 'none', maxHeight: 'none',
            width: `${width * scale}px`, height: `${height * scale}px`,
            left: `${(availableWidth - width * frameWidth * scale) / 2 - left * width * scale}px`,
            top: `${(availableHeight - height * frameHeight * scale) / 2 - top * height * scale}px`,
          });
          continue;
        }
        Object.assign(entry.image.style, { position: '', maxWidth: '100%', maxHeight: '100%', left: '', top: '' });
        const scale = Math.min(availableWidth / width, availableHeight / height);
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

    function chooseImage(panel, key, url, reload = false, frame = null) {
      let entry = images.get(key);
      if (!entry || reload) {
        const image = document.createElement('img');
        image.alt = '';
        image.decoding = 'async';
        entry = { image, state: 'loading', frame };
        images.set(key, entry);
        image.addEventListener('load', () => {
          entry.state = 'loaded';
          if (panel === panels.print && dialog.open && panel.entry === entry) {
            entry.frame = measureArtwork(image);
            entry.boundsMeasured = true;
          }
          showState(panel, entry);
        });
        image.addEventListener('error', () => { entry.state = 'error'; showState(panel, entry); });
        image.src = url;
      }
      panel.entry = entry;
      if (panel === panels.print && entry.state === 'loaded' && !entry.boundsMeasured) {
        entry.frame = measureArtwork(entry.image);
        entry.boundsMeasured = true;
      }
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
      i18n.setText(modelStatus, Products.isPhoto(configuration.product)
        ? 'Diese Vorschau konnte nicht geladen werden. Bitte versucht es erneut.'
        : 'Die 3D-Vorschau ist gerade nicht verfügbar. Euer Design bleibt erhalten.');
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
      const photoPreview = Products.isPhoto(configuration.product);
      i18n.setText(modelStatus, photoPreview ? 'Eure Produktvorschau wird vorbereitet…' : '3D-Vorschau wird geladen…');
      const host = document.createElement('div');
      host.className = 'print-preview-model-stage';
      host.tabIndex = photoPreview ? -1 : 0;
      host.classList.toggle('is-photo', photoPreview);
      host.setAttribute('aria-label', i18n.t(photoPreview ? 'Produktvorschau' : 'Interaktive 3D-Vorschau. Ziehen oder Pfeiltasten zum Drehen.'));
      modelHost.append(host);
      const current = () => dialog.open && generation === activeGeneration && modelGeneration === activeModel;
      try {
        const render = photoPreview ? renderPhoto : render3D;
        const rendered = await render({ host, item: configuration, window: browser,
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
      const message = Mockups.statusMessage({ status: 'error', errorCode: error?.errorCode });
      i18n.setText(mockupStatus, message.source, message.params);
      updateMockupButton();
    }

    mockups.subscribe?.((endpoint, state) => {
      if (!dialog.open || endpoint !== configuration?.mockupUrl || state.status !== 'loading') return;
      const message = Mockups.statusMessage(state);
      mockupStatus.hidden = false;
      i18n.setText(mockupStatus, message.source, message.params);
      updateMockupButton();
    });

    async function loadMockups() {
      if (!allowMockups || !configuration?.mockupUrl) return;
      const activeGeneration = generation;
      mockupStatus.hidden = true;
      const pending = mockups.load(configuration.mockupUrl);
      updateMockupButton();
      try {
        const result = await pending;
        if (!dialog.open || generation !== activeGeneration) return;
        showMockups(result);
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
      photoThumbnails.replaceChildren();
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
    panels.photo.retry.addEventListener('click', () => choosePhoto(photoIndex, true));
    for (const button of views.children) button.addEventListener('click', () => chooseView(button.dataset.previewView));
    views.addEventListener('keydown', event => {
      if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
      const buttons = [...views.children].filter(button => !button.hidden);
      const index = buttons.indexOf(document.activeElement);
      if (index < 0) return;
      event.preventDefault();
      const next = event.key === 'Home' ? 0 : event.key === 'End' ? buttons.length - 1 :
        (index + (event.key === 'ArrowRight' ? 1 : -1) + buttons.length) % buttons.length;
      chooseView(buttons[next].dataset.previewView);
      buttons[next].focus();
    });
    photoThumbnails.addEventListener('keydown', event => {
      if (!['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Home', 'End'].includes(event.key)) return;
      event.preventDefault();
      choosePhoto(event.key === 'Home' ? 0 : event.key === 'End' ? productPhotos.length - 1 :
        photoIndex + (['ArrowRight', 'ArrowDown'].includes(event.key) ? 1 : -1));
      photoThumbnails.children[photoIndex]?.focus();
    });
    expand.addEventListener('click', () => {
      const expanded = dialog.classList.toggle('is-expanded');
      expand.setAttribute('aria-pressed', String(expanded));
      expand.setAttribute('aria-label', i18n.t(expanded ? 'Ansicht verkleinern' : 'Ansicht vergrößern'));
      fitPreviews();
    });
    printFit.addEventListener('click', () => {
      fullPrintArea = !fullPrintArea;
      printFit.setAttribute('aria-pressed', String(fullPrintArea));
      updateCaption();
      fitPreviews();
    });
    modelRetry.addEventListener('click', () => void showModel());
    mockupButton.addEventListener('click', () => { void loadMockups(); });
    browser.addEventListener('resize', fitPreviews);
    browser.addEventListener('wolkenworte:localechange', () => {
      if (configuration) {
        detail.textContent = Products.variant(configuration.product, i18n);
        showDescription();
        updateCaption();
        localizePhotos();
        i18n.setText(query('[data-preview-view="model"]'), Products.isPhoto(configuration.product) ? 'Produktvorschau' : '3D-Ansicht');
        expand.setAttribute('aria-label', i18n.t(dialog.classList.contains('is-expanded') ? 'Ansicht verkleinern' : 'Ansicht vergrößern'));
      }
      fitPreviews();
    });

    return Object.freeze({
      close() { if (dialog.open) dialog.close(); },
      openPhotos(product, trigger) {
        this.open({ product, printPreviewUrls: {} }, trigger, { photoOnly: true });
      },
      open(item, trigger, { photoOnly = false } = {}) {
        const printSurfaces = item.product.printSurfaces.filter(surface => item.printPreviewUrls?.[surface.key]);
        if (!printSurfaces.length && !Products.photos(item.product).length) return;
        clearPreviews();
        configuration = item;
        opener = trigger;
        fullPrintArea = false;
        printFit.setAttribute('aria-pressed', 'false');
        dialog.classList.remove('is-expanded');
        expand.setAttribute('aria-pressed', 'false');
        expand.setAttribute('aria-label', i18n.t('Ansicht vergrößern'));
        i18n.setText(title, item.product.displayName);
        detail.textContent = Products.variant(item.product, i18n);
        showDescription();
        mockupStatus.hidden = true;
        surfaces.replaceChildren();
        surfaces.hidden = printSurfaces.length < 2;
        for (const surface of printSurfaces) addSurfaceButton(surfaces, surface.key, surface.label, {}, () => chooseSurface(surface.key));
        productPhotos = Products.photos(item.product);
        for (const [index, photo] of productPhotos.entries()) {
          const button = document.createElement('button');
          button.type = 'button';
          button.setAttribute('aria-label', i18n.t('Produktfoto {{number}}: {{view}}', {
            number: index + 1, view: i18n.t(photo.label),
          }));
          const image = document.createElement('img');
          image.alt = ''; image.loading = 'lazy'; image.src = photo.src;
          button.append(image);
          button.addEventListener('click', () => choosePhoto(index));
          photoThumbnails.append(button);
        }
        query('[data-preview-view="photo"]').hidden = !productPhotos.length;
        query('[data-preview-view="print"]').hidden = !printSurfaces.length;
        const hasModel = !photoOnly && (Products.is3D(item.product) || Products.isPhoto(item.product)) && printSurfaces.length > 0;
        i18n.setText(query('[data-preview-view="model"]'), Products.isPhoto(item.product) ? 'Produktvorschau' : '3D-Ansicht');
        query('[data-preview-view="model"]').hidden = !hasModel;
        updateMockupButton();
        if (!dialog.open) {
          dialog.showModal();
        }
        query('[data-preview-content]').scrollTop = 0;
        title.focus({ preventScroll: true });
        if (printSurfaces.length) chooseSurface(printSurfaces[0].key);
        if (productPhotos.length) choosePhoto(0);
        chooseView(hasModel ? 'model' : productPhotos.length ? 'photo' : 'print');
        // Only rejoin an already-running, explicitly requested job; the client
        // returns its existing promise without starting another generation.
        if (allowMockups && item.mockupUrl && mockups.get(item.mockupUrl).status === 'loading') void loadMockups();
      },
    });
  }
  return Object.freeze({ create, visibleArtworkBounds });
});
