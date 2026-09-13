'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const template = fs.readFileSync(path.join(__dirname, '../views/display.ejs'), 'utf8');

function pageFunction(name) {
  const match = new RegExp('  (?:async )?function ' + name + '\\(').exec(template);
  assert.ok(match, name);
  const start = match.index;
  const bodyStart = template.indexOf('{', start);
  let depth = 0;
  for (let index = bodyStart; index < template.length; index += 1) {
    if (template[index] === '{') depth += 1;
    if (template[index] === '}') depth -= 1;
    if (depth === 0) return template.slice(start, index + 1);
  }
  assert.fail(`unterminated function ${name}`);
}

function createHarness() {
  const classes = new Set();
  const attributes = new Map();
  const document = {
    activeElement: null,
    fullscreenElement: null,
    webkitFullscreenElement: null,
    body: {
      classList: {
        contains(name) { return classes.has(name); },
        toggle(name, enabled) {
          if (enabled) classes.add(name);
          else classes.delete(name);
        },
      },
    },
  };
  document.documentElement = {};

  const context = vm.createContext({
    document,
    currentWords: [],
    displayWordInput: { blur() {} },
    presentationModeButton: {
      setAttribute(name, value) { attributes.set(name, value); },
    },
    closeDisplayMenu() {},
    scheduleRender() {},
  });
  const names = [
    'setPresentationMode',
    'fullscreenElement',
    'requestPresentationFullscreen',
    'exitPresentationFullscreen',
    'togglePresentationMode',
    'syncPresentationModeWithFullscreen',
  ];
  vm.runInContext(
    `${names.map(pageFunction).join('\n')}\nthis.presentationApi = { ${names.join(', ')} };`,
    context
  );

  return { api: context.presentationApi, attributes, classes, document };
}

test('presentation mode requests document fullscreen and exits it with the same toggle', async () => {
  const { api, attributes, classes, document } = createHarness();
  let requestOptions;
  let exitCalls = 0;
  document.documentElement.requestFullscreen = (options) => {
    requestOptions = options;
    document.fullscreenElement = document.documentElement;
    return Promise.resolve();
  };
  document.exitFullscreen = () => {
    exitCalls += 1;
    document.fullscreenElement = null;
    return Promise.resolve();
  };

  await api.togglePresentationMode();
  assert.equal(classes.has('presentation-mode'), true);
  assert.equal(attributes.get('aria-checked'), 'true');
  assert.equal(requestOptions.navigationUI, 'hide');

  await api.togglePresentationMode();
  assert.equal(classes.has('presentation-mode'), false);
  assert.equal(attributes.get('aria-checked'), 'false');
  assert.equal(exitCalls, 1);
});

test('presentation layout remains available when a browser denies fullscreen', async () => {
  const { api, attributes, classes, document } = createHarness();
  document.documentElement.requestFullscreen = () => Promise.reject(new Error('denied'));

  await api.togglePresentationMode();

  assert.equal(classes.has('presentation-mode'), true);
  assert.equal(attributes.get('aria-checked'), 'true');
});

test('leaving native fullscreen restores the normal page layout', () => {
  const { api, attributes, classes, document } = createHarness();
  api.setPresentationMode(true);
  document.fullscreenElement = document.documentElement;

  document.fullscreenElement = null;
  api.syncPresentationModeWithFullscreen();

  assert.equal(classes.has('presentation-mode'), false);
  assert.equal(attributes.get('aria-checked'), 'false');
});

test('presentation mode retains the WebKit fullscreen fallback', async () => {
  const { api, classes, document } = createHarness();
  let exitCalls = 0;
  document.documentElement.webkitRequestFullscreen = () => {
    document.webkitFullscreenElement = document.documentElement;
  };
  document.webkitExitFullscreen = () => {
    exitCalls += 1;
    document.webkitFullscreenElement = null;
  };

  await api.togglePresentationMode();
  assert.equal(classes.has('presentation-mode'), true);
  assert.equal(api.fullscreenElement(), document.documentElement);

  await api.togglePresentationMode();
  assert.equal(classes.has('presentation-mode'), false);
  assert.equal(exitCalls, 1);
});

test('presentation mode listens for native fullscreen exits', () => {
  assert.match(template, /presentationModeButton\.addEventListener\('click', togglePresentationMode\)/);
  assert.match(template, /document\.addEventListener\('fullscreenchange', syncPresentationModeWithFullscreen\)/);
  assert.match(template, /document\.addEventListener\('webkitfullscreenchange', syncPresentationModeWithFullscreen\)/);
});
