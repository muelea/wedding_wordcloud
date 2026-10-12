'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { plan } = require('../public/js/canvas-viewport');

test('high zoom allocates only visible phone pixels and retains print coordinates', () => {
  for (const pixelRatio of [1, 2, 3, 4]) {
    const view = plan({ width: 1350, height: 525, fitWidth: 740, viewportWidth: 740, viewportHeight: 240,
      zoom: 6, pixelRatio });
    assert.equal(view.paintWidth, 740);
    assert.equal(view.paintHeight, 240);
    assert.equal(view.displayWidth, 4440);
    assert.ok(view.paintWidth * view.paintHeight * view.retina ** 2 <= 5_000_000);
    const [scale, , , , x, y] = view.transform;
    assert.equal(675 * scale + x, 370, 'the print centre is still the visible centre');
    assert.equal(262.5 * scale + y, 120);
    assert.equal(view.retina, Math.min(3, pixelRatio));
  }
});

test('portrait fit and panning use the same inverse scene coordinates', () => {
  const fit = plan({ width: 1350, height: 525, fitWidth: 300, viewportWidth: 300, viewportHeight: 700, zoom: 1 });
  assert.equal(fit.paintWidth, 300);
  assert.equal(fit.paintHeight, 117);
  assert.equal(fit.offsetX, 0);
  assert.equal(fit.offsetY, 0);
  const zoom = plan({ width: 1350, height: 525, fitWidth: 300, viewportWidth: 300, viewportHeight: 700,
    zoom: 6, panX: 1e6, panY: -1e6 });
  assert.equal(zoom.panX, 750);
  assert.equal(zoom.offsetX, 0);
  assert.equal(zoom.offsetY, zoom.displayHeight - 700);
});

test('large screens also bound backing-store allocation', () => {
  const view = plan({ width: 1500, height: 2100, fitWidth: 1000, viewportWidth: 1000, viewportHeight: 1500, zoom: 6, pixelRatio: 3 });
  assert.ok(view.paintWidth * view.paintHeight * view.retina ** 2 <= 5_000_000 + 1);
  assert.ok(view.retina > 1);
});
