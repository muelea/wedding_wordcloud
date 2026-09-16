'use strict';

const { createCanvas } = require('canvas');
const opentype = require('opentype.js');
const WordCloudCore = require('../public/js/wordcloud-core.js');
const MugIcons = require('../public/js/mug-icons.js');
const DesignFonts = require('./designFonts');
const { inspectRasterDataUrl } = require('./designImages');
const EmojiAssets = require('./emojiAssets');

const measureCanvas = createCanvas(10, 10);
const measureCtx = measureCanvas.getContext('2d');

const DESIGN_SAFE_MARGIN = 24;
const outlineFonts = new Map();

function outlineFont(fontKey, weight) {
  const normalizedWeight = weight === 700 ? 700 : 400;
  const cacheKey = `${DesignFonts.normalizeKey(fontKey)}:${normalizedWeight}`;
  if (!outlineFonts.has(cacheKey)) {
    outlineFonts.set(cacheKey, opentype.loadSync(
      DesignFonts.fontFilePath(fontKey, normalizedWeight)
    ));
  }
  return outlineFonts.get(cacheKey);
}

function glyphSymbol(fontKey, weight, font, glyph, symbols) {
  const id = `ww-glyph-${DesignFonts.normalizeKey(fontKey)}-${weight}-${glyph.index}`;
  if (!symbols.has(id)) {
    const path = glyph.getPath(0, 0, font.unitsPerEm).toPathData(2);
    symbols.set(id, path ? `<path id="${id}" d="${path}"/>` : '');
  }
  return symbols.get(id) ? id : null;
}

/**
 * Convert shaped local-font glyphs to shared SVG paths. Symbols are deduplicated
 * across the complete design, which keeps the largest allowed word clouds well
 * below the immutable artifact limit while removing every runtime font lookup.
 */
function outlinedTextRun(text, x, baseline, runWidth, fontPx, fontKey, color, item, symbols) {
  if (!String(text).trim()) return '';
  const weight = item?.fontWeight === 700 ? 700 : 400;
  const font = outlineFont(fontKey, weight);
  const fontScale = fontPx / font.unitsPerEm;
  const uses = [];
  const cursor = font.forEachGlyph(text, 0, 0, fontPx, {}, (glyph, glyphX) => {
    const id = glyphSymbol(fontKey, weight, font, glyph, symbols);
    if (id) uses.push(`<g transform="translate(${glyphX.toFixed(4)} 0)"><use href="#${id}" ` +
      `transform="scale(${fontScale.toFixed(8)})"/></g>`);
  });
  if (!uses.length || cursor <= 0) throw new Error('Cannot convert print text to vector outlines');
  const widthScale = runWidth / cursor;
  return `<g data-outlined-text="true" fill="${color}" ` +
    `transform="translate(${x.toFixed(3)} ${baseline.toFixed(3)}) ` +
    `scale(${widthScale.toFixed(8)} 1)">${uses.join('')}</g>`;
}

