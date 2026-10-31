'use strict';

const { createHash } = require('node:crypto');
const { createCanvas, Image } = require('canvas');
const ContentBounds = require('../public/js/design-content-bounds');
const { inspectRasterDataUrl } = require('./designImages');
require('./designFonts');

const ctx = createCanvas(1, 1).getContext('2d');
// Retain only small rectangles and digests, never uploaded image bytes/pixels.
const sources = new Map();
const MAX_CACHED_SOURCES = 64;

function imageBounds(src) {
  if (!inspectRasterDataUrl(src)) return null;
  const key = createHash('sha256').update(src).digest('hex');
  if (sources.has(key)) return sources.get(key);
  const image = new Image();
  try {
    image.src = Buffer.from(src.slice(src.indexOf(',') + 1), 'base64');
    if (!image.complete || !image.width || !image.height) return null;
    const bounds = ContentBounds.image(image, createCanvas);
    sources.set(key, bounds);
    if (sources.size > MAX_CACHED_SOURCES) sources.delete(sources.keys().next().value);
    return bounds;
  } catch { return null; }
}

function bounds(item) {
  const image = item.type === 'image' ? imageBounds(item.src) : undefined;
  if (item.type === 'image' && !image) return null;
  return ContentBounds.bounds(item, ctx, { image });
}

module.exports = { bounds, imageBounds };
