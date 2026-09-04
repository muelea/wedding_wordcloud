'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const Journey = require('../public/js/site-journey');
const landingTemplate = fs.readFileSync(path.join(__dirname, '../views/landing.ejs'), 'utf8');

test('Home gives the remembered journey a clear unboxed re-entry hierarchy', () => {
  assert.match(landingTemplate, /class="resume-kicker">Zuletzt geöffnet</);
  assert.match(landingTemplate, /class="resume-title" data-resume-title/);
  assert.match(landingTemplate, /resume-link resume-link-primary[^>]*data-resume-cloud/);
  assert.match(landingTemplate, /resume-link resume-link-secondary[^>]*data-resume-design/);
  assert.match(landingTemplate, /Warenkorb öffnen/);
  const resumeStyle = landingTemplate.match(/#resume-journey\s*\{([^}]*)\}/)?.[1] || '';
  assert.doesNotMatch(resumeStyle, /background|border|box-shadow/);
});
function storage() { const values = new Map(); return {
  getItem: key => values.get(key) || null, setItem: (key, value) => values.set(key, value), removeItem: key => values.delete(key),
}; }
test('the last opened event survives Home without conflating a new cloud or storing a PIN', () => {
  const local = storage();
  Journey.remember('-_AbCdEf0123456789xyZQ', 'Erste Wolke', true, local, 100);
  Journey.remember('-_AbCdEf0123456789xyZQ', 'Neuer Titel', undefined, local, 200);
  assert.equal(Journey.read(local, 200).hasDesign, true);
  Journey.remember('_-aBcDeF0123456789XYzQ', 'Zweite Wolke', undefined, local, 300);
  assert.equal(Journey.read(local, 300).slug, '_-aBcDeF0123456789XYzQ');
  assert.equal(Journey.read(local, 300).hasDesign, false);
  assert.deepEqual(Object.keys(Journey.read(local, 300)).sort(), ['expiresAt', 'hasDesign', 'slug', 'title']);
  assert.equal(Journey.read(local, 300 + Journey.TTL), null);
  Journey.remember('../invalid', 'Bad', true, local);
  assert.equal(Journey.read(local), null);
});
test('blocked browser storage never prevents the word cloud or configurator from loading', () => {
  const scope = { get localStorage() { throw new Error('blocked'); } };
  vm.runInNewContext(fs.readFileSync(require.resolve('../public/js/site-journey'), 'utf8'), scope);
  assert.doesNotThrow(() => scope.WolkenworteJourney.remember('-_AbCdEf0123456789xyZQ', 'Cloud', true));
  assert.equal(scope.WolkenworteJourney.recent(), null);
});

test('remembered event IDs require exactly 22 URL-safe characters', () => {
  for (const slug of ['a'.repeat(21), 'a'.repeat(23), '/'.repeat(22), ' '.repeat(22)]) {
    const local = storage();
    Journey.remember(slug, 'Invalid', false, local, 100);
    assert.equal(Journey.read(local, 100), null);
    local.setItem('wolkenworte-recent-event', JSON.stringify({ slug, expiresAt: 200 }));
    assert.equal(Journey.read(local, 100), null);
    assert.equal(local.getItem('wolkenworte-recent-event'), null);
  }
});

test('Home shows the cart link only for this tab and never points it at a fresh design', async () => {
  const local = storage(), session = storage();
  Journey.remember('-_AbCdEf0123456789xyZQ', 'Cloud', true, local);
  const cloudLink = { getAttribute() { return this.href; } }, designLink = {}, title = {};
  const card = { querySelector(selector) { return selector === '[data-resume-cloud]' ? cloudLink
    : selector === '[data-resume-design]' ? designLink : title; } };
  const scope = { localStorage: local, sessionStorage: session, AbortSignal };
  vm.runInNewContext(fs.readFileSync(require.resolve('../public/js/site-journey'), 'utf8'), scope);
  const mount = () => scope.WolkenworteJourney.mountHome({ getElementById: () => card }, async () => ({ status: 200 }));
  await mount();
  assert.equal(designLink.hidden, true);
  session.setItem('wolkenworte-order:-_AbCdEf0123456789xyZQ', JSON.stringify([{ id: 'a'.repeat(16) }]));
  await mount();
  assert.equal(designLink.hidden, false);
  assert.equal(designLink.href, '/e/-_AbCdEf0123456789xyZQ/configure?cart=1');
  assert.equal(cloudLink.href, '/e/-_AbCdEf0123456789xyZQ');
  assert.equal(title.textContent, 'Cloud');
});
