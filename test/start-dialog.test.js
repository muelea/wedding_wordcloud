'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { parse } = require('parse5');
const { renderPage } = require('../src/pageRenderer');
const { SUPPORTED_LOCALES, translate } = require('../src/i18n');

function attribute(node, name) {
  return node.attrs?.find((entry) => entry.name === name)?.value;
}

function descendants(node) {
  return (node.childNodes || []).flatMap((child) => [child, ...descendants(child)]);
}

function formOwnerId(node) {
  const explicitOwner = attribute(node, 'form');
  if (explicitOwner !== undefined) return explicitOwner;
  for (let ancestor = node.parentNode; ancestor; ancestor = ancestor.parentNode) {
    if (ancestor.tagName === 'form') return attribute(ancestor, 'id');
  }
  return undefined;
}

async function renderLanding(locale, startDialog) {
  let html;
  await renderPage({ query: {}, headers: {}, originalUrl: '/' }, {
    status() {}, set() {}, vary() {}, send(value) { html = value; },
  }, 'landing', {
    eventLocale: locale,
    header: { variant: 'landing', id: 'site-header' },
    pageData: { startDialog },
  });
  return parse(html);
}

test('Create word cloud is the sole native submit action in every localized start dialog', async () => {
  for (const locale of SUPPORTED_LOCALES) {
    // Server validation can re-render the same form with an error. Its native
    // default action must remain correct in both the initial and retry states.
    for (const startDialog of [{}, {
      open: true, name: 'Sommerfest', error: 'Die beiden PINs stimmen nicht überein.',
    }]) {
      const nodes = descendants(await renderLanding(locale, startDialog));
      const form = nodes.find((node) => node.tagName === 'form' && attribute(node, 'id') === 'start-dialog-form');
      assert.ok(form);
      assert.equal(attribute(form, 'action'), '/start');
      assert.equal(attribute(form, 'method'), 'post');

      // HTML implicit submission uses the first associated submit button in
      // document order, including buttons outside the form with a form= owner.
      const submitters = nodes.filter((node) => node.tagName === 'button' &&
        (attribute(node, 'type') || 'submit') === 'submit' && formOwnerId(node) === 'start-dialog-form');
      assert.equal(submitters.length, 1, `${locale}: dialog-open buttons must not hijack Enter`);
      assert.ok(descendants(form).includes(submitters[0]));
      const label = descendants(submitters[0]).filter((node) => node.nodeName === '#text')
        .map((node) => node.value).join('');
      assert.ok(label.includes(translate('Wortwolke erstellen', locale)));

      const openers = nodes.filter((node) => attribute(node, 'data-open-start-dialog') !== undefined);
      assert.equal(openers.length, 5, 'includes header, mobile menu and all three page CTAs');
      for (const opener of openers) {
        assert.equal(attribute(opener, 'type'), 'button');
        assert.equal(formOwnerId(opener), undefined);
      }

      for (const name of ['cloudName', 'organizerPin', 'organizerPinConfirmation']) {
        const input = descendants(form).find((node) => attribute(node, 'name') === name);
        assert.ok(input);
        assert.equal(attribute(input, 'required'), '');
        if (name !== 'cloudName') {
          assert.equal(attribute(input, 'type'), 'tel');
          assert.equal(attribute(input, 'inputmode'), 'numeric');
          assert.equal(attribute(input, 'autocomplete'), 'off');
        }
      }
    }
  }
});
