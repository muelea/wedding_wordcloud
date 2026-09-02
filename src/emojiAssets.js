'use strict';

const fs = require('node:fs');
const path = require('node:path');
const EmojiCatalog = require('../public/js/emoji-catalog.js');

const ASSET_ROOT = path.join(
  __dirname,
  '..',
  'public',
  'assets',
  'noto-emoji',
  EmojiCatalog.artworkVersion
);
const ASSET_RE = /^(?:svg\/emoji_u[0-9a-f_]+|flags\/[A-Z]{2}(?:-[A-Z]{3})?)\.svg$/;
const parsedAssets = new Map();

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function parseAsset(reference) {
  if (!ASSET_RE.test(String(reference || ''))) throw new Error('Unknown emoji artwork');
  if (parsedAssets.has(reference)) return parsedAssets.get(reference);
  const filename = path.join(ASSET_ROOT, reference);
  const source = fs.readFileSync(filename, 'utf8')
    .replace(/^\uFEFF/, '')
    .replace(/<\?xml[\s\S]*?\?>/gi, '')
    .replace(/<!DOCTYPE[\s\S]*?\]>/gi, '')
    .replace(/<!DOCTYPE[^>]*>/gi, '')
    .replace(/<!--([\s\S]*?)-->/g, '')
    .trim();
  const match = source.match(/^<svg\b([^>]*)>([\s\S]*)<\/svg>$/i);
  if (!match) throw new Error(`Invalid bundled emoji SVG: ${reference}`);
  const width = match[1].match(/\bwidth=(['"])(-?\d+(?:\.\d+)?)(?:px)?\1/i)?.[2];
  const height = match[1].match(/\bheight=(['"])(-?\d+(?:\.\d+)?)(?:px)?\1/i)?.[2];
  const viewBox = match[1].match(/\bviewBox=(['"])([^'"]+)\1/i)?.[2] ||
    (width && height ? `0 0 ${width} ${height}` : '');
  if (!viewBox || !/^-?\d+(?:\.\d+)?(?:[\s,]+-?\d+(?:\.\d+)?){3}$/.test(viewBox.trim())) {
    throw new Error(`Bundled emoji SVG has no valid viewBox: ${reference}`);
  }
  const body = match[2]
    .replace(/<metadata\b[\s\S]*?<\/metadata>/gi, '')
    .replace(/<foreignObject\b[\s\S]*?<\/foreignObject>/gi, '')
    .replace(/<(?:sodipodi:namedview|inkscape:perspective|i:pgf)\b[\s\S]*?<\/(?:sodipodi:namedview|inkscape:perspective|i:pgf)>/gi, '')
    .replace(/<(?:sodipodi:namedview|inkscape:perspective|i:pgfRef)\b[^>]*\/?\s*>/gi, '')
    .replace(/\bxlink:href=/gi, 'href=')
    .replace(/\s+[A-Za-z_][\w.-]*:[\w.-]+=(['"])[\s\S]*?\1/g, '')
    .replace(/&(?!amp;|lt;|gt;|quot;|apos;)[A-Za-z_][\w.-]*;/g, '')
    .trim();
  const parsed = { viewBox: viewBox.trim().replace(/,/g, ' '), body };
  parsedAssets.set(reference, parsed);
  return parsed;
}

function prefixIds(body, prefix) {
  const ids = [...body.matchAll(/\bid=(['"])([^'"\s>]+)\1/g)].map((match) => match[2]);
  let result = body;
  for (const id of new Set(ids)) {
    const safeId = escapeRegExp(id);
    const nextId = `${prefix}-${id}`;
    result = result
      .replace(new RegExp(`\\bid=(['"])${safeId}\\1`, 'g'), `id="${nextId}"`)
      .replace(new RegExp(`url\\(#${safeId}\\)`, 'g'), `url(#${nextId})`)
      .replace(new RegExp(`(href)=(['"])#${safeId}\\2`, 'g'), `$1="#${nextId}"`);
  }
  return result;
}

function inlineSvg(run, geometry) {
  const parsed = parseAsset(run.asset);
  const prefix = String(geometry.id || `emoji-${run.key}`).replace(/[^A-Za-z0-9_.-]/g, '-');
  const body = prefixIds(parsed.body, prefix);
  return `<svg data-emoji="${run.key}" x="${geometry.x.toFixed(1)}" y="${geometry.y.toFixed(1)}" ` +
    `width="${geometry.width.toFixed(1)}" height="${geometry.height.toFixed(1)}" ` +
    `viewBox="${parsed.viewBox}" preserveAspectRatio="xMidYMid meet">${body}</svg>`;
}

module.exports = {
  ASSET_ROOT,
  inlineSvg,
  parseAsset,
};
