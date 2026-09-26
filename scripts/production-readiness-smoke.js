'use strict';

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

async function run({ expected = parseExpected(), fetchImpl = fetch, output = console.log } = {}) {
  const [live, ready, root, www] = await Promise.all([
    request(fetchImpl, `${PUBLIC_URL}/health/live`),
    request(fetchImpl, `${PUBLIC_URL}/health/ready`),
    request(fetchImpl, `${PUBLIC_URL}/`, { redirect: 'manual' }),
    request(fetchImpl, `${WWW_URL}/`, { redirect: 'manual' }),
  ]);
  if (live.status !== 200 || ready.status !== 200) {
    throw new Error(`Production health failed (live=${live.status}, ready=${ready.status}).`);
  }
  if (www.status !== 308 || www.headers.get('location') !== `${PUBLIC_URL}/`) {
    throw new Error('The www host does not redirect exactly to the canonical apex.');
  }
  if (expected === 'maintenance') {
    if (root.status !== 503 || root.headers.get('x-wolkenworte-maintenance') !== 'active') {
      throw new Error('The production target is not locked in maintenance mode.');
    }
  } else {
    if (root.status !== 200 || !String(root.headers.get('content-type')).includes('text/html')) {
      throw new Error('The active production landing page is not healthy.');
    }
  }
  const result = { expected, health: 'ok', canonicalRedirect: 'ok', publicStatus: root.status };
  output(JSON.stringify(result, null, 2));
  return result;
}

if (require.main === module) {
  run().catch((error) => {
    console.error('[cutover:smoke] verification failed:', error.message);
    process.exitCode = 1;
  });
}

module.exports = { PUBLIC_URL, WWW_URL, parseExpected, run };
