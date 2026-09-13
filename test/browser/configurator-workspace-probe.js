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
      if (innerWidth <= 620) {
        const studio = document.getElementById('config-studio');
        const toggle = document.getElementById('mobile-editor-toggle');
        const continueButton = document.getElementById('continue-order');
        check('phone starts in preview-first mode', studio.dataset.mobileEditorExpanded === 'false' &&
          toggle.getAttribute('aria-expanded') === 'false' &&
          !document.getElementById('design-toolbar').getClientRects().length &&
          !document.getElementById('workspace-tools').getClientRects().length &&
          !document.getElementById('editor-card').getClientRects().length);
        const purchaseRect = continueButton.getBoundingClientRect();
        check('phone purchase action is immediately visible', purchaseRect.top >= 0 &&
          purchaseRect.bottom <= innerHeight && purchaseRect.height >= 44);
        check('phone purchase action explicitly saves the design',
          document.getElementById('continue-order-label').textContent.includes('cart'));
        toggle.click();
        await frames();
        check('phone editor expands in place', studio.dataset.mobileEditorExpanded === 'true' &&
          toggle.getAttribute('aria-expanded') === 'true' &&
          document.getElementById('design-toolbar').getClientRects().length &&
          !document.getElementById('workspace-tools').getClientRects().length &&
          document.getElementById('editor-compact-toolbar').getClientRects().length &&
          document.querySelector('#editor-card > #editor-compact-toolbar > .editor-toolbar') &&
          document.getElementById('editor-card').getClientRects().length);
      }
      workspace.close();
      await document.fonts.ready;
      // Resizing intentionally animates the canvas fit. Start selection checks
      // after that transition, so a resize is not mistaken for a selection shift.
      await frames();
      await Promise.all(document.getElementById('editor-canvas-shell').getAnimations()
        .map(animation => animation.finished.catch(() => {})));
      const editorScroll = document.getElementById('editor-scroll');
      const printShell = document.getElementById('editor-canvas-shell');
      const baseFit = geometry();
      const editorCard = document.querySelector('.editor-card').getBoundingClientRect();
      const previewCard = document.querySelector('.preview-card').getBoundingClientRect();
      if (innerWidth <= 940) {
        const padding = editorScroll.clientHeight - printShell.getBoundingClientRect().height;
        check('stacked editor hugs the print area', padding >= 23 && padding <= 26, { padding });
        check('fresh mug initialization fills the available editor width',
          printShell.getBoundingClientRect().width >= editorScroll.clientWidth - 26);
      } else check('side-by-side cards retain equal heights', Math.abs(editorCard.height - previewCard.height) < 1);
      document.getElementById('editor-zoom-in').click();
      await frames();
      await Promise.all(printShell.getAnimations().map(animation => animation.finished.catch(() => {})));
      check('zoom enlarges the artwork inside a scrollable stage',
        geometry().width > baseFit.width * 1.2 && editorScroll.scrollWidth > editorScroll.clientWidth);
      document.getElementById('editor-zoom-out').click();
      await frames();
      await Promise.all(printShell.getAnimations().map(animation => animation.finished.catch(() => {})));
      same('returning to fit restores the original geometry', baseFit);
      const orderActions = document.querySelector('.order-actions').getBoundingClientRect();
      const another = document.getElementById('design-another').getBoundingClientRect();
      const save = document.getElementById('save-design').getBoundingClientRect();
      const shipping = document.getElementById('continue-order').getBoundingClientRect();
      if (innerWidth <= 620) {
        check('mobile design actions share the first row', Math.abs(another.top - save.top) < 1 && another.right < save.left);
        check('mobile shipping action spans the next full row', shipping.top >= Math.max(another.bottom, save.bottom) &&
          Math.abs(shipping.width - orderActions.width) < 1 && Math.abs(shipping.left - orderActions.left) < 1);
      }
      check('order action labels fit with comfortable tap targets',
        ['design-another', 'save-design', 'continue-order'].every(id => {
          const button = document.getElementById(id);
          return button.getBoundingClientRect().height >= 44 && button.scrollWidth <= button.clientWidth;
        }));
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
        const flags = {
          text: !document.getElementById('editor-text').disabled,
          font: !document.getElementById('editor-font-toggle').disabled,
          color: !document.getElementById('editor-color').disabled,
          transform: !document.getElementById('editor-smaller').disabled,
        };
        check(`${name}: correct tools`, flags.transform &&
          flags.text === ['word', 'emoji'].includes(name) && flags.font === (name !== 'image') && flags.color === (name !== 'image'), flags);
      }
      mugEditor.setDesign([word], { resetHistory: true });
      mugEditor.selectAll();
      await frames();
      const beforeButtonNudge = mugEditor.getDesign()[0];
      document.getElementById('editor-move-right').click();
      const afterButtonNudge = mugEditor.getDesign()[0];
      check('direction button nudges the selection precisely',
        Math.abs(afterButtonNudge.x - beforeButtonNudge.x - 8) < .1 &&
        Math.abs(afterButtonNudge.y - beforeButtonNudge.y) < .1);
      document.dispatchEvent(new KeyboardEvent('keydown', {
        key: 'ArrowDown', shiftKey: true, bubbles: true, cancelable: true,
      }));
      const afterKeyboardNudge = mugEditor.getDesign()[0];
      check('Shift plus an arrow key applies the larger nudge',
        Math.abs(afterKeyboardNudge.x - afterButtonNudge.x) < .1 &&
        Math.abs(afterKeyboardNudge.y - afterButtonNudge.y - 40) < .1);
      const textInput = document.getElementById('editor-text');
      textInput.focus({ preventScroll: true });
      textInput.dispatchEvent(new KeyboardEvent('keydown', {
        key: 'ArrowLeft', bubbles: true, cancelable: true,
      }));
      check('arrow keys keep their normal behavior inside editor fields',
        JSON.stringify(mugEditor.getDesign()[0]) === JSON.stringify(afterKeyboardNudge));
      textInput.blur();
      if (workspace.media.matches) {
        const inspector = document.getElementById('editor-compact-inspector');
        const sections = [...inspector.querySelectorAll('[data-editor-section]')];
        check('compact inspector shows every editor group directly',
          inspector.getClientRects().length && sections.length === 4 &&
          sections.every(section => section.getClientRects().length));
        check('compact inspector has no secondary editor dialog', !document.getElementById('editor-tool-panel'));
      }
      // Both presentations must operate on the exact same custom options.
      mugEditor.setDesign([word], { resetHistory: true });
      mugEditor.selectAll();
      await frames();
      const fontMenu = document.getElementById('editor-font-menu');
      const fontToggle = document.getElementById('editor-font-toggle');
      const fontOptions = [...fontMenu.querySelectorAll('[role="option"]')];
      const fontTrigger = fontToggle;
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
        check(`${font.key}: dropdown closes and focus returns`, fontMenu.hidden && document.activeElement === fontToggle);
        same(`${font.key}: font selection preserves workspace geometry`, fontGeometry);
      }
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
      mugEditor.canvas.discardActiveObject();
      await frames();
      check('direct controls disable without a selection', fontToggle.disabled &&
        document.getElementById('editor-text').disabled && document.getElementById('editor-color').disabled &&
        document.getElementById('editor-smaller').disabled);

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
      const selectionActions = actions.filter(button => button.closest('.editor-actions'));
      const selectionActionBox = document.querySelector('.editor-actions').getBoundingClientRect();
      check('selection action buttons stay inside their responsive row', selectionActions.every(button => {
        const rect = button.getBoundingClientRect();
        return rect.left >= selectionActionBox.left - 1 && rect.right <= selectionActionBox.right + 1 &&
          rect.top >= selectionActionBox.top - 1 && rect.bottom <= selectionActionBox.bottom + 1;
      }));
      check('selection action buttons never overlap', selectionActions.every((button, index) =>
        selectionActions.slice(index + 1).every(other => {
          const a = button.getBoundingClientRect(), b = other.getBoundingClientRect();
          return a.right <= b.left || b.right <= a.left || a.bottom <= b.top || b.bottom <= a.top;
        })));
      const actionRows = [];
      for (const button of selectionActions) {
        const rect = button.getBoundingClientRect();
        let row = actionRows.find(item => Math.abs(item.top - rect.top) < 1);
        if (!row) {
          row = { top: rect.top, left: rect.left };
          actionRows.push(row);
        } else row.left = Math.min(row.left, rect.left);
      }
      check('every selection action row is left-aligned', actionRows.every(row =>
        Math.abs(row.left - selectionActionBox.left) <= 7));
      const nudgeButtons = ['editor-move-up', 'editor-move-down', 'editor-move-left', 'editor-move-right']
        .map(id => document.getElementById(id).getBoundingClientRect());
      check('direction buttons always stay together', nudgeButtons.every(rect =>
        Math.abs(rect.top - nudgeButtons[0].top) < 1));
      if (innerWidth <= 940) {
        const smallerRect = document.getElementById('editor-smaller').getBoundingClientRect();
        check('compact direction controls lead their own left-aligned row',
          nudgeButtons[0].bottom <= smallerRect.top && Math.abs(nudgeButtons[0].left - selectionActionBox.left) < 1);
      }
      const addWord = document.getElementById('editor-add');
      toolbar.show(addWord);
      const tooltipRect = toolbar.tooltip.getBoundingClientRect();
      check('tooltip uses translated accessible name and fits viewport', toolbar.tooltip.textContent === addWord.getAttribute('aria-label') &&
        tooltipRect.left >= 0 && tooltipRect.right <= innerWidth && tooltipRect.top >= 0 && tooltipRect.bottom <= innerHeight);
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
      check('Escape dismisses tooltip', toolbar.tooltip.hidden);
      for (const name of ['theme']) {
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
      const controls = ['editor-text', 'editor-font-toggle', 'editor-font-menu', 'editor-color',
        'editor-move-up', 'editor-move-down', 'editor-move-left', 'editor-move-right',
        'editor-smaller', 'editor-delete', 'editor-selection'];
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
