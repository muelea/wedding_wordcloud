'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const { renderPage } = require('../src/pageRenderer');

async function fixture() {
  let html;
  await renderPage({ query: {}, headers: {}, originalUrl: '/' }, {
    status() {}, set() {}, vary() {}, send(value) { html = value; },
  }, 'landing');
  const video = html.match(/<video id="intro-video"[\s\S]*?<\/video>/)?.[0];
  assert.ok(video);
  const dataset = Object.fromEntries([...video.matchAll(/data-(mobile|desktop)-(src|poster)="([^"]+)"/g)]
    .map(([, variant, kind, value]) => [variant + kind[0].toUpperCase() + kind.slice(1), value]));
  assert.equal(Object.keys(dataset).length, 4);
  const initialization = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)]
    .map(match => match[1]).find(source => source.includes('var reduceMotion') && source.includes('WolkenworteJourney.recent()'));
  assert.ok(initialization);
  return { video, dataset, initialization };
}

function run({ dataset, initialization }, { width = 390, height = 844,
  reduced = false, recent = false, previousSrc = '' } = {}) {
  const loads = [], classes = new Set();
  const overlay = { style: {}, removed: false, remove() { this.removed = true; } };
  const video = { dataset, src: previousSrc, muted: false, preload: 'none',
    load() { loads.push({ src: this.src, poster: this.poster,
      muted: this.muted, preload: this.preload, background: overlay.style.backgroundImage }); } };
  vm.runInNewContext(initialization, {
    document: {
      getElementById: id => id === 'intro-overlay' ? overlay : video,
      documentElement: { classList: { add: (...names) => names.forEach(name => classes.add(name)) } },
    },
    window: { matchMedia(query) {
      if (query === '(prefers-reduced-motion: reduce)') return { matches: reduced };
      assert.equal(query, '(max-width: 760px) and (orientation: portrait)');
      return { matches: width <= 760 && height >= width };
    } },
    WolkenworteJourney: { recent: () => recent },
  });
  return { loads, classes, overlay };
}

test('portrait phones explicitly load only the mobile video and matching poster on first visit and reload', async () => {
  const page = await fixture();
  assert.doesNotMatch(page.video, /<source\b|\ssrc="|\sposter="/);
  for (const previousSrc of ['', page.dataset.desktopSrc, page.dataset.mobileSrc]) {
    const { loads, classes } = run(page, { previousSrc });
    assert.deepEqual(loads, [{ src: page.dataset.mobileSrc, poster: page.dataset.mobilePoster,
      muted: true, preload: 'auto', background: `url("${page.dataset.mobilePoster}")` }]);
    assert.ok(classes.has('intro-lock') && classes.has('intro-fade'));
  }
});

test('the portrait breakpoint chooses paired assets consistently', async () => {
  const page = await fixture();
  for (const [width, height, variant] of [
    [320, 568, 'mobile'], [760, 900, 'mobile'], [761, 900, 'desktop'],
    [1440, 900, 'desktop'], [844, 390, 'desktop'], [700, 350, 'desktop'],
  ]) {
    const { loads } = run(page, { width, height });
    assert.equal(loads.length, 1);
    assert.equal(loads[0].src, page.dataset[variant + 'Src']);
    assert.equal(loads[0].poster, page.dataset[variant + 'Poster']);
  }
});

test('skipped intros remove the overlay without loading either video', async () => {
  const page = await fixture();
  for (const options of [{ reduced: true }, { recent: true }]) {
    const { loads, overlay, classes } = run(page, options);
    assert.equal(loads.length, 0);
    assert.equal(overlay.removed, true);
    assert.equal(classes.size, 0);
  }
});
