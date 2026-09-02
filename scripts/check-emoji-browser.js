'use strict';

// Isolated, read-only browser regression fixture. No .env, database, provider
// calls or product records; uses the same asset endpoint and renderer as the app.
const path = require('node:path');
const express = require('express');
const { ASSET_BASE } = require('../public/js/emoji-catalog');
const { makeEmojiArtworkRouter } = require('../src/routes/emojiArtwork');

const root = path.join(__dirname, '..');
const app = express();
app.use((req, res, next) => {
  res.set('Cache-Control', 'no-store');
  next();
});
app.use(ASSET_BASE, makeEmojiArtworkRouter());
app.get('/', (req, res) => res.sendFile(path.join(root, 'test/browser/emoji-rendering.html')));
app.get('/probe.js', (req, res) => res.sendFile(path.join(root, 'test/browser/emoji-rendering-probe.js')));
app.get('/vendor/fabric.min.js', (req, res) => res.sendFile(path.join(root, 'node_modules/fabric/dist/index.min.js')));
app.get('/vendor/fonts/gelasio-latin-ext-400-normal.woff', (req, res) =>
  res.sendFile(require.resolve('@fontsource/gelasio/files/gelasio-latin-ext-400-normal.woff')));
app.use(express.static(path.join(root, 'public')));
app.use((error, req, res, next) => {
  if (res.headersSent) return next(error);
  res.set('Cache-Control', 'no-store').status(500).send('Emoji-Testdatei konnte nicht geladen werden.');
});

const server = app.listen(0, '127.0.0.1', () => {
  console.log(`Emoji-Renderer prüfen: http://127.0.0.1:${server.address().port}`);
  console.log('In Chrome, Firefox und Safari öffnen. Keine Produktdaten werden verändert.');
  console.log('Mit Strg+C beenden.');
});
function close() {
  server.close();
  server.closeAllConnections();
}
process.once('SIGINT', close);
process.once('SIGTERM', close);
