'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const template = fs.readFileSync(require.resolve('../views/configure.ejs'), 'utf8');

function pageFunction(name) {
  const start = template.search(new RegExp('    (?:async )?function ' + name + '\\('));
  assert.notEqual(start, -1, name);
  return template.slice(start, template.indexOf('\n    }', start) + '\n    }'.length);
}

function element(inert = false) {
  const classes = new Set(), attributes = new Map();
  return { inert, hidden: true, disabled: false, textContent: '', attributes,
    setAttribute: (key, value) => attributes.set(key, value),
    classList: {
      toggle: (name, enabled) => enabled ? classes.add(name) : classes.delete(name),
      remove: name => classes.delete(name),
      contains: name => classes.has(name),
    } };
}

function setup({ design = [{ text: 'Liebe', x: 10 }], unchanged = false, failure = null } = {}) {
  const frames = [], timers = new Map(), calls = [];
  let timerId = 0, paints = 0, current = design;
  const controls = [element(), element(true)];
  const editorScroll = element();
  const context = vm.createContext({
    fitAreaButton: element(), fitAreaFeedback: element(), fitAreaMessage: element(), editorScroll,
    fitAreaPending: false, orderActionPending: false, fitAreaInertStates: [], fitAreaFeedbackTimer: null,
    workspace: {},
    overlapWarnings: { showCapacity: () => calls.push('capacity-dialog') },
    requestAnimationFrame: callback => frames.push(callback),
    setTimeout: callback => { timers.set(++timerId, callback); return timerId; },
    clearTimeout: id => timers.delete(id),
    document: { querySelectorAll: () => [editorScroll, ...controls] },
    WolkenworteActions: { setBusy: (button, busy) => {
      button.disabled = busy; button.classList.toggle('ww-is-busy', busy);
    } },
    WolkenworteI18n: { setAttribute: (target, key, value) => target.setAttribute(key, value) },
    setText: (target, value) => { target.textContent = value; },
    updateCartActions: () => calls.push('cart'),
    finalizeCurrentText: async () => {
      calls.push('finalize');
      if (failure === 'text') throw new Error('text');
    },
    ensureDesignFonts: async () => {
      if (failure === 'font') throw new Error('font');
    },
    WolkenworteConfiguratorSession: { withTimeout: promise => promise },
    productView: () => ({ layoutGeometry: { 'fit-area': [{}] }, printFile: { dpi: 300 } }),
    TextPrintQuality: require('../public/js/text-print-quality'),
    selectedTheme: 'classic', getPalette: () => ({ colors: ['#000'] }),
    DesignFonts: { cssFamily: key => key },
    printLayoutJobs: () => ({ pack() {} }),
    DesignLayout: {
      applyLayoutActionAsync: async items => {
        assert.ok(paints >= 1, 'the busy state must paint before layout starts');
        assert.equal(context.fitAreaFeedback.hidden, false);
        assert.equal(context.fitAreaMessage.textContent, 'Design wird angeordnet…');
        assert.equal(editorScroll.inert, true);
        calls.push('layout');
        if (failure === 'layout') throw new Error('layout');
        if (failure === 'capacity') throw new Error('print_capacity');
        return unchanged ? items : items.map(item => ({ ...item, x: 20 }));
      },
      spreadDesignColors: items => items,
    },
    mugEditor: {
      touchController: { finish: () => calls.push('finish-gesture') },
      getDesign: () => current,
      setDesign: (items, options) => { calls.push(['setDesign', options]); current = items; },
      clearSelection: () => calls.push('clear-selection'),
    },
  });
  for (const name of ['syncFitAreaButton', 'showFitAreaFeedback', 'setFitAreaBusy',
    'paintFitAreaFeedback', 'fitCurrentDesignToArea']) vm.runInContext(pageFunction(name), context);
  return { context, calls, controls, timers, current: () => current,
    frame() { const callbacks = frames.splice(0); callbacks.forEach(callback => callback()); paints++; },
  };
}

