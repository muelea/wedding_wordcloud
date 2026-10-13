(function (root) {
  'use strict';
  const t = source => root.WolkenworteI18n?.t(source) || source;
  function setText(element, source, params = {}) {
    if (root.WolkenworteI18n) root.WolkenworteI18n.setText(element, source, params);
    else element.textContent = source.replace(/\{\{(\w+)\}\}/g, (_, name) => params[name]);
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
        if (this.keyboardSession) this.closeKeyboardEditor({ cancel: true });
        else if (this.picker) this.closePicker();
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
      document.getElementById('mobile-canvas-multi-select').addEventListener('click', () => this.chooseTool('multi'));
      document.getElementById('mobile-canvas-multi-done').addEventListener('click', () => this.chooseTool('move'));
      document.getElementById('mobile-canvas-panel-back').addEventListener('click', () => {
        if (this.picker) this.picker.back();
        else this.chooseTool('more');
      });
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
      document.getElementById('editor-text').addEventListener('click', () => { if (this.active) this.openTextEditor(); });
      for (const [id, kind] of [['editor-angle', 'rotation'], ['editor-font-size', 'font-size']]) {
        const field = document.getElementById(id);
        for (const event of ['focus', 'click']) field.addEventListener(event, () => this.openNumericEditor(kind));
      }
      document.getElementById('mobile-canvas-text-cancel').addEventListener('click', () => this.closeKeyboardEditor({ cancel: true }));
      document.getElementById('mobile-canvas-text-editor').addEventListener('submit', event => {
        event.preventDefault();
        this.saveKeyboardEditor();
      });
      document.getElementById('mobile-canvas-text').addEventListener('input', () => {
        this.setKeyboardError();
        this.updateKeyboardSearch();
      });
      document.getElementById('mobile-canvas-text').addEventListener('keydown', event => {
        if (event.key !== 'Escape') return;
        event.preventDefault(); event.stopPropagation();
        this.closeKeyboardEditor({ cancel: true });
      });
      this.media.addEventListener('change', () => { if (!this.media.matches) this.close(); });
      const resize = () => {
        if (!this.active) return;
        this.syncViewport();
        this.placeOverlapTrigger();
        // A viewport/orientation change ends the current contact sequence before
        // changing screen-to-print coordinates, keeping its single Undo entry.
        editor.touchController?.finish();
        if (!this.keyboardSession) requestAnimationFrame(() => this.onLayout());
      };
      root.addEventListener('resize', resize, { passive: true });
      root.visualViewport?.addEventListener('resize', resize, { passive: true });
      root.visualViewport?.addEventListener('scroll', resize, { passive: true });
      root.addEventListener('orientationchange', resize, { passive: true });
      root.screen?.orientation?.addEventListener('change', resize);
      this.dialog.addEventListener('focusin', event => {
        if (this.active && !this.keyboardSession) {
          if (event.target.id === 'mobile-canvas-search') this.openSearchEditor('elements', event.target);
          else if (event.target === this.emojiPicker?.picker.searchInput) this.openSearchEditor('emoji', event.target);
        }
        this.syncViewport();
      });
      this.dialog.addEventListener('focusout', () => requestAnimationFrame(() => this.syncViewport()));
      if (root.ResizeObserver) this.viewportObserver = new root.ResizeObserver(resize);
    }

    mount(node, host) {
      const anchor = this.document.createComment('mobile canvas return');
      node.before(anchor);
      this.mounts.push({ node, anchor });
      host.append(node);
    }

    open(invoker) {
      if (!root.WolkenworteDevice?.isMobileDevice(root.navigator) || !this.media.matches || this.active) return false;
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
      this.mount(get('editor-overlap-trigger'), get('mobile-canvas-overlaps'));
      this.placeOverlapTrigger();
      this.mount(get('surface-editor'), get('mobile-canvas-surfaces'));
      this.mount(this.document.querySelector('.editor-tools-primary'), get('mobile-canvas-add'));
      for (const group of ['selection', 'layout', 'reset']) {
        this.mount(this.document.querySelector(`.editor-tools-${group}`), get('mobile-canvas-design-actions'));
      }
      this.keyboardFields = ['editor-text', 'editor-angle', 'editor-font-size'].map(id => ({ field: get(id), readOnly: get(id).readOnly }));
      for (const { field } of this.keyboardFields) field.readOnly = true;
      this.document.documentElement.classList.add('mobile-canvas-open');
      this.dialog.showModal();
      this.viewportObserver?.observe(this.dialog.querySelector('.mobile-canvas-body'));
      this.syncViewport();
      this.editor.setMobileViewport(true);
      this.editor.clearSelection();
      this.chooseView('canvas');
      this.chooseTool('move');
      this.onLayout();
      return true;
    }

    close() {
      if (!this.active) return;
      this.closeKeyboardEditor();
      this.closeEmojiPicker();
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
      this.viewportObserver?.disconnect();
      this.editor.mobileMultiSelect = false;
      for (const { node, anchor } of this.mounts.reverse()) { anchor.replaceWith(node); }
      this.mounts = [];
      for (const { field, readOnly } of this.keyboardFields) field.readOnly = readOnly;
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

    placeOverlapTrigger() {
      // Narrow phones keep the 44px history, zoom and deselect controls in one
      // row. Move the same warning button to the rail instead of shrinking taps.
      const host = this.document.getElementById(root.innerWidth <= 480
        ? 'mobile-canvas-overlap-rail' : 'mobile-canvas-overlaps');
      host.append(this.document.getElementById('editor-overlap-trigger'));
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
      this.closeKeyboardEditor();
      const previous = this.tool;
      if (tool !== 'emoji') this.closeEmojiPicker();
      if (tool !== 'picker') this.closePicker();
      this.editor.touchController?.finish();
      this.editor.closeFontPicker();
      this.editor.closeIconPicker();
      this.tool = tool;
      this.dialog.dataset.tool = tool;
      this.editor.mobileMultiSelect = tool === 'multi';
      this.editor.mobileNavigation = tool === 'view';
      const panel = ['settings', 'picker'].includes(tool) || (['properties', 'add', 'elements', 'more', 'emoji'].includes(tool) && this.view === 'canvas');
      this.document.getElementById('mobile-canvas-drawer').hidden = !panel;
      for (const name of ['properties', 'add', 'elements', 'more', 'emoji', 'settings', 'picker']) this.document.getElementById(`mobile-canvas-${name}`).hidden = name !== tool;
      this.document.getElementById('mobile-canvas-panel-back').hidden = !['picker', 'elements'].includes(tool);
      if (previous !== tool) this.dialog.querySelector('.mobile-canvas-drawer-content').scrollTop = 0;
      const titles = { properties: 'Anpassen', add: 'Element hinzufügen', elements: 'Element suchen', more: 'Mehr', emoji: 'Emoji auswählen', settings: 'Produkt und Farben' };
      this.document.getElementById('mobile-canvas-settings-toggle').setAttribute('aria-expanded', String(tool === 'settings'));
      setText(this.document.getElementById('mobile-canvas-panel-title'), titles[tool] || 'Anpassen');
      this.dialog.querySelectorAll('[data-canvas-tool]').forEach(button => button.setAttribute('aria-pressed', String(button.dataset.canvasTool === tool)));
      if (tool === 'elements') this.renderElements();
      this.updateSelection();
    }

    showPicker(panel, close, back = close) {
      const returnTool = this.tool;
      this.chooseTool('picker');
      const anchor = this.document.createComment('mobile picker return');
      panel.before(anchor);
      this.picker = { panel, anchor, close, back, returnTool };
      if (panel.id === 'theme-panel') {
        panel.dataset.mobileStep = 'palettes';
        this.picker.back = () => {
          if (panel.dataset.mobileStep !== 'custom') { back(); return; }
          panel.dataset.mobileStep = 'palettes';
          setText(this.document.getElementById('mobile-canvas-panel-title'), 'Farbwelt');
          panel.querySelector('.config-panel-body').scrollTop = 0;
        };
      }
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

    openCustomColors(panel) {
      if (!this.active || this.picker?.panel !== panel) return;
      panel.dataset.mobileStep = 'custom';
      setText(this.document.getElementById('mobile-canvas-panel-title'), 'Eure Farben');
      panel.querySelector('.config-panel-body').scrollTop = 0;
    }

    openTextEditor() {
      if (!this.active) return false;
      const objects = this.editor.selectedObjects();
      if (objects.length !== 1 || objects[0].editorKind !== 'text') return false;
      return this.openKeyboardEditor({ kind: 'word', object: objects[0], label: 'Wort bearbeiten',
        value: this.editor.objectText(objects[0]) });
    }

    openNumericEditor(kind) {
      if (!this.active) return false;
      const source = this.document.getElementById(kind === 'rotation' ? 'editor-angle' : 'editor-font-size');
      if (source.disabled || !this.editor.selectedObjects().length) return false;
      return this.openKeyboardEditor({ kind, source, value: source.value,
        label: kind === 'rotation' ? 'Drehung' : 'Schriftgröße', unit: kind === 'rotation' ? '°' : 'pt' });
    }

    openSearchEditor(kind, source) {
      const results = kind === 'emoji' ? this.emojiPicker?.picker.panel : this.document.getElementById('mobile-canvas-element-list');
      return this.openKeyboardEditor({ kind, source, results, value: source.value,
        label: kind === 'emoji' ? 'Emojis suchen' : 'Element suchen', search: true });
    }

    openKeyboardEditor(session) {
      if (!this.active) return false;
      if (this.keyboardSession) return this.keyboardSession.kind === session.kind;
      this.editor.touchController?.finish();
      session.selectedIds = this.editor.selectedObjects().map(object => object.editorId);
      session.originalValue = session.value;
      this.keyboardSession = session;
      this.dialog.dataset.entry = session.kind;
      this.dialog.toggleAttribute('data-entry-search', Boolean(session.search));
      const input = this.document.getElementById('mobile-canvas-text');
      input.type = session.search ? 'search' : 'text';
      input.inputMode = session.unit ? 'decimal' : 'text';
      input.spellcheck = session.kind === 'word';
      input.autocapitalize = session.kind === 'word' ? 'sentences' : 'none';
      input.maxLength = session.unit ? 32 : 1024;
      input.value = session.value;
      const form = this.document.getElementById('mobile-canvas-text-editor');
      if (root.WolkenworteI18n) root.WolkenworteI18n.setAttribute(form, 'aria-label', session.label);
      else form.setAttribute('aria-label', session.label);
      setText(this.document.getElementById('mobile-canvas-entry-label'), session.label);
      const unit = this.document.getElementById('mobile-canvas-entry-unit');
      unit.textContent = session.unit || '';
      unit.hidden = !session.unit;
      this.setKeyboardError();
      this.document.getElementById('mobile-canvas-text-done').disabled = false;
      this.document.getElementById('mobile-canvas-text-cancel').disabled = false;
      const host = this.document.getElementById('mobile-canvas-keyboard-results');
      host.hidden = !session.search;
      if (session.results) {
        session.anchor = this.document.createComment('keyboard results return');
        session.results.before(session.anchor);
        host.append(session.results);
      }
      this.document.getElementById('mobile-canvas-text-editor').hidden = false;
      this.syncViewport();
      input.focus({ preventScroll: true });
      input.select();
      return true;
    }

    setKeyboardError(message = '') {
      const error = this.document.getElementById('mobile-canvas-entry-error');
      error.textContent = message;
      error.hidden = !message;
      this.document.getElementById('mobile-canvas-entry-label').hidden = Boolean(message);
      this.document.getElementById('mobile-canvas-text').setAttribute('aria-invalid', String(Boolean(message)));
    }

    updateKeyboardSearch(value = this.document.getElementById('mobile-canvas-text').value) {
      const session = this.keyboardSession;
      if (!session?.search) return;
      session.source.value = value;
      session.source.dispatchEvent(new this.document.defaultView.Event('input', { bubbles: true }));
    }

    async saveKeyboardEditor() {
      const session = this.keyboardSession;
      if (!session || session.saving) return false;
      if (session.search) { this.closeKeyboardEditor(); return true; }
      const value = this.document.getElementById('mobile-canvas-text').value;
      const number = value.trim() ? Number(value.replace(',', '.')) : NaN;
      if (session.unit && (!Number.isFinite(number) || (session.kind === 'font-size' && number < 1))) {
        this.setKeyboardError(t(session.kind === 'rotation' ? 'Bitte gebt eine gültige Drehung ein.' : 'Bitte gebt eine gültige Schriftgröße ein.'));
        return false;
      }
      // Apply only to the selection that opened the field, including mixed groups.
      if (JSON.stringify(session.selectedIds) !== JSON.stringify(this.editor.selectedObjects().map(object => object.editorId))) {
        this.closeKeyboardEditor(); return false;
      }
      session.saving = true;
      const done = this.document.getElementById('mobile-canvas-text-done');
      const cancel = this.document.getElementById('mobile-canvas-text-cancel');
      done.disabled = cancel.disabled = true;
      try {
        if (session.kind === 'word') await this.editor.applyTextChange(session.object, value, { finalize: true, record: true });
        else if (session.kind === 'rotation') this.editor.setActiveAngle(number);
        else if (!this.editor.setActiveFontSize(number) &&
          session.source.value !== this.editor.displayPointSize(number)) {
          this.setKeyboardError(this.editor.feedback.textContent || t('Diese Schriftgröße passt nicht auf die aktuelle Druckfläche.'));
          return false;
        }
        if (this.keyboardSession !== session) return true;
        this.editor.updateSelectionPanel();
        this.closeKeyboardEditor();
        return true;
      } catch {
        if (this.keyboardSession === session) this.setKeyboardError(t('Das Emoji konnte nicht geladen werden.'));
        return false;
      } finally {
        session.saving = false;
        if (!this.keyboardSession || this.keyboardSession === session) done.disabled = cancel.disabled = false;
      }
    }

    closeKeyboardEditor({ cancel = false } = {}) {
      const session = this.keyboardSession;
      if (!session || (cancel && session.saving)) return;
      if (cancel && session.search) this.updateKeyboardSearch(session.originalValue);
      this.document.getElementById('mobile-canvas-text').blur();
      if (session.anchor) session.anchor.replaceWith(session.results);
      this.keyboardSession = null;
      delete this.dialog.dataset.entry;
      this.dialog.removeAttribute('data-entry-search');
      this.document.getElementById('mobile-canvas-keyboard-results').hidden = true;
      this.document.getElementById('mobile-canvas-text-editor').hidden = true;
      this.syncViewport();
      requestAnimationFrame(() => { if (this.active) this.onLayout(); });
    }

    syncViewport() {
      const viewport = root.visualViewport;
      const field = this.document.activeElement;
      // Ordinary editing uses CSS dynamic viewport units. Safari can briefly
      // retain the previous orientation's visualViewport values; use them only
      // for an active keyboard field, including its scroll offset.
      const keyboard = Boolean(this.keyboardSession || (this.dialog.contains(field) && !field.readOnly &&
        field.matches('textarea, input[type="text"], input[type="search"], input[type="number"]')));
      this.dialog.toggleAttribute('data-keyboard', keyboard);
      this.dialog.style.setProperty('--mobile-viewport-top', `${viewport?.offsetTop || 0}px`);
      this.dialog.style.setProperty('--mobile-viewport-left', `${viewport?.offsetLeft || 0}px`);
      this.dialog.style.setProperty('--mobile-viewport-width', `${viewport?.width || root.innerWidth}px`);
      this.dialog.style.setProperty('--mobile-viewport-height', `${viewport?.height || root.innerHeight}px`);
      if (this.keyboardSession?.kind === 'emoji') requestAnimationFrame(() => this.emojiPicker?.picker.renderVirtualWindow({ force: true }));
    }

    openEmojiPicker(picker) {
      if (!this.active) return;
      this.chooseTool('emoji');
      const anchor = this.document.createComment('mobile emoji return');
      picker.panel.before(anchor);
      this.emojiPicker = { picker, anchor };
      this.document.getElementById('mobile-canvas-emoji').append(picker.panel);
    }

    closeEmojiPicker() {
      if (!this.emojiPicker) return;
      this.closeKeyboardEditor();
      const { picker, anchor } = this.emojiPicker;
      this.emojiPicker = null;
      picker.close();
      anchor.replaceWith(picker.panel);
    }

    emojiClosed() {
      if (!this.emojiPicker) return;
      this.closeEmojiPicker();
      this.chooseTool('add');
    }

    updateSelection() {
      if (!this.active) return;
      if (this.tool === 'elements') this.renderElements();
      const objects = this.editor.selectedObjects();
      const multi = this.editor.mobileMultiSelect === true;
      this.document.getElementById('mobile-canvas-selection').hidden = (!objects.length && !multi) || this.view !== 'canvas';
      this.document.getElementById('mobile-canvas-deselect').hidden = multi;
      const done = this.document.getElementById('mobile-canvas-multi-done');
      done.hidden = !multi;
      setText(done, 'Fertig ({{count}})', { count: objects.length });
    }

    elementLabel(object) {
      return object.editorKind === 'image' ? t('Bild') : object.editorKind === 'icon'
        ? t(object.editorIconLabel) : this.editor.objectText(object);
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
