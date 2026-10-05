'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const { createCanvas } = require('canvas');
const fabric = require('fabric/node');
const Fonts = require('../src/designFonts');
const Core = require('../public/js/wordcloud-core');
const Layout = require('../public/js/design-layout');
const Emoji = require('../public/js/emoji-catalog');
const Limits = require('../public/js/cloud-limits');
const { getProduct, resolveProductOrientation } = require('../src/products');
const { isPrintDesignWithinBounds } = require('../src/mugPrint');
const { occupiedFraction, largestEmptyFraction } = require('./support/layout-space');

// October 2 report. Actual vote counts are not visible in the screenshots.
const SCREENSHOT = ['bier, mehr bier', 'lebkuchenherz', 'wiesn 2025',
  'daniel ging’s nicht so gut', 'flohzirkus', 'echt? spiegelkabinett?',
  '❤️', '🍻', '🥨', '🎤'].map(word => [word, 1]);
// Reconstruct the dense report with plausible weights, not its unknown votes.
const DENSE_SCREENSHOT = ['reisen', 'abenteuer', 'zukunft', 'geduld', 'treue', 'familie',
  'leichtigkeit', 'zärtlichkeit', 'füreinander', 'ehrlichkeit', 'humor', 'gemeinsam',
  'glück', '❤️', 'romantik', 'tanzen', 'wärme', 'gesundheit', 'lachen', 'liebe',
  'vertrauen', 'freundschaft', '✨', 'zusammenhalt', 'respekt', 'freude', 'hand in hand',
  'geborgenheit', 'unvergesslich', 'immer füreinander', '🥂', 'leidenschaft',
  'sonntagsfrühstück', 'lieblingsmenschen', 'offene türen', 'tanzfläche', 'urlaub am meer',
  'mitternachtssnack', 'lange gespräche', 'gemeinsam alt werden'].map((word, index) =>
  [word, ['liebe', 'glück', 'familie', 'lachen', 'freude'].includes(word) ? 6 : index < 28 ? 3 : 1]);
const context = createCanvas(1, 1).getContext('2d');
const options = { fontFamily: item => Fonts.cssFamily(item.fontFamily) };
const template = fs.readFileSync(require.resolve('../views/configure.ejs'), 'utf8');
const start = template.indexOf('    function buildAutomaticDesign(');
const automaticSource = template.slice(start, template.indexOf('    function cloneDesign(', start));

function automatic(product, words) {
  // Exercise the real page controller. Live placement is deliberately made
  // unavailable, proving the product has its own placement decision.
  return JSON.parse(JSON.stringify(vm.runInNewContext(automaticSource + '\nbuildAutomaticDesign()', {
    product, productView: () => product, activeSurface: product.printSurfaces[0].key,
    words, WordCloudCore: { ...Core, layoutWordsInArea() { throw new Error('Live placement must not build print designs'); } },
    DesignLayout: Layout, DesignFonts: Fonts, CloudLimits: Limits,
    document: { createElement: () => createCanvas(1, 1) }, selectedTheme: 'konfetti',
    getPalette: () => ({ colors: ['#f77500', '#ed2446', '#2455f5', '#18a84b', '#efbf00', '#e600b8'] }),
    makePaletteAssigner: Core.makePaletteAssigner,
  })));
}

function boxes(design) {
  return design.map(item => {
    const size = item.type === 'image' ? { width: item.width, height: item.height }
      : item.type === 'icon' ? { width: item.size, height: item.size }
      : Core.styledTextBox(Core.measureTextBox(item.text, item.fontSize, context,
        Fonts.cssFamily(item.fontFamily), item), item);
    const radians = (item.angle || 0) * Math.PI / 180;
    const width = size.width * Math.abs(Math.cos(radians)) + size.height * Math.abs(Math.sin(radians));
    const height = size.height * Math.abs(Math.cos(radians)) + size.width * Math.abs(Math.sin(radians));
    return { width, height, emoji: Core.isEmojiOnly(item.text),
      x1: item.x - width / 2, x2: item.x + width / 2, y1: item.y - height / 2, y2: item.y + height / 2 };
  });
}

