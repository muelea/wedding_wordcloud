'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { createCanvas, loadImage } = require('canvas');
const { SUPPORTED_LOCALES, translate } = require('../src/i18n');

const ROOT = path.join(__dirname, '..');
const ASSET_DIRECTORY = path.join(ROOT, 'public', 'assets', 'social');
const SOURCE_FILE = path.join(ASSET_DIRECTORY, 'wolkenworte-share.svg');
const WIDTH = 1200;
const HEIGHT = 630;

const CARDS = Object.freeze({
  de: {
    documentTitle: 'Wolkenworte – Eure Erinnerungen in einem Wort',
    tagline: 'Gemeinsam sammeln · live erleben · für immer bewahren',
    note: 'Worte, die bleiben.',
    sizes: { titleLineOne: 64, titleLineTwo: 60, tagline: 22, note: 25 },
  },
  en: {
    documentTitle: 'Wolkenworte – Your memories in one word',
    tagline: 'Collect together · experience it live · keep it forever',
    note: 'Words that stay.',
    sizes: { titleLineOne: 64, titleLineTwo: 52, tagline: 20, note: 25 },
  },
  fr: {
    documentTitle: 'Wolkenworte – Vos souvenirs en un mot',
    tagline: 'Créer ensemble · vivre en direct · garder pour toujours',
    note: 'Des mots qui restent.',
    sizes: { titleLineOne: 64, titleLineTwo: 51, tagline: 19, note: 23 },
  },
  it: {
    documentTitle: 'Wolkenworte – I vostri ricordi in una parola',
    tagline: 'Creare insieme · vivere in diretta · conservare per sempre',
    note: 'Parole che restano.',
    sizes: { titleLineOne: 60, titleLineTwo: 52, tagline: 18, note: 23 },
  },
  es: {
    documentTitle: 'Wolkenworte – Vuestros recuerdos en una palabra',
    tagline: 'Crear juntos · vivirlo en directo · conservar para siempre',
    note: 'Palabras que perduran.',
    sizes: { titleLineOne: 64, titleLineTwo: 52, tagline: 18, note: 22 },
  },
  tr: {
    documentTitle: 'Wolkenworte – Anılarınız tek kelimede',
    tagline: 'Birlikte toplayın · canlı yaşayın · sonsuza dek saklayın',
    note: 'Kalıcı sözler.',
    sizes: { titleLineOne: 64, titleLineTwo: 57, tagline: 18, note: 25 },
  },
});

function escapeXml(value) {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&apos;');
}

function replaceExactlyOnce(source, expression, replacement, label) {
  const matches = source.match(expression);
  if (!matches || matches.length !== 1) {
    throw new Error(`Expected exactly one ${label} placeholder in ${SOURCE_FILE}`);
  }
  return source.replace(expression, replacement);
}

function replaceTextElement(source, key, value, fontSize) {
  const expression = new RegExp(`<text([^>]*data-social-text="${key}"[^>]*)>[^<]*<\\/text>`, 'g');
  return replaceExactlyOnce(source, expression, (element, attributes) => {
    const resizedAttributes = attributes.replace(/font-size="[^"]+"/, `font-size="${fontSize}"`);
    return `<text${resizedAttributes}>${escapeXml(value)}</text>`;
  }, key);
}

function renderSvg(source, card) {
  let output = replaceExactlyOnce(
    source,
    /<title>[^<]*<\/title>/g,
    `<title>${escapeXml(card.documentTitle)}</title>`,
    'document title',
  );
  output = replaceTextElement(output, 'title-line-one', card.titleLineOne, card.sizes.titleLineOne);
  output = replaceTextElement(output, 'title-line-two', card.titleLineTwo, card.sizes.titleLineTwo);
  output = replaceTextElement(output, 'tagline', card.tagline, card.sizes.tagline);
  return replaceTextElement(output, 'note', card.note, card.sizes.note);
}

async function main() {
  const source = fs.readFileSync(SOURCE_FILE, 'utf8');
  const configuredLocales = Object.keys(CARDS);
  if (configuredLocales.join(',') !== SUPPORTED_LOCALES.join(',')) {
    throw new Error(
      `Social preview locales (${configuredLocales}) must match supported locales (${SUPPORTED_LOCALES})`,
    );
  }
  for (const locale of SUPPORTED_LOCALES) {
    const card = {
      ...CARDS[locale],
      titleLineOne: translate('Eine Wolke', locale),
      titleLineTwo: translate('voller Glück.', locale),
    };
    const svg = renderSvg(source, card);
    const pngFile = path.join(ASSET_DIRECTORY, `wolkenworte-share-${locale}.png`);

    const image = await loadImage(Buffer.from(svg));
    const canvas = createCanvas(WIDTH, HEIGHT);
    canvas.getContext('2d').drawImage(image, 0, 0, WIDTH, HEIGHT);
    const png = canvas.toBuffer('image/png');
    fs.writeFileSync(pngFile, png);
    // Keep the original German URL valid for previews cached before locale-specific assets existed.
    if (locale === 'de') {
      fs.writeFileSync(path.join(ASSET_DIRECTORY, 'wolkenworte-share.png'), png);
    }
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
