(function (root) {
  'use strict';
  class ArtworkOverlapWarnings {
    constructor({ document, editor, workspace, getSurfaces, selectSurface }) {
      Object.assign(this, { document, editor, workspace, getSurfaces, selectSurface });
      this.trigger = document.getElementById('editor-overlap-trigger');
      this.count = document.getElementById('editor-overlap-count');
      this.list = document.getElementById('editor-overlap-list');
      this.status = document.getElementById('editor-overlap-status');
      this.generation = 0;
      this.results = [];
      this.checker = root.ArtworkOverlap.create({
        createCanvas: (width, height) => Object.assign(document.createElement('canvas'), { width, height }),
        assets: { image: src => editor.getImageElement(src), emojiImage: run => root.WolkenworteEmoji.getLoadedImage(run) },
      });
      root.addEventListener('wolkenworte:localechange', () => this.render());
      for (const event of ['close', 'toggle']) document.getElementById('editor-overlap-panel')
        .addEventListener(event, () => requestAnimationFrame(() => this.render()));
      root.addEventListener('pagehide', () => { ++this.generation; clearTimeout(this.timer); this.fingerprint = null; });
    }

    text(element, source, params = {}) {
      if (root.WolkenworteI18n) root.WolkenworteI18n.setText(element, source, params);
      else element.textContent = source.replace(/\{\{(\w+)\}\}/g, (_, key) => params[key] ?? '');
    }

    schedule() {
      const surfaces = this.getSurfaces();
      const fingerprint = JSON.stringify(surfaces.map(surface => [surface.key, surface.design.map(item => this.checker.key(item))]));
      if (fingerprint === this.fingerprint) return;
      this.fingerprint = fingerprint;
      const generation = ++this.generation;
      clearTimeout(this.timer);
      this.results = [];
      this.state = 'checking';
      this.render();
      this.timer = setTimeout(async () => {
        const results = [];
        try {
          for (const surface of surfaces) {
            const result = await this.checker.check(surface.design, { cancelled: () => generation !== this.generation });
            if (!result || generation !== this.generation) return;
            results.push({ ...surface, ...result });
          }
          if (generation !== this.generation) return;
          this.results = results;
          this.state = 'ready';
        } catch {
          if (generation !== this.generation) return;
          this.state = 'error';
          // Permit a retry on the next render after assets have recovered.
          this.fingerprint = null;
        }
        this.render();
      }, 180);
    }

    label(item) {
      const t = source => root.WolkenworteI18n?.t(source) || source;
      return item.type === 'image' ? t('Bild') : item.type === 'icon' ? t(root.MugIcons.get(item.icon).label)
        : item.text;
    }

    render() {
      const total = this.results.reduce((count, result) => count + result.findings.length, 0);
      const truncated = this.results.some(result => result.truncated);
      // Keep an open list usable while it refreshes, including its close button.
      this.trigger.hidden = total === 0 && this.state !== 'error' && this.workspace.active?.panel !== this.document.getElementById('editor-overlap-panel');
      this.count.textContent = this.state === 'checking' ? '…' : this.state === 'error' ? '?' : `${total}${truncated ? '+' : ''}`;
      const source = total ? '{{count}} Überlagerungen prüfen' : 'Überlagerungen prüfen';
      const params = { count: `${total}${truncated ? '+' : ''}` };
      this.trigger.setAttribute('aria-label', root.WolkenworteI18n?.t(source, params)
        || source.replace('{{count}}', params.count));
      this.list.setAttribute('aria-busy', String(this.state === 'checking'));
      this.text(this.status, this.state === 'checking' ? 'Überlagerungen werden geprüft…'
        : this.state === 'error' ? 'Überlagerungen konnten nicht geprüft werden. Bitte verändert ein Element oder öffnet das Design erneut.'
        : total ? 'Diese Elemente überlagern sich. Wenn das beabsichtigt ist, könnt ihr euer Design so bestellen.'
        : 'Keine Überlagerungen gefunden.');
      this.list.replaceChildren();
      for (const surface of this.results) {
        for (const finding of surface.findings) {
          const items = finding.ids.map(id => surface.design.find(item => item.id === id));
          if (items.some(item => !item)) continue;
          const row = this.document.createElement('div');
          row.className = 'artwork-overlap-finding';
          const heading = this.document.createElement('strong');
          this.text(heading, '{{first}} überlagert {{second}}', { first: this.label(items[0]), second: this.label(items[1]) });
          row.append(heading);
          if (this.results.length > 1) {
            const side = this.document.createElement('span');
            this.text(side, surface.label);
            row.append(side);
          }
          for (const item of items) {
            const button = this.document.createElement('button');
            button.type = 'button';
            button.dataset.elementId = item.id;
            button.dataset.surfaceKey = surface.key;
            this.text(button, '{{element}} auswählen', { element: this.label(item) });
            button.addEventListener('click', () => this.navigate(surface.key, item.id, finding.ids));
            row.append(button);
          }
          this.list.append(row);
        }
        if (surface.truncated) {
          const note = this.document.createElement('p');
          this.text(note, 'Weitere Überlagerungen werden nach dem Bearbeiten angezeigt.');
          this.list.append(note);
        }
      }
    }

    navigate(surfaceKey, id, ids) {
      if (!this.getSurfaces().find(surface => surface.key === surfaceKey)?.design.some(item => item.id === id)) return;
      this.editor.touchController?.finish();
      this.workspace.close(false);
      this.selectSurface(surfaceKey, { announce: false });
      const mobile = this.workspace.mobileCanvas;
      if (mobile?.active) mobile.chooseView('canvas');
      requestAnimationFrame(() => this.editor.focusArtworkElement(id, ids));
    }
  }
  root.ArtworkOverlapWarnings = ArtworkOverlapWarnings;
  if (typeof module === 'object' && module.exports) module.exports = { ArtworkOverlapWarnings };
})(typeof window === 'object' ? window : globalThis);
