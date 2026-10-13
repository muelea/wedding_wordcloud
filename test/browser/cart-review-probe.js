'use strict';
// Isolated local fixture: real editor, account dialog, review renderer and cart.
(function () {
  const run = document.createElement('button');
  run.id = 'run-cart-review-probe';
  run.textContent = 'Run design and cart checks';
  run.style.cssText = 'position:fixed;right:8px;top:76px;z-index:999;padding:10px;background:white;color:#400f26;border:1px solid #ccc;border-radius:8px';
  document.body.append(run);
  const frames = async () => { for (let i = 0; i < 3; i++) await new Promise(requestAnimationFrame); };
  const until = async test => {
    const start = performance.now();
    while (!test()) { if (performance.now() - start > 15000) throw new Error('Timed out waiting for UI'); await frames(); }
  };
  run.addEventListener('click', async () => {
    run.disabled = true;
    const results = [];
    const check = (name, pass, detail) => results.push({ name, pass: Boolean(pass), detail });
    const mobile = workspace.mobileCanvas;
    try {
      if (!workspaceReady) throw new Error('Wait for editor loading');
      const isMobile = WolkenworteDevice.isMobileDevice(navigator);
      if (!isMobile) {
        const heading = document.querySelector('.config-design-heading').getBoundingClientRect();
        const picker = changeProductButton.getBoundingClientRect();
        check('product selector is compact and inside the design heading', picker.height <= 52 && picker.top >= heading.top && picker.bottom <= heading.bottom);
        check('narrow desktop controls do not overflow', document.documentElement.scrollWidth <= innerWidth);
      }
      if (isMobile) mobile.open(run);
      await frames();
      const save = document.querySelector(isMobile ? '#mobile-canvas-save' : '.config-design-save [data-account-save]');
      check('save is visible in the active workspace', save.getClientRects().length && save.getBoundingClientRect().right <= innerWidth);
      const object = mugEditor.canvas.getObjects()[0];
      mugEditor.canvas.setActiveObject(object);
      mugEditor.setZoom(1.5);
      const artwork = JSON.stringify(mugEditor.getDesign()), history = JSON.stringify(mugEditor.history), zoom = mugEditor.zoom, side = activeSurface;
      save.click();
      await until(() => document.getElementById('account-save-dialog').open);
      check('opening save leaves canvas mode mounted', !isMobile || (mobile.active && mobile.dialog.open));
      document.querySelector('#account-save-dialog [data-account-dialog-close]').click();
      await frames();
      check('cancelling save preserves selection, zoom, print side and history', mugEditor.canvas.getActiveObject() === object && mugEditor.zoom === zoom && activeSurface === side && JSON.stringify(mugEditor.history) === history);
      save.click();
      await until(() => document.getElementById('account-save-dialog').open);
      document.querySelector('#account-save-dialog form').requestSubmit();
      await until(() => !document.getElementById('account-save-dialog').open);
      check('saving returns to the same artwork and workspace', (!isMobile || mobile.active) && JSON.stringify(mugEditor.getDesign()) === artwork && mugEditor.canvas.getActiveObject() === object && mugEditor.zoom === zoom && activeSurface === side);
      check('save feedback identifies the design library', [...document.querySelectorAll('[data-account-save-note]')].some(note => note.getClientRects().length && note.textContent.includes('your designs')));
      if (isMobile) mobile.close();
      await frames();
      // Reset only the isolated fixture cart before testing replacement.
      cart.write([]); editingOrderItemId = null; currentDesignNeedsSave = true;
      await saveCurrentDesign(saveDesignButton);
      const approvedId = editingOrderItemId;
      const edited = mugEditor.getDesign().map((item, index) => index ? item : { ...item, color: '#003355' });
      mugEditor.setDesign(edited, { record: true }); markDirty();
      await persistCurrentDraft(); await refreshCartDrafts();
      const choice = askShippingChoice('choose-update', [...cartDrafts.values()]);
      await until(() => shippingChoiceList.querySelectorAll('.cart-review-artwork img').length === 2);
      check('review shows both exact artwork versions', shippingChoiceList.querySelector('[data-version="before"] img').src !== shippingChoiceList.querySelector('[data-version="after"] img').src);
      check('current design has no redundant edit button or trailing divider', !shippingChoiceList.querySelector('.cart-review-item-heading button') && getComputedStyle(shippingChoiceList.lastElementChild).borderBottomWidth === '0px');
      check('review stays within the viewport', shippingChoiceDialog.getBoundingClientRect().left >= -1 && shippingChoiceDialog.getBoundingClientRect().right <= innerWidth + 1 && shippingChoiceDialog.getBoundingClientRect().bottom <= innerHeight + 1);
      shippingChoiceList.querySelector('.cart-review-enlarge').click();
      await until(() => document.getElementById('cart-comparison-dialog').open);
      check('enlargement opens without closing the review', shippingChoiceDialog.open);
      document.querySelector('[data-cart-comparison-close]').click();
      shippingChoiceDialog.close('cancel'); await choice;
      check('review and cancel leave the cart unchanged', cart.read().length === 1 && cart.read()[0].id === approvedId);
      await saveReviewedDesigns([...cartDrafts.values()]);
      check('updating replaces one item without a duplicate', cart.read().length === 1 && cart.read()[0].id !== approvedId);
      const saved = await fetch(`/api/events/${slug}/configurations/${cart.read()[0].id}/edit`).then(response => response.json());
      check('replacement snapshot contains the reviewed edit', saved.designs[activeSurface][0].color === '#003355');
    } catch (error) { check('probe completed', false, error.stack); }
    finally {
      if (mobile.active) mobile.close();
      for (const dialog of document.querySelectorAll('dialog[open]')) dialog.close();
      const report = document.createElement('pre');
      report.id = 'cart-review-probe-report';
      report.style.cssText = 'white-space:pre-wrap;background:white;color:black;padding:16px;font:13px monospace';
      report.textContent = JSON.stringify({ passed: results.every(result => result.pass), viewport: [innerWidth, innerHeight], results }, null, 2);
      document.body.append(report); report.scrollIntoView(); run.disabled = false;
    }
  });
})();
