'use strict';

const { createCanvas } = require('canvas');
const WordCloudCore = require('../public/js/wordcloud-core.js');
const { MUG_DUO } = require('./products');

const measureCanvas = createCanvas(10, 10);
const measureCtx = measureCanvas.getContext('2d');

// Printful's template marks the center of the 2700px wrap at x=1350 and
// the two visible faces at roughly x=587 and x=2112. The verified geometry
// lives with the product so the browser preview and print file share it.
const CLOUD_LAYOUTS = MUG_DUO.layoutGeometry;

function textElements(placed, offsetX, offsetY) {
  return placed.map((p) => {
    const x = p.x + offsetX;
    const y = p.y + offsetY;
    const rotate = p.rotated ? ` transform="rotate(-90 ${x.toFixed(1)} ${y.toFixed(1)})"` : '';
    return `<text x="${x.toFixed(1)}" y="${(y + p.fontPx * 0.34).toFixed(1)}" ` +
      `font-size="${p.fontPx.toFixed(1)}" font-family="${WordCloudCore.SVG_FONT_FAMILY}" ` +
      `fill="${p.color}" text-anchor="middle"${rotate}>${WordCloudCore.escapeXML(p.word)}</text>`;
  }).join('\n  ');
}

function layoutSlot(words, slot, colors) {
  const layoutHeight = slot.height || slot.side;
  const layoutWidth = slot.width || slot.side;
  const xScale = layoutWidth / layoutHeight;
  return WordCloudCore.layoutWords(words, layoutHeight, measureCtx, colors)
    .map((item) => ({ ...item, x: item.x * xScale }));
}

/**
 * Builds the exact 2700x1050 Printful print file for the verified 11oz mug.
 * The input words are an immutable configuration snapshot, never the live
 * event state, so a paid design cannot change while fulfillment is running.
 */
function buildMugPrintSvg(words, theme = 'pastel', layout = 'single') {
  if (!Array.isArray(words) || words.length === 0) {
    throw new Error('Cannot build a mug print without words');
  }
  const selectedTheme = MUG_DUO.themes.find((option) => option.key === theme) || MUG_DUO.themes[0];
  const slots = CLOUD_LAYOUTS[layout] || CLOUD_LAYOUTS.single;
  const { width, height } = MUG_DUO.printFile;

  const groups = slots.map((slot) => {
    const colors = WordCloudCore.makePaletteAssigner(selectedTheme.colors);
    const placed = layoutSlot(words, slot, colors);
    return `<g data-cloud="${layout}">\n  ${textElements(placed, slot.x, slot.y)}\n</g>`;
  }).join('\n');

  return `<?xml version="1.0" encoding="UTF-8"?>\n` +
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" ` +
    `viewBox="0 0 ${width} ${height}" data-background="transparent">\n` +
    `  ${groups}\n</svg>`;
}

module.exports = { buildMugPrintSvg, CLOUD_LAYOUTS };