function outlinedRichTextSvg(
  text,
  x,
  y,
  fontPx,
  color,
  fontKey,
  textBox,
  item,
  emojiSvg,
  symbols
) {
  const style = WordCloudCore.textStyle(item);
  const startX = x - textBox.width / 2;
  const contents = textBox.runs.map((run, index) => {
    const runX = startX + run.x;
    if (run.type === 'emoji') {
      return emojiSvg(run, {
        x: runX,
        y: y - fontPx * WordCloudCore.EMOJI_SIZE_RATIO / 2,
        width: run.width,
        height: fontPx * WordCloudCore.EMOJI_SIZE_RATIO,
        id: `emoji-${index}`,
      });
    }
    const path = outlinedTextRun(
      run.text,
      runX,
      y + fontPx * WordCloudCore.TEXT_BASELINE_OFFSET,
      run.width,
      fontPx,
      fontKey,
      color,
      style,
      symbols
    );
    const decorations = [
      ...(style.underline ? [fontPx * .48] : []),
      ...(style.linethrough ? [fontPx * .03] : []),
    ].map((offset) => `<line x1="${runX.toFixed(1)}" y1="${(y + offset).toFixed(1)}" ` +
      `x2="${(runX + run.width).toFixed(1)}" y2="${(y + offset).toFixed(1)}" ` +
      `stroke="${color}" stroke-width="${Math.max(1, fontPx * .055).toFixed(1)}"/>`).join('\n  ');
    return decorations ? `${path}\n  ${decorations}` : path;
  }).join('\n  ');
  if (style.fontStyle !== 'italic') return contents;
  return `<g transform="translate(${x.toFixed(1)} ${y.toFixed(1)}) ` +
    `skewX(${WordCloudCore.ITALIC_SKEW_DEGREES}) translate(${(-x).toFixed(1)} ${(-y).toFixed(1)})">` +
    `${contents}</g>`;
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
  const area = typeof safeMargin === 'number'
    ? { x: safeMargin, y: safeMargin, width: width - safeMargin * 2, height: height - safeMargin * 2 }
    : safeMargin;
  if (!area || ![area.x, area.y, area.width, area.height].every(Number.isFinite) ||
      area.x < 0 || area.y < 0 || area.width <= 0 || area.height <= 0 ||
      area.x + area.width > width || area.y + area.height > height) return false;
  return design.every((item) => {
    if (item.type === 'icon' && (!MugIcons.has(item.icon) || !Number.isFinite(item.size))) return false;
    if (item.type === 'image' && (!inspectRasterDataUrl(item.src) ||
        !Number.isFinite(item.width) || !Number.isFinite(item.height) ||
        item.width <= 0 || item.height <= 0)) return false;
    const bounds = getDesignBounds(item);
    const halfWidth = bounds.width / 2;
    const halfHeight = bounds.height / 2;
    return item.x - halfWidth >= area.x &&
      item.x + halfWidth <= area.x + area.width &&
      item.y - halfHeight >= area.y &&
      item.y + halfHeight <= area.y + area.height;
  });
}

function designElements(design, { outlineText = false, outlineSymbols = null } = {}) {
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
    const emojiSvg = (run, geometry) => EmojiAssets.inlineSvg(run, {
      ...geometry,
      id: `design-${itemIndex}-${item.id || 'item'}-${geometry.id}`,
    });
    const contents = outlineText
      ? outlinedRichTextSvg(
          item.text,
          item.x,
          item.y,
          item.fontSize,
          item.color,
          fontKey,
          textBox,
          item,
          emojiSvg,
          outlineSymbols
        )
      : WordCloudCore.richTextSvg(
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
            emojiSvg,
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
  // Approved snapshots retain their original geometry as catalog safe areas
  // evolve. New saves enforce the current per-surface areas in events.js.
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

/** Builds the provider artifact with every font glyph frozen as vector paths. */
function buildProviderPrintSvg(product, design) {
  if (!product?.printFile) throw new Error('Cannot build a print for an invalid product');
  const { width, height } = product.printFile;
  if (!isPrintDesignWithinBounds(design, width, height, product.designSafeMargin)) {
    throw new Error('Cannot build a print with an invalid design');
  }
  const outlineSymbols = new Map();
  const elements = designElements(design, { outlineText: true, outlineSymbols });
  const definitions = [...outlineSymbols.values()].filter(Boolean).join('');
  return `<?xml version="1.0" encoding="UTF-8"?>\n` +
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" ` +
    `viewBox="0 0 ${width} ${height}" data-background="transparent" ` +
    `data-font-rendering="outlined">\n` +
    `  ${definitions ? `<defs>${definitions}</defs>\n` : ''}` +
    `  <g>\n  ${elements}\n</g>\n` +
    `</svg>`;
}

module.exports = {
  buildProductPrintSvg,
  buildProviderPrintSvg,
  isPrintDesignWithinBounds,
};
