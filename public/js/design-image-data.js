(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.DesignImageData = api;
})(typeof window === 'undefined' ? globalThis : window, function () {
  'use strict';
  const MAX_IMAGES = 20, MAX_BYTES = 10 * 1024 * 1024, MAX_PIXELS = 64_000_000;
  const MESSAGES = {
    images: 'Verwendet bitte höchstens 20 verschiedene Bilder pro Design.',
    bytes: 'Die Bilder sind zusammen zu groß. Verwendet höchstens 10 MB Bilddaten pro Design.',
    pixels: 'Die Bilder überschreiten zusammen 64 Megapixel. Entfernt ein Bild oder ladet Bilder mit geringerer Auflösung hoch.',
  };
  function sourceInfo(src) {
    const encoded = src.slice(src.indexOf(',') + 1);
    const bytes = typeof Buffer === 'function' ? Buffer.from(encoded, 'base64')
      : Uint8Array.from(atob(encoded), character => character.charCodeAt(0));
    const word = at => bytes[at] * 256 + bytes[at + 1];
    const integer = at => word(at) * 65536 + word(at + 2);
    if (src.startsWith('data:image/png;')) return { bytes: bytes.length, pixels: integer(16) * integer(20) };
    let offset = 2;
    while (offset + 4 <= bytes.length) {
      if (bytes[offset] !== 255) break;
      while (bytes[offset] === 255) offset++;
      const marker = bytes[offset++];
      if (marker === 217 || marker === 218) break;
      if (marker === 1 || (marker >= 208 && marker <= 215)) continue;
      const length = word(offset);
      if (length < 2 || offset + length > bytes.length) break;
      if ([192,193,194,195,197,198,199,201,202,203,205,206,207].includes(marker)) {
        return { bytes: bytes.length, pixels: word(offset + 3) * word(offset + 5) };
      }
      offset += length;
    }
    return { bytes: bytes.length, pixels: Infinity };
  }
  function imageSources(value) {
    const sources = new Set();
    function visit(item) {
      if (!item || typeof item !== 'object') return;
      if (item.type === 'image' && typeof item.src === 'string') sources.add(item.src);
      for (const child of Object.values(item)) if (child && typeof child === 'object') visit(child);
    }
    visit(value);
    return sources;
  }
  function measure(sources, cache = new Map()) {
    for (const src of cache.keys()) if (!sources.has(src)) cache.delete(src);
    let bytes = 0, pixels = 0;
    for (const src of sources) {
      const info = cache.get(src) || sourceInfo(src);
      if (cache.size < MAX_IMAGES) cache.set(src, info);
      bytes += info.bytes; pixels += info.pixels;
    }
    return { count: sources.size, bytes, pixels };
  }
  function usage(value, cache) { return measure(imageSources(value), cache); }
  function problem(value) {
    const sources = imageSources(value);
    if (sources.size > MAX_IMAGES) return MESSAGES.images;
    const { bytes, pixels } = measure(sources);
    if (bytes > MAX_BYTES) return MESSAGES.bytes;
    return pixels > MAX_PIXELS ? MESSAGES.pixels : null;
  }
  function pack(value) {
    const images = [], indices = new Map();
    const data = JSON.parse(JSON.stringify(value, (key, item) => {
      if (key !== 'src' || typeof item !== 'string' || !item.startsWith('data:image/')) return item;
      if (!indices.has(item)) { indices.set(item, images.length); images.push(item); }
      return `image:${indices.get(item)}`;
    }));
    return images.length ? { imagePacket: { version: 1, images, data } } : value;
  }
  function unpack(value) {
    if (!value?.imagePacket) return value;
    const packet = value.imagePacket;
    if (packet.version !== 1 || !Array.isArray(packet.images) || packet.images.length > MAX_IMAGES ||
        !packet.data || typeof packet.data !== 'object' || packet.images.some(src =>
          typeof src !== 'string' || !/^data:image\/(png|jpeg);base64,/.test(src)) ||
        packet.images.reduce((n, src) => n + src.length, 0) > Math.ceil(MAX_BYTES * 4 / 3) + MAX_IMAGES * 64) {
      throw new Error('invalid_image_packet');
    }
    return JSON.parse(JSON.stringify(packet.data), (key, item) => {
      if (key !== 'src' || typeof item !== 'string') return item;
      if (!/^image:(0|[1-9]\d*)$/.test(item)) throw new Error('invalid_image_packet');
      const src = packet.images[Number(item.slice(6))];
      if (!src) throw new Error('invalid_image_packet');
      return src;
    });
  }
  return { MAX_IMAGES, MAX_BYTES, MAX_PIXELS, MESSAGES, usage, problem, pack, unpack };
});
