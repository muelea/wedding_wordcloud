(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else {
    root.WolkenworteBaskets = api;
    document.addEventListener('DOMContentLoaded', () => api.mount(document));
  }
}(typeof globalThis === 'object' ? globalThis : this, function () {
  'use strict';
  function list(storage, now = Date.now()) {
    const baskets = [];
    try {
      for (let index = 0; index < Math.min(storage.length, 2000); index++) {
        const match = /^wolkenworte-order:([A-Za-z0-9_-]{22})$/.exec(storage.key(index));
        if (!match) continue;
        const expiry = Number(storage.getItem(`${match[0]}:expires`));
        if (expiry && expiry <= now) continue;
        let items;
        try { items = JSON.parse(storage.getItem(match[0])); }
        catch { continue; }
        if (!Array.isArray(items)) continue;
        const count = new Set(items.filter(item => /^[A-Za-z0-9_-]{16}$/.test(item?.id)).map(item => item.id)).size;
        if (count) baskets.push({ slug: match[1], count: Math.min(count, 20),
          title: String(storage.getItem(`wolkenworte-basket-label:${match[1]}`) || '').slice(0, 120) });
        if (baskets.length === 50) break;
      }
    } catch { /* Recovery navigation never blocks an ordinary page. */ }
    return baskets;
  }
  function mount(document, storage) {
    const hosts = [...document.querySelectorAll('[data-browser-baskets]')];
    if (!hosts.length) return;
    try { storage ||= globalThis.localStorage; } catch { return; }
    const render = () => {
      const baskets = list(storage);
      for (const host of hosts) {
        host.replaceChildren(); host.hidden = !baskets.length;
        const heading = document.createElement('h2'); heading.className = 'ww-site-menu-label ww-basket-heading';
        const text = (element, source, params = {}) => globalThis.WolkenworteI18n
          ? globalThis.WolkenworteI18n.setText(element, source, params)
          : element.textContent = source.replace(/\{\{(\w+)\}\}/g, (_, key) => params[key] ?? '');
        text(heading, 'Warenkörbe in diesem Browser'); host.append(heading);
        baskets.forEach((basket, index) => {
          const link = document.createElement('a'); link.className = 'ww-header-menu-item ww-basket-link';
          link.href = `/e/${encodeURIComponent(basket.slug)}/configure?cart=1`;
          const name = document.createElement('span'); name.className = 'ww-basket-name';
          if (basket.title.trim()) name.textContent = basket.title;
          else text(name, 'Warenkorb {{number}}', { number: index + 1 });
          const count = document.createElement('span'); count.className = 'ww-basket-count';
          text(count, basket.count === 1 ? '{{count}} Design' : '{{count}} Designs', { count: basket.count });
          link.append(name, document.createTextNode(' '), count);
          host.append(link);
        });
      }
    };
    render();
    globalThis.addEventListener?.('storage', render);
    globalThis.addEventListener?.('wolkenworte:cartchange', render);
    globalThis.addEventListener?.('wolkenworte:localechange', render);
  }
  return { list, mount };
}));
