'use strict';

const { createCanvas } = require('canvas');
const WordCloudCore = require('../public/js/wordcloud-core.js');
const MugIcons = require('../public/js/mug-icons.js');
const DesignFonts = require('./designFonts');
const { inspectRasterDataUrl } = require('./designImages');
const EmojiAssets = require('./emojiAssets');

const measureCanvas = createCanvas(10, 10);
const measureCtx = measureCanvas.getContext('2d');

const DESIGN_SAFE_MARGIN = 24;

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
    const textBox = WordCloudCore.measureTextBox(
      item.text,
      item.fontSize,
      measureCtx,
      DesignFonts.cssFamily(item.fontFamily),
      item
    );
    const styledBox = WordCloudCore.styledTextBox(textBox, item);
    itemWidth = styledBox.width;
    itemHeight = styledBox.height;
  }
  const radians = item.angle * Math.PI / 180;
  const cos = Math.abs(Math.cos(radians));
  const sin = Math.abs(Math.sin(radians));
  return {
    width: itemWidth * cos + itemHeight * sin,
    height: itemWidth * sin + itemHeight * cos,
  };
}

function isPrintDesignWithinBounds(
  design,
  width,
  height,
  safeMargin = DESIGN_SAFE_MARGIN
) {
  if (!Array.isArray(design) || design.length === 0 ||
      !Number.isFinite(width) || !Number.isFinite(height)) return false;
  return design.every((item) => {
    if (item.type === 'icon' && (!MugIcons.has(item.icon) || !Number.isFinite(item.size))) return false;
    if (item.type === 'image' && (!inspectRasterDataUrl(item.src) ||
        !Number.isFinite(item.width) || !Number.isFinite(item.height) ||
        item.width <= 0 || item.height <= 0)) return false;
    const bounds = getDesignBounds(item);
    const halfWidth = bounds.width / 2;
    const halfHeight = bounds.height / 2;
    return item.x - halfWidth >= safeMargin &&
      item.x + halfWidth <= width - safeMargin &&
      item.y - halfHeight >= safeMargin &&
      item.y + halfHeight <= height - safeMargin;
  });
}

function designElements(design) {
  return design.map((item, itemIndex) => {
    if (item.type === 'image') {
      const x = item.x - item.width / 2;
      const y = item.y - item.height / 2;
      const rotate = item.angle
        ? ` transform="rotate(${item.angle.toFixed(1)} ${item.x.toFixed(1)} ${item.y.toFixed(1)})"`
        : '';
      return `<image data-uploaded-image="true" x="${x.toFixed(1)}" y="${y.toFixed(1)}" ` +
        `width="${item.width.toFixed(1)}" height="${item.height.toFixed(1)}" ` +
        `preserveAspectRatio="none" href="${item.src}"${rotate}/>`;
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
    const fontKey = DesignFonts.normalizeKey(item.fontFamily);
    const textBox = WordCloudCore.measureTextBox(
      item.text,
      item.fontSize,
      measureCtx,
      DesignFonts.cssFamily(fontKey),
      item
    );
    const contents = WordCloudCore.richTextSvg(
      item.text,
      item.x,
      item.y,
      item.fontSize,
      item.color,
      DesignFonts.svgFamily(fontKey),
      textBox,
      {
        fontWeight: item.fontWeight,
        fontStyle: item.fontStyle,
        underline: item.underline,
        linethrough: item.linethrough,
        emojiSvg: (run, geometry) => EmojiAssets.inlineSvg(run, {
          ...geometry,
          id: `design-${itemIndex}-${item.id || 'item'}-${geometry.id}`,
        }),
      }
    );
    const tagged = `<g data-font="${fontKey}">${contents}</g>`;
    return item.angle
      ? `<g transform="rotate(${item.angle.toFixed(1)} ${item.x.toFixed(1)} ${item.y.toFixed(1)})">${tagged}</g>`
      : tagged;
  }).join('\n  ');
}

/** Builds the exact Printful file from the immutable canvas shown in preview. */
function buildProductPrintSvg(product, design) {
  if (!product?.printFile) throw new Error('Cannot build a print for an invalid product');
  const { width, height } = product.printFile;
  if (!isPrintDesignWithinBounds(design, width, height, product.designSafeMargin)) {
    throw new Error('Cannot build a print with an invalid design');
  }

  return `<?xml version="1.0" encoding="UTF-8"?>\n` +
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" ` +
    `viewBox="0 0 ${width} ${height}" data-background="transparent">\n` +
    DesignFonts.embeddedSvgFontFaces(design) +
    `  <g>\n  ${designElements(design)}\n</g>\n` +
    `</svg>`;
}

module.exports = {
  buildProductPrintSvg,
  isPrintDesignWithinBounds,
};
