(function (root, factory) {
  'use strict';
  if (typeof module === 'object' && module.exports) {
    module.exports = factory(require('./wordcloud-core'), require('./design-fonts'), require('./mug-icons'), require('./design-content-bounds'));
  } else root.ArtworkOverlap = factory(root.WordCloudCore, root.DesignFonts, root.MugIcons, root.DesignContentBounds);
})(typeof window === 'object' ? window : globalThis, function (core, fonts, icons, contentBounds) {
  'use strict';
  const TILE_SIZE = 128;
  const MAX_CACHED_TILES = 512;
  const MAX_FINDINGS = 100;
  // Ignore faint antialiasing fringes, but retain narrow strokes and tiny text.
  const MIN_ALPHA = 64;

  // Shared with the product preview. Selection frames and controls never enter
  // this renderer, including the transparent frames in Fabric emoji groups.
  function drawItem(ctx, item, { image, emojiImage, allowMissing = false, path = value => new Path2D(value) } = {}, scale = 1) {
    ctx.save();
    try {
      ctx.translate(item.x * scale, item.y * scale);
      ctx.rotate((item.angle || 0) * Math.PI / 180);
      if (item.type === 'image') {
        const element = image?.(item.src);
        if (!element) {
          if (allowMissing) return;
          throw new Error('Artwork image is not loaded');
        }
        ctx.drawImage(element, -item.width * scale / 2, -item.height * scale / 2,
          item.width * scale, item.height * scale);
      } else if (item.type === 'icon') {
        const icon = icons.get(item.icon);
        if (!icon) {
          if (allowMissing) return;
          throw new Error('Unknown artwork motif');
        }
        const factor = item.size * scale / icons.VIEWBOX_SIZE;
        ctx.scale(factor, factor);
        ctx.translate(-icons.VIEWBOX_SIZE / 2, -icons.VIEWBOX_SIZE / 2);
        ctx.strokeStyle = item.color;
        ctx.lineWidth = icons.STROKE_WIDTH;
        ctx.lineCap = 'round';
        ctx.lineJoin = 'round';
        ctx.stroke(path(icon.path));
      } else {
        core.drawRichText(ctx, item.text, 0, 0, item.fontSize * scale, {
          fontFamily: fonts.cssFamily(item.fontFamily), color: item.color,
          fontWeight: item.fontWeight, fontStyle: item.fontStyle,
          underline: item.underline, linethrough: item.linethrough,
          emojiImage: run => {
            const element = emojiImage?.(run);
            if (!element && !allowMissing) throw new Error('Emoji artwork is not loaded');
            return element;
          },
        });
      }
    } finally { ctx.restore(); }
  }

  function bounds(item, ctx) {
    // Candidate rectangles and the final pixel masks share the same painted
    // geometry as the editor/print validator. Image rectangles may remain
    // conservative here: transparent pixels are rejected by the mask itself.
    const box = contentBounds.bounds(item, ctx);
    return { left: Math.floor(box.left - 2), top: Math.floor(box.top - 2),
      right: Math.ceil(box.left + box.width + 2), bottom: Math.ceil(box.top + box.height + 2) };
  }

  function create({ createCanvas, draw = drawItem, assets = {}, yieldTask = () => new Promise(resolve => setTimeout(resolve, 0)),
    now = () => performance.now() } = {}) {
    const canvas = createCanvas(TILE_SIZE, TILE_SIZE);
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    const cache = new Map();
    const imageIds = new WeakMap();
    let nextImageId = 0;
    function key(item) {
      const source = item.type === 'image' ? assets.image?.(item.src) : null;
      if (source && !imageIds.has(source)) imageIds.set(source, ++nextImageId);
      return JSON.stringify({ ...item, src: item.type === 'image' ? imageIds.get(source) : undefined,
        color: undefined, colorLocked: undefined, layoutFingerprint: undefined, layoutFontSize: undefined });
    }
    function mask(entry, x, y) {
      const id = `${entry.key}:${x}:${y}`;
      if (cache.has(id)) {
        const value = cache.get(id);
        cache.delete(id); cache.set(id, value);
        return value;
      }
      ctx.clearRect(0, 0, TILE_SIZE, TILE_SIZE);
      ctx.save();
      try {
        ctx.translate(-x, -y);
        draw(ctx, entry.item, assets);
      } finally { ctx.restore(); }
      const pixels = ctx.getImageData(0, 0, TILE_SIZE, TILE_SIZE).data;
      let bits = null;
      for (let i = 0; i < TILE_SIZE * TILE_SIZE; i++) {
        if (pixels[i * 4 + 3] < MIN_ALPHA) continue;
        if (!bits) bits = new Uint8Array(TILE_SIZE * TILE_SIZE / 8);
        bits[i >> 3] |= 1 << (i & 7);
      }
      cache.set(id, bits);
      if (cache.size > MAX_CACHED_TILES) cache.delete(cache.keys().next().value);
      return bits;
    }
    async function check(design, { cancelled = () => false, limit = MAX_FINDINGS } = {}) {
      const entries = [];
      let lastYield = now();
      for (const item of design) {
        if (cancelled()) return null;
        entries.push({ item, key: key(item), bounds: bounds(item, ctx) });
        if (now() - lastYield >= 8) { await yieldTask(); lastYield = now(); }
      }
      entries.sort((a, b) => a.bounds.left - b.bounds.left);
      const findings = [];
      for (let i = 0; i < entries.length; i++) {
        const a = entries[i];
        for (let j = i + 1; j < entries.length && entries[j].bounds.left < a.bounds.right; j++) {
          if ((j & 63) === 0) {
            if (cancelled()) return null;
            if (now() - lastYield >= 8) { await yieldTask(); lastYield = now(); }
          }
          const b = entries[j];
          const left = Math.max(a.bounds.left, b.bounds.left), right = Math.min(a.bounds.right, b.bounds.right);
          const top = Math.max(a.bounds.top, b.bounds.top), bottom = Math.min(a.bounds.bottom, b.bounds.bottom);
          if (top >= bottom || left >= right) continue;
          let overlap = false;
          // Rasterize only candidate intersections, at one pixel per print pixel.
          // Fixed-size tiles bound memory even for full-size blanket images.
          for (let y = Math.floor(top / TILE_SIZE) * TILE_SIZE; y < bottom && !overlap; y += TILE_SIZE) {
            for (let x = Math.floor(left / TILE_SIZE) * TILE_SIZE; x < right && !overlap; x += TILE_SIZE) {
              if (cancelled()) return null;
              const first = mask(a, x, y), second = first && mask(b, x, y);
              if (second) for (let k = 0; k < first.length; k++) {
                if (first[k] & second[k]) { overlap = true; break; }
              }
              if (now() - lastYield >= 8) { await yieldTask(); lastYield = now(); }
            }
          }
          if (overlap) findings.push({ ids: [a.item.id, b.item.id] });
          if (findings.length > limit) return { findings: findings.slice(0, limit), truncated: true };
        }
        if (cancelled()) return null;
        if (now() - lastYield >= 8) { await yieldTask(); lastYield = now(); }
      }
      return { findings, truncated: false };
    }
    return { check, key, clear: () => cache.clear(), cacheSize: () => cache.size };
  }
  return { create, drawItem, bounds, MAX_FINDINGS, MAX_CACHED_TILES };
});
