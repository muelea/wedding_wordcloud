'use strict';

/**
 * Builds the lazy-loaded, localized emoji search indexes from pinned Unicode
 * CLDR annotation data:
 *
 *   node scripts/build-emoji-search-index.js \
 *     --annotations-root /path/to/cldr-annotations-full/annotations \
 *     --derived-root /path/to/cldr-annotations-derived-full/annotationsDerived \
 *     --emoji-test /path/to/emoji-test.txt \
 *     --license /path/to/cldr-json/LICENSE
 */

const fs = require('node:fs');
const path = require('node:path');
const EmojiData = require('../public/js/emoji-data');
const EmojiCatalog = require('../public/js/emoji-catalog');

const ROOT = path.join(__dirname, '..');
const CLDR_VERSION = '48.2';
const LOCALES = Object.freeze(['de', 'en', 'es', 'fr', 'it', 'tr']);
const OUTPUT_ROOT = path.join(ROOT, 'public', 'emoji-search', CLDR_VERSION);
const CATALOG_GROUPS = Object.freeze([
  ['smileys', 'Smileys & Emotion'],
  ['people', 'People & Body'],
  ['nature', 'Animals & Nature'],
  ['food', 'Food & Drink'],
  ['activities', 'Activities'],
  ['travel', 'Travel & Places'],
  ['objects', 'Objects'],
  ['symbols', 'Symbols'],
  ['flags', 'Flags'],
]);

function parseArgs(argv) {
  const result = {};
  for (let index = 0; index < argv.length; index += 2) {
    const key = argv[index];
    const value = argv[index + 1];
    if (!key?.startsWith('--') || !value) throw new Error('Expected named source paths.');
    result[key.slice(2)] = path.resolve(value);
  }
  for (const key of ['annotations-root', 'derived-root', 'emoji-test', 'license']) {
    if (!result[key]) throw new Error(`Missing --${key}.`);
  }
  return result;
}

