'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const EmojiData = require('../public/js/emoji-data');
const { ASSET_ROOT } = require('./emojiAssets');

const references = new Set(Object.values(EmojiData.canonicalAssets));
const PIXELS_PER_UNIT = Object.freeze({
  '': 1, px: 1, in: 96, cm: 96 / 2.54, mm: 96 / 25.4,
  q: 96 / 101.6, pt: 96 / 72, pc: 16,
});

function absoluteLength(value) {
  const match = String(value || '').trim().match(/^(\d+(?:\.\d*)?|\.\d+)([a-z]*)$/i);
  if (!match || !Object.hasOwn(PIXELS_PER_UNIT, match[2].toLowerCase())) return null;
  const length = Number(match[1]) * PIXELS_PER_UNIT[match[2].toLowerCase()];
  return Number.isFinite(length) && length > 0 ? length : null;
}

/**
 * Give trusted, bundled SVGs a definite intrinsic viewport before any browser
 * decodes them. A viewBox alone defines coordinates/aspect ratio, not pixels.
 * Fabric's source-rectangle drawImage call needs the latter. Keep all artwork,
 * root presentation attributes and existing aspect ratios unchanged.
 */
function normalizeBrowserSvg(source) {
  let found = false;
  const normalized = String(source).replace(/<svg\b([^>]*)>/i, (tag, attributes) => {
    found = true;
    const attribute = (name) => attributes.match(new RegExp(`\\s${name}\\s*=\\s*(['"])(.*?)\\1`, 'i'))?.[2];
    const viewBox = attribute('viewBox')?.trim().split(/[\s,]+/).map(Number);
    const validViewBox = viewBox?.length === 4 && viewBox.every(Number.isFinite) &&
      viewBox[2] > 0 && viewBox[3] > 0;
    let width = absoluteLength(attribute('width'));
    let height = absoluteLength(attribute('height'));
    if (!width || !height) {
      if (!validViewBox) throw new Error('Bundled emoji SVG has no definite image size');
      if (width) height = width * viewBox[3] / viewBox[2];
      else if (height) width = height * viewBox[2] / viewBox[3];
      else [width, height] = viewBox.slice(2);
    }
    const preserved = attributes.replace(/\s(?:width|height)\s*=\s*(['"])[\s\S]*?\1/gi, '');
    return `<svg${preserved} width="${width}" height="${height}">`;
  });
  if (!found) throw new Error('Bundled emoji artwork is not an SVG');
  return normalized;
}

async function loadBrowserSvg(reference) {
  // Catalog membership, not user-supplied paths, controls filesystem access.
  // Async reads avoid blocking the event loop; HTTP immutable caching handles
  // reuse without an unbounded in-process cache of the 37 MB artwork catalog.
  if (!references.has(reference)) return null;
  return normalizeBrowserSvg(await fs.readFile(path.join(ASSET_ROOT, reference), 'utf8'));
}

module.exports = { loadBrowserSvg, normalizeBrowserSvg };
