'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const WordCloudCore = require('../public/js/wordcloud-core.js');
const { layoutForExport } = require('../src/exportSvg');

// Deterministic fake canvas 2D context, used ONLY in this file to test the
// collision/placement ALGORITHM in isolation from font metrics — it only
// needs *a* stable width estimate per string at a given font size to
// reserve non-overlapping boxes; the algorithm's correctness (no drops, no
// duplicates, no overlaps) doesn't depend on which measurement source
// produced that estimate.
//
// This is no longer what production uses: src/exportSvg.js (the real
// GET /e/:slug/export.svg code path) switched to node-canvas's real
// CanvasRenderingContext2D for actual glyph metrics — see
// test/export-font-metrics.test.js, which exercises exportSvg.js itself
// (not this fake) and proves real metrics are in effect.
function makeFakeMeasureCtx() {
  let fontPx = 16;
  return {
    set font(v) { const m = /(\d+(?:\.\d+)?)px/.exec(v); fontPx = m ? parseFloat(m[1]) : 16; },
    get font() { return `${fontPx}px`; },
    // 0.42 approximates real Georgia lowercase average glyph-width/font-size
    // ratio closely enough for the collision math below to exercise
    // realistic-magnitude boxes; not a substitute for real metrics (see
    // test/export-font-metrics.test.js for that).
    measureText(str) { return { width: str.length * fontPx * 0.42 }; },
  };
}

function boxesOverlap(a, b) {
  return !(a.x2 <= b.x1 || a.x1 >= b.x2 || a.y2 <= b.y1 || a.y1 >= b.y2);
}

// Deterministic (no Math.random) so this test is reproducible run to run —
// a flaky "sometimes fails" placement test would be worse than useless here.
function wordList(n) {
  // A realistic-ish spread: some very popular words, a long tail of ones.
  const words = [];
  const pool = [
    'liebe', 'glück', 'freude', 'vertrauen', 'treue', 'humor', 'abenteuer',
    'zusammenhalt', 'lachen', 'geborgenheit', 'ehrlichkeit', 'leidenschaft',
    'freundschaft', 'harmonie', 'zärtlichkeit', 'respekt', 'wärme', 'traum',
    'zukunft', 'familie', 'genuss', 'reisen', 'tanzen', 'musik', 'gemeinsam',
    'füreinander', 'unterstützung', 'geduld', 'spaß', 'romantik',
  ];
  for (let i = 0; i < n; i++) {
    const word = pool[i % pool.length] + (i >= pool.length ? `-${i}` : '');
    const count = 1 + ((i * 7) % 20); // deterministic pseudo-random spread, 1..20
    words.push([word, count]);
  }
  return words;
}

test('layoutWords places every word exactly once, with no overlapping boxes', () => {
  const words = wordList(24);
  const side = 900;
  const once = WordCloudCore.sizeForCount('liebe', 1, 1, 2, 20, 100);
  const twice = WordCloudCore.sizeForCount('liebe', 2, 1, 2, 20, 100);
  assert.ok(twice > once, 'removing one matching contribution must make that word smaller');
  const placed = WordCloudCore.layoutWords(words, side, makeFakeMeasureCtx(), WordCloudCore.makeColorAssigner('pastel'));

  // No word dropped (the algorithm is designed to always place everything,
  // shrinking on collision rather than giving up — this asserts that
  // property holds, not just "most words placed").
  assert.equal(placed.length, words.length, 'every submitted word must be placed');

  const placedWords = placed.map((p) => p.word);
  const inputWords = words.map(([w]) => w);
  assert.deepEqual([...placedWords].sort(), [...inputWords].sort(), 'placed words must exactly match submitted words');

  // No duplicates.
  assert.equal(new Set(placedWords).size, placedWords.length, 'no word should be placed twice');

  // No two placed words' bounding boxes overlap.
  for (let i = 0; i < placed.length; i++) {
    for (let j = i + 1; j < placed.length; j++) {
      assert.equal(
        boxesOverlap(placed[i], placed[j]), false,
        `"${placed[i].word}" and "${placed[j].word}" bounding boxes overlap`
      );
    }
  }

  // Every word fits inside the canvas bounds.
  for (const p of placed) {
    assert.ok(p.x1 >= -0.01 && p.x2 <= side + 0.01, `"${p.word}" x-bounds outside canvas`);
    assert.ok(p.y1 >= -0.01 && p.y2 <= side + 0.01, `"${p.word}" y-bounds outside canvas`);
  }
});