function assertSafe(design, product) {
  assert.ok(isPrintDesignWithinBounds(design, product.printFile.width, product.printFile.height,
    product.designSafeAreas?.[product.printSurfaces[0].key] || product.designSafeMargin));
  const measured = boxes(design);
  for (const [index, box] of measured.entries()) {
    for (const other of measured.slice(0, index)) assert.ok(box.x1 >= other.x2 || box.x2 <= other.x1 ||
      box.y1 >= other.y2 || box.y2 <= other.y1, 'every measured element stays separate');
  }
}

function assertBreathingRoom(design) {
  const measured = visibleBoxes(design);
  for (const [index, box] of measured.entries()) {
    for (const [otherIndex, other] of measured.slice(0, index).entries()) {
      const across = Math.max(0, box.x1 - other.x2, other.x1 - box.x2);
      const down = Math.max(0, box.y1 - other.y2, other.y1 - box.y2);
      const shortSide = Math.min(box.width, box.height, other.width, other.height);
      assert.ok(across >= shortSide * .065 || down >= shortSide * .065,
        `${design[index].text} and ${design[otherIndex].text} need a visible gap`);
    }
  }
}

function parallelVerticalPairs(design, slot) {
  const measured = boxes(design);
  const vertical = measured.map((box, index) => ({ ...box, item: design[index] }))
    .filter(({ item }) => Math.abs(item.angle) === 90 && !Core.isEmojiOnly(item.text));
  const pairs = [];
  vertical.forEach((box, index) => vertical.slice(0, index).forEach(other => {
    const overlap = Math.min(box.y2, other.y2) - Math.max(box.y1, other.y1);
    const across = Math.max(0, box.x1 - other.x2, other.x1 - box.x2);
    if (overlap > Math.min(box.height, other.height) * .25 &&
        across < Math.max(Math.min(slot.width, slot.height) * .07, Math.min(box.width, other.width) * 1.25)) {
      pairs.push([box.item.text, other.item.text]);
    }
  }));
  return pairs;
}

function visibleBoxes(design) {
  return design.map((item, index) => {
    if (item.type === 'image' || item.type === 'icon' || item.fontStyle === 'italic' ||
        item.underline || item.linethrough) return boxes(design)[index];
    const measured = Core.measureTextBox(item.text, item.fontSize, context, Fonts.cssFamily(item.fontFamily), item);
    const ink = context.measureText(item.text);
    const emoji = Core.isEmojiOnly(item.text);
    const left = emoji ? -item.fontSize / 2 : -measured.width / 2 - ink.actualBoundingBoxLeft;
    const right = emoji ? item.fontSize / 2 : -measured.width / 2 + ink.actualBoundingBoxRight;
    const top = emoji ? -item.fontSize / 2 : item.fontSize * Core.TEXT_BASELINE_OFFSET - ink.actualBoundingBoxAscent;
    const bottom = emoji ? item.fontSize / 2 : item.fontSize * Core.TEXT_BASELINE_OFFSET + ink.actualBoundingBoxDescent;
    const angle = (item.angle || 0) * Math.PI / 180;
    const points = [[left, top], [left, bottom], [right, top], [right, bottom]].map(([x, y]) =>
      [item.x + x * Math.cos(angle) - y * Math.sin(angle), item.y + x * Math.sin(angle) + y * Math.cos(angle)]);
    const x1 = Math.min(...points.map(point => point[0])), x2 = Math.max(...points.map(point => point[0]));
    const y1 = Math.min(...points.map(point => point[1])), y2 = Math.max(...points.map(point => point[1]));
    return { x1, x2, y1, y2, width: x2 - x1, height: y2 - y1 };
  });
}

function facingGaps(design) {
  const measured = visibleBoxes(design);
  const gaps = { x: [], y: [] };
  for (const [index, box] of measured.entries()) for (const axis of ['x', 'y']) {
    const cross = axis === 'x' ? 'y' : 'x';
    let nearest = Infinity;
    for (const [otherIndex, other] of measured.entries()) {
      if (otherIndex === index || Math.min(box[cross + '2'], other[cross + '2']) <=
          Math.max(box[cross + '1'], other[cross + '1'])) continue;
      const gap = other[axis + '1'] - box[axis + '2'];
      if (gap >= 0) nearest = Math.min(nearest, gap);
    }
    if (Number.isFinite(nearest)) gaps[axis].push(nearest);
  }
  return gaps;
}

