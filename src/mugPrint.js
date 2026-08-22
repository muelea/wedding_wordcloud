'use strict';

const { createCanvas } = require('canvas');
const WordCloudCore = require('../public/js/wordcloud-core.js');
const MugIcons = require('../public/js/mug-icons.js');
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
  let itemWidth;
  let itemHeight;
  if (item.type === 'image') {
    itemWidth = item.width;
    itemHeight = item.height;
  } else if (item.type === 'icon') {
    itemWidth = item.size;
    itemHeight = item.size;
  } else {
    measureCtx.font = `${item.fontSize}px ${WordCloudCore.FONT_FAMILY}`;
    const metrics = measureCtx.measureText(item.text);
    itemWidth = Math.max(1, metrics.width);
    itemHeight = Math.max(1, item.fontSize);
  }
  const radians = item.angle * Math.PI / 180;
  const cos = Math.abs(Math.cos(radians));
  const sin = Math.abs(Math.sin(radians));
  return {
    width: itemWidth * cos + itemHeight * sin,
    height: itemWidth * sin + itemHeight * cos,
  };
}

function isMugDesignWithinBounds(design, width = MUG_DUO.printFile.width, height = MUG_DUO.printFile.height) {
  if (!Array.isArray(design) || design.length === 0) return false;
  return design.every((item) => {
    if (item.type === 'icon' && (!MugIcons.has(item.icon) || !Number.isFinite(item.size))) return false;
    if (item.type === 'image' &&
        (!Number.isFinite(item.width) || !Number.isFinite(item.height) || typeof item.src !== 'string')) {
      return false;
    }
    const bounds = getDesignBounds(item);
    const halfWidth = bounds.width / 2;
    const halfHeight = bounds.height / 2;
    return item.x - halfWidth >= DESIGN_SAFE_MARGIN &&
      item.x + halfWidth <= width - DESIGN_SAFE_MARGIN &&
      item.y - halfHeight >= DESIGN_SAFE_MARGIN &&
      item.y + halfHeight <= height - DESIGN_SAFE_MARGIN;
  });
}

function designElements(design) {
  return design.map((item) => {
    if (item.type === 'image') {
      const x = item.x - item.width / 2;
      const y = item.y - item.height / 2;
      const rotate = item.angle
        ? ` transform="rotate(${item.angle.toFixed(1)} ${item.x.toFixed(1)} ${item.y.toFixed(1)})"`
        : '';
      return `<image data-photo="true" x="${x.toFixed(1)}" y="${y.toFixed(1)}" ` +
        `width="${item.width.toFixed(1)}" height="${item.height.toFixed(1)}" ` +
        `href="${item.src}" preserveAspectRatio="none"${rotate}/>`;
    }
    if (item.type === 'icon') {
      const icon = MugIcons.get(item.icon);
      const scale = item.size / MugIcons.VIEWBOX_SIZE;
      const transform = `translate(${item.x.toFixed(1)} ${item.y.toFixed(1)}) ` +
        `rotate(${item.angle.toFixed(1)}) scale(${scale.toFixed(6)}) ` +
        `translate(${-MugIcons.VIEWBOX_SIZE / 2} ${-MugIcons.VIEWBOX_SIZE / 2})`;
      return `<path data-motif="${icon.id}" d="${icon.path}" fill="none" stroke="${item.color}" ` +
        `stroke-width="${MugIcons.STROKE_WIDTH}" stroke-linecap="round" stroke-linejoin="round" ` +
        `transform="${transform}"/>`;
    }
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
  if ((!Array.isArray(words) || words.length === 0) && !design) {
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
      `  <g data-cloud="${layout}" data-custom="true">\n  ${designElements(design)}\n</g>\n` +
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
