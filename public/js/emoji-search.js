(function (root, factory) {
  'use strict';

  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.WolkenworteEmojiSearch = api;
})(typeof window !== 'undefined' ? window : globalThis, function () {
  'use strict';

  const SKIN_TONE_KEY_RE = /(?:^|_)(?:1f3fb|1f3fc|1f3fd|1f3fe|1f3ff)(?:_|$)/;

  function normalize(value) {
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

  function prepare(index) {
    if (!index || !Array.isArray(index.entries)) throw new TypeError('Invalid emoji search index.');
    return index.entries.map(([key, name, terms, aliases = '']) => Object.freeze({
      key: String(key),
      name: String(name),
      normalizedName: normalize(name),
      normalizedAliases: String(aliases)
        .split('|')
        .map(normalize)
        .filter(Boolean),
      terms: normalize(terms),
    }));
  }

  function nameRelevance(name, query, tokens) {
    if (name === query) return 0;
    if (name.startsWith(query)) return 10;
    const nameWords = name.split(' ');
    if (tokens.every((token) => nameWords.includes(token))) return 20;
    if (tokens.every((token) => nameWords.some((word) => word.startsWith(token)))) return 25;
    return Infinity;
  }

  function relevance(entry, query, tokens) {
    const namedScore = Math.min(...[entry.normalizedName, ...entry.normalizedAliases]
      .map((name) => nameRelevance(name, query, tokens)));
    if (Number.isFinite(namedScore)) return namedScore;
    const termWords = entry.terms.split(' ');
    if (tokens.every((token) => termWords.includes(token))) return 30;
    return 40 + Math.max(0, entry.terms.indexOf(query));
  }

  function search(entries, value, { limit = 320, includeSkinTones = false } = {}) {
    const query = normalize(value);
    if (!query) return [];
    const tokens = query.split(' ');
    return entries
      .filter((entry) => (includeSkinTones || !SKIN_TONE_KEY_RE.test(entry.key))
        && tokens.every((token) => entry.terms.includes(token)))
      .map((entry) => ({ entry, score: relevance(entry, query, tokens) }))
      .sort((left, right) => left.score - right.score
        || left.entry.normalizedName.length - right.entry.normalizedName.length
        || left.entry.normalizedName.localeCompare(right.entry.normalizedName))
      .slice(0, limit)
      .map(({ entry }) => entry);
  }

  return Object.freeze({ normalize, prepare, search });
});
