'use strict';

const { generateEventSlug } = require('../src/slug');
const crypto = require('node:crypto');

const PUBLIC_URL = 'https://wolkenworte.io';
const WWW_URL = 'https://www.wolkenworte.io';

function parseExpected(argv = process.argv) {
  const maintenance = argv.includes('--expect-maintenance');
  const active = argv.includes('--expect-active');
  if (maintenance === active) {
    throw new Error('Exactly one of --expect-maintenance or --expect-active is required.');
  }
  return maintenance ? 'maintenance' : 'active';
}

async function request(fetchImpl, url, options = {}) {
  return fetchImpl(url, { ...options, signal: AbortSignal.timeout(15_000) });
}

const sleep = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));

async function waitForHealth(fetchImpl, sleepImpl = sleep) {
  let consecutive = 0;
  let statuses = { live: 'unreachable', ready: 'unreachable' };
  for (let attempt = 0; attempt < 6; attempt += 1) {
    try {
      const [live, ready] = await Promise.all([
        request(fetchImpl, `${PUBLIC_URL}/health/live`),
        request(fetchImpl, `${PUBLIC_URL}/health/ready`),
      ]);
      statuses = { live: live.status, ready: ready.status };
      consecutive = live.status === 200 && ready.status === 200 ? consecutive + 1 : 0;
      if (consecutive === 2) return;
    } catch {
      consecutive = 0;
      statuses = { live: 'unreachable', ready: 'unreachable' };
    }
    if (attempt < 5) await sleepImpl(1_000);
  }
  throw new Error(`Production health failed (live=${statuses.live}, ready=${statuses.ready}); two consecutive healthy probes were not reached.`);
}

async function run({ expected = parseExpected(), fetchImpl = fetch, output = console.log,
  sleepImpl = sleep } = {}) {
  // Let cold starts and transient database timeouts settle before other probes.
  // Persistent failures still stop the guarded release.
  await waitForHealth(fetchImpl, sleepImpl);
  const webhookProbe = { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' };
  const [root, www, stripeWebhook, printfulWebhook, resendWebhook] = await Promise.all([
    request(fetchImpl, `${PUBLIC_URL}/`, { redirect: 'manual' }),
    request(fetchImpl, `${WWW_URL}/`, { redirect: 'manual' }),
    request(fetchImpl, `${PUBLIC_URL}/webhook/stripe`, webhookProbe),
    request(fetchImpl, `${PUBLIC_URL}/webhook/printful`, webhookProbe),
    request(fetchImpl, `${PUBLIC_URL}/webhook/resend`, webhookProbe),
  ]);
  if (www.status !== 308 || www.headers.get('location') !== `${PUBLIC_URL}/`) {
    throw new Error('The www host does not redirect exactly to the canonical apex.');
  }
  const webhookStatuses = {
    stripe: stripeWebhook.status,
    printful: printfulWebhook.status,
    resend: resendWebhook.status,
  };
  if (Object.values(webhookStatuses).some((status) => status !== 400)) {
    throw new Error(`Production webhook reachability failed (${JSON.stringify(webhookStatuses)}).`);
  }
  if (expected === 'maintenance') {
    if (root.status !== 503 || root.headers.get('x-wolkenworte-maintenance') !== 'active') {
      throw new Error('The production target is not locked in maintenance mode.');
    }
  } else {
    if (root.status !== 200 || !String(root.headers.get('content-type')).includes('text/html')) {
      throw new Error('The active production landing page is not healthy.');
    }
    const probeSlug = generateEventSlug();
    const probeConfiguration = crypto.randomBytes(18).toString('base64url');
    const [legal, event] = await Promise.all([
      request(fetchImpl, `${PUBLIC_URL}/bestellinformationen`),
      request(fetchImpl, `${PUBLIC_URL}/api/events/${probeSlug}/configurations/${probeConfiguration}`),
    ]);
    if (legal.status !== 200 || event.status !== 404 ||
        (await event.json()).error !== 'configuration_not_found') {
      throw new Error(`Representative read-only application routes failed (legal=${legal.status}, configuration=${event.status}).`);
    }
  }
  const result = {
    expected,
    health: 'ok',
    canonicalRedirect: 'ok',
    webhookReachability: 'ok',
    publicStatus: root.status,
    ...(expected === 'active' ? { applicationReads: 'ok' } : {}),
  };
  output(JSON.stringify(result, null, 2));
  return result;
}

if (require.main === module) {
  run().catch((error) => {
    console.error('[cutover:smoke] verification failed:', error.message);
    process.exitCode = 1;
  });
}

module.exports = { PUBLIC_URL, WWW_URL, parseExpected, waitForHealth, run };
