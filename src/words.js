'use strict';

const EmojiCatalog = require('../public/js/emoji-catalog.js');

const { MAX_WORD_LENGTH } = require('../public/js/cloud-limits');

// Shared character safety; design text deliberately has no contribution limit.
function normalizeTextInput(rawWord) {
  if (typeof rawWord !== 'string') return { word: '', error: 'invalid_word' };
  let word = rawWord.normalize('NFC').trim()
    .replace(/[\x00-\x1f\x7f]/g, '')
    .replace(/ {2,}/g, ' ')
    .trim();
  if (EmojiCatalog.containsUnsupportedEmoji(word)) {
    return { word: '', error: 'unsupported_emoji' };
  }
  word = EmojiCatalog.canonicalizeText(word);
  if (!word) return { word: '', error: 'invalid_word' };
  return { word, error: null };
}

function normalizeWordInput(rawWord, locale = 'de') {
  const result = normalizeTextInput(rawWord);
  if (result.word && EmojiCatalog.graphemeLength(result.word) > MAX_WORD_LENGTH) {
    return { word: '', error: 'word_too_long' };
  }
  return result;
}

function normalizeWord(rawWord, locale = 'de') {
  return normalizeWordInput(rawWord, locale).word;
}

module.exports = { normalizeWord, normalizeWordInput, normalizeTextInput, MAX_WORD_LENGTH };
