(function (root) {
  'use strict';
  const t = source => root.WolkenworteI18n?.t(source) || source;
  function setText(element, source) {
    if (root.WolkenworteI18n) root.WolkenworteI18n.setText(element, source);
    else element.textContent = source;
  }

  class MobileCanvasWorkspace {
    constructor({ document, editor, workspace, onLayout, onEnter, onExit }) {
      Object.assign(this, { document, editor, workspace, onLayout, onEnter, onExit });
      this.dialog = document.getElementById('mobile-canvas-dialog');
      this.media = root.matchMedia('(max-width: 940px), (pointer: coarse)');
      this.mounts = [];
      this.view = 'canvas';
      this.tool = 'move';
      this.active = false;
      editor.onViewChange = zoom => { document.getElementById('mobile-canvas-fit').textContent = `${Math.round(zoom * 100)} %`; };
      this.dialog.addEventListener('cancel', event => {
        event.preventDefault();
        if (this.picker) this.closePicker();
        else this.close();
      });
      this.dialog.addEventListener('close', () => { if (this.active) this.close(); });
      this.dialog.addEventListener('pointerdown', event => {
        if (!event.target.closest('#mobile-canvas-stage')) editor.touchController?.finish();
      }, true);
      document.getElementById('mobile-canvas-close').addEventListener('click', () => this.close());
      document.getElementById('mobile-canvas-deselect').addEventListener('click', () => {
        editor.touchController?.finish();
        editor.clearSelection();
      });
      document.getElementById('mobile-canvas-panel-back').addEventListener('click', () => this.picker?.back());
      const fullscreen = document.getElementById('mobile-canvas-fullscreen');
      fullscreen.hidden = !document.fullscreenEnabled || typeof document.documentElement.requestFullscreen !== 'function';
      fullscreen.addEventListener('click', async () => {
        editor.touchController?.finish();
        try {
          if (document.fullscreenElement) await document.exitFullscreen();
          else {
            await document.documentElement.requestFullscreen({ navigationUI: 'hide' });
            this.ownsFullscreen = true;
            if (!this.active) { await document.exitFullscreen(); this.ownsFullscreen = false; }
          }
        } catch { fullscreen.hidden = true; }
      });
      document.addEventListener('fullscreenchange', () => {
        const enabled = Boolean(document.fullscreenElement);
        fullscreen.setAttribute('aria-pressed', String(enabled));
        const source = enabled ? 'Vollbild schließen' : 'Vollbild öffnen';
        if (root.WolkenworteI18n) root.WolkenworteI18n.setAttribute(fullscreen, 'aria-label', source);
        else fullscreen.setAttribute('aria-label', source);
        if (!enabled) this.ownsFullscreen = false;
        resize();
      });
      document.getElementById('mobile-canvas-panel-close').addEventListener('click', () => this.chooseTool('move'));
      document.getElementById('mobile-canvas-settings-toggle').addEventListener('click', () => this.chooseTool(this.tool === 'settings' ? 'move' : 'settings'));
      document.getElementById('mobile-canvas-fit').addEventListener('click', () => {
        editor.mobilePanX = editor.mobilePanY = 0;
        editor.setZoom(1);
      });
      document.getElementById('editor-mobile-open').addEventListener('click', event => this.open(event.currentTarget));
      this.dialog.querySelectorAll('[data-canvas-view]').forEach(button => button.addEventListener('click', () => this.chooseView(button.dataset.canvasView)));
      this.dialog.querySelectorAll('[data-canvas-tool]').forEach(button => button.addEventListener('click', () => this.chooseTool(button.dataset.canvasTool)));
      document.getElementById('mobile-canvas-search').addEventListener('input', () => this.renderElements());
      this.dialog.querySelectorAll('[data-canvas-emoji]').forEach(button => button.addEventListener('click', async () => {
        button.disabled = true;
        try {
          await editor.addEmoji(button.dataset.canvasEmoji);
          this.chooseTool('move');
        } catch { editor.setFeedback('Das Emoji konnte nicht geladen werden.'); }
        finally { button.disabled = false; }
      }));
      this.media.addEventListener('change', () => { if (!this.media.matches) this.close(); });
      const resize = () => {
        if (!this.active) return;
        // A viewport/orientation change ends the current contact sequence before
        // changing screen-to-print coordinates, keeping its single Undo entry.
        editor.touchController?.finish();
        requestAnimationFrame(() => this.onLayout());
      };
      root.addEventListener('resize', resize, { passive: true });
      root.visualViewport?.addEventListener('resize', resize, { passive: true });
      this.dialog.addEventListener('click', event => {
        if (event.target.closest('#editor-add')) this.chooseTool('properties');
      });
    }

    mount(node, host) {
      const anchor = this.document.createComment('mobile canvas return');
      node.before(anchor);
      this.mounts.push({ node, anchor });
      host.append(node);
    }

    open(invoker) {
      if (!this.media.matches || this.active) return false;
      this.workspace.close(false);
      this.editor.closeFontPicker();
      this.editor.closeIconPicker();
      this.invoker = invoker;
      this.onEnter?.();
      this.active = true;
      this.workspace.mobileCanvas = this;
      this.document.getElementById('mobile-editor-toggle').setAttribute('aria-expanded', 'true');
      const get = id => this.document.getElementById(id);
      this.mount(this.document.querySelector('.wrap-preview'), get('mobile-canvas-stage'));
      this.mount(get('product-stage'), get('mobile-canvas-product'));
      this.mount(get('editor-selection'), get('mobile-canvas-properties'));
      this.mount(this.document.querySelector('.design-toolbar-controls'), get('mobile-canvas-settings'));
      this.mount(this.document.querySelector('.editor-tools-history'), get('mobile-canvas-history'));
      this.mount(this.document.querySelector('.editor-tools-view'), get('mobile-canvas-zoom'));
      this.mount(get('surface-editor'), get('mobile-canvas-surfaces'));
      this.mount(this.document.querySelector('.editor-toolbar'), get('mobile-canvas-add'));
      this.document.documentElement.classList.add('mobile-canvas-open');
      this.dialog.showModal();
      this.editor.setMobileViewport(true);
      this.editor.clearSelection();
      this.chooseView('canvas');
      this.chooseTool('move');
      this.onLayout();
      return true;
    }

    close() {
      if (!this.active) return;
      this.editor.touchController?.finish();
      this.editor.closeFontPicker();
      this.editor.closeIconPicker();
      this.workspace.close(false);
      this.closePicker();
      if (this.ownsFullscreen && this.document.fullscreenElement) {
        this.document.exitFullscreen().catch(() => {});
        this.ownsFullscreen = false;
      }
      this.document.activeElement?.blur();
      this.active = false;
      for (const { node, anchor } of this.mounts.reverse()) { anchor.replaceWith(node); }
      this.mounts = [];
      this.editor.setMobileViewport(false);
      this.editor.mobileNavigation = false;
      this.document.documentElement.classList.remove('mobile-canvas-open');
      if (this.dialog.open) this.dialog.close();
      this.workspace.mountInspector();
      this.onExit?.();
      this.document.getElementById('mobile-editor-toggle').setAttribute('aria-expanded', 'false');
      this.onLayout();
      this.invoker?.focus({ preventScroll: true });
    }

    chooseView(view) {
      this.editor.touchController?.finish();
      this.view = view;
      this.dialog.dataset.view = view;
      this.document.getElementById('mobile-canvas-stage').hidden = view !== 'canvas';
      this.document.getElementById('mobile-canvas-product').hidden = view !== 'product';
      this.dialog.querySelectorAll('[data-canvas-view]').forEach(button => button.setAttribute('aria-pressed', String(button.dataset.canvasView === view)));
      this.chooseTool('move');
      this.updateSelection();
      requestAnimationFrame(() => this.onLayout());
    }

    chooseTool(tool) {
      const previous = this.tool;
      if (tool !== 'picker') this.closePicker();
      this.editor.touchController?.finish();
      this.editor.closeFontPicker();
      this.editor.closeIconPicker();
      this.tool = tool;
      this.editor.mobileNavigation = tool === 'view';
      const panel = ['settings', 'picker'].includes(tool) || (['properties', 'add', 'elements'].includes(tool) && this.view === 'canvas');
      this.document.getElementById('mobile-canvas-drawer').hidden = !panel;
      for (const name of ['properties', 'add', 'elements', 'settings', 'picker']) this.document.getElementById(`mobile-canvas-${name}`).hidden = name !== tool;
      this.document.getElementById('mobile-canvas-panel-back').hidden = tool !== 'picker';
      if (previous !== tool) this.dialog.querySelector('.mobile-canvas-drawer-content').scrollTop = 0;
      const titles = { properties: 'Anpassen', add: 'Element hinzufügen', elements: 'Element auswählen', settings: 'Produkt und Farben' };
      this.document.getElementById('mobile-canvas-settings-toggle').setAttribute('aria-expanded', String(tool === 'settings'));
      setText(this.document.getElementById('mobile-canvas-panel-title'), titles[tool] || 'Anpassen');
      this.dialog.querySelectorAll('[data-canvas-tool]').forEach(button => button.setAttribute('aria-pressed', String(button.dataset.canvasTool === tool)));
      if (tool === 'elements') this.renderElements();
      this.updateHint();
    }

    showPicker(panel, close, back = close) {
      const returnTool = this.tool;
      this.chooseTool('picker');
      const anchor = this.document.createComment('mobile picker return');
      panel.before(anchor);
      this.picker = { panel, anchor, close, back, returnTool };
      panel.dataset.presentation = 'embedded';
      this.document.getElementById('mobile-canvas-picker').append(panel);
      const title = panel.querySelector('h2');
      setText(this.document.getElementById('mobile-canvas-panel-title'), title.getAttribute('data-i18n-source') || title.textContent);
    }

    closePicker() {
      if (!this.picker) return;
      const { panel, close } = this.picker;
      close();
      this.restorePicker(panel);
    }

    restorePicker(panel) {
      if (this.picker?.panel !== panel) return;
      const { anchor, returnTool } = this.picker;
      this.picker = null;
      anchor.replaceWith(panel);
      delete panel.dataset.presentation;
      delete panel.dataset.mobileStep;
      this.chooseTool(returnTool);
    }

    openTextEditor() {
      if (!this.active) return false;
      this.chooseView('canvas');
      this.chooseTool('properties');
      const input = this.document.getElementById('editor-text');
      if (input.disabled) return false;
      input.focus({ preventScroll: true });
      input.select();
      return true;
    }

    updateSelection() {
      if (!this.active) return;
      if (this.tool === 'elements') this.renderElements();
      const objects = this.editor.selectedObjects();
      this.document.getElementById('mobile-canvas-selection').hidden = !objects.length || this.view !== 'canvas';
      this.document.getElementById('mobile-canvas-selected-name').textContent = objects.length === 1
        ? this.elementLabel(objects[0]) : t('Mehrere Elemente');
      this.updateHint();
    }

    elementLabel(object) {
      return object.editorKind === 'image' ? t('Bild') : object.editorKind === 'icon'
        ? t(object.editorIconLabel) : this.editor.objectText(object);
    }

    updateHint() {
      const wide = this.editor.width / this.editor.height > 1.5 && root.innerHeight > root.innerWidth;
      setText(this.document.getElementById('mobile-canvas-hint'), this.tool === 'view'
        ? 'Ansicht: mit einem Finger verschieben, mit zwei Fingern zoomen'
        : this.editor.selectedObjects().length ? 'Auswahl gesperrt · Überall bewegen, vergrößern und drehen'
        : wide ? 'Handy quer halten · Element antippen oder mit zwei Fingern zoomen'
        : 'Element antippen · Zwei Finger zoomen die Ansicht');
    }

    renderElements() {
      const list = this.document.getElementById('mobile-canvas-element-list');
      const search = this.document.getElementById('mobile-canvas-search').value.toLocaleLowerCase();
      const active = this.editor.selectedObjects();
      list.replaceChildren();
      for (const object of this.editor.canvas.getObjects()) {
        const label = this.elementLabel(object);
        if (!label.toLocaleLowerCase().includes(search)) continue;
        const button = this.document.createElement('button');
        button.type = 'button';
        button.textContent = label;
        button.setAttribute('aria-pressed', String(active.includes(object)));
        button.disabled = active.length > 0 && !active.includes(object);
        button.addEventListener('click', () => {
          if (active.includes(object)) { this.editor.clearSelection(); return; }
          if (this.editor.selectedObjects().length) return;
          this.editor.canvas.setActiveObject(object);
          this.editor.updateSelectionPanel();
          this.editor.canvas.requestRenderAll();
          this.chooseTool('move');
          // Bring a small word into reach without changing the print design.
          this.editor.setZoom(Math.max(this.editor.zoom, 2));
          const center = object.getCenterPoint();
          this.editor.mobilePanX = (.5 - center.x / this.editor.canvasWidth) * this.editor.shell.clientWidth;
          this.editor.mobilePanY = (.5 - center.y / this.editor.canvasHeight) * this.editor.shell.clientHeight;
          this.editor.refreshViewport();
        });
        list.append(button);
      }
    }
  }
  root.MobileCanvasWorkspace = MobileCanvasWorkspace;
  if (typeof module === 'object' && module.exports) module.exports = { MobileCanvasWorkspace };
})(typeof window === 'object' ? window : globalThis);
