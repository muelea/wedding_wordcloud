(function (root, factory) {
  'use strict';
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) {
    root.WolkenworteDevice = api;
    // Set this before page styles load so desktop never flashes mobile controls.
    root.document?.documentElement?.setAttribute('data-ww-mobile-device', String(api.isMobileDevice(root.navigator)));
  }
})(typeof window !== 'undefined' ? window : globalThis, function () {
  'use strict';

  function isIosDevice(navigator = {}) {
    const agent = String(navigator.userAgent || '');
    return /iPad|iPhone|iPod/.test(agent) ||
      (/Macintosh/.test(agent) && navigator.maxTouchPoints > 1);
  }

  function isMobileDevice(navigator = {}) {
    // Window width and touch capability alone do not identify a mobile device.
    return isIosDevice(navigator) || /Android/.test(String(navigator.userAgent || '')) ||
      navigator.userAgentData?.mobile === true;
  }

  return Object.freeze({ isIosDevice, isMobileDevice });
});
