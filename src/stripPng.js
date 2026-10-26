'use strict';

const { createCanvas } = require('canvas');
const { createDeflate } = require('node:zlib');
const littleEndian = require('node:os').endianness() === 'LE';

const crcTable = Uint32Array.from({ length: 256 }, (_, value) => {
  for (let bit = 0; bit < 8; bit++) value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
  return value >>> 0;
});
function chunk(type, bytes) {
  const name = Buffer.from(type), output = Buffer.alloc(bytes.length + 12);
  output.writeUInt32BE(bytes.length); name.copy(output, 4); bytes.copy(output, 8);
  let crc = 0xffffffff;
  for (const byte of output.subarray(4, output.length - 4)) crc = crcTable[(crc ^ byte) & 255] ^ (crc >>> 8);
  output.writeUInt32BE((crc ^ 0xffffffff) >>> 0, output.length - 4);
  return output;
}

// PNG scanlines are compressed incrementally. Neither the complete RGBA bitmap
// nor the uncompressed PNG is retained for oversized provider print files.
async function stripPng({ width, height, paint, maxBytes, rows = 128 }) {
  const canvas = createCanvas(width, Math.min(height, rows)), context = canvas.getContext('2d');
  const deflate = createDeflate(), chunks = [];
  let bytes = 45;
  const complete = new Promise((resolve, reject) => {
    deflate.on('data', data => {
      const encoded = chunk('IDAT', data); bytes += encoded.length;
      if (bytes > maxBytes) {
        const error = new Error('Die erzeugte Druckdatei hat eine ungültige Größe.');
        error.code = 'PRINT_FILE_TOO_LARGE'; deflate.destroy(error);
      } else chunks.push(encoded);
    });
    deflate.once('end', resolve); deflate.once('error', reject);
  });
  complete.catch(() => {});
  try {
    for (let top = 0; top < height; top += rows) {
      const count = Math.min(rows, height - top);
      context.clearRect(0, 0, width, canvas.height);
      await paint(context, top, count);
      const raw = canvas.toBuffer('raw');
      const scanlines = Buffer.alloc((width * 4 + 1) * count);
      // Cairo PNG uses rounded unpremultiplication. getImageData truncates it,
      // which would darken antialiased edges after another PNG decode.
      for (let row = 0; row < count; row++) for (let x = 0; x < width; x++) {
        const i = (row * width + x) * 4, out = row * (width * 4 + 1) + 1 + x * 4;
        const alpha = raw[i + (littleEndian ? 3 : 0)];
        scanlines[out + 3] = alpha;
        if (alpha === 255) {
          scanlines[out] = raw[i + (littleEndian ? 2 : 1)];
          scanlines[out + 1] = raw[i + (littleEndian ? 1 : 2)];
          scanlines[out + 2] = raw[i + (littleEndian ? 0 : 3)];
        } else if (alpha) {
          scanlines[out] = Math.round(raw[i + (littleEndian ? 2 : 1)] * 255 / alpha);
          scanlines[out + 1] = Math.round(raw[i + (littleEndian ? 1 : 2)] * 255 / alpha);
          scanlines[out + 2] = Math.round(raw[i + (littleEndian ? 0 : 3)] * 255 / alpha);
        }
      }
      // Lossless horizontal prediction keeps large gradients and uploaded
      // photographs compact without retaining a preceding full-image row.
      for (let row = 0; row < count; row++) {
        const start = row * (width * 4 + 1);
        scanlines[start] = 1;
        for (let x = width * 4 - 1; x >= 4; x--) scanlines[start + 1 + x] =
          (scanlines[start + 1 + x] - scanlines[start + 1 + x - 4]) & 255;
      }
      await new Promise((resolve, reject) => deflate.write(scanlines, error => error ? reject(error) : resolve()));
    }
    deflate.end(); await complete;
    const header = Buffer.alloc(13);
    header.writeUInt32BE(width); header.writeUInt32BE(height, 4); header[8] = 8; header[9] = 6;
    return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', header), ...chunks, chunk('IEND', Buffer.alloc(0))]);
  } finally {
    deflate.destroy(); canvas.width = canvas.height = 0;
  }
}

module.exports = stripPng;
