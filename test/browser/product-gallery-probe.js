'use strict';

// Database-free fixture only. Exercise the real print optimizer, preview
// callbacks, Fabric initialization, side switching and IndexedDB recovery.
(function () {
  const run = document.createElement('button');
  run.type = 'button';
  run.textContent = 'Check gallery and exact editor handoff';
  run.style.cssText = 'position:fixed;right:12px;bottom:12px;z-index:10000;padding:12px;background:white;color:black';
  const report = document.createElement('pre');
  report.id = 'product-gallery-report';
  report.style.cssText = 'white-space:pre-wrap;padding:16px;background:white;color:black';
  document.body.append(run, report);
  const reset = document.createElement('button');
  reset.type = 'button';
  reset.textContent = 'Reset gallery fixture';
  reset.style.cssText = 'position:fixed;right:12px;top:90px;z-index:10000;padding:8px;background:white;color:black';
  document.body.append(reset);
  const calm = document.createElement('button');
  calm.type = 'button';
  calm.textContent = 'Check calm gallery loading';
  calm.style.cssText = 'position:fixed;right:12px;bottom:64px;z-index:10000;padding:12px;background:white;color:black';
  const calmReport = document.createElement('pre');
  calmReport.id = 'gallery-loading-report';
  document.body.append(calm, calmReport);
  const scrollReport = document.createElement('pre');
  scrollReport.id = 'gallery-cart-scroll-report';
  scrollReport.style.cssText = 'position:fixed;left:12px;top:90px;z-index:10000;max-width:340px;padding:12px;background:white;color:black;white-space:pre-wrap;pointer-events:none';
  scrollReport.hidden = true;
  document.body.append(scrollReport);
  // Use the real pointer path: calling Gallery.add() directly misses Safari's
  // response to text-node replacement after a native mouse click.
  document.addEventListener('pointerdown', event => {
    const add = event.target.closest('.product-gallery-add');
    if (!event.isTrusted || event.button !== 0 || !add || add.disabled) return;
    const card = add.closest('.product-gallery-card');
    const beforeY = scrollY, beforeTop = card.getBoundingClientRect().top;
    const textNodes = [...document.querySelectorAll(
      '.product-gallery-name, .product-gallery-price, .product-gallery-price-note, .product-gallery-variant-summary > span:first-child'
    )].map(element => [element, element.firstChild]);
    const started = performance.now();
    let settledAt = null, maxScrollDelta = 0;
    scrollReport.hidden = false;
    scrollReport.textContent = 'Recording native Add to cart…';
    function sample(now) {
      maxScrollDelta = Math.max(maxScrollDelta, Math.abs(scrollY - beforeY));
      const busy = add.getAttribute('aria-busy') === 'true';
      if (busy) settledAt = null;
      else settledAt ??= now;
      if (now - started < 32000 && (busy || now - settledAt < 500)) {
        requestAnimationFrame(sample);
        return;
      }
      const cardTopDelta = card.getBoundingClientRect().top - beforeTop;
      const retainedText = textNodes.every(([element, node]) => element.firstChild === node);
      const accepted = productGallery.cards.some(entry => entry.element === card && entry.inCart && entry.snapshot.needsCartUpdate === false);
      const passed = accepted && !busy && maxScrollDelta < 1 && Math.abs(cardTopDelta) < 1 && retainedText;
      scrollReport.textContent = JSON.stringify({ passed, product: card.querySelector('.product-gallery-name').textContent,
        beforeY, afterY: scrollY, maxScrollDelta, cardTopDelta, retainedText, accepted }, null, 2);
    }
    requestAnimationFrame(sample);
  }, true);
  let finishLoading = null;
  calm.addEventListener('click', async () => {
    if (finishLoading) { finishLoading(); return; }
    calm.disabled = true;
    const results = [];
    const check = (name, pass) => results.push({ name, pass: Boolean(pass) });
    try {
      const gallery = productGallery;
      await gallery.queue;
      const mug = gallery.cards.find(card => card.product.previewType === 'mug');
      const next = mug.variants.find(product => product.key !== mug.product.key);
      const bounds = () => ({ card: mug.element.getBoundingClientRect().height,
        add: mug.add.getBoundingClientRect().top, customize: mug.customize.getBoundingClientRect().top });
      const before = bounds();
      const prepare = gallery.prepareDesign;
      const gate = new Promise(resolve => { finishLoading = resolve; });
      gallery.prepareDesign = async (product, options) => {
        if (product.key === next.key) await gate;
        return prepare(product, options);
      };
      gallery.entries.delete(ProductOrientation.key(next));
      const pending = gallery.load(mug, next);
      await new Promise(requestAnimationFrame);
      check('the card and actions do not move while loading', JSON.stringify(before) === JSON.stringify(bounds()));
      check('preparation text is outside the layout', getComputedStyle(mug.status).position === 'absolute');
      check('a dimmed copy of the previous mug stays visible', !mug.previousPreview.hidden &&
        mug.previousPreview.getContext('2d').getImageData(0, 0, mug.previousPreview.width, mug.previousPreview.height)
          .data.some((value, index) => index % 4 === 3 && value > 0));
      calm.textContent = 'Finish loading check';
      calm.disabled = false;
      calmReport.textContent = JSON.stringify({ phase: 'loading', results }, null, 2);
      await gate;
      await pending;
      gallery.prepareDesign = prepare;
      check('the card and actions stay in place when ready', JSON.stringify(before) === JSON.stringify(bounds()));
      check('the previous copy is released after the new preview paints', mug.previousPreview.hidden && mug.stage.dataset.ready === 'true');
    } catch (error) { results.push({ name: 'Loading probe failed', pass: false, message: error.message }); }
    calmReport.textContent = JSON.stringify({ passed: results.every(result => result.pass), results }, null, 2);
    calm.hidden = true;
    finishLoading = null;
  });
  reset.addEventListener('click', async () => {
    workspaceReady = false;
    allowNavigation = true;
    clearTimeout(draftSaveTimer);
    if (draftSavePromise) await draftSavePromise;
    await draftStore.clearActive();
    cart.write([]);
    const query = new URLSearchParams(location.search);
    for (const key of ['draft', 'edit', 'cart', 'accountDesign']) query.delete(key);
    location.assign(`${location.pathname}?${query}`);
  });
  run.addEventListener('click', async () => {
    run.disabled = true;
    const results = [];
    const check = (name, pass) => results.push({ name, pass: Boolean(pass) });
    const frame = async () => { await new Promise(requestAnimationFrame); await new Promise(requestAnimationFrame); };
    const decodeCurrentPhoto = async card => {
      // Reference photos load lazily. A ready 3D preview can also replace the
      // reference with a design thumbnail while an earlier decode is pending.
      card.photoButton.scrollIntoView({ block: 'center' });
      const deadline = performance.now() + 15000;
      while (performance.now() < deadline) {
        await frame();
        const source = card.photo.getAttribute('src');
        try {
          await card.photo.decode();
          if (source === card.photo.getAttribute('src') && card.photo.naturalWidth > 0) return;
        } catch (error) {
          if (source === card.photo.getAttribute('src') && card.photo.complete && !card.photo.naturalWidth) throw error;
        }
      }
      throw new Error('The current product thumbnail did not finish loading.');
    };
    const fingerprint = designs => WolkenworteConfiguratorSession.designFingerprint({ designs }, true);
    try {
      if (!productGallery) throw new Error('Open this probe on a fresh gallery, before choosing a product.');
      const gallery = productGallery;
      await gallery.queue;
      await frame();
      check('browsing does not create an editor, draft, or cart item', !mugEditor && !workspaceReady &&
        !await draftStore.loadActive() && !loadOrderItems().length && !new URLSearchParams(location.search).has('draft'));
      check('all catalog groups are ready', gallery.cards.length === WolkenworteProductGallery.groupProducts(products).length &&
        gallery.cards.every(card => !card.customize.disabled));
      gallery.filter('poster');
      check('poster filter includes both styles and hides other products', gallery.cards.filter(card => !card.element.hidden).length === 2 &&
        gallery.cards.filter(card => !card.element.hidden).every(card => card.product.familyKey === 'posters'));
      gallery.filter('all');
      check('mug capacities are metric in cards and selectors', gallery.cards.find(card => card.product.previewType === 'mug').sizes.textContent.includes('325 ml') &&
        !gallery.cards.some(card => /\boz\b/.test(card.element.textContent)));
      for (const card of gallery.cards) {
        for (const variant of card.variants) {
          await gallery.load(card, variant);
          const saved = card.snapshot;
          check(variant.key + ': every print side retains every source word', saved &&
            variant.printSurfaces.every(surface => saved.designs[surface.key].length === words.length));
          if (variant.previewType === 'flat') check(variant.key + ': existing Printful asset is used',
            card.image.getAttribute('src') === currentProductMockupAsset(card.view, card.surface));
          if (variant.productPhoto) {
            await decodeCurrentPhoto(card);
            check(variant.key + ': the thumbnail matches the selected product and design',
              !card.photo.hidden && card.photo.naturalWidth > 0 &&
              card.photo.getAttribute('src') === (card.thumbnailUrl || variant.productPhoto));
            const withPhoto = card.element.getBoundingClientRect().height;
            const reservedPhoto = card.sizes.classList.contains('has-product-photo');
            card.photoButton.hidden = true;
            card.sizes.classList.remove('has-product-photo');
            const withoutPhoto = card.element.getBoundingClientRect().height;
            card.photoButton.hidden = false;
            card.sizes.classList.toggle('has-product-photo', reservedPhoto);
            check(variant.key + ': the reference photo adds no card height', withPhoto === withoutPhoto);
          }
        }
      }
      const target = new URLSearchParams(location.search).get('pick') || 'spiral-notebook-dotted';
      const card = gallery.cards.find(card => card.variants.some(variant => variant.key === target));
      await gallery.load(card, card.variants.find(variant => variant.key === target));
      const expected = JSON.parse(JSON.stringify(card.snapshot));
      const viewer = gallery.cards.find(card => card.viewer)?.viewer;
      await gallery.choose(card);
      await frame();
      check('the selected product opens the current editor', workspaceReady && product.key === expected.productKey && galleryElement.hidden && !editorElement.hidden);
      const galleryBack = document.getElementById(mobileDevice ? 'mobile-back-link' : 'back-link');
      check('the header returns to products while the toolbar starts with the product selector',
        new URL(galleryBack.href).searchParams.get('view') === 'products' &&
        document.querySelector('.design-toolbar-controls').firstElementChild.id === 'selected-product-control');
      if (!mobileDevice) {
        const backRect = galleryBack.getBoundingClientRect();
        check('the header gallery return link is visible when the editor opens', backRect.top >= 0 &&
          backRect.bottom <= innerHeight && backRect.width > 0);
      }
      const actual = getAllSurfaceDesigns();
      const exact = fingerprint(actual) === fingerprint(expected.designs);
      check('every print side matches the gallery exactly', exact);
      if (!exact) {
        const differences = [];
        for (const [side, design] of Object.entries(expected.designs)) design.forEach((before, index) => {
          const after = actual[side][index];
          for (const key of new Set([...Object.keys(before), ...Object.keys(after)])) {
            if (before[key] !== after[key]) differences.push({ side, index, key, before: before[key], after: after[key] });
          }
        });
        results.push({ name: 'Handoff differences', pass: false, differences: differences.slice(0, 15) });
      }
      check('source words and palette are retained', JSON.stringify(words) === JSON.stringify(expected.words) && selectedTheme === expected.theme);
      check('the initial gallery design remains automatic and outside the cart', !currentDesignEdited && currentDesignNeedsSave && !loadOrderItems().length);
      if (viewer) check('the gallery releases its WebGL context', viewer.renderer.getContext().isContextLost());
      if (productSurfaces().length > 1) {
        selectSurface('back');
        check('the prepared back opens without repacking', fingerprint({ back: mugEditor.getDesign() }) === fingerprint({ back: expected.designs.back }));
        selectSurface('front');
      }
      check('the chosen design persists exactly for browser recovery', await persistCurrentDraft() &&
        fingerprint((await draftStore.loadActive()).designs) === fingerprint(expected.designs));
      if (mobileDevice && mobileEditorMedia.matches) check('mobile selection opens the existing canvas workspace', Boolean(workspace.mobileCanvas?.active));
      const editor = mugEditor;
      const first = editor.canvas.getObjects()[0];
      first.set('fill', '#123456');
      editor.recordHistory();
      editor.emitChange();
      editor.flushPendingChange();
      const edited = getAllSurfaceDesigns();
      const history = editor.getState().history.length;
      await returnToGallery();
      await frame();
      const retained = productGallery.cards.find(card => card.product.key === expected.productKey);
      check('back opens the gallery and closes the mobile canvas', !galleryElement.hidden && editorElement.hidden && !workspace.mobileCanvas.active);
      check('the edited artwork is shown on its gallery card', fingerprint(retained.snapshot.designs) === fingerprint(edited));
      await productGallery.choose(retained);
      check('returning to the same design keeps its editor and Undo history', mugEditor === editor &&
        editor.getState().history.length === history && fingerprint(getAllSurfaceDesigns()) === fingerprint(edited));
      await returnToGallery();
      await frame();
      const other = productGallery.cards.find(card => card.product.previewShape === (product.previewShape === 'pillow' ? 'notebook' : 'pillow'));
      const addedDesign = structuredClone(other.snapshot);
      const beforeAdd = other.add.getBoundingClientRect();
      const beforeLabel = other.add.textContent;
      const originalAdd = productGallery.onAdd;
      let releaseAdd;
      productGallery.onAdd = async snapshot => {
        await new Promise(resolve => { releaseAdd = resolve; });
        return originalAdd(snapshot);
      };
      const pendingAdd = productGallery.add(other);
      const busyAdd = other.add.getBoundingClientRect();
      const addLabel = document.createRange();
      addLabel.selectNodeContents(other.add);
      const spinnerStyle = getComputedStyle(other.add, '::before');
      check('adding keeps the label and button dimensions while showing a spinner',
        other.add.textContent === beforeLabel && other.add.getAttribute('aria-busy') === 'true' &&
        beforeAdd.width === busyAdd.width && beforeAdd.height === busyAdd.height &&
        getComputedStyle(other.add, '::before').borderTopStyle === 'solid');
      check('the loading spinner stays to the left of the button label',
        busyAdd.left + parseFloat(spinnerStyle.left) + parseFloat(spinnerStyle.width) <= addLabel.getBoundingClientRect().left);
      releaseAdd();
      await pendingAdd;
      productGallery.onAdd = originalAdd;
      check('gallery Add keeps the gallery open and updates the cart badge', !galleryElement.hidden && loadOrderItems().length === 1 && headerCartCount.textContent === '1');
      const beforeCart = location.href;
      headerCart.click();
      check('the cart icon opens a separate dialog without navigating or replacing the editor',
        document.getElementById('cart-panel').open && !galleryElement.hidden && beforeCart === location.href && mugEditor === editor);
      check('the cart panel shows its product and an explicit shipping action',
        document.querySelectorAll('[data-cart-panel-list] li').length === 1 &&
        !document.querySelector('[data-cart-panel-continue]').disabled);
      check('the cart panel retains its header close control and only the shipping action in its footer',
        document.querySelector('.cart-panel-head [data-cart-panel-close]') &&
        document.querySelectorAll('.cart-panel-foot button').length === 1);
      cartPanel.close();
      const accepted = await (await fetch(`/api/events/${slug}/configurations/${loadOrderItems()[0].id}/edit`)).json();
      check('the cart freezes the exact gallery artwork on both sides', fingerprint(accepted.designs) === fingerprint(addedDesign.designs));
      await productGallery.add(other);
      check('repeated Add does not duplicate a cart position', loadOrderItems().length === 1);
      await productGallery.choose(other);
      check('a gallery-added product opens as its accepted cart design', editingOrderItemId === accepted.id &&
        !currentDesignNeedsSave && fingerprint(getAllSurfaceDesigns()) === fingerprint(addedDesign.designs));
      await returnToGallery();
      await frame();
      check('the earlier edited product survives choosing and adding another product', fingerprint(retained.snapshot.designs) === fingerprint(edited));
      await productGallery.choose(retained);
      check('switching back restores both sides of the earlier edited design', fingerprint(getAllSurfaceDesigns()) === fingerprint(edited));
    } catch (error) { results.push({ name: 'Probe failed', pass: false, message: error.message }); }
    report.textContent = JSON.stringify({ passed: results.every(result => result.pass), results }, null, 2);
    run.hidden = true;
    report.scrollIntoView({ block: 'start' });
  });
})();
