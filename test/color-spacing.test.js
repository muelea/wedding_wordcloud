'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const WordCloudCore = require('../public/js/wordcloud-core');
const DesignLayout = require('../public/js/design-layout');

const PALETTE = ['#2455f5', '#ed2446', '#18a84b', '#efbf00', '#f77500', '#e600b8'];

function gridItems(columns, rows, colors = PALETTE) {
  return Array.from({ length: columns * rows }, (_, index) => ({
    id: `word-${index}`,
    x1: (index % columns) * 20,
    x2: (index % columns) * 20 + 15,
    y1: Math.floor(index / columns) * 20,
    y2: Math.floor(index / columns) * 20 + 15,
    color: colors[index % colors.length],
  }));
}

test('spatial palette assignment separates every surrounding grid neighbour', () => {
  const source = gridItems(5, 5);
  const first = WordCloudCore.spreadPaletteColors(source, PALETTE);
  const second = WordCloudCore.spreadPaletteColors(source, PALETTE);

  assert.deepEqual(second, first, 'the same geometry always receives the same colors');
  assert.notStrictEqual(first[0], source[0], 'the source design is not mutated');
  assert.deepEqual(new Set(first.map(item => item.color)), new Set(PALETTE));
  for (let index = 0; index < first.length; index += 1) {
    const row = Math.floor(index / 5);
    const column = index % 5;
    for (let other = index + 1; other < first.length; other += 1) {
      const otherRow = Math.floor(other / 5);
      const otherColumn = other % 5;
      if (Math.max(Math.abs(row - otherRow), Math.abs(column - otherColumn)) !== 1) continue;
      assert.notEqual(first[index].color, first[other].color,
        `${first[index].id} and ${first[other].id} must not form a same-color cluster`);
    }
  }
});

test('small palettes degrade predictably while locked choices remain authoritative', () => {
  const twoColors = PALETTE.slice(0, 2);
  const line = gridItems(8, 1, twoColors).map(item => ({ ...item, color: twoColors[0] }));
  const spread = WordCloudCore.spreadPaletteColors(line, twoColors);
  spread.slice(1).forEach((item, index) => {
    assert.notEqual(item.color, spread[index].color, 'two colors alternate along a simple row');
  });

  const locked = line.map((item, index) => index === 3
    ? { ...item, color: PALETTE[2], colorLocked: true }
    : item);
  const lockedSpread = WordCloudCore.spreadPaletteColors(locked, PALETTE.slice(0, 3));
  assert.equal(lockedSpread[3].color, PALETTE[2]);
  assert.equal(lockedSpread[3].colorLocked, true);
  assert.notEqual(lockedSpread[2].color, PALETTE[2]);
  assert.notEqual(lockedSpread[4].color, PALETTE[2]);

  const oneColor = WordCloudCore.spreadPaletteColors(line, [PALETTE[0]]);
  assert.ok(oneColor.every(item => item.color === PALETTE[0]));
});

test('product color spacing uses rotated design bounds and ignores uncolored artwork', () => {
  const measureContext = {
    font: '',
    measureText(text) { return { width: String(text).length * 10 }; },
  };
  const design = [
    { id: 'a', text: 'alpha', x: 50, y: 50, fontSize: 20, angle: 0, color: PALETTE[0], fontFamily: 'classic' },
    { id: 'b', text: 'beta', x: 100, y: 50, fontSize: 20, angle: 90, color: PALETTE[0], fontFamily: 'classic' },
    { id: 'locked', text: 'gamma', x: 150, y: 50, fontSize: 20, angle: 0,
      color: PALETTE[1], colorLocked: true, fontFamily: 'classic' },
    { id: 'emoji', text: '🫶', x: 200, y: 50, fontSize: 20, angle: 0, color: PALETTE[0], fontFamily: 'classic' },
    { id: 'photo', type: 'image', src: 'data:image/png;base64,x', x: 250, y: 50,
      width: 20, height: 20, angle: 0 },
  ];
  const spread = DesignLayout.spreadDesignColors(design, PALETTE.slice(0, 3), measureContext);

  assert.equal(spread.length, design.length);
  assert.notEqual(spread[0].color, spread[1].color);
  assert.equal(spread[2].color, PALETTE[1]);
  assert.equal(spread[2].colorLocked, true);
  assert.equal(spread[3].color, design[3].color, 'standalone emoji artwork has no palette fill');
  assert.equal('color' in spread[4], false, 'uploaded images remain untouched');
});

test('both pages route their finished geometry through the shared spatial palette', () => {
  const display = fs.readFileSync(path.join(__dirname, '../views/display.ejs'), 'utf8');
  const configure = fs.readFileSync(path.join(__dirname, '../views/configure.ejs'), 'utf8');
  const editor = fs.readFileSync(path.join(__dirname, '../public/js/mug-editor.js'), 'utf8');

  assert.match(display, /spreadPaletteColors\(placed, getWordColor\.palette\)/);
  assert.match(configure, /function buildAutomaticDesign[\s\S]*?spreadDesignColors\(/);
  assert.match(configure, /function fitCurrentDesignToArea[\s\S]*?spreadDesignColors\(/);
  assert.match(configure, /function applyPaletteAcrossSurfaces[\s\S]*?spreadDesignColors\(/);
  assert.match(editor, /applyPalette\(colors\)[\s\S]*?spreadDesignColors\(/);
});
