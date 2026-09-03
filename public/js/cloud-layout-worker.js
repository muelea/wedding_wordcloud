'use strict';

// Only measured boxes cross this boundary. Font measurement and drawing use
// the page's loaded fonts, so no worker font/OffscreenCanvas fallback is needed.
self.onmessage = ({ data }) => {
  try {
    if (!self.WordCloudCore) {
      const url = new URL(data.coreUrl, self.location.href);
      if (url.origin !== self.location.origin || url.pathname !== '/js/wordcloud-core.js') {
        throw new Error('Invalid layout module');
      }
      importScripts(url.href);
    }
    const placed = self.WordCloudCore.layoutBoxesInArea(data.boxes, data.width, data.height);
    self.postMessage({ id: data.id, placed });
  } catch {
    self.postMessage({ id: data.id, error: 'layout_failed' });
  }
};
