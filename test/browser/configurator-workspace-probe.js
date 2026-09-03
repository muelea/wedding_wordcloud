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
      // Both presentations must operate on the exact same custom options.
      mugEditor.setDesign([word], { resetHistory: true });
      mugEditor.selectAll();
      await frames();
      const fontMenu = document.getElementById('editor-font-menu');
      const fontToggle = document.getElementById('editor-font-toggle');
      const fontOptions = [...fontMenu.querySelectorAll('[role="option"]')];
      const fontTrigger = workspace.media.matches
        ? workspace.toolButtons.find(button => button.dataset.editorTool === 'font') : fontToggle;
      const styleButtons = ['bold', 'italic', 'underline', 'linethrough']
        .map(name => document.getElementById(`editor-${name}`));
      for (const button of styleButtons) button.click();
      await frames();
      check('all four whole-word styles apply before changing fonts', Object.entries({
        fontWeight: 700, fontStyle: 'italic', underline: true, linethrough: true,
      }).every(([key, value]) => mugEditor.getDesign()[0][key] === value) &&
        styleButtons.every(button => button.getAttribute('aria-pressed') === 'true'));
      fontTrigger.scrollIntoView({ block: 'center' });
      await frames();
      const fontGeometry = geometry();
      const openFonts = () => { if (fontMenu.hidden) fontTrigger.click(); };
      check('font picker has exactly one custom option per catalog font',
        fontOptions.length === DesignFonts.FONTS.length && !document.querySelector('.editor-font-select'));
      for (const [index, font] of DesignFonts.FONTS.entries()) {
        await document.fonts.load(`20px ${font.cssFamily}`);
        openFonts();
        await frames();
        const option = fontOptions[index];
        check(`${font.key}: shared preview and description`, option.dataset.fontKey === font.key &&
          option.querySelector('.editor-font-option-name').textContent === WolkenworteI18n.t(font.label) &&
          option.querySelector('.editor-font-option-description').textContent === WolkenworteI18n.t(font.description));
        option.scrollIntoView({ block: 'nearest' });
        await frames();
        const r = option.getBoundingClientRect();
        check(`${font.key}: custom option is visible and reachable`, option.contains(document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2)));
        option.focus({ preventScroll: true });
        option.click();
        await frames();
        check(`${font.key}: custom option changes the design and selected state`, mugEditor.getDesign()[0].fontFamily === font.key &&
          mugEditor.getDesign()[0].fontWeight === 700 && mugEditor.getDesign()[0].fontStyle === 'italic' &&
          mugEditor.getDesign()[0].underline && mugEditor.getDesign()[0].linethrough &&
          option.getAttribute('aria-selected') === 'true' && fontMenu.querySelectorAll('[aria-selected="true"]').length === 1);
        check(`${font.key}: sheet remains open, dropdown closes`, workspace.media.matches
          ? workspace.toolPanel.open && !fontMenu.hidden && document.activeElement === option
          : fontMenu.hidden && document.activeElement === fontToggle);
        same(`${font.key}: font selection preserves workspace geometry`, fontGeometry);
      }
      workspace.close();
      mugEditor.undo();
      mugEditor.selectAll();
      check('font Undo restores the previous design font and picker state', mugEditor.getDesign()[0].fontFamily === 'caveat' &&
        fontOptions[3].getAttribute('aria-selected') === 'true');
      mugEditor.redo();
      mugEditor.selectAll();
      check('font Redo restores the final design font and picker state', mugEditor.getDesign()[0].fontFamily === 'baloo-2' &&
        fontOptions[4].getAttribute('aria-selected') === 'true');
      mugEditor.setDesign([word, { ...word, id: 'font-other', x: 1800, fontFamily: 'lora' },
        { id: 'font-image', type: 'image', src, x: 900, y: 525, width: 300, height: 300, angle: 0 }], { resetHistory: true });
      mugEditor.selectAll();
      const imageBeforeFont = JSON.stringify(mugEditor.getDesign().find(item => item.type === 'image'));
      check('mixed fonts have no misleading selected option', !fontMenu.querySelector('[aria-selected="true"]'));
      openFonts();
      fontOptions[2].click();
      await frames();
      check('mixed selection changes all text fonts without changing the image', mugEditor.getDesign().filter(item => item.type !== 'image').every(item => item.fontFamily === 'montserrat') &&
        JSON.stringify(mugEditor.getDesign().find(item => item.type === 'image')) === imageBeforeFont);
      mugEditor.setDesign([word, { ...word, id: 'style-emoji', text: '🎲', x: 1800,
        fontWeight: 700, fontStyle: 'italic', underline: true, linethrough: true }], { resetHistory: true });
      mugEditor.selectAll();
      document.getElementById('editor-bold').click();
      const [styledWord, plainEmoji] = mugEditor.getDesign();
      check('mixed word and emoji selection styles only meaningful text', styledWord.fontWeight === 700 &&
        plainEmoji.fontWeight === 400 && plainEmoji.fontStyle === 'normal' &&
        !plainEmoji.underline && !plainEmoji.linethrough);
      check('picker options are never cloned or regenerated by presentation changes',
        fontOptions.every((option, index) => fontMenu.children[index] === option));
      workspace.close();
      mugEditor.canvas.discardActiveObject();
      await frames();
      check('font controls disable without a text selection', fontToggle.disabled &&
        workspace.toolButtons.find(button => button.dataset.editorTool === 'font').disabled);

      // Confirmation must not mutate the active side until explicitly accepted.
      mugEditor.setDesign([word, { ...word, id: 'reset-emoji', text: '🎲', x: 1800 },
        { id: 'reset-image', type: 'image', src, x: 900, y: 525, width: 300, height: 300, angle: 15 }], { resetHistory: true });
      const beforeReset = JSON.stringify(mugEditor.getDesign());
      const paletteBeforeReset = selectedTheme;
      const otherSides = () => JSON.stringify([...surfaceStates].filter(([key]) => key !== activeSurface));
      const sidesBeforeReset = otherSides();
      const reset = document.getElementById('editor-reset');
      reset.scrollIntoView({ block: 'center' });
      reset.focus({ preventScroll: true });
      const resetGeometry = geometry();
      reset.click();
      await frames();
      check('reset opens a native confirmation without changing the design', workspace.resetPanel.matches(':modal') && JSON.stringify(mugEditor.getDesign()) === beforeReset);
      check('reset focuses the safe cancel action', document.activeElement === workspace.resetPanel.querySelector('[data-panel-initial-focus]'));
      same('reset confirmation preserves canvas geometry', resetGeometry);
      workspace.resetPanel.querySelector('[data-panel-close]').click();
      check('cancel preserves design and focus', JSON.stringify(mugEditor.getDesign()) === beforeReset && document.activeElement === reset);
      reset.click();
      workspace.resetPanel.dispatchEvent(new Event('cancel', { cancelable: true }));
      check('Escape cancellation cannot reset the design', !workspace.resetPanel.open && JSON.stringify(mugEditor.getDesign()) === beforeReset);
      reset.click();
      document.getElementById('editor-reset-confirm').click();
      document.getElementById('editor-reset-confirm').click();
      await frames();
      const automatic = JSON.stringify(mugEditor.getDesign());
      check('confirmed reset changes the design once', automatic !== beforeReset && mugEditor.historyIndex === 1 && mugEditor.history.length === 2);
      check('reset preserves palette and other print sides', selectedTheme === paletteBeforeReset && otherSides() === sidesBeforeReset);
      document.getElementById('editor-undo').click();
      check('one Undo restores words, emoji and uploaded images exactly', JSON.stringify(mugEditor.getDesign()) === beforeReset);
      document.getElementById('editor-redo').click();
      check('one Redo reapplies the reset', JSON.stringify(mugEditor.getDesign()) === automatic);
      const actions = [...document.querySelectorAll('[data-editor-tooltip]')].filter(button => button.getClientRects().length);
      for (const button of actions) {
        const rect = button.getBoundingClientRect();
        const minimum = button.classList.contains('editor-style-button') ? 24 : 44;
        check(`${button.id}: named action with touch target`, button.getAttribute('aria-label') &&
          (button.querySelector('svg[aria-hidden="true"] use') || button.classList.contains('editor-style-button')) &&
          rect.width >= minimum && rect.height >= minimum);
      }
      const primaryActions = actions.filter(button => button.closest('.editor-toolbar'));
      check('toolbar buttons do not overlap', primaryActions.every((button, index) => primaryActions.slice(index + 1).every(other => {
        const a = button.getBoundingClientRect(), b = other.getBoundingClientRect();
        return a.right <= b.left || b.right <= a.left || a.bottom <= b.top || b.bottom <= a.top;
      })));
      check('toolbar visual order follows keyboard order', primaryActions.every((button, index) => {
        if (index === 0) return true;
        const previous = primaryActions[index - 1].getBoundingClientRect(), current = button.getBoundingClientRect();
        return current.top >= previous.bottom || (Math.abs(current.top - previous.top) < 1 && current.left >= previous.right);
      }));
      const addWord = document.getElementById('editor-add');
      toolbar.show(addWord);
      const tooltipRect = toolbar.tooltip.getBoundingClientRect();
      check('tooltip uses translated accessible name and fits viewport', toolbar.tooltip.textContent === addWord.getAttribute('aria-label') &&
        tooltipRect.left >= 0 && tooltipRect.right <= innerWidth && tooltipRect.top >= 0 && tooltipRect.bottom <= innerHeight);
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
      check('Escape dismisses tooltip', toolbar.tooltip.hidden);
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
      const controls = ['editor-text', 'editor-font-toggle', 'editor-font-menu', 'editor-color', 'editor-smaller', 'editor-delete', 'editor-selection'];
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
