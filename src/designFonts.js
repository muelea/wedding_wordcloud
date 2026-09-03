'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { registerFont } = require('canvas');
const DesignFonts = require('../public/js/design-fonts.js');

const PUBLIC_DIR = path.join(__dirname, '..', 'public');
const embeddedFontData = new Map();

for (const font of DesignFonts.FONTS) {
  if (!font.file) continue;
  const filePath = font.packageFile
    ? require.resolve(font.packageFile)
    : path.join(PUBLIC_DIR, font.file.replace(/^\//, ''));
  registerFont(filePath, { family: font.family, weight: 'normal', style: 'normal' });
  embeddedFontData.set(`${font.key}:400`, fs.readFileSync(filePath).toString('base64'));
  const boldPath = path.join(PUBLIC_DIR, font.boldFile.replace(/^\//, ''));
  registerFont(boldPath, { family: font.family, weight: 'bold', style: 'normal' });
  embeddedFontData.set(`${font.key}:700`, fs.readFileSync(boldPath).toString('base64'));
}

function embeddedSvgFontFaces(design) {
  const variants = [...new Set((Array.isArray(design) ? design : [])
    .filter((item) => item && item.type !== 'image' && item.type !== 'icon')
    .map((item) => `${DesignFonts.normalizeKey(item.fontFamily)}:${item.fontWeight === 700 ? 700 : 400}`))];
  if (!variants.length) return '';
  const rules = variants.map((variant) => {
    const [key, weightText] = variant.split(':');
    const weight = Number(weightText);
    const font = DesignFonts.get(key);
    const mime = font.format === 'woff' ? 'font/woff' : 'font/ttf';
    const data = embeddedFontData.get(variant);
    return `@font-face{font-family:'${font.family}';src:url(data:${mime};base64,${data}) ` +
      `format('${font.format || 'truetype'}');font-weight:${weight};font-style:normal;}`;
  });
  return `  <defs><style type="text/css"><![CDATA[${rules.join('')}]]></style></defs>\n`;
}

module.exports = Object.freeze({ ...DesignFonts, embeddedSvgFontFaces });
