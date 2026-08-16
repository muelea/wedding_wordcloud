const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const QRCode = require('qrcode');
const os = require('os');
const path = require('path');
const fs = require('fs');
const compression = require('compression');

// ── Configuration ─────────────────────────────────────────────────────────────
const CONFIG = {
  coupleName: 'Johanna & Peter', // ← Change to the couple's names
  eventTitle: 'Hochzeit',       // ← Shown on the display screen
  port: process.env.PORT || 3000,
  maxWordLength: 30,
};
// ─────────────────────────────────────────────────────────────────────────────

// Matches emoji, flag sequences, and their joiner/modifier characters —
// guests submit text only, no emoji.
const EMOJI_REGEX = /[\p{Extended_Pictographic}\p{Regional_Indicator}\p{Emoji_Modifier}\u200D\uFE0F]/gu;

const app = express();
const server = http.createServer(app);
const io = new Server(server);

// Behind Render's (or any) reverse proxy, this makes req.protocol correctly
// report "https" instead of the internal "http" the proxy forwards.
app.set('trust proxy', true);

// Works locally (LAN IP + QR), on Render (auto-detected via its own env var),
// and with a custom domain (PUBLIC_URL override, or auto-detected from the
// request's Host header once DNS points at it) — no code change needed
// when moving between them.
function getBaseUrl(req) {
  if (process.env.PUBLIC_URL) return process.env.PUBLIC_URL.replace(/\/$/, '');
  if (process.env.RENDER_EXTERNAL_URL) return process.env.RENDER_EXTERNAL_URL.replace(/\/$/, '');
  // "localhost" only resolves on this machine, so it's useless in a QR code
  // meant for a guest's phone — fall back to the LAN IP in that case.
  const host = req && req.get('host');
  if (host && !/^(localhost|127\.0\.0\.1)(:|$)/.test(host)) {
    return `${req.protocol}://${host}`;
  }
  return `http://${getLocalIP()}:${CONFIG.port}`;
}

// Word store: word (lowercase) → count, persisted to disk so a crash or
// restart during the event doesn't lose everyone's submitted words.
const DATA_FILE = path.join(__dirname, 'data', 'words.json');
const wordCounts = new Map();

fs.mkdirSync(path.dirname(DATA_FILE), { recursive: true });

try {
  if (fs.existsSync(DATA_FILE)) {
    const saved = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
    for (const [word, count] of saved) wordCounts.set(word, count);
    console.log(`  Loaded ${wordCounts.size} saved word(s) from ${DATA_FILE}`);
  }
} catch (err) {
  console.error('  Could not load saved words, starting empty:', err.message);
}

function persistWords() {
  try {
    fs.writeFileSync(DATA_FILE, JSON.stringify(Array.from(wordCounts.entries())));
  } catch (err) {
    console.error('Failed to save words to disk:', err.message);
  }
}

// Snapshot the current words before a reset, so starting a new round never
// loses the previous one.
const ARCHIVE_DIR = path.join(__dirname, 'data', 'archive');
fs.mkdirSync(ARCHIVE_DIR, { recursive: true });

function archiveWords() {
  if (wordCounts.size === 0) return;
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const file = path.join(ARCHIVE_DIR, `words-${stamp}.json`);
  try {
    fs.writeFileSync(file, JSON.stringify(Array.from(wordCounts.entries()), null, 2));
  } catch (err) {
    console.error('Failed to archive words:', err.message);
  }
}

function getLocalIP() {
  const interfaces = os.networkInterfaces();
  for (const name of Object.keys(interfaces)) {
    for (const iface of interfaces[name]) {
      if (iface.family === 'IPv4' && !iface.internal) {
        return iface.address;
      }
    }
  }
  return 'localhost';
}

app.use(compression());

app.use(express.static(path.join(__dirname, 'public'), {
  setHeaders: (res, filePath) => {
    // Vendored libraries (wordcloud2.js) never change during an event —
    // let phones cache them for a week instead of re-fetching every load.
    if (filePath.endsWith('.js')) {
      res.setHeader('Cache-Control', 'public, max-age=604800, immutable');
    }
  },
}));

// The public root is the product landing page. Guests use this focused screen
// after scanning the QR code during an event.
app.get('/join', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'join.html'));
});

app.get('/display', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'display.html'));
});

app.get('/config', (req, res) => {
  res.json({ coupleName: CONFIG.coupleName, eventTitle: CONFIG.eventTitle });
});

app.get('/qr', async (req, res) => {
  const url = `${getBaseUrl(req)}/join`;
  try {
    const dataUrl = await QRCode.toDataURL(url, {
      width: 220,
      margin: 1,
      color: { dark: '#5a3e36', light: '#fdf8f4' },
    });
    res.json({ dataUrl, url });
  } catch (err) {
    res.status(500).json({ error: 'QR generation failed' });
  }
});

// Archive the current words to disk, then clear the board for a new round
app.post('/reset', (req, res) => {
  archiveWords();
  wordCounts.clear();
  persistWords();
  io.emit('word-update', []);
  res.json({ ok: true });
});

io.on('connection', (socket) => {
  // Send current state to newly connected client
  socket.emit('word-update', Array.from(wordCounts.entries()));

  socket.on('submit-word', (rawWord) => {
    if (typeof rawWord !== 'string') return;
    // NFC normalization fixes NFD-encoded umlauts (e.g. macOS option-key input)
    let word = rawWord.normalize('NFC').trim()
      .replace(/[\x00-\x1f\x7f]/g, '')   // strip control chars only
      .replace(EMOJI_REGEX, '')          // text only, no emoji
      .replace(/ {2,}/g, ' ')            // collapse gaps left behind by stripped emoji
      .trim()
      .slice(0, CONFIG.maxWordLength)
      .trim()
      .toLowerCase();
    if (!word) return;

    const count = (wordCounts.get(word) || 0) + 1;
    wordCounts.set(word, count);
    persistWords();

    io.emit('word-update', Array.from(wordCounts.entries()));
    socket.emit('word-accepted', word);
  });

  // Relay theme changes to all connected clients
  socket.on('theme-change', (theme) => {
    if (theme === 'neon' || theme === 'pastel') {
      socket.broadcast.emit('theme-change', theme);
    }
  });
});

server.listen(CONFIG.port, () => {
  const base = getBaseUrl();
  console.log('\n  ♡  Wedding Word Cloud is running!\n');
  console.log(`  Guest URL   →  ${base}/join`);
  console.log(`  Display URL →  ${base}/display`);
  console.log(`\n  Open the display URL on the big screen.`);
  console.log(`  Guests scan the QR code shown on the display.\n`);
});
