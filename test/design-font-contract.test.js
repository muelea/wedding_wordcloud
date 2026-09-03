'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { createCanvas } = require('canvas');
const Fonts = require('../src/designFonts');
const { readFont } = require('./support/font-tables');

const LATIN_CHARACTERS = [...new Set(
  'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789' +
  'ÄÖÜäöüßÀÂÇÈÉÊËÎÏÔÙÛŸàâçèéêëîïôùûÿŒœÆæÀÈÉÌÒÙàèéìòùÁÉÍÑÓÚÜáéíñóúüĞİŞğış' +
  ' .,!?&:;()-–—„“”’\'€'
)];

function fontFile(font) {
  return font.packageFile ? require.resolve(font.packageFile)
    : path.join(__dirname, '..', 'public', font.file);
}

for (const font of Fonts.FONTS) {
  test(`${font.key}: the actual font contains basic Latin and every supported locale's letters`, () => {
    const table = readFont(fontFile(font));
    const missing = LATIN_CHARACTERS.filter(character => !table.glyph(character.codePointAt(0)));
    assert.deepEqual(missing, [], 'A loaded font file is not proof of supported glyphs');
  });

  test(`${font.key}: canvas uses that font's real glyph advances, not a platform fallback`, () => {
    const table = readFont(fontFile(font));
    const context = createCanvas(1, 1).getContext('2d');
    context.font = `100px ${font.cssFamily}`;
    for (const character of ['t', 'W', 'i', 'ä', 'é', 'ş', 'ı']) {
      const expected = table.advance(character);
      assert.notEqual(expected, null, `Missing glyph ${character}`);
      assert.ok(Math.abs(context.measureText(character).width - expected) < 0.03,
        `${font.key}/${character}: renderer width ${context.measureText(character).width} vs font advance ${expected}`);
    }
  });
}

test('print font loading rejects missing faces, failed downloads and timeouts instead of accepting fallback', async () => {
  await assert.rejects(Fonts.loadFont('classic', null), /unavailable/);
  await assert.rejects(Fonts.loadFont('classic', { load: async () => [] }), /unavailable/);
  await assert.rejects(Fonts.loadFont('classic', { load: async () => [{ status: 'unloaded' }] }), /unavailable/);
  await assert.rejects(Fonts.loadFont('classic', { load: async () => { throw new Error('network'); } }), /network/);
  await assert.rejects(Fonts.loadFont('classic', { load: () => new Promise(() => {}) }, 5), /timeout/);
  for (const font of Fonts.FONTS) {
    let requested;
    await Fonts.loadFont(font.key, { load: async (css, text) => {
      requested = [css, text];
      return [{ status: 'loaded' }];
    } });
    assert.deepEqual(requested, [`16px "${font.family}"`, 'Wolkenworte']);
  }
});
