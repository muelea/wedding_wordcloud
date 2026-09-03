'use strict';

// Test-only, independent SFNT reader: proves glyph coverage and advance widths
// from the font file itself, rather than comparing two platform fallbacks.
const fs = require('node:fs');
const zlib = require('node:zlib');

function readFont(filename) {
  const bytes = fs.readFileSync(filename);
  const woff = bytes.toString('ascii', 0, 4) === 'wOFF';
  const count = bytes.readUInt16BE(woff ? 12 : 4);
  const tables = new Map();
  for (let i = 0; i < count; i += 1) {
    const pos = (woff ? 44 : 12) + i * (woff ? 20 : 16);
    const tag = bytes.toString('ascii', pos, pos + 4);
    const offset = bytes.readUInt32BE(pos + (woff ? 4 : 8));
    const length = bytes.readUInt32BE(pos + (woff ? 8 : 12));
    const raw = bytes.subarray(offset, offset + length);
    tables.set(tag, woff && length !== bytes.readUInt32BE(pos + 12)
      ? zlib.inflateSync(raw) : raw);
  }
  const cmap = tables.get('cmap');
  const subtables = [];
  for (let i = 0; i < cmap.readUInt16BE(2); i += 1) {
    const platform = cmap.readUInt16BE(4 + 8 * i);
    const encoding = cmap.readUInt16BE(6 + 8 * i);
    if (platform !== 0 && !(platform === 3 && [1, 10].includes(encoding))) continue;
    const offset = cmap.readUInt32BE(8 + 8 * i);
    const format = cmap.readUInt16BE(offset);
    if (format === 4 || format === 12) subtables.push({ offset, format });
  }

  function glyph(codepoint) {
    for (const { offset: o, format } of subtables) {
      if (format === 12) {
        const groups = cmap.readUInt32BE(o + 12);
        for (let i = 0; i < groups; i += 1) {
          const pos = o + 16 + i * 12;
          const start = cmap.readUInt32BE(pos);
          if (codepoint >= start && codepoint <= cmap.readUInt32BE(pos + 4)) {
            return cmap.readUInt32BE(pos + 8) + codepoint - start;
          }
        }
      } else if (codepoint <= 0xffff) {
        const segments = cmap.readUInt16BE(o + 6) / 2;
        for (let i = 0; i < segments; i += 1) {
          const end = cmap.readUInt16BE(o + 14 + i * 2);
          const start = cmap.readUInt16BE(o + 16 + segments * 2 + i * 2);
          if (codepoint < start || codepoint > end) continue;
          const delta = cmap.readInt16BE(o + 16 + segments * 4 + i * 2);
          const rangePos = o + 16 + segments * 6 + i * 2;
          const range = cmap.readUInt16BE(rangePos);
          if (!range) return (codepoint + delta) & 0xffff;
          const index = cmap.readUInt16BE(rangePos + range + (codepoint - start) * 2);
          return index ? (index + delta) & 0xffff : 0;
        }
      }
    }
    return 0;
  }

  const unitsPerEm = tables.get('head').readUInt16BE(18);
  const horizontalMetrics = tables.get('hhea').readUInt16BE(34);
  function advance(character, size = 100) {
    const index = glyph(character.codePointAt(0));
    if (!index) return null;
    return tables.get('hmtx').readUInt16BE(Math.min(index, horizontalMetrics - 1) * 4) * size / unitsPerEm;
  }
  return { glyph, advance };
}

module.exports = { readFont };
