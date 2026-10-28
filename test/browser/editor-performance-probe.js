'use strict';

// Loopback fixture only: scripted operations measure the real hot paths, not
// physical touch latency. The fixture never reads or writes hosted designs.
(function () {
  const query = new URLSearchParams(location.search);
  const originalCreate = Mug3DViewer.create;
  if (query.has('texture')) window.Mug3DViewer = { ...Mug3DViewer, create: options => originalCreate({ ...options,
    maxTextureSize: Number(query.get('texture')), modelOptions: { maxTextureSize: Number(query.get('texture')) } }) };
  const button = document.createElement('button');
  button.textContent = 'Measure editor interactions';
  button.id = 'editor-performance-run';
  button.style.cssText = 'position:fixed;top:4px;right:4px;z-index:100000';
  const report = document.createElement('pre');
  report.id = 'editor-performance-report';
  report.style.cssText = 'position:fixed;bottom:0;left:0;right:0;z-index:100000;max-height:25vh;overflow:auto;white-space:pre-wrap;overflow-wrap:anywhere;background:white;font:10px monospace';
  document.body.append(button, report);
  button.addEventListener('click', async () => {
    button.disabled = true;
    report.dataset.finished = 'false';
    report.textContent = 'Recording editor interactions…';
    const samples = {}, phases = {}, restorers = [];
    const wrap = (owner, key, label = key) => {
      const original = owner[key];
      if (typeof original !== 'function') return;
      owner[key] = function (...args) {
        const start = performance.now();
        try { return original.apply(this, args); }
        finally { (samples[label] ||= []).push(performance.now() - start); }
      };
      restorers.push(() => { owner[key] = original; });
    };
    const frame = () => new Promise(requestAnimationFrame);
    try {
      while (!workspaceReady && !productGallery) await frame();
      if (!workspaceReady) {
        const card = productGallery.cards.find(card => card.product.previewType === 'mug');
        while (!card.snapshot) await frame();
        await productGallery.choose(card);
      }
      await document.fonts.ready;
      if (query.get('device') === 'mobile') workspace.mobileCanvas.open(button);
      const original = mugEditor.getDesign();
      if (original.length < 2) mugEditor.setDesign([
        { ...original[0], id: 'probe-hallo', text: 'Hallo', fontSize: 450, x: 700, y: 500 },
        { ...original[0], id: 'probe-test', text: 'test', fontSize: 450, x: 1900, y: 500 },
      ], { resetHistory: true });
      for (let i = 0; i < 30; i++) await frame();
      for (const name of ['handleTransform', 'getDesign', 'keepInside', 'refreshViewport', 'setZoom']) wrap(mugEditor, name);
      wrap(mugEditor.canvas, 'renderAll', 'fabric.renderAll');
      if (mug3D) {
        for (const name of ['updateTexture', 'render', 'resize']) wrap(mug3D, name, `preview.${name}`);
      }
      // Global template functions use writable bindings; instrument through
      // direct assignments so timings include all real callers.
      const timed = (fn, name) => function (...args) {
        const start = performance.now();
        try { return fn.apply(this, args); }
        finally { (samples[name] ||= []).push(performance.now() - start); }
      };
      const dirty = markDirty, preview = renderProductPreview, layout = refreshWorkspaceLayout;
      markDirty = timed(dirty, 'markDirty');
      renderProductPreview = query.has('no-preview') ? () => {} : timed(preview, 'renderProductPreview');
      refreshWorkspaceLayout = timed(layout, 'refreshWorkspaceLayout');
      restorers.push(() => { markDirty = dirty; renderProductPreview = preview; refreshWorkspaceLayout = layout; });
      const phase = async (name, action, count = 90) => {
        button.textContent = `Measuring ${name}`;
        const gaps = [];
        let previous = await frame();
        for (let i = 0; i < count; i++) {
          await action(i);
          const now = await frame();
          gaps.push(now - previous); previous = now;
        }
        gaps.sort((a, b) => a - b);
        phases[name] = { frames: count, p50: gaps[Math.floor(count * .5)], p95: gaps[Math.floor(count * .95)], max: gaps.at(-1), over50: gaps.filter(value => value > 50).length };
      };
      const object = mugEditor.canvas.getObjects()[0];
      mugEditor.canvas.setActiveObject(object);
      await phase('drag', i => {
        object.set({ left: object.left + (i % 2 ? -1 : 1) });
        mugEditor.handleTransform(object); mugEditor.canvas.requestRenderAll();
      });
      mugEditor.canvas.fire('object:modified', { target: object });
      await phase('text', i => mugEditor.applyTextChange(object, i % 2 ? 'Hallo' : 'Hallos'), 30);
      await phase('zoom', i => mugEditor.setZoom(1 + (i % 5) * .25), 30);
      mugEditor.setZoom(1);
      await phase('idle', () => {}, 60);
      const timings = Object.fromEntries(Object.entries(samples).map(([key, values]) => {
        values.sort((a, b) => a - b);
        return [key, { calls: values.length, total: values.reduce((sum, value) => sum + value, 0), p50: values[Math.floor(values.length * .5)], p95: values[Math.floor(values.length * .95)], max: values.at(-1) }];
      }));
      const result = { phases, timings, viewport: [innerWidth, innerHeight], mobile: mugEditor.mobileViewport === true,
        gallerySuspended: productGallery?.suspended, galleryViewers: productGallery?.cards.filter(card => card.viewer).length };
      const { timings: _timings, ...metadata } = result;
      report.replaceChildren(...Object.entries({ ...metadata, ...timings }).map(([key, value]) => {
        const line = document.createElement('div'); line.textContent = `${key}: ${JSON.stringify(value)}`; return line;
      }));
      if (workspace.mobileCanvas.active) document.getElementById('mobile-canvas-dialog').append(report);
    } catch (error) { report.textContent = error.stack; }
    finally { restorers.reverse().forEach(restore => restore()); button.textContent = 'Measure editor interactions'; button.disabled = false; report.dataset.finished = 'true'; }
  });
})();
