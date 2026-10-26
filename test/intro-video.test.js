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

function outro({ duration = 8.5, currentTime = 0 } = {}) {
  const source = require('node:fs').readFileSync(require('node:path').join(__dirname, '../views/landing.ejs'), 'utf8');
  const script = [...source.matchAll(/<script>([\s\S]*?)<\/script>/g)]
    .map(match => match[1]).find(value => value.includes('function finishIntro('));
  const { JSDOM } = require('jsdom');
  const dom = new JSDOM('<html class="intro-lock intro-fade"><body><div id="intro-overlay"><video id="intro-video"></video><div id="intro-scroll-cue"></div></div><header id="site-header"></header></body></html>');
  const { window } = dom;
  const video = window.document.getElementById('intro-video');
  Object.defineProperty(video, 'duration', { value: duration });
  video.currentTime = currentTime;
  const timers = [];
  let pageScroll = 0;
  window.scrollTo = ({ top }) => { pageScroll = top; };
  window.scrollBy = ({ top }) => { pageScroll = Math.max(0, pageScroll + top); };
  let pendingFrame;
  window.requestAnimationFrame = callback => { pendingFrame = callback; return 1; };
  window.cancelAnimationFrame = () => { pendingFrame = null; };
  window.clearTimeout = () => {};
  window.setTimeout = (callback, delay) => { timers.push({ callback, delay }); };
  vm.runInNewContext(script, { window, document: window.document, Number });
  return { window, video, timers, get pageScroll() { return pageScroll; }, paint() { if (pendingFrame) { const cb = pendingFrame; pendingFrame = null; cb(); } }, overlay: window.document.getElementById('intro-overlay') };
}

test('the final title dissolves before playback ends and unlocks only after the dissolve', () => {
  const h = outro();
  h.video.currentTime = 6;
  h.video.dispatchEvent(new h.window.Event('timeupdate'));
  assert.equal(h.timers.length, 0);
  h.video.currentTime = 7;
  h.video.dispatchEvent(new h.window.Event('timeupdate'));
  assert.ok(h.overlay.classList.contains('fade-out'));
  assert.equal(h.window.document.documentElement.classList.contains('intro-fade'), true, 'homepage stays hidden during the video fade');
  assert.ok(h.window.document.documentElement.classList.contains('intro-lock'));
  h.video.dispatchEvent(new h.window.Event('ended'));
  assert.equal(h.timers.length, 1, 'ended cannot restart the transition');
  assert.equal(h.timers[0].delay, 1250);
  h.timers[0].callback();
  assert.equal(h.overlay.isConnected, false);
  assert.equal(h.window.document.documentElement.classList.contains('intro-fade'), false);
  assert.ok(h.window.document.documentElement.classList.contains('intro-lock'));
  assert.equal(h.timers[1].delay, 350);
  h.timers[1].callback();
  assert.equal(h.window.document.documentElement.classList.contains('intro-lock'), false);
  h.window.close();
});

test('late initialization and video errors still complete the intro', () => {
  for (const options of [{ currentTime: 8 }, { duration: NaN }]) {
    const h = outro(options);
    if (Number.isNaN(options.duration)) h.video.dispatchEvent(new h.window.Event('error'));
    assert.equal(h.timers.length, 1);
    h.timers[0].callback();
    assert.equal(h.overlay.isConnected, false);
    h.window.close();
  }
});

test('wheel progress directly moves the homepage over the video and can reverse', () => {
  const h = outro();
  const root = h.window.document.documentElement;
  function wheel(deltaY, options = {}) {
    const event = new h.window.WheelEvent('wheel', { deltaY, cancelable: true, ...options });
    h.window.dispatchEvent(event); h.paint(); return event;
  }
  wheel(100, { ctrlKey: true });
  assert.equal(root.classList.contains('intro-scrubbing'), false);
  assert.ok(wheel(h.window.innerHeight / 4).defaultPrevented);
  assert.ok(root.classList.contains('intro-scrubbing'));
  assert.equal(root.style.getPropertyValue('--intro-rise'), h.window.innerHeight * .75 + 'px');
  assert.equal(root.style.getPropertyValue('--intro-paper-opacity'), '0', 'words enter before the paper background');
  assert.equal(root.style.getPropertyValue('--intro-content-opacity'), '0', 'other homepage content waits for the background');
  assert.equal(h.timers.length, 0, 'stopping the gesture leaves progress in place');
  wheel(-h.window.innerHeight / 8);
  assert.equal(root.style.getPropertyValue('--intro-rise'), h.window.innerHeight * .875 + 'px');
  h.video.dispatchEvent(new h.window.Event('ended'));
  assert.equal(h.timers.length, 0, 'automatic ending cannot interrupt the gesture');
  wheel(h.window.innerHeight * .5);
  assert.ok(Number(root.style.getPropertyValue('--intro-paper-opacity')) > 0);
  assert.ok(Number(root.style.getPropertyValue('--intro-film-opacity')) < 1);
  wheel(-h.window.innerHeight * .5);
  wheel(h.window.innerHeight);
  assert.equal(h.overlay.isConnected, false);
  assert.equal(root.classList.contains('intro-fade'), false);
  assert.equal(root.classList.contains('intro-lock'), false);
  assert.equal(h.pageScroll, h.window.innerHeight / 8, 'only excess motion scrolls the homepage');
  assert.equal(wheel(50).defaultPrevented, false, 'continued wheel motion goes straight to native scrolling');
  assert.equal(h.timers.length, 0, 'no idle timeout is required');
  h.window.close();
});

test('mobile swipe continues into the homepage without lifting the finger', () => {
  const h = outro();
  function touch(type, y) {
    const event = new h.window.Event(type, { cancelable: true });
    event.touches = y === null ? [] : [{ clientY: y }];
    h.window.dispatchEvent(event); h.paint(); return event;
  }
  touch('touchstart', 600);
  touch('touchmove', 595);
  assert.equal(h.window.document.documentElement.classList.contains('intro-scrubbing'), false);
  assert.ok(touch('touchmove', 400).defaultPrevented);
  assert.equal(h.window.document.documentElement.style.getPropertyValue('--intro-rise'), h.window.innerHeight - 200 + 'px');
  touch('touchmove', -600);
  assert.equal(h.window.document.documentElement.classList.contains('intro-lock'), false);
  const before = h.pageScroll;
  assert.ok(touch('touchmove', -700).defaultPrevented);
  assert.equal(h.pageScroll, before + 100, 'remaining finger motion scrolls the page immediately');
  touch('touchend', null);
  assert.equal(touch('touchmove', -800).defaultPrevented, false, 'touch listeners are removed after release');
  assert.equal(h.timers.length, 0);
  h.window.close();
});
