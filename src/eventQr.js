'use strict';

const QRCode = require('qrcode');

const QR_OPTIONS = Object.freeze({
  width: 220,
  margin: 1,
  color: Object.freeze({ dark: '#5a3e36', light: '#fdf8f4' }),
});

function buildEventUrl(baseUrl, slug) {
  const normalizedSlug = String(slug || '').trim();
  if (!normalizedSlug) throw new TypeError('event slug is required');

  const base = new URL(String(baseUrl || ''));
  if (base.protocol !== 'http:' && base.protocol !== 'https:') {
    throw new TypeError('event base URL must use HTTP or HTTPS');
  }
  return new URL(`/e/${encodeURIComponent(normalizedSlug)}`, base).toString();
}

async function renderEventQrSvg(url) {
  return QRCode.toString(url, { ...QR_OPTIONS, type: 'svg' });
}

async function renderEventQrDataUrl(url) {
  return QRCode.toDataURL(url, QR_OPTIONS);
}

module.exports = {
  buildEventUrl,
  renderEventQrDataUrl,
  renderEventQrSvg,
};
