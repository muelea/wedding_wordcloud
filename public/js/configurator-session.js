(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.WolkenworteConfiguratorSession = api;
}(typeof globalThis === 'object' ? globalThis : this, function () {
  'use strict';

  const SHIPPING_TTL_MS = 24 * 60 * 60 * 1000;
  const MAX_CART_ITEMS = 20;
  const validId = (id) => /^[A-Za-z0-9_-]{16}$/.test(String(id || ''));
  const copy = (value) => value == null ? null : JSON.parse(JSON.stringify(value));

  function withTimeout(promise, milliseconds = 10000) {
    let timer;
    return Promise.race([promise, new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error('operation_timeout')), milliseconds);
    })]).finally(() => clearTimeout(timer));
  }

  function normalizeCart(items) {
    if (!Array.isArray(items)) return [];
    const seen = new Set();
    return items.filter((item) => item && validId(item.id) && !seen.has(item.id) && seen.add(item.id))
      .map((item) => ({
        id: String(item.id), productKey: String(item.productKey || ''),
        orientation: String(item.orientation || 'default'), printFileUrl: String(item.printFileUrl || ''),
        createdAt: String(item.createdAt || ''),
      })).slice(0, MAX_CART_ITEMS);
  }

  // Only references to explicitly approved server snapshots live in this tab.
  // There is deliberately no working-draft database or automatic restoration.
  function createCart(slug, suppliedStorage) {
    const storage = () => suppliedStorage === undefined ? sessionStorage : suppliedStorage;
    const key = `wolkenworte-order:${slug}`;
    function read() {
      const raw = storage().getItem(key);
      return raw ? normalizeCart(JSON.parse(raw)) : [];
    }
    function write(items) {
      const normalized = normalizeCart(items);
      storage().setItem(key, JSON.stringify(normalized));
      return normalized;
    }
    function replace(configuration, previousId = null) {
      const items = read();
      const index = items.findIndex((item) => item.id === previousId);
      if (index < 0 && !items.some((item) => item.id === configuration.id) && items.length >= MAX_CART_ITEMS) {
        throw new Error('cart_full');
      }
      const next = items.filter((item) => item.id !== previousId && item.id !== configuration.id);
      next.splice(index < 0 ? next.length : index, 0, configuration);
      return write(next);
    }
    return { read, write, replace };
  }

  function createShippingDraft(slug, storage, now = Date.now) {
    const key = `wolkenworte-shipping-draft:${slug}`;
    function read() {
      try {
        const record = JSON.parse(storage.getItem(key));
        if (record?.version === 1 && record.expiresAt > now() &&
            Array.isArray(record.shipments) && record.shipments.length === 1) return record;
        storage.removeItem(key);
      } catch {}
      return null;
    }
    function write(shipments) {
      if (!Array.isArray(shipments) || shipments.length !== 1) return false;
      try {
        storage.setItem(key, JSON.stringify({ version: 1, expiresAt: now() + SHIPPING_TTL_MS,
          shipments: copy(shipments) }));
        return true;
      } catch { return false; }
    }
    function replaceConfiguration(previous, next) {
      const record = read();
      if (!record || !validId(previous) || !validId(next)) return;
      record.shipments.forEach((shipment) => (shipment.items || []).forEach((item) => {
        if (item.configurationId === previous) item.configurationId = next;
      }));
      write(record.shipments);
    }
    function restore(ids) {
      const record = read();
      if (!record) return null;
      return record.shipments.filter((shipment) => shipment && typeof shipment === 'object')
        .map((shipment) => ({
          recipient: Object.fromEntries(['name', 'address1', 'address2', 'zip', 'city', 'country_code', 'state_code']
            .map((field) => [field, String(shipment.recipient?.[field] || '').slice(0, 200)])),
          items: (Array.isArray(shipment.items) ? shipment.items : [])
            .filter((item) => item && ids.includes(item.configurationId))
            .map((item) => ({ configurationId: item.configurationId,
              quantity: Math.max(0, Math.min(99, Math.round(Number(item.quantity) || 0))) })),
        }));
    }
    function removeConfigurations(ids) {
      const record = read();
      if (!record) return;
      const remaining = record.shipments.map((shipment) => ({ ...shipment,
        items: (shipment.items || []).filter((item) => !ids.includes(item.configurationId)),
      })).filter((shipment) => shipment.items.length);
      if (remaining.length) write(remaining);
      else { try { storage.removeItem(key); } catch {} }
    }
    return { write, restore, replaceConfiguration, removeConfigurations };
  }


  function purchasedIds(slug, storage) {
    try {
      const ids = JSON.parse(storage.getItem(`wolkenworte-purchased:${slug}`));
      return Array.isArray(ids) ? ids.filter(validId) : [];
    } catch { return []; }
  }

  function clearPurchased(slug, order, options = {}) {
    if (order?.paymentConfirmed !== true || !Array.isArray(order.configurationIds)) return false;
    const ids = order.configurationIds.filter(validId);
    if (!ids.length) return false;
    try {
      const storage = options.storage === undefined ? sessionStorage : options.storage;
      const cart = createCart(slug, storage);
      cart.write(cart.read().filter((item) => !ids.includes(item.id)));
      storage.setItem(`wolkenworte-purchased:${slug}`, JSON.stringify(
        [...new Set([...purchasedIds(slug, storage), ...ids])].slice(-200)
      ));
      createShippingDraft(slug, storage).removeConfigurations(ids);
      return true;
    } catch { return false; }
  }

  function prepareReorder(slug, configurations, suppliedStorage) {
    const storage = suppliedStorage === undefined ? sessionStorage : suppliedStorage;
    const copies = normalizeCart(configurations);
    if (!copies.length || copies.length !== configurations.length ||
        copies.some((entry) => purchasedIds(slug, storage).includes(entry.id))) throw new Error('invalid_reorder');
    const cart = createCart(slug, storage);
    const previous = cart.read();
    const combined = [...previous.filter((entry) => !copies.some((item) => item.id === entry.id)), ...copies];
    if (combined.length > MAX_CART_ITEMS) throw new Error('cart_full');
    const shipping = createShippingDraft(slug, storage);
    const previousShipping = shipping.restore(previous.map((entry) => entry.id));
    const quantities = new Map((previousShipping?.[0]?.items || [])
      .map((item) => [item.configurationId, item.quantity]));
    configurations.forEach((item) => quantities.set(item.id, Number(item.quantity) || 1));
    cart.write(combined);
    // An explicit reorder always asks for a new address and a fresh quote.
    if (!shipping.write([{ recipient: {}, items: combined.map((entry) => ({
      configurationId: entry.id, quantity: quantities.get(entry.id) ?? 1,
    })) }])) {
      cart.write(previous);
      throw new Error('storage_unavailable');
    }
    return combined.map((entry) => entry.id);
  }

  return { createCart, createShippingDraft, normalizeCart, validId, withTimeout, purchasedIds, clearPurchased,
    prepareReorder, MAX_CART_ITEMS };
}));
