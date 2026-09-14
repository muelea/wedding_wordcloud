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
        check(key + ': product switches without a routine dialog', product.key === key && !draftLossDialog.open);
        filled(key);
      }
      edit();
      const before = JSON.stringify(getAllSurfaceDesigns());
      await pick('all-over-basic-pillow-18in'); await frame();
      check('edited product autosaves and switches without a routine dialog',
        product.key === 'all-over-basic-pillow-18in' && !draftLossDialog.open);
      filled('new pillow');
      await pick('white-glossy-mug-duo-11oz'); await frame();
      check('returning to the mug restores its exact local draft', JSON.stringify(getAllSurfaceDesigns()) === before);
      await pick('all-over-basic-pillow-18in'); await frame();
      const front = JSON.stringify(getAllSurfaceDesigns().front);
      selectSurface('back'); edit();
      check('editing the back leaves the front unchanged', JSON.stringify(getAllSurfaceDesigns().front) === front);
      const pillowDraft = JSON.stringify(getAllSurfaceDesigns());
      await pick('matte-poster-30x40cm'); await frame();
      check('edits on the back autosave when changing product', product.key === 'matte-poster-30x40cm');
      const landscape = product.orientations.find(option => option.key === 'landscape');
      await activateOrientation(landscape); await frame();
      check('orientation switches directly', selectedOrientation === 'landscape' && !draftLossDialog.open);
      filled('landscape poster');
      edit();
      const landscapeDraft = JSON.stringify(getAllSurfaceDesigns());
      const portrait = product.orientations.find(option => option.key === 'portrait');
      await activateOrientation(portrait); await frame();
      check('edited orientation autosaves and switches directly', selectedOrientation === 'portrait' && !draftLossDialog.open);
      filled('portrait poster');
      await activateOrientation(landscape); await frame();
      check('returning to an orientation restores its exact local draft',
        JSON.stringify(getAllSurfaceDesigns()) === landscapeDraft);
      await pick('all-over-basic-pillow-18in'); await frame();
      check('multi-surface local drafts restore exactly', JSON.stringify(getAllSurfaceDesigns()) === pillowDraft);
    } catch (error) { results.push({ name: 'Probe failed', pass: false, message: error.message }); }
    finally {
      report.textContent = JSON.stringify({ passed: results.every(result => result.pass), results }, null, 2);
      run.disabled = false;
    }
  });
})();
