(function (root, factory) {
  'use strict';
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.ProductPhotoPreview = api;
})(typeof window !== 'undefined' ? window : globalThis, function () {
  'use strict';

  const layers = new WeakMap();

  function loadLayer(document, url) {
    let cache = layers.get(document);
    if (!cache) { cache = new Map(); layers.set(document, cache); }
    if (!cache.has(url)) {
      const pending = new Promise((resolve, reject) => {
        const image = document.createElement('img');
        image.decoding = 'async';
        image.onload = () => resolve(image);
        image.onerror = () => reject(new Error('preview_image_failed'));
        image.src = url;
      });
      cache.set(url, pending);
      pending.catch(() => { if (cache.get(url) === pending) cache.delete(url); });
      while (cache.size > 12) cache.delete(cache.keys().next().value);
    }
    return cache.get(url);
  }

  // Coordinates describe the complete provider template, not the visible ink
  // bounds or the garment's nominal chest width. Preserve every artwork margin.
  function paint(context, { width, height }, product, layer, drawTexture, fill = 1) {
    const mockup = product.previewMockup;
    const area = mockup.canvas;
    const scale = Math.min(width / mockup.width, height / mockup.height) * fill;
    const frameWidth = Math.max(1, Math.round(mockup.width * scale));
    const frameHeight = Math.max(1, Math.round(mockup.height * scale));
    context.clearRect(0, 0, width, height);
    context.save();
    // Align the outside mask to backing pixels so a black base cannot leave
    // an antialiased hairline around the white photo surround at small sizes.
    context.translate(Math.round((width - frameWidth) / 2), Math.round((height - frameHeight) / 2));
    context.scale(frameWidth / mockup.width, frameHeight / mockup.height);
    context.fillStyle = mockup.backgroundColor;
    context.fillRect(0, 0, mockup.width, mockup.height);
    context.save();
    context.translate(mockup.width * area.left / 100, mockup.height * area.top / 100);
    context.scale(mockup.width * area.width / 100 / product.printFile.width,
      mockup.height * area.height / 100 / product.printFile.height);
    context.beginPath();
    context.rect(0, 0, product.printFile.width, product.printFile.height);
    context.clip();
    drawTexture(context, { offsetX: 0, offsetY: 0,
      printWidth: product.printFile.width, printHeight: product.printFile.height });
    context.restore();
    // The original alpha layer shades the print and masks seams/background.
    // Flattened catalog JPEGs would cover the artwork instead.
    context.drawImage(layer, 0, 0, mockup.width, mockup.height);
    context.restore();
  }

  function create({ host, product, drawTexture, onStatus = () => {},
    maxPixelRatio = 2, maxRenderPixels = 1800000, framingFill = () => 1 } = {}) {
    const canvas = host.ownerDocument.createElement('canvas');
    const context = canvas.getContext('2d');
    if (!context) throw new Error('preview_canvas_unavailable');
    canvas.className = 'product-photo-canvas';
    canvas.setAttribute('aria-hidden', 'true');
    host.prepend(canvas);
    let disposed = false, layer = null, loading = true;
    function render() {
      if (!disposed && layer) paint(context, canvas, product, layer, drawTexture, framingFill());
    }
    function resize() {
      if (disposed) return;
      const width = Math.max(1, host.clientWidth), height = Math.max(1, host.clientHeight);
      const ratio = Math.min(host.ownerDocument.defaultView?.devicePixelRatio || 1,
        maxPixelRatio, Math.sqrt(maxRenderPixels / (width * height)));
      canvas.width = Math.max(1, Math.round(width * ratio));
      canvas.height = Math.max(1, Math.round(height * ratio));
      render();
    }
    onStatus('loading');
    const ready = loadLayer(host.ownerDocument, product.previewMockup.assets.front).then(image => {
      if (disposed) return false;
      layer = image;
      loading = false;
      resize();
      onStatus('ready');
      return true;
    }).catch(() => {
      if (!disposed) { loading = false; onStatus('error'); }
      return false;
    });
    return {
      canvas, ready, get loading() { return loading; }, render, resize,
      updateTexture(draw) { drawTexture = draw; render(); },
      destroy() {
        if (disposed) return;
        disposed = true;
        layer = null;
        canvas.remove();
        canvas.width = canvas.height = 1;
      },
    };
  }

  return Object.freeze({ create, paint });
});
