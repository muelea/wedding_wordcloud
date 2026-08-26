'use strict';

const path = require('path');

const DEFAULT_LOCALE = 'de';
const SUPPORTED_LOCALES = Object.freeze(['de', 'en', 'fr', 'it', 'es', 'tr']);
const catalogs = new Map();

function normalizeLocale(value, fallback = DEFAULT_LOCALE) {
  const candidate = String(value || '').trim().toLowerCase().split(/[-_]/)[0];
  return SUPPORTED_LOCALES.includes(candidate) ? candidate : fallback;
}

function isSupportedLocale(value) {
  const candidate = String(value || '').trim().toLowerCase().split(/[-_]/)[0];
  return SUPPORTED_LOCALES.includes(candidate);
}

function getCatalog(locale) {
  const normalized = normalizeLocale(locale);
  if (normalized === DEFAULT_LOCALE) return {};
  if (!catalogs.has(normalized)) {
    const englishFile = path.join(__dirname, '..', 'public', 'locales', 'en.json');
    const localeFile = path.join(__dirname, '..', 'public', 'locales', `${normalized}.json`);
    catalogs.set(normalized, normalized === 'en'
      ? require(englishFile)
      : { ...require(englishFile), ...require(localeFile) });
  }
  return catalogs.get(normalized);
}

function translate(source, locale, params = {}) {
  const value = getCatalog(locale)[source] || source;
  return String(value).replace(/\{\{\s*([\w]+)\s*\}\}/g, (match, key) => (
    Object.hasOwn(params, key) ? String(params[key]) : match
  ));
}

module.exports = {
  DEFAULT_LOCALE,
  SUPPORTED_LOCALES,
  isSupportedLocale,
  normalizeLocale,
  translate,
};
