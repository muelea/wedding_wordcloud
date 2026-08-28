'use strict';

const crypto = require('node:crypto');
const path = require('node:path');
const { io: ioClient } = require('socket.io-client');
const sharp = require('sharp');

require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

const requestedBaseUrl = process.argv.slice(2).find((argument) => !argument.startsWith('--'));
const baseUrl = String(requestedBaseUrl || process.env.PUBLIC_URL || 'https://wolkenworte.fly.dev')
  .replace(/\/$/, '');
const skipMaintenance = process.argv.includes('--skip-maintenance');

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

  const adminPin = String(crypto.randomInt(1000, 10_000));
  const eventResponse = await fetchWithTimeout('/api/events', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      coupleName: `Hosted Smoke ${new Date().toISOString()}`,
      slug: 'hosted-smoke',
      pin: adminPin,
      locale: 'de',
    }),
  });
  const event = await eventResponse.json();
  if (eventResponse.status !== 201 || typeof event.slug !== 'string' || 'adminToken' in event) {
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

  const resetResponse = await fetchWithTimeout(`/api/events/${encodeURIComponent(event.slug)}/reset`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ pin: adminPin }),
  });
  if (resetResponse.status !== 200 || !(await resetResponse.json()).ok) {
    throw new Error(`one-use PIN reset smoke failed (${resetResponse.status})`);
  }
  const retiredAdminResponse = await fetchWithTimeout(
    `/api/events/${encodeURIComponent(event.slug)}/admin/verify`,
    { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ pin: adminPin }) }
  );
  if (retiredAdminResponse.status !== 404) {
    throw new Error(`retired admin-token endpoint is still reachable (${retiredAdminResponse.status})`);
  }

  const ownerId = crypto.randomBytes(16).toString('hex');
  const photoBytes = await sharp({
    create: { width: 96, height: 72, channels: 4, background: '#b83f6d' },
  }).jpeg({ quality: 90 }).toBuffer();
  const assetResponse = await fetchWithTimeout(`/api/events/${encodeURIComponent(event.slug)}/assets`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Wolkenworte-Guest-Id': ownerId,
    },
    body: JSON.stringify({ dataUrl: `data:image/jpeg;base64,${photoBytes.toString('base64')}` }),
  });
  const asset = await assetResponse.json();
  if (assetResponse.status !== 201 || !/^[A-Za-z0-9_-]{24}$/.test(asset.assetId || '') ||
      !String(asset.previewUrl || '').startsWith('https://') || asset.expiresInSeconds !== 900) {
    throw new Error(`private photo upload smoke failed (${assetResponse.status})`);
  }

  const configurationResponse = await fetchWithTimeout(
    `/api/events/${encodeURIComponent(event.slug)}/configurations`,
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Wolkenworte-Guest-Id': ownerId,
      },
      body: JSON.stringify({
        configurationType: 'personal_memory',
        productKey: 'white-glossy-mug-duo-11oz',
        quantity: 1,
        theme: 'pastel',
        designs: {
          default: [{
            id: 'hosted-private-photo',
            type: 'image',
            assetId: asset.assetId,
            src: asset.previewUrl,
            x: 1350,
            y: 525,
            width: 640,
            height: 480,
            angle: 0,
          }],
        },
      }),
    }
  );
  const configuration = await configurationResponse.json();
  if (configurationResponse.status !== 201 || !configuration.id || !configuration.printFileUrl) {
    throw new Error(`private configuration smoke failed (${configurationResponse.status})`);
  }

  const editableResponse = await fetchWithTimeout(
    `/api/events/${encodeURIComponent(event.slug)}/configurations/${encodeURIComponent(configuration.id)}/edit`
  );
  const editable = await editableResponse.json();
  const editablePhoto = editable?.designs?.default?.[0];
  if (editableResponse.status !== 200 || editablePhoto?.assetId !== asset.assetId ||
      !String(editablePhoto?.src || '').startsWith('https://') ||
      String(editablePhoto?.src || '').startsWith('data:image/')) {
    throw new Error(`signed private preview smoke failed (${editableResponse.status})`);
  }

  const printResponse = await fetchWithTimeout(configuration.printFileUrl);
  const printSvg = await printResponse.text();
  if (printResponse.status !== 200 || printResponse.headers.get('cache-control') !== 'private, no-store' ||
      !printSvg.includes('data-photo="true"') || !printSvg.includes('href="data:image/jpeg;base64,') ||
      printSvg.includes('.supabase.co/storage/')) {
    throw new Error(`private print materialization smoke failed (${printResponse.status})`);
  }

  const hiddenMaintenance = await fetchWithTimeout('/internal/maintenance/run', { method: 'POST' });
  if (hiddenMaintenance.status !== 404) {
    throw new Error(`unauthenticated maintenance is visible (${hiddenMaintenance.status})`);
  }
  if (!skipMaintenance) {
    const maintenanceSecret = String(process.env.MAINTENANCE_SECRET || '');
    if (maintenanceSecret.length < 32) throw new Error('MAINTENANCE_SECRET fehlt für den Hosted-Smoke.');
    const maintenanceResponse = await fetchWithTimeout('/internal/maintenance/run', {
      method: 'POST',
      headers: { Authorization: `Bearer ${maintenanceSecret}`, 'Content-Type': 'application/json' },
      body: '{}',
    }, 30_000);
    const maintenanceResult = await maintenanceResponse.json();
    if (maintenanceResponse.status !== 200 ||
        !['ok', 'already_running'].includes(maintenanceResult.status)) {
      throw new Error(`authenticated maintenance smoke failed (${maintenanceResponse.status})`);
    }
  }
  const missingArtifact = await fetchWithTimeout(
    `/api/print-files/${'x'.repeat(24)}/${'y'.repeat(32)}`
  );
  if (missingArtifact.status !== 404) {
    throw new Error(`opaque print-artifact boundary failed (${missingArtifact.status})`);
  }

  console.log(
    `[smoke] hosted HTTP, Postgres, one-use PIN reset, private Storage, ` +
    `${skipMaintenance ? 'maintenance auth boundary' : 'maintenance'}, artifact capability, ` +
    `immutable photo print, cache and Socket.io checks passed ` +
    `in ${Date.now() - startedAt}ms.`
  );
}

if (require.main === module) {
  main().catch((error) => {
    console.error('[smoke] hosted verification failed:', error.message);
    process.exitCode = 1;
  });
}

module.exports = { fetchWithTimeout, main, waitUntilReady };