test('the second pass equalizes visible gaps in both axes and uses the bounded size allowance', () => {
  const size = Core.measureTextBox('liebe', 100, context, Fonts.cssFamily('classic'));
  const slot = { x: 0, y: 0, width: size.width * 3 + 200, height: size.height * 3 + 60 };
  const first = Array.from({ length: 9 }, (_, index) => {
    const column = index % 3, row = Math.floor(index / 3);
    return { id: String(index), text: 'liebe', fontSize: 100, layoutFontSize: 100, fontFamily: 'classic', angle: 0,
      x: 30 + size.width / 2 + column * size.width + [0, 10, 140][column],
      y: 10 + size.height / 2 + row * size.height + [0, 2, 40][row] };
  });
  const frozen = JSON.parse(JSON.stringify(first));
  const balanced = Layout.balancePrintSpacing(first, slot, context, options.fontFamily);
  assert.deepEqual(first, frozen, 'the first-stage design is not mutated');
  const before = Object.values(facingGaps(first)).flat();
  const after = Object.values(facingGaps(balanced)).flat();
  assert.ok(Math.max(...before) / Math.min(...before) > 5, 'the fixture has markedly unequal gaps');
  assert.ok(Math.max(...after) / Math.min(...after) < 1.3, 'left/right and top/bottom share approximately the same visible gap');
  assert.ok(balanced.some((item, index) => item.x !== first[index].x) &&
    balanced.some((item, index) => item.y !== first[index].y), 'both axes are refined');
  assert.ok(balanced.some(item => item.fontSize !== 100), 'size adjustment helps close pockets');
  balanced.forEach((item, index) => {
    assert.equal(item.id, first[index].id);
    assert.equal(item.text, first[index].text);
    assert.equal(item.layoutFontSize, 100);
    assert.ok(item.fontSize >= 80 && item.fontSize <= 120);
  });
  boxes(balanced).forEach((box, index, measured) => {
    assert.ok(box.x1 >= 0 && box.x2 <= slot.width && box.y1 >= 0 && box.y2 <= slot.height);
    measured.slice(0, index).forEach(other => assert.ok(box.x1 >= other.x2 || box.x2 <= other.x1 ||
      box.y1 >= other.y2 || box.y2 <= other.y1));
  });
});

test('print fill measures sparse coverage against the whole safe area', () => {
  const measured = [{ width: 120, height: 120, x1: 440, x2: 560, y1: 90, y2: 210 }];
  assert.equal(Layout.printLayoutQuality(measured, 1000, 300).coverage, .048);
  assert.ok(Layout.printLayoutQuality(measured, 1000, 300).emptyRegion > .4);
});

test('the reported mug fills the full safe area independently of live placement', () => {
  const product = getProduct('white-glossy-mug-duo-11oz');
  const slot = product.layoutGeometry['fit-area'][0];
  const design = automatic(product, SCREENSHOT);
  assert.deepEqual(design.map(item => item.text).sort(), SCREENSHOT.map(([word]) => word).sort());
  assertSafe(design, product);
  assertBreathingRoom(design);
  assert.ok(design.some(item => Math.abs(item.angle) === 90 && !Core.isEmojiOnly(item.text)), 'vertical words are included');
  const area = { x1: slot.x, y1: slot.y, x2: slot.x + slot.width, y2: slot.y + slot.height };
  assert.ok(occupiedFraction(boxes(design), area) > .6, 'more than twice the reconstructed 27% box coverage, with gutters');
  assert.ok(largestEmptyFraction(boxes(design), area) < .05, 'large empty bands are closed');
  assert.equal(design.find(item => item.text === 'echt? spiegelkabinett?').angle, 0,
    'the long phrase no longer imposes a vertical height limit');
  for (let click = 0; click < 5; click++) assert.deepEqual(Layout.applyLayoutAction(
    JSON.parse(JSON.stringify(design)), [slot], context, options), design);
});

