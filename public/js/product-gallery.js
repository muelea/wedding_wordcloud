(function (root, factory) {
  'use strict';
  const api = factory(typeof module === 'object' && module.exports
    ? require('./print-layout-client') : root.PrintLayoutClient,
    typeof module === 'object' && module.exports ? require('./text-print-quality') : root.TextPrintQuality);
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.WolkenworteProductGallery = api;
})(typeof window !== 'undefined' ? window : globalThis, function (LayoutClient, TextPrintQuality) {
  'use strict';

  const copy = value => JSON.parse(JSON.stringify(value));
  const CATEGORIES = Object.freeze([
    ['all', 'Alle'], ['mug', 'Tassen'], ['poster', 'Poster'], ['coaster', 'Untersetzer'],
    ['drinkware', 'Trinkflaschen & Becher'], ['tech', 'Technik & Zubehör'], ['canvas', 'Leinwände'],
    ['tote', 'Taschen'], ['clothing', 'Kleidung'], ['blanket', 'Decken'], ['pillow', 'Kissen'], ['notebook', 'Notizbücher'],
  ]);
  const is3D = product => ['mug', '3d'].includes(product.previewType);
  const referencePhoto = product => product.productPhoto || product.previewMockup?.assets?.default ||
    product.previewMockup?.assets?.front || Object.values(product.previewMockup?.assets || {})[0] || '';
  const categoryFor = product => product.familyKey === 'clothing' ? 'clothing' : product.familyKey === 'bags' ? 'tote' : product.familyKey === 'tech' ? 'tech' : product.familyKey === 'drinkware' ? 'drinkware' : product.catalogGroup === 'colored-mug' ? 'mug' : product.previewType === 'mug' ? 'mug'
    : product.previewShape === 'framed-poster' ? 'poster' : product.previewShape;

  function printPrecision(designs) {
    // Match MugPrintEditor.getDesign's persisted tenth-pixel coordinates before
    // painting a preview. The optimizer can return finer fractional font sizes.
    return Object.fromEntries(Object.entries(designs).map(([side, design]) => [side, design.map(item => {
      const result = { ...item };
      for (const key of ['x', 'y', 'angle', 'fontSize', 'layoutFontSize', 'size', 'width', 'height']) {
        if (Number.isFinite(result[key])) result[key] = Math.round(result[key] * 10) / 10;
      }
      return result;
    })]));
  }

  function shouldOpen({ directDesign, words, query, draft }) {
    return !directDesign && words.length > 0 &&
      !['edit', 'cart', 'accountDesign'].some(key => query.has(key)) &&
      (query.get('view') === 'products' || (!draft && !query.has('draft')));
  }

  function groupProducts(products) {
    const groups = new Map();
    for (const product of products) {
      const key = product.catalogGroup || (product.previewType === 'mug' ? 'mug' : product.previewShape);
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(product);
    }
    return [...groups.values()];
  }

  class Gallery {
    constructor({ element, products, prepare, getView, configureFlat, paintFlat, createMug, renderArtwork, preview, onChoose, onAdd, isInCart, i18n }) {
      Object.assign(this, { element, prepareDesign: prepare, getView, configureFlat, paintFlat, createMug, renderArtwork, preview, onChoose, onAdd, isInCart, i18n });
      this.document = element.ownerDocument;
      this.window = this.document.defaultView;
      this.controller = new this.window.AbortController();
      this.entries = new Map();
      this.cards = [];
      this.category = 'all';
      this.preparationQueue = LayoutClient.createQueue({ limit: products.length,
        concurrency: LayoutClient.parallelism(this.window.navigator?.hardwareConcurrency),
        warmup: true,
        yieldControl: () => new Promise(resolve => this.window.setTimeout(resolve, 0)),
        priority: key => {
          const card = this.cards.find(card => card.product.key === key);
          return !card || card.element.hidden ? -100 : card.visible ? 50 : 0;
        },
      });
      Object.defineProperty(this, 'queue', { get: () => this.preparationQueue.idle() });
      this.destroyed = false;
      this.suspended = false;
      this.choosing = false;
      this.frame = null;
      this.scrolling = false;
      this.scrollTimer = null;
      this.viewSequence = 0;
      this.previewQueue = new Set();
      this.previewTurn = null;
      this.previewActive = null;
      this.requestPreviewTurn = callback => this.window.requestIdleCallback
        ? this.window.requestIdleCallback(callback, { timeout: 1000 }) : this.window.setTimeout(callback, 50);
      this.cancelPreviewTurn = id => this.window.requestIdleCallback
        ? this.window.cancelIdleCallback(id) : this.window.clearTimeout(id);
      this.buildPhotoDialog();
      this.buildVariantDialog();
      this.buildPriceInfo();
      this.resizeObserver = this.window.ResizeObserver ? new this.window.ResizeObserver(entries =>
        this.resize(entries.map(entry => this.cards.find(card => card.stage === entry.target)).filter(Boolean))) : null;
      this.intersectionObserver = this.window.IntersectionObserver ? new this.window.IntersectionObserver(entries => {
        const changed = [];
        for (const entry of entries) {
          const card = this.cards.find(card => card.stage === entry.target);
          if (card) {
            card.visible = entry.isIntersecting;
            if (!card.visible) {
              this.previewQueue.delete(card);
              if (this.previewActive?.card === card && card.viewer?.loading) {
                card.viewer.destroy(); card.viewer = null; this.previewActive = null;
              }
            }
            changed.push(card);
          }
        }
        changed.filter(card => card.visible).forEach(card => this.render(card));
      }) : null;
      const grid = element.querySelector('[data-gallery-grid]');
      this.filters = element.querySelector('[data-gallery-filters]');
      if (this.filters) {
        this.filters.replaceChildren();
        for (const [key, label] of CATEGORIES) {
          const filter = this.node('button', '', this.filters);
          filter.type = 'button';
          filter.dataset.category = key;
          this.i18n.setText(filter, label);
          filter.setAttribute('aria-pressed', String(key === this.category));
          this.listen(filter, 'click', () => this.filter(key));
        }
      }
      grid.replaceChildren();
      for (const variants of groupProducts(products)) {
        const card = this.buildCard(variants);
        this.cards.push(card);
        grid.appendChild(card.element);
        this.resizeObserver?.observe(card.stage);
        this.intersectionObserver?.observe(card.stage);
        void this.load(card, variants[0], false);
      }
      this.listen(this.window, 'resize', () => this.resize());
      const scrolling = () => {
        if (this.destroyed || this.suspended) return;
        this.scrolling = true;
        if (this.previewTurn !== null) this.cancelPreviewTurn(this.previewTurn);
        this.previewTurn = null;
        this.window.clearTimeout(this.scrollTimer);
        this.scrollTimer = this.window.setTimeout(() => {
          this.scrolling = false;
          this.resize();
        }, 350);
      };
      this.listen(this.window, 'scroll', scrolling, { passive: true });
      this.listen(this.window, 'wheel', scrolling, { passive: true });
      this.listen(this.window, 'touchmove', scrolling, { passive: true });
    }

    listen(element, event, callback, options = {}) {
      element.addEventListener(event, callback, { ...options, signal: this.controller.signal });
    }

    node(tag, className, parent) {
      const element = this.document.createElement(tag);
      element.className = className;
      parent?.appendChild(element);
      return element;
    }

    buildPhotoDialog() {
      const dialog = this.node('dialog', 'product-photo-dialog', this.document.body);
      dialog.id = 'product-gallery-photo-dialog';
      const header = this.node('div', 'product-photo-dialog-head', dialog);
      const title = this.node('h2', '', header);
      title.id = 'product-gallery-photo-title';
      title.tabIndex = -1;
      dialog.setAttribute('aria-labelledby', title.id);
      const close = this.node('button', 'ww-icon-button ww-close-button', header);
      close.type = 'button';
      this.i18n.setAttribute(close, 'aria-label', 'Schließen');
      const photo = this.node('img', 'product-photo-dialog-image', dialog);
      photo.alt = '';
      this.photoDialog = { dialog, title, photo };
      this.listen(close, 'click', () => dialog.close());
      this.listen(dialog, 'click', event => {
        const rect = dialog.getBoundingClientRect();
        if (event.target === dialog && (event.clientX < rect.left || event.clientX > rect.right ||
          event.clientY < rect.top || event.clientY > rect.bottom)) dialog.close();
      });
      this.listen(dialog, 'close', () => {
        const card = this.photoCard;
        const opener = this.photoOpener;
        this.photoCard = null;
        this.photoProduct = this.photoOpener = null;
        if (card && !this.destroyed && !this.suspended) (opener || card.photoButton).focus({ preventScroll: true });
      });
    }

    localizePhoto() {
      const product = this.photoProduct;
      const values = { product: this.i18n.t(product.displayName), size: this.i18n.t(product.size.label) };
      this.photoDialog.title.textContent = `${values.product} · ${values.size}`;
      this.i18n.setAttribute(this.photoDialog.photo, 'alt', 'Produktfoto: {{product}}, {{size}}', values);
    }

    openPhoto(card, product = card.product, opener = card.photoButton) {
      if (this.destroyed || this.suspended || !referencePhoto(product) || card.element.hidden) return;
      this.closePriceInfo();
      this.photoCard = card;
      this.photoProduct = product;
      this.photoOpener = opener;
      this.photoDialog.photo.src = referencePhoto(product);
      this.photoDialog.photo.style.objectFit = product.productPhotoFit || 'contain';
      this.photoDialog.photo.style.objectPosition = product.productPhotoPosition || 'center';
      this.localizePhoto();
      if (!this.photoDialog.dialog.open) {
        this.photoDialog.dialog.showModal();
        this.photoDialog.title.focus({ preventScroll: true });
      }
    }

    artwork(card, side) {
      return card.previewUrls[side] ||= this.renderArtwork(
        this.getView(card.product, card.snapshot.orientation), card.snapshot.designs[side], side);
    }

    openPreview(card) {
      if (!card.snapshot || this.destroyed || this.suspended || card.element.hidden || this.choosing) return;
      this.closePriceInfo();
      this.preview.open({ product: card.view, printPreviewUrls: Object.fromEntries(
        card.product.printSurfaces.map(side => [side.key, this.artwork(card, side.key)])),
      }, card.photoButton);
    }

    updateThumbnail(card) {
      if (!card.snapshot || card.thumbnailVersion === card.version) return;
      try {
        if (is3D(card.product)) {
          const source = card.viewer?.canvas;
          if (!source?.width || !source.height) return;
          card.viewer.render();
          const canvas = this.document.createElement('canvas');
          canvas.width = canvas.height = 200;
          const scale = Math.min(canvas.width / source.width, canvas.height / source.height);
          canvas.getContext('2d').drawImage(source, (canvas.width - source.width * scale) / 2,
            (canvas.height - source.height * scale) / 2, source.width * scale, source.height * scale);
          card.thumbnailUrl = canvas.toDataURL('image/png');
        } else card.thumbnailUrl = this.artwork(card, card.surface);
        card.photo.src = card.thumbnailUrl;
        card.thumbnailVersion = card.version;
      } catch { /* The matching reference photo remains available if rendering fails. */ }
    }

    priceFor(product) {
      const price = product.price;
      return !price ? '' : this.i18n.formatCurrency?.(price.unitGrossCents, price.currency) ||
        new Intl.NumberFormat(this.i18n.getLocale?.() || 'de', { style: 'currency', currency: price.currency }).format(price.unitGrossCents / 100);
    }

    buildPriceInfo() {
      const panel = this.node('div', 'product-gallery-price-info', this.document.body);
      panel.id = 'product-gallery-price-info';
      panel.setAttribute('role', 'note');
      panel.hidden = true;
      if (typeof panel.showPopover === 'function') panel.setAttribute('popover', 'auto');
      this.priceInfo = panel;
      this.listen(panel, 'toggle', event => {
        if (event.newState === 'closed') this.closePriceInfo();
      });
      this.listen(this.document, 'click', event => {
        if (this.priceCard && !panel.contains(event.target) && !this.priceCard.priceInfoButton.contains(event.target)) this.closePriceInfo();
      });
      this.listen(this.document, 'keydown', event => { if (event.key === 'Escape') this.closePriceInfo(); });
      this.listen(this.window, 'resize', () => this.closePriceInfo());
      this.listen(this.document, 'scroll', () => this.closePriceInfo(), { capture: true });
    }

    closePriceInfo() {
      if (this.priceCard) {
        this.priceCard.priceInfoButton.setAttribute('aria-expanded', 'false');
        this.priceCard.priceInfoButton.removeAttribute('aria-describedby');
        this.priceCard = null;
      }
      if (this.priceInfo.hasAttribute('popover') && this.priceInfo.matches(':popover-open')) this.priceInfo.hidePopover();
      this.priceInfo.hidden = true;
    }

    openPriceInfo(card) {
      const closing = this.priceCard === card;
      this.closePriceInfo();
      if (closing || this.destroyed || this.suspended || card.element.hidden || !card.product.price) return;
      this.priceCard = card;
      card.priceInfoButton.setAttribute('aria-expanded', 'true');
      card.priceInfoButton.setAttribute('aria-describedby', this.priceInfo.id);
      this.localizePriceInfo();
      this.priceInfo.hidden = false;
      if (this.priceInfo.hasAttribute('popover')) this.priceInfo.showPopover();
      const anchor = card.priceInfoButton.getBoundingClientRect(), panel = this.priceInfo.getBoundingClientRect();
      this.priceInfo.style.left = `${Math.max(12, Math.min(anchor.right - panel.width, this.window.innerWidth - panel.width - 12))}px`;
      this.priceInfo.style.top = `${Math.max(12, Math.min(anchor.bottom + 6, this.window.innerHeight - panel.height - 12))}px`;
    }

    localizePriceInfo() {
      if (!this.priceCard) return;
      this.i18n.setText(this.priceInfo, this.priceCard.product.price.germanDeliveryAvailable === false
        ? 'Nicht nach Deutschland lieferbar. Preise für andere Lieferländer können abweichen.'
        : 'Inkl. 19 % MwSt., zzgl. Versand. Preis für Deutschland; andere Lieferländer können abweichen.');
    }

    buildVariantDialog() {
      const dialog = this.node('dialog', 'product-variant-dialog', this.document.body);
      dialog.id = 'product-gallery-variants';
      const header = this.node('div', 'product-photo-dialog-head', dialog);
      const title = this.node('h2', '', header);
      title.id = 'product-gallery-variants-title';
      dialog.setAttribute('aria-labelledby', title.id);
      const close = this.node('button', 'ww-icon-button ww-close-button', header);
      close.type = 'button'; this.i18n.setAttribute(close, 'aria-label', 'Schließen');
      const list = this.node('div', 'product-variant-list', dialog);
      this.variantDialog = { dialog, title, list };
      this.listen(close, 'click', () => dialog.close());
      this.listen(dialog, 'click', event => {
        const rect = dialog.getBoundingClientRect();
        if (event.target === dialog && (event.clientX < rect.left || event.clientX > rect.right || event.clientY < rect.top || event.clientY > rect.bottom)) dialog.close();
      });
      this.listen(dialog, 'close', () => {
        const card = this.variantCard; this.variantCard = null;
        card?.variantToggle.setAttribute('aria-expanded', 'false');
        if (card && !this.suspended && !this.destroyed) card.variantToggle.focus({ preventScroll: true });
      });
      this.listen(list, 'keydown', event => {
        const choices = [...list.querySelectorAll('.product-variant-choice')];
        const index = choices.indexOf(this.document.activeElement);
        if (index < 0 || !['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return;
        event.preventDefault();
        choices[event.key === 'Home' ? 0 : event.key === 'End' ? choices.length - 1 :
          (index + (event.key === 'ArrowDown' ? 1 : -1) + choices.length) % choices.length].focus();
      });
      this.listen(this.window, 'resize', () => { if (dialog.open) this.positionVariants(); });
    }

    positionVariants() {
      if (!this.variantCard || this.window.innerWidth <= 620) return;
      const dialog = this.variantDialog.dialog, rect = this.variantCard.sizes.getBoundingClientRect();
      const width = Math.min(440, Math.max(320, rect.width), this.window.innerWidth - 24);
      dialog.style.width = `${width}px`;
      dialog.style.left = `${Math.max(12, Math.min(rect.left, this.window.innerWidth - width - 12))}px`;
      const below = this.window.innerHeight - rect.bottom - 20, above = rect.top - 20;
      const useBelow = below >= Math.min(360, above);
      dialog.style.maxHeight = `${Math.max(140, Math.min(520, useBelow ? below : above))}px`;
      const height = dialog.getBoundingClientRect().height;
      dialog.style.top = `${Math.max(12, useBelow ? rect.bottom + 8 : rect.top - height - 8)}px`;
    }

    openVariants(card) {
      this.closePriceInfo();
      if (this.destroyed || this.suspended || this.choosing || !card.variantToggle) return;
      const { dialog, title, list } = this.variantDialog;
      this.variantCard = card;
      title.textContent = `${this.i18n.t(card.product.displayName)} · ${this.i18n.t('Variante wählen')}`;
      list.replaceChildren();
      for (const product of card.variants) {
        const row = this.node('div', 'product-variant-row', list);
        const photo = this.node('button', 'product-variant-photo', row);
        photo.type = 'button'; photo.disabled = !referencePhoto(product);
        this.i18n.setAttribute(photo, 'aria-label', 'Produktfoto vergrößern: {{product}}, {{size}}', {
          product: this.i18n.t(product.displayName), size: this.i18n.t(product.variantLabel || product.size.label) });
        const image = this.node('img', '', photo); image.alt = ''; image.src = referencePhoto(product) || product.thumbnail;
        image.style.objectFit = 'contain'; image.loading = 'lazy';
        photo.addEventListener('click', () => this.openPhoto(card, product, photo));
        const choice = this.node('button', 'product-variant-choice', row);
        choice.type = 'button'; choice.dataset.productKey = product.key;
        choice.setAttribute('aria-pressed', String(card.product.key === product.key));
        this.node('strong', '', choice).textContent = this.i18n.t(product.variantLabel || product.size.label);
        this.node('span', '', choice).textContent = this.i18n.t(product.displayName);
        this.node('span', 'product-variant-price', choice).textContent = this.priceFor(product);
        choice.addEventListener('click', () => { dialog.close(); if (!this.choosing) void this.load(card, product); });
      }
      card.variantToggle.setAttribute('aria-expanded', 'true');
      if (!dialog.open) dialog.showModal();
      this.positionVariants();
      list.querySelector('[aria-pressed="true"]').focus({ preventScroll: true });
    }

    buildCard(variants) {
      const element = this.node('article', 'product-gallery-card');
      const preview = this.node('div', 'product-gallery-select', element);
      const stage = this.node('span', 'product-gallery-preview', preview);
      const host = this.node('span', 'mug-viewer product-gallery-mug', stage);
      host.tabIndex = 0;
      host.hidden = true;
      const flat = this.node('span', 'flat-product-preview', stage);
      const composite = this.node('span', 'flat-product-composite', flat);
      const canvas = this.node('canvas', '', composite);
      const image = this.node('img', 'flat-product-mockup', composite);
      image.alt = '';
      image.draggable = false;
      image.loading = 'lazy';
      const previousPreview = this.node('canvas', 'product-gallery-previous', stage);
      previousPreview.hidden = true;
      const details = this.node('div', 'product-gallery-details', element);
      const caption = this.node('div', 'product-gallery-caption', details);
      const name = this.node('strong', 'product-gallery-name', caption);
      const detail = this.node('span', 'product-gallery-detail', caption);
      const priceRow = this.node('div', 'product-gallery-price-row', caption);
      const price = this.node('strong', 'product-gallery-price', priceRow);
      price.setAttribute('data-i18n-ignore', '');
      const priceNote = this.node('small', 'product-gallery-price-note', priceRow);
      const priceInfoButton = this.node('button', 'product-gallery-price-info-button', priceRow);
      priceInfoButton.type = 'button';
      priceInfoButton.setAttribute('aria-controls', this.priceInfo.id);
      priceInfoButton.setAttribute('aria-expanded', 'false');
      this.i18n.setAttribute(priceInfoButton, 'aria-label', 'Preisinformationen');
      const infoIcon = this.node('span', '', priceInfoButton);
      infoIcon.textContent = 'ⓘ'; infoIcon.setAttribute('aria-hidden', 'true');
      const photoButton = this.node('button', 'product-gallery-photo-button cart-product-preview', details);
      photoButton.type = 'button';
      photoButton.hidden = true;
      photoButton.setAttribute('aria-haspopup', 'dialog');
      photoButton.setAttribute('aria-controls', 'print-preview');
      const photo = this.node('img', 'product-gallery-photo', photoButton);
      photo.hidden = true;
      photo.loading = 'lazy';
      photo.draggable = false;
      const zoom = this.node('span', 'cart-product-preview-eye ww-preview-eye', photoButton);
      zoom.setAttribute('aria-hidden', 'true');
      const sizes = this.node('div', 'product-gallery-sizes', details);
      sizes.setAttribute('role', 'group');
      this.i18n.setAttribute(sizes, 'aria-label', 'Produktdetails');
      sizes.appendChild(photoButton);
      const actions = this.node('div', 'product-gallery-actions', element);
      const add = this.node('button', 'primary-button product-gallery-add', actions);
      add.type = 'button';
      add.disabled = true;
      this.i18n.setText(add, 'In den Warenkorb');
      const customize = this.node('button', 'secondary-button product-gallery-customize', actions);
      customize.type = 'button';
      customize.disabled = true;
      this.i18n.setText(customize, 'Design anpassen');
      const status = this.node('p', 'product-gallery-status', element);
      status.setAttribute('role', 'status');
      const retry = this.node('button', 'product-gallery-retry', element);
      retry.type = 'button';
      retry.hidden = true;
      this.i18n.setText(retry, 'Erneut versuchen');
      const card = { element, preview, stage, host, flat, canvas, image, previousPreview, name, detail, priceRow, price, priceNote, priceInfoButton, details, photo, photoButton, customize, sizes, add, status, retry,
        variants, product: variants[0], snapshot: null, version: 0, viewer: null, visible: !this.intersectionObserver };
      const variantSummary = this.node(variants.length > 1 ? 'button' : 'div', 'product-gallery-variant-summary', sizes);
      card.variantLabel = this.node('span', '', variantSummary);
      if (variants.length > 1) {
        const toggle = variantSummary;
        toggle.classList.add('product-gallery-variant-toggle');
        toggle.type = 'button'; toggle.setAttribute('aria-haspopup', 'dialog');
        toggle.setAttribute('aria-controls', this.variantDialog.dialog.id); toggle.setAttribute('aria-expanded', 'false');
        this.i18n.setAttribute(toggle, 'aria-label', 'Variante wählen');
        card.variantToggle = toggle;
        this.node('span', 'product-variant-chevron', toggle).textContent = '⌄';
        this.listen(toggle, 'click', () => this.openVariants(card));
      }
      this.listen(add, 'click', () => { void this.add(card); });
      this.listen(priceInfoButton, 'click', () => this.openPriceInfo(card));
      this.listen(photoButton, 'click', () => this.openPreview(card));
      this.listen(customize, 'click', () => { void this.choose(card); });
      // A retained bitmap needs no model rebuild just because it reenters the
      // viewport. Capture runs before the viewer's target/bubble listeners, so
      // a deliberate first drag/key also reaches a newly created viewer.
      this.listen(stage, 'pointerdown', event => {
        if (event.isPrimary === false || (event.button != null && event.button !== 0)) return;
        if (event.target === host || host.contains(event.target)) this.render(card, false, true);
      }, { capture: true });
      this.listen(stage, 'keydown', event => {
        if (['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', ' ', 'Escape'].includes(event.key) &&
          (event.target === host || host.contains(event.target))) this.render(card, false, true);
      }, { capture: true });
      this.listen(retry, 'click', () => {
        if (card.capacity) {
          this.entries.delete(card.product.key);
          void this.load(card, card.product, true, true);
          return;
        }
        if (card.snapshot) this.render(card, true);
        else { this.entries.delete(card.product.key); void this.load(card, card.product); }
      });
      return card;
    }

    prepared(product, deliberate = false, allowSmallText = false) {
      if (!this.entries.has(product.key)) {
        const promise = this.preparationQueue.add(product.key, async () => {
          if (this.destroyed) throw new Error('gallery_closed');
          const prepared = await this.prepareDesign(product, { signal: this.controller.signal, allowSmallText });
          return { ...prepared, designs: printPrecision(prepared.designs) };
        }, deliberate ? 100 : 0);
        this.entries.set(product.key, promise);
      }
      if (deliberate) this.preparationQueue.promote(product.key);
      return this.entries.get(product.key);
    }

    async load(card, product, deliberate = true, allowSmallText = false) {
      const version = ++card.version;
      card.cachedPreviewVersion = null;
      this.previewQueue.delete(card);
      card.previousPreview.style.removeProperty('opacity');
      const previous = card.product;
      if (previous.key !== product.key && this.preparationQueue.cancel(previous.key)) {
        this.entries.delete(previous.key);
      }
      if (card.viewer?.canvas && card.stage.dataset.ready === 'true') {
        try {
          card.viewer.render();
          card.previousPreview.width = card.viewer.canvas.width;
          card.previousPreview.height = card.viewer.canvas.height;
          card.previousPreview.getContext('2d').drawImage(card.viewer.canvas, 0, 0);
          card.previousPreview.hidden = false;
        } catch { card.previousPreview.hidden = true; }
      }
      card.viewer?.destroy();
      card.viewer = null;
      card.snapshot = null;
      card.previewUrls = {};
      card.thumbnailUrl = null;
      card.failed = false;
      card.capacity = false;
      card.product = product;
      card.customize.disabled = true;
      card.add.disabled = true;
      card.stage.dataset.ready = 'false';
      card.preview.setAttribute('aria-busy', 'true');
      card.retry.hidden = true;
      this.i18n.setText(card.retry, 'Erneut versuchen');
      card.status.hidden = false;
      card.status.classList.add('is-loading');
      this.i18n.setText(card.status, 'Euer Design wird vorbereitet…');
      this.localizeCard(card);
      try {
        const snapshot = await this.prepared(product, deliberate, allowSmallText);
        if (this.destroyed || version !== card.version) return;
        card.snapshot = snapshot;
        card.view = this.getView(product, snapshot.orientation);
        card.surface = product.printSurfaces[0].key;
        card.host.hidden = !is3D(product);
        card.flat.hidden = is3D(product);
        this.configureFlat(card.view, card.surface, card.flat, card.image);
        this.updateActions();
        this.render(card);
      } catch (error) {
        if (this.destroyed || version !== card.version) return;
        card.stage.dataset.ready = 'error';
        card.preview.setAttribute('aria-busy', 'false');
        card.status.classList.remove('is-loading');
        card.status.hidden = false;
        card.capacity = error.message === 'print_capacity';
        card.previousPreview.hidden = true;
        this.i18n.setText(card.status, card.capacity ? TextPrintQuality.CAPACITY_MESSAGE
          : 'Diese Vorschau konnte nicht geladen werden. Bitte versucht es erneut.');
        this.i18n.setText(card.retry, card.capacity ? 'Mit kleiner Schrift gestalten' : 'Erneut versuchen');
        card.retry.hidden = false;
      }
    }

    render(card, retry = false, immediate = false) {
      if (this.destroyed || this.suspended || card.element.hidden || !card.visible || !card.snapshot) return;
      if (card.failed && !retry) return;
      const width = card.stage.clientWidth, height = card.stage.clientHeight;
      const density = this.window.devicePixelRatio || 1;
      const design = card.snapshot.designs[card.surface];
      if (is3D(card.product)) {
        card.lastViewed = ++this.viewSequence;
        // Building models, shaders and textures can take hundreds of ms. Keep
        // native scrolling free of that work; prepare newly visible 3D views
        // after scrolling settles, reusing nearby views in the meantime.
        if (this.scrolling && !retry && !immediate) return;
        try {
          if (retry) { card.viewer?.destroy(); card.viewer = null; }
          if (card.viewer && card.renderedWidth === width && card.renderedHeight === height && card.renderedDensity === density && !retry) return;
          if (!card.viewer && !retry && !immediate) {
            if (card.cachedPreviewVersion === card.version && card.renderedWidth === width &&
              card.renderedHeight === height && card.renderedDensity === density) return;
            if (this.intersectionObserver) { this.previewQueue.add(card); this.schedulePreview(); return; }
          }
          if (!card.viewer) {
            this.previewQueue.delete(card);
            this.releaseDistantViewer();
            card.viewer = this.createMug({ host: card.host, product: card.view, design, designs: card.snapshot.designs,
            onStatus: state => {
              if (state === 'error') this.previewError(card);
              else if (state === 'ready') this.previewReady(card);
            } });
          }
          card.viewer.resize();
          if (!card.viewer.loading) this.previewReady(card);
        } catch { this.previewError(card); }
      } else {
        if (card.renderedVersion === card.version && card.renderedWidth === width && card.renderedHeight === height && card.renderedDensity === density && !retry) return;
        const mockup = card.view.previewMockup;
        const aspect = mockup ? mockup.width / mockup.height : card.view.printFile.width / card.view.printFile.height;
        const flatWidth = Math.min(Math.max(1, width - 24), Math.max(1, height - 24) * aspect);
        card.flat.style.setProperty('--flat-preview-width', `${Math.floor(flatWidth)}px`);
        card.flat.style.setProperty('--flat-preview-height', `${Math.floor(flatWidth / aspect)}px`);
        this.paintFlat(card.canvas, card.view, design, card.surface);
        this.previewReady(card);
      }
      card.renderedVersion = card.version;
      card.renderedWidth = width;
      card.renderedHeight = height;
      card.renderedDensity = density;
    }

    schedulePreview() {
      if (this.destroyed || this.suspended || this.scrolling || this.previewTurn !== null || this.previewActive || !this.previewQueue.size) return;
      this.previewTurn = this.requestPreviewTurn(() => {
        this.previewTurn = null;
        if (this.destroyed || this.suspended || this.scrolling) return;
        // One model per idle turn: a row must not compile several WebGL scenes
        // in one burst during the short pauses between mouse-wheel movements.
        const card = this.previewQueue.values().next().value;
        this.previewQueue.delete(card);
        if (card) this.render(card, false, true);
        if (card?.viewer?.loading && card.viewer.ready) {
          const active = this.previewActive = { card, viewer: card.viewer };
          const finish = () => {
            if (this.previewActive !== active) return;
            this.previewActive = null;
            this.schedulePreview();
          };
          Promise.resolve(card.viewer.ready).then(finish, finish);
        } else this.schedulePreview();
      });
    }

    releaseDistantViewer() {
      if (!this.intersectionObserver || this.cards.filter(card => card.viewer).length < 6) return;
      const candidates = this.cards.filter(card => card.viewer && !card.host.classList.contains('dragging'));
      const oldest = candidates.sort((a, b) => Number(a.visible) - Number(b.visible) || a.lastViewed - b.lastViewed)[0];
      if (!oldest) return;
      // Wide/tall viewports can intersect more than six cards. Keep their
      // rendered images instead of exceeding Safari's WebGL context budget.
      try {
        if (oldest.viewer.canvas && !oldest.viewer.loading && !oldest.failed) {
          oldest.viewer.render();
          oldest.previousPreview.width = oldest.viewer.canvas.width;
          oldest.previousPreview.height = oldest.viewer.canvas.height;
          oldest.previousPreview.getContext('2d').drawImage(oldest.viewer.canvas, 0, 0);
          oldest.previousPreview.style.opacity = '1';
          oldest.previousPreview.style.objectFit = 'contain';
          oldest.previousPreview.hidden = false;
          oldest.cachedPreviewVersion = oldest.version;
        }
      } catch { oldest.previousPreview.hidden = true; }
      oldest.viewer.destroy();
      oldest.viewer = null;
    }

    previewReady(card) {
      card.failed = false;
      card.cachedPreviewVersion = null;
      card.host.classList.add('is-ready');
      card.stage.dataset.ready = 'true';
      card.preview.setAttribute('aria-busy', 'false');
      card.previousPreview.hidden = true;
      card.previousPreview.width = card.previousPreview.height = 0;
      card.status.classList.remove('is-loading');
      card.status.hidden = true;
      card.retry.hidden = true;
      this.updateThumbnail(card);
    }

    previewError(card) {
      card.failed = true;
      card.host.classList.remove('is-ready');
      card.stage.dataset.ready = 'error';
      card.preview.setAttribute('aria-busy', 'false');
      card.status.classList.remove('is-loading');
      card.status.hidden = false;
      this.i18n.setText(card.status, 'Die 3D-Vorschau ist gerade nicht verfügbar. Euer Design bleibt erhalten.');
      card.retry.hidden = false;
    }

    resize(cards = this.cards) {
      if (this.destroyed || this.suspended) return;
      this.resizeCards ||= new Set();
      cards.forEach(card => this.resizeCards.add(card));
      if (this.frame !== null) return;
      this.frame = this.window.requestAnimationFrame(() => {
        this.frame = null;
        const pending = [...this.resizeCards];
        this.resizeCards.clear();
        pending.forEach(card => this.render(card));
      });
    }

    filter(category) {
      if (!CATEGORIES.some(([key]) => key === category)) return;
      this.closePriceInfo();
      this.category = category;
      for (const button of this.filters?.children || []) {
        button.setAttribute('aria-pressed', String(button.dataset.category === category));
      }
      for (const card of this.cards) {
        card.element.hidden = category !== 'all' && categoryFor(card.product) !== category;
        if (card.element.hidden) { this.previewQueue.delete(card); card.viewer?.destroy(); card.viewer = null; }
      }
      this.resize();
    }

    localizeCard(card) {
      this.i18n.setText(card.name, card.product.displayName);
      this.i18n.setText(card.detail, card.product.variantLabel || card.product.size.label);
      const price = card.product.price;
      card.priceRow.hidden = !price;
      if (price) {
        card.price.textContent = this.i18n.formatCurrency?.(price.unitGrossCents, price.currency)
          || new Intl.NumberFormat(this.i18n.getLocale?.() || 'de', { style: 'currency', currency: price.currency }).format(price.unitGrossCents / 100);
        this.i18n.setText(card.priceNote, price.germanDeliveryAvailable === false
          ? 'Nicht nach DE lieferbar'
          : 'inkl. MwSt., zzgl. Versand · DE');
      }
      card.photo.hidden = !referencePhoto(card.product);
      card.photoButton.hidden = card.photo.hidden;
      card.sizes.classList.toggle('has-product-photo', !card.photo.hidden);
      if (referencePhoto(card.product)) {
        const url = card.thumbnailUrl || referencePhoto(card.product);
        if (card.photo.getAttribute('src') !== url) card.photo.src = url;
        card.photo.alt = '';
        this.i18n.setAttribute(card.photoButton, 'aria-label', '{{view}}: {{product}}, {{variant}}', {
          view: this.i18n.t('Details & Vorschau'), product: this.i18n.t(card.product.displayName),
          variant: this.i18n.t(card.product.variantLabel || card.product.size.label),
        });
      }
      card.photoButton.disabled = !card.snapshot || this.choosing;
      this.i18n.setAttribute(card.host, 'aria-label', ['blanket', 'garment'].includes(card.product.previewModel?.kind)
        ? '{{product}}, {{size}}. Stoff greifen und ziehen; daneben ziehen oder Pfeiltasten zum Drehen. Leertaste bewegt den Stoff.' : '{{product}}, {{size}}', {
        product: this.i18n.t(card.product.displayName), size: this.i18n.t(card.product.size.label),
      });
      card.detail.hidden = true;
      if (card.variantLabel) card.variantLabel.textContent = this.i18n.t(card.product.variantLabel || card.product.size.label);
      card.inCart = Boolean(card.snapshot?.editingOrderItemId && (this.isInCart?.(card.snapshot.editingOrderItemId) ?? true));
      this.i18n.setText(card.add, card.inCart && card.snapshot.needsCartUpdate === false ? 'Im Warenkorb'
        : card.inCart ? 'Warenkorb aktualisieren' : 'In den Warenkorb');
    }

    localize() {
      this.cards.forEach(card => this.localizeCard(card));
      if (this.photoCard) this.localizePhoto();
      this.localizePriceInfo();
    }

    updateActions() {
      for (const card of this.cards) {
        this.localizeCard(card);
        card.customize.disabled = this.choosing || !card.snapshot;
        card.add.disabled = this.choosing || !card.snapshot ||
          Boolean(card.inCart && card.snapshot.needsCartUpdate === false);
        card.add.setAttribute('aria-busy', String(Boolean(card.adding)));
        if (card.variantToggle) card.variantToggle.disabled = this.choosing;
      }
    }

    async add(card) {
      if (!card.snapshot || this.choosing || this.destroyed || this.suspended || card.add.disabled) return;
      this.choosing = true;
      card.adding = true;
      this.updateActions();
      try {
        const saved = await this.onAdd(copy(card.snapshot));
        if (!this.destroyed) {
          card.snapshot = copy(saved);
          this.entries.set(card.product.key, Promise.resolve(card.snapshot));
          card.status.hidden = true;
        }
      } catch (error) {
        if (!this.destroyed) {
          card.status.hidden = false;
          this.i18n.setText(card.status, error.userMessage || 'Das Design konnte nicht gespeichert werden. Bitte versucht es erneut.');
        }
      } finally {
        card.adding = false;
        this.choosing = false;
        if (!this.destroyed) this.updateActions();
      }
    }

    suspend() {
      this.suspended = true;
      this.preview?.close();
      this.closePriceInfo();
      if (this.photoDialog.dialog.open) this.photoDialog.dialog.close();
      if (this.variantDialog.dialog.open) this.variantDialog.dialog.close();
      this.preparationQueue.pause();
      this.window.cancelAnimationFrame(this.frame);
      this.frame = null;
      this.resizeCards?.clear();
      if (this.previewTurn !== null) this.cancelPreviewTurn(this.previewTurn);
      this.previewTurn = null;
      this.previewActive = null;
      this.previewQueue.clear();
      this.window.clearTimeout(this.scrollTimer);
      this.scrolling = false;
      this.cards.forEach(card => { card.viewer?.destroy(); card.viewer = null; });
    }

    async resume(snapshot = null) {
      this.suspended = false;
      this.preparationQueue.resume();
      if (snapshot) {
        const card = this.cards.find(card => card.variants.some(product => product.key === snapshot.productKey));
        if (card) {
          this.preparationQueue.cancel(snapshot.productKey);
          this.entries.set(snapshot.productKey, Promise.resolve(copy(snapshot)));
          await this.load(card, card.variants.find(product => product.key === snapshot.productKey));
        }
      }
      this.updateActions();
      this.resize();
    }

    async choose(card) {
      if (!card.snapshot || card.element.hidden || this.choosing || this.destroyed || this.suspended) return;
      this.choosing = true;
      this.updateActions();
      try {
        // The cached preview is immutable from the editor's point of view.
        // Hand over every print side without measuring or arranging it again.
        await this.onChoose(copy(card.snapshot));
      } catch {
        if (!this.destroyed) {
          card.status.hidden = false;
          this.i18n.setText(card.status, 'Diese Vorschau konnte nicht geladen werden. Bitte versucht es erneut.');
        }
      } finally {
        this.choosing = false;
        if (!this.destroyed) this.updateActions();
      }
    }

    destroy() {
      this.destroyed = true;
      this.preview?.close();
      this.closePriceInfo();
      this.priceInfo.remove();
      if (this.photoDialog.dialog.open) this.photoDialog.dialog.close();
      this.photoDialog.dialog.remove();
      this.variantDialog.dialog.remove();
      this.preparationQueue.dispose();
      this.controller.abort();
      this.resizeObserver?.disconnect();
      this.intersectionObserver?.disconnect();
      this.window.cancelAnimationFrame(this.frame);
      this.window.clearTimeout(this.scrollTimer);
      if (this.previewTurn !== null) this.cancelPreviewTurn(this.previewTurn);
      this.previewTurn = null;
      this.previewActive = null;
      this.previewQueue.clear();
      this.cards.forEach(card => card.viewer?.destroy());
      this.entries.clear();
    }
  }

  return Object.freeze({ Gallery, groupProducts, shouldOpen, categoryFor });
});
