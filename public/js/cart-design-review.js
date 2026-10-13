(function (root, factory) {
  'use strict';
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.WolkenworteCartReview = factory();
})(typeof window === 'object' ? window : globalThis, function () {
  'use strict';

  function artworkSignature(snapshot, omit = []) {
    function normalize(value) {
      if (Array.isArray(value)) return value.map(normalize);
      if (!value || typeof value !== 'object') return value;
      return Object.fromEntries(Object.keys(value).sort()
        .filter(key => !['id', 'colorLocked'].includes(key) && !omit.includes(key)).map(key => [key, normalize(value[key])]));
    }
    return JSON.stringify(normalize(snapshot.designs));
  }

  function changes(previous, current) {
    const result = [];
    if (previous.productKey !== current.productKey) result.push('Produkt geändert');
    if (previous.orientation !== current.orientation) result.push('Ausrichtung geändert');
    const artworkChanged = artworkSignature(previous) !== artworkSignature(current);
    const onlyColours = artworkChanged && artworkSignature(previous, ['color']) === artworkSignature(current, ['color']);
    if (previous.theme !== current.theme || onlyColours) result.push('Farben geändert');
    if (artworkChanged && !onlyColours) result.push('Design geändert');
    return result;
  }

  // Both versions use the same print-coordinate renderer, without touching the
  // editor, its selection/history, the local draft or the immutable cart file.
  async function renderArtwork({ document, runtime, snapshot, surface, view, signal }) {
    const design = snapshot.designs?.[surface.key];
    if (!Array.isArray(design)) throw new Error('preview_unavailable');
    const images = new Map();
    await Promise.all([
      ...[...new Set(design.filter(item => item.type !== 'image' && item.type !== 'icon')
        .map(item => runtime.DesignFonts.normalizeKey(item.fontFamily)))].map(key =>
        runtime.DesignFonts.loadFont(key, document.fonts)),
      runtime.WolkenworteEmoji.preloadTexts(design.map(item => item.text || '')),
      ...[...new Set(design.filter(item => item.type === 'image').map(item => item.src))].map(src => new Promise((resolve, reject) => {
        if (signal.aborted) return reject(new Error('aborted'));
        const image = document.createElement('img');
        let timer;
        const finish = error => {
          clearTimeout(timer);
          signal.removeEventListener('abort', abort);
          image.onload = image.onerror = null;
          if (error) { image.removeAttribute('src'); reject(error); }
          else { images.set(src, image); resolve(); }
        };
        const abort = () => finish(new Error('aborted'));
        signal.addEventListener('abort', abort, { once: true });
        image.onload = () => finish();
        image.onerror = () => finish(new Error('preview_unavailable'));
        timer = setTimeout(() => finish(new Error('preview_unavailable')), 10000);
        image.src = src;
      })),
    ]);
    if (signal.aborted) throw new Error('aborted');
    const canvas = document.createElement('canvas');
    const { width, height } = view.printFile;
    const scale = Math.min(1, 1200 / Math.max(width, height));
    canvas.width = Math.max(1, Math.round(width * scale));
    canvas.height = Math.max(1, Math.round(height * scale));
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    for (const item of design) runtime.ArtworkOverlap.drawItem(ctx, item, {
      image: src => images.get(src),
      emojiImage: run => runtime.WolkenworteEmoji.getLoadedImage(run),
    }, scale);
    return canvas.toDataURL('image/png');
  }

  function create({ document, container, detailDialog, load, render, describe, surfaces, setText, onEdit }) {
    let controller = null;
    const element = (tag, className, source, params) => {
      const node = document.createElement(tag);
      if (className) node.className = className;
      if (source) setText(node, source, params);
      return node;
    };
    const detailBody = detailDialog.querySelector('[data-cart-comparison-body]');
    const detailTitle = detailDialog.querySelector('h2');
    detailDialog.querySelector('[data-cart-comparison-close]').addEventListener('click', () => detailDialog.close());
    detailDialog.addEventListener('close', () => detailBody.replaceChildren());

    function dispose() {
      controller?.abort();
      controller = null;
      if (detailDialog.open) detailDialog.close();
      detailBody.replaceChildren();
      container.replaceChildren();
    }

    function pair(host, previous, current, signal, previews, initialIndex = 0) {
      const beforeSides = previous ? surfaces(previous) : [];
      const afterSides = surfaces(current);
      const count = Math.max(beforeSides.length, afterSides.length);
      const sideNav = element('nav', 'cart-review-surfaces');
      const navigationLabel = element('span', 'sr-only', 'Druckseite wählen');
      sideNav.setAttribute('aria-label', navigationLabel.textContent);
      sideNav.setAttribute('data-i18n-aria-label-source', 'Druckseite wählen');
      const grid = element('div', 'cart-review-comparison');
      if (!previous) grid.classList.add('is-addition');
      host.append(sideNav, grid);
      let generation = 0, activeIndex = initialIndex;
      function choose(index) {
        activeIndex = index;
        const version = ++generation;
        sideNav.querySelectorAll('button').forEach((button, number) => button.setAttribute('aria-pressed', String(index === number)));
        grid.replaceChildren();
        for (const [key, snapshot, side, label] of [
          ['before', previous, beforeSides[index], 'Im Warenkorb'],
          ['after', current, afterSides[index], 'Deine Änderungen'],
        ]) {
          if (!snapshot) continue;
          const figure = element('figure', 'cart-review-version');
          figure.dataset.version = key;
          const caption = element('figcaption', null, !previous ? 'Neues Design' : label);
          const product = element('span', 'cart-review-product');
          product.textContent = describe(snapshot);
          caption.append(product);
          const frame = element('div', 'cart-review-artwork');
          const status = element('p', 'cart-review-preview-status', side ? 'Vorschau wird geladen…' : 'Keine Druckseite');
          status.setAttribute('role', 'status');
          frame.append(status);
          figure.append(caption, frame);
          grid.append(figure);
          if (!side) continue;
          const previewKey = `${key}:${side.key}`;
          const show = async () => {
            setText(status, 'Vorschau wird geladen…');
            try {
              if (!previews.has(previewKey)) previews.set(previewKey, render(snapshot, side, signal)
                .catch(error => { previews.delete(previewKey); throw error; }));
              const src = await previews.get(previewKey);
              if (signal.aborted || generation !== version || !frame.isConnected) return;
              const image = element('img');
              image.alt = caption.textContent;
              image.src = src;
              frame.replaceChildren(image);
            } catch {
              if (signal.aborted || generation !== version || !frame.isConnected) return;
              setText(status, 'Vorschau konnte nicht geladen werden.');
              const retry = element('button', 'cart-review-link', 'Erneut versuchen');
              retry.type = 'button';
              retry.addEventListener('click', () => { retry.remove(); void show(); });
              frame.replaceChildren(status, retry);
            }
          };
          void show();
        }
      }
      if (count > 1) {
        for (let index = 0; index < count; index++) {
          const side = afterSides[index] || beforeSides[index];
          const button = element('button', null, side.label);
          button.type = 'button';
          button.addEventListener('click', () => choose(index));
          sideNav.append(button);
        }
      } else sideNav.hidden = true;
      choose(initialIndex);
      return () => activeIndex;
    }

    function show({ items, drafts, currentId, addition }) {
      dispose();
      controller = new AbortController();
      const { signal } = controller;
      const jobs = [];
      for (const draft of [...drafts, ...(addition ? [addition] : [])]) {
        const saved = items.find(item => item.id === draft.editingOrderItemId);
        const row = element('li', 'cart-review-item');
        const heading = element('div', 'cart-review-item-heading');
        const title = element('strong', null, saved ? 'Design {{number}}' : 'Weiteres Design', {
          number: items.findIndex(item => item.id === saved?.id) + 1,
        });
        heading.append(title);
        if (saved && saved.id !== currentId) {
          const edit = element('button', 'cart-review-link', 'Dieses Design bearbeiten');
          edit.type = 'button';
          edit.addEventListener('click', () => onEdit(saved.id));
          heading.append(edit);
        }
        const effect = element('p', 'cart-review-effect', saved
          ? 'Ersetzt dieses Design im Warenkorb. Kein zusätzlicher Artikel.'
          : 'Wird als zusätzlicher Artikel in den Warenkorb gelegt.');
        const body = element('div');
        row.append(heading, effect, body);
        container.append(row);
        const loadRow = async () => {
          body.replaceChildren(element('p', 'cart-review-preview-status', 'Vergleich wird geladen…'));
          try {
            const previous = saved ? await load(saved.id, signal) : null;
            if (signal.aborted) return;
            body.replaceChildren();
            if (previous) {
              const summary = element('p', 'cart-review-changes');
              for (const source of changes(previous, draft)) summary.append(element('span', null, source));
              body.append(summary);
            }
            const previews = new Map();
            const selectedSide = pair(body, previous, draft, signal, previews);
            const enlarge = element('button', 'cart-review-link cart-review-enlarge', 'Vergleich vergrößern');
            enlarge.type = 'button';
            enlarge.addEventListener('click', () => {
              detailBody.replaceChildren();
              detailTitle.textContent = title.textContent;
              pair(detailBody, previous, draft, signal, previews, selectedSide());
              detailDialog.showModal();
              detailTitle.focus({ preventScroll: true });
            });
            body.append(enlarge);
          } catch {
            if (signal.aborted) return;
            const message = element('p', 'cart-review-preview-status', 'Vergleich konnte nicht geladen werden.');
            const retry = element('button', 'cart-review-link', 'Erneut versuchen');
            retry.type = 'button';
            retry.addEventListener('click', () => void loadRow());
            body.replaceChildren(message, retry);
          }
        };
        jobs.push(loadRow);
      }
      // At most two read-only snapshot requests at once, including large carts.
      const work = async () => { while (jobs.length && !signal.aborted) await jobs.shift()(); };
      void Promise.all([work(), work()]);
    }
    return { show, dispose };
  }
  return { create, changes, renderArtwork };
});
