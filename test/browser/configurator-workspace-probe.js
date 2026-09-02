'use strict';

// Loaded only by scripts/check-configurator-browser.js with ?probe=1.
// Exercises the production DOM, CSS, controller and Fabric selection events.
(function installProbe() {
  const run = document.createElement('button');
  run.type = 'button';
  run.textContent = 'Run layout regression';
  run.id = 'run-workspace-probe';
  run.style.cssText = 'position:fixed;right:16px;top:90px;z-index:1000;padding:12px;border:1px solid #999;background:white;color:black;border-radius:8px';
  const report = document.createElement('pre');
  report.id = 'workspace-probe-report';
  report.style.cssText = 'white-space:pre-wrap;overflow-wrap:anywhere;padding:16px;background:white;color:black';
  document.body.append(run, report);
  const frames = async () => {
    for (let index = 0; index < 3; index++) await new Promise(requestAnimationFrame);
  };
  function geometry() {
    const canvas = document.getElementById('editor-canvas-shell').getBoundingClientRect();
    const dock = document.getElementById('editor-selection').getBoundingClientRect();
    return { top: canvas.top + scrollY, width: canvas.width, height: canvas.height,
      dockHeight: dock.height, zoom: document.getElementById('editor-zoom-label').textContent };
  }
  run.addEventListener('click', async () => {
    run.disabled = true;
    report.textContent = 'Running…';
    const results = [];
    const check = (name, condition, detail = null) => results.push({ name, pass: Boolean(condition), detail });
    const same = (name, expected) => {
      const actual = geometry();
      check(name, Object.keys(expected).every(key => typeof expected[key] === 'number'
        ? Math.abs(actual[key] - expected[key]) < 1 : actual[key] === expected[key]), { expected, actual });
    };
    try {
      if (typeof mugEditor === 'undefined' || !mugEditor) throw new Error('Wait for the configurator to load.');
      workspace.close();
      await document.fonts.ready;
      // Resizing intentionally animates the canvas fit. Start selection checks
      // after that transition, so a resize is not mistaken for a selection shift.
      await frames();
      await Promise.all(document.getElementById('editor-canvas-shell').getAnimations()
        .map(animation => animation.finished.catch(() => {})));
      await WolkenworteEmoji.preloadTexts(['🎲']);
      const image = document.createElement('canvas');
      image.width = 100; image.height = 100;
      image.getContext('2d').fillRect(0, 0, 100, 100);
      const src = image.toDataURL();
      await mugEditor.loadImageSource(src);
      const word = { id: 'probe-word', text: 'test', x: 1350, y: 525, fontSize: 180, angle: 0, color: '#a40e4c', fontFamily: 'classic' };
      const cases = [
        ['word', [word]],
        ['emoji', [{ ...word, id: 'probe-emoji', text: '🎲' }]],
        ['image', [{ id: 'probe-image', type: 'image', src, x: 1350, y: 525, width: 300, height: 300, angle: 0 }]],
        ['multiple', [word, { ...word, id: 'probe-second', text: 'together', x: 1800 }]],
      ];
      for (const [name, design] of cases) {
        mugEditor.setDesign(design, { resetHistory: true });
        await frames();
        const baseline = geometry();
        for (let iteration = 0; iteration < 3; iteration++) {
          mugEditor.selectAll();
          await frames();
          same(`${name}: selecting ${iteration + 1} preserves geometry`, baseline);
          mugEditor.canvas.discardActiveObject();
          mugEditor.canvas.requestRenderAll();
          await frames();
          same(`${name}: clearing ${iteration + 1} preserves geometry`, baseline);
        }
        mugEditor.selectAll();
        await frames();
        const flags = Object.fromEntries(workspace.toolButtons.map(button => [button.dataset.editorTool, !button.disabled]));
        check(`${name}: correct tools`, flags.transform &&
          flags.text === ['word', 'emoji'].includes(name) && flags.font === (name !== 'image') && flags.color === (name !== 'image'), flags);
      }
      mugEditor.setDesign([word], { resetHistory: true });
      mugEditor.selectAll();
      await frames();
      if (workspace.media.matches) {
        for (const tool of ['text', 'font', 'color', 'transform']) {
          const button = workspace.toolButtons.find(item => item.dataset.editorTool === tool);
          button.focus({ preventScroll: true });
          const baseline = geometry();
          const scrollBefore = scrollY;
          button.click();
          await frames();
          same(`${tool}: opening preserves geometry`, baseline);
          check(`${tool}: native modal and focus`, workspace.toolPanel.matches(':modal') && workspace.toolPanel.contains(document.activeElement));
          check(`${tool}: opening preserves page scroll`, Math.abs(scrollBefore - scrollY) < 1, { scrollBefore, after: scrollY });
          const section = document.querySelector(`[data-editor-section="${tool}"]`);
          check(`${tool}: one control set is inside sheet`, section.parentNode === workspace.toolBody);
          if (tool === 'text') {
            const input = section.querySelector('input');
            input.value = 'edited 🎲';
            input.dispatchEvent(new Event('input', { bubbles: true }));
            await frames();
          }
          workspace.toolPanel.querySelector('[data-panel-close]').click();
          await frames();
          same(`${tool}: closing preserves geometry`, baseline);
          check(`${tool}: focus returns`, document.activeElement === button);
          check(`${tool}: closing preserves page scroll`, Math.abs(scrollBefore - scrollY) < 1);
          if (tool === 'text') check('closing text editor commits undo history', !document.getElementById('editor-undo').disabled);
        }
        // A modal editor must not let canvas shortcuts act on the design.
        workspace.openTool('transform', workspace.toolButtons[3]);
        const count = mugEditor.getDesign().length;
        document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Delete', bubbles: true }));
        check('sheet shields canvas keyboard shortcuts', mugEditor.getDesign().length === count);
        document.getElementById('editor-duplicate').click();
        await frames();
        check('duplicate keeps the adjustment sheet open', workspace.toolPanel.open);
        document.getElementById('editor-delete').click();
        await frames();
        check('deleting selection closes the adjustment sheet', !workspace.toolPanel.open);
        mugEditor.setDesign([word], { resetHistory: true });
      }
      for (const name of ['theme', 'placement']) {
        const trigger = document.querySelector(`[data-panel-trigger="${name}-panel"]`);
        trigger.scrollIntoView({ block: 'center' });
        await frames();
        const before = geometry();
        const height = trigger.getBoundingClientRect().height;
        trigger.click();
        await frames();
        const panel = document.getElementById(`${name}-panel`);
        same(`${name}: opening preserves geometry`, before);
        check(`${name}: trigger height unchanged`, Math.abs(height - trigger.getBoundingClientRect().height) < 1);
        const rect = panel.getBoundingClientRect();
        check(`${name}: panel stays in viewport`, rect.left >= -1 && rect.right <= innerWidth + 1 && rect.top >= -1 && rect.bottom <= innerHeight + 1, rect.toJSON());
        for (const option of panel.querySelectorAll('.option')) {
          option.scrollIntoView({ block: 'nearest' });
          await frames();
          const r = option.getBoundingClientRect();
          const hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
          check(`${name}: ${option.textContent.trim().slice(0, 35)} is reachable`, option.contains(hit));
        }
        panel.querySelector('[data-panel-close]').click();
        await frames();
        same(`${name}: closing preserves geometry`, before);
        check(`${name}: focus returns to trigger`, document.activeElement === trigger);
      }
      check('no horizontal page overflow', document.documentElement.scrollWidth <= innerWidth);
      const controls = ['editor-text', 'editor-font', 'editor-color', 'editor-smaller', 'editor-delete', 'editor-selection'];
      check('editor controls remain unique after repeated reparenting',
        controls.every(id => document.querySelectorAll(`[id="${id}"]`).length === 1));
    } catch (error) {
      check('probe completed', false, error.message);
    } finally {
      workspace.close();
      const failures = results.filter(item => !item.pass);
      report.textContent = JSON.stringify({ width: innerWidth, height: innerHeight, browser: navigator.userAgent,
        passed: results.length - failures.length, failed: failures.length, failures }, null, 2);
      run.disabled = false;
    }
  });
})();
