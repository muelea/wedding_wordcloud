'use strict';

const os = require('os');

function getLocalIP() {
  const interfaces = os.networkInterfaces();
  for (const name of Object.keys(interfaces)) {
    for (const iface of interfaces[name]) {
      if (iface.family === 'IPv4' && !iface.internal) {
        return iface.address;
      }
    }
  }
  return 'localhost';
}

// Works locally (LAN IP + QR), and with a custom domain (PUBLIC_URL
// override, or auto-detected from the request's Host header once DNS
// points at it) — ported from the prototype, generalized (dropped the
// Render-specific env var since hosting choice is a later-phase decision).
function getBaseUrl(req, port) {
  if (process.env.PUBLIC_URL) return process.env.PUBLIC_URL.replace(/\/$/, '');
  const host = req && req.get && req.get('host');
  if (host && !/^(localhost|127\.0\.0\.1)(:|$)/.test(host)) {
    return `${req.protocol}://${host}`;
  }
  return `http://${getLocalIP()}:${port}`;
}

module.exports = { getBaseUrl, getLocalIP };
