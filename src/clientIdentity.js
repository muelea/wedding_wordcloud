'use strict';

const crypto = require('node:crypto');
const net = require('node:net');
const ipaddr = require('ipaddr.js');

function addressWithoutTransport(value) {
  let raw = String(value || '').trim();
  if (!raw) return '';
  const bracketed = /^\[([^\]]+)\](?::\d+)?$/.exec(raw);
  if (bracketed) raw = bracketed[1];
  if (!net.isIP(raw)) {
    const ipv4WithPort = /^(\d{1,3}(?:\.\d{1,3}){3}):\d+$/.exec(raw);
    if (ipv4WithPort) raw = ipv4WithPort[1];
  }
  const zoneIndex = raw.indexOf('%');
  if (zoneIndex !== -1) raw = raw.slice(0, zoneIndex);
  return raw;
}

function normalizeSourceAddress(value) {
  const raw = addressWithoutTransport(value);
  if (!raw) return null;
  try {
    const parsed = ipaddr.process(raw);
    if (parsed.kind() === 'ipv4') return `ipv4:${parsed.toString()}`;
    const bytes = parsed.toByteArray();
    bytes.fill(0, 8);
    return `ipv6:${Buffer.from(bytes).toString('hex').slice(0, 16)}/64`;
  } catch {
    return null;
  }
}

function productionFlyAddress(headers) {
  if (process.env.NODE_ENV !== 'production') return null;
  const value = headers?.['fly-client-ip'];
  if (Array.isArray(value)) return value[0];
  return value;
}

function sourceAddressForRequest(req) {
  return normalizeSourceAddress(
    productionFlyAddress(req.headers) ||
    (process.env.NODE_ENV === 'test' ? req.headers?.['x-wolkenworte-test-client-ip'] : null) ||
    req.socket?.remoteAddress
  ) || 'unknown';
}

function sourceAddressForSocket(socket) {
  return normalizeSourceAddress(
    productionFlyAddress(socket.request?.headers) ||
    socket.conn?.remoteAddress ||
    socket.request?.socket?.remoteAddress
  ) || 'unknown';
}

function hashSourceIdentity(normalizedAddress) {
  const secret = String(process.env.RATE_LIMIT_HMAC_SECRET || 'wolkenworte-local-rate-limit-only');
  return crypto.createHmac('sha256', secret)
    .update(String(normalizedAddress || 'unknown'))
    .digest('hex');
}

function sourceHashForRequest(req) {
  return hashSourceIdentity(sourceAddressForRequest(req));
}

function sourceHashForSocket(socket) {
  return hashSourceIdentity(sourceAddressForSocket(socket));
}

module.exports = {
  normalizeSourceAddress,
  sourceAddressForRequest,
  sourceAddressForSocket,
  hashSourceIdentity,
  sourceHashForRequest,
  sourceHashForSocket,
};
