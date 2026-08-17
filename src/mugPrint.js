'use strict';

const { createCanvas } = require('canvas');
const WordCloudCore = require('../public/js/wordcloud-core.js');
const { MUG_DUO } = require('./products');

const measureCanvas = createCanvas(10, 10);
const measureCtx = measureCanvas.getContext('2d');

// Printful file 43 ends on either side of the handle. Its two visible face
// centres are roughly x=587 and x=2112; x=1350 is the back opposite the
// handle. The verified geometry lives with the product so the browser
// preview and print file share it.
const CLOUD_LAYOUTS = MUG_DUO.layoutGeometry;
const DESIGN_SAFE_MARGIN = 24;

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
  if (slot.optimize) {
    return WordCloudCore.layoutWordsInArea(words, layoutWidth, layoutHeight, measureCtx, colors);
  }
  const xScale = layoutWidth / layoutHeight;
  return WordCloudCore.layoutWords(words, layoutHeight, measureCtx, colors)
    .map((item) => ({ ...item, x: item.x * xScale }));
}

function getDesignBounds(item) {
  measureCtx.font = `${item.fontSize}px ${WordCloudCore.FONT_FAMILY}`;
  const metrics = measureCtx.measureText(item.text);
  const textWidth = Math.max(1, metrics.width);
  const textHeight = Math.max(1, item.fontSize);
  const radians = item.angle * Math.PI / 180;
  const cos = Math.abs(Math.cos(radians));
  const sin = Math.abs(Math.sin(radians));
  return {
    width: textWidth * cos + textHeight * sin,
    height: textWidth * sin + textHeight * cos,
  };
}

function isMugDesignWithinBounds(design, width = MUG_DUO.printFile.width, height = MUG_DUO.printFile.height) {
  if (!Array.isArray(design) || design.length === 0) return false;
  return design.every((item) => {
    const bounds = getDesignBounds(item);
    const halfWidth = bounds.width / 2;
    const halfHeight = bounds.height / 2;
    return item.x - halfWidth >= DESIGN_SAFE_MARGIN &&
      item.x + halfWidth <= width - DESIGN_SAFE_MARGIN &&
      item.y - halfHeight >= DESIGN_SAFE_MARGIN &&
      item.y + halfHeight <= height - DESIGN_SAFE_MARGIN;
  });
}

function designTextElements(design) {
  return design.map((item) => {
    const rotate = item.angle
      ? ` transform="rotate(${item.angle.toFixed(1)} ${item.x.toFixed(1)} ${item.y.toFixed(1)})"`
      : '';
    return `<text x="${item.x.toFixed(1)}" y="${(item.y + item.fontSize * 0.34).toFixed(1)}" ` +
      `font-size="${item.fontSize.toFixed(1)}" font-family="${WordCloudCore.SVG_FONT_FAMILY}" ` +
      `fill="${item.color}" text-anchor="middle"${rotate}>${WordCloudCore.escapeXML(item.text)}</text>`;
  }).join('\n  ');
}

/**
 * Builds the exact 2700x1050 Printful print file for the verified 11oz mug.
 * The input words are an immutable configuration snapshot, never the live
 * event state, so a paid design cannot change while fulfillment is running.
 */
function buildMugPrintSvg(words, theme = 'pastel', layout = 'single', design = null) {
  if (!Array.isArray(words) || words.length === 0) {
    throw new Error('Cannot build a mug print without words');
  }
  const selectedTheme = MUG_DUO.themes.find((option) => option.key === theme) || MUG_DUO.themes[0];
  const slots = CLOUD_LAYOUTS[layout] || CLOUD_LAYOUTS.single;
  const { width, height } = MUG_DUO.printFile;

  if (design) {
    if (!isMugDesignWithinBounds(design, width, height)) {
      throw new Error('Cannot build a mug print with an invalid design');
    }
    return `<?xml version="1.0" encoding="UTF-8"?>\n` +
      `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" ` +
      `viewBox="0 0 ${width} ${height}" data-background="transparent">\n` +
      `  <g data-cloud="${layout}" data-custom="true">\n  ${designTextElements(design)}\n</g>\n` +
      `</svg>`;
  }

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

module.exports = { buildMugPrintSvg, isMugDesignWithinBounds, CLOUD_LAYOUTS, DESIGN_SAFE_MARGIN };
