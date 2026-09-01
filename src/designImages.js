'use strict';

const MAX_IMAGE_BYTES = 1_250_000;
const MAX_IMAGE_PIXEL_DIMENSION = 4096;
const MAX_IMAGE_PIXELS = 16_000_000;

function pngDimensions(bytes) {
  const signature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  if (bytes.length < 45 || !bytes.subarray(0, 8).equals(signature) ||
      bytes.toString('ascii', 12, 16) !== 'IHDR') return null;
  const width = bytes.readUInt32BE(16);
  const height = bytes.readUInt32BE(20);
  let offset = 8;
  let foundEnd = false;
  while (offset + 12 <= bytes.length) {
    const length = bytes.readUInt32BE(offset);
    const end = offset + 12 + length;
    if (end > bytes.length) return null;
    if (bytes.toString('ascii', offset + 4, offset + 8) === 'IEND') {
      foundEnd = length === 0 && end === bytes.length;
      break;
    }
    offset = end;
  }
  return foundEnd ? { width, height } : null;
}

function jpegDimensions(bytes) {
  if (bytes.length < 4 || bytes[0] !== 0xff || bytes[1] !== 0xd8 ||
      bytes[bytes.length - 2] !== 0xff || bytes[bytes.length - 1] !== 0xd9) return null;
  const frameMarkers = new Set([
    0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7,
    0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf,
  ]);
  let offset = 2;
  while (offset + 4 <= bytes.length) {
    if (bytes[offset] !== 0xff) return null;
    while (offset < bytes.length && bytes[offset] === 0xff) offset += 1;
    const marker = bytes[offset];
    offset += 1;
    if (marker === 0xd9 || marker === 0xda) break;
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) continue;
    if (offset + 2 > bytes.length) return null;
    const length = bytes.readUInt16BE(offset);
    if (length < 2 || offset + length > bytes.length) return null;
    if (frameMarkers.has(marker)) {
      if (length < 7) return null;
      return {
        width: bytes.readUInt16BE(offset + 5),
        height: bytes.readUInt16BE(offset + 3),
      };
    }
    offset += length;
  }
  return null;
}

function inspectRasterDataUrl(value) {
  if (typeof value !== 'string' || value.length > Math.ceil(MAX_IMAGE_BYTES * 4 / 3) + 64) return null;
  const match = /^data:(image\/(?:png|jpeg));base64,([A-Za-z0-9+/]+={0,2})$/.exec(value);
  if (!match) return null;
  const bytes = Buffer.from(match[2], 'base64');
  if (!bytes.length || bytes.length > MAX_IMAGE_BYTES || bytes.toString('base64') !== match[2]) return null;
  const dimensions = match[1] === 'image/png' ? pngDimensions(bytes) : jpegDimensions(bytes);
  if (!dimensions || !Number.isSafeInteger(dimensions.width) || !Number.isSafeInteger(dimensions.height) ||
      dimensions.width < 1 || dimensions.height < 1 ||
      dimensions.width > MAX_IMAGE_PIXEL_DIMENSION || dimensions.height > MAX_IMAGE_PIXEL_DIMENSION ||
      dimensions.width * dimensions.height > MAX_IMAGE_PIXELS) return null;
  return { mimeType: match[1], byteSize: bytes.length, ...dimensions };
}

module.exports = {
  MAX_IMAGE_BYTES,
  MAX_IMAGE_PIXEL_DIMENSION,
  MAX_IMAGE_PIXELS,
  inspectRasterDataUrl,
};