test('dense print layouts reserve space between horizontal, vertical and staggered neighbors', () => {
  const product = getProduct('white-glossy-mug-duo-11oz');
  const slot = product.layoutGeometry['fit-area'][0];
  const design = automatic(product, DENSE_SCREENSHOT);
  assert.deepEqual(design.map(item => item.text).sort(), DENSE_SCREENSHOT.map(([word]) => word).sort());
  assertSafe(design, product);
  assertBreathingRoom(design);
  assert.ok(occupiedFraction(boxes(design), { x1: slot.x, y1: slot.y,
    x2: slot.x + slot.width, y2: slot.y + slot.height }) > .5, 'spacing still uses the whole surface well');
  assert.ok(design.find(item => item.text === 'liebe').fontSize >
    design.find(item => item.text === 'mitternachtssnack').fontSize * 1.5);
  assert.deepEqual(Layout.applyLayoutAction(JSON.parse(JSON.stringify(design)), [slot], context, options), design);
});

test('the exact classic-wedding seed keeps its leading words staggered instead of in a central column', () => {
  const seed = require('../scripts/seed-local-cloud').normalizeSeedDocument(
    require('../marketing/clouds/classic-wedding.json'));
  const product = getProduct('white-glossy-mug-duo-11oz');
  const slot = product.layoutGeometry['fit-area'][0];
  const ordered = seed.words.slice().sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1));
  const databaseOrdered = seed.words.slice().sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0], 'en'));
  for (const words of [seed.words, ordered, databaseOrdered]) {
    const design = automatic(product, words);
    assert.deepEqual(design.map(item => item.text).sort(), words.map(([word]) => word).sort());
    assertSafe(design, product);
    assertBreathingRoom(design);
    const vertical = design.filter(item => Math.abs(item.angle) === 90 && !Core.isEmojiOnly(item.text));
    const text = design.filter(item => !Core.isEmojiOnly(item.text));
    assert.ok(vertical.length >= 5 && vertical.length <= 10,
      'a forty-entry cloud has a visible mix of orientations with a horizontal majority');
    assert.ok(text.length - vertical.length > vertical.length * 2, 'horizontal words remain the clear majority');
    assert.ok(Math.max(...vertical.map(item => item.x)) - Math.min(...vertical.map(item => item.x)) > slot.width * .5,
      'vertical words are distributed across the print rather than clustered');
    assert.ok(vertical.some(item => item.x > slot.x + slot.width * .2 && item.x < slot.x + slot.width * .8),
      'the vertical words also participate in the interior instead of only framing the edges');
    assert.ok(parallelVerticalPairs(design, slot).length <= 1,
      'vertical words are interspersed rather than placed in repeated parallel banks');
    const measured = boxes(design);
    const quality = Layout.printLayoutQuality(measured.map(box => ({ ...box,
      x1: box.x1 - slot.x, x2: box.x2 - slot.x, y1: box.y1 - slot.y, y2: box.y2 - slot.y })),
    slot.width, slot.height);
    assert.ok(quality.alignment <= .1, 'prominent aligned stacks do not win on density alone');
    assert.ok(quality.coverage > .5 && quality.emptyRegion < .05, 'the staggered layout still uses the print area');
    const leading = ['liebe', 'glück', 'familie', 'freude'].map(word =>
      design.find(item => item.text.toLocaleLowerCase('de') === word));
    assert.ok(leading.every(item => item.angle === 0), 'prominent words stay readable horizontally');
    assert.ok(Math.max(...leading.map(item => item.x)) - Math.min(...leading.map(item => item.x)) > slot.width * .35,
      'the leading words spread across the surface: ' + JSON.stringify(leading.map(item => [item.text, item.x])));
    const preferred = new Map(Core.measureWords(words, context).map(item => [item.word, item.fontPx]));
    const scales = design.map(item => item.fontSize / preferred.get(item.text));
    assert.ok(Math.max(...scales) / Math.min(...scales) < 1.20 / .80 + .003,
      'the real seed preserves its count-based importance within the allowed adjustment');
    assert.deepEqual(Layout.applyLayoutAction(JSON.parse(JSON.stringify(design)), [slot], context, options), design);
  }
});

