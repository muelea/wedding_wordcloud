'use strict';

const path = require('path');
const ejs = require('ejs');
const {
  DEFAULT_LOCALE,
  SUPPORTED_LOCALES,
  isSupportedLocale,
  normalizeLocale,
  translate,
} = require('./i18n');
const { publicAssetUrl } = require('./publicAssets');

const LANGUAGE_COOKIE = 'wolkenworte-language';
const LANGUAGE_COOKIE_MAX_AGE_MS = 365 * 24 * 60 * 60 * 1000;
const VIEW_ROOT = path.join(__dirname, '..', 'views');
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

function parseCookies(header) {
  const cookies = {};
  for (const pair of String(header || '').split(';')) {
    const separator = pair.indexOf('=');
    if (separator < 1) continue;
    const name = pair.slice(0, separator).trim();
    try {
      cookies[name] = decodeURIComponent(pair.slice(separator + 1).trim());
    } catch {
      cookies[name] = '';
    }
  }
  return cookies;
}

function preferredRequestLocale(header) {
  const preferences = String(header || '')
    .split(',')
    .map((entry, index) => {
      const [language, ...parameters] = entry.trim().split(';');
      const qualityParameter = parameters.find((parameter) => parameter.trim().startsWith('q='));
      const quality = qualityParameter ? Number(qualityParameter.trim().slice(2)) : 1;
      return { language, quality: Number.isFinite(quality) ? quality : 0, index };
    })
    .sort((a, b) => b.quality - a.quality || a.index - b.index);
  for (const preference of preferences) {
    if (preference.quality <= 0) continue;
    if (isSupportedLocale(preference.language)) return normalizeLocale(preference.language);
  }
  return '';
}

function resolvePageLocale(req, eventLocale) {
  if (isSupportedLocale(req.query?.lang)) {
    return { locale: normalizeLocale(req.query.lang), source: 'query' };
  }
  const cookieLocale = parseCookies(req.headers.cookie)[LANGUAGE_COOKIE];
  if (isSupportedLocale(cookieLocale)) {
    return { locale: normalizeLocale(cookieLocale), source: 'cookie' };
  }
  if (isSupportedLocale(eventLocale)) {
    return { locale: normalizeLocale(eventLocale), source: 'event' };
  }
  const browserLocale = preferredRequestLocale(req.headers['accept-language']);
  if (browserLocale) return { locale: browserLocale, source: 'browser' };
  return { locale: DEFAULT_LOCALE, source: 'default' };
}

function relativeLanguageUrl(originalUrl, locale) {
  const url = new URL(originalUrl || '/', 'https://wolkenworte.invalid');
  url.searchParams.set('lang', normalizeLocale(locale));
  return `${url.pathname}${url.search}${url.hash}`;
}

function rememberExplicitLocale(req, res, locale) {
  res.cookie(LANGUAGE_COOKIE, locale, {
    maxAge: LANGUAGE_COOKIE_MAX_AGE_MS,
    path: '/',
    sameSite: 'lax',
    secure: req.secure || process.env.APP_ENVIRONMENT === 'production',
  });
}

async function renderPage(req, res, view, options = {}) {
  const resolved = resolvePageLocale(req, options.eventLocale);
  if (resolved.source === 'query') rememberExplicitLocale(req, res, resolved.locale);
  const locals = {
    locale: resolved.locale,
    localeSource: resolved.source,
    header: options.header || {},
    pageData: options.pageData || {},
    languages: SUPPORTED_LOCALES.map((code) => ({
      code,
      name: LANGUAGE_NAMES[code],
      flag: LANGUAGE_FLAGS[code],
      href: relativeLanguageUrl(req.originalUrl, code),
    })),
    asset: publicAssetUrl,
    t: (source, params) => translate(source, resolved.locale, params),
  };
  const html = await ejs.renderFile(path.join(VIEW_ROOT, `${view}.ejs`), locals);
  res.status(options.status || 200);
  res.set('Cache-Control', options.cacheControl || 'no-cache');
  res.vary('Accept-Language');
  res.vary('Cookie');
  return res.send(html);
}

module.exports = {
  LANGUAGE_COOKIE,
  LANGUAGE_FLAGS,
  LANGUAGE_NAMES,
  parseCookies,
  preferredRequestLocale,
  relativeLanguageUrl,
  renderPage,
  resolvePageLocale,
};
