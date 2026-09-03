'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const {
  FINGERPRINT_LENGTH,
  PUBLIC_ROOT,
  fingerprintPublicAsset,
  hasCurrentPublicAssetVersion,
  publicAssetUrl,
} = require('../src/publicAssets');

const VIEW_ROOT = path.join(__dirname, '..', 'views');

function walkFiles(directory) {
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const filename = path.join(directory, entry.name);
    return entry.isDirectory() ? walkFiles(filename) : [filename];
  });
}

test('first-party asset URLs are fingerprints of the shipped bytes', () => {
  const publicPath = '/js/wordcloud-core.js';
  const contents = fs.readFileSync(path.join(PUBLIC_ROOT, publicPath.slice(1)));
  const expected = crypto.createHash('sha256')
    .update(contents)
    .digest('hex')
    .slice(0, FINGERPRINT_LENGTH);

  assert.equal(fingerprintPublicAsset(publicPath), expected);
  assert.equal(publicAssetUrl(publicPath), `${publicPath}?v=${expected}`);
  assert.equal(hasCurrentPublicAssetVersion(publicPath, expected), true);
  assert.equal(hasCurrentPublicAssetVersion(publicPath, 'stale-release'), false);
  assert.equal(hasCurrentPublicAssetVersion('/js/not-present.js', expected), false);
});

test('asset paths cannot escape public and every view asset exists', () => {
  assert.throws(() => publicAssetUrl('../server.js'), /Invalid public asset path/);
  assert.throws(() => publicAssetUrl('/../server.js'), /escapes the public directory/);
  assert.throws(() => publicAssetUrl('/js/wordcloud-core.js?manual=1'), /Invalid public asset path/);

  for (const filename of walkFiles(VIEW_ROOT).filter((value) => value.endsWith('.ejs'))) {
    const source = fs.readFileSync(filename, 'utf8');
    assert.doesNotMatch(
      source,
      /(?:src|href)="\/(?!socket\.io\/|vendor\/)[^"]+\.(?:css|js)(?:\?[^"]*)?"/,
      `${path.relative(VIEW_ROOT, filename)} has a manually versioned first-party runtime`
    );
    for (const match of source.matchAll(/asset\('([^']+)'\)/g)) {
      assert.doesNotThrow(
        () => publicAssetUrl(match[1]),
        `${path.relative(VIEW_ROOT, filename)} references missing asset ${match[1]}`
      );
    }
  }
});

test('every word-cloud page uses the same content-addressed runtime', () => {
  for (const filename of ['landing.ejs', 'display.ejs', 'configure.ejs']) {
    const source = fs.readFileSync(path.join(VIEW_ROOT, filename), 'utf8');
    assert.match(source, /asset\('\/js\/wordcloud-core\.js'\)/, filename);
    assert.doesNotMatch(source, /wordcloud-core\.js\?v=/, filename);
  }

  const display = fs.readFileSync(path.join(VIEW_ROOT, 'display.ejs'), 'utf8');
  assert.match(display, /Number\.isFinite\(WordCloudCore\.TEXT_BASELINE_OFFSET\)/);
  assert.match(display, /:\s*0\.34;/);
});

test('development edits cannot reuse a cached immutable asset fingerprint', () => {
  let contents = Buffer.from('first version'), revision = 1;
  const context = vm.createContext({ module: { exports: {} }, __dirname: path.join(__dirname, '../src'),
    process: { env: { NODE_ENV: 'development' } },
    require(name) { return name === 'node:fs' ? {
      statSync: () => ({ size: contents.length, mtimeMs: revision, ctimeMs: revision }),
      readFileSync: () => contents,
    } : require(name); },
  });
  vm.runInContext(fs.readFileSync(path.join(__dirname, '../src/publicAssets.js'), 'utf8'), context);
  const assets = context.module.exports;
  const first = assets.fingerprintPublicAsset('/js/example.js');
  contents = Buffer.from('second version'); revision += 1;
  const second = assets.fingerprintPublicAsset('/js/example.js');
  assert.notEqual(first, second);
  assert.equal(assets.hasCurrentPublicAssetVersion('/js/example.js', first), false);
  assert.equal(assets.hasCurrentPublicAssetVersion('/js/example.js', second), true);
});