test('fill acknowledges the click immediately and yields a paint before calculation', async () => {
  const fixture = setup(), { context, calls } = fixture;
  const result = context.fitCurrentDesignToArea();
  assert.equal(context.fitAreaPending, true);
  assert.equal(context.fitAreaButton.disabled, true);
  assert.equal(context.fitAreaButton.classList.contains('ww-is-busy'), true);
  assert.equal(context.fitAreaFeedback.hidden, false);
  assert.equal(context.fitAreaFeedback.classList.contains('is-pending'), true);
  assert.equal(context.fitAreaMessage.textContent, 'Design wird angeordnet…');
  assert.equal(context.editorScroll.attributes.get('aria-busy'), 'true');
  assert.ok(fixture.controls.every(control => control.inert));
  assert.equal(await context.fitCurrentDesignToArea(), false, 'a duplicate click cannot queue another fill');
  fixture.frame();
  await Promise.resolve();
  assert.ok(!calls.includes('finalize'), 'one rAF is too early to start the work');
  fixture.frame();
  assert.equal(await result, true);
  assert.equal(context.fitAreaPending, false);
  assert.equal(context.editorScroll.inert, false);
  assert.equal(context.editorScroll.attributes.get('aria-busy'), 'false');
  assert.deepEqual(fixture.controls.map(control => control.inert), [false, true], 'pre-existing locks survive');
  assert.equal(context.fitAreaButton.disabled, false);
  assert.equal(context.fitAreaButton.classList.contains('ww-is-busy'), false);
  assert.equal(context.fitAreaMessage.textContent, 'Fläche neu angeordnet');
  assert.equal(context.fitAreaFeedback.classList.contains('is-pending'), false);
  assert.equal(calls.filter(call => Array.isArray(call) && call[0] === 'setDesign').length, 1);
  assert.equal(calls.find(call => Array.isArray(call))[1].record, true, 'the result stays undoable');
  [...fixture.timers.values()].forEach(callback => callback());
  assert.equal(context.fitAreaFeedback.hidden, true);
});

test('an unchanged layout explains the result without adding an Undo step', async () => {
  const fixture = setup({ unchanged: true });
  const result = fixture.context.fitCurrentDesignToArea();
  fixture.frame(); fixture.frame();
  assert.equal(await result, true);
  assert.equal(fixture.context.fitAreaMessage.textContent, 'Keine bessere Anordnung gefunden.');
  assert.ok(!fixture.calls.some(call => Array.isArray(call)));
});

test('mobile Fill closes the tool drawer before presenting canvas feedback', async () => {
  const fixture = setup();
  const tools = [];
  fixture.context.workspace.mobileCanvas = { active: true, chooseTool: tool => tools.push(tool) };
  const result = fixture.context.fitCurrentDesignToArea();
  assert.deepEqual(tools, ['move']);
  assert.equal(fixture.context.fitAreaFeedback.hidden, false);
  fixture.frame(); fixture.frame();
  assert.equal(await result, true);
});

for (const failure of ['text', 'font', 'layout']) {
  test(`${failure} failure preserves the design and clears every busy lock for retry`, async () => {
    const fixture = setup({ failure }), original = fixture.current();
    const result = fixture.context.fitCurrentDesignToArea();
    fixture.frame(); fixture.frame();
    assert.equal(await result, false);
    assert.equal(fixture.current(), original);
    assert.equal(fixture.context.fitAreaPending, false);
    assert.equal(fixture.context.editorScroll.inert, false);
    assert.equal(fixture.context.fitAreaButton.disabled, false);
    assert.equal(fixture.context.fitAreaFeedback.hidden, false);
    assert.equal(fixture.context.fitAreaFeedback.classList.contains('is-pending'), false);
    assert.match(fixture.context.fitAreaMessage.textContent, /erneut/);
    assert.equal(fixture.timers.size, 0, 'an error stays visible until the next action');
  });
}

test('an empty design leaves no spinner and keeps Fill disabled', async () => {
  const fixture = setup({ design: [] });
  const result = fixture.context.fitCurrentDesignToArea();
  fixture.frame(); fixture.frame();
  assert.equal(await result, false);
  assert.equal(fixture.context.fitAreaFeedback.hidden, true);
  assert.equal(fixture.context.fitAreaPending, false);
  assert.equal(fixture.context.fitAreaButton.disabled, true);
  assert.ok(!fixture.calls.includes('layout'));
});

test('capacity failure keeps all artwork and Undo history intact and opens the design check after unlocking', async () => {
  const fixture = setup({ failure: 'capacity' }), original = fixture.current();
  const pending = fixture.context.fitCurrentDesignToArea();
  fixture.frame(); fixture.frame();
  assert.equal(await pending, false);
  assert.equal(fixture.current(), original);
  assert.ok(!fixture.calls.some(call => Array.isArray(call)));
  assert.equal(fixture.context.editorScroll.inert, false);
  assert.match(fixture.context.fitAreaMessage.textContent, /mindestens 10 pt/);
  fixture.frame();
  assert.ok(fixture.calls.includes('capacity-dialog'));
});
