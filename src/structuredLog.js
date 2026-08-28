'use strict';

const crypto = require('node:crypto');
const { AsyncLocalStorage } = require('node:async_hooks');

const context = new AsyncLocalStorage();
const SAFE_FIELDS = new Set([
  'requestId', 'operation', 'outcome', 'errorCode', 'durationMs', 'statusCode',
  'eventId', 'orderId', 'jobId', 'shipmentId', 'maintenanceRunId',
  'operatorActionId', 'count', 'attempt', 'mode', 'provider', 'signal',
  'activeSockets', 'activeRooms', 'queueDepth', 'oldestAgeSeconds',
]);
let testSink = null;

function safeToken(value, fallback = null, maxLength = 120) {
  const token = String(value == null ? '' : value)
    .trim().toLowerCase().replace(/[^a-z0-9_.:-]/g, '_').slice(0, maxLength);
  return token || fallback;
}

function safeId(value) {
  const id = String(value == null ? '' : value).trim();
  return /^[A-Za-z0-9_-]{1,80}$/.test(id) ? id : null;
}

function errorCode(error, fallback = 'operation_failed') {
  const value = String(error?.code == null ? '' : error.code).trim();
  if (/^[A-Za-z][A-Za-z0-9_:-]{0,119}$/.test(value)) return value.toLowerCase();
  return safeToken(fallback, 'operation_failed');
}

function safeValue(key, value) {
  if (value == null) return null;
  if (['durationMs', 'statusCode', 'count', 'attempt', 'activeSockets',
    'activeRooms', 'queueDepth', 'oldestAgeSeconds'].includes(key)) {
    const number = Number(value);
    return Number.isFinite(number) ? Math.max(0, number) : null;
  }
  if (['requestId', 'eventId', 'orderId', 'jobId', 'shipmentId',
    'maintenanceRunId', 'operatorActionId'].includes(key)) return safeId(value);
  if (key === 'errorCode') return errorCode({ code: value });
  return safeToken(value);
}

function sanitizeFields(fields = {}) {
  const sanitized = {};
  for (const [key, value] of Object.entries(fields)) {
    if (!SAFE_FIELDS.has(key)) continue;
    const safe = safeValue(key, value);
    if (safe !== null) sanitized[key] = safe;
  }
  const requestId = context.getStore()?.requestId;
  if (requestId && !sanitized.requestId) sanitized.requestId = requestId;
  return sanitized;
}

function write(level, event, fields = {}) {
  const record = {
    timestamp: new Date().toISOString(),
    level,
    event: safeToken(event, 'application_event'),
    ...sanitizeFields(fields),
  };
  const line = JSON.stringify(record);
  if (testSink) testSink(record, line);
  else if (level === 'error') console.error(line);
  else if (level === 'warn') console.warn(line);
  else console.log(line);
  return record;
}

function requestContext(req, res, next) {
  const requestId = crypto.randomUUID();
  req.requestId = requestId;
  res.set('X-Request-ID', requestId);
  context.run({ requestId }, next);
}

function setSinkForTests(sink) {
  if (process.env.NODE_ENV !== 'test') throw new Error('Structured-log test sinks are test-only.');
  testSink = sink;
}

function resetForTests() {
  testSink = null;
}

module.exports = {
  error: (event, fields) => write('error', event, fields),
  errorCode,
  info: (event, fields) => write('info', event, fields),
  requestContext,
  resetForTests,
  sanitizeFields,
  setSinkForTests,
  warn: (event, fields) => write('warn', event, fields),
};
