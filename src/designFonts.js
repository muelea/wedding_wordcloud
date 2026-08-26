'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { registerFont } = require('canvas');
const DesignFonts = require('../public/js/design-fonts.js');

const PUBLIC_DIR = path.join(__dirname, '..', 'public');
const embeddedFontData = new Map();

for (const font of DesignFonts.FONTS) {
  if (!font.file) continue;
  const filePath = path.join(PUBLIC_DIR, font.file.replace(/^\//, ''));
  registerFont(filePath, { family: font.family, weight: 'normal', style: 'normal' });
  embeddedFontData.set(font.key, fs.readFileSync(filePath).toString('base64'));
}

function embeddedSvgFontFaces(design) {
  const keys = [...new Set((Array.isArray(design) ? design : [])
    .filter((item) => item && item.type !== 'image' && item.type !== 'icon')
    .map((item) => DesignFonts.normalizeKey(item.fontFamily))
    .filter((key) => key !== DesignFonts.DEFAULT_FONT_KEY))];
  if (!keys.length) return '';
  const rules = keys.map((key) => {
    const font = DesignFonts.get(key);
    const data = embeddedFontData.get(key);
    return `@font-face{font-family:'${font.family}';src:url(data:font/ttf;base64,${data}) ` +
      `format('truetype');font-weight:400;font-style:normal;}`;
  });
  return `  <defs><style type="text/css"><![CDATA[${rules.join('')}]]></style></defs>\n`;
}

module.exports = Object.freeze({ ...DesignFonts, embeddedSvgFontFaces });
