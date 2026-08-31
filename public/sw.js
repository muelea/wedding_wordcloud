// The service worker is intentionally network-only: it enables installation
// without caching live event content or keeping a stale word cloud offline.
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (event) => event.waitUntil(self.clients.claim()));
