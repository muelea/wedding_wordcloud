(function (root, factory) {
  'use strict';
  const api = factory(typeof module === 'object' && module.exports
    ? require('./product-photo-preview') : root.ProductPhotoPreview);
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.WolkenworteCartProductPreview = api;
})(typeof window === 'object' ? window : globalThis, function (PhotoPreview) {
  'use strict';

  const thumbnails = new Map();
  let queue = Promise.resolve();
  const is3D = product => ['mug', '3d'].includes(product?.previewType);
  const isPhoto = product => product?.previewType === 'photo';
  const photo = product => product?.productPhoto || product?.previewMockup?.assets?.default ||
    product?.previewMockup?.assets?.front || Object.values(product?.previewMockup?.assets || {})[0] || product?.thumbnail || '';
  const photos = product => product?.productPhotos?.length ? product.productPhotos :
    photo(product) ? [{ src: photo(product), label: 'Produktfoto' }] : [];

  function variant(product, i18n) {
    const size = product?.size || {};
    let label = i18n.t(product?.variantLabel || size.label || '');
    if (product?.orientation === 'landscape' && size.label) {
      // Keep color/finish identity while using the oriented metric dimensions.
      label = label.replace(/^.*?\d+(?:[.,]\d+)?\s+×\s+\d+(?:[.,]\d+)?\s+(?:cm|mm)/,
        i18n.t(size.label));
    }
    return size.detail ? `${label} · ${i18n.t(size.detail)}` : label;
  }

  function configuration(item, product) {
    const base = String(item.printFileUrl || '').split('?')[0].replace(/\.(svg|png)$/, '.png');
    const sides = product?.printSurfaces || [];
    const printPreviewUrls = item.printPreviewUrls || Object.fromEntries(sides.map(side => [
      side.key, sides.length > 1 ? `${base}?surface=${encodeURIComponent(side.key)}` : base,
    ]));
    return { ...item, product, printPreviewUrls,
      printFileUrls: item.printFileUrls || Object.fromEntries(Object.entries(printPreviewUrls)
        .map(([key, url]) => [key, url.replace(/\.png(?=\?|$)/, '.svg')])),
    };
  }

  function loadImage(document, url) {
    return new Promise((resolve, reject) => {
      const image = document.createElement('img');
      image.decoding = 'async';
      image.onload = () => resolve(image);
      image.onerror = () => reject(new Error('preview_image_failed'));
      image.src = url;
    });
  }

  // Frozen SVGs include their fonts and uploaded images. Reusing them keeps
  // automatic thumbnails outside the on-demand production-PNG render quota.
  // This never loads an editable draft or calls Printful's mockup API.
  async function render3D({ host, item, window: browser = window, onStatus = () => {} }) {
    const product = item.product;
    const sides = product.printSurfaces;
    const urls = item.printFileUrls || item.printPreviewUrls;
    const sources = await Promise.all(sides.map(side => loadImage(host.ownerDocument, urls[side.key])));
    if (!browser.THREE) await (browser.wolkenworteThreeReady ||= import('/vendor/three/build/three.module.js?v=0.160.1')
      .then(THREE => { browser.THREE = THREE; }));
    if (!host.isConnected) throw new Error('preview_closed');
    const draw = image => (ctx, { offsetX, offsetY, printWidth, printHeight }) => {
      if (image) ctx.drawImage(image, offsetX, offsetY, printWidth, printHeight);
    };
    const front = Math.max(0, sides.findIndex(side => side.key === 'front'));
    const back = sides.findIndex(side => side.key === 'back');
    let viewer;
    try {
      viewer = browser.Mug3DViewer.create({ host, product, THREE: browser.THREE,
        drawTexture: draw(sources[front]), drawBackTexture: draw(sources[back]),
        fitToView: true, framingFill: () => .92,
        onStatus, maxPixelRatio: 2, maxRenderPixels: 1800000,
      });
      if (!await viewer.ready) throw new Error('preview_model_failed');
      if (!host.isConnected) throw new Error('preview_closed');
      viewer.resize();
      return viewer;
    } catch (error) { viewer?.destroy(); throw error; }
  }

  async function renderPhoto({ host, item, onStatus = () => {} }) {
    const product = item.product;
    const urls = item.printFileUrls || item.printPreviewUrls;
    const source = await loadImage(host.ownerDocument, urls[product.printSurfaces[0].key]);
    if (!host.isConnected) throw new Error('preview_closed');
    const viewer = PhotoPreview.create({ host, product, onStatus,
      drawTexture: (ctx, { printWidth, printHeight }) => ctx.drawImage(source, 0, 0, printWidth, printHeight),
    });
    try {
      if (!await viewer.ready) throw new Error('preview_image_failed');
      if (!host.isConnected) throw new Error('preview_closed');
      viewer.resize();
      return viewer;
    } catch (error) { viewer.destroy(); throw error; }
  }

  function createThumbnails({ document, item, i18n, onOpen }) {
    const group = document.createElement('div');
    group.className = 'cart-product-previews';
    const product = item.product;
    const add = (view, label, url) => {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'cart-product-preview';
      button.dataset.previewView = view;
      button.setAttribute('aria-haspopup', 'dialog');
      button.setAttribute('aria-controls', 'print-preview');
      i18n.setAttribute(button, 'aria-label', '{{view}}: {{product}}, {{variant}}', {
        view: i18n.t(label), product: i18n.t(product.displayName), variant: variant(product, i18n),
      });
      const image = document.createElement('img');
      image.alt = '';
      image.src = url;
      image.loading = 'lazy';
      image.addEventListener('error', () => {
        const fallback = photo(product);
        if (image.getAttribute('src') !== fallback) image.src = fallback;
        else image.hidden = true;
      });
      const eye = document.createElement('span');
      eye.className = 'cart-product-preview-eye ww-preview-eye';
      eye.setAttribute('aria-hidden', 'true');
      button.append(image, eye);
      button.addEventListener('click', () => onOpen(view, button));
      group.append(button);
      return image;
    };
    const composed = is3D(product) || isPhoto(product);
    const designImage = add('overview', 'Details & Vorschau', composed ? photo(product) :
      Object.values(item.printFileUrls || item.printPreviewUrls || {})[0] || item.printFileUrl || photo(product));
    if (composed) {
      const key = JSON.stringify([product.key, item.orientation, item.printFileUrls || item.printPreviewUrls]);
      if (thumbnails.has(key)) designImage.src = thumbnails.get(key);
      else queue = queue.catch(() => {}).then(async () => {
        if (!group.isConnected || !group.getClientRects().length) return;
        if (thumbnails.has(key)) { designImage.src = thumbnails.get(key); return; }
        const host = document.createElement('div');
        host.className = 'cart-product-thumbnail-stage';
        document.body.append(host);
        let viewer;
        try {
          const render = isPhoto(product) ? renderPhoto : render3D;
          viewer = await render({ host, item, window: document.defaultView });
          if (!group.isConnected) return;
          viewer.render();
          const url = viewer.canvas.toDataURL('image/png');
          thumbnails.set(key, url);
          while (thumbnails.size > 32) thumbnails.delete(thumbnails.keys().next().value);
          designImage.src = url;
        } catch { /* Keep the matching reference photo if the local render fails. */ }
        finally { viewer?.destroy(); host.remove(); }
      });
    }
    return group;
  }

  return Object.freeze({ is3D, isPhoto, photo, photos, variant, configuration, render3D, renderPhoto, createThumbnails });
});
