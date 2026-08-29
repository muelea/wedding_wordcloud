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
  const LANGUAGE_FLAGS = Object.freeze({
    de: '🇩🇪',
    en: '🇺🇸',
    fr: '🇫🇷',
    it: '🇮🇹',
    es: '🇪🇸',
    tr: '🇹🇷',
  });
  const LEGACY_STORAGE_KEY = 'wolkenworte-language';
  const COOKIE_KEY = 'wolkenworte-language';
  const CATALOG_VERSION = '20260829-2';
  const ATTRIBUTE_NAMES = Object.freeze(['aria-label', 'placeholder', 'title', 'alt', 'content']);
  const textSources = new WeakMap();
  const attributeSources = new WeakMap();
  let locale = DEFAULT_LOCALE;
  let localeSource = 'default';
  let messages = {};
  let observer = null;
  let readyPromise = Promise.resolve();
  let localeRequestId = 0;
  const catalogPromises = new Map([[DEFAULT_LOCALE, Promise.resolve({})]]);

  function normalizeLocale(value, fallback = DEFAULT_LOCALE) {
    const candidate = String(value || '').trim().toLowerCase().split(/[-_]/)[0];
    return SUPPORTED_LOCALES.includes(candidate) ? candidate : fallback;
  }

  function readCookieLocale() {
    try {
      const prefix = `${COOKIE_KEY}=`;
      const pair = String(root.document?.cookie || '')
        .split(';')
        .map((value) => value.trim())
        .find((value) => value.startsWith(prefix));
      return pair ? decodeURIComponent(pair.slice(prefix.length)) : '';
    } catch {
      return '';
    }
  }

  function persistLocale(value) {
    try {
      const secure = root.location?.protocol === 'https:' ? '; Secure' : '';
      root.document.cookie = `${COOKIE_KEY}=${encodeURIComponent(value)}; Path=/; Max-Age=31536000; SameSite=Lax${secure}`;
    } catch {}
    // The cookie is the single source of truth because the server can read it
    // before rendering. Remove the pre-SSR implementation's duplicate value.
    try { root.localStorage?.removeItem(LEGACY_STORAGE_KEY); } catch {}
  }

  function initialLocale() {
    if (!root.location) return { locale: DEFAULT_LOCALE, source: 'default' };
    const queryLocale = new URLSearchParams(root.location.search).get('lang');
    if (SUPPORTED_LOCALES.includes(normalizeLocale(queryLocale, ''))) {
      return { locale: normalizeLocale(queryLocale), source: 'query' };
    }
    const cookieLocale = normalizeLocale(readCookieLocale(), '');
    if (SUPPORTED_LOCALES.includes(cookieLocale)) return { locale: cookieLocale, source: 'stored' };
    const renderedLocale = normalizeLocale(root.document?.documentElement?.lang, '');
    if (SUPPORTED_LOCALES.includes(renderedLocale)) return { locale: renderedLocale, source: 'server' };
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
    const declaredSource = node.parentElement.getAttribute('data-i18n-source');
    let source = declaredSource || textSources.get(node);
    if (declaredSource) {
      textSources.set(node, declaredSource);
    } else if (!source || (!preserveSource && current !== replaceTrimmed(current, t(source)))) {
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
      const declaredSource = element.getAttribute(`data-i18n-${name}-source`);
      if (declaredSource) sources[name] = declaredSource;
      else if (!sources[name] || (!preserveSource && current !== t(sources[name]))) sources[name] = current;
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
    if (catalogPromises.has(nextLocale)) return catalogPromises.get(nextLocale);
    if (!root.fetch) return {};
    const request = (async () => {
      const locales = nextLocale === 'en' ? ['en'] : ['en', nextLocale];
      const loaded = await Promise.all(locales.map(async (code) => {
        const response = await root.fetch(
          `/locales/${encodeURIComponent(code)}.json?v=${CATALOG_VERSION}`,
          { cache: 'force-cache' }
        );
        if (!response.ok) throw new Error(`Could not load locale ${code}`);
        return response.json();
      }));
      return Object.assign({}, ...loaded);
    })();
    catalogPromises.set(nextLocale, request);
    try {
      return await request;
    } catch (error) {
      catalogPromises.delete(nextLocale);
      throw error;
    }
  }

  async function setLocale(value, options = {}) {
    const nextLocale = normalizeLocale(value);
    const requestId = ++localeRequestId;
    let loaded;
    try {
      loaded = await loadMessages(nextLocale);
    } catch (error) {
      if (requestId === localeRequestId && root.dispatchEvent && typeof root.CustomEvent === 'function') {
        root.dispatchEvent(new root.CustomEvent('wolkenworte:localeerror', {
          detail: { locale: nextLocale },
        }));
      }
      return locale;
    }
    if (requestId !== localeRequestId) return locale;
    locale = nextLocale;
    messages = loaded;
    if (options.source) localeSource = options.source;
    if (options.persist) {
      localeSource = 'stored';
      persistLocale(locale);
    }
    if (root.document) translateTree(root.document, true);
    updateLanguageSelector();
    if (root.dispatchEvent && typeof root.CustomEvent === 'function') {
      root.dispatchEvent(new root.CustomEvent('wolkenworte:localechange', {
        detail: { locale, source: localeSource },
      }));
    }
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

  function updateLanguageSelector() {
    const picker = root.document?.querySelector('.ww-language-picker');
    if (!picker) return;
    const trigger = picker.querySelector('#ww-language-select');
    const menu = picker.querySelector('#ww-language-menu');
    const currentFlag = picker.querySelector('.ww-language-current-flag');
    const currentName = picker.querySelector('.ww-language-current-name');
    if (currentFlag) currentFlag.textContent = LANGUAGE_FLAGS[locale];
    if (currentName) currentName.textContent = LANGUAGE_NAMES[locale];
    if (trigger) trigger.setAttribute('aria-label', `${t('Sprache')}: ${LANGUAGE_NAMES[locale]}`);
    if (menu) menu.setAttribute('aria-label', t('Sprache'));
    picker.querySelectorAll('[data-language-code]').forEach((option) => {
      const isSelected = option.dataset.languageCode === locale;
      if (isSelected) option.setAttribute('aria-current', 'true');
      else option.removeAttribute('aria-current');
      option.classList.toggle('is-selected', isSelected);
      option.href = languageUrl(root.location.href, option.dataset.languageCode);
    });
  }

  function languageUrl(href, code) {
    const url = new URL(href);
    url.searchParams.set('lang', normalizeLocale(code));
    return url.toString();
  }

  function enhanceLanguageSelector() {
    const picker = root.document?.querySelector('.ww-language-picker');
    if (!picker || picker.dataset.enhanced === 'true') return;
    picker.dataset.enhanced = 'true';
    const trigger = picker.querySelector('#ww-language-select');
    const options = Array.from(picker.querySelectorAll('[data-language-code]'));
    const stackingHost = picker.closest('header');
    let selectionId = 0;

    picker.addEventListener('toggle', () => {
      stackingHost?.classList.toggle('ww-language-host-open', picker.open);
    });
    options.forEach((option) => {
      option.addEventListener('click', async (event) => {
        if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
        event.preventDefault();
        const nextLocale = normalizeLocale(option.dataset.languageCode);
        const currentSelectionId = ++selectionId;
        picker.open = false;
        trigger?.setAttribute('aria-busy', 'true');
        const appliedLocale = await setLocale(nextLocale, { persist: true, source: 'stored' });
        if (appliedLocale === nextLocale) {
          const nextUrl = languageUrl(root.location.href, nextLocale);
          root.history?.replaceState(root.history.state, '', nextUrl);
          updateLanguageSelector();
        }
        if (currentSelectionId === selectionId) {
          trigger?.removeAttribute('aria-busy');
          trigger?.focus();
        }
      });
    });
    root.document.addEventListener('pointerdown', (event) => {
      if (!picker.contains(event.target)) picker.open = false;
    });
    root.document.addEventListener('keydown', (event) => {
      if (event.key === 'Escape' && picker.open) {
        picker.open = false;
        trigger?.focus();
      }
    });
    updateLanguageSelector();
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
      enhanceLanguageSelector();
      startObserver();
      await readyPromise;
      translateTree(root.document);
    });
  }

  return Object.freeze({
    DEFAULT_LOCALE,
    SUPPORTED_LOCALES,
    LANGUAGE_NAMES,
    LANGUAGE_FLAGS,
    languageUrl,
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
