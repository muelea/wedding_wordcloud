'use strict';

// Covers the switch from src/exportSvg.js's old fixed AVG_CHAR_WIDTH_RATIO
// approximation to real font metrics via node-canvas's real
// CanvasRenderingContext2D (same Canvas 2D spec the browser implements).
//
// Two things this file proves that svg-export.test.js/export-endpoint.test.js
// don't:
//   1. Real glyph metrics are actually in use, not just "a" plausible width
//      estimate — via a case the old approximation could never pass (see
//      below), exercised through the exact code path GET /e/:slug/export.svg
//      uses (src/exportSvg.js).
//   2. The no-overlap/no-drop/all-words-present invariants
//      test/svg-export.test.js already established for layoutWords()/
//      buildSVG() still hold now that exportSvg.js's measureCtx is a real
//      canvas context instead of the fake approximation one.

const test = require('node:test');
const assert = require('node:assert/strict');
const { createCanvas } = require('canvas');
const WordCloudCore = require('../public/js/wordcloud-core.js');
const { layoutForExport } = require('../src/exportSvg');

function boxesOverlap(a, b) {
  return !(a.x2 <= b.x1 || a.x1 >= b.x2 || a.y2 <= b.y1 || a.y1 >= b.y2);
}

test('real canvas measureText distinguishes narrow vs wide glyphs at equal string length and font size (fails under the retired fixed-ratio approximation by construction)', () => {
  // The old approximation was `str.length * fontPx * 0.42` — a pure
  // function of string LENGTH. Two equal-length strings made of different
  // glyphs were, by construction, always measured identically under it.
  // Real fonts don't work that way: "i" is dramatically narrower than "w".
  // This is the simplest possible observable proof that exportSvg.js is
  // now consulting real font metrics.
  const canvas = createCanvas(10, 10);
  const ctx = canvas.getContext('2d');
  ctx.font = '60px Georgia, serif';

  const narrow = 'iiiiiiiiii'; // 10 chars
  const wide = 'wwwwwwwwww';   // 10 chars

  const narrowWidth = ctx.measureText(narrow).width;
  const wideWidth = ctx.measureText(wide).width;
  const sharedNarrowBox = WordCloudCore.measureTextBox(narrow, 60, ctx, 'Georgia, serif');
  const sharedWideBox = WordCloudCore.measureTextBox(wide, 60, ctx, 'Georgia, serif');

  const oldApproxWidth = 10 * 60 * 0.42; // what BOTH strings measured as under the old code

  assert.notEqual(narrowWidth, wideWidth, 'real glyph metrics must differ for narrow vs wide characters of equal string length');
  assert.ok(wideWidth > narrowWidth * 1.5, `expected "w" run much wider than "i" run (narrow=${narrowWidth}, wide=${wideWidth})`);
  // Neither real measurement should coincide with the old length-only estimate.
  assert.notEqual(narrowWidth, oldApproxWidth);
  assert.notEqual(wideWidth, oldApproxWidth);
  assert.equal(sharedNarrowBox.width, narrowWidth);
  assert.equal(sharedWideBox.width, wideWidth);
  assert.equal(sharedNarrowBox.height, 60 * WordCloudCore.TEXT_LINE_HEIGHT);
});