function buildCatalog(emojiTest) {
  const bySourceGroup = new Map(CATALOG_GROUPS.map(([, sourceGroup]) => [sourceGroup, []]));
  let currentGroup = '';
  for (const line of fs.readFileSync(emojiTest, 'utf8').split(/\r?\n/)) {
    const groupMatch = line.match(/^# group: (.+)$/);
    if (groupMatch) {
      currentGroup = groupMatch[1];
      continue;
    }
    const sequenceMatch = line.match(/^([0-9A-F ]+)\s*;\s*fully-qualified\s*#/);
    if (!sequenceMatch || !bySourceGroup.has(currentGroup)) continue;
    const key = sequenceMatch[1].trim().toLowerCase().replace(/\s+/g, '_');
    if (Object.hasOwn(EmojiData.canonicalAssets, key)) bySourceGroup.get(currentGroup).push(key);
  }
  const groups = CATALOG_GROUPS.map(([key, sourceGroup]) => ({
    key,
    sourceGroup,
    entries: bySourceGroup.get(sourceGroup),
  }));
  const catalogKeys = groups.flatMap(({ entries }) => entries);
  const expectedKeys = Object.keys(EmojiData.canonicalAssets);
  if (catalogKeys.length !== expectedKeys.length
      || new Set(catalogKeys).size !== expectedKeys.length
      || expectedKeys.some((key) => !catalogKeys.includes(key))) {
    throw new Error('Unicode emoji groups do not exactly cover the canonical catalog.');
  }
  return {
    unicodeVersion: EmojiData.unicodeVersion,
    count: expectedKeys.length,
    groups,
  };
}

function readAnnotations(root, locale, topLevelKey) {
  const filename = path.join(root, locale, 'annotations.json');
  const source = JSON.parse(fs.readFileSync(filename, 'utf8'));
  const annotations = source?.[topLevelKey]?.annotations;
  if (!annotations || typeof annotations !== 'object') {
    throw new Error(`Invalid CLDR annotations: ${filename}`);
  }
  return annotations;
}

function normalizeSearchText(value) {
  return String(value || '')
    .normalize('NFKD')
    .replace(/\p{Mark}+/gu, '')
    .toLocaleLowerCase('und')
    .replace(/[œ]/g, 'oe')
    .replace(/[æ]/g, 'ae')
    .replace(/[ß]/g, 'ss')
    .replace(/[ø]/g, 'o')
    .replace(/[ł]/g, 'l')
    .replace(/[ð]/g, 'd')
    .replace(/[þ]/g, 'th')
    .replace(/[^\p{Letter}\p{Number}]+/gu, ' ')
    .trim()
    .replace(/\s+/g, ' ');
}

function uniqueSearchTerms(value) {
  return [...new Set(normalizeSearchText(value).split(' ').filter(Boolean))].join(' ');
}

function canonicalKey(value) {
  const runs = EmojiCatalog.parse(value);
  return runs.length === 1 && runs[0].type === 'emoji' ? runs[0].key : null;
}

function collectLocaleRecords(annotationsRoot, derivedRoot, locale) {
  const records = new Map();
  const sources = [
    readAnnotations(derivedRoot, locale, 'annotationsDerived'),
    readAnnotations(annotationsRoot, locale, 'annotations'),
  ];
  for (const source of sources) {
    for (const [emoji, annotation] of Object.entries(source)) {
      const key = canonicalKey(emoji);
      if (!key || !Object.hasOwn(EmojiData.canonicalAssets, key)) continue;
      if (!records.has(key)) records.set(key, { names: [], keywords: [] });
      const record = records.get(key);
      for (const name of annotation.tts || []) if (!record.names.includes(name)) record.names.push(name);
      for (const keyword of annotation.default || []) {
        if (!record.keywords.includes(keyword)) record.keywords.push(keyword);
      }
    }
  }
  return records;
}

function buildIndex({ annotationsRoot, derivedRoot, locale, englishRecords }) {
  const localized = collectLocaleRecords(annotationsRoot, derivedRoot, locale);
  const entries = [];
  for (const key of Object.keys(EmojiData.canonicalAssets)) {
    const local = localized.get(key);
    const english = englishRecords.get(key);
    if (!local || !english) throw new Error(`${locale} is missing CLDR annotations for ${key}.`);
    const name = local.names[0] || english.names[0];
    const terms = uniqueSearchTerms([
      ...local.names,
      ...local.keywords,
      ...english.names,
      ...english.keywords,
    ].join(' '));
    const aliases = [...new Set(english.names.filter((value) => value !== name))].join('|');
    entries.push([key, name, terms, aliases]);
  }
  return {
    cldrVersion: CLDR_VERSION,
    unicodeVersion: EmojiData.unicodeVersion,
    locale,
    entries,
  };
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  for (const source of [args['annotations-root'], args['derived-root'], args['emoji-test'], args.license]) {
    if (!fs.existsSync(source)) throw new Error(`Missing source: ${source}`);
  }
  fs.mkdirSync(OUTPUT_ROOT, { recursive: true });
  const englishRecords = collectLocaleRecords(args['annotations-root'], args['derived-root'], 'en');
  for (const locale of LOCALES) {
    const index = buildIndex({
      annotationsRoot: args['annotations-root'],
      derivedRoot: args['derived-root'],
      locale,
      englishRecords,
    });
    fs.writeFileSync(path.join(OUTPUT_ROOT, `${locale}.json`), `${JSON.stringify(index)}\n`);
  }
  fs.writeFileSync(
    path.join(OUTPUT_ROOT, 'catalog.json'),
    `${JSON.stringify(buildCatalog(args['emoji-test']))}\n`
  );
  fs.copyFileSync(args.license, path.join(OUTPUT_ROOT, 'LICENSE'));
  fs.writeFileSync(
    path.join(OUTPUT_ROOT, 'VERSION'),
    `Unicode CLDR ${CLDR_VERSION}\nUnicode Emoji ${EmojiData.unicodeVersion}\n`
  );
  console.log(`Generated ${LOCALES.length} CLDR emoji indexes with ${Object.keys(EmojiData.canonicalAssets).length} entries each.`);
}

main();
