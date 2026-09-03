'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { createRequire } = require('node:module');
const { spawnSync } = require('node:child_process');

const ROOT = path.join(__dirname, '..');
const INSTALL_STAMP = path.join('node_modules', '.wolkenworte-install.json');
const BROWSER_DEPENDENCY_FILES = Object.freeze([
  path.join('node_modules', 'three', 'build', 'three.min.js'),
  path.join('node_modules', 'fabric', 'dist', 'index.min.js'),
  path.join(
    'node_modules',
    '@fontsource',
    'gelasio',
    'files',
    'gelasio-latin-ext-400-normal.woff'
  ),
]);

function fail(message) {
  throw new Error(message);
}

function readJson(filename, label) {
  try {
    return JSON.parse(fs.readFileSync(filename, 'utf8'));
  } catch (error) {
    fail(`${label} konnte nicht gelesen werden: ${error.message}`);
  }
}

function dependencyFingerprint(root = ROOT) {
  const lockPath = path.join(root, 'package-lock.json');
  if (!fs.existsSync(lockPath)) fail('package-lock.json fehlt; der Checkout ist unvollständig.');
  const lockHash = crypto.createHash('sha256').update(fs.readFileSync(lockPath)).digest('hex');
  const nodeMajor = process.versions.node.split('.')[0];
  return `${lockHash}:${nodeMajor}:${process.versions.modules}:${process.platform}:${process.arch}`;
}

function inspectDependencies(root = ROOT, { requireStamp = true } = {}) {
  const problems = [];
  const packagePath = path.join(root, 'package.json');
  const lockPath = path.join(root, 'package-lock.json');
  if (!fs.existsSync(packagePath)) problems.push('package.json fehlt');
  if (!fs.existsSync(lockPath)) problems.push('package-lock.json fehlt');
  if (problems.length) return { problems, fingerprint: null, stamp: null };

  const packageJson = readJson(packagePath, 'package.json');
  const lock = readJson(lockPath, 'package-lock.json');
  const directNames = Object.keys({
    ...(packageJson.dependencies || {}),
    ...(packageJson.devDependencies || {}),
  }).sort();

  for (const name of directNames) {
    const lockedVersion = lock.packages?.[`node_modules/${name}`]?.version;
    const installedPath = path.join(root, 'node_modules', ...name.split('/'), 'package.json');
    if (!lockedVersion) {
      problems.push(`${name} fehlt im Lockfile`);
      continue;
    }
    if (!fs.existsSync(installedPath)) {
      problems.push(`${name}@${lockedVersion} ist nicht installiert`);
      continue;
    }
    let installedVersion = null;
    try {
      installedVersion = JSON.parse(fs.readFileSync(installedPath, 'utf8')).version;
    } catch {
      problems.push(`${name} ist beschädigt`);
      continue;
    }
    if (installedVersion !== lockedVersion) {
      problems.push(`${name} ist ${installedVersion || 'unbekannt'}, erwartet wird ${lockedVersion}`);
    }
  }

  for (const filename of BROWSER_DEPENDENCY_FILES) {
    if (!fs.existsSync(path.join(root, filename))) problems.push(`${filename} fehlt`);
  }

  const fingerprint = dependencyFingerprint(root);
  const stampPath = path.join(root, INSTALL_STAMP);
  let stamp = null;
  if (fs.existsSync(stampPath)) {
    try {
      stamp = JSON.parse(fs.readFileSync(stampPath, 'utf8')).fingerprint || null;
    } catch {
      problems.push(`${INSTALL_STAMP} ist beschädigt`);
    }
  }
  if (requireStamp && stamp !== fingerprint) {
    problems.push(stamp
      ? 'package-lock.json, Node.js oder die Plattform hat sich geändert'
      : 'der lokale Installationsnachweis fehlt');
  }

  return { problems, fingerprint, stamp };
}