test('lowercase wedding words include short, staggered vertical accents rather than repeated tall strips', () => {
  const seed = require('../scripts/seed-local-cloud').normalizeSeedDocument(
    require('../marketing/clouds/classic-wedding.json'));
  const words = seed.words.map(([word, count]) => [word.toLocaleLowerCase('de'), count]);
  const product = getProduct('white-glossy-mug-duo-11oz');
  const slot = product.layoutGeometry['fit-area'][0];
  const filled = automatic(product, words);
  assertSafe(filled, product);
  assertBreathingRoom(filled);
  const vertical = filled.filter(item => Math.abs(item.angle) === 90 && !Core.isEmojiOnly(item.text));
  assert.ok(vertical.length >= 5 && vertical.length <= 10);
  assert.ok(vertical.some(item => item.text.length <= 5), 'short words can also become vertical accents');
  assert.ok(Math.max(...vertical.map(item => item.y)) - Math.min(...vertical.map(item => item.y)) > slot.height * .4,
    'vertical centres vary in height rather than lining up in a strip');
  assert.ok(parallelVerticalPairs(filled, slot).length <= 1);
  const area = { x1: slot.x, y1: slot.y, x2: slot.x + slot.width, y2: slot.y + slot.height };
  assert.ok(occupiedFraction(boxes(filled), area) > .5);
  assert.ok(largestEmptyFraction(boxes(filled), area) < .05);
  assert.deepEqual(filled.map(item => item.text).sort(), words.map(([word]) => word).sort());
  assert.deepEqual(Layout.applyLayoutAction(JSON.parse(JSON.stringify(filled)), [slot], context, options), filled);
});

test('a saved previous fill gains breathing room without dropping entries or changing their styles', () => {
  const product = getProduct('white-glossy-mug-duo-11oz');
  const previous = require('./support/print-fill-previous.json');
  const filled = Layout.applyLayoutAction(previous, product.layoutGeometry['fit-area'], context, options);
  assertSafe(filled, product);
  assertBreathingRoom(filled);
  assert.notDeepEqual(filled, previous, 'the previous completed-layout cache must not suppress the upgrade');
  filled.forEach((item, index) => {
    for (const key of ['id', 'text', 'color', 'fontFamily', 'fontWeight', 'fontStyle', 'underline', 'linethrough']) {
      assert.equal(item[key], previous[index][key]);
    }
    assert.ok(item.fontSize / item.layoutFontSize >= .799 && item.fontSize / item.layoutFontSize <= 1.201,
      'a previous fill adopts the new 20% allowance relative to its preferred importance');
  });
  assert.deepEqual(Layout.applyLayoutAction(JSON.parse(JSON.stringify(filled)),
    product.layoutGeometry['fit-area'], context, options), filled);
});

test('an existing one-vertical wedding draft upgrades to a distributed mix and then stays stable', () => {
  const product = getProduct('white-glossy-mug-duo-11oz');
  const slot = product.layoutGeometry['fit-area'][0];
  const previous = require('./support/print-fill-single-vertical.json');
  assert.equal(previous.filter(item => Math.abs(item.angle) === 90).length, 1);
  const filled = Layout.applyLayoutAction(previous, [slot], context, options);
  assertSafe(filled, product);
  assertBreathingRoom(filled);
  const vertical = filled.filter(item => Math.abs(item.angle) === 90 && !Core.isEmojiOnly(item.text));
  assert.ok(vertical.length >= 5 && vertical.length <= 10, 'old provenance cannot keep the lonely vertical word');
  assert.ok(vertical.some(item => item.x > slot.x + slot.width * .2 && item.x < slot.x + slot.width * .8));
  assert.deepEqual(filled.map(item => item.text), previous.map(item => item.text));
  filled.forEach((item, index) => {
    for (const field of ['id', 'color', 'fontFamily', 'fontWeight', 'fontStyle', 'underline', 'linethrough']) {
      assert.equal(item[field], previous[index][field]);
    }
    assert.ok(item.fontSize / item.layoutFontSize >= .799 && item.fontSize / item.layoutFontSize <= 1.201);
  });
  assert.deepEqual(Layout.applyLayoutAction(JSON.parse(JSON.stringify(filled)), [slot], context, options), filled);
});

