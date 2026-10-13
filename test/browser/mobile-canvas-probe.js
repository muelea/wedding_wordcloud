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
      check('routine draft, cart and gesture messages are absent on mobile',
        !document.getElementById('mobile-canvas-hint') &&
        !document.getElementById('draft-save-state') &&
        !document.getElementById('cart-save-state'));
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
      check('repeated adjustment taps disable browser double-tap zoom without disabling browser pinch',
        getComputedStyle(document.getElementById('editor-larger')).touchAction === 'manipulation' &&
        !document.querySelector('meta[name="viewport"]').content.includes('user-scalable=no'));
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
      mugEditor.setDesign([word], { resetHistory: true });
      const beforeZoom = JSON.stringify(mugEditor.getDesign());
      mugEditor.setZoom(6); await frames();
      check('600% zoom redraws Fabric at the visible display scale with retina enabled',
        mugEditor.canvas.enableRetinaScaling && mugEditor.canvas.getZoom() > 1 &&
        Math.abs(mugEditor.canvas.width - mugEditor.scroll.clientWidth) < 25 &&
        mugEditor.canvas.lowerCanvasEl.width >= mugEditor.canvas.width &&
        mugEditor.canvas.width * mugEditor.canvas.height < 1_000_000 &&
        JSON.stringify(mugEditor.getDesign()) === beforeZoom && mugEditor.history.length === 1);
      mugEditor.setZoom(1); await frames();
      const multiDesign = [word, { ...word, id: 'multi-emoji', text: '❤️', x: mugEditor.width * .7 },
        { id: 'multi-image', type: 'image', src, x: mugEditor.width * .3, y: word.y, width: 180, height: 180, angle: 0 }];
      mugEditor.setDesign(multiDesign, { resetHistory: true }); await frames();
      mobile.chooseTool('more'); await frames();
      const more = document.getElementById('mobile-canvas-drawer').getBoundingClientRect();
      check('More sizes to its buttons and exposes multi-select', more.width < 300 &&
        Boolean(document.getElementById('mobile-canvas-multi-select')));
      document.getElementById('mobile-canvas-multi-select').click(); await frames();
      check('multi-select opens the canvas with Done and no overlay', mugEditor.mobileMultiSelect &&
        document.getElementById('mobile-canvas-drawer').hidden && !document.getElementById('mobile-canvas-multi-done').hidden);
      const multiBox = shell.getBoundingClientRect();
      const memberPoint = ratio => ({ x: multiBox.left + multiBox.width * ratio, y: multiBox.top + multiBox.height / 2 });
      const groupOriginal = JSON.stringify(mugEditor.getDesign());
      for (const ratio of [.5, .7, .3]) tap(memberPoint(ratio));
      check('word, emoji and image are selected individually', mugEditor.selectedObjects().length === 3);
      tap(memberPoint(.7));
      check('tapping a selected child removes only that member', mugEditor.selectedObjects().length === 2 &&
        !mugEditor.selectedObjects().some(object => object.editorId === 'multi-emoji'));
      tap(memberPoint(.7));
      check('selection alone preserves the design and Undo history', JSON.stringify(mugEditor.getDesign()) === groupOriginal && mugEditor.history.length === 1);
      document.getElementById('mobile-canvas-multi-done').click(); await frames();
      const groupOff = memberPoint(.1);
      send('pointerdown', 1, groupOff);
      send('pointermove', 1, { x: groupOff.x + 8, y: groupOff.y });
      send('pointerdown', 2, { x: groupOff.x + 108, y: groupOff.y });
      send('pointermove', 2, { x: groupOff.x + 8, y: groupOff.y + 50 });
      send('pointerup', 2, groupOff); send('pointerup', 1, groupOff);
      check('Done locks the temporary group for background move, scale and rotation', !mugEditor.mobileMultiSelect &&
        mugEditor.selectedObjects().length === 3 && mugEditor.getDesign().every(item => item.angle === 90) && mugEditor.history.length === 2);
      mugEditor.undo();
      check('group Undo restores every member and keeps the selection', JSON.stringify(mugEditor.getDesign()) === groupOriginal && mugEditor.selectedObjects().length === 3);
      mugEditor.redo();
      check('group Redo restores every member transform', mugEditor.getDesign().every(item => item.angle === 90));
      document.getElementById('mobile-canvas-deselect').click();
      check('Deselect clears the whole temporary group', !mugEditor.canvas.getActiveObject());
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
      check('all selected-state top controls fit within the viewport',
        [...document.querySelectorAll('.mobile-canvas-header button')].filter(button => button.getClientRects().length).every(button => {
          const rect = button.getBoundingClientRect(); return rect.left >= 0 && rect.right <= innerWidth;
        }));
      const beforeLocked = mugEditor.getDesign();
      send('pointerdown', 1, second); send('pointermove', 1, { x: second.x - 12, y: second.y }); send('pointerup', 1, second);
      check('dragging on another word moves only the locked element', mugEditor.getDesign()[0].x < beforeLocked[0].x &&
        JSON.stringify(mugEditor.getDesign()[1]) === JSON.stringify(beforeLocked[1]));
      const movedPoint = { x: first.x - 12, y: first.y };
      tap(movedPoint);
      await new Promise(resolve => setTimeout(resolve, 320));
      check('tapping the active word deselects it', !mugEditor.canvas.getActiveObject());
      tap(second);
      check('another word can be selected after unlocking', mugEditor.canvas.getActiveObject()?.editorId === 'other');
      document.getElementById('mobile-canvas-deselect').click();
      check('explicit Deselect releases the lock without editing', !mugEditor.canvas.getActiveObject());
      check('Deselect lives in the header and no selected-name overlay covers the canvas',
        document.getElementById('mobile-canvas-deselect').closest('.mobile-canvas-header') &&
        !document.getElementById('mobile-canvas-selected-name'));
      mugEditor.setDesign([word], { resetHistory: true });
      await frames();
      tap(first); tap(first);
      check('double tap opens a dedicated text field while retaining the lock', mobile.keyboardSession &&
        document.activeElement.id === 'mobile-canvas-text' && mugEditor.canvas.getActiveObject()?.editorId === word.id &&
        getComputedStyle(document.querySelector('.mobile-canvas-header')).display === 'none');
      const textRect = document.getElementById('mobile-canvas-text').getBoundingClientRect();
      check('text entry and Done remain visible in the available viewport', textRect.top >= (visualViewport?.offsetTop || 0) &&
        textRect.bottom <= (visualViewport?.offsetTop || 0) + (visualViewport?.height || innerHeight) &&
        document.getElementById('mobile-canvas-text-done').getBoundingClientRect().right <= innerWidth);
      document.getElementById('mobile-canvas-text').value = 'Changed word';
      document.getElementById('mobile-canvas-text-editor').requestSubmit();
      await frames();
      check('Done saves the text in one Undo step and restores the canvas', !mobile.keyboardSession &&
        mugEditor.getDesign()[0].text === 'Changed word' && mugEditor.history.length === 2 &&
        mugEditor.canvas.getActiveObject()?.editorId === word.id);
      mugEditor.undo();
      check('text editing Undo restores the original word and lock', mugEditor.getDesign()[0].text === word.text &&
        mugEditor.canvas.getActiveObject()?.editorId === word.id);
      mobile.chooseTool('properties'); await frames();
      const row = document.querySelector('#mobile-canvas-properties .editor-selection-row').getBoundingClientRect();
      const actions = document.querySelector('#mobile-canvas-properties .editor-actions').getBoundingClientRect();
      check('Adjust has no desktop-sized blank gap before transforms', actions.top - row.bottom >= 0 && actions.top - row.bottom <= 12);
      document.getElementById('editor-text').click(); await frames();
      check('Adjust text field uses the same dedicated editing state', mobile.keyboardSession && document.activeElement.id === 'mobile-canvas-text');
      document.getElementById('mobile-canvas-text').value = 'Discard this';
      document.getElementById('mobile-canvas-text-cancel').click(); await frames();
      check('Cancel leaves text, print design and history unchanged', mugEditor.getDesign()[0].text === word.text && mugEditor.historyIndex === 0);
      const viewportDescriptor = Object.getOwnPropertyDescriptor(window, 'visualViewport');
      const keyboardViewport = { width: innerWidth, height: 72, offsetTop: 0, offsetLeft: 0 };
      const enterKeyboard = async () => {
        Object.defineProperty(window, 'visualViewport', { configurable: true, value: keyboardViewport });
        mobile.syncViewport(); await frames();
      };
      const leaveKeyboard = async () => {
        if (viewportDescriptor) Object.defineProperty(window, 'visualViewport', viewportDescriptor);
        else { delete window.visualViewport; }
        mobile.syncViewport(); await frames();
      };
      const entryVisible = () => ['mobile-canvas-text', 'mobile-canvas-text-cancel', 'mobile-canvas-text-done'].every(id => {
        const rect = document.getElementById(id).getBoundingClientRect();
        return rect.top >= keyboardViewport.offsetTop && rect.bottom <= keyboardViewport.offsetTop + keyboardViewport.height &&
          rect.left >= 0 && rect.right <= innerWidth;
      });
      for (const [kind, id, value] of [['rotation', 'editor-angle', '24,5'], ['font-size', 'editor-font-size', '42,5']]) {
        mugEditor.setDesign([word], { resetHistory: true });
        mugEditor.canvas.setActiveObject(mugEditor.canvas.getObjects()[0]);
        mugEditor.updateSelectionPanel();
        mobile.chooseTool('properties');
        const initialDesign = JSON.stringify(mugEditor.getDesign()), historyLength = mugEditor.history.length;
        document.getElementById(id).focus(); await enterKeyboard();
        check(`${kind}: focus opens the shared decimal field with visible actions above a 72px keyboard viewport`,
          mobile.keyboardSession?.kind === kind && document.activeElement.id === 'mobile-canvas-text' && entryVisible() &&
          getComputedStyle(document.querySelector('.mobile-canvas-header')).display === 'none' && document.getElementById(id).readOnly);
        document.getElementById('mobile-canvas-text').value = value;
        keyboardViewport.offsetTop = 35; keyboardViewport.height = 64; mobile.syncViewport(); await frames();
        check(`${kind}: keyboard scroll/resize retains the draft and visible controls`, entryVisible() && document.activeElement.value === value);
        document.getElementById('mobile-canvas-text-cancel').click(); await leaveKeyboard();
        check(`${kind}: Cancel retains artwork, history and the Adjust panel`, !mobile.keyboardSession && mobile.tool === 'properties' &&
          JSON.stringify(mugEditor.getDesign()) === initialDesign && mugEditor.history.length === historyLength);
        keyboardViewport.offsetTop = 0; keyboardViewport.height = 72;
        document.getElementById(id).focus(); await enterKeyboard();
        document.getElementById('mobile-canvas-text').value = value;
        document.getElementById('mobile-canvas-text-editor').requestSubmit(); await leaveKeyboard();
        check(`${kind}: Done changes only the intended property with one Undo step`, !mobile.keyboardSession && mobile.tool === 'properties' &&
          mugEditor.history.length === historyLength + 1 && (kind === 'rotation' ? mugEditor.getDesign()[0].angle === 24.5 :
            mugEditor.displayPointSize(mugEditor.objectPointSize(mugEditor.canvas.getActiveObject())) === '42.5'));
        mugEditor.undo();
        check(`${kind}: Undo restores the exact original design`, JSON.stringify(mugEditor.getDesign()) === initialDesign);
        mugEditor.redo(); mugEditor.undo();
      }
      // Numeric commits leave their redo entries; keep the remaining probe independent.
      mugEditor.setDesign([word], { resetHistory: true });
      mugEditor.canvas.setActiveObject(mugEditor.canvas.getObjects()[0]); mugEditor.updateSelectionPanel();
      for (const [kind, id, value] of [['rotation', 'editor-angle', 'Infinity'], ['font-size', 'editor-font-size', '99999']]) {
        mobile.chooseTool('properties');
        const design = JSON.stringify(mugEditor.getDesign()), history = mugEditor.history.length;
        document.getElementById(id).focus(); await enterKeyboard();
        document.getElementById('mobile-canvas-text').value = value;
        document.getElementById('mobile-canvas-text-editor').requestSubmit(); await frames();
        check(`${kind}: invalid values keep the field, its error and actions visible without editing artwork`, mobile.keyboardSession?.kind === kind &&
          entryVisible() && !document.getElementById('mobile-canvas-entry-error').hidden &&
          JSON.stringify(mugEditor.getDesign()) === design && mugEditor.history.length === history);
        document.getElementById('mobile-canvas-text-cancel').click(); await leaveKeyboard();
      }
      mobile.chooseTool('add'); await frames();
      keyboardViewport.offsetTop = 0;
      keyboardViewport.height = innerWidth > innerHeight ? 72 : 240;
      check('Add contains Text, Emoji and Image without general design actions',
        document.querySelector('#mobile-canvas-add #editor-add') && document.querySelector('#mobile-canvas-add #editor-emoji-toggle') &&
        document.querySelector('#mobile-canvas-add #editor-image') && !document.querySelector('#mobile-canvas-add #editor-select-all') &&
        !document.querySelector('#mobile-canvas-add #editor-reset'));
      document.getElementById('editor-emoji-toggle').click();
      await Promise.all([configuratorEmojiPicker.loadCatalog(), configuratorEmojiPicker.loadSearchIndex()]); await frames();
      check('Emoji opens the full searchable catalog without forcing the keyboard', mobile.tool === 'emoji' &&
        !configuratorEmojiPicker.panel.hidden && configuratorEmojiPicker.panel.closest('#mobile-canvas-emoji') &&
        document.activeElement !== configuratorEmojiPicker.searchInput && configuratorEmojiPicker.grid.querySelectorAll('button').length > 0);
      configuratorEmojiPicker.searchInput.focus(); await enterKeyboard();
      const beforeSearch = JSON.stringify(mugEditor.getDesign()), searchHistory = mugEditor.history.length;
      const originalEmojiQuery = configuratorEmojiPicker.searchInput.value;
      const emojiQuery = { de: 'herz', fr: 'cœur', it: 'cuore', es: 'corazón', tr: 'kalp' }[configuratorEmojiPicker.currentLocale()] || 'heart';
      document.getElementById('mobile-canvas-text').value = emojiQuery;
      document.getElementById('mobile-canvas-text').dispatchEvent(new Event('input', { bubbles: true }));
      await new Promise(resolve => setTimeout(resolve, 120)); await frames();
      check('emoji search keeps its real picker and results alongside the keyboard row', mobile.keyboardSession?.kind === 'emoji' && entryVisible() &&
        configuratorEmojiPicker.panel.parentElement.id === 'mobile-canvas-keyboard-results' && configuratorEmojiPicker.grid.querySelectorAll('button').length > 0);
      check('emoji search has a visible, scrollable results area', configuratorEmojiPicker.grid.getBoundingClientRect().height >= 40);
      if (innerWidth >= 621 && innerWidth > innerHeight) {
        const gridRect = configuratorEmojiPicker.grid.getBoundingClientRect();
        check('landscape emoji results have at least one usable row above the keyboard', gridRect.height >= 40 && gridRect.bottom <= 72);
      }
      document.getElementById('mobile-canvas-text-cancel').click(); await leaveKeyboard();
      check('emoji search Cancel restores the prior filter without changing artwork/history', configuratorEmojiPicker.searchInput.value === originalEmojiQuery &&
        configuratorEmojiPicker.panel.closest('#mobile-canvas-emoji') && JSON.stringify(mugEditor.getDesign()) === beforeSearch && mugEditor.history.length === searchHistory);
      configuratorEmojiPicker.searchInput.focus(); await enterKeyboard();
      document.getElementById('mobile-canvas-text').value = emojiQuery;
      document.getElementById('mobile-canvas-text').dispatchEvent(new Event('input', { bubbles: true }));
      document.getElementById('mobile-canvas-text-editor').requestSubmit(); await leaveKeyboard();
      await new Promise(resolve => setTimeout(resolve, 120)); await frames();
      check('emoji search Done retains the filter and dismisses the keyboard', !mobile.keyboardSession && configuratorEmojiPicker.searchInput.value === emojiQuery &&
        configuratorEmojiPicker.panel.closest('#mobile-canvas-emoji') && document.activeElement !== configuratorEmojiPicker.searchInput);
      configuratorEmojiPicker.searchInput.focus(); await enterKeyboard();
      configuratorEmojiPicker.grid.querySelector('button').click(); await frames(); await leaveKeyboard();
      check('choosing an emoji directly from keyboard results adds one element and returns to Edit', mobile.tool === 'move' &&
        !mobile.keyboardSession && configuratorEmojiPicker.panel.hidden && mugEditor.getDesign().length === 2 &&
        !document.querySelector('#mobile-canvas-keyboard-results .ww-emoji-picker'));
      mobile.chooseTool('more');
      check('More contains labeled design actions and Find element',
        document.querySelector('#mobile-canvas-more #editor-select-all') && document.querySelector('#mobile-canvas-more #editor-fit-area') &&
        document.querySelector('#mobile-canvas-more #editor-reset') && document.querySelector('#mobile-canvas-more [data-canvas-tool="elements"]'));
      check('More action labels do not overflow their buttons or panel',
        [...document.querySelectorAll('#mobile-canvas-design-actions button')].every(button => button.scrollWidth <= button.clientWidth + 1 &&
          button.getBoundingClientRect().right <= document.getElementById('mobile-canvas-drawer').getBoundingClientRect().right));
      document.querySelector('#mobile-canvas-more [data-canvas-tool="elements"]').click();
      check('Find element is reached from More with a working Back action', mobile.tool === 'elements' &&
        !document.getElementById('mobile-canvas-panel-back').hidden);
      const findSource = document.getElementById('mobile-canvas-search');
      const findInitial = JSON.stringify(mugEditor.getDesign()), findHistory = mugEditor.history.length;
      findSource.focus(); await enterKeyboard();
      document.getElementById('mobile-canvas-text').value = word.text;
      document.getElementById('mobile-canvas-text').dispatchEvent(new Event('input', { bubbles: true })); await frames();
      check('Find element keeps the shared query field and real filtered results visible', mobile.keyboardSession?.kind === 'elements' && entryVisible() &&
        document.querySelectorAll('#mobile-canvas-keyboard-results #mobile-canvas-element-list button').length === 1);
      const findButton = document.querySelector('#mobile-canvas-keyboard-results #mobile-canvas-element-list button').getBoundingClientRect();
      check('Find element results stay inside the available keyboard viewport', findButton.top >= 0 && findButton.bottom <= keyboardViewport.height);
      document.getElementById('mobile-canvas-text-cancel').click(); await leaveKeyboard();
      check('Find element Cancel restores the original query and nodes without editing', !findSource.value &&
        document.querySelector('#mobile-canvas-elements #mobile-canvas-element-list') && JSON.stringify(mugEditor.getDesign()) === findInitial && mugEditor.history.length === findHistory);
      findSource.focus(); await enterKeyboard();
      document.getElementById('mobile-canvas-text').value = word.text;
      document.getElementById('mobile-canvas-text').dispatchEvent(new Event('input', { bubbles: true }));
      document.getElementById('mobile-canvas-text-editor').requestSubmit(); await leaveKeyboard();
      check('Find element Done retains the filter and returns to its panel', !mobile.keyboardSession && mobile.tool === 'elements' &&
        findSource.value === word.text && document.querySelectorAll('#mobile-canvas-elements #mobile-canvas-element-list button').length === 1);
      mugEditor.clearSelection();
      findSource.focus(); await enterKeyboard();
      document.querySelector('#mobile-canvas-keyboard-results #mobile-canvas-element-list button').click(); await frames(); await leaveKeyboard();
      check('choosing a Find element keyboard result returns to Edit and locks the word without changing artwork', mobile.tool === 'move' &&
        !mobile.keyboardSession && mugEditor.canvas.getActiveObject()?.editorId === word.id &&
        document.querySelector('#mobile-canvas-elements #mobile-canvas-element-list') && JSON.stringify(mugEditor.getDesign()) === findInitial);
      mobile.chooseTool('elements');
      document.getElementById('mobile-canvas-panel-back').click();
      check('Find element Back returns to More', mobile.tool === 'more');
      document.getElementById('mobile-canvas-deselect').click();
      mobile.chooseTool('settings'); await frames();
      if (innerHeight >= 390) {
        const drawer = document.getElementById('mobile-canvas-drawer').getBoundingClientRect();
        check('simple product settings size to their content', drawer.height < document.querySelector('.mobile-canvas-body').clientHeight - 20);
      }
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
      document.querySelector('#theme-options input[value="custom"]').click(); await frames();
      const customRect = document.getElementById('custom-palette-panel').getBoundingClientRect();
      const paletteBody = document.querySelector('#theme-panel .config-panel-body').getBoundingClientRect();
      check('Custom colours opens Your colours immediately at the top', document.getElementById('theme-panel').dataset.mobileStep === 'custom' &&
        getComputedStyle(themeOptions).display === 'none' && Math.abs(customRect.top - paletteBody.top) < 2);
      check('colour remove buttons stay within their rows', [...customColorList.children].every(item => {
        const itemRect = item.getBoundingClientRect(), remove = item.querySelector('button').getBoundingClientRect();
        return remove.right <= itemRect.right && remove.left >= itemRect.left;
      }));
      document.getElementById('mobile-canvas-panel-back').click(); await frames();
      check('custom colours Back restores palette choices', document.getElementById('theme-panel').dataset.mobileStep === 'palettes' &&
        getComputedStyle(themeOptions).display !== 'none');
      workspace.close();
      document.getElementById('change-product').click(); await frames();
      check('product families replace settings without a stacked modal', productDialog.closest('#mobile-canvas-picker') &&
        !productDialog.matches(':modal') && !productOptions.hidden && variantPanel.hidden);
      check('product families are navigation rows with no nested boxes or family checkmarks', [...productOptions.children].every(option => {
        const card = option.querySelector('.product-choice');
        return option.getAttribute('role') === 'button' && !option.hasAttribute('aria-checked') &&
          parseFloat(getComputedStyle(card).borderTopWidth) === 0 && getComputedStyle(card.querySelector('.checkmark')).display === 'none';
      }));
      for (const family of productFamilies) {
        document.querySelector(`[data-family-key="${family.key}"]`).click(); await frames();
        const firstVariant = variantOptions.querySelector('.variant-option');
        check(`${family.key}: selecting a family shows its variants immediately`, productOptions.hidden && !variantPanel.hidden &&
          variantOptions.children.length === productsInFamily(family.key).length &&
          firstVariant.getBoundingClientRect().top >= document.querySelector('.product-dialog-body').getBoundingClientRect().top - 1 &&
          !productDialogDone.closest('[hidden]'));
        const variantBody = productDialog.querySelector('.product-dialog-body');
        const variantDrawer = document.getElementById('mobile-canvas-drawer').getBoundingClientRect();
        check(`${family.key}: confirmation remains inside the bounded panel`, productDialogDone.getBoundingClientRect().bottom <= variantDrawer.bottom + 1);
        variantBody.scrollTop = variantBody.scrollHeight; await frames();
        check(`${family.key}: the final variant can be reached by scrolling`, variantOptions.lastElementChild.getBoundingClientRect().bottom <= variantBody.getBoundingClientRect().bottom + 1);
        variantBody.scrollTop = 0; await frames();
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
      mobile.chooseTool('more');
      document.getElementById('editor-reset').click(); await frames();
      check('reset confirmation uses the compact panel', document.getElementById('editor-reset-panel').closest('#mobile-canvas-picker') &&
        !document.getElementById('editor-reset-panel').matches(':modal'));
      workspace.close(); await frames();
      check('cancelling a reset returns to More without resetting the design', mobile.tool === 'more' && mugEditor.getDesign().length === 2);
      mobile.chooseView('product'); await frames();
      if (mug3D) {
        const viewer = mugViewer.getBoundingClientRect();
        const rotation = mug3D.group.rotation.y;
        const previewSend = (type, x) => mugViewer.dispatchEvent(new PointerEvent(type, { pointerId: 75, pointerType: 'touch',
          isPrimary: true, clientX: x, clientY: viewer.top + 10, button: 0, bubbles: true, cancelable: true }));
        previewSend('pointerdown', viewer.left + 10); previewSend('pointermove', viewer.left + 70); previewSend('pointerup', viewer.left + 70);
        check('blank space in product preview rotates the real mug', mug3D.group.rotation.y > rotation && getComputedStyle(mugViewer).touchAction === 'none');
      }
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
      check('closing restores the original desktop bitmap and identity viewport', !mugEditor.canvas.enableRetinaScaling &&
        mugEditor.canvas.width === mugEditor.canvasWidth && mugEditor.canvas.height === mugEditor.canvasHeight &&
        JSON.stringify(mugEditor.canvas.viewportTransform) === '[1,0,0,1,0,0]' && !shell.style.getPropertyValue('--mobile-paint-width'));
      check('closing restores desktop numeric fields to ordinary editable inputs', !document.getElementById('editor-angle').readOnly &&
        !document.getElementById('editor-font-size').readOnly);
      mobile.open(run); await frames(); mobile.close(); await frames();
      check('repeated entry/exit keeps the same editor state', JSON.stringify(mugEditor.getDesign()) === beforeClose && !mobile.dialog.open);
    } catch (error) { check('unexpected exception', false, error.stack); }
    document.body.append(report);
    report.textContent = JSON.stringify({ passed: results.every(result => result.pass), results }, null, 2);
    run.disabled = false;
  });
})();