function validateNativeDependencies(root = ROOT) {
  for (const name of ['canvas']) {
    const result = spawnSync(process.execPath, ['-e', `require(${JSON.stringify(name)})`], {
      cwd: root,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    if (result.error) fail(`${name} konnte nicht geprüft werden: ${result.error.message}`);
    if (result.status !== 0) {
      const reason = String(result.stderr || result.stdout || '').trim().split(/\r?\n/)[0];
      fail(`${name} kann auf dieser Plattform nicht geladen werden${reason ? `: ${reason}` : '.'}`);
    }
  }
}

function ensureDependencies(root = ROOT, run = spawnSync) {
  const state = inspectDependencies(root);

  if (state.problems.length) {
    console.log('[local] Installiere die exakt in package-lock.json festgelegten Abhängigkeiten ...');
    const npmCommand = process.platform === 'win32' ? 'npm.cmd' : 'npm';
    const result = run(npmCommand, ['ci', '--no-audit', '--no-fund'], {
      cwd: root,
      env: process.env,
      stdio: 'inherit',
    });
    if (result.error) fail(`npm ci konnte nicht gestartet werden: ${result.error.message}`);
    if (result.status !== 0) fail(`npm ci ist fehlgeschlagen (Exit ${result.status}).`);
  }

  const installed = inspectDependencies(root, { requireStamp: false });
  if (installed.problems.length) {
    fail(`Die Installation ist unvollständig: ${installed.problems.join('; ')}.`);
  }
  validateNativeDependencies(root);
  fs.writeFileSync(
    path.join(root, INSTALL_STAMP),
    `${JSON.stringify({ fingerprint: installed.fingerprint })}\n`,
    { mode: 0o600 }
  );
  console.log('[local] Abhängigkeiten und Browser-Runtimes sind vollständig.');
}

function collectRepositoryAssetPaths(root = ROOT) {
  const requireFromRoot = createRequire(path.join(root, 'package.json'));
  const { FONTS } = requireFromRoot('./public/js/design-fonts.js');
  const emojiData = requireFromRoot('./public/js/emoji-data.js');
  const { PRODUCT_FAMILIES, PRODUCTS, getPublicProduct } = requireFromRoot('./src/products.js');
  const urls = new Set();
  const emojiRoot = path.join('public', 'assets', 'noto-emoji', emojiData.artworkVersion);
  urls.add(`/${path.join('assets', 'noto-emoji', emojiData.artworkVersion, 'LICENSE')}`);
  urls.add(`/${path.join('assets', 'noto-emoji', emojiData.artworkVersion, 'FLAGS-LICENSE')}`);
  urls.add(`/${path.join('assets', 'noto-emoji', emojiData.artworkVersion, 'VERSION')}`);
  for (const reference of new Set(Object.values(emojiData.canonicalAssets))) {
    urls.add(`/${path.join('assets', 'noto-emoji', emojiData.artworkVersion, reference)}`);
  }
  const emojiSearchVersion = '48.2';
  for (const locale of ['de', 'en', 'es', 'fr', 'it', 'tr']) {
    urls.add(`/${path.join('emoji-search', emojiSearchVersion, `${locale}.json`)}`);
  }
  urls.add(`/${path.join('emoji-search', emojiSearchVersion, 'catalog.json')}`);
  urls.add(`/${path.join('emoji-search', emojiSearchVersion, 'LICENSE')}`);
  urls.add(`/${path.join('emoji-search', emojiSearchVersion, 'VERSION')}`);

  for (const font of FONTS) {
    if (font.file?.startsWith('/assets/')) urls.add(font.file);
    if (font.boldFile?.startsWith('/assets/')) urls.add(font.boldFile);
  }
  for (const family of PRODUCT_FAMILIES) {
    if (family.thumbnail?.startsWith('/assets/')) urls.add(family.thumbnail);
  }
  for (const product of PRODUCTS) {
    const publicProduct = getPublicProduct(product);
    if (publicProduct.thumbnail?.startsWith('/assets/')) urls.add(publicProduct.thumbnail);
    const previews = [
      publicProduct.previewMockup,
      ...(publicProduct.orientations || []).map((orientation) => orientation.previewMockup),
    ];
    for (const preview of previews) {
      for (const asset of Object.values(preview?.assets || {})) {
        if (asset?.startsWith('/assets/')) urls.add(asset);
      }
    }
  }
  const { SITE_FONT_ASSETS } = requireFromRoot('./src/siteFonts.js');
  for (const fontPath of Object.values(SITE_FONT_ASSETS)) urls.add(fontPath);
  return [...urls].sort().map((url) => path.join('public', url.slice(1)));
}

function validateRepositoryAssets(root = ROOT) {
  const required = [
    path.join('public', 'js', 'mug-3d-viewer.js'),
    ...collectRepositoryAssetPaths(root),
  ];
  const missing = required.filter((filename) => !fs.existsSync(path.join(root, filename)));
  if (missing.length) {
    fail(`Getrackte Browser-Assets fehlen: ${missing.join(', ')}. Bitte den Checkout neu klonen.`);
  }
  return required;
}

function integrationStatus(env = process.env) {
  const stripeMode = String(env.STRIPE_PAYMENT_MODE || 'test').trim().toLowerCase();
  return [
    {
      label: 'Private Druckdateien',
      ready: Boolean(String(env.SUPABASE_URL || '').trim() && String(env.SUPABASE_SECRET_KEY || '').trim()),
    },
    {
      label: 'Stripe Checkout',
      ready: stripeMode === 'live'
        ? Boolean(String(env.STRIPE_LIVE_SECRET_KEY || '').trim())
        : Boolean(String(env.STRIPE_TEST_SECRET_KEY || '').trim()),
    },
    {
      label: 'Printful Preise und Versand',
      ready: Boolean(String(env.PRINTFUL_API_KEY || '').trim()),
    },
  ];
}

function validateLocalEnvironment(root = ROOT) {
  const envPath = path.join(root, '.env');
  if (!fs.existsSync(envPath)) {
    fail('Die lokale .env fehlt. Bitte die freigegebene Entwicklungs-.env sicher vom Maintainer beziehen.');
  }
  const requireFromRoot = createRequire(path.join(root, 'package.json'));
  const loaded = requireFromRoot('dotenv').config({ path: envPath });
  if (loaded.error) fail(`.env konnte nicht gelesen werden: ${loaded.error.message}`);
  if (!String(process.env.DATABASE_URL || '').trim()) {
    fail('DATABASE_URL fehlt in .env; ohne vorbereitete Entwicklungsdatenbank kann Wolkenworte nicht starten.');
  }

  requireFromRoot('./src/runtimeConfig.js').validateRuntimeConfig();
  requireFromRoot('./src/dbConfig.js').connectionOptions(process.env.DATABASE_URL);
  validateRepositoryAssets(root);

  const unavailable = integrationStatus(process.env)
    .filter((integration) => !integration.ready)
    .map((integration) => integration.label);
  if (unavailable.length) {
    console.warn(`[local] Hinweis: Diese optionalen Integrationen sind in .env nicht vollständig konfiguriert: ${unavailable.join(', ')}.`);
  } else {
    console.log('[local] Private Druckdateien, Stripe-Testcheckout und Printful-Preise sind konfiguriert.');
  }
  console.log('[local] 3D-Tasse, Produktbilder und Schriften sind lokal verfügbar.');
}

function main() {
  if (Number.parseInt(process.versions.node, 10) < 22) {
    fail(`Node.js ${process.versions.node} ist zu alt; benötigt wird Node.js 22 oder neuer.`);
  }
  const envPath = path.join(ROOT, '.env');
  if (!fs.existsSync(envPath)) {
    fail('Die lokale .env fehlt. Bitte die freigegebene Entwicklungs-.env sicher vom Maintainer beziehen.');
  }
  ensureDependencies();
  validateLocalEnvironment();
}

if (require.main === module) {
  try {
    main();
  } catch (error) {
    console.error(`\n[local] Fehler: ${error.message}`);
    process.exitCode = 1;
  }
}

module.exports = {
  BROWSER_DEPENDENCY_FILES,
  INSTALL_STAMP,
  collectRepositoryAssetPaths,
  dependencyFingerprint,
  ensureDependencies,
  inspectDependencies,
  integrationStatus,
  validateLocalEnvironment,
  validateNativeDependencies,
  validateRepositoryAssets,
};
