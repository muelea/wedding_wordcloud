'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const parse5 = require('parse5');
const { loadImage } = require('canvas');
const { startTestServer, createEvent } = require('./helpers');

function elements(node, tagName, result = []) {
  if (node?.tagName === tagName) result.push(node);
  for (const child of node?.childNodes || []) elements(child, tagName, result);
  return result;
}

function attribute(node, name) {
  return node.attrs?.find((candidate) => candidate.name === name)?.value;
}

function metadata(document, selectorAttribute) {
  return new Map(elements(document, 'meta')
    .filter((node) => attribute(node, selectorAttribute))
    .map((node) => [attribute(node, selectorAttribute), attribute(node, 'content')]));
}

test('public event pages provide a complete server-rendered social sharing card', async (t) => {
  const previousPublicUrl = process.env.PUBLIC_URL;
  const { baseUrl, close } = await startTestServer();
  process.env.PUBLIC_URL = baseUrl;
  t.after(async () => {
    if (previousPublicUrl == null) delete process.env.PUBLIC_URL;
    else process.env.PUBLIC_URL = previousPublicUrl;
    await close();
  });

  const event = await createEvent(baseUrl, { title: 'Anna & Ben', locale: 'en' });
  const eventUrl = `${baseUrl}/e/${event.slug}`;
  const response = await fetch(eventUrl, {
    headers: { 'User-Agent': 'WhatsApp/2.24 LinkPreview' },
  });
  assert.equal(response.status, 200);

  const document = parse5.parse(await response.text());
  const openGraph = metadata(document, 'property');
  const twitter = metadata(document, 'name');
  const canonical = elements(document, 'link')
    .find((node) => attribute(node, 'rel') === 'canonical');
  const description = 'You’re invited to help create the word cloud “Anna & Ben”. ' +
    'Add a word and watch it grow live.';

  assert.equal(attribute(canonical, 'href'), eventUrl);
  assert.equal(openGraph.get('og:type'), 'website');
  assert.equal(openGraph.get('og:site_name'), 'Wolkenworte');
  assert.equal(openGraph.get('og:locale'), 'en_US');
  assert.equal(openGraph.get('og:title'), 'Anna & Ben – word cloud');
  assert.equal(openGraph.get('og:description'), description);
  assert.equal(openGraph.get('og:url'), eventUrl);
  assert.equal(openGraph.get('og:image:type'), 'image/png');
  assert.equal(openGraph.get('og:image:width'), '1200');
  assert.equal(openGraph.get('og:image:height'), '630');
  assert.equal(openGraph.get('og:image:alt'), 'Wolkenworte – Your memories in one word');
  assert.match(openGraph.get('og:image'), new RegExp(
    `^${baseUrl.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}/assets/social/wolkenworte-share\\.png\\?v=[a-f0-9]{16}$`,
  ));

  assert.equal(twitter.get('description'), description);
  assert.equal(twitter.get('twitter:card'), 'summary_large_image');
  assert.equal(twitter.get('twitter:title'), openGraph.get('og:title'));
  assert.equal(twitter.get('twitter:description'), description);
  assert.equal(twitter.get('twitter:image'), openGraph.get('og:image'));
  assert.equal(twitter.get('twitter:image:alt'), openGraph.get('og:image:alt'));

  const imageResponse = await fetch(openGraph.get('og:image'));
  assert.equal(imageResponse.status, 200);
  assert.equal(imageResponse.headers.get('content-type'), 'image/png');
  assert.match(imageResponse.headers.get('cache-control') || '', /max-age=31536000/);
  const image = await loadImage(Buffer.from(await imageResponse.arrayBuffer()));
  assert.equal(image.width, 1200);
  assert.equal(image.height, 630);
});
