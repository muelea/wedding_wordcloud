'use strict';

const { createCanvas, loadImage, Image } = require('canvas');
const { buildProviderPrintSvg, isRenderablePrintDesign } = require('./mugPrint');
const stripPng = require('./stripPng');

const MIME_TYPE = 'image/png';
const MAX_ARTIFACT_BYTES = 40 * 1024 * 1024;

async function renderProviderPngInStrips(product, design) {
  const { width, height } = product.printFile, segments = [];
  if (!Number.isSafeInteger(width) || !Number.isSafeInteger(height) || width < 1 || height < 1 ||
      !isRenderablePrintDesign(design, width, height, product.designSafeMargin)) {
    throw new Error('Cannot build a print with an invalid design');
  }
  let vectors = [];
  function flush() {
    if (vectors.length) segments.push({ svg: buildProviderPrintSvg(product, vectors) });
    vectors = [];
  }
  for (const item of design) {
    if (item.type !== 'image') vectors.push(item);
    else { flush(); segments.push({ item, bytes: Buffer.from(item.src.slice(item.src.indexOf(',') + 1), 'base64') }); }
  }
  flush();
  // Reuse native Image objects so advancing through strips releases the
  // preceding SVG surface or decoded upload instead of awaiting native GC.
  const vectorImage = new Image(), rasterImage = new Image();
  const decode = (image, source) => new Promise((resolve, reject) => {
    image.onload = () => resolve(image); image.onerror = reject; image.src = source;
  });
  return stripPng({ width, height, maxBytes: MAX_ARTIFACT_BYTES, paint: async (context, top, rows) => {
    for (const segment of segments) {
      if (segment.svg) {
        const svg = segment.svg.replace(/<svg\b[^>]*>/, opening => opening
          .replace(/\bheight="\d+"/, `height="${rows}"`)
          .replace(/\bviewBox="[^"]*"/, `viewBox="0 ${top} ${width} ${rows}"`));
        context.drawImage(await decode(vectorImage, Buffer.from(svg)), 0, 0);
      } else {
        const { item } = segment, radius = Math.hypot(item.width, item.height) / 2;
        if (item.y + radius < top || item.y - radius > top + rows) continue;
        let image;
        try { image = await decode(rasterImage, segment.bytes); }
        catch {
          const error = new Error('Ein hochgeladenes Bild kann nicht für den Druck gelesen werden.');
          error.code = 'PRINT_IMAGE_INVALID'; throw error;
        }
        context.save(); context.translate(item.x, item.y - top); context.rotate(item.angle * Math.PI / 180);
        context.drawImage(image, -item.width / 2, -item.height / 2, item.width, item.height); context.restore();
      }
    }
  } });
}

/**
 * Render one immutable design surface into the exact transparent PNG supplied
 * to Printful. Operator mockups and paid fulfillment deliberately share this
 * function so neither path can introduce its own resolution or rasterization.
 */
async function renderProviderPng(product, design) {
  const width = Number(product?.printFile?.width);
  const height = Number(product?.printFile?.height);
  if (!Number.isSafeInteger(width) || !Number.isSafeInteger(height) ||
      width < 1 || height < 1) {
    throw new Error('Die gespeicherte Druckfläche ist ungültig.');
  }

  if (!isRenderablePrintDesign(design, width, height, product.designSafeMargin)) {
    throw new Error('Cannot build a print with an invalid design');
  }
  if (product.previewModel?.kind === 'canvas' && width * height > 40_000_000) {
    return renderProviderPngInStrips(product, design);
  }
  const canvas = createCanvas(width, height);
  const context = canvas.getContext('2d');
  const drawVectors = async (elements) => {
    if (!elements.length) return;
    const svg = Buffer.from(buildProviderPrintSvg(product, elements), 'utf8');
    context.drawImage(await loadImage(svg), 0, 0);
  };

  // The production librsvg runtime silently omits embedded raster <image>
  // elements. Decode uploads through canvas instead, interleaving vector runs
  // to preserve the exact approved stacking order. Decode errors abort the
  // artifact; a partial design must never be uploaded or sent for fulfillment.
  let vectors = [];
  for (const item of design) {
    if (item.type !== 'image') {
      vectors.push(item);
      continue;
    }
    await drawVectors(vectors);
    vectors = [];
    const source = Buffer.from(item.src.slice(item.src.indexOf(',') + 1), 'base64');
    let image;
    try {
      image = await loadImage(source);
    } catch {
      const error = new Error('Ein hochgeladenes Bild kann nicht für den Druck gelesen werden.');
      error.code = 'PRINT_IMAGE_INVALID';
      throw error;
    }
    context.save();
    context.translate(item.x, item.y);
    context.rotate(item.angle * Math.PI / 180);
    context.drawImage(image, -item.width / 2, -item.height / 2, item.width, item.height);
    context.restore();
  }
  await drawVectors(vectors);
  const bytes = await new Promise((resolve, reject) => {
    canvas.toBuffer((error, output) => error ? reject(error) : resolve(output), MIME_TYPE);
  });
  if (!bytes.length || bytes.length > MAX_ARTIFACT_BYTES) {
    const error = new Error('Die erzeugte Druckdatei hat eine ungültige Größe.');
    error.code = 'PRINT_FILE_TOO_LARGE';
    throw error;
  }
  return bytes;
}

module.exports = {
  MIME_TYPE,
  MAX_ARTIFACT_BYTES,
  renderProviderPng,
  renderProviderPngInStrips,
};
