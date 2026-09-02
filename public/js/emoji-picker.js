(function (root, factory) {
  'use strict';

  const api = factory(root);
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.WolkenworteEmojiPicker = api;
})(typeof window !== 'undefined' ? window : globalThis, function (root) {
  'use strict';

  const RECENTS_KEY = 'wolkenworte:emoji-recents:v1';
  const RECENTS_LIMIT = 24;
  const COLUMNS = 8;
  const ROW_HEIGHT = 40;
  const OVERSCAN_ROWS = 2;
  const SEARCH_DELAY_MS = 90;
  const EXPECTED_EMOJI_COUNT = 3944;
  const EXPECTED_GROUP_COUNT = 9;
  const SEARCH_INDEX_VERSION = '48.2';
  const FALLBACK_RECENTS = Object.freeze([
    '❤️', '🥰', '😍', '😊', '😂', '🥹', '😘', '🫶', '👍', '🙏', '🎉', '✨',
    '🥂', '💍', '💐', '💖', '🔥', '☀️', '🌈', '🎁', '🎂', '🤍', '💕', '💫',
  ]);
  const CATEGORIES = Object.freeze([
    {
      key: 'frequent',
      label: 'Häufig',
      icon: 'M12 3a9 9 0 1 0 9 9M12 7v5l3 2',
    },
    {
      key: 'smileys',
      label: 'Gesichter',
      icon: 'M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18ZM8.5 10h.01M15.5 10h.01M8.5 15c1 1.4 2.1 2 3.5 2s2.5-.6 3.5-2',
    },
    {
      key: 'people',
      label: 'Menschen',
      icon: 'M7.5 11V7.2a1.4 1.4 0 0 1 2.8 0V10M10.3 10V5.8a1.4 1.4 0 0 1 2.8 0V10M13.1 10V6.7a1.4 1.4 0 0 1 2.8 0v4.5M15.9 11.2V9a1.4 1.4 0 0 1 2.8 0v5.3c0 4.2-2.6 6.7-6.6 6.7-2.5 0-4.1-1.2-5.4-3.2l-2.1-3.1a1.5 1.5 0 0 1 2.3-1.9l2 1.8',
    },
    {
      key: 'nature',
      label: 'Tiere & Natur',
      icon: 'M20.5 3.5C11 3.7 4.2 7.6 4 18.8c10.8.3 16.4-5.8 16.5-15.3ZM4.5 19c3.2-4.3 7.1-7.4 12.5-10',
    },
    {
      key: 'food',
      label: 'Essen & Trinken',
      icon: 'M7 3v8M4 3v5c0 2 1.3 3 3 3s3-1 3-3V3M7 11v10M16 3v18M16 3c3 2 4 5 0 9',
    },
    {
      key: 'activities',
      label: 'Aktivitäten',
      icon: 'M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18ZM4 9l5 2 3-8M20 9l-5 2-3-8M7 19l1-5-4-3M17 19l-1-5 4-3M8 14h8',
    },
    {
      key: 'travel',
      label: 'Reisen & Orte',
      icon: 'M3 17h18l-2-7H5l-2 7ZM6 17v2M18 17v2M7 10l2-5h6l2 5',
    },
    {
      key: 'objects',
      label: 'Objekte',
      icon: 'M9 18h6M10 22h4M8.5 15.5a7 7 0 1 1 7 0c-1.2.8-1.5 1.4-1.5 2.5h-4c0-1.1-.3-1.7-1.5-2.5Z',
    },
    {
      key: 'symbols',
      label: 'Symbole',
      icon: 'M20.8 4.8a5.5 5.5 0 0 0-7.8 0L12 5.9l-1-1.1a5.5 5.5 0 0 0-7.8 7.8L12 21l8.8-8.4a5.5 5.5 0 0 0 0-7.8Z',
    },
    {
      key: 'flags',
      label: 'Flaggen',
      icon: 'M5 21V4M5 5c5-3 8 3 14 0v10c-6 3-9-3-14 0',
    },
  ]);

  const searchRecords = new Map();
  const searchPromises = new Map();
  const catalogs = new Map();
  const catalogPromises = new Map();

  function requireDependency(name) {
    if (!root?.[name]) throw new Error(`${name} is required for the emoji picker`);
    return root[name];
  }

  function createElement(document, tagName, className = '') {
    const element = document.createElement(tagName);
    if (className) element.className = className;
    return element;
  }

  function createCategoryIcon(document, pathData) {
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('viewBox', '0 0 24 24');
    svg.setAttribute('aria-hidden', 'true');
    const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    path.setAttribute('d', pathData);
    svg.appendChild(path);
    return svg;
  }

  function createSearchIcon(document) {
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('viewBox', '0 0 24 24');
    svg.setAttribute('aria-hidden', 'true');
    const circle = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
    circle.setAttribute('cx', '10.8');
    circle.setAttribute('cy', '10.8');
    circle.setAttribute('r', '6.8');
    const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    path.setAttribute('d', 'm16 16 4.5 4.5');
    svg.append(circle, path);
    return svg;
  }

  class EmojiPicker {
    constructor(options = {}) {
      this.document = options.document || root.document;
      this.trigger = options.trigger;
      this.mount = options.mount;
      if (!this.document || !this.trigger || !this.mount) {
        throw new TypeError('EmojiPicker requires a document, trigger and mount element.');
      }
      this.emoji = requireDependency('WolkenworteEmoji');
      this.search = requireDependency('WolkenworteEmojiSearch');
      this.virtualGrid = requireDependency('WolkenworteEmojiVirtualGrid');
      this.i18n = root.WolkenworteI18n || null;
      this.idPrefix = String(options.idPrefix || 'ww-emoji').replace(/[^a-z0-9_-]/gi, '-');
      this.placement = options.placement === 'below-left' ? 'below-left' : 'above-right';
      this.catalogUrl = String(options.catalogUrl || '');
      this.searchIndexUrls = Object.freeze({ ...(options.searchIndexUrls || {}) });
      if (!this.catalogUrl || !Object.keys(this.searchIndexUrls).length) {
        throw new TypeError('EmojiPicker requires versioned catalog and search-index URLs.');
      }
      this.mediaQuery = typeof options.mediaQuery === 'string'
        ? root.matchMedia(options.mediaQuery)
        : options.mediaQuery || null;
      this.onSelect = typeof options.onSelect === 'function' ? options.onSelect : () => {};
      this.onOpen = typeof options.onOpen === 'function' ? options.onOpen : () => {};
      this.onError = typeof options.onError === 'function' ? options.onError : () => {};
      this.selectedCategory = CATEGORIES[0].key;
      this.renderRevision = 0;
      this.searchTimer = null;
      this.scrollFrame = null;
      this.focusedIndex = 0;
      this.virtualState = null;
      this.selectionPending = false;
      this.initialized = false;
      this.build();
      this.bind();
    }

    translate(source, params = {}) {
      if (this.i18n) return this.i18n.t(source, params);
      return String(source).replace(/\{\{\s*([\w.-]+)\s*\}\}/g, (_, key) => (
        Object.hasOwn(params, key) ? String(params[key]) : ''
      ));
    }

    setText(element, source, params = {}) {
      if (this.i18n) this.i18n.setText(element, source, params);
      else element.textContent = this.translate(source, params);
    }

    clearText(element) {
      if (this.i18n) this.i18n.clearText(element);
      else element.replaceChildren();
    }

    setAttribute(element, name, source, params = {}) {
      if (this.i18n) this.i18n.setAttribute(element, name, source, params);
      else element.setAttribute(name, this.translate(source, params));
    }

    build() {
      const titleId = `${this.idPrefix}-title`;
      const panelId = `${this.idPrefix}-picker`;
      this.panel = createElement(this.document, 'div', 'ww-emoji-picker');
      this.panel.id = panelId;
      this.panel.dataset.placement = this.placement;
      this.panel.setAttribute('role', 'dialog');
      this.panel.setAttribute('aria-labelledby', titleId);
      this.panel.hidden = true;

      const header = createElement(this.document, 'div', 'ww-emoji-picker-header');
      const title = createElement(this.document, 'strong', 'ww-emoji-picker-title');
      title.id = titleId;
      this.setText(title, 'Emoji auswählen');
      this.closeButton = createElement(this.document, 'button', 'ww-emoji-picker-close');
      this.closeButton.type = 'button';
      this.closeButton.textContent = '×';
      this.setAttribute(this.closeButton, 'aria-label', 'Emoji-Auswahl schließen');
      header.append(title, this.closeButton);

      const searchField = createElement(this.document, 'div', 'ww-emoji-search');
      this.searchInput = createElement(this.document, 'input', 'ww-emoji-search-input');
      this.searchInput.type = 'search';
      this.searchInput.autocomplete = 'off';
      this.searchInput.spellcheck = false;
      this.setAttribute(this.searchInput, 'placeholder', 'Emojis suchen');
      this.setAttribute(this.searchInput, 'aria-label', 'Emojis suchen');
      this.searchClear = createElement(this.document, 'button', 'ww-emoji-search-clear');
      this.searchClear.type = 'button';
      this.searchClear.textContent = '×';
      this.searchClear.hidden = true;
      this.setAttribute(this.searchClear, 'aria-label', 'Suche löschen');
      searchField.append(createSearchIcon(this.document), this.searchInput, this.searchClear);

      this.categories = createElement(this.document, 'div', 'ww-emoji-categories');
      this.categories.setAttribute('role', 'tablist');
      this.setAttribute(this.categories, 'aria-label', 'Emoji-Kategorien');
      this.grid = createElement(this.document, 'div', 'ww-emoji-grid');
      this.grid.id = `${this.idPrefix}-grid`;
      this.grid.setAttribute('role', 'tabpanel');
      this.empty = createElement(this.document, 'p', 'ww-emoji-empty');
      this.empty.hidden = true;
      this.status = createElement(this.document, 'p', 'ww-emoji-status');
      this.status.setAttribute('role', 'status');
      this.status.setAttribute('aria-live', 'polite');
      this.status.setAttribute('aria-atomic', 'true');
      this.panel.append(header, searchField, this.categories, this.grid, this.status);
      this.mount.appendChild(this.panel);

      this.trigger.setAttribute('aria-haspopup', 'dialog');
      this.trigger.setAttribute('aria-controls', panelId);
      this.trigger.setAttribute('aria-expanded', 'false');
    }

    bind() {
      this.trigger.addEventListener('click', () => {
        if (this.panel.hidden) this.open();
        else this.close({ focusTrigger: true });
      });
      this.closeButton.addEventListener('click', () => this.close({ focusTrigger: true }));
      this.searchInput.addEventListener('input', () => this.scheduleSearch());
      this.searchClear.addEventListener('click', () => {
        clearTimeout(this.searchTimer);
        this.searchInput.value = '';
        this.renderCategory(this.selectedCategory, { clearSearch: false });
        this.searchInput.focus();
      });
      this.grid.addEventListener('scroll', () => {
        if (this.scrollFrame !== null) return;
        this.scrollFrame = root.requestAnimationFrame(() => {
          this.scrollFrame = null;
          this.renderVirtualWindow();
        });
      }, { passive: true });
      this.grid.addEventListener('keydown', (event) => this.handleGridKeydown(event));
      this.panel.addEventListener('keydown', (event) => this.handlePanelKeydown(event));
      this.document.addEventListener('pointerdown', (event) => {
        if (!this.panel.hidden
            && !this.panel.contains(event.target)
            && !this.trigger.contains(event.target)) this.close();
      });
      this.mediaQuery?.addEventListener?.('change', (event) => {
        if (!event.matches) this.close();
      });
      root.addEventListener?.('wolkenworte:localechange', () => this.handleLocaleChange());
    }

    currentLocale() {
      const raw = this.i18n?.getLocale?.() || this.document.documentElement.lang || 'de';
      const locale = String(raw).toLowerCase().split(/[-_]/)[0];
      return Object.hasOwn(this.searchIndexUrls, locale) ? locale : 'en';
    }

    loadSearchIndex(locale = this.currentLocale()) {
      const url = this.searchIndexUrls[locale];
      if (searchRecords.has(url)) return Promise.resolve(searchRecords.get(url));
      if (searchPromises.has(url)) return searchPromises.get(url);
      const request = root.fetch(url, { cache: 'force-cache' })
        .then((response) => {
          if (!response.ok) throw new Error(`Emoji search index returned ${response.status}.`);
          return response.json();
        })
        .then((index) => {
          if (index.cldrVersion !== SEARCH_INDEX_VERSION
              || index.unicodeVersion !== this.emoji.unicodeVersion
              || index.locale !== locale
              || index.entries?.length !== EXPECTED_EMOJI_COUNT) {
            throw new Error('Emoji search index version mismatch.');
          }
          const entries = this.search.prepare(index);
          const record = Object.freeze({
            entries,
            byKey: new Map(entries.map((entry) => [entry.key, entry])),
          });
          searchRecords.set(url, record);
          return record;
        })
        .catch((error) => {
          searchPromises.delete(url);
          throw error;
        });
      searchPromises.set(url, request);
      return request;
    }

    loadCatalog() {
      const url = this.catalogUrl;
      if (catalogs.has(url)) return Promise.resolve(catalogs.get(url));
      if (catalogPromises.has(url)) return catalogPromises.get(url);
      const request = root.fetch(url, { cache: 'force-cache' })
        .then((response) => {
          if (!response.ok) throw new Error(`Emoji catalog returned ${response.status}.`);
          return response.json();
        })
        .then((catalog) => {
          const keys = catalog.groups?.flatMap((group) => group.entries || []) || [];
          if (catalog.unicodeVersion !== this.emoji.unicodeVersion
              || catalog.count !== EXPECTED_EMOJI_COUNT
              || catalog.groups?.length !== EXPECTED_GROUP_COUNT
              || keys.length !== EXPECTED_EMOJI_COUNT
              || new Set(keys).size !== EXPECTED_EMOJI_COUNT) {
            throw new Error('Emoji catalog version mismatch.');
          }
          const prepared = Object.freeze({
            ...catalog,
            byKey: new Map(catalog.groups.map((group) => [group.key, group.entries])),
          });
          catalogs.set(url, prepared);
          return prepared;
        })
        .catch((error) => {
          catalogPromises.delete(url);
          throw error;
        });
      catalogPromises.set(url, request);
      return request;
    }

    readRecents() {
      try {
        const stored = JSON.parse(root.localStorage?.getItem(RECENTS_KEY) || '[]');
        if (!Array.isArray(stored)) return [];
        return stored.filter((key) => {
          const runs = this.emoji.parse(this.emoji.keyToString(key));
          return runs.length === 1 && runs[0].type === 'emoji' && runs[0].key === key;
        }).slice(0, RECENTS_LIMIT);
      } catch {
        return [];
      }
    }

    remember(emoji) {
      const runs = this.emoji.parse(emoji);
      if (runs.length !== 1 || runs[0].type !== 'emoji') return;
      const recents = [runs[0].key, ...this.readRecents().filter((key) => key !== runs[0].key)]
        .slice(0, RECENTS_LIMIT);
      try {
        root.localStorage?.setItem(RECENTS_KEY, JSON.stringify(recents));
      } catch {
        // Storage is an optional enhancement; the picker remains fully usable without it.
      }
    }

    recentItems() {
      const record = searchRecords.get(this.searchIndexUrls[this.currentLocale()]);
      const stored = this.readRecents();
      const fallback = FALLBACK_RECENTS
        .map((emoji) => this.emoji.parse(emoji)[0]?.key)
        .filter(Boolean);
      const keys = [...stored, ...fallback.filter((key) => !stored.includes(key))]
        .slice(0, RECENTS_LIMIT);
      return keys.map((key) => ({
        key,
        emoji: this.emoji.keyToString(key),
        name: record?.byKey.get(key)?.name || this.emoji.keyToString(key),
      }));
    }

    createOption(item, index) {
      const option = createElement(this.document, 'button', 'ww-emoji-option');
      option.type = 'button';
      option.tabIndex = index === this.focusedIndex ? 0 : -1;
      option.dataset.emojiIndex = String(index);
      option.dataset.i18nIgnore = '';
      option.style.left = `${(index % COLUMNS) * (100 / COLUMNS)}%`;
      option.style.top = `${Math.floor(index / COLUMNS) * ROW_HEIGHT}px`;
      this.emoji.renderInline(option, item.emoji);
      option.setAttribute('aria-label', item.name || item.emoji);
      if (item.name && item.name !== item.emoji) option.title = item.name;
      const image = option.querySelector('img');
      if (image) {
        image.loading = 'lazy';
        image.decoding = 'async';
      }
      option.addEventListener('click', () => this.select(item.emoji, option));
      return option;
    }

    renderVirtualWindow({ force = false } = {}) {
      const state = this.virtualState;
      if (!state) return;
      const range = this.virtualGrid.windowRange({
        itemCount: state.items.length,
        scrollTop: this.grid.scrollTop,
        viewportHeight: this.grid.clientHeight,
        columns: COLUMNS,
        rowHeight: ROW_HEIGHT,
        overscanRows: OVERSCAN_ROWS,
      });
      state.spacer.style.height = `${Math.max(126, range.totalHeight)}px`;
      if (!force && state.start === range.start && state.end === range.end) return;
      state.start = range.start;
      state.end = range.end;
      state.spacer.replaceChildren(...state.items
        .slice(range.start, range.end)
        .map((item, offset) => this.createOption(item, range.start + offset)));
    }

    renderOptions(items, { emptySource = 'Keine Emojis gefunden.', busy = false } = {}) {
      if (this.scrollFrame !== null) root.cancelAnimationFrame(this.scrollFrame);
      this.scrollFrame = null;
      this.grid.scrollTop = 0;
      this.grid.toggleAttribute('aria-busy', busy);
      this.focusedIndex = 0;
      this.virtualState = null;
      if (!items.length) {
        this.setText(this.empty, emptySource);
        this.empty.hidden = false;
        this.grid.removeAttribute('aria-rowcount');
        this.grid.replaceChildren(this.empty);
        return;
      }
      this.empty.hidden = true;
      const spacer = createElement(this.document, 'div', 'ww-emoji-virtual-spacer');
      spacer.setAttribute('aria-hidden', 'false');
      this.virtualState = { items, spacer, start: -1, end: -1 };
      this.grid.setAttribute('aria-rowcount', String(Math.ceil(items.length / COLUMNS)));
      this.grid.replaceChildren(spacer);
      this.renderVirtualWindow({ force: true });
    }

    focusOption(index) {
      const state = this.virtualState;
      if (!state?.items.length) return;
      this.focusedIndex = Math.max(0, Math.min(state.items.length - 1, index));
      const row = Math.floor(this.focusedIndex / COLUMNS);
      const rowTop = row * ROW_HEIGHT;
      const rowBottom = rowTop + ROW_HEIGHT;
      if (rowTop < this.grid.scrollTop) this.grid.scrollTop = rowTop;
      else if (rowBottom > this.grid.scrollTop + this.grid.clientHeight) {
        this.grid.scrollTop = rowBottom - this.grid.clientHeight;
      }
      this.renderVirtualWindow({ force: true });
      this.grid.querySelector(`[data-emoji-index="${this.focusedIndex}"]`)?.focus();
    }

    renderCategory(categoryKey = this.selectedCategory, { clearSearch = true } = {}) {
      const category = CATEGORIES.find((item) => item.key === categoryKey) || CATEGORIES[0];
      const revision = ++this.renderRevision;
      this.selectedCategory = category.key;
      if (clearSearch) this.searchInput.value = '';
      this.searchClear.hidden = true;
      this.clearText(this.status);
      for (const tab of this.categories.querySelectorAll('[role="tab"]')) {
        const selected = tab.dataset.emojiCategory === category.key;
        tab.setAttribute('aria-selected', String(selected));
        tab.tabIndex = selected ? 0 : -1;
      }
      this.grid.removeAttribute('aria-label');
      this.grid.removeAttribute('data-i18n-aria-label-source');
      this.grid.setAttribute('aria-labelledby', `${this.idPrefix}-category-${category.key}`);
      if (category.key === 'frequent') {
        this.renderOptions(this.recentItems());
        return;
      }
      this.renderOptions([], { emptySource: 'Emoji-Katalog wird geladen…', busy: true });
      Promise.all([this.loadSearchIndex(), this.loadCatalog()]).then(([record, catalog]) => {
        if (revision !== this.renderRevision
            || this.selectedCategory !== category.key
            || this.searchInput.value.trim()) return;
        const items = (catalog.byKey.get(category.key) || []).map((key) => ({
          key,
          emoji: this.emoji.keyToString(key),
          name: record.byKey.get(key)?.name || this.emoji.keyToString(key),
        }));
        this.renderOptions(items);
      }).catch(() => {
        if (revision === this.renderRevision && !this.searchInput.value.trim()) {
          this.renderOptions([], { emptySource: 'Emoji-Katalog konnte nicht geladen werden.' });
        }
      });
    }

    renderSearch() {
      const query = this.searchInput.value.trim();
      this.searchClear.hidden = !query;
      if (!query) {
        this.renderCategory(this.selectedCategory, { clearSearch: false });
        return;
      }
      const revision = ++this.renderRevision;
      for (const tab of this.categories.querySelectorAll('[role="tab"]')) {
        tab.setAttribute('aria-selected', 'false');
      }
      this.grid.removeAttribute('aria-labelledby');
      this.setAttribute(this.grid, 'aria-label', 'Suchergebnisse');
      const locale = this.currentLocale();
      const url = this.searchIndexUrls[locale];
      const record = searchRecords.get(url);
      if (!record) {
        this.renderOptions([], { emptySource: 'Emoji-Suche wird geladen…', busy: true });
        this.loadSearchIndex(locale).then(() => {
          if (revision === this.renderRevision
              && this.currentLocale() === locale
              && this.searchInput.value.trim()) this.renderSearch();
        }).catch(() => {
          if (revision === this.renderRevision
              && this.currentLocale() === locale
              && this.searchInput.value.trim()) {
            this.renderOptions([], { emptySource: 'Emoji-Suche konnte nicht geladen werden.' });
          }
        });
        return;
      }
      const results = this.search.search(record.entries, query, {
        limit: EXPECTED_EMOJI_COUNT,
        includeSkinTones: true,
      });
      this.renderOptions(results.map((entry) => ({
        key: entry.key,
        emoji: this.emoji.keyToString(entry.key),
        name: entry.name,
      })));
      const count = this.i18n?.formatNumber
        ? this.i18n.formatNumber(results.length)
        : String(results.length);
      this.setText(this.status, '{{count}} Emojis gefunden', { count });
    }

    scheduleSearch() {
      clearTimeout(this.searchTimer);
      this.searchClear.hidden = !this.searchInput.value.trim();
      if (!this.searchInput.value.trim()) {
        this.renderSearch();
        return;
      }
      this.searchTimer = setTimeout(() => this.renderSearch(), SEARCH_DELAY_MS);
    }

    renderCategories() {
      this.categories.replaceChildren(...CATEGORIES.map((category) => {
        const tab = createElement(this.document, 'button', 'ww-emoji-category');
        tab.id = `${this.idPrefix}-category-${category.key}`;
        tab.type = 'button';
        tab.dataset.emojiCategory = category.key;
        tab.setAttribute('role', 'tab');
        tab.setAttribute('aria-controls', this.grid.id);
        this.setAttribute(tab, 'aria-label', category.label);
        this.setAttribute(tab, 'title', category.label);
        tab.appendChild(createCategoryIcon(this.document, category.icon));
        tab.addEventListener('click', () => this.renderCategory(category.key));
        return tab;
      }));
      this.renderCategory();
    }

    initialize() {
      if (this.initialized) return;
      this.initialized = true;
      this.renderCategories();
    }

    async select(emoji, option) {
      if (this.selectionPending) return;
      this.selectionPending = true;
      option.disabled = true;
      this.panel.setAttribute('aria-busy', 'true');
      try {
        await this.onSelect(emoji);
        this.remember(emoji);
        this.close();
      } catch (error) {
        this.onError(error);
      } finally {
        this.selectionPending = false;
        option.disabled = false;
        this.panel.removeAttribute('aria-busy');
      }
    }

    open() {
      if (this.mediaQuery && !this.mediaQuery.matches) return false;
      this.onOpen();
      this.initialize();
      this.panel.hidden = false;
      this.trigger.setAttribute('aria-expanded', 'true');
      this.renderVirtualWindow({ force: true });
      const locale = this.currentLocale();
      Promise.all([this.loadSearchIndex(locale), this.loadCatalog()]).then(() => {
        if (this.panel.hidden || this.currentLocale() !== locale) return;
        if (this.searchInput.value.trim()) this.renderSearch();
        else this.renderCategory(this.selectedCategory, { clearSearch: false });
      }).catch(() => {});
      this.searchInput.focus({ preventScroll: true });
      return true;
    }

    close({ focusTrigger = false } = {}) {
      if (this.panel.hidden) return;
      this.panel.hidden = true;
      this.trigger.setAttribute('aria-expanded', 'false');
      if (this.searchInput.value) this.renderCategory(this.selectedCategory);
      if (focusTrigger) this.trigger.focus();
    }

    handleGridKeydown(event) {
      if (!['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Home', 'End'].includes(event.key)) return;
      const focusedIndex = Number.parseInt(this.document.activeElement?.dataset?.emojiIndex, 10);
      if (!Number.isInteger(focusedIndex) || !this.virtualState?.items.length) return;
      event.preventDefault();
      let nextIndex = focusedIndex;
      if (event.key === 'Home') nextIndex = 0;
      else if (event.key === 'End') nextIndex = this.virtualState.items.length - 1;
      else if (event.key === 'ArrowLeft') nextIndex = Math.max(0, focusedIndex - 1);
      else if (event.key === 'ArrowRight') nextIndex = Math.min(this.virtualState.items.length - 1, focusedIndex + 1);
      else if (event.key === 'ArrowUp') nextIndex = Math.max(0, focusedIndex - COLUMNS);
      else if (event.key === 'ArrowDown') nextIndex = Math.min(this.virtualState.items.length - 1, focusedIndex + COLUMNS);
      this.focusOption(nextIndex);
    }

    handlePanelKeydown(event) {
      if (event.key === 'Escape') {
        event.preventDefault();
        this.close({ focusTrigger: true });
        return;
      }
      if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
      const tabs = [...this.categories.querySelectorAll('[role="tab"]')];
      const focusedIndex = tabs.indexOf(this.document.activeElement);
      if (focusedIndex < 0) return;
      event.preventDefault();
      let nextIndex = focusedIndex;
      if (event.key === 'Home') nextIndex = 0;
      else if (event.key === 'End') nextIndex = tabs.length - 1;
      else nextIndex = (focusedIndex + (event.key === 'ArrowRight' ? 1 : -1) + tabs.length) % tabs.length;
      tabs[nextIndex].focus();
      this.renderCategory(tabs[nextIndex].dataset.emojiCategory);
    }

    handleLocaleChange() {
      ++this.renderRevision;
      if (!this.initialized || this.panel.hidden) return;
      const locale = this.currentLocale();
      this.loadSearchIndex(locale).then(() => {
        if (this.panel.hidden || this.currentLocale() !== locale) return;
        if (this.searchInput.value.trim()) this.renderSearch();
        else this.renderCategory(this.selectedCategory, { clearSearch: false });
      }).catch(() => {});
    }
  }

  return Object.freeze({
    EmojiPicker,
    create: (options) => new EmojiPicker(options),
    CATEGORIES,
    FALLBACK_RECENTS,
    RECENTS_KEY,
    RECENTS_LIMIT,
    COLUMNS,
    ROW_HEIGHT,
    OVERSCAN_ROWS,
    SEARCH_DELAY_MS,
  });
});