(function installSharpPreview() {
  const inspect = new URLSearchParams(location.search).get('inspect');
  const button = document.createElement('button');
  button.id = 'inspect-sharp-mobile-preview';
  button.type = 'button';
  button.textContent = inspect ? 'Inspect keyboard layout' : 'Inspect 600% word and emoji';
  button.style.cssText = 'position:fixed;right:8px;top:58px;z-index:1000;background:white;color:black;padding:8px';
  document.body.append(button);
  button.addEventListener('click', async () => {
    await WolkenworteEmoji.preloadTexts(['🍸']);
    workspace.mobileCanvas.open(button);
    mugEditor.setDesign([
      { id:'sharp-word', text:'Hi', x:mugEditor.width/2-100, y:mugEditor.height/2, fontSize:140, angle:0, color:'#2455f5', fontFamily:'classic' },
      { id:'sharp-emoji', text:'🍸', x:mugEditor.width/2+140, y:mugEditor.height/2, fontSize:140, angle:0, color:'#2455f5', fontFamily:'classic' },
    ], {resetHistory:true});
    if (inspect) {
      button.remove();
      document.getElementById('run-mobile-canvas-probe').remove();
      const mobile = workspace.mobileCanvas;
      if (inspect === 'rotation') {
        mugEditor.canvas.setActiveObject(mugEditor.canvas.getObjects()[0]);
        mugEditor.updateSelectionPanel();
        mobile.chooseTool('properties');
        mobile.openNumericEditor('rotation');
      } else {
        mobile.chooseTool('elements');
        mobile.openSearchEditor('elements', document.getElementById('mobile-canvas-search'));
      }
      const height = innerWidth > innerHeight ? 72 : 240;
      Object.defineProperty(window, 'visualViewport', { configurable: true,
        value: { width: innerWidth, height, offsetTop: 0, offsetLeft: 0 } });
      mobile.syncViewport();
      return;
    }
    workspace.mobileCanvas.chooseTool('view');
    mugEditor.setZoom(6);
  });
})();
