'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  buildEventUrl,
  renderEventQrDataUrl,
  renderEventQrSvg,
} = require('../src/eventQr');

test('event QR rendering uses one encoded canonical HTTP URL', async () => {
  const url = buildEventUrl('https://wolkenworte.io/ignored/path', 'wortwolke-g2t3q');
  assert.equal(url, 'https://wolkenworte.io/e/wortwolke-g2t3q');
  assert.throws(() => buildEventUrl('file:///tmp/wolkenworte', 'event'), /HTTP or HTTPS/);
  assert.throws(() => buildEventUrl('https://wolkenworte.io', ''), /slug is required/);

  const [svg, dataUrl] = await Promise.all([
    renderEventQrSvg(url),
    renderEventQrDataUrl(url),
  ]);
  assert.match(svg, /^<svg\b[^>]*viewBox="0 0 \d+ \d+"[^>]*>/);
  assert.match(svg, /<path\b/);
  assert.doesNotMatch(svg, /<script\b|<foreignObject\b/i);
  assert.match(dataUrl, /^data:image\/png;base64,/);
  assert.deepEqual(
    Buffer.from(dataUrl.slice(dataUrl.indexOf(',') + 1), 'base64').subarray(0, 8),
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
  );
});