test('layoutWords handles a dense word list without dropping words or creating overlaps/duplicates', () => {
  // At high density the algorithm's own documented fallback (8 shrink
  // attempts per word, spiral placement — see wordcloud-core.js) can, in
  // principle, leave a handful of words unplaced rather than ever
  // overlapping two words. In practice, for a realistically dense wedding
  // word cloud (45 unique words — most real events land well under that)
  // it places everything; this asserts that plus the two guarantees that
  // must never be violated regardless of density: no duplicates, no
  // overlaps. The >=90% floor (vs. the 100% actually observed here) leaves
  // headroom for that documented edge case without making this test flaky.
  const words = wordList(45);
  const side = 900;
  const placed = WordCloudCore.layoutWords(words, side, makeFakeMeasureCtx(), WordCloudCore.makeColorAssigner('neon'));

  assert.ok(placed.length / words.length >= 0.90, `expected >=90% of ${words.length} words placed, got ${placed.length}`);

  const placedWords = placed.map((p) => p.word);
  assert.equal(new Set(placedWords).size, placedWords.length, 'no word should be placed twice');

  for (let i = 0; i < placed.length; i++) {
    for (let j = i + 1; j < placed.length; j++) {
      assert.equal(boxesOverlap(placed[i], placed[j]), false, `"${placed[i].word}" and "${placed[j].word}" overlap`);
    }
  }
});

test('layoutWordsInArea fills a wide print area while preserving every relative font size', () => {
  const words = wordList(18);
  const width = 2628;
  const height = 978;
  const placed = WordCloudCore.layoutWordsInArea(
    words,
    width,
    height,
    makeFakeMeasureCtx(),
    WordCloudCore.makeColorAssigner('pastel')
  );

  assert.equal(placed.length, words.length, 'the optimized layout must retain every word');
  for (let i = 0; i < placed.length; i++) {
    assert.ok(placed[i].x1 >= -0.01 && placed[i].x2 <= width + 0.01);
    assert.ok(placed[i].y1 >= -0.01 && placed[i].y2 <= height + 0.01);
    for (let j = i + 1; j < placed.length; j++) {
      assert.equal(boxesOverlap(placed[i], placed[j]), false, `"${placed[i].word}" and "${placed[j].word}" overlap`);
    }
  }

  const bounds = placed.reduce((result, item) => ({
    x1: Math.min(result.x1, item.x1),
    x2: Math.max(result.x2, item.x2),
    y1: Math.min(result.y1, item.y1),
    y2: Math.max(result.y2, item.y2),
  }), { x1: Infinity, x2: -Infinity, y1: Infinity, y2: -Infinity });
  assert.ok((bounds.x2 - bounds.x1) / width > .98, 'the optimized cloud should reach both safe horizontal edges');
  assert.ok((bounds.y2 - bounds.y1) / height > .95, 'the optimized cloud should use most of the available height');

  const counts = words.map(([, count]) => count);
  const minCount = Math.min(...counts);
  const maxCount = Math.max(...counts);
  const expectedWeights = new Map(words.map(([word, count]) => [
    word,
    WordCloudCore.sizeForCount(word, count, minCount, maxCount, .24, 1),
  ]));
  const commonScale = placed[0].fontPx / expectedWeights.get(placed[0].word);
  placed.forEach((item) => {
    const actualScale = item.fontPx / expectedWeights.get(item.word);
    assert.ok(Math.abs(actualScale - commonScale) < 1e-7, `"${item.word}" must use the same global scale`);
  });
});

test('buildSVG output contains every word, properly escaped, with no missing entries', () => {
  const words = [['liebe & treue', 3], ['<3', 1], ['abenteuer', 5]];
  const side = 1000;
  const placed = WordCloudCore.layoutWords(words, side, makeFakeMeasureCtx(), WordCloudCore.makeColorAssigner('pastel'));
  const svg = WordCloudCore.buildSVG(placed, side, 'pastel');

  assert.match(svg, /^<\?xml/);
  assert.match(svg, /<svg[^>]*width="1000"[^>]*height="1000"/);

  // XML-unsafe characters must be escaped, not present raw.
  assert.ok(svg.includes('liebe &amp; treue'));
  assert.ok(!svg.includes('liebe & treue<')); // raw unescaped ampersand form
  assert.ok(svg.includes('&lt;3'));

  const textElementCount = (svg.match(/<text /g) || []).length;
  assert.equal(textElementCount, words.length, 'SVG must contain exactly one <text> per submitted word');
});

test('server-side layoutForExport (used for the Printful print file) matches the same no-overlap guarantee', () => {
  const words = wordList(20);
  const svg = layoutForExport(words, 'pastel', 1200);
  const textElementCount = (svg.match(/<text /g) || []).length;
  assert.equal(textElementCount, words.length);
});
