'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { createFixture, instrument, omissions } = require('../scripts/check-landing-browser');

test('diagnosis accepts only known omissions and removes each feature independently', () => {
  assert.deepEqual(omissions('filters,video,unknown,<script>'), ['video', 'filters']);
  const html = '<html><head></head><body><div id="intro-overlay"><video></video></div>' +
    '<div id="intro-scroll-space"></div><script>document.getElementById(\'intro-overlay\');</script>' +
    '<script src="/js/landing-demo.js?v=1"></script><script src="/js/analytics.js?v=1" data-ga4-id="G-TEST"></script>' +
    '<form action="/start"></form></body></html>';
  const baseline = instrument(html, []);
  assert.match(baseline, /intro-overlay/);
  assert.match(baseline, /landing-demo\.js/);
  assert.doesNotMatch(baseline, /analytics\.js/);
  const video = instrument(html, ['video']);
  assert.doesNotMatch(video, /intro-overlay|intro-scroll-space/);
  assert.match(video, /landing-demo\.js/);
  const demo = instrument(html, ['demo']);
  assert.match(demo, /intro-overlay/);
  assert.doesNotMatch(demo, /landing-demo\.js/);
  assert.match(instrument(html, ['filters']), /backdrop-filter: none !important/);
});

test('real homepage and simulated form navigation remain local and never create an event', async t => {
  const server = createFixture().listen(0, '127.0.0.1');
  t.after(() => { server.close(); server.closeAllConnections(); });
  await new Promise(resolve => server.once('listening', resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  const baseline = await fetch(origin);
  assert.equal(baseline.status, 200);
  assert.match(baseline.headers.get('content-security-policy'), /connect-src 'self'/);
  assert.match(await baseline.text(), /id="start-dialog-form"/);
  const omitted = await (await fetch(origin + '/?omit=video,demo,filters')).text();
  assert.doesNotMatch(omitted, /id="intro-overlay"|function finishIntro\(|src="[^" ]*\/js\/landing-demo\.js/);
  assert.match(omitted, /data-omitted="video,demo,filters"/);
  assert.match(omitted, /action="\/start\?omit=video%2Cdemo%2Cfilters"/);
  const posted = await fetch(origin + '/start?omit=demo', { method: 'POST', redirect: 'manual',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: 'cloudName=private-test-name&organizerPin=9999' });
  assert.equal(posted.status, 303);
  assert.equal(posted.headers.get('location'), '/__submitted?omit=demo');
  const result = await (await fetch(origin + posted.headers.get('location'))).text();
  assert.match(result, /keine Wortwolke erstellt/);
  assert.doesNotMatch(result, /private-test-name|9999/);
  assert.equal((await fetch(origin + '/api/events', { method: 'POST' })).status, 404);
  assert.equal((await fetch(origin + '/.env')).status, 404);
});

test('breadcrumbs stay bounded across interactions and exclude names, PINs and error messages', async () => {
  const { JSDOM } = require('jsdom');
  const dom = new JSDOM('<button data-open-start-dialog>Start</button><form id="start-dialog-form"><input value="private-name-and-pin-9999"></form>',
    { url: 'http://localhost', runScripts: 'outside-only' });
  try {
    const { window } = dom;
    Object.defineProperty(window.document, 'currentScript', { value: { dataset: { omitted: 'demo' } } });
    window.eval(fs.readFileSync(require.resolve('./browser/landing-diagnostics-probe'), 'utf8'));
    await new Promise(resolve => window.document.addEventListener('DOMContentLoaded', resolve, { once: true }));
    for (let index = 0; index < 50; index++) window.document.querySelector('button').click();
    window.document.querySelector('form').dispatchEvent(new window.Event('submit', { bubbles: true }));
    window.dispatchEvent(new window.ErrorEvent('error', { message: 'private-error-message' }));
    const panel = window.document.getElementById('landing-diagnosis');
    const opened = new Promise(resolve => panel.addEventListener('toggle', resolve, { once: true }));
    panel.open = true;
    await opened;
    const result = panel.querySelector('textarea').value;
    const report = JSON.parse(result);
    assert.equal(report.entries.length, 40);
    assert.equal(report.entries.at(-2).event, 'start-form-submit');
    assert.equal(report.entries.at(-1).event, 'error');
    assert.doesNotMatch(result, /private-name|9999|private-error-message/);
    assert.equal(window.sessionStorage.length, 1);
  } finally { dom.window.close(); }
});
