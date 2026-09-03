'use strict';

// Local fixture only: real controller, shared dialogs and Fabric serialization.
(function () {
  const run = document.createElement('button');
  run.type = 'button';
  run.textContent = 'Check automatic product layouts';
  run.style.cssText = 'position:fixed;right:16px;top:90px;z-index:1000;padding:12px;background:white;color:black';
  const report = document.createElement('pre');
  report.style.cssText = 'white-space:pre-wrap;padding:16px;background:white;color:black';
  report.id = 'area-layout-report';
  document.body.append(run, report);
  run.addEventListener('click', async () => {
    run.disabled = true;
    const results = [];
    const check = (name, pass) => results.push({ name, pass: Boolean(pass) });
    const frame = async () => { await new Promise(requestAnimationFrame); await new Promise(requestAnimationFrame); };
    const pick = key => {
      openProductDialog();
      selectDialogProduct(products.find(candidate => candidate.key === key));
      return confirmProductDialog();
    };
    const edit = () => {
      const design = mugEditor.getDesign();
      design[0] = { ...design[0], color: '#000000' };
      mugEditor.setDesign(design, { record: true });
      mugEditor.flushPendingChange();
    };
    const filled = name => {
      const designs = getAllSurfaceDesigns();
      const expected = JSON.stringify(mugEditor.getDesign());
      check(name + ': every surface contains every word', Object.values(designs).every(design => design.length === words.length));
      check(name + ': surfaces start with independent copies of the filled design',
        Object.values(designs).every(design => JSON.stringify(design) === expected));
      check(name + ': fresh design does not count as an edit', !currentDesignEdited && currentDesignNeedsSave);
    };
    try {
      if (!workspaceReady) throw new Error('Wait for the configurator.');
      check('layout chooser is removed', !document.getElementById('placement-step'));
      for (const key of ['spiral-notebook-dotted', 'white-glossy-mug-duo-11oz']) {
        await pick(key); await frame();
        check(key + ': untouched product switches without a dialog', product.key === key && !leaveDialog.open);
        filled(key);
      }
      edit();
      const before = JSON.stringify(getAllSurfaceDesigns());
      let pending = pick('all-over-basic-pillow-18in'); await frame();
      check('edited product uses the existing Save this design dialog', leaveDialog.open);
      leaveCancelButton.click(); await pending;
      check('cancel keeps the product and exact edited design', product.key === 'white-glossy-mug-duo-11oz' &&
        JSON.stringify(getAllSurfaceDesigns()) === before);
      pending = pick('all-over-basic-pillow-18in'); await frame();
      leaveDiscardButton.click(); await pending; await frame();
      filled('pillow after discard');
      const front = JSON.stringify(getAllSurfaceDesigns().front);
      selectSurface('back'); edit();
      check('editing the back leaves the front unchanged', JSON.stringify(getAllSurfaceDesigns().front) === front);
      pending = pick('matte-poster-30x40cm'); await frame();
      check('edits on the back are protected when changing product', leaveDialog.open);
      leaveDiscardButton.click(); await pending; await frame();
      const landscape = product.orientations.find(option => option.key === 'landscape');
      await activateOrientation(landscape); await frame();
      check('untouched orientation switches directly', selectedOrientation === 'landscape' && !leaveDialog.open);
      filled('landscape poster');
      edit();
      const portrait = product.orientations.find(option => option.key === 'portrait');
      pending = activateOrientation(portrait); await frame();
      check('edited orientation uses the same dialog', leaveDialog.open);
      leaveCancelButton.click(); await pending;
      check('cancel keeps the orientation', selectedOrientation === 'landscape');
      pending = activateOrientation(portrait); await frame();
      leaveDiscardButton.click(); await pending; await frame();
      check('discard switches orientation', selectedOrientation === 'portrait');
      filled('portrait poster');
    } catch (error) { results.push({ name: 'Probe failed', pass: false, message: error.message }); }
    finally {
      report.textContent = JSON.stringify({ passed: results.every(result => result.pass), results }, null, 2);
      run.disabled = false;
    }
  });
})();
