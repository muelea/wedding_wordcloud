(function (root, factory) {
  'use strict';

  const api = factory(root);
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.WolkenworteI18n = api;
})(typeof window !== 'undefined' ? window : globalThis, function (root) {
  'use strict';

  const DEFAULT_LOCALE = 'de';
  const SUPPORTED_LOCALES = Object.freeze(['de', 'en', 'fr', 'it', 'es', 'tr']);
  const LANGUAGE_NAMES = Object.freeze({
    de: 'Deutsch',
    en: 'English',
    fr: 'Français',
    it: 'Italiano',
    es: 'Español',
    tr: 'Türkçe',
  });
  const STORAGE_KEY = 'wolkenworte-language';
  const ATTRIBUTE_NAMES = Object.freeze(['aria-label', 'placeholder', 'title', 'alt', 'content']);
  const textSources = new WeakMap();
  const attributeSources = new WeakMap();
  let locale = DEFAULT_LOCALE;
  let localeSource = 'default';
  let messages = {};
  let observer = null;
  let readyPromise = Promise.resolve();

  function normalizeLocale(value, fallback = DEFAULT_LOCALE) {
    const candidate = String(value || '').trim().toLowerCase().split(/[-_]/)[0];
    return SUPPORTED_LOCALES.includes(candidate) ? candidate : fallback;
  }

  function readStoredLocale() {
    try {
      return root.localStorage?.getItem(STORAGE_KEY) || '';
    } catch {
      return '';
    }
  }

  function initialLocale() {
    if (!root.location) return { locale: DEFAULT_LOCALE, source: 'default' };
    const queryLocale = new URLSearchParams(root.location.search).get('lang');
    if (SUPPORTED_LOCALES.includes(normalizeLocale(queryLocale, ''))) {
      return { locale: normalizeLocale(queryLocale), source: 'query' };
    }
    const storedLocale = normalizeLocale(readStoredLocale(), '');
    if (SUPPORTED_LOCALES.includes(storedLocale)) return { locale: storedLocale, source: 'stored' };
    const browserLocale = normalizeLocale(root.navigator?.languages?.[0] || root.navigator?.language);
    return { locale: browserLocale, source: 'browser' };
  }

  function interpolate(value, params) {
    return String(value).replace(/\{\{\s*([\w]+)\s*\}\}/g, (match, key) => (
      Object.hasOwn(params || {}, key) ? String(params[key]) : match
    ));
  }

  function t(source, params = {}) {
    const normalizedSource = String(source).replace(/\s+/g, ' ').trim();
    return interpolate(messages[source] || messages[normalizedSource] || source, params);
  }

  function translateTextNode(node, preserveSource = false) {
    if (!node || node.nodeType !== 3 || !node.parentElement) return;
    if (node.parentElement.closest('script, style, [data-i18n-ignore]')) return;
    const current = node.nodeValue || '';
    const trimmed = current.trim();
    if (!trimmed) return;
    let source = textSources.get(node);
    if (!source || (!preserveSource && current !== replaceTrimmed(current, t(source)))) {
      source = trimmed;
      textSources.set(node, source);
    }
    const translated = replaceTrimmed(current, t(source));
    if (translated !== current) node.nodeValue = translated;
  }

  function replaceTrimmed(value, replacement) {
    const start = value.match(/^\s*/)?.[0] || '';
    const end = value.match(/\s*$/)?.[0] || '';
    return `${start}${replacement}${end}`;
  }

  function translateAttributes(element, preserveSource = false) {
    if (!element || element.nodeType !== 1 || element.closest('[data-i18n-ignore]')) return;
    let sources = attributeSources.get(element);
    if (!sources) {
      sources = {};
      attributeSources.set(element, sources);
    }
    for (const name of ATTRIBUTE_NAMES) {
      if (!element.hasAttribute(name)) continue;
      const current = element.getAttribute(name);
      if (!current) continue;
      if (!sources[name] || (!preserveSource && current !== t(sources[name]))) sources[name] = current;
      const translated = t(sources[name]);
      if (translated !== current) element.setAttribute(name, translated);
    }
  }

  function translateTree(scope, preserveSource = false) {
    if (!root.document || !scope) return;
    if (scope.nodeType === 3) {
      translateTextNode(scope, preserveSource);
      return;
    }
    if (scope.nodeType !== 1 && scope.nodeType !== 9 && scope.nodeType !== 11) return;
    if (scope.nodeType === 1) translateAttributes(scope, preserveSource);
    const walker = root.document.createTreeWalker(scope, root.NodeFilter.SHOW_ELEMENT | root.NodeFilter.SHOW_TEXT);
    let node = walker.nextNode();
    while (node) {
      if (node.nodeType === 3) translateTextNode(node, preserveSource);
      else translateAttributes(node, preserveSource);
      node = walker.nextNode();
    }
    root.document.documentElement.lang = locale;
  }

  async function loadMessages(nextLocale) {
    if (nextLocale === DEFAULT_LOCALE || !root.fetch) return {};
    const locales = nextLocale === 'en' ? ['en'] : ['en', nextLocale];
    const loaded = await Promise.all(locales.map(async (code) => {
      const response = await root.fetch(`/locales/${encodeURIComponent(code)}.json`, { cache: 'no-store' });
      if (!response.ok) throw new Error(`Could not load locale ${code}`);
      return response.json();
    }));
    return Object.assign({}, ...loaded);
  }

  async function setLocale(value, options = {}) {
    const nextLocale = normalizeLocale(value);
    const loaded = await loadMessages(nextLocale).catch(() => ({}));
    locale = nextLocale;
    messages = loaded;
    if (options.source) localeSource = options.source;
    if (options.persist) {
      localeSource = 'stored';
      try { root.localStorage?.setItem(STORAGE_KEY, locale); } catch {}
    }
    if (root.document) translateTree(root.document, true);
    const selector = root.document?.getElementById('ww-language-select');
    if (selector) selector.value = locale;
    return locale;
  }

  async function useEventLocale(eventLocale) {
    if (localeSource === 'query' || localeSource === 'stored') return locale;
    return setLocale(eventLocale, { source: 'event' });
  }

  function formatCurrency(cents, currency = 'EUR') {
    return new Intl.NumberFormat(locale, { style: 'currency', currency }).format(Number(cents) / 100);
  }

  function formatNumber(value, options) {
    return new Intl.NumberFormat(locale, options).format(value);
  }

  function displayRegion(code) {
    try {
      return new Intl.DisplayNames([locale], { type: 'region' }).of(code) || code;
    } catch {
      return code;
    }
  }

  function mountLanguageSelector() {
    if (!root.document?.body || root.document.getElementById('ww-language-select')) return;
    const wrapper = root.document.createElement('label');
    wrapper.className = 'ww-language-picker';
    wrapper.setAttribute('data-i18n-ignore', '');
    wrapper.setAttribute('aria-label', t('Sprache'));
    const select = root.document.createElement('select');
    select.id = 'ww-language-select';
    select.setAttribute('aria-label', t('Sprache'));
    for (const code of SUPPORTED_LOCALES) {
      const option = root.document.createElement('option');
      option.value = code;
      option.textContent = LANGUAGE_NAMES[code];
      select.appendChild(option);
    }
    select.value = locale;
    select.addEventListener('change', () => {
      try { root.localStorage?.setItem(STORAGE_KEY, select.value); } catch {}
      const url = new URL(root.location.href);
      url.searchParams.set('lang', select.value);
      root.location.assign(url.toString());
    });
    wrapper.appendChild(select);
    const container = root.document.querySelector('.ww-nav') ||
      root.document.querySelector('body > .header');
    if (container) {
      wrapper.classList.add('ww-language-inline');
      if (container.classList.contains('ww-nav') && container.lastElementChild) {
        container.insertBefore(wrapper, container.lastElementChild);
      } else {
        container.appendChild(wrapper);
      }
    } else {
      root.document.body.appendChild(wrapper);
    }
  }

  function startObserver() {
    if (!root.document || observer || typeof root.MutationObserver !== 'function') return;
    observer = new root.MutationObserver((records) => {
      for (const record of records) {
        if (record.type === 'characterData') translateTextNode(record.target);
        if (record.type === 'attributes') translateAttributes(record.target);
        for (const node of record.addedNodes || []) translateTree(node);
      }
    });
    observer.observe(root.document.documentElement, {
      subtree: true,
      childList: true,
      characterData: true,
      attributes: true,
      attributeFilter: ATTRIBUTE_NAMES,
    });
  }

  if (root.document) {
    const initial = initialLocale();
    locale = initial.locale;
    localeSource = initial.source;
    root.document.documentElement.lang = locale;
    readyPromise = setLocale(locale, { source: localeSource });
    root.document.addEventListener('DOMContentLoaded', async () => {
      await readyPromise;
      translateTree(root.document);
      mountLanguageSelector();
      startObserver();
    });
  }

  return Object.freeze({
    DEFAULT_LOCALE,
    SUPPORTED_LOCALES,
    LANGUAGE_NAMES,
    normalizeLocale,
    getLocale: () => locale,
    getLocaleSource: () => localeSource,
    ready: () => readyPromise,
    setLocale,
    useEventLocale,
    t,
    translateTree,
    formatCurrency,
    formatNumber,
    displayRegion,
  });
});
