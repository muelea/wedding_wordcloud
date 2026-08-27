'use strict';

/**
 * Server-side SVG export, using the exact same layoutWords()/buildSVG()
 * engine as the browser (public/js/wordcloud-core.js) — so the mug print
 * file matches what the couple saw and downloaded from the display page.
 *
 * Text measurement uses `node-canvas`'s real CanvasRenderingContext2D
 * (same Canvas 2D spec the browser implements), not an approximation.
 *
 * History: an earlier pass here used a fixed average-character-width ratio
 * instead, reasoning that node-canvas's native-compile step conflicted with
 * this project's "agent-first, no ops team" operating philosophy. That
 * reasoning was wrong for
 * this specific decision: "agent-first" describes lean day-to-day
 * *operations* (support, marketing automation, no headcount watching a
 * server) — it doesn't mean avoiding a one-time build-step dependency for
 * a *correctness*-critical path. `export.svg` is what actually gets
 * printed on the physical products this business sells; an approximate
 * glyph width there means word positions in the mug print can visibly
 * differ from what the customer previewed and approved in their browser.
 * That risk to the paying product outweighs a native dependency that (see
 * README "Server-rendered fonts") installs cleanly via prebuilt binaries
 * with no compiler toolchain needed in this environment.
 */

// Registers the bundled Wolkenworte Classic serif before the measurement
// context is created, so Linux/Fly and local exports use identical metrics.
require('./designFonts');
const { createCanvas } = require('canvas');
const WordCloudCore = require('../public/js/wordcloud-core.js');

// A real CanvasRenderingContext2D used purely for text measurement. Pixel
// dimensions are irrelevant here (measureText() doesn't render anything) —
// reused across calls rather than created per-request since it's stateless
// aside from the `.font` the layout algorithm sets before each measurement,
// and layoutWords() is synchronous (no interleaving between requests).
const measureCanvas = createCanvas(10, 10);
const measureCtx = measureCanvas.getContext('2d');

function layoutForExport(words, theme, side = 2000) {
  const colorFn = WordCloudCore.makeColorAssigner(theme || 'pastel');
  const placed = WordCloudCore.layoutWords(words, side, measureCtx, colorFn);
  return WordCloudCore.buildSVG(placed, side, theme || 'pastel');
}

module.exports = { layoutForExport };
