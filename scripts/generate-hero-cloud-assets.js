'use strict';

// Committed public demo assets keep the landing page independent of seed files,
// organizer PINs, event creation and the database. Run after editing the examples.
const fs = require('node:fs/promises');
const path = require('node:path');
const { createCanvas, loadImage } = require('canvas');
const QRCode = require('qrcode');
require('../src/designFonts');
const Core = require('../public/js/wordcloud-core');
const Emoji = require('../public/js/emoji-catalog');
const { loadBrowserSvg } = require('../src/emojiBrowserAssets');
const { normalizeWord } = require('../src/words');
const { DEFAULT_PRODUCT } = require('../src/products');

const ROOT = path.join(__dirname, '..');
const LOCALES = ['de', 'en', 'fr', 'it', 'es', 'tr'];

async function generate() {
  const directory = path.join(ROOT, 'public/assets/hero-clouds');
  await fs.mkdir(directory, { recursive: true });
  await fs.writeFile(path.join(directory, 'home-qr.svg'), await QRCode.toString('https://wolkenworte.io', {
    type: 'svg', margin: 4, color: { dark: '#5a3e36', light: '#ffffff' },
  }));
  const palette = DEFAULT_PRODUCT.themes[0];
  for (const locale of LOCALES) {
    const filename = `classic-wedding${locale === 'de' ? '' : '-' + locale}.json`;
    const source = JSON.parse(await fs.readFile(path.join(ROOT, 'marketing/clouds', filename), 'utf8'));
    const words = new Map();
    for (const item of source.words) {
      const word = normalizeWord(item.word, locale);
      words.set(word, (words.get(word) || 0) + item.count);
    }
    const demo = {
      title: source.event.title,
      words: [...words],
      palette: { colors: palette.colors, background: palette.background },
    };
    await fs.writeFile(path.join(directory, locale + '.json'), JSON.stringify(demo) + '\n');

    // A real-engine, transparent fallback is visible before JS/fonts are ready,
    // and remains useful when scripting, canvas or an asset request is unavailable.
    const width = 400, height = 430, ratio = 2;
    const canvas = createCanvas(width * ratio, height * ratio);
    const ctx = canvas.getContext('2d');
    ctx.scale(ratio, ratio);
    const images = new Map();
    for (const [word] of demo.words) {
      for (const run of Emoji.parse(word).filter(run => run.type === 'emoji')) {
        if (!images.has(run.asset)) images.set(run.asset,
          await loadImage(Buffer.from(await loadBrowserSvg(run.asset))));
      }
    }
    const placed = Core.layoutWordsInArea(demo.words, width, height, ctx,
      Core.makePaletteAssigner(palette.colors));
    for (const item of placed) Core.drawPlacedWord(ctx, item, {
      emojiImage: run => images.get(run.asset),
    });
    await fs.writeFile(path.join(directory, locale + '.png'), canvas.toBuffer('image/png'));
  }
  console.log('Generated six localized hero clouds from the wedding examples.');
}

generate().catch(error => { console.error(error); process.exitCode = 1; });
