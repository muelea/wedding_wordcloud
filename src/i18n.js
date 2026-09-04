'use strict';

const path = require('path');
const fs = require('node:fs');
const { fingerprintPublicAsset } = require('./publicAssets');

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
  const englishVersion = fingerprintPublicAsset('/locales/en.json');
  const version = normalized === 'en'
    ? englishVersion
    : `${englishVersion}:${fingerprintPublicAsset(`/locales/${normalized}.json`)}`;
  if (catalogs.get(normalized)?.version !== version) {
    const englishFile = path.join(__dirname, '..', 'public', 'locales', 'en.json');
    const localeFile = path.join(__dirname, '..', 'public', 'locales', `${normalized}.json`);
    // JSON require() would retain old translations after a development edit.
    const english = JSON.parse(fs.readFileSync(englishFile, 'utf8'));
    const messages = normalized === 'en'
      ? english
      : { ...english, ...JSON.parse(fs.readFileSync(localeFile, 'utf8')) };
    catalogs.set(normalized, { version, messages });
  }
  return catalogs.get(normalized).messages;
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
  getCatalog,
  isSupportedLocale,
  normalizeLocale,
  translate,
};
