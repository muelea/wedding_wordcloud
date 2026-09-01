(function (root, factory) {
  'use strict';

  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.WolkenworteOwnWords = api;
})(typeof window !== 'undefined' ? window : globalThis, function () {
  'use strict';

  function groupContributions(entries, locale = 'de') {
    const groups = new Map();
    for (const entry of Array.isArray(entries) ? entries : []) {
      const receipt = Array.isArray(entry) ? entry[0] : entry?.receipt;
      const word = Array.isArray(entry) ? entry[1] : entry?.word;
      if (!receipt || !word) continue;
      if (!groups.has(word)) groups.set(word, []);
      groups.get(word).push(receipt);
    }
    return [...groups.entries()].sort(([left], [right]) => left.localeCompare(right, locale));
  }

  return Object.freeze({ groupContributions });
});
