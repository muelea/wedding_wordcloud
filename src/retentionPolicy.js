'use strict';

// Deadlines are midnight in Germany AFTER the last complete retention year.
// January is always CET. UTC extraction of the German calendar year also
// handles documents created just before midnight on 31 December UTC.
function yearEndDeadline(value, years) {
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) throw new Error('invalid retention date');
  const year = Number(new Intl.DateTimeFormat('en', {
    timeZone: 'Europe/Berlin', year: 'numeric',
  }).format(date));
  return new Date(Date.UTC(year + years + 1, 0, 1) - 60 * 60 * 1000);
}

function emailRetentionYears(kind) {
  return ['order_confirmation', 'refund_confirmation'].includes(kind) ? 8 : 6;
}

// Keep one address record as evidence of customer, delivery and tax country.
// Phone/email, quotes, artwork and other operational copies are not evidence.
function evidenceAddresses(value) {
  const addressKeys = ['name', 'company', 'address1', 'address2', 'city',
    'zip', 'country_code', 'state_code', 'state_name'];
  const addresses = Array.isArray(value) ? value.map((entry) => entry.recipient) : [value];
  return addresses.filter((entry) => entry && typeof entry === 'object').map((entry) =>
    Object.fromEntries(addressKeys.filter((key) => entry[key] != null)
      .map((key) => [key, entry[key]])));
}

module.exports = { yearEndDeadline, emailRetentionYears, evidenceAddresses };
