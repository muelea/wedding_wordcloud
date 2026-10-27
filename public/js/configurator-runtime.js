(function (root, factory) {
  'use strict';
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.WolkenworteConfiguratorRuntime = api;
})(typeof window !== 'undefined' ? window : globalThis, function () {
  'use strict';

  // Browsing products needs no Fabric canvas. Fetch the editor dependency on
  // first editor entry, sharing concurrent requests and allowing failed retries.
  function createLoader({ document, src, ready, timeoutMs = 15000 }) {
    let pending = null;
    return function load() {
      if (ready()) return Promise.resolve();
      if (!pending) {
        pending = new Promise((resolve, reject) => {
          const script = document.createElement('script');
          const finish = error => {
            document.defaultView.clearTimeout(timer);
            script.onload = script.onerror = null;
            if (error) { script.remove(); reject(error); }
            else resolve();
          };
          const timer = document.defaultView.setTimeout(() => finish(new Error('editor_runtime_timeout')), timeoutMs);
          script.onload = () => finish(ready() ? null : new Error('editor_runtime_unavailable'));
          script.onerror = () => finish(new Error('editor_runtime_unavailable'));
          script.src = src;
          document.head.appendChild(script);
        }).catch(error => { pending = null; throw error; });
      }
      return pending;
    };
  }

  return Object.freeze({ createLoader });
});
