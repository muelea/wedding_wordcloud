(function (root, factory) {
  'use strict';
  if (typeof module === 'object' && module.exports) {
    module.exports = factory(require('./wordcloud-core'), require('./design-fonts'), require('./artwork-bounds-data'));
  } else root.DesignContentBounds = factory(root.WordCloudCore, root.DesignFonts, root.ArtworkBoundsData);
})(typeof window !== 'undefined' ? window : globalThis, function (core, fonts, artwork) {
  'use strict';

  const imageCache = new WeakMap();
  const textCaches = new WeakMap();
  const MAX_TEXT_CACHE = 512;
  const rect = (left, top, right, bottom) => ({ left, top,
    width: Math.max(0, right - left), height: Math.max(0, bottom - top) });
  function union(boxes) {
    const occupied = boxes.filter(box => box && box.width > 0 && box.height > 0);
    return occupied.length ? rect(Math.min(...occupied.map(b => b.left)), Math.min(...occupied.map(b => b.top)),
      Math.max(...occupied.map(b => b.left + b.width)), Math.max(...occupied.map(b => b.top + b.height))) : null;
  }
  function transform(box, { x = 0, y = 0, angle = 0, skewX = 0 } = {}) {
    const a = angle * Math.PI / 180, skew = Math.tan(skewX * Math.PI / 180);
    const points = [[box.left, box.top], [box.left + box.width, box.top],
      [box.left, box.top + box.height], [box.left + box.width, box.top + box.height]]
      .map(([px, py]) => ({ x: x + (px + skew * py) * Math.cos(a) - py * Math.sin(a),
        y: y + (px + skew * py) * Math.sin(a) + py * Math.cos(a) }));
    return rect(Math.min(...points.map(p => p.x)), Math.min(...points.map(p => p.y)),
      Math.max(...points.map(p => p.x)), Math.max(...points.map(p => p.y)));
  }
  function artworkBox(value, size) {
    const [left, top, right, bottom] = value || [0, 0, artwork.resolution, artwork.resolution];
    return rect((left / artwork.resolution - .5) * size, (top / artwork.resolution - .5) * size,
      (right / artwork.resolution - .5) * size, (bottom / artwork.resolution - .5) * size);
  }

  // Baselines and advance widths remain unchanged. Ink bounds can be asymmetric
  // about that saved anchor; keeping their offset is as important as their size.
  function text(item, ctx, { box, baseline = core.TEXT_BASELINE_OFFSET,
    skew = true, decorations, fontFamily = fonts.cssFamily(item.fontFamily) } = {}) {
    let cache = textCaches.get(ctx);
    if (!cache) { cache = new Map(); textCaches.set(ctx, cache); }
    const key = JSON.stringify([item.text, item.fontSize, item.fontFamily,
      core.textStyle(item), box, baseline, skew, decorations, fontFamily]);
    if (cache.has(key)) return cache.get(key);
    const size = item.fontSize;
    const family = fontFamily;
    const layout = box || core.measureTextBox(item.text, size, ctx, family, item);
    ctx.font = `${core.textStyle(item).fontWeight} ${size}px ${family}`;
    ctx.textAlign = 'left'; ctx.textBaseline = 'alphabetic';
    const boxes = [];
    for (const run of layout.runs) {
      const x = -layout.width / 2 + run.x;
      if (run.type === 'emoji') {
        const ink = artworkBox(artwork.emoji[run.asset], size);
        boxes.push({ ...ink, left: x + run.width / 2 + ink.left });
      } else {
        const m = ctx.measureText(run.text);
        // node-canvas 3's Pango implementation returns the signed left bearing;
        // browser TextMetrics returns its distance in the opposite direction.
        const leftBearing = typeof ctx.canvas?.toBuffer === 'function'
          ? m.actualBoundingBoxLeft : -m.actualBoundingBoxLeft;
        if (run.text.trim()) boxes.push([leftBearing, m.actualBoundingBoxRight,
          m.actualBoundingBoxAscent, m.actualBoundingBoxDescent].every(Number.isFinite)
          ? rect(x + leftBearing, baseline * size - m.actualBoundingBoxAscent,
            x + m.actualBoundingBoxRight, baseline * size + m.actualBoundingBoxDescent)
          : rect(x, -size * core.TEXT_LINE_HEIGHT / 2, x + run.width, size * core.TEXT_LINE_HEIGHT / 2));
        const lines = decorations || [
          ...(item.underline ? [[size * .48, Math.max(1, size * .055)]] : []),
          ...(item.linethrough ? [[size * .03, Math.max(1, size * .055)]] : []),
        ];
        for (const [y, thickness] of lines) boxes.push(rect(x, y - thickness / 2,
          x + run.width, y + thickness / 2));
      }
    }
    const result = union(boxes) || rect(-layout.width / 2, -size / 2, layout.width / 2, size / 2);
    const bounds = skew && item.fontStyle === 'italic'
      ? transform(result, { skewX: core.ITALIC_SKEW_DEGREES }) : result;
    cache.set(key, bounds);
    if (cache.size > MAX_TEXT_CACHE) cache.delete(cache.keys().next().value);
    return bounds;
  }

  // Decode/scan each uploaded source once. Never infer transparency from colour:
  // white pixels in a photo or logo remain part of the artwork.
  function image(element, createCanvas) {
    if (imageCache.has(element)) return imageCache.get(element);
    const width = element.naturalWidth || element.width, height = element.naturalHeight || element.height;
    const canvas = createCanvas(width, height), ctx = canvas.getContext('2d', { willReadFrequently: true });
    ctx.drawImage(element, 0, 0, width, height);
    const pixels = ctx.getImageData(0, 0, width, height).data;
    let left = width, top = height, right = 0, bottom = 0;
    for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
      if (!pixels[(y * width + x) * 4 + 3]) continue;
      left = Math.min(left, x); top = Math.min(top, y);
      right = Math.max(right, x + 1); bottom = Math.max(bottom, y + 1);
    }
    // Upscaling interpolates an edge pixel into its transparent neighbours.
    // Retain that half-pixel footprint, including for very small uploaded logos.
    const result = right > left && bottom > top
      ? rect(Math.max(0, left - .5) / width - .5, Math.max(0, top - .5) / height - .5,
        Math.min(width, right + .5) / width - .5, Math.min(height, bottom + .5) / height - .5)
      : rect(-.5, -.5, .5, .5);
    imageCache.set(element, result);
    return result;
  }
  function local(item, ctx, { image: imageBounds } = {}) {
    if (item.type === 'image') {
      const b = imageBounds || rect(-.5, -.5, .5, .5);
      return { left: b.left * item.width, top: b.top * item.height,
        width: b.width * item.width, height: b.height * item.height };
    }
    if (item.type === 'icon') return artworkBox(artwork.icons[item.icon], item.size);
    return text(item, ctx);
  }
  function bounds(item, ctx, assets) { return transform(local(item, ctx, assets), item); }
  return { text, image, local, bounds, transform, union,
    emoji: (asset, size) => artworkBox(artwork.emoji[asset], size) };
});