test('a saved draft with parallel vertical words gains an interspersed mix without losing coverage', () => {
  const product = getProduct('white-glossy-mug-duo-11oz');
  const slot = product.layoutGeometry['fit-area'][0];
  const previous = require('./support/print-fill-vertical-banks.json');
  assert.ok(parallelVerticalPairs(previous, slot).length >= 2, 'the fixture contains repeated parallel pairs');
  const filled = Layout.applyLayoutAction(previous, [slot], context, options);
  assertSafe(filled, product);
  assertBreathingRoom(filled);
  assert.ok(parallelVerticalPairs(filled, slot).length <= 1,
    'old provenance cannot retain the vertical banks: ' + JSON.stringify(parallelVerticalPairs(filled, slot)));
  const vertical = filled.filter(item => Math.abs(item.angle) === 90 && !Core.isEmojiOnly(item.text));
  assert.ok(vertical.length >= 5 && vertical.length <= 10);
  const area = { x1: slot.x, y1: slot.y, x2: slot.x + slot.width, y2: slot.y + slot.height };
  assert.ok(occupiedFraction(boxes(filled), area) > .5);
  assert.ok(largestEmptyFraction(boxes(filled), area) < .05);
  filled.forEach((item, index) => {
    for (const field of ['id', 'text', 'color', 'fontFamily', 'fontWeight', 'fontStyle', 'underline', 'linethrough']) {
      assert.equal(item[field], previous[index][field]);
    }
    assert.ok(item.fontSize / item.layoutFontSize >= .799 && item.fontSize / item.layoutFontSize <= 1.201);
  });
  assert.deepEqual(Layout.applyLayoutAction(JSON.parse(JSON.stringify(filled)), [slot], context, options), filled);
});

test('an older tight row gains spacing and fills its unused surface without losing entries', () => {
  const product = getProduct('white-glossy-mug-duo-11oz');
  // The old completed-layout fingerprint must not skip the new two-stage fill.
  const previous = require('./support/print-fill-tight-row.json');
  const filled = Layout.applyLayoutAction(previous, product.layoutGeometry['fit-area'], context, options);
  assertSafe(filled, product);
  assertBreathingRoom(filled);
  assert.deepEqual(filled.map(item => item.text), previous.map(item => item.text));
  const slot = product.layoutGeometry['fit-area'][0];
  const area = { x1: slot.x, y1: slot.y, x2: slot.x + slot.width, y2: slot.y + slot.height };
  assert.ok(occupiedFraction(boxes(filled), area) > occupiedFraction(boxes(previous), area) * 3,
    'tiny legacy text no longer strands most of the available surface');
  filled.forEach((item, index) => {
    assert.equal(item.color, previous[index].color);
    assert.equal(item.fontFamily, previous[index].fontFamily);
    assert.ok(item.fontSize / item.layoutFontSize >= .799 && item.fontSize / item.layoutFontSize <= 1.201);
  });
  assert.deepEqual(Layout.applyLayoutAction(JSON.parse(JSON.stringify(filled)),
    product.layoutGeometry['fit-area'], context, options), filled);
});

