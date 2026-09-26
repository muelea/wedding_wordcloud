'use strict';

const { createCanvas, loadImage } = require('canvas');
const { buildProviderPrintSvg } = require('./mugPrint');

const MIME_TYPE = 'image/png';
const MAX_ARTIFACT_BYTES = 24 * 1024 * 1024;

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

  const svg = Buffer.from(buildProviderPrintSvg(product, design), 'utf8');
  const image = await loadImage(svg);
  const canvas = createCanvas(width, height);
  canvas.getContext('2d').drawImage(image, 0, 0);
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
};
