'use strict';

const crypto = require('node:crypto');
const { io: ioClient } = require('socket.io-client');

const baseUrl = String(process.argv[2] || process.env.PUBLIC_URL || 'https://wolkenworte.fly.dev')
  .replace(/\/$/, '');

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function fetchWithTimeout(pathname, options = {}, timeoutMs = 20_000) {
  return fetch(`${baseUrl}${pathname}`, {
    ...options,
    signal: AbortSignal.timeout(timeoutMs),
  });
}

async function waitUntilReady() {
  const deadline = Date.now() + 120_000;
  let lastStatus = 'unreachable';
  while (Date.now() < deadline) {
    try {
      const response = await fetchWithTimeout('/health/ready', {}, 10_000);
      lastStatus = String(response.status);
      if (response.status === 200) return response;
    } catch (error) {
      lastStatus = error.name;
    }
    await delay(1_500);
  }
  throw new Error(`readiness did not become healthy (last=${lastStatus})`);
}

function connectSocket(slug) {
  return new Promise((resolve, reject) => {
    const socket = ioClient(baseUrl, {
      query: { slug, guestId: crypto.randomBytes(16).toString('hex') },
      transports: ['websocket'],
      forceNew: true,
      reconnection: false,
      timeout: 20_000,
    });
    let words;
    let ownWords;
    const timer = setTimeout(() => finish(new Error('socket snapshot timed out')), 25_000);
    const finish = (error) => {
      if (error) {
        clearTimeout(timer);
        socket.close();
        reject(error);
      } else if (words !== undefined && ownWords !== undefined) {
        clearTimeout(timer);
        resolve({ socket, words, ownWords });
      }
    };
    socket.once('word-update', (value) => { words = value; finish(); });
    socket.once('own-word-update', (value) => { ownWords = value; finish(); });
    socket.once('connect_error', finish);
  });
}

function once(socket, event, timeoutMs = 20_000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${event} timed out`)), timeoutMs);
    socket.once(event, (...args) => {
      clearTimeout(timer);
      resolve(args);
    });
  });
}

async function main() {
  const parsed = new URL(baseUrl);
  if (parsed.protocol !== 'https:') throw new Error('Hosted smoke requires an HTTPS base URL.');
  const startedAt = Date.now();

  const live = await fetchWithTimeout('/health/live');
  if (live.status !== 200 || live.headers.get('cache-control') !== 'no-store') {
    throw new Error(`liveness failed (${live.status})`);
  }
  await waitUntilReady();

  const html = await fetchWithTimeout('/');
  if (html.status !== 200 || html.headers.get('cache-control') !== 'no-cache' ||
      !String(html.headers.get('content-type')).includes('text/html')) {
    throw new Error('landing-page/cache smoke failed');
  }
  const versionedAsset = await fetchWithTimeout('/js/wordcloud-core.js?v=20260819-2');
  if (versionedAsset.status !== 200 || !String(versionedAsset.headers.get('cache-control')).includes('immutable')) {
    throw new Error('versioned static-asset cache smoke failed');
  }

  const eventResponse = await fetchWithTimeout('/api/events', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      coupleName: `Hosted Smoke ${new Date().toISOString()}`,
      slug: 'hosted-smoke',
      pin: String(crypto.randomInt(1000, 10_000)),
      locale: 'de',
    }),
  });
  const event = await eventResponse.json();
  if (eventResponse.status !== 201 || typeof event.slug !== 'string') {
    throw new Error(`event creation smoke failed (${eventResponse.status})`);
  }

  const { socket } = await connectSocket(event.slug);
  try {
    const accepted = once(socket, 'word-accepted');
    const updated = once(socket, 'word-update');
    socket.emit('submit-word', 'bereit');
    const [word, receipt] = await accepted;
    const [words] = await updated;
    if (word !== 'bereit' || !/^[A-Za-z0-9_-]{24}$/.test(receipt) ||
        !Array.isArray(words) || !words.some(([value, count]) => value === 'bereit' && count === 1)) {
      throw new Error('Socket.io write/broadcast smoke failed');
    }
  } finally {
    socket.close();
  }

  console.log(`[smoke] hosted HTTP, Postgres, cache and Socket.io checks passed in ${Date.now() - startedAt}ms.`);
}

if (require.main === module) {
  main().catch((error) => {
    console.error('[smoke] hosted verification failed:', error.message);
    process.exitCode = 1;
  });
}

module.exports = { fetchWithTimeout, main, waitUntilReady };

