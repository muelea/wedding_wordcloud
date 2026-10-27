'use strict';

const { createCanvas } = require('canvas');
const DesignFonts = require('../../src/designFonts');

function richArtwork() {
  const styles = [];
  for (const fontWeight of [400, 700]) for (const fontStyle of ['normal', 'italic']) {
    for (const underline of [false, true]) for (const linethrough of [false, true]) {
      styles.push({ fontWeight, fontStyle, underline, linethrough });
    }
  }
  const elements = DesignFonts.FONTS.flatMap((font, row) => styles.map((style, column) => ({
    id: `audit-${font.key}-${column}`, type: 'text', text: 'Glück ❤️', fontFamily: font.key,
    fontSize: 27, x: 225 + column * 150, y: 150 + row * 105, angle: column % 2 ? 7 : -7,
    color: '#2455f5', ...style,
  })));
  for (const [index, mime] of ['image/png', 'image/jpeg'].entries()) {
    const image = createCanvas(32, 24);
    image.getContext('2d').fillStyle = index ? '#00ff00' : '#ff0000';
    image.getContext('2d').fillRect(0, 0, 32, 24);
    elements.push({ id: `audit-upload-${index}`, type: 'image', src: image.toDataURL(mime),
      width: 160, height: 120, x: 800 + index * 400, y: 810, angle: index ? -17 : 17 });
  }
  elements.push({ id: 'audit-flags', text: '🇨🇺 🇶🇦 👍🏽 👨‍👩‍👧‍👦', fontFamily: 'classic',
    fontSize: 100, x: 1850, y: 810, angle: 0, color: '#123456' });
  return elements;
}

module.exports = { richArtwork };
