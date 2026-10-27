'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const os = require('node:os');
const { getBaseUrl, getCheckoutBaseUrl } = require('../src/baseUrl');

function request(origin) {
  const url = new URL(origin);
  return { protocol: url.protocol.slice(0, -1), get: name => name === 'host' ? url.host : undefined };
}

test('Checkout preserves the browser origin while public share links can use another origin', t => {
  t.mock.method(os, 'networkInterfaces', () => ({ en0: [
    { family: 'IPv4', internal: false, address: '10.0.0.163' },
  ] }));
  const previous = process.env.PUBLIC_URL;
  t.after(() => {
    if (previous === undefined) delete process.env.PUBLIC_URL;
    else process.env.PUBLIC_URL = previous;
  });
  for (const publicUrl of ['', 'https://wolkenworte.example/']) {
    process.env.PUBLIC_URL = publicUrl;
    for (const origin of [
      'http://localhost:3000', 'http://127.0.0.1:3000', 'http://[::1]:3000',
      'http://10.0.0.163:3000', 'https://wolkenworte.example', 'https://alternate.example',
    ]) {
      assert.equal(getCheckoutBaseUrl(request(origin), 3000), origin);
    }
    assert.equal(getBaseUrl(request('http://localhost:3000'), 3000),
      publicUrl ? 'https://wolkenworte.example' : 'http://10.0.0.163:3000');
  }
  assert.equal(getCheckoutBaseUrl(null, 3000), 'https://wolkenworte.example');
});
