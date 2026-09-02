(function (root, factory) {
  'use strict';
  const data = typeof module === 'object' && module.exports
    ? require('./emoji-data.js')
    : root.WolkenworteEmojiData;
  const api = factory(root, data);
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.WolkenworteEmoji = api;
})(typeof window !== 'undefined' ? window : globalThis, function (root, data) {
  'use strict';

  if (!data?.canonicalAssets || !data?.aliases) throw new Error('Emoji data is required');

  const ASSET_BASE = `/assets/noto-emoji/${data.artworkVersion}/`;
  const UNSUPPORTED_EMOJI_RE = /[\p{Extended_Pictographic}\p{Regional_Indicator}\p{Emoji_Modifier}\u200D\uFE0F\u20E3\u{E0020}-\u{E007F}]/u;
  const canonicalKeys = new Set(Object.keys(data.canonicalAssets));
  const imageElements = new Map();
  const imagePromises = new Map();
  let trie = null;

  function keyToCodepoints(key) {
    return String(key || '').split('_').filter(Boolean).map((value) => Number.parseInt(value, 16));
  }

  function keyToString(key) {
    return String.fromCodePoint(...keyToCodepoints(key));
  }

  function stringToKey(value) {
    return Array.from(String(value || ''), (character) => character.codePointAt(0).toString(16)).join('_');
  }

  function buildTrie() {
    if (trie) return trie;
    trie = new Map();
    const entries = [
      ...Object.keys(data.canonicalAssets).map((key) => [key, key]),
      ...Object.entries(data.aliases),
    ];
    for (const [inputKey, canonicalKey] of entries) {
      if (!canonicalKeys.has(canonicalKey)) continue;
      let node = trie;
      for (const codepoint of keyToCodepoints(inputKey)) {
        if (!node.has(codepoint)) node.set(codepoint, new Map());
        node = node.get(codepoint);
      }
      node.canonicalKey = canonicalKey;
    }
    return trie;
  }

  function parse(value) {
    const text = String(value || '');
    if (!text) return [];
    const characters = Array.from(text);
    const codepoints = characters.map((character) => character.codePointAt(0));
    const result = [];
    const rootNode = buildTrie();
    let textBuffer = '';

    function flushText() {
      if (!textBuffer) return;
      result.push({ type: 'text', text: textBuffer });
      textBuffer = '';
    }

    for (let index = 0; index < codepoints.length;) {
      let node = rootNode;
      let cursor = index;
      let match = null;
      while (cursor < codepoints.length && node.has(codepoints[cursor])) {
        node = node.get(codepoints[cursor]);
        cursor += 1;
        if (node.canonicalKey) match = { end: cursor, canonicalKey: node.canonicalKey };
      }
      if (!match) {
        textBuffer += characters[index];
        index += 1;
        continue;
      }
      flushText();
      const sourceText = characters.slice(index, match.end).join('');
      const canonicalText = keyToString(match.canonicalKey);
      result.push({
        type: 'emoji',
        text: canonicalText,
        sourceText,
        key: match.canonicalKey,
        asset: data.canonicalAssets[match.canonicalKey],
      });
      index = match.end;
    }
    flushText();
    return result;
  }

  function canonicalizeText(value) {
    return parse(value).map((run) => run.text).join('');
  }

  function hasEmoji(value) {
    return parse(value).some((run) => run.type === 'emoji');
  }

  function containsUnsupportedEmoji(value) {
    return parse(value).some((run) => run.type === 'text' && UNSUPPORTED_EMOJI_RE.test(run.text));
  }

  function graphemes(value) {
    const text = String(value || '');
    if (!text) return [];
    if (typeof Intl?.Segmenter === 'function') {
      const segmenter = new Intl.Segmenter('und', { granularity: 'grapheme' });
      return Array.from(segmenter.segment(text), (entry) => entry.segment);
    }
    return parse(text).flatMap((run) => run.type === 'emoji' ? [run.text] : Array.from(run.text));
  }

  function graphemeLength(value) {
    return graphemes(value).length;
  }

  function truncateGraphemes(value, maximum) {
    const limit = Math.max(0, Number(maximum) || 0);
    return graphemes(value).slice(0, limit).join('');
  }

  function assetUrl(assetOrRun) {
    const asset = typeof assetOrRun === 'string' && assetOrRun.includes('/')
      ? assetOrRun
      : typeof assetOrRun === 'string'
        ? data.canonicalAssets[assetOrRun]
        : assetOrRun?.asset;
    return asset ? `${ASSET_BASE}${asset}` : '';
  }

  function loadAsset(asset) {
    const source = assetUrl(asset);
    if (!source) return Promise.reject(new Error('Unknown emoji asset'));
    if (imageElements.has(source)) return Promise.resolve(imageElements.get(source));
    if (imagePromises.has(source)) return imagePromises.get(source);
    if (typeof root.Image !== 'function') return Promise.reject(new Error('Emoji images require a browser'));
    const promise = new Promise((resolve, reject) => {
      const image = new root.Image();
      image.decoding = 'async';
      image.onload = () => {
        imageElements.set(source, image);
        imagePromises.delete(source);
        resolve(image);
      };
      image.onerror = () => {
        imagePromises.delete(source);
        reject(new Error(`Could not load emoji asset: ${source}`));
      };
      image.src = source;
    });
    imagePromises.set(source, promise);
    return promise;
  }

  function preloadTexts(values) {
    const assets = new Set();
    for (const value of Array.isArray(values) ? values : [values]) {
      for (const run of parse(value)) if (run.type === 'emoji') assets.add(run.asset);
    }
    return Promise.all([...assets].map(loadAsset));
  }

  function getLoadedImage(assetOrRun) {
    return imageElements.get(assetUrl(assetOrRun)) || null;
  }

  function renderInline(element, value, { className = 'ww-emoji' } = {}) {
    if (!element) return;
    const text = String(value || '');
    const nodes = [];
    for (const run of parse(text)) {
      if (run.type === 'text') {
        nodes.push((element.ownerDocument || document).createTextNode(run.text));
        continue;
      }
      const image = (element.ownerDocument || document).createElement('img');
      image.className = className;
      image.src = assetUrl(run);
      image.alt = '';
      image.draggable = false;
      image.setAttribute('aria-hidden', 'true');
      image.dataset.emoji = run.key;
      nodes.push(image);
    }
    element.replaceChildren(...nodes);
    element.setAttribute('aria-label', text);
  }

  return Object.freeze({
    unicodeVersion: data.unicodeVersion,
    artworkVersion: data.artworkVersion,
    ASSET_BASE,
    parse,
    canonicalizeText,
    containsUnsupportedEmoji,
    hasEmoji,
    graphemeLength,
    truncateGraphemes,
    stringToKey,
    keyToString,
    assetUrl,
    preloadTexts,
    getLoadedImage,
    renderInline,
  });
});
