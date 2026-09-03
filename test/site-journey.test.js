'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const Journey = require('../public/js/site-journey');
function storage() { const values = new Map(); return {
  getItem: key => values.get(key) || null, setItem: (key, value) => values.set(key, value), removeItem: key => values.delete(key),
}; }
test('the last opened event survives Home without conflating a new cloud or storing a PIN', () => {
  const local = storage();
  Journey.remember('first-cloud', 'Erste Wolke', true, local, 100);
  Journey.remember('first-cloud', 'Neuer Titel', undefined, local, 200);
  assert.equal(Journey.read(local, 200).hasDesign, true);
  Journey.remember('second-cloud', 'Zweite Wolke', undefined, local, 300);
  assert.equal(Journey.read(local, 300).slug, 'second-cloud');
  assert.equal(Journey.read(local, 300).hasDesign, false);
  assert.deepEqual(Object.keys(Journey.read(local, 300)).sort(), ['expiresAt', 'hasDesign', 'slug', 'title']);
  assert.equal(Journey.read(local, 300 + Journey.TTL), null);
  Journey.remember('../invalid', 'Bad', true, local);
  assert.equal(Journey.read(local), null);
});
test('blocked browser storage never prevents the word cloud or configurator from loading', () => {
  const scope = { get localStorage() { throw new Error('blocked'); } };
  vm.runInNewContext(fs.readFileSync(require.resolve('../public/js/site-journey'), 'utf8'), scope);
  assert.doesNotThrow(() => scope.WolkenworteJourney.remember('cloud', 'Cloud', true));
  assert.equal(scope.WolkenworteJourney.recent(), null);
});

test('Home shows the cart link only for this tab and never points it at a fresh design', async () => {
  const local = storage(), session = storage();
  Journey.remember('cloud', 'Cloud', true, local);
  const cloudLink = { getAttribute() { return this.href; } }, designLink = {}, title = {};
  const card = { querySelector(selector) { return selector === '[data-resume-cloud]' ? cloudLink
    : selector === '[data-resume-design]' ? designLink : title; } };
  const scope = { localStorage: local, sessionStorage: session, AbortSignal };
  vm.runInNewContext(fs.readFileSync(require.resolve('../public/js/site-journey'), 'utf8'), scope);
  const mount = () => scope.WolkenworteJourney.mountHome({ getElementById: () => card }, async () => ({ status: 200 }));
  await mount();
  assert.equal(designLink.hidden, true);
  session.setItem('wolkenworte-order:cloud', JSON.stringify([{ id: 'a'.repeat(16) }]));
  await mount();
  assert.equal(designLink.hidden, false);
  assert.equal(designLink.href, '/e/cloud/configure?cart=1');
  assert.equal(cloudLink.href, '/e/cloud');
  assert.equal(title.textContent, 'Cloud');
});
