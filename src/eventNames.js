'use strict';

const MAX_EVENT_NAME_LENGTH = 80;

function normalizeEventName(value) {
  if (typeof value !== 'string') return '';
  return value.normalize('NFC').trim().replace(/\s+/g, ' ');
}

function isValidEventName(value) {
  const normalized = normalizeEventName(value);
  return Boolean(normalized) && normalized.length <= MAX_EVENT_NAME_LENGTH;
}

module.exports = {
  MAX_EVENT_NAME_LENGTH,
  isValidEventName,
  normalizeEventName,
};
