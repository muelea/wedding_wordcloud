'use strict';

/**
 * Rebuilds the pinned browser/print emoji bundle from two upstream sources:
 *
 *   node scripts/build-emoji-assets.js \
 *     --noto-root /path/to/noto-emoji-2.051 \
 *     --emoji-test /path/to/emoji-test.txt
 *
 * The generated runtime contains Unicode sequence metadata only. Artwork is
 * copied locally so event pages, previews and paid print files never depend on
 * a CDN or an operating-system emoji font.
 */

const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const ARTWORK_VERSION = '2.051';
const UNICODE_VERSION = '17.0';
const OUTPUT_ROOT = path.join(ROOT, 'public', 'assets', 'noto-emoji', ARTWORK_VERSION);
const DATA_FILE = path.join(ROOT, 'public', 'js', 'emoji-data.js');

function parseArgs(argv) {
  const result = {};
  for (let index = 0; index < argv.length; index += 2) {
    const key = argv[index];
    const value = argv[index + 1];
    if (!key?.startsWith('--') || !value) throw new Error('Expected --noto-root and --emoji-test paths.');
    result[key.slice(2)] = path.resolve(value);
  }
  if (!result['noto-root'] || !result['emoji-test']) {
    throw new Error('Usage: --noto-root /path/to/noto-emoji-2.051 --emoji-test /path/to/emoji-test.txt');
  }
  return result;
}

function sequenceKey(codepoints, { stripPresentation = false } = {}) {
  return codepoints
    .map((value) => value.toLowerCase())
    .filter((value) => !stripPresentation || value !== 'fe0f')
    .join('_');
}

function regionalFlagName(codepoints) {
  if (codepoints.length !== 2) return null;
  const letters = codepoints.map((value) => Number.parseInt(value, 16) - 0x1f1e6 + 65);
  return letters.every((value) => value >= 65 && value <= 90)
    ? String.fromCharCode(...letters)
    : null;
}

function subdivisionFlagName(codepoints) {
  if (codepoints[0] !== '1f3f4' || codepoints.at(-1) !== 'e007f') return null;
  const tag = codepoints.slice(1, -1).map((value) => Number.parseInt(value, 16) - 0xe0000);
  if (!tag.length || tag.some((value) => value < 0x20 || value > 0x7e)) return null;
  const identifier = String.fromCharCode(...tag).toUpperCase();
  return ({ gbeng: 'GB-ENG', gbsct: 'GB-SCT', gbwls: 'GB-WLS' })[identifier.toLowerCase()] || null;
}

function assetForSequence(codepoints, paths) {
  const regionalName = regionalFlagName(codepoints);
  if (regionalName) {
    const source = path.join(paths.flagSource, `${regionalName}.svg`);
    return fs.existsSync(source) ? { source, reference: `flags/${regionalName}.svg` } : null;
  }
  const subdivisionName = subdivisionFlagName(codepoints);
  if (subdivisionName) {
    const source = path.join(paths.flagSource, `${subdivisionName}.svg`);
    return fs.existsSync(source) ? { source, reference: `flags/${subdivisionName}.svg` } : null;
  }
  const artworkKey = sequenceKey(codepoints, { stripPresentation: true });
  const source = path.join(paths.emojiSource, `emoji_u${artworkKey}.svg`);
  return fs.existsSync(source) ? { source, reference: `svg/emoji_u${artworkKey}.svg` } : null;
}

function ensureCleanDirectory(directory) {
  fs.rmSync(directory, { recursive: true, force: true });
  fs.mkdirSync(directory, { recursive: true });
}

function copyFile(source, destination) {
  fs.mkdirSync(path.dirname(destination), { recursive: true });
  fs.copyFileSync(source, destination);
}

