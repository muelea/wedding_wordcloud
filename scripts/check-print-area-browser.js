'use strict';

// Isolated, loopback-only evidence fixture. It has no database, .env, orders
// or application configuration writes. Start the rendering through its button.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const express = require('express');
const ROOT = path.join(__dirname, '..');
const REPORT = path.join(ROOT, 'reports/print-area-audit-2026-10-24');
const FULL = path.join(REPORT, 'full');
const sha = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const read = file => JSON.parse(fs.readFileSync(file));
const write = (file, value) => fs.writeFileSync(file, JSON.stringify(value, null, 2) + '\n');

function createFixture() {
  const app = express(), nonce = crypto.randomBytes(24).toString('hex');
  const sourceFiles = ['public/js/mug-3d-viewer.js', 'public/js/product-3d-geometry.js',
    'public/js/printful-product-model.js', 'src/productCatalogManifest.json', 'src/productPreviewModels.json',
    'test/browser/print-area-probe.js', 'views/configure.ejs'];
  const sources = Object.fromEntries(sourceFiles.map(file => [file, sha(fs.readFileSync(path.join(ROOT, file)))]));
  app.use((req, res, next) => { res.set('Cache-Control', 'no-store'); next(); });
  app.get('/', (req, res) => res.type('html').send(`<!doctype html><html lang="de"><head>
    <meta charset="utf-8"><title>Druckflächen-Prüfung</title>
    <style>body{font:16px system-ui;margin:24px;color:#20222a}button{padding:12px}#host{width:600px;height:600px;position:relative;background:#fff}#host canvas{width:100%;height:100%}#log{white-space:pre-wrap}img{max-width:300px}</style>
    <script type="importmap">{"imports":{"three":"/vendor/three/build/three.module.js"}}</script>
    <script src="/vendor/three.min.js"></script><script src="/js/product-3d-geometry.js"></script>
    <script src="/js/printful-product-model.js"></script><script src="/js/mug-3d-viewer.js"></script>
    </head><body><h1>Druckflächen-Prüfung · 67 Varianten</h1>
    <p>Lokale Kalibriermuster mit dem echten 3D-Renderer. Technische Ansichten ohne Kameraneigung.</p>
    <button id="start">Alle lokalen Vorschauen rendern</button><a href="/review">Vergleich öffnen</a>
    <output id="status">Bereit</output><div id="host"></div><pre id="log"></pre>
    <script>window.auditNonce=${JSON.stringify(nonce)};</script><script src="/probe.js"></script></body></html>`));
  app.get('/probe.js', (req, res) => res.sendFile(path.join(ROOT, 'test/browser/print-area-probe.js')));
  app.post('/capture/:id/:view', express.raw({ type: 'image/png', limit: '8mb' }), (req, res) => {
    if (req.headers['x-audit-nonce'] !== nonce) return res.sendStatus(403);
    const plan = read(path.join(FULL, 'coverage.json'));
    const c = plan.cases.find(c => c.id === req.params.id);
    if (!c || !['front', 'left', 'right', 'back'].includes(req.params.view) ||
        !Buffer.isBuffer(req.body) || req.body.subarray(0, 8).toString('hex') !== '89504e470d0a1a0a') return res.sendStatus(400);
    const file = `local/${c.id}-${req.params.view}.png`;
    fs.writeFileSync(path.join(FULL, file), req.body);
    const manifestFile = path.join(FULL, 'local-renders.json');
    const manifest = fs.existsSync(manifestFile) ? read(manifestFile) : { cases: {} };
    const entry = manifest.cases[c.id] ||= { views: {} };
    entry.productSha256 = sha(Buffer.from(JSON.stringify(c.product)));
    entry.designSha256 = sha(fs.readFileSync(path.join(FULL, c.designsFile)));
    entry.sources = sources;
    entry.renderedAt = new Date().toISOString();
    entry.views[req.params.view] = { file, sha256: sha(req.body) };
    write(manifestFile, manifest); res.sendStatus(204);
  });
  app.get('/review', (req, res) => {
    const plan = read(path.join(FULL, 'coverage.json'));
    const rendersFile = path.join(FULL, 'local-renders.json');
    const renders = fs.existsSync(rendersFile) ? read(rendersFile) : { cases: {} };
    const rows = plan.cases.filter(c => !req.query.only || c.id.includes(req.query.only)).map(c => {
      const views = Object.entries(renders.cases[c.id]?.views || {}).map(([view, v]) =>
        `<figure><img src="/audit/full/${v.file}"><figcaption>Wolkenworte · ${view}</figcaption></figure>`).join('');
      const provider = c.provider.map(v => `<figure><img src="/audit/full/${v.file}"><figcaption>Printful · ${v.view || v.placement || ''}</figcaption></figure>`).join('');
      return `<article><h2>${c.id}</h2><p>Variante ${c.variantId} · ${c.product.printFile.width} × ${c.product.printFile.height} · ${c.providerStatus}</p><section>${views}${provider}</section></article>`;
    }).join('');
    res.type('html').send(`<!doctype html><html><head><meta charset="utf-8"><title>Druckflächen-Vergleich</title><style>body{font:14px system-ui;margin:20px}article{border-bottom:1px solid #aaa;padding:20px 0}h2{font-size:18px}section{display:flex;flex-wrap:wrap}figure{margin:6px;width:270px}img{width:270px;height:270px;object-fit:contain;background:white}figcaption{text-align:center}</style></head><body><h1>Wolkenworte / Printful · Kalibriervergleich</h1>${rows}</body></html>`);
  });
  app.use('/audit', express.static(REPORT, { index: false, dotfiles: 'deny' }));
  app.get('/vendor/three.min.js', (req, res) => res.sendFile(path.join(ROOT, 'node_modules/three/build/three.min.js')));
  app.use('/vendor/three', express.static(path.join(ROOT, 'node_modules/three'), { index: false, dotfiles: 'deny' }));
  app.use(express.static(path.join(ROOT, 'public'), { index: false, dotfiles: 'deny' }));
  return app;
}
if (require.main === module) {
  const server = createFixture().listen(0, '127.0.0.1', () => console.log(`Print area fixture http://127.0.0.1:${server.address().port}/ PID ${process.pid}`));
  const close = () => { server.close(); server.closeAllConnections(); };
  process.once('SIGTERM', close); process.once('SIGINT', close);
}
module.exports = { createFixture };
