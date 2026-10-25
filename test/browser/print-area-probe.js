(function () {
  'use strict';
  const host = document.getElementById('host');
  const status = document.getElementById('status'), log = document.getElementById('log');
  const loadImage = src => new Promise((resolve, reject) => {
    const img = new Image(); img.onload = () => resolve(img); img.onerror = reject; img.src = src;
  });
  async function save(c, view, canvas) {
    const blob = await new Promise(resolve => canvas.toBlob(resolve, 'image/png'));
    if (!blob) throw Error('No capture');
    const response = await fetch(`/capture/${c.id}/${view}`, { method: 'POST', headers: {
      'Content-Type': 'image/png', 'X-Audit-Nonce': window.auditNonce }, body: blob });
    if (!response.ok) throw Error(`Capture ${response.status}`);
  }
  function drawItems(ctx, items, images, offsets) {
    for (const item of items) {
      if (item.type !== 'image') throw Error('Calibration must contain only images');
      ctx.save(); ctx.translate(item.x + offsets.offsetX, item.y + offsets.offsetY);
      ctx.rotate(item.angle * Math.PI / 180);
      ctx.drawImage(images.get(item.src), -item.width / 2, -item.height / 2, item.width, item.height); ctx.restore();
    }
  }
  async function flat(c) {
    const m = c.product.previewMockup, r = m.canvas;
    const canvas = document.createElement('canvas'); canvas.width = m.width; canvas.height = m.height;
    const ctx = canvas.getContext('2d'), artwork = await loadImage('/audit/full/' + Object.values(c.inputs)[0].file);
    // Match the production composite's full-blank color beneath the provider
    // layer, including its semi-transparent handles and unprinted fabric.
    if (m.backgroundColor) { ctx.fillStyle = m.backgroundColor; ctx.fillRect(0, 0, canvas.width, canvas.height); }
    const tile = document.createElement('canvas'); tile.width = Math.round(m.width * r.width / 100); tile.height = Math.round(m.height * r.height / 100);
    const t = tile.getContext('2d');
    if (m.backgroundColor) { t.fillStyle = m.backgroundColor; t.fillRect(0, 0, tile.width, tile.height); }
    const scale = (r.fit === 'cover' ? Math.max : Math.min)(tile.width / artwork.width, tile.height / artwork.height);
    t.drawImage(artwork, (tile.width - artwork.width * scale) / 2, (tile.height - artwork.height * scale) / 2, artwork.width * scale, artwork.height * scale);
    ctx.save(); ctx.translate(m.width * r.left / 100, m.height * r.top / 100);
    if (r.clipPath?.startsWith('polygon(')) {
      const points = r.clipPath.slice(8, -1).split(',').map(p => p.trim().split(/\s+/).map(parseFloat));
      ctx.beginPath(); points.forEach(([x, y], i) => ctx[i ? 'lineTo' : 'moveTo'](x / 100 * tile.width, y / 100 * tile.height)); ctx.closePath(); ctx.clip();
    }
    ctx.drawImage(tile, 0, 0); ctx.restore();
    const photo = await loadImage(m.assets.default || Object.values(m.assets)[0]);
    ctx.save(); ctx.translate(m.width / 2, m.height / 2); ctx.rotate((m.rotation || 0) * Math.PI / 180);
    ctx.globalCompositeOperation = m.blendMode === 'multiply' ? 'multiply' : 'source-over';
    const fit = Math.min(m.width / photo.width, m.height / photo.height);
    ctx.drawImage(photo, -photo.width * fit / 2, -photo.height * fit / 2, photo.width * fit, photo.height * fit); ctx.restore();
    await save(c, 'front', canvas); canvas.width = tile.width = 1;
  }
  async function render(c) {
    if (c.product.previewType === 'flat') return flat(c);
    const designs = await (await fetch('/audit/full/' + c.designsFile)).json();
    const images = new Map();
    for (const items of Object.values(designs)) for (const item of items) if (!images.has(item.src)) images.set(item.src, await loadImage(item.src));
    const keys = Object.keys(designs);
    let viewer;
    try {
      viewer = Mug3DViewer.create({ host, product: c.product, initialRotationY: 0, positionY: 0,
        drawTexture: (ctx, o) => drawItems(ctx, designs[keys[0]], images, o),
        drawBackTexture: (ctx, o) => drawItems(ctx, designs[keys[1]] || [], images, o) });
      if (!await viewer.ready) throw Error('Model loading failed');
      const distance = viewer.camera.position.length(); viewer.camera.position.set(0, 0, distance); viewer.camera.lookAt(0, 0, 0);
      const kind = c.product.previewModel?.kind;
      const curved = c.product.previewType === 'mug' || ['colored-mug', 'bottle', 'steel-tumbler', 'enamel', 'travel', 'wine'].includes(kind);
      const angles = curved ? [['front', 0], ['left', Math.PI / 2], ['right', -Math.PI / 2], ['back', Math.PI]]
        : keys.length > 1 ? [['front', 0], ['back', Math.PI]] : [['front', 0]];
      for (const [view, angle] of angles) {
        viewer.group.rotation.y = angle;
        viewer.render();
        // Read before the browser clears the non-preserved WebGL buffer.
        const capture = document.createElement('canvas'); capture.width = viewer.canvas.width; capture.height = viewer.canvas.height;
        capture.getContext('2d').drawImage(viewer.canvas, 0, 0);
        await save(c, view, capture); capture.width = 1;
      }
    } finally { viewer?.destroy(); host.replaceChildren(); images.clear(); }
  }
  document.getElementById('start').addEventListener('click', async event => {
    event.target.disabled = true;
    const plan = await (await fetch('/audit/full/coverage.json')).json();
    const only = new URL(location.href).searchParams.get('only');
    const cases = plan.cases.filter(c => !only || c.id.includes(only));
    let failures = 0;
    for (const [i, c] of cases.entries()) {
      status.textContent = `${i + 1}/${cases.length} · ${c.id}`;
      try { await render(c); log.textContent += `OK ${c.id}\n`; }
      catch (error) { failures++; log.textContent += `FAIL ${c.id}: ${error.message}\n`; }
      await new Promise(resolve => setTimeout(resolve, 50));
    }
    status.textContent = `Fertig: ${cases.length - failures}/${cases.length}, Fehler: ${failures}`;
    event.target.disabled = false;
  });
})();
