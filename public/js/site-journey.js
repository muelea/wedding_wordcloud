(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.WolkenworteJourney = api;
}(typeof globalThis === 'object' ? globalThis : this, function () {
  'use strict';
  const KEY = 'wolkenworte-recent-event';
  const TTL = 7 * 24 * 60 * 60 * 1000;
  const validSlug = (slug) => typeof slug === 'string' && /^[A-Za-z0-9_-]{21}[AEIMQUYcgkosw048]$/.test(slug);
  function read(storage, now = Date.now()) {
    try {
      const saved = JSON.parse(storage.getItem(KEY));
      if (validSlug(saved?.slug) && saved.expiresAt > now) return saved;
      storage.removeItem(KEY);
    } catch {}
    return null;
  }
  function remember(slug, title, hasDesign, storage, now = Date.now()) {
    if (!validSlug(slug)) return;
    try {
      if (storage === undefined) storage = localStorage;
      const previous = read(storage, now);
      storage.setItem(KEY, JSON.stringify({ slug, title: String(title || slug).slice(0, 120),
        hasDesign: hasDesign == null ? previous?.slug === slug && previous.hasDesign === true : Boolean(hasDesign),
        expiresAt: now + TTL }));
    } catch {}
  }
  function recent() { try { return read(localStorage); } catch { return null; } }
  function setDesign(slug, hasDesign) {
    const saved = recent();
    if (saved?.slug === slug) remember(slug, saved.title, hasDesign);
  }
  async function mountHome(document, fetcher = fetch) {
    const card = document.getElementById('resume-journey');
    const saved = recent();
    if (!card) return;
    card.hidden = true;
    if (!saved) return;
    const cloudLink = card.querySelector('[data-resume-cloud]');
    const designLink = card.querySelector('[data-resume-design]');
    cloudLink.href = `/e/${encodeURIComponent(saved.slug)}`;
    designLink.href = `${cloudLink.getAttribute('href')}/configure?cart=1`;
    let hasCart = false;
    try {
      const items = JSON.parse(sessionStorage.getItem(`wolkenworte-order:${saved.slug}`));
      hasCart = Array.isArray(items) && items.some((item) => /^[A-Za-z0-9_-]{16}$/.test(item?.id));
    } catch {}
    designLink.hidden = !hasCart;
    card.querySelector('[data-resume-title]').textContent = saved.title;
    card.hidden = false;
    // Validate expiry without making navigation wait on network availability.
    try {
      const response = await fetcher(`/api/events/${encodeURIComponent(saved.slug)}`, { signal: AbortSignal.timeout(5000) });
      if (response.status === 404 && recent()?.slug === saved.slug) {
        try { localStorage.removeItem(KEY); } catch {}
        card.hidden = true;
      }
    } catch { /* Existing links also work after a temporary offline interval. */ }
  }
  return { read, remember, recent, setDesign, mountHome, TTL };
}));
