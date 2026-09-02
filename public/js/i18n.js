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
  const ATTRIBUTE_NAMES = Object.freeze(['aria-label', 'placeholder', 'title', 'alt', 'content']);
  const textSources = new WeakMap();
  const attributeSources = new WeakMap();
  let locale = DEFAULT_LOCALE;
  let localeSource = 'default';
  let messages = {};
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
    if (SUPPORTED_LOCALES.includes(renderedLocale)) {
      return {
        locale: renderedLocale,
        source: root.document?.documentElement?.dataset?.localeSource || 'server',
      };
    }
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

  function parseParams(element, attributeName) {
    const raw = element?.getAttribute(attributeName);
    if (!raw) return {};
    try {
      const parsed = JSON.parse(raw);
      return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
    } catch {
      return {};
    }
  }

  function storeParams(element, attributeName, params) {
    if (!element) return;
    if (params && Object.keys(params).length) {
      element.setAttribute(attributeName, JSON.stringify(params));
    } else {
      element.removeAttribute(attributeName);
    }
  }

  function setText(element, source, params = {}) {
    if (!element) return;
    const normalizedSource = String(source);
    element.setAttribute('data-i18n-source', normalizedSource);
    storeParams(element, 'data-i18n-params', params);
    element.textContent = t(normalizedSource, params);
    if (element.firstChild?.nodeType === 3) {
      textSources.set(element.firstChild, { source: normalizedSource, params: { ...params } });
    }
  }

  function clearText(element) {
    if (!element) return;
    element.removeAttribute('data-i18n-source');
    element.removeAttribute('data-i18n-params');
    element.replaceChildren();
  }

  function setAttribute(element, name, source, params = {}) {
    if (!element || !ATTRIBUTE_NAMES.includes(name)) return;
    const normalizedSource = String(source);
    element.setAttribute(`data-i18n-${name}-source`, normalizedSource);
    storeParams(element, `data-i18n-${name}-params`, params);
    element.setAttribute(name, t(normalizedSource, params));
    let sources = attributeSources.get(element);
    if (!sources) {
      sources = {};
      attributeSources.set(element, sources);
    }
    sources[name] = { source: normalizedSource, params: { ...params } };
  }

  function translateTextNode(node) {
    if (!node || node.nodeType !== 3 || !node.parentElement) return;
    if (node.parentElement.closest('script, style, [data-i18n-ignore]')) return;
    const current = node.nodeValue || '';
    const parent = node.parentElement;
    const directSource = parent.childNodes.length === 1
      ? parent.getAttribute('data-i18n-source')
      : '';
    let indexedSource = '';
    if (!directSource) {
      const encodedSources = parent.getAttribute('data-i18n-text-sources');
      if (encodedSources) {
        try {
          const sources = JSON.parse(encodedSources);
          const childIndex = Array.prototype.indexOf.call(parent.childNodes, node);
          indexedSource = sources?.[childIndex] || '';
        } catch {}
      }
    }
    const declaredSource = directSource || indexedSource;
    let binding = textSources.get(node);
    if (declaredSource) {
      binding = {
        source: declaredSource,
        params: parseParams(node.parentElement, 'data-i18n-params'),
      };
      textSources.set(node, binding);
    }
    if (!binding) return;
    const translated = replaceTrimmed(current, t(binding.source, binding.params));
    if (translated !== current) node.nodeValue = translated;
  }

  function replaceTrimmed(value, replacement) {
    const start = value.match(/^\s*/)?.[0] || '';
    const end = value.match(/\s*$/)?.[0] || '';
    return `${start}${replacement}${end}`;
  }

  function translateAttributes(element) {
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
      if (declaredSource) {
        sources[name] = {
          source: declaredSource,
          params: parseParams(element, `data-i18n-${name}-params`),
        };
      }
      if (!sources[name]) continue;
      const translated = t(sources[name].source, sources[name].params);
      if (translated !== current) element.setAttribute(name, translated);
    }
  }

  function translateTree(scope) {
    if (!root.document || !scope) return;
    if (scope.nodeType === 3) {
      translateTextNode(scope);
      return;
    }
    if (scope.nodeType !== 1 && scope.nodeType !== 9 && scope.nodeType !== 11) return;
    if (scope.nodeType === 1) translateAttributes(scope);
    const walker = root.document.createTreeWalker(scope, root.NodeFilter.SHOW_ELEMENT | root.NodeFilter.SHOW_TEXT);
    let node = walker.nextNode();
    while (node) {
      if (node.nodeType === 3) translateTextNode(node);
      else translateAttributes(node);
      node = walker.nextNode();
    }
    root.document.documentElement.lang = locale;
  }

  async function loadMessages(nextLocale) {
    if (catalogPromises.has(nextLocale)) return catalogPromises.get(nextLocale);
    if (!root.fetch) return {};
    const request = (async () => {
      const renderedRoot = root.document?.documentElement;
      const renderedLocale = normalizeLocale(renderedRoot?.lang, '');
      let catalogUrls = {};
      try {
        catalogUrls = JSON.parse(renderedRoot?.dataset?.localeCatalogUrls || '{}');
      } catch {}
      const renderedUrl = catalogUrls[nextLocale] || (renderedLocale === nextLocale
        ? renderedRoot?.dataset?.localeCatalogUrl
        : '');
      const response = await root.fetch(
        renderedUrl || `/locales/${encodeURIComponent(nextLocale)}.json`,
        { cache: renderedUrl ? 'force-cache' : 'no-cache' }
      );
      if (!response.ok) throw new Error(`Could not load locale ${nextLocale}`);
      return response.json();
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
    if (root.document) translateTree(root.document);
    updateLanguageSelector();
    if (root.dispatchEvent && typeof root.CustomEvent === 'function') {
      root.dispatchEvent(new root.CustomEvent('wolkenworte:localechange', {
        detail: { locale, source: localeSource },
      }));
    }
    return locale;
  }

  async function useEventLocale(eventLocale) {
    await readyPromise;
    if (localeSource === 'query' || localeSource === 'stored' || localeSource === 'cookie') return locale;
    const nextLocale = normalizeLocale(eventLocale);
    if (nextLocale === locale) return locale;
    return setLocale(nextLocale, { source: 'event' });
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

  function updateLanguagePicker(picker) {
    const trigger = picker.querySelector('[data-language-trigger]');
    const menu = picker.querySelector('[data-language-menu]');
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

  function updateLanguageSelector() {
    for (const picker of root.document?.querySelectorAll('[data-language-picker]') || []) {
      updateLanguagePicker(picker);
    }
  }

  function languageUrl(href, code) {
    const url = new URL(href);
    url.searchParams.set('lang', normalizeLocale(code));
    return url.toString();
  }

  function enhanceLanguagePicker(picker) {
    if (picker.dataset.enhanced === 'true') return;
    picker.dataset.enhanced = 'true';
    const trigger = picker.querySelector('[data-language-trigger]');
    const options = Array.from(picker.querySelectorAll('[data-language-code]'));
    const stackingHost = picker.closest('header');
    let selectionId = 0;
    picker.addEventListener('toggle', () => {
      const hasOpenPicker = Boolean(stackingHost?.querySelector('[data-language-picker][open]'));
      stackingHost?.classList.toggle('ww-language-host-open', hasOpenPicker);
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
    updateLanguagePicker(picker);
  }

  function enhanceLanguageSelectors() {
    for (const picker of root.document?.querySelectorAll('[data-language-picker]') || []) {
      enhanceLanguagePicker(picker);
    }
  }

  if (root.document) {
    const initial = initialLocale();
    locale = initial.locale;
    localeSource = initial.source;
    root.document.documentElement.lang = locale;
    readyPromise = setLocale(locale, { source: localeSource });
    root.document.addEventListener('DOMContentLoaded', async () => {
      enhanceLanguageSelectors();
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
    setText,
    clearText,
    setAttribute,
    translateTree,
    formatCurrency,
    formatNumber,
    displayRegion,
  });
});
