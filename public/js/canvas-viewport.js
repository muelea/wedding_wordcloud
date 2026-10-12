(function (root) {
  'use strict';
  // Keep the backing bitmap bounded to the visible region, even at 600%.
  // Print/scene coordinates never change when allocating display pixels.
  function plan({ width, height, fitWidth, viewportWidth, viewportHeight, zoom, panX = 0, panY = 0, pixelRatio = 1 }) {
    const scale = fitWidth * zoom / width;
    const displayWidth = width * scale, displayHeight = height * scale;
    const limitX = Math.max(0, (displayWidth - viewportWidth) / 2);
    const limitY = Math.max(0, (displayHeight - viewportHeight) / 2);
    panX = Math.max(-limitX, Math.min(limitX, panX));
    panY = Math.max(-limitY, Math.min(limitY, panY));
    const offsetX = Math.max(0, (displayWidth - viewportWidth) / 2 - panX);
    const offsetY = Math.max(0, (displayHeight - viewportHeight) / 2 - panY);
    const paintWidth = Math.ceil(Math.min(displayWidth, viewportWidth));
    const paintHeight = Math.ceil(Math.min(displayHeight, viewportHeight));
    const retina = Math.max(1, Math.min(3, pixelRatio, Math.sqrt(5_000_000 / Math.max(1, paintWidth * paintHeight))));
    return { displayWidth, displayHeight, panX, panY, offsetX, offsetY, paintWidth, paintHeight, retina,
      transform: [scale, 0, 0, scale, -offsetX, -offsetY] };
  }
  root.CanvasViewport = { plan };
  if (typeof module === 'object' && module.exports) module.exports = { plan };
})(typeof window === 'object' ? window : globalThis);
