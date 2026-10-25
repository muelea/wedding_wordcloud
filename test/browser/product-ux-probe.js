'use strict';

// Only served by the database-free fixture. All approved items are in-memory
// fixtures; this never contacts a payment or fulfillment provider.
(function () {
  const controls = document.createElement('div');
  controls.style.cssText = 'position:fixed;right:12px;bottom:12px;z-index:10000;display:flex;flex-wrap:wrap;justify-content:flex-end;max-width:calc(100vw - 24px);gap:8px';
  const button = text => {
    const element = document.createElement('button'); element.type = 'button'; element.textContent = text;
    element.style.cssText = 'padding:10px;background:white;color:black;border:1px solid #aaa;border-radius:8px';
    controls.append(element); return element;
  };
  const run = button('Check product UX');
  const reset = button('Reset UX fixture');
  const variants = button('Show variant picker');
  const preview = button('Show mouse-pad editor');
  const rotationScroll = button('Check mug rotation and scrolling');
  const captureRotation = button('Capture white mug rotation');
  const productRotation = button('Check non-mug rotation');
  const colored444 = button('Check 444 ml colored mugs');
  const wrapMargins = button('Check full-wrap margins');
  const report = document.createElement('pre'); report.id = 'product-ux-report';
  report.style.cssText = 'white-space:pre-wrap;background:white;color:black;padding:16px';
  document.body.append(controls, report);
  const frame = async () => { await new Promise(requestAnimationFrame); await new Promise(requestAnimationFrame); };
  const find = key => productGallery.cards.find(card => card.variants.some(product => product.key === key));
  reset.addEventListener('click', async () => {
    clearTimeout(draftSaveTimer);
    if (draftSavePromise) await draftSavePromise;
    await draftStore.clearActive(); cart.write([]); allowNavigation = true;
    location.assign(`${location.pathname}?lang=en&probe=product-ux`);
  });
  variants.addEventListener('click', async () => {
    if (editorElement.hidden === false) await returnToGallery();
    const mug = find('white-glossy-mug-duo-11oz');
    mug.sizes.scrollIntoView({ block: 'center' });
    productGallery.openVariants(mug);
    controls.style.visibility = 'hidden';
    productGallery.variantDialog.dialog.addEventListener('close', () => { controls.style.visibility = ''; }, { once: true });
  });
  preview.addEventListener('click', async () => {
    if (editorElement.hidden === false) await returnToGallery();
    await productGallery.choose(find('mouse-pad'));
    document.querySelector('.workbench').scrollIntoView({ block: 'center' });
    controls.style.visibility = 'hidden';
  });
  wrapMargins.addEventListener('click', async () => {
    wrapMargins.disabled = true; controls.style.visibility = 'hidden';
    const results = [], check = (name, pass, details) => results.push({ name, pass: Boolean(pass), details });
    const output = document.createElement('pre'); output.id = 'wrap-margin-report'; document.body.append(output);
    try {
      for (const [key, verticalMargin] of [['water-bottle-10798', 50], ['water-bottle-16030', 50],
        ['steel-tumbler-15005', 70], ['steel-tumbler-15004', 70], ['wine-tumbler', 50]]) {
        if (!editorElement.hidden) await returnToGallery();
        const variant = products.find(product => product.key === key), card = find(key);
        await productGallery.load(card, variant); await productGallery.choose(card);
        await initMug3D(); await mug3D.ready; await frame();
        const original = getAllSurfaceDesigns().default, { width, height } = variant.printFile;
        const area = mugEditor.getSafeArea();
        check(key + ': editor and layout share the three-pixel sides', area.x === 3 && area.width === width - 6 &&
          variant.layoutGeometry['fit-area'][0].x === 3 && variant.layoutGeometry['fit-area'][0].width === width - 6, area);
        check(key + ': guide uses the same side margin',
          Math.abs(parseFloat(getComputedStyle(mugEditor.shell).getPropertyValue('--print-safe-left')) - 3 / width * 100) < 1e-6);
        const items = [[-100, height / 2], [width + 100, height / 2], [width / 2, -100], [width / 2, height + 100]]
          .map(([x, y], index) => ({ id: `boundary-${index}`, type: 'icon', icon: 'heart', size: 48,
            x, y, angle: 0, color: '#0055ff' }));
        mugEditor.setDesign(items); await frame();
        const placed = mugEditor.getDesign();
        // The existing two-pixel numerical guard sits inside the safe rectangle.
        check(key + ': edge movement reaches the narrow join', placed[0].x - 24 >= 3 && placed[0].x - 24 < 6 &&
          width - placed[1].x - 24 >= 3 && width - placed[1].x - 24 < 6, placed.map(item => item.x));
        check(key + ': vertical movement keeps the original limits', placed[2].y - 24 >= verticalMargin &&
          placed[2].y - 24 < verticalMargin + 3 && height - placed[3].y - 24 >= verticalMargin &&
          height - placed[3].y - 24 < verticalMargin + 3, placed.map(item => item.y));
        check(key + ': objects remain whole and the provider mesh loads', placed.length === 4 &&
          placed.every(item => item.type === 'icon' && Math.abs(item.size - 48) < .01) &&
          mug3D.canvas.dataset.productMesh === variant.previewMesh.id);
        mugEditor.setDesign(original); updateMug3DTexture();
      }
      mug3D.group.rotation.set(.1, Math.PI, 0); mug3D.render();
      document.querySelector('.workbench').scrollIntoView({ block: 'center' }); await frame();
      output.textContent = JSON.stringify({ passed: results.every(result => result.pass), results }, null, 2);
    } catch (error) {
      output.textContent = JSON.stringify({ passed: false, error: error.stack, results }, null, 2);
      controls.style.visibility = '';
    }
  });
  colored444.addEventListener('click', async () => {
    colored444.disabled = true; controls.style.visibility = 'hidden';
    const results = [], check = (name, pass) => results.push({ name, pass: Boolean(pass) });
    const output = document.createElement('pre'); output.id = 'colored-444-report'; document.body.append(output);
    const captures = document.createElement('div'); captures.id = 'colored-444-captures'; captures.hidden = true; document.body.append(captures);
    const capture = key => {
      mug3D.render();
      const canvas = document.createElement('canvas'); canvas.width = 600;
      canvas.height = Math.round(canvas.width * mug3D.canvas.height / mug3D.canvas.width);
      const ctx = canvas.getContext('2d'); ctx.fillStyle = 'white'; ctx.fillRect(0, 0, canvas.width, canvas.height);
      ctx.drawImage(mug3D.canvas, 0, 0, canvas.width, canvas.height);
      const image = document.createElement('img'); image.dataset.key = key; image.src = canvas.toDataURL(); captures.append(image);
    };
    try {
      const variants = products.filter(product => product.previewModel?.kind === 'colored-mug' && product.size.volumeMl === 444);
      const white = products.find(product => product.key === 'white-glossy-mug-15oz');
      for (const variant of variants) {
        if (!editorElement.hidden) await returnToGallery();
        const card = find(variant.key); await productGallery.load(card, variant); await productGallery.choose(card);
        await initMug3D(); await mug3D.ready; await frame();
        check(variant.key + ': original 444 ml geometry is loaded', variant.previewMesh.file === white.previewMesh.file &&
          variant.previewMesh.adaptation === 'colored-interior-444' && mug3D.canvas.dataset.productMesh === 'mug-444');
        const artwork = JSON.stringify(getAllSurfaceDesigns()), camera = mug3D.camera.position.clone();
        for (let step = 0; step < 12; step++) { mug3D.group.rotation.set(.2, step * Math.PI / 6, 0); mug3D.render(); }
        check(variant.key + ': camera stays fixed', camera.distanceTo(mug3D.camera.position) < 1e-8);
        mug3D.updateTexture(() => {}); mug3D.group.rotation.set(.15, -2.5, 0); capture(variant.key + '-blank');
        mug3D.group.rotation.set(.5, -2.5, 0); capture(variant.key + '-inside');
        updateMug3DTexture();
        check(variant.key + ': artwork stays exact', artwork === JSON.stringify(getAllSurfaceDesigns()));
      }
      await returnToGallery();
      const card = find('colored-mug-17196'); await productGallery.load(card, variants.find(variant => variant.key === 'colored-mug-17196'));
      await productGallery.choose(card); await initMug3D(); await mug3D.ready; await frame();
      mug3D.group.rotation.set(.15, -2.5, 0); mug3D.render(); mugViewer.scrollIntoView({ block: 'center' }); await frame();
      output.textContent = JSON.stringify({ passed: results.every(result => result.pass), results }, null, 2);
    } catch (error) {
      output.textContent = JSON.stringify({ passed: false, error: error.stack, results }, null, 2); controls.style.visibility = '';
    }
  });
  productRotation.addEventListener('click', async () => {
    productRotation.disabled = true; controls.style.visibility = 'hidden';
    const results = [], check = (name, pass, details) => results.push({ name, pass: Boolean(pass), details });
    const output = document.createElement('pre'); output.id = 'product-rotation-report'; document.body.append(output);
    try {
      const gallery = productGallery;
      for (const key of ['cork-back-coaster', 'all-over-tote-8904', 'laptop-sleeve-10984', 'mouse-pad']) {
        if (!editorElement.hidden) await returnToGallery();
        const card = find(key); await gallery.load(card, card.variants.find(product => product.key === key));
        await gallery.choose(card); await initMug3D(); await mug3D.ready; await frame();
        const position = mug3D.camera.position.clone(), quaternion = mug3D.camera.quaternion.clone();
        const artwork = JSON.stringify(getAllSurfaceDesigns());
        let movement = 0, angle = 0;
        for (const pitch of [-Math.PI / 6, -.23, 0, .17, Math.PI / 6]) for (let step = 0; step < 16; step++) {
          mug3D.group.rotation.set(pitch, .13 + step * Math.PI / 8, 0); mug3D.render();
          movement = Math.max(movement, position.distanceTo(mug3D.camera.position));
          angle = Math.max(angle, quaternion.angleTo(mug3D.camera.quaternion));
        }
        check(key + ': camera stays fixed through a full turn and tilt', movement < 1e-8 && angle < 1e-6, { movement, angle });
        check(key + ': artwork stays exact', artwork === JSON.stringify(getAllSurfaceDesigns()));
        mug3D.group.rotation.set(0, .14, 0); mug3D.render();
      }
      mugViewer.scrollIntoView({ block: 'center' }); await frame();
      const camera = mug3D.camera.position.clone();
      output.dataset.dragCameraMovement = '0';
      mugViewer.addEventListener('pointermove', () => {
        output.dataset.dragCameraMovement = Math.max(Number(output.dataset.dragCameraMovement), camera.distanceTo(mug3D.camera.position));
      });
      output.textContent = JSON.stringify({ passed: results.every(result => result.pass), results }, null, 2);
    } catch (error) {
      check('probe completed', false, error.stack); output.textContent = JSON.stringify({ passed: false, results }, null, 2);
      controls.style.visibility = '';
    }
  });
  captureRotation.addEventListener('click', async () => {
    controls.style.visibility = 'hidden';
    if (!editorElement.hidden) await returnToGallery();
    const card = find('white-glossy-mug-duo-11oz');
    await productGallery.load(card, card.variants[0]);
    await productGallery.choose(card); await initMug3D(); await mug3D.ready; await frame();
    mugViewer.scrollIntoView({ block: 'center' });
    const frames = document.createElement('div'); frames.id = 'mug-rotation-frames'; frames.hidden = true;
    document.body.append(frames);
    const capture = document.createElement('canvas'); capture.width = 520;
    capture.height = Math.round(capture.width * mug3D.canvas.height / mug3D.canvas.width);
    const context = capture.getContext('2d');
    for (let index = 0; index < 36; index++) {
      mug3D.group.rotation.set(0, .14 + index * Math.PI / 18, 0); mug3D.render();
      context.fillStyle = '#ffffff'; context.fillRect(0, 0, capture.width, capture.height);
      context.drawImage(mug3D.canvas, 0, 0, capture.width, capture.height);
      const image = document.createElement('img'); image.src = capture.toDataURL('image/png'); frames.append(image);
    }
    mug3D.group.rotation.set(0, .14, 0); mug3D.render();
    frames.dataset.ready = 'true';
  });
  rotationScroll.addEventListener('click', async () => {
    rotationScroll.disabled = true; controls.style.visibility = 'hidden';
    const results = [], check = (name, pass, details) => results.push({ name, pass: Boolean(pass), ...(details ? { details } : {}) });
    const output = document.createElement('pre'); output.id = 'mug-scroll-report'; document.body.append(output);
    try {
      const gallery = productGallery; await gallery.queue;
      for (const key of ['white-glossy-mug-duo-11oz', 'colored-mug-11051', 'colored-mug-17196', 'enamel-mug']) {
        if (!editorElement.hidden) await returnToGallery();
        const card = find(key); await gallery.load(card, card.variants.find(product => product.key === key));
        await gallery.choose(card); await initMug3D(); await mug3D.ready; await frame();
        const position = mug3D.camera.position.clone(), quaternion = mug3D.camera.quaternion.clone();
        const before = JSON.stringify(getAllSurfaceDesigns());
        let movement = 0;
        for (const pitch of [-Math.PI / 6, 0, Math.PI / 6]) for (let step = 0; step < 12; step++) {
          mug3D.group.rotation.set(pitch, step * Math.PI / 6, 0); mug3D.render();
          movement = Math.max(movement, position.distanceTo(mug3D.camera.position));
        }
        check(key + ': no camera drift or zoom through a full turn and tilt', movement < 1e-8 && quaternion.angleTo(mug3D.camera.quaternion) < 1e-6, { movement });
        check(key + ': artwork stays unchanged', before === JSON.stringify(getAllSurfaceDesigns()));
      }
      await returnToGallery();
      const colored = find('colored-mug-11051');
      colored.sizes.scrollIntoView({ block: 'center' }); await frame();
      const pageY = window.scrollY, overflow = getComputedStyle(document.documentElement).overflowY;
      gallery.openVariants(colored); await frame();
      const dialog = gallery.variantDialog.dialog;
      dialog.scrollTop = dialog.scrollHeight;
      await frame();
      check('a long dropdown scrolls internally and locks the page', dialog.scrollHeight > dialog.clientHeight &&
        getComputedStyle(dialog).overscrollBehaviorY === 'contain' && getComputedStyle(document.documentElement).overflowY === 'hidden');
      check('opening and reaching the bottom preserves the page position', window.scrollY === pageY, { pageY });
      const syncScroll = () => { output.dataset.pageScroll = window.scrollY; };
      window.addEventListener('scroll', syncScroll); syncScroll();
      let photos = 0;
      gallery.photoDialog.dialog.addEventListener('close', () => {
        photos++;
        check('closing a nested photo keeps the dropdown scroll lock', dialog.open &&
          getComputedStyle(document.documentElement).overflowY === 'hidden' && window.scrollY === pageY);
      }, { once: true });
      dialog.addEventListener('close', async () => {
        await frame(); window.removeEventListener('scroll', syncScroll);
        check('wheel scrolling at the dropdown boundary never moves the background', window.scrollY === pageY, { before: pageY, after: window.scrollY });
        check('nested product photo was exercised', photos > 0);
        check('closing the dropdown releases the lock without moving the page', getComputedStyle(document.documentElement).overflowY === overflow && window.scrollY === pageY);
        output.textContent = JSON.stringify({ passed: results.every(result => result.pass), results }, null, 2);
        controls.style.visibility = '';
      }, { once: true });
      output.textContent = JSON.stringify({ phase: 'Scroll down at the bottom, enlarge a variant photo, close it, then close the dropdown.', pageY, results }, null, 2);
    } catch (error) {
      check('probe completed', false, error.stack); output.textContent = JSON.stringify({ passed: false, results }, null, 2); controls.style.visibility = '';
    }
  });
  run.addEventListener('click', async () => {
    run.disabled = true;
    const results = [], check = (name, pass, details) => results.push({ name, pass: Boolean(pass), ...(details ? { details } : {}) });
    try {
      const gallery = productGallery;
      await gallery.queue; await frame();
      const mug = find('white-glossy-mug-duo-11oz'), mouse = find('mouse-pad');
      for (const event of [new MouseEvent('click', { bubbles: true }), new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })]) mug.preview.dispatchEvent(event);
      check('gallery preview clicks and Enter leave the editor closed', !workspaceReady && !mugEditor && editorElement.hidden);
      mug.variantToggle.click();
      const dialog = gallery.variantDialog.dialog, rows = [...gallery.variantDialog.list.children];
      await Promise.all(rows.map(row => row.querySelector('img').decode()));
      check('all mug options show exact real photographs, sizes and prices', rows.length === 3 && rows.every((row, i) =>
        row.querySelector('img').getAttribute('src') === mug.variants[i].productPhoto && row.querySelector('img').naturalWidth > 0 &&
        row.querySelector('strong').textContent === mug.variants[i].size.label && row.querySelector('.product-variant-price').textContent === gallery.priceFor(mug.variants[i])));
      const before = JSON.stringify(mug.snapshot);
      rows[2].querySelector('.product-variant-photo').click();
      check('an unselected variant photo enlarges without switching the design', gallery.photoDialog.dialog.open && dialog.open &&
        gallery.photoDialog.photo.getAttribute('src') === mug.variants[2].productPhoto && before === JSON.stringify(mug.snapshot));
      gallery.photoDialog.dialog.close();
      await frame();
      check('closing the enlarged photograph returns focus to its option thumbnail', document.activeElement === rows[2].querySelector('.product-variant-photo'));
      rows[2].querySelector('.product-variant-choice').click(); await gallery.queue;
      check('choosing 591 ml updates only its exact preview and price', mug.product.key === mug.variants[2].key &&
        mug.snapshot.productKey === mug.variants[2].key && mug.price.textContent === gallery.priceFor(mug.variants[2]) && !workspaceReady);
      await gallery.load(mug, mug.variants[0]); await gallery.add(mug);
      const poster = find('matte-poster-30x40cm'); await gallery.add(poster);
      const cartIds = loadOrderItems().map(item => item.id);
      check('explicit gallery adds approve exactly two fixture items', cartIds.length === 2);
      await gallery.choose(mouse); await initMug3D(); await mug3D.ready; await frame();
      check('Customize opens the mouse-pad editor', workspaceReady && product.key === 'mouse-pad' && !editorElement.hidden);
      const design = JSON.stringify(getAllSurfaceDesigns()), uv = JSON.stringify(mug3D.group.children[0]?.children[0]?.geometry?.attributes.uv?.array);
      const box = new THREE.Box3().setFromObject(mug3D.group, true), corner = new THREE.Vector3();
      mug3D.camera.updateMatrixWorld();
      const projected = { left: 1, right: -1, top: -1, bottom: 1 };
      mug3D.group.traverse(object => {
        const position = object.geometry?.attributes.position;
        for (let index = 0; index < (position?.count || 0); index++) {
          corner.fromBufferAttribute(position, index).applyMatrix4(object.matrixWorld).project(mug3D.camera);
          projected.left = Math.min(projected.left, corner.x); projected.right = Math.max(projected.right, corner.x);
          projected.top = Math.max(projected.top, corner.y); projected.bottom = Math.min(projected.bottom, corner.y);
        }
      });
      check('the mouse pad fills the editor with visible padding', Math.max(projected.right - projected.left, projected.top - projected.bottom) > 1.5 &&
        Object.values(projected).every(value => Math.abs(value) < .95), projected);
      mug3D.group.rotation.set(.4, 1, 0); mug3D.render(); mug3D.group.rotation.set(0, .14, 0); mug3D.render();
      check('framing and rotation preserve all artwork and print UVs', JSON.stringify(getAllSurfaceDesigns()) === design &&
        JSON.stringify(mug3D.group.children[0]?.children[0]?.geometry?.attributes.uv?.array) === uv && !box.isEmpty());
      await returnToGallery(); await gallery.load(mug, mug.variants[2]); await frame();
      check('browsing an unsubmitted size after editing leaves only the two accepted cart items', JSON.stringify(loadOrderItems().map(item => item.id)) === JSON.stringify(cartIds));
      cartPanel.open(); await frame();
      const panel = document.getElementById('cart-panel'), note = panel.querySelector('.product-price-note');
      check('cart VAT/shipping note aligns with the 22px content inset', Math.abs(note.getBoundingClientRect().left - panel.getBoundingClientRect().left - 23) < 1.5,
        { inset: note.getBoundingClientRect().left - panel.getBoundingClientRect().left, margin: getComputedStyle(note).marginLeft });
      cartPanel.close();
      sessionStorage.setItem('product-ux-expected-cart', JSON.stringify(cartIds));
      check('the exact active editor draft is retained locally', (await draftStore.loadActive())?.productKey === 'mouse-pad');
    } catch (error) { check('probe completed without errors', false, error.stack); }
    report.textContent = JSON.stringify({ passed: results.every(result => result.pass), results }, null, 2);
    run.hidden = true;
    report.scrollIntoView({ block: 'start' });
  });
})();
