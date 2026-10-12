(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.WolkenworteConfiguratorSession = api;
}(typeof globalThis === 'object' ? globalThis : this, function () {
  'use strict';

  const SHIPPING_TTL_MS = 24 * 60 * 60 * 1000;
  const DRAFT_TTL_MS = 7 * 24 * 60 * 60 * 1000;
  const CART_TTL_MS = 7 * 24 * 60 * 60 * 1000;
  const MAX_CART_ITEMS = 20;
  const DRAFT_DATABASE = 'wolkenworte-configurator';
  const DRAFT_STORE = 'design-drafts';
  const validId = (id) => /^[A-Za-z0-9_-]{16}$/.test(String(id || ''));
  const copy = (value) => value == null ? null : JSON.parse(JSON.stringify(value));
  const imageFingerprints = new Map();

  // Comparison for UI state only. Approval and print validation remain server-side.
  function fingerprint(text) {
    let first = 0xdeadbeef;
    let second = 0x41c6ce57;
    for (let index = 0; index < text.length; index += 1) {
      const character = text.charCodeAt(index);
      first = Math.imul(first ^ character, 2654435761);
      second = Math.imul(second ^ character, 1597334677);
    }
    return `${text.length}:${(first >>> 0).toString(16)}:${(second >>> 0).toString(16)}`;
  }

  function designFingerprint(design, includeAll = false) {
    function canonical(value, key = '') {
      if (key === 'src' && typeof value === 'string') {
        if (!imageFingerprints.has(value)) {
          if (imageFingerprints.size >= 8) imageFingerprints.delete(imageFingerprints.keys().next().value);
          imageFingerprints.set(value, fingerprint(value));
        }
        return imageFingerprints.get(value);
      }
      if (Array.isArray(value)) return value.map(item => canonical(item));
      if (!value || typeof value !== 'object') return value;
      return Object.fromEntries(Object.keys(value).sort()
        .filter(name => includeAll || !['id', 'colorLocked'].includes(name))
        .map(name => [name, canonical(value[name], name)]));
    }
    return fingerprint(JSON.stringify(canonical(includeAll ? design : { productKey: design.productKey,
      orientation: design.orientation || 'default', theme: design.theme, designs: design.designs })));
  }

  function browserStorage(name) {
    try {
      const scope = typeof globalThis === 'object' ? globalThis : null;
      return scope?.[name] || null;
    } catch { return null; }
  }

  function defaultCartStorage() {
    return browserStorage('localStorage') || browserStorage('sessionStorage');
  }

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

  // Only references to explicitly approved server snapshots live in the cart.
  // The default is device-local so an accidentally closed tab does not empty it.
  function createCart(slug, suppliedStorage, now = Date.now) {
    const storage = () => suppliedStorage === undefined ? defaultCartStorage() : suppliedStorage;
    const key = `wolkenworte-order:${slug}`;
    const expiryKey = `${key}:expires`;
    const removalKey = `${key}:removed`;
    function read() {
      const primary = storage();
      if (!primary) throw new Error('storage_unavailable');
      let raw = primary.getItem(key);
      // One-time migration from the former tab-only cart.
      const legacy = suppliedStorage === undefined ? browserStorage('sessionStorage') : null;
      if (!raw && legacy && legacy !== primary) {
        try {
          raw = legacy.getItem(key);
          if (raw) {
            primary.setItem(key, raw);
            primary.setItem(expiryKey, String(now() + CART_TTL_MS));
            legacy.removeItem(key);
            legacy.removeItem(expiryKey);
          }
        } catch { /* The primary cart remains usable without migration. */ }
      }
      if (!raw) return [];
      const expiresAt = Number(primary.getItem(expiryKey));
      if (expiresAt > 0 && expiresAt <= now()) {
        primary.removeItem(key);
        primary.removeItem(expiryKey);
        return [];
      }
      if (!(expiresAt > 0)) primary.setItem(expiryKey, String(now() + CART_TTL_MS));
      return normalizeCart(JSON.parse(raw));
    }
    function write(items) {
      const normalized = normalizeCart(items);
      const primary = storage();
      if (!primary) throw new Error('storage_unavailable');
      if (normalized.length) {
        primary.setItem(key, JSON.stringify(normalized));
        primary.setItem(expiryKey, String(now() + CART_TTL_MS));
      } else {
        primary.removeItem(key);
        primary.removeItem(expiryKey);
      }
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
    function pendingRemoval() {
      try {
        const record = JSON.parse(storage()?.getItem(removalKey));
        if (record?.expiresAt > now() && normalizeCart([record.item]).length) return record;
        storage()?.removeItem(removalKey);
      } catch { /* An unavailable undo does not prevent reading the cart. */ }
      return null;
    }
    function remove(configurationId, { quantity = 1 } = {}) {
      const items = read();
      const index = items.findIndex(item => item.id === configurationId);
      if (index < 0) return null;
      const record = { item: items[index], index, quantity: Math.max(0, Math.min(99, Math.round(Number(quantity) || 0))),
        expiresAt: now() + 10 * 60 * 1000 };
      const previous = storage().getItem(removalKey);
      storage().setItem(removalKey, JSON.stringify(record));
      try { write(items.filter(item => item.id !== configurationId)); }
      catch (error) {
        if (previous) storage().setItem(removalKey, previous);
        else storage().removeItem(removalKey);
        throw error;
      }
      return record;
    }
    function undoRemoval() {
      const record = pendingRemoval();
      if (!record) return null;
      const items = read();
      if (!items.some(item => item.id === record.item.id)) {
        if (items.length >= MAX_CART_ITEMS) throw new Error('cart_full');
        items.splice(Math.max(0, Math.min(items.length, record.index)), 0, record.item);
        write(items);
      }
      storage().removeItem(removalKey);
      return record;
    }
    function clearRemoval(ids) {
      if (ids.includes(pendingRemoval()?.item.id)) storage()?.removeItem(removalKey);
    }
    return { read, write, replace, remove, pendingRemoval, undoRemoval, clearRemoval };
  }

  function normalizeDraft(slug, draft, now = Date.now()) {
    if (!draft || typeof draft !== 'object') return null;
    const productKey = String(draft.productKey || '').slice(0, 100);
    const orientation = String(draft.orientation || 'default').slice(0, 100);
    const theme = String(draft.theme || '').slice(0, 100);
    if (!productKey || !theme || !draft.designs || typeof draft.designs !== 'object' || Array.isArray(draft.designs)) {
      return null;
    }
    const editingOrderItemId = validId(draft.editingOrderItemId) ? String(draft.editingOrderItemId) : null;
    const scope = editingOrderItemId
      ? `cart:${editingOrderItemId}`
      : `product:${productKey}:${orientation}`;
    return {
      key: `draft:${slug}:${scope}`,
      type: 'draft', version: 1, slug: String(slug),
      productKey, orientation, theme,
      customColors: Array.isArray(draft.customColors) ? copy(draft.customColors) : [],
      words: Array.isArray(draft.words) ? copy(draft.words) : [],
      designs: copy(draft.designs),
      productDesignState: draft.productDesignState?.version === 1 ? copy(draft.productDesignState) : null,
      accountDesign: draft.accountDesign && /^[0-9a-f-]{36}$/i.test(draft.accountDesign.id || '') &&
        /^[0-9a-f-]{36}$/i.test(draft.accountDesign.ownerId || '')
        ? { id: draft.accountDesign.id, ownerId: draft.accountDesign.ownerId,
          version: Number(draft.accountDesign.version) || 1, fingerprint: String(draft.accountDesign.fingerprint || '').slice(0, 100) }
        : null,
      // Automatic drafts can be regenerated when the layout runtime changes.
      // Manually edited drafts remain portable across runtime revisions.
      layoutVersion: String(draft.layoutVersion || '').slice(0, 128),
      editingOrderItemId,
      needsCartUpdate: draft.needsCartUpdate !== false,
      savedDesignFingerprint: typeof draft.savedDesignFingerprint === 'string'
        ? draft.savedDesignFingerprint.slice(0, 100) : null,
      currentDesignEdited: draft.currentDesignEdited !== false,
      designRevision: Math.max(0, Math.round(Number(draft.designRevision) || 0)),
      updatedAt: now,
      expiresAt: now + DRAFT_TTL_MS,
    };
  }

  function createDraftStore(slug, options = {}) {
    const now = typeof options.now === 'function' ? options.now : Date.now;
    const backend = options.backend || null;
    const indexedDB = options.indexedDB === undefined
      ? (typeof globalThis === 'object' ? globalThis.indexedDB : null)
      : options.indexedDB;
    let databasePromise = null;
    const activeKey = `active:${slug}`;

    function request(request) {
      return new Promise((resolve, reject) => {
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error || new Error('draft_storage_failed'));
      });
    }

    function transactionComplete(transaction) {
      return new Promise((resolve, reject) => {
        transaction.oncomplete = () => resolve();
        transaction.onabort = () => reject(transaction.error || new Error('draft_storage_failed'));
        transaction.onerror = () => reject(transaction.error || new Error('draft_storage_failed'));
      });
    }

    function openDatabase() {
      if (backend) return Promise.resolve(null);
      if (!indexedDB) return Promise.reject(new Error('draft_storage_unavailable'));
      if (databasePromise) return databasePromise;
      databasePromise = new Promise((resolve, reject) => {
        let open;
        try { open = indexedDB.open(DRAFT_DATABASE, 1); }
        catch (error) { reject(error); return; }
        open.onupgradeneeded = () => {
          if (!open.result.objectStoreNames.contains(DRAFT_STORE)) {
            open.result.createObjectStore(DRAFT_STORE, { keyPath: 'key' });
          }
        };
        open.onsuccess = () => {
          const database = open.result;
          database.onversionchange = () => {
            database.close();
            databasePromise = null;
          };
          resolve(database);
        };
        open.onerror = () => reject(open.error || new Error('draft_storage_failed'));
        open.onblocked = () => reject(new Error('draft_storage_blocked'));
      }).catch((error) => {
        databasePromise = null;
        throw error;
      });
      return databasePromise;
    }

    function close() {
      const pending = databasePromise;
      databasePromise = null;
      if (!pending) return;
      // Safari can retain a page in its back/forward cache. Explicitly close
      // the connection so a newly loaded configurator never waits behind it.
      void pending.then((database) => database?.close()).catch(() => {});
    }

    async function get(key) {
      if (backend) return copy(await backend.get(key));
      const database = await openDatabase();
      return copy(await request(database.transaction(DRAFT_STORE).objectStore(DRAFT_STORE).get(key)));
    }

    async function removeKeys(keys) {
      if (backend) {
        for (const key of keys) await backend.delete(key);
        return;
      }
      const database = await openDatabase();
      const transaction = database.transaction(DRAFT_STORE, 'readwrite');
      const store = transaction.objectStore(DRAFT_STORE);
      keys.forEach((key) => store.delete(key));
      await transactionComplete(transaction);
    }

    async function usable(record) {
      if (record?.type === 'draft' && record.version === 1 && record.slug === String(slug) &&
          record.expiresAt > now()) return copy(record);
      if (record?.key) await removeKeys([record.key]);
      return null;
    }

    async function save(draft) {
      const record = normalizeDraft(slug, draft, now());
      if (!record) throw new Error('invalid_draft');
      const active = { key: activeKey, type: 'active', version: 1, slug: String(slug),
        draftKey: record.key, expiresAt: record.expiresAt };
      if (backend) {
        await backend.put(record);
        await backend.put(active);
      } else {
        const database = await openDatabase();
        const transaction = database.transaction(DRAFT_STORE, 'readwrite');
        const store = transaction.objectStore(DRAFT_STORE);
        store.put(record);
        store.put(active);
        await transactionComplete(transaction);
      }
      return copy(record);
    }

    async function loadActive() {
      const active = await get(activeKey);
      if (!active || active.version !== 1 || active.slug !== String(slug) || active.expiresAt <= now()) {
        if (active) await removeKeys([activeKey]);
        return null;
      }
      const record = await usable(await get(active.draftKey));
      if (!record) await removeKeys([activeKey]);
      return record;
    }

    async function loadFor({ productKey, orientation = 'default', editingOrderItemId = null } = {}) {
      const normalized = normalizeDraft(slug, {
        productKey, orientation, theme: '_lookup_', designs: {}, editingOrderItemId,
      }, now());
      return normalized ? usable(await get(normalized.key)) : null;
    }

    async function clearActive({ removeDraft = true } = {}) {
      const active = await get(activeKey);
      const keys = [activeKey];
      if (removeDraft && active?.draftKey) keys.push(active.draftKey);
      await removeKeys(keys);
    }

    async function removeFor(criteria) {
      const normalized = normalizeDraft(slug, {
        ...criteria, theme: '_lookup_', designs: {},
      }, now());
      if (!normalized) return;
      const active = await get(activeKey);
      const keys = [normalized.key];
      if (active?.draftKey === normalized.key) keys.push(activeKey);
      await removeKeys(keys);
    }

    async function loadCartDrafts(ids) {
      const records = await Promise.all([...new Set(ids)].filter(validId).map(editingOrderItemId =>
        loadFor({ editingOrderItemId, productKey: '_cart_' })));
      return records.filter(Boolean);
    }
    return { save, loadActive, loadFor, loadCartDrafts, clearActive, removeFor, close };
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
    function removeConfigurations(ids, { keepRecipient = false } = {}) {
      const record = read();
      if (!record) return;
      const remaining = record.shipments.map((shipment) => ({ ...shipment,
        items: (shipment.items || []).filter((item) => !ids.includes(item.configurationId)),
      })).filter((shipment) => keepRecipient || shipment.items.length);
      if (remaining.length) write(remaining);
      else { try { storage.removeItem(key); } catch {} }
    }
    function restoreConfiguration(configurationId, quantity = 1) {
      const record = read();
      if (!record || !validId(configurationId)) return;
      const items = record.shipments[0].items ||= [];
      if (!items.some(item => item.configurationId === configurationId)) {
        items.push({ configurationId, quantity: Math.max(0, Math.min(99, Math.round(Number(quantity) || 0))) });
      }
      write(record.shipments);
    }
    return { write, restore, replaceConfiguration, removeConfigurations, restoreConfiguration };
  }


  function purchasedIds(slug, storage = defaultCartStorage(), now = Date.now) {
    if (!storage) return [];
    try {
      const key = `wolkenworte-purchased:${slug}`;
      const expiryKey = `${key}:expires`;
      const expiresAt = Number(storage.getItem(expiryKey));
      if (expiresAt > 0 && expiresAt <= now()) {
        storage.removeItem(key);
        storage.removeItem(expiryKey);
        return [];
      }
      const raw = storage.getItem(key);
      if (raw && !(expiresAt > 0)) storage.setItem(expiryKey, String(now() + CART_TTL_MS));
      const ids = JSON.parse(raw);
      return Array.isArray(ids) ? ids.filter(validId) : [];
    } catch { return []; }
  }

  function clearPurchased(slug, order, options = {}) {
    if (order?.paymentConfirmed !== true || !Array.isArray(order.configurationIds)) return false;
    const ids = order.configurationIds.filter(validId);
    if (!ids.length) return false;
    try {
      const storage = options.storage === undefined ? defaultCartStorage() : options.storage;
      if (!storage) return false;
      const shippingStorage = options.shippingStorage === undefined
        ? (options.storage === undefined ? browserStorage('sessionStorage') : storage)
        : options.shippingStorage;
      const cart = createCart(slug, storage);
      cart.write(cart.read().filter((item) => !ids.includes(item.id)));
      cart.clearRemoval(ids);
      const purchasedKey = `wolkenworte-purchased:${slug}`;
      storage.setItem(purchasedKey, JSON.stringify(
        [...new Set([...purchasedIds(slug, storage), ...ids])].slice(-200)
      ));
      storage.setItem(`${purchasedKey}:expires`, String(Date.now() + CART_TTL_MS));
      if (shippingStorage) createShippingDraft(slug, shippingStorage).removeConfigurations(ids);
      return true;
    } catch { return false; }
  }

  function prepareReorder(slug, configurations, suppliedStorage) {
    const storage = suppliedStorage === undefined ? defaultCartStorage() : suppliedStorage;
    const shippingStorage = suppliedStorage === undefined ? browserStorage('sessionStorage') : suppliedStorage;
    if (!storage || !shippingStorage) throw new Error('storage_unavailable');
    const copies = normalizeCart(configurations);
    if (!copies.length || copies.length !== configurations.length ||
        copies.some((entry) => purchasedIds(slug, storage).includes(entry.id))) throw new Error('invalid_reorder');
    const cart = createCart(slug, storage);
    const previous = cart.read();
    const combined = [...previous.filter((entry) => !copies.some((item) => item.id === entry.id)), ...copies];
    if (combined.length > MAX_CART_ITEMS) throw new Error('cart_full');
    const shipping = createShippingDraft(slug, shippingStorage);
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

  async function clearAccountDrafts(ownerId, designId = null) {
    if (!globalThis.indexedDB) return;
    const database = await new Promise((resolve, reject) => {
      const open = globalThis.indexedDB.open(DRAFT_DATABASE, 1);
      open.onupgradeneeded = () => { if (!open.result.objectStoreNames.contains(DRAFT_STORE)) open.result.createObjectStore(DRAFT_STORE, { keyPath: 'key' }); };
      open.onsuccess = () => resolve(open.result);
      open.onerror = () => reject(open.error);
      open.onblocked = () => reject(new Error('draft_storage_unavailable'));
    });
    try {
      await new Promise((resolve, reject) => {
        const transaction = database.transaction(DRAFT_STORE, 'readwrite');
        const store = transaction.objectStore(DRAFT_STORE);
        const request = store.getAll();
        request.onsuccess = () => {
          const rows = request.result;
          const keys = new Set(rows.filter(row => row.accountDesign?.ownerId === ownerId &&
            (!designId || row.accountDesign.id === designId)).map(row => row.key));
          rows.forEach(row => { if (keys.has(row.key) || keys.has(row.draftKey)) store.delete(row.key); });
        };
        transaction.oncomplete = resolve;
        transaction.onerror = () => reject(transaction.error);
        transaction.onabort = () => reject(transaction.error);
      });
    } finally { database.close(); }
  }

  return { createCart, createDraftStore, createShippingDraft, normalizeCart, normalizeDraft, designFingerprint,
    accountDesignFingerprint: snapshot => designFingerprint(snapshot, true), clearAccountDrafts, validId, withTimeout,
    purchasedIds, clearPurchased, prepareReorder, MAX_CART_ITEMS, DRAFT_TTL_MS, CART_TTL_MS };
}));
