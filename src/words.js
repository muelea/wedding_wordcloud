'use strict';

const EmojiCatalog = require('../public/js/emoji-catalog.js');

const MAX_WORD_LENGTH = 30;

function normalizeWordInput(rawWord, locale = 'de') {
  if (typeof rawWord !== 'string') return { word: '', error: 'invalid_word' };
  let word = rawWord.normalize('NFC').trim()
    .replace(/[\x00-\x1f\x7f]/g, '')
    .replace(/ {2,}/g, ' ')
    .trim();
  if (EmojiCatalog.containsUnsupportedEmoji(word)) {
    return { word: '', error: 'unsupported_emoji' };
  }
  word = EmojiCatalog.canonicalizeText(word);
  word = EmojiCatalog.truncateGraphemes(word, MAX_WORD_LENGTH).trim();
  if (!word) return { word: '', error: 'invalid_word' };
  return { word: word.toLocaleLowerCase(locale), error: null };
}

function normalizeWord(rawWord, locale = 'de') {
  return normalizeWordInput(rawWord, locale).word;
}

module.exports = { normalizeWord, normalizeWordInput, MAX_WORD_LENGTH };
