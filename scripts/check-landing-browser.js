'use strict';

// Real homepage/client assets, without .env, a database or provider calls.
// The form POST is a navigation probe only: it never creates an event.
const path = require('node:path');
const os = require('node:os');
const express = require('express');
const { renderPage } = require('../src/pageRenderer');
const { ASSET_BASE } = require('../public/js/emoji-catalog');
const { makeEmojiArtworkRouter } = require('../src/routes/emojiArtwork');

function omissions(value) {
  const requested = String(value || '').split(',');
  return ['video', 'demo', 'filters'].filter(name => requested.includes(name));
}

function instrument(html, omitted) {
  // Even an inherited GA setting must not send fixture traffic to analytics.
  html = html.replace(/<script\b[^>]*src="[^" ]*\/js\/analytics\.js[^" ]*"[^>]*><\/script>/g, '');
  if (omitted.includes('video')) {
    html = html.replace(/<div id="intro-overlay">[\s\S]*?<\/div>/, '')
      .replace(/<div id="intro-scroll-space"[^>]*><\/div>/, '')
      .replace(/<script>([\s\S]*?)<\/script>/g, (tag, source) =>
        source.includes("getElementById('intro-overlay')") ? '' : tag);
  }
  if (omitted.includes('demo')) {
    html = html.replace(/<script\b[^>]*src="[^" ]*\/js\/landing-demo\.js[^" ]*"[^>]*><\/script>/g, '');
  }
  const styles = omitted.includes('filters')
    ? '<style>*, *::before, *::after, dialog::backdrop { filter: none !important; backdrop-filter: none !important; -webkit-backdrop-filter: none !important; }</style>' : '';
  const query = encodeURIComponent(omitted.join(','));
  return html.replace('action="/start"', `action="/start?omit=${query}"`)
    .replace('<head>', `<head><script src="/__landing-probe.js" data-omitted="${omitted.join(',')}"></script>${styles}`);
}

function createFixture() {
  const app = express();
  const root = path.join(__dirname, '..');
  app.use((req, res, next) => {
    res.set('Cache-Control', 'no-store');
    // All resources must stay local, including if analytics is configured.
    res.set('Content-Security-Policy', "default-src 'self' data: blob:; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; connect-src 'self'; worker-src 'self' blob:; object-src 'none'; form-action 'self'");
    next();
  });
  app.get('/', (req, res, next) => {
    const send = res.send.bind(res);
    res.send = html => send(instrument(html, omissions(req.query.omit)));
    renderPage(req, res, 'landing', { header: { variant: 'landing', headerClass: 'site-header',
      navClass: 'shell nav', id: 'site-header' } }).catch(next);
  });
  app.post('/start', (req, res) => {
    // Do not parse, store, echo or log the name/PIN. Only exercise navigation.
    req.resume();
    res.redirect(303, `/__submitted?omit=${encodeURIComponent(omissions(req.query.omit).join(','))}`);
  });
  app.get('/__submitted', (req, res) => res.type('html').send(instrument(`<!doctype html><html lang="de"><head>
    <meta name="viewport" content="width=device-width, initial-scale=1"><title>Lokale Safari-Diagnose</title>
    <link rel="stylesheet" href="/site-header.css"></head>
    <body><h1>Lokales Formular gesendet</h1><p>Die Navigation hat funktioniert. Es wurde keine Wortwolke erstellt.
    Name und PIN werden nicht gespeichert. Die echte Eventseite wird hier nicht geprüft.</p>
    <a href="/?omit=${encodeURIComponent(omissions(req.query.omit).join(','))}">Zurück zur Diagnose</a></body></html>`, omissions(req.query.omit))));
  app.get('/__landing-probe.js', (req, res) => res.sendFile(path.join(root, 'test/browser/landing-diagnostics-probe.js')));
  app.get('/api/account/session', (req, res) => res.json({ user: null }));
  app.use(ASSET_BASE, makeEmojiArtworkRouter());
  app.use('/vendor/three', express.static(path.join(root, 'node_modules/three'), { index: false, dotfiles: 'deny' }));
  app.use(express.static(path.join(root, 'public'), { index: false, dotfiles: 'deny' }));
  return app;
}

if (require.main === module) {
  const lan = process.argv.includes('--lan');
  const server = createFixture().listen(0, lan ? '0.0.0.0' : '127.0.0.1', () => {
    const port = server.address().port;
    console.log(`Local Safari diagnosis: http://127.0.0.1:${port}/?lang=de`);
    if (lan) for (const addresses of Object.values(os.networkInterfaces())) for (const address of addresses || []) {
      if (address.family === 'IPv4' && !address.internal) console.log(`Same-Wi-Fi iPhone: http://${address.address}:${port}/?lang=de`);
    }
    console.log('Compare baseline, omit=video, omit=demo, omit=filters, then omit=video,demo,filters.');
    console.log('No database, event creation, real event-page rendering, analytics or provider calls. Reports stay in this browser.');
    console.log('Use test names/PINs. A saved breadcrumb is not a native crash report. Ctrl-C stops this fixture.');
  });
  const close = () => { server.close(); server.closeAllConnections(); };
  process.once('SIGINT', close);
  process.once('SIGTERM', close);
}

module.exports = { createFixture, instrument, omissions };
