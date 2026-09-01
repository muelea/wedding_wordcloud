(function (root, factory) {
  'use strict';

  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.ImagePrintQuality = api;
})(typeof window !== 'undefined' ? window : globalThis, function () {
  'use strict';

  const CM_PER_INCH = 2.54;

  function positiveNumber(value) {
    const number = Number(value);
    return Number.isFinite(number) && number > 0 ? number : null;
  }

  function evaluate({
    sourceWidth,
    sourceHeight,
    printWidth,
    printHeight,
    printFileDpi,
  } = {}) {
    const pixelsWide = positiveNumber(sourceWidth);
    const pixelsHigh = positiveNumber(sourceHeight);
    const designWidth = positiveNumber(printWidth);
    const designHeight = positiveNumber(printHeight);
    const targetDpi = positiveNumber(printFileDpi);
    if (!pixelsWide || !pixelsHigh || !designWidth || !designHeight || !targetDpi) return null;

    const widthInches = designWidth / targetDpi;
    const heightInches = designHeight / targetDpi;
    const effectiveDpi = Math.max(1, Math.floor(Math.min(
      pixelsWide / widthInches,
      pixelsHigh / heightInches
    )));
    // Printful recommends 150–300 DPI and still considers 120 DPI high quality
    // for most products. A 300-DPI product therefore keeps 150 as its lower
    // print-ready boundary; large-format 150-DPI products keep 120.
    const minimumDpi = targetDpi >= 300 ? 150 : 120;
    const level = effectiveDpi >= targetDpi
      ? 'optimal'
      : effectiveDpi >= minimumDpi ? 'good' : 'low';

    return Object.freeze({
      effectiveDpi,
      targetDpi: Math.round(targetDpi),
      minimumDpi,
      widthCm: widthInches * CM_PER_INCH,
      heightCm: heightInches * CM_PER_INCH,
      level,
    });
  }

  return Object.freeze({ evaluate });
});