test('weighted print words retain approximately the same importance on different products', () => {
  const words = [['liebe', 24], ['familie', 12], ['tanzen', 6], ['zusammen lachen', 3],
    ['glück', 2], ['freunde', 1], ['❤️', 4], ['🎉', 1]];
  const preferred = new Map(Core.measureWords(words, context).map(item => [item.word, item.fontPx]));
  for (const product of [getProduct('white-glossy-mug-duo-11oz'), getProduct('cork-back-coaster'),
    resolveProductOrientation(getProduct('matte-poster-30x40cm'), 'portrait'),
    resolveProductOrientation(getProduct('matte-poster-30x40cm'), 'landscape')]) {
    const design = automatic(product, words);
    assertSafe(design, product);
    const scales = design.map(item => item.fontSize / preferred.get(item.text));
    assert.ok(Math.max(...scales) / Math.min(...scales) < 1.20 / .80 + .003,
      'one global scale plus at most 20% per-word adjustment');
    for (const item of design) assert.ok(item.fontSize / item.layoutFontSize >= .799 &&
      item.fontSize / item.layoutFontSize <= 1.201, 'each word stays within the bounded adjustment');
    assert.ok(design.find(item => item.text === 'liebe').fontSize >
      design.find(item => item.text === 'freunde').fontSize * 1.5, 'the leading word remains prominent');
    assert.deepEqual(Layout.applyLayoutAction(design, product.layoutGeometry['fit-area'], context, options), design);
  }
});

test('fill can repair an old vertical layout without changing text, fonts or formatting', () => {
  const product = getProduct('white-glossy-mug-duo-11oz');
  const slot = product.layoutGeometry['fit-area'][0];
  const legacy = Core.layoutWordsInArea(SCREENSHOT, slot.width, slot.height, context).map((item, index) => ({
    id: String(index), text: item.word, fontSize: Math.floor(item.fontPx * 10) / 10,
    x: slot.x + item.x, y: slot.y + item.y, angle: item.rotated ? -90 : 0,
    color: item.color, fontFamily: 'classic', fontWeight: 400, fontStyle: 'normal', underline: false, linethrough: false,
  }));
  const filled = Layout.applyLayoutAction(legacy, [slot], context, options);
  assertSafe(filled, product);
  filled.forEach((item, index) => {
    for (const key of ['id', 'text', 'color', 'fontFamily', 'fontWeight', 'fontStyle', 'underline', 'linethrough']) {
      assert.equal(item[key], legacy[index][key]);
    }
  });
  assert.ok(occupiedFraction(boxes(filled), { x1: slot.x, y1: slot.y,
    x2: slot.x + slot.width, y2: slot.y + slot.height }) > .6);
});

test('Fabric draft round trips preserve fill references and edits invalidate completed layout provenance', async t => {
  const product = getProduct('white-glossy-mug-duo-11oz');
  const root = { fabric, DesignFonts: Fonts, WordCloudCore: Core, WolkenworteEmoji: Emoji };
  vm.runInNewContext(fs.readFileSync(require.resolve('../public/js/mug-editor'), 'utf8'), { window: root });
  const editor = Object.create(root.MugPrintEditor.prototype);
  Object.assign(editor, { width: 2700, height: 1050, editorScale: .5, printMargin: 36, margin: 18,
    canvasWidth: 1350, canvasHeight: 525, idCounter: 0, textInput: { value: '' },
    measureContext: context, canvas: new fabric.Canvas(null, { width: 1350, height: 525, enableRetinaScaling: false }) });
  t.after(() => editor.canvas.dispose());
  for (const method of ['updateSelectionPanel', 'emitChange', 'recordHistory', 'flashBoundary']) editor[method] = () => {};
  // Text only avoids needing browser image loaders for emoji in this Node
  // round-trip; mixed emoji layout is covered by the actual page tests above.
  const design = automatic(product, SCREENSHOT.filter(([word]) => !Core.isEmojiOnly(word)));
  editor.setDesign(design);
  const restored = JSON.parse(JSON.stringify(editor.getDesign()));
  assert.equal(restored[0].layoutFingerprint, design[0].layoutFingerprint);
  assert.deepEqual(restored.map(item => item.layoutFontSize), design.map(item => item.layoutFontSize));
  assert.deepEqual(Layout.applyLayoutAction(restored, product.layoutGeometry['fit-area'], context, options), restored);
  restored[0].x = 0; // Same cached provenance, but edited geometry must be repacked.
  const repaired = Layout.applyLayoutAction(restored, product.layoutGeometry['fit-area'], context, options);
  assertSafe(repaired, product);
  assert.notEqual(repaired[0].x, 0);
  assert.deepEqual(Layout.applyLayoutAction(repaired, product.layoutGeometry['fit-area'], context, options), repaired);
});
