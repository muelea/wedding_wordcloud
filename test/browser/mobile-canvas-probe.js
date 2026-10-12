'use strict';
// Isolated fixture only. Drive the real DOM Pointer Events path with repeatable
// two-contact sequences; physical-device browser gestures remain a separate QA.
(function () {
  const run = document.createElement('button');
  run.id = 'run-mobile-canvas-probe';
  run.type = 'button';
  run.textContent = 'Run mobile canvas checks';
  run.style.cssText = 'position:fixed;right:8px;top:8px;z-index:1000;padding:12px;background:white;color:black';
  document.body.append(run);
  const frames = async () => { for (let i = 0; i < 3; i++) await new Promise(requestAnimationFrame); };
  run.addEventListener('click', async () => {
    run.disabled = true;
    const results = [], check = (name, pass, detail) => results.push({ name, pass: Boolean(pass), detail });
    const report = document.createElement('pre');
    report.id = 'mobile-canvas-probe-report';
    report.style.cssText = 'position:fixed;inset:10px;z-index:20;overflow:auto;background:white;color:black;font:12px monospace;white-space:pre-wrap;padding:12px';
    try {
      if (!mugEditor || !workspaceReady) throw new Error('Wait for the editor');
      const mobile = workspace.mobileCanvas;
      mobile.open(run);
      await frames();
      check('native full-screen workspace fills the available viewport', mobile.dialog.open &&
        Math.abs(mobile.dialog.getBoundingClientRect().height - (visualViewport?.height || innerHeight)) < 2);
      check('history, zoom and fit share the top toolbar without a bottom row',
        document.getElementById('editor-undo').closest('.mobile-canvas-header') &&
        document.getElementById('editor-zoom-in').closest('.mobile-canvas-header') &&
        document.getElementById('mobile-canvas-fit').closest('.mobile-canvas-header') &&
        !document.querySelector('.mobile-canvas-footer'));
      const toolbar = document.querySelector('.mobile-canvas-header').getBoundingClientRect();
      check('toolbar stays inside the viewport', toolbar.left >= 0 && toolbar.right <= innerWidth + 1);
      const shell = document.getElementById('editor-canvas-shell');
      const lowerCanvas = document.getElementById('wrap-canvas');
      const send = (type, id, p) => mugEditor.scroll.dispatchEvent(new PointerEvent(type, {
        pointerId: id, pointerType: 'touch', clientX: p.x, clientY: p.y,
        button: 0, buttons: type === 'pointerup' ? 0 : 1, bubbles: true, cancelable: true,
      }));
      const tap = p => { send('pointerdown', 99, p); send('pointerup', 99, p); };
      await WolkenworteEmoji.preloadTexts(['❤️']);
      const image = document.createElement('canvas');
      image.width = image.height = 100;
      image.getContext('2d').fillRect(0, 0, 100, 100);
      const src = image.toDataURL();
      await mugEditor.loadImageSource(src);
      const word = { id: 'touch-word', text: 'Liebe', x: mugEditor.width / 2, y: mugEditor.height / 2,
        fontSize: 160, angle: 0, color: '#a40e4c', fontFamily: 'classic' };
      for (const [kind, design] of [
        ['word', word], ['emoji', { ...word, id: 'touch-emoji', text: '❤️' }],
        ['image', { id: 'touch-image', type: 'image', src, x: word.x, y: word.y, width: 180, height: 180, angle: 0 }],
      ]) {
        mugEditor.setZoom(1);
        mugEditor.setDesign([design], { resetHistory: true });
        await frames();
        const box = shell.getBoundingClientRect(), p = { x: box.left + box.width / 2, y: box.top + box.height / 2 };
        const original = mugEditor.getDesign()[0];
        send('pointerdown', 3, p); send('pointerdown', 4, { x: p.x + 50, y: p.y });
        send('pointermove', 4, { x: p.x + 100, y: p.y });
        send('pointerup', 4, p); send('pointerup', 3, p);
        check(`${kind}: an unselected pinch starting on the element zooms only the view`, mugEditor.zoom > 1.9 &&
          !mugEditor.canvas.getActiveObject() && mugEditor.history.length === 1 &&
          JSON.stringify(mugEditor.getDesign()[0]) === JSON.stringify(original));
        document.getElementById('mobile-canvas-fit').click();
        tap(p);
        check(`${kind}: explicit tap selects without editing or opening the keyboard`, mugEditor.canvas.getActiveObject()?.editorId === design.id &&
          mugEditor.history.length === 1 && document.activeElement?.id !== 'editor-text');
        const off = { x: box.left + box.width * .15, y: box.top + box.height * .2 };
        send('pointerdown', 1, off);
        send('pointermove', 1, { x: off.x + 12, y: off.y });
        const moved = mugEditor.getDesign()[0];
        check(`${kind}: one-finger dragging moves without resizing`, moved.x > original.x &&
          moved.angle === original.angle && (kind === 'image' ? moved.width === original.width : moved.fontSize === original.fontSize));
        const anchor = { x: off.x + 12, y: off.y };
        send('pointerdown', 2, { x: anchor.x + 50, y: anchor.y });
        check(`${kind}: adding the second finger does not jump`, JSON.stringify(mugEditor.getDesign()[0]) === JSON.stringify(moved));
        send('pointermove', 2, { x: anchor.x, y: anchor.y + 100 });
        send('pointerup', 2, { x: anchor.x, y: anchor.y + 100 });
        send('pointerup', 1, anchor);
        const transformed = mugEditor.getDesign()[0];
        check(`${kind}: two-finger pinch and twist transform the element`, transformed.angle === 90 &&
          (kind === 'image' ? transformed.width > moved.width * 1.9 : transformed.fontSize > moved.fontSize * 1.9));
        check(`${kind}: stationary contact retains its position`, Math.abs(transformed.x - moved.x) < 1 && Math.abs(transformed.y - moved.y) < 1);
        check(`${kind}: entire gesture produces one Undo step`, mugEditor.history.length === 2);
        mugEditor.undo();
        check(`${kind}: Undo restores the complete original design`, JSON.stringify(mugEditor.getDesign()[0]) === JSON.stringify(original));
        mugEditor.redo();
        check(`${kind}: Redo restores the transform`, mugEditor.getDesign()[0].angle === 90);
        check(`${kind}: Undo and Redo retain the selected element lock`, mugEditor.canvas.getActiveObject()?.editorId === design.id);
        const beforeView = JSON.stringify(mugEditor.getDesign());
        const history = mugEditor.history.length;
        mobile.chooseTool('view');
        send('pointerdown', 3, p); send('pointerdown', 4, { x: p.x + 50, y: p.y });
        send('pointermove', 4, { x: p.x + 100, y: p.y });
        send('pointerup', 4, p); send('pointerup', 3, p);
        check(`${kind}: view gestures zoom without editing design or history`, mugEditor.zoom > 1.9 &&
          JSON.stringify(mugEditor.getDesign()) === beforeView && mugEditor.history.length === history);
        mobile.chooseTool('move');
        const zoom = mugEditor.zoom;
        const pan = [mugEditor.mobilePanX, mugEditor.mobilePanY];
        mobile.chooseView('product'); await frames();
        check(`${kind}: product view uses the existing live preview`, document.querySelector('#mobile-canvas-product #product-stage') &&
          !document.getElementById('product-stage').hidden);
        mobile.chooseView('canvas'); await frames();
        check(`${kind}: canvas return preserves zoom and exact design`, mugEditor.zoom === zoom &&
          JSON.stringify(mugEditor.getDesign()) === beforeView && document.getElementById('wrap-canvas') === lowerCanvas &&
          mugEditor.mobilePanX === pan[0] && mugEditor.mobilePanY === pan[1]);
      }
      mobile.chooseTool('move');
      document.getElementById('mobile-canvas-fit').click();
      mugEditor.setDesign([word, { ...word, id: 'other', text: 'Glück', x: mugEditor.width * .75 }], { resetHistory: true });
      await frames();
      const box = shell.getBoundingClientRect();
      const first = { x: box.left + box.width * .5, y: box.top + box.height * .5 };
      const second = { x: box.left + box.width * .75, y: first.y };
      tap(first); tap(second);
      check('tapping another element cannot replace the lock', mugEditor.canvas.getActiveObject()?.editorId === word.id);
      const beforeLocked = mugEditor.getDesign();
      send('pointerdown', 1, second); send('pointermove', 1, { x: second.x - 12, y: second.y }); send('pointerup', 1, second);
      check('dragging on another word moves only the locked element', mugEditor.getDesign()[0].x < beforeLocked[0].x &&
        JSON.stringify(mugEditor.getDesign()[1]) === JSON.stringify(beforeLocked[1]));
      const movedPoint = { x: first.x - 12, y: first.y };
      tap(movedPoint);
      check('tapping the active word deselects it', !mugEditor.canvas.getActiveObject());
      tap(second);
      check('another word can be selected after unlocking', mugEditor.canvas.getActiveObject()?.editorId === 'other');
      document.getElementById('mobile-canvas-deselect').click();
      check('explicit Deselect releases the lock without editing', !mugEditor.canvas.getActiveObject());
      mobile.chooseTool('settings');
      check('product, palette and orientation selectors share the same fullscreen workspace',
        document.querySelector('#mobile-canvas-settings #change-product') &&
        document.querySelector('#mobile-canvas-settings #theme-step') &&
        document.querySelector('#mobile-canvas-settings #orientation-step'));
      document.querySelector('[data-panel-trigger="theme-panel"]').click();
      await frames();
      check('palette chooser replaces settings within the same panel', document.getElementById('theme-panel').open &&
        document.getElementById('theme-panel').closest('#mobile-canvas-picker') &&
        !document.getElementById('theme-panel').matches(':modal') && document.getElementById('mobile-canvas-settings').hidden);
      check('picker text matches the compact tool labels', parseFloat(getComputedStyle(document.querySelector('#theme-panel .option-card strong')).fontSize) ===
        parseFloat(getComputedStyle(document.querySelector('[data-canvas-tool="move"]')).fontSize));
      workspace.close();
      document.getElementById('change-product').click(); await frames();
      check('product families replace settings without a stacked modal', productDialog.closest('#mobile-canvas-picker') &&
        !productDialog.matches(':modal') && !productOptions.hidden && variantPanel.hidden);
      for (const family of productFamilies) {
        document.querySelector(`[data-family-key="${family.key}"]`).click(); await frames();
        const firstVariant = variantOptions.querySelector('.variant-option');
        check(`${family.key}: selecting a family shows its variants immediately`, productOptions.hidden && !variantPanel.hidden &&
          variantOptions.children.length === productsInFamily(family.key).length &&
          firstVariant.getBoundingClientRect().top >= document.querySelector('.product-dialog-body').getBoundingClientRect().top - 1 &&
          !productDialogDone.closest('[hidden]'));
        if (family.key === 'mugs' && innerWidth >= 621 && innerHeight >= 300 && innerWidth > innerHeight) {
          const body = document.querySelector('.product-dialog-body').getBoundingClientRect();
          check('all three mug sizes are visible together in landscape', [...variantOptions.children].every(option => {
            const rect = option.getBoundingClientRect();
            return rect.top >= body.top - 1 && rect.bottom <= body.bottom + 1;
          }));
        }
        document.getElementById('mobile-canvas-panel-back').click(); await frames();
      }
      document.getElementById('mobile-canvas-panel-back').click(); await frames();
      check('Back restores the original settings without changing product', !productDialog.open && !document.getElementById('mobile-canvas-settings').hidden &&
        !productDialog.closest('#mobile-canvas-dialog'));
      mobile.chooseTool('add');
      document.getElementById('editor-reset').click(); await frames();
      check('reset confirmation uses the compact panel', document.getElementById('editor-reset-panel').closest('#mobile-canvas-picker') &&
        !document.getElementById('editor-reset-panel').matches(':modal'));
      workspace.close(); await frames();
      check('cancelling a reset returns to Add without resetting the design', mobile.tool === 'add' && mugEditor.getDesign().length === 2);
      mobile.chooseView('product');
      mobile.chooseTool('settings');
      check('product settings are also reachable from the product preview', !document.getElementById('mobile-canvas-drawer').hidden);
      mobile.chooseView('canvas');
      const beforeFit = JSON.stringify(mugEditor.getDesign());
      document.getElementById('mobile-canvas-fit').click();
      check('fit action resets only the view', mugEditor.zoom === 1 && mugEditor.mobilePanX === 0 && mugEditor.mobilePanY === 0 &&
        JSON.stringify(mugEditor.getDesign()) === beforeFit);
      const beforeClose = JSON.stringify(mugEditor.getDesign());
      mobile.close(); await frames();
      check('closing restores the original single controls and canvas',
        document.querySelector('#editor-card #wrap-canvas') === lowerCanvas &&
        document.getElementById('product-stage').closest('.preview-card') &&
        document.querySelectorAll('#editor-text').length === 1 && document.querySelector('#design-toolbar .design-toolbar-controls') &&
        JSON.stringify(mugEditor.getDesign()) === beforeClose);
      mobile.open(run); await frames(); mobile.close(); await frames();
      check('repeated entry/exit keeps the same editor state', JSON.stringify(mugEditor.getDesign()) === beforeClose && !mobile.dialog.open);
    } catch (error) { check('unexpected exception', false, error.stack); }
    document.body.append(report);
    report.textContent = JSON.stringify({ passed: results.every(result => result.pass), results }, null, 2);
    run.disabled = false;
  });
})();
