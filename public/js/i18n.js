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
    updateLanguageSelector();
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
    const currentFlag = picker.querySelector('.ww-language-current-flag');
    const currentName = picker.querySelector('.ww-language-current-name');
    if (currentFlag) currentFlag.textContent = LANGUAGE_FLAGS[locale];
    if (currentName) currentName.textContent = LANGUAGE_NAMES[locale];
    if (trigger) trigger.setAttribute('aria-label', `${t('Sprache')}: ${LANGUAGE_NAMES[locale]}`);
    picker.querySelectorAll('[data-language-code]').forEach((option) => {
      const isSelected = option.dataset.languageCode === locale;
      option.setAttribute('aria-selected', String(isSelected));
      option.classList.toggle('is-selected', isSelected);
    });
  }

  function createLanguageMenuController({
    optionCodes,
    getSelectedCode,
    getOpen,
    setOpen,
    getFocusedIndex,
    focusOption,
    focusTrigger,
    onChoose,
  }) {
    const codes = [...optionCodes];

    function close({ restoreFocus = false } = {}) {
      if (!getOpen()) return;
      setOpen(false);
      if (restoreFocus) focusTrigger();
    }

    function open(direction = 0) {
      setOpen(true);
      const selectedIndex = Math.max(0, codes.indexOf(getSelectedCode()));
      const focusIndex = (selectedIndex + direction + codes.length) % codes.length;
      focusOption(focusIndex);
    }

    function toggle() {
      if (getOpen()) close({ restoreFocus: true });
      else open();
    }

    function choose(code) {
      if (!codes.includes(code)) return false;
      close();
      onChoose(code);
      return true;
    }

    function handleTriggerKey(key) {
      if (key !== 'ArrowDown' && key !== 'ArrowUp') return false;
      open(key === 'ArrowDown' ? 1 : -1);
      return true;
    }

    function handleMenuKey(key) {
      const currentIndex = getFocusedIndex();
      let nextIndex = currentIndex;
      if (key === 'ArrowDown') nextIndex = (currentIndex + 1) % codes.length;
      else if (key === 'ArrowUp') nextIndex = (currentIndex - 1 + codes.length) % codes.length;
      else if (key === 'Home') nextIndex = 0;
      else if (key === 'End') nextIndex = codes.length - 1;
      else if (key === 'Escape') {
        close({ restoreFocus: true });
        return true;
      } else {
        return false;
      }
      focusOption(nextIndex);
      return true;
    }

    return Object.freeze({ close, open, toggle, choose, handleTriggerKey, handleMenuKey });
  }

  function languageUrl(href, code) {
    const url = new URL(href);
    url.searchParams.set('lang', normalizeLocale(code));
    return url.toString();
  }

  function mountLanguageSelector() {
    if (!root.document?.body || root.document.getElementById('ww-language-select')) return;
    const container = root.document.querySelector('.ww-nav');
    if (!container) return;
    const wrapper = root.document.createElement('div');
    wrapper.className = 'ww-language-picker';
    wrapper.setAttribute('data-i18n-ignore', '');

    const trigger = root.document.createElement('button');
    trigger.id = 'ww-language-select';
    trigger.className = 'ww-language-trigger';
    trigger.type = 'button';
    trigger.setAttribute('aria-haspopup', 'listbox');
    trigger.setAttribute('aria-expanded', 'false');
    trigger.setAttribute('aria-controls', 'ww-language-menu');

    const currentFlag = root.document.createElement('span');
    currentFlag.className = 'ww-language-flag ww-language-current-flag';
    currentFlag.setAttribute('aria-hidden', 'true');
    const currentName = root.document.createElement('span');
    currentName.className = 'ww-language-current-name';
    const chevron = root.document.createElement('span');
    chevron.className = 'ww-language-chevron';
    chevron.setAttribute('aria-hidden', 'true');
    trigger.append(currentFlag, currentName, chevron);

    const menu = root.document.createElement('div');
    menu.id = 'ww-language-menu';
    menu.className = 'ww-language-menu';
    menu.setAttribute('role', 'listbox');
    menu.setAttribute('aria-label', t('Sprache'));
    menu.hidden = true;

    for (const code of SUPPORTED_LOCALES) {
      const option = root.document.createElement('button');
      option.id = `ww-language-option-${code}`;
      option.className = 'ww-language-option';
      option.type = 'button';
      option.dataset.languageCode = code;
      option.setAttribute('role', 'option');

      const flag = root.document.createElement('span');
      flag.className = 'ww-language-flag';
      flag.setAttribute('aria-hidden', 'true');
      flag.textContent = LANGUAGE_FLAGS[code];
      const name = root.document.createElement('span');
      name.className = 'ww-language-option-name';
      name.textContent = LANGUAGE_NAMES[code];
      const check = root.document.createElement('span');
      check.className = 'ww-language-check';
      check.setAttribute('aria-hidden', 'true');
      check.textContent = '✓';
      option.append(flag, name, check);
      menu.appendChild(option);
    }

    const options = Array.from(menu.querySelectorAll('[data-language-code]'));
    let stackingHost = null;

    function chooseLanguage(code) {
      try { root.localStorage?.setItem(STORAGE_KEY, code); } catch {}
      root.location.assign(languageUrl(root.location.href, code));
    }

    const controller = createLanguageMenuController({
      optionCodes: SUPPORTED_LOCALES,
      getSelectedCode: () => locale,
      getOpen: () => !menu.hidden,
      setOpen: (isOpen) => {
        menu.hidden = !isOpen;
        wrapper.classList.toggle('is-open', isOpen);
        stackingHost?.classList.toggle('ww-language-host-open', isOpen);
        trigger.setAttribute('aria-expanded', String(isOpen));
      },
      getFocusedIndex: () => options.indexOf(root.document.activeElement),
      focusOption: (index) => options[index]?.focus(),
      focusTrigger: () => trigger.focus(),
      onChoose: chooseLanguage,
    });

    trigger.addEventListener('click', controller.toggle);
    trigger.addEventListener('keydown', (event) => {
      if (controller.handleTriggerKey(event.key)) event.preventDefault();
    });
    menu.addEventListener('keydown', (event) => {
      if (controller.handleMenuKey(event.key)) event.preventDefault();
    });
    options.forEach((option) => {
      option.addEventListener('click', () => controller.choose(option.dataset.languageCode));
    });
    root.document.addEventListener('pointerdown', (event) => {
      if (!wrapper.contains(event.target)) controller.close();
    });
    root.document.addEventListener('focusin', (event) => {
      if (!wrapper.contains(event.target)) controller.close();
    });

    wrapper.append(trigger, menu);
    wrapper.classList.add('ww-language-inline');
    container.classList.add('ww-language-mounted');
    container.appendChild(wrapper);
    stackingHost = wrapper.closest('header');
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
      // The selected locale is already known synchronously. Mount the fixed-
      // width control before waiting for its catalog so the first painted
      // header has its final geometry during a language-change navigation.
      mountLanguageSelector();
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
    createLanguageMenuController,
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
