'use strict';

const MAX_WORD_LENGTH = 30;

// Matches emoji, flag sequences, and their joiner/modifier characters —
// guests submit text only, no emoji. Ported from the prototype's server.js.
const EMOJI_REGEX = /[\p{Extended_Pictographic}\p{Regional_Indicator}\p{Emoji_Modifier}\u200D\uFE0F]/gu;

function normalizeWord(rawWord) {
  if (typeof rawWord !== 'string') return '';
  // NFC normalization fixes NFD-encoded umlauts (e.g. macOS option-key input)
  return rawWord.normalize('NFC').trim()
    .replace(/[\x00-\x1f\x7f]/g, '')   // strip control chars only
    .replace(EMOJI_REGEX, '')          // text only, no emoji
    .replace(/ {2,}/g, ' ')            // collapse gaps left behind by stripped emoji
    .trim()
    .slice(0, MAX_WORD_LENGTH)
    .trim()
    .toLowerCase();
}

module.exports = { normalizeWord, MAX_WORD_LENGTH };