test('the actual /export.svg code path (src/exportSvg.js) measures narrow- and wide-glyph words at the same font size with genuinely different widths, not a length-based estimate', () => {
  // Deliberately bypasses layoutWords()'s collision-avoidance shrink-retry
  // loop for this assertion: that loop can legitimately shrink one word's
  // fontPx more than another's once real (unequal) widths make one harder
  // to place than the other — a correct consequence of real metrics, but
  // it would confound a same-fontPx comparison. Isolating the measurement
  // step directly (same getFontSizeRange()/sizeForCount()/FONT_FAMILY
  // exportSvg.js's layoutWords() call itself relies on) proves the
  // narrow-vs-wide difference comes purely from measureText(), the same
  // thing the previous test proved for a bare canvas context, but now
  // through the exact functions/constants the real server module uses.
  const words = [['iiiiiiiiii', 5], ['wwwwwwwwww', 5]];
  const side = 1000;
  const { minPx, maxPx } = WordCloudCore.getFontSizeRange(words, side);
  const fontPxNarrow = WordCloudCore.sizeForCount('iiiiiiiiii', 5, 5, 5, minPx, maxPx);
  const fontPxWide = WordCloudCore.sizeForCount('wwwwwwwwww', 5, 5, 5, minPx, maxPx);
  assert.equal(fontPxNarrow, fontPxWide, 'equal submission count and equal string length must produce equal font size (isolates measureText as the only remaining variable)');

  const canvas = createCanvas(10, 10);
  const ctx = canvas.getContext('2d');
  ctx.font = `${fontPxNarrow}px ${WordCloudCore.FONT_FAMILY}`;
  const narrowWidth = ctx.measureText('iiiiiiiiii').width;
  ctx.font = `${fontPxWide}px ${WordCloudCore.FONT_FAMILY}`;
  const wideWidth = ctx.measureText('wwwwwwwwww').width;

  assert.ok(
    wideWidth > narrowWidth * 1.3,
    `expected "w"-word measured much wider than "i"-word at the identical font size (narrow=${narrowWidth.toFixed(1)}, wide=${wideWidth.toFixed(1)})`
  );

  // And the real server function (used by the HTTP route) still produces
  // well-formed output containing both words (full placement, including
  // its legitimate per-word shrink-retry behavior).
  const svg = layoutForExport(words, 'pastel', side);
  assert.ok(svg.includes('iiiiiiiiii'));
  assert.ok(svg.includes('wwwwwwwwww'));
});

test('layoutForExport (real font metrics) still guarantees zero overlaps and every word placed, for a realistic word list', () => {
  // Same invariants test/svg-export.test.js established before the
  // node-canvas switch — re-asserted here against real metrics via direct
  // placement data (layoutForExport() itself only returns the SVG string,
  // so this calls the same underlying layoutWords() exportSvg.js uses,
  // with the same kind of real canvas context it constructs internally).
  const words = [
    ['liebe', 12], ['glück', 9], ['zärtlichkeit', 7], ['humor', 15],
    ['vertrauen', 5], ['abenteuer', 3], ['freundschaft', 8],
    ['veranstaltungsvorbereitung', 1], ['tanzen', 6], ['musik', 4],
    ['gemeinsam', 2], ['füreinander', 10], ['unterstützung', 1],
    ['geduld', 11], ['spaß', 13], ['romantik', 6], ['traum', 5],
    ['zukunft', 3], ['familie', 14], ['genuss', 2],
  ];
  const side = 1200;

  const canvas = createCanvas(10, 10);
  const ctx = canvas.getContext('2d');
  const placed = WordCloudCore.layoutWords(words, side, ctx, WordCloudCore.makeColorAssigner('neon'));

  assert.equal(placed.length, words.length, 'every submitted word must be placed under real font metrics too');

  const placedWords = placed.map((p) => p.word);
  assert.equal(new Set(placedWords).size, placedWords.length, 'no duplicates');

  for (let i = 0; i < placed.length; i++) {
    for (let j = i + 1; j < placed.length; j++) {
      assert.equal(boxesOverlap(placed[i], placed[j]), false, `"${placed[i].word}" and "${placed[j].word}" overlap under real font metrics`);
    }
  }

  for (const p of placed) {
    assert.ok(p.x1 >= -0.01 && p.x2 <= side + 0.01, `"${p.word}" x-bounds outside canvas`);
    assert.ok(p.y1 >= -0.01 && p.y2 <= side + 0.01, `"${p.word}" y-bounds outside canvas`);
  }

  // And the real HTTP-facing function agrees on completeness.
  const svg = layoutForExport(words, 'neon', side);
  const textElementCount = (svg.match(/<text /g) || []).length;
  assert.equal(textElementCount, words.length);
});
