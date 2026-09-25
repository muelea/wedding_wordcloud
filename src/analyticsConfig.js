'use strict';

const MEASUREMENT_ID_PATTERN = /^G-[A-Z0-9]+$/;

function measurementId() {
  const value = String(process.env.GA4_MEASUREMENT_ID || '').trim();
  return MEASUREMENT_ID_PATTERN.test(value) ? value : '';
}

function validationError() {
  const value = String(process.env.GA4_MEASUREMENT_ID || '').trim();
  return value && !MEASUREMENT_ID_PATTERN.test(value)
    ? 'GA4_MEASUREMENT_ID muss eine Web-Mess-ID im Format G-... sein.'
    : '';
}

module.exports = { measurementId, validationError };
