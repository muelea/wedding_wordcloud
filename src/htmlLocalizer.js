'use strict';

const { parse, serialize } = require('parse5');
const { getCatalog, translate } = require('./i18n');

const TRANSLATABLE_ATTRIBUTES = Object.freeze(['aria-label', 'placeholder', 'title', 'alt', 'content']);
const RAW_TEXT_ELEMENTS = new Set(['script', 'style']);
let sourceCatalog;
let messageSources = new Set();

function attribute(node, name) {
  return node.attrs?.find((candidate) => candidate.name === name);
}

function setAttribute(node, name, value) {
  const existing = attribute(node, name);
  if (existing) existing.value = value;
  else (node.attrs ||= []).push({ name, value });
}

function normalizedSource(value) {
  return String(value || '').replace(/\s+/g, ' ').trim();
}

function replaceTrimmed(value, replacement) {
  const start = String(value).match(/^\s*/)?.[0] || '';
  const end = String(value).match(/\s*$/)?.[0] || '';
  return `${start}${replacement}${end}`;
}

function localizeAttributes(node, locale) {
  for (const name of TRANSLATABLE_ATTRIBUTES) {
    const target = attribute(node, name);
    if (!target?.value) continue;
    const declaredSource = attribute(node, `data-i18n-${name}-source`)?.value;
    const source = declaredSource || normalizedSource(target.value);
    if (!source || (!declaredSource && !messageSources.has(source))) continue;
    if (!declaredSource) setAttribute(node, `data-i18n-${name}-source`, source);
    const translated = translate(source, locale);
    if (translated !== target.value) target.value = translated;
  }
}

function bindTextSource(node, parent, source) {
  if (!parent?.tagName || !Array.isArray(parent.childNodes)) return;
  if (parent.childNodes.length === 1) {
    if (!attribute(parent, 'data-i18n-source')) setAttribute(parent, 'data-i18n-source', source);
    return;
  }

  const childIndex = parent.childNodes.indexOf(node);
  if (childIndex < 0) return;
  const bindingAttribute = attribute(parent, 'data-i18n-text-sources');
  let bindings = {};
  if (bindingAttribute?.value) {
    try {
      const parsed = JSON.parse(bindingAttribute.value);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) bindings = parsed;
    } catch {}
  }
  bindings[childIndex] = source;
  setAttribute(parent, 'data-i18n-text-sources', JSON.stringify(bindings));
}

function localizeTextNode(node, parent, locale) {
  const source = normalizedSource(node.value);
  if (!source) return;
  const declaredSource = parent?.childNodes?.length === 1
    ? attribute(parent, 'data-i18n-source')?.value
    : '';
  const translationSource = declaredSource || source;
  if (!declaredSource && !messageSources.has(translationSource)) return;
  bindTextSource(node, parent, translationSource);
  const translated = translate(translationSource, locale);
  if (translated !== normalizedSource(node.value)) node.value = replaceTrimmed(node.value, translated);
}

function visit(node, parent, locale, ignored = false) {
  if (!node) return;
  if (node.nodeName === '#text') {
    if (!ignored) localizeTextNode(node, parent, locale);
    return;
  }
  if (node.nodeName === '#comment') return;

  const ignoresSubtree = ignored || Boolean(attribute(node, 'data-i18n-ignore'));
  if (!ignoresSubtree && node.tagName) localizeAttributes(node, locale);
  const ignoresText = ignoresSubtree || RAW_TEXT_ELEMENTS.has(node.tagName);
  for (const child of node.childNodes || []) visit(child, node, locale, ignoresText);
  if (node.content) visit(node.content, node, locale, ignoresText);
}

function localizeHtml(html, locale) {
  if (!html) return html;
  const english = getCatalog('en');
  if (sourceCatalog !== english) {
    sourceCatalog = english;
    messageSources = new Set(Object.keys(english));
  }
  const document = parse(html);
  visit(document, null, locale);
  return serialize(document);
}

module.exports = { TRANSLATABLE_ATTRIBUTES, localizeHtml, normalizedSource };