function buildRuntime({ canonicalAssets, aliases }) {
  const canonical = Object.fromEntries([...canonicalAssets.entries()].sort(([left], [right]) => left.localeCompare(right)));
  const aliasObject = Object.fromEntries([...aliases.entries()]
    .filter(([input, output]) => input !== output)
    .sort(([left], [right]) => left.localeCompare(right)));
  return `(function (root, factory) {\n` +
    `  'use strict';\n` +
    `  const data = factory();\n` +
    `  if (typeof module === 'object' && module.exports) module.exports = data;\n` +
    `  if (root) root.WolkenworteEmojiData = data;\n` +
    `})(typeof window !== 'undefined' ? window : globalThis, function () {\n` +
    `  'use strict';\n` +
    `  return Object.freeze({\n` +
    `    unicodeVersion: ${JSON.stringify(UNICODE_VERSION)},\n` +
    `    artworkVersion: ${JSON.stringify(ARTWORK_VERSION)},\n` +
    `    canonicalAssets: Object.freeze(${JSON.stringify(canonical)}),\n` +
    `    aliases: Object.freeze(${JSON.stringify(aliasObject)}),\n` +
    `  });\n` +
    `});\n`;
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const notoRoot = args['noto-root'];
  const emojiTest = args['emoji-test'];
  const paths = {
    emojiSource: path.join(notoRoot, 'svg'),
    flagSource: path.join(notoRoot, 'third_party', 'region-flags', 'svg'),
  };
  for (const required of [paths.emojiSource, paths.flagSource, emojiTest]) {
    if (!fs.existsSync(required)) throw new Error(`Missing source: ${required}`);
  }

  const groups = new Map();
  for (const line of fs.readFileSync(emojiTest, 'utf8').split(/\r?\n/)) {
    const match = line.match(/^([0-9A-F ]+)\s*;\s*(fully-qualified|minimally-qualified|unqualified)\s*#/);
    if (!match) continue;
    const codepoints = match[1].trim().split(/\s+/).map((value) => value.toLowerCase());
    const artworkKey = sequenceKey(codepoints, { stripPresentation: true });
    if (!groups.has(artworkKey)) groups.set(artworkKey, { fullyQualified: null, inputs: [] });
    const group = groups.get(artworkKey);
    const key = sequenceKey(codepoints);
    group.inputs.push(key);
    if (match[2] === 'fully-qualified') group.fullyQualified = { key, codepoints };
  }

  ensureCleanDirectory(OUTPUT_ROOT);
  const canonicalAssets = new Map();
  const aliases = new Map();
  const copied = new Set();
  const missing = [];
  for (const group of groups.values()) {
    if (!group.fullyQualified) continue;
    const asset = assetForSequence(group.fullyQualified.codepoints, paths);
    if (!asset) {
      missing.push(group.fullyQualified.key);
      continue;
    }
    canonicalAssets.set(group.fullyQualified.key, asset.reference);
    aliases.set(group.fullyQualified.key, group.fullyQualified.key);
    for (const input of group.inputs) aliases.set(input, group.fullyQualified.key);
    if (!copied.has(asset.reference)) {
      copyFile(asset.source, path.join(OUTPUT_ROOT, asset.reference));
      copied.add(asset.reference);
    }
  }
  if (missing.length) throw new Error(`Noto artwork is missing ${missing.length} RGI sequences: ${missing.slice(0, 8).join(', ')}`);

  copyFile(path.join(notoRoot, 'svg', 'LICENSE'), path.join(OUTPUT_ROOT, 'LICENSE'));
  copyFile(
    path.join(notoRoot, 'third_party', 'region-flags', 'LICENSE'),
    path.join(OUTPUT_ROOT, 'FLAGS-LICENSE')
  );
  fs.writeFileSync(path.join(OUTPUT_ROOT, 'VERSION'),
    `Noto Emoji ${ARTWORK_VERSION}\nUnicode Emoji ${UNICODE_VERSION}\n`);
  fs.writeFileSync(DATA_FILE, buildRuntime({ canonicalAssets, aliases }));
  console.log(`Generated ${canonicalAssets.size} canonical emoji sequences using ${copied.size} local assets.`);
}

main();
