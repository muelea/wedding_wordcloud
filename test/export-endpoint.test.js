'use strict';

// Covers the actual gap this pass closes: a fetchable server-side SVG export
// with a real URL (GET /e/:slug/export.svg), which is what
// src/routes/webhook.js now hands to Printful instead of inline SVG markup
// (see src/printful.js). Reuses the same overlap/completeness invariants
// test/svg-export.test.js already established for layoutWords()/buildSVG(),
// but exercised end-to-end: real submitted words in the DB -> real HTTP
// response.

const test = require('node:test');
const assert = require('node:assert/strict');
const { io: ioClient } = require('socket.io-client');
const { startTestServer, createEvent } = require('./helpers');

function connectSocket(baseUrl, slug) {
  return new Promise((resolve, reject) => {
    const socket = ioClient(baseUrl, { query: { slug }, transports: ['websocket'], forceNew: true });
    const cleanup = () => { socket.off('word-update', onReady); socket.off('connect_error', onErr); };
    const onReady = () => { cleanup(); resolve(socket); };
    const onErr = (err) => { cleanup(); reject(err); };
    socket.once('word-update', onReady);
    socket.once('connect_error', onErr);
  });
}

function submitWord(socket, word) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`timed out waiting for "${word}" to be accepted`)), 2000);
    socket.once('word-accepted', (accepted) => { clearTimeout(timer); resolve(accepted); });
    socket.emit('submit-word', word);
  });
}

// Minimal but real well-formedness check: every opening tag is matched by a
// same-named closing tag in the correct nesting order, no unclosed tags left
// on the stack. Deliberately not a full XML parser (matches this project's
// existing style in test/svg-export.test.js) — good enough to catch a
// mismatched/unescaped tag, which is the failure mode that actually matters
// here (a raw `&`/`<`/`>` in a submitted word breaking the document).
function assertWellFormedXML(xml) {
  assert.match(xml, /^<\?xml version="1\.0" encoding="UTF-8"\?>/, 'must start with an XML declaration');
  const tagRe = /<(\/?)([a-zA-Z][\w:-]*)\b[^>]*?(\/?)>/g;
  const stack = [];
  let m;
  while ((m = tagRe.exec(xml))) {
    const [, closing, name, selfClosing] = m;
    if (selfClosing) continue;
    if (closing) {
      const top = stack.pop();
      assert.equal(top, name, `mismatched closing tag </${name}> (expected </${top}>) in export SVG`);
    } else {
      stack.push(name);
    }
  }
  assert.deepEqual(stack, [], `export SVG has unclosed tag(s): ${stack.join(', ')}`);
}

test('GET /e/:slug/export.svg serves a well-formed SVG containing every submitted word', async (t) => {
  const { baseUrl, close } = await startTestServer();
  t.after(close);

  const event = await createEvent(baseUrl, { coupleName: 'Export Erika & Long Word Lars' });

  const socket = await connectSocket(baseUrl, event.slug);
  t.after(() => socket.close());

  // A realistic mixed submission: a few common words, one with an umlaut,
  // and one long word (near the 30-char MAX_WORD_LENGTH cap in src/words.js)
  // — exactly the case the task called out as likely to break a naive
  // server-side text-measurement approximation or a homegrown XML builder.
  const submitted = [
    'liebe',
    'vertrauen',
    'zärtlichkeit',            // umlaut
    'hochzeitsvorbereitungsstress', // long (29 chars)
  ];
  for (const word of submitted) {
    const accepted = await submitWord(socket, word);
    assert.equal(accepted, word, `"${word}" should normalize to itself (already lowercase, no padding)`);
  }

  const res = await fetch(`${baseUrl}/e/${event.slug}/export.svg`);
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-type') || '', /image\/svg\+xml/);

  const svg = await res.text();
  assertWellFormedXML(svg);

  // Completeness: every submitted word appears exactly once as a <text> body.
  for (const word of submitted) {
    assert.ok(svg.includes(`>${word}</text>`), `export SVG must contain the word "${word}"`);
  }
  const textElementCount = (svg.match(/<text /g) || []).length;
  assert.equal(textElementCount, submitted.length, 'one <text> element per submitted word, no drops/duplicates');
});

test('GET /e/:slug/export.svg 404s for an event with no words submitted yet', async (t) => {
  const { baseUrl, close } = await startTestServer();
  t.after(close);

  const event = await createEvent(baseUrl, { coupleName: 'Wortlose Wendy' });
  const res = await fetch(`${baseUrl}/e/${event.slug}/export.svg`);
  assert.equal(res.status, 404);
});

test('GET /e/:slug/export.svg 404s for an unknown slug', async (t) => {
  const { baseUrl, close } = await startTestServer();
  t.after(close);

  const res = await fetch(`${baseUrl}/e/does-not-exist/export.svg`);
  assert.equal(res.status, 404);
});
