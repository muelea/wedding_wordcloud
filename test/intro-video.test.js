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

function outro({ duration = 8.5, currentTime = 0, height = 844 } = {}) {
  const source = require('node:fs').readFileSync(require('node:path').join(__dirname, '../views/landing.ejs'), 'utf8');
  const script = [...source.matchAll(/<script>([\s\S]*?)<\/script>/g)]
    .map(match => match[1]).find(value => value.includes('function finishIntro('));
  const { JSDOM } = require('jsdom');
  const dom = new JSDOM('<html class="intro-enabled intro-lock intro-fade"><body><div id="intro-overlay"><video id="intro-video"></video><button id="intro-scroll-cue"></button></div><header id="site-header"></header><div id="intro-scroll-space"></div></body></html>');
  const { window } = dom;
  const video = window.document.getElementById('intro-video');
  Object.defineProperty(video, 'duration', { value: duration });
  video.currentTime = currentTime;
  video.play = () => Promise.resolve();
  video.pause = () => {};
  let onMotionChange;
  const motion = { matches: false, addEventListener(name, callback) { onMotionChange = callback; }, removeEventListener() {} };
  window.matchMedia = () => motion;
  let range = height, scrollRequest;
  window.document.getElementById('intro-scroll-space').getBoundingClientRect = () => ({ height: range });
  window.scrollTo = options => { scrollRequest = options; };
  let pendingFrame;
  window.requestAnimationFrame = callback => { pendingFrame = callback; return 1; };
  vm.runInNewContext(script, { window, document: window.document, Number });
  return { window, video, reduceMotion() { motion.matches = true; onMotionChange(); }, get scrollRequest() { return scrollRequest; },
    resize(height) { range = height; window.dispatchEvent(new window.Event('resize')); this.paint(); },
    scroll(top) { window.scrollY = top; window.dispatchEvent(new window.Event('scroll')); this.paint(); },
    paint() { if (pendingFrame) { const cb = pendingFrame; pendingFrame = null; cb(); } },
    overlay: window.document.getElementById('intro-overlay') };
}

test('video completion and the accessible skip button use the same native scroll destination', () => {
  for (const action of ['timeupdate', 'ended', 'error', 'click']) {
    const h = outro();
    h.video.currentTime = 7;
    (action === 'click' ? h.window.document.getElementById('intro-scroll-cue') : h.video)
      .dispatchEvent(new h.window.Event(action));
    assert.equal(h.scrollRequest.top, 844);
    assert.equal(h.scrollRequest.behavior, 'smooth');
    h.scroll(844);
    assert.ok(h.overlay.classList.contains('fade-out'));
    assert.equal(h.overlay.inert, true);
    assert.equal(h.window.document.documentElement.classList.contains('intro-lock'), false);
    assert.ok(h.window.document.getElementById('intro-scroll-space').isConnected, 'the scroll range stays in flow');
    h.window.close();
  }
});

test('native scroll reveal reverses, completes without repositioning and follows viewport changes', () => {
  for (const height of [320, 568, 844, 900]) {
    const h = outro({ height });
    const root = h.window.document.documentElement;
    h.scroll(height / 2);
    assert.equal(root.style.getPropertyValue('--intro-film-opacity'), '0.5');
    h.scroll(height / 4);
    assert.equal(root.style.getPropertyValue('--intro-film-opacity'), '0.75');
    h.resize(height / 2);
    assert.equal(root.style.getPropertyValue('--intro-film-opacity'), '0.5');
    h.scroll(height);
    assert.equal(h.scrollRequest, undefined, 'manual scrolling never triggers corrective scrolling');
    assert.ok(h.overlay.classList.contains('fade-out'));
    h.scroll(0);
    assert.equal(h.overlay.inert, false);
    assert.equal(root.classList.contains('intro-lock'), true);
    h.window.close();
  }
});

test('wheel, touch, zoom and keyboard input remain browser-owned throughout the intro', () => {
  const h = outro();
  for (const type of ['wheel', 'touchstart', 'touchmove', 'touchend', 'keydown']) {
    const event = new h.window.Event(type, { cancelable: true });
    h.window.dispatchEvent(event);
    assert.equal(event.defaultPrevented, false, type);
  }
  h.scroll(400);
  h.video.dispatchEvent(new h.window.Event('error'));
  assert.equal(h.scrollRequest.top, 844, 'partial progress cannot trap the visitor on a failed video');
  h.window.close();
});


test('enabling reduced motion removes the intro without leaving a blank scroll range', () => {
  const h = outro();
  h.scroll(1000);
  h.reduceMotion();
  assert.equal(h.overlay.isConnected, false);
  assert.equal(h.window.document.documentElement.classList.contains('intro-enabled'), false);
  assert.equal(h.scrollRequest.top, 156, 'the visible homepage position is preserved');
  assert.equal(h.scrollRequest.behavior, 'instant');
  h.scroll(0);
  assert.equal(h.window.document.documentElement.classList.contains('intro-lock'), false);
  h.window.close();
});
