(function (root) {
  'use strict';

  const EDITOR_SCALE = .5;
  const PRINT_MARGIN = 24;
  const MIN_PRINT_FONT_SIZE = 12;
  const MAX_HISTORY = 60;

  function round(value) {
    return Math.round(value * 10) / 10;
  }

  function cloneDesign(design) {
    return design.map((item) => ({ ...item }));
  }

  class MugPrintEditor {
    constructor(options) {
      if (!root.fabric) throw new Error('Fabric.js is required for the mug editor');
      this.width = options.printWidth;
      this.height = options.printHeight;
      this.canvasWidth = this.width * EDITOR_SCALE;
      this.canvasHeight = this.height * EDITOR_SCALE;
      this.margin = PRINT_MARGIN * EDITOR_SCALE;
      this.palette = options.palette || ['#8f3a58'];
      this.onChange = options.onChange || (() => {});
      this.onReset = options.onReset || (() => {});
      this.shell = options.shell;
      this.scroll = options.scroll;
      this.selectionPanel = options.selectionPanel;
      this.textInput = options.textInput;
      this.swatches = options.swatches;
      this.zoomLabel = options.zoomLabel;
      this.feedback = options.feedback;
      this.history = [];
      this.historyIndex = -1;
      this.suspended = false;
      this.changeFrame = null;
      this.zoom = 1;
      this.idCounter = 0;

      this.canvas = new root.fabric.Canvas(options.canvas, {
        width: this.canvasWidth,
        height: this.canvasHeight,
        selection: false,
        preserveObjectStacking: true,
        stopContextMenu: true,
        fireRightClick: false,
      });
      this.canvas.backgroundColor = '#ffffff';
      this.canvas.renderAll();
      this.bindCanvasEvents();
      this.bindControls(options);
      this.renderSwatches();
      this.setZoom(1);
    }

    makeObject(item) {
      const text = new root.fabric.FabricText(item.text, {
        left: item.x * EDITOR_SCALE,
        top: item.y * EDITOR_SCALE,
        originX: 'center',
        originY: 'center',
        fontFamily: 'Georgia',
        fontSize: Math.max(MIN_PRINT_FONT_SIZE * EDITOR_SCALE, item.fontSize * EDITOR_SCALE),
        fill: item.color,
        angle: item.angle || 0,
        lockScalingFlip: true,
        centeredScaling: true,
        centeredRotation: true,
        transparentCorners: false,
        cornerColor: '#ffffff',
        cornerStrokeColor: '#9c1c4c',
        borderColor: '#9c1c4c',
        cornerStyle: 'circle',
        cornerSize: 14,
        touchCornerSize: 28,
        padding: 3,
      });
      text.editorId = item.id || this.nextId();
      text.setControlsVisibility({ mt: false, mb: false, ml: false, mr: false });
      text.setCoords();
      return text;
    }

    nextId() {
      this.idCounter += 1;
      return `wort-${Date.now().toString(36)}-${this.idCounter}`;
    }

    bindCanvasEvents() {
      this.canvas.on('selection:created', () => this.updateSelectionPanel());
      this.canvas.on('selection:updated', () => this.updateSelectionPanel());
      this.canvas.on('selection:cleared', () => this.updateSelectionPanel());
      this.canvas.on('object:moving', (event) => this.handleTransform(event.target));
      this.canvas.on('object:scaling', (event) => this.handleTransform(event.target));
      this.canvas.on('object:rotating', (event) => this.handleTransform(event.target));
      this.canvas.on('object:modified', (event) => {
        this.absorbScale(event.target);
        this.keepInside(event.target);
        this.canvas.requestRenderAll();
        this.recordHistory();
        this.emitChange();
        this.updateSelectionPanel();
      });

      this.canvas.on('mouse:dblclick', (event) => {
        if (!event.target) return;
        this.canvas.setActiveObject(event.target);
        this.updateSelectionPanel();
        this.textInput.focus();
        this.textInput.select();
      });
    }

    bindControls(options) {
      options.addButton.addEventListener('click', () => this.addWord());
      options.undoButton.addEventListener('click', () => this.undo());
      options.redoButton.addEventListener('click', () => this.redo());
      options.resetButton.addEventListener('click', () => this.onReset());
      options.zoomOutButton.addEventListener('click', () => this.setZoom(this.zoom - .25));
      options.zoomInButton.addEventListener('click', () => this.setZoom(this.zoom + .25));
      options.smallerButton.addEventListener('click', () => this.resizeActive(.9));
      options.largerButton.addEventListener('click', () => this.resizeActive(1.1));
      options.rotateLeftButton.addEventListener('click', () => this.rotateActive(-15));
      options.rotateRightButton.addEventListener('click', () => this.rotateActive(15));
      options.duplicateButton.addEventListener('click', () => this.duplicateActive());
      options.deleteButton.addEventListener('click', () => this.deleteActive());

      this.textInput.addEventListener('input', () => {
        const active = this.canvas.getActiveObject();
        const text = this.textInput.value.normalize('NFC').replace(/[\x00-\x1f\x7f]/g, '').slice(0, 30);
        if (!active || !text.trim()) return;
        active.set({ text: text.trim() });
        this.keepInside(active);
        active.setCoords();
        this.canvas.requestRenderAll();
        this.emitChange();
      });
      this.textInput.addEventListener('change', () => {
        const active = this.canvas.getActiveObject();
        if (!active) return;
        this.textInput.value = active.text;
        this.recordHistory();
      });
      this.textInput.addEventListener('blur', () => {
        const active = this.canvas.getActiveObject();
        if (active && !this.textInput.value.trim()) this.textInput.value = active.text;
      });
      options.colorInput.addEventListener('input', () => this.setActiveColor(options.colorInput.value));
      this.colorInput = options.colorInput;

      document.addEventListener('keydown', (event) => {
        const editingField = /^(INPUT|TEXTAREA|SELECT)$/.test(document.activeElement?.tagName || '');
        const command = event.metaKey || event.ctrlKey;
        if (command && event.key.toLowerCase() === 'z') {
          event.shiftKey ? this.redo() : this.undo();
          event.preventDefault();
          return;
        }
        if (command && event.key.toLowerCase() === 'y') {
          this.redo();
          event.preventDefault();
          return;
        }
        if (!editingField && (event.key === 'Delete' || event.key === 'Backspace')) {
          this.deleteActive();
          event.preventDefault();
        }
      });

      this.undoButton = options.undoButton;
      this.redoButton = options.redoButton;
    }

    setDesign(design, { resetHistory = false, record = false } = {}) {
      this.suspended = true;
      this.canvas.discardActiveObject();
      for (const object of [...this.canvas.getObjects()]) this.canvas.remove(object);
      for (const item of design) this.canvas.add(this.makeObject(item));
      this.canvas.requestRenderAll();
      this.suspended = false;
      this.updateSelectionPanel();
      if (resetHistory) {
        this.history = [JSON.stringify(this.getDesign())];
        this.historyIndex = 0;
        this.updateHistoryButtons();
      } else if (record) {
        this.recordHistory();
      }
      this.emitChange();
    }

    getDesign() {
      return this.canvas.getObjects().map((object) => ({
        id: object.editorId,
        text: object.text,
        x: round(object.left / EDITOR_SCALE),
        y: round(object.top / EDITOR_SCALE),
        fontSize: round(object.fontSize * object.scaleX / EDITOR_SCALE),
        angle: round(object.angle || 0),
        color: String(object.fill).toLowerCase(),
      }));
    }

    handleTransform(object) {
      if (!object) return;
      this.keepInside(object);
      this.emitChange();
    }

    absorbScale(object) {
      if (!object) return;
      const nextSize = Math.max(MIN_PRINT_FONT_SIZE * EDITOR_SCALE, object.fontSize * object.scaleX);
      object.set({ fontSize: nextSize, scaleX: 1, scaleY: 1 });
      object.setCoords();
    }

    keepInside(object) {
      if (!object) return;
      object.setCoords();
      let bounds = object.getBoundingRect();
      const availableWidth = this.canvasWidth - this.margin * 2;
      const availableHeight = this.canvasHeight - this.margin * 2;
      if (bounds.width > availableWidth || bounds.height > availableHeight) {
        const factor = Math.min(availableWidth / bounds.width, availableHeight / bounds.height);
        object.scaleX *= factor;
        object.scaleY *= factor;
        object.setCoords();
        bounds = object.getBoundingRect();
        this.flashBoundary();
      }

      let deltaX = 0;
      let deltaY = 0;
      if (bounds.left < this.margin) deltaX = this.margin - bounds.left;
      if (bounds.left + bounds.width > this.canvasWidth - this.margin) {
        deltaX = this.canvasWidth - this.margin - bounds.left - bounds.width;
      }
      if (bounds.top < this.margin) deltaY = this.margin - bounds.top;
      if (bounds.top + bounds.height > this.canvasHeight - this.margin) {
        deltaY = this.canvasHeight - this.margin - bounds.top - bounds.height;
      }
      if (deltaX || deltaY) {
        object.set({ left: object.left + deltaX, top: object.top + deltaY });
        object.setCoords();
        this.flashBoundary();
      }
    }

    flashBoundary() {
      this.shell.classList.remove('boundary-hit');
      void this.shell.offsetWidth;
      this.shell.classList.add('boundary-hit');
      clearTimeout(this.boundaryTimer);
      this.boundaryTimer = setTimeout(() => this.shell.classList.remove('boundary-hit'), 500);
    }

    emitChange() {
      if (this.suspended || this.changeFrame) return;
      this.changeFrame = requestAnimationFrame(() => {
        this.changeFrame = null;
        this.onChange(cloneDesign(this.getDesign()));
      });
    }

    recordHistory() {
      if (this.suspended) return;
      const snapshot = JSON.stringify(this.getDesign());
      if (this.history[this.historyIndex] === snapshot) return;
      this.history.splice(this.historyIndex + 1);
      this.history.push(snapshot);
      if (this.history.length > MAX_HISTORY) this.history.shift();
      this.historyIndex = this.history.length - 1;
      this.updateHistoryButtons();
    }

    restoreHistory(index) {
      if (index < 0 || index >= this.history.length) return;
      this.historyIndex = index;
      this.setDesign(JSON.parse(this.history[index]));
      this.updateHistoryButtons();
      this.setFeedback('Änderung übernommen');
    }

    undo() {
      this.restoreHistory(this.historyIndex - 1);
    }

    redo() {
      this.restoreHistory(this.historyIndex + 1);
    }

    updateHistoryButtons() {
      if (!this.undoButton) return;
      this.undoButton.disabled = this.historyIndex <= 0;
      this.redoButton.disabled = this.historyIndex >= this.history.length - 1;
    }

    addWord() {
      const color = this.palette[this.canvas.getObjects().length % this.palette.length];
      const object = this.makeObject({
        id: this.nextId(),
        text: 'neues wort',
        x: this.width / 2,
        y: this.height / 2,
        fontSize: 96,
        angle: 0,
        color,
      });
      const offset = (this.canvas.getObjects().length % 5) * 18;
      object.set({ left: object.left + offset, top: object.top + offset });
      this.keepInside(object);
      this.canvas.add(object);
      this.canvas.setActiveObject(object);
      this.canvas.requestRenderAll();
      this.recordHistory();
      this.emitChange();
      this.updateSelectionPanel();
      this.textInput.focus();
      this.textInput.select();
      this.setFeedback('Neues Wort hinzugefügt');
    }

    deleteActive() {
      const active = this.canvas.getActiveObject();
      if (!active) return;
      if (this.canvas.getObjects().length <= 1) {
        this.setFeedback('Mindestens ein Wort muss bleiben.');
        return;
      }
      this.canvas.remove(active);
      this.canvas.discardActiveObject();
      this.canvas.requestRenderAll();
      this.recordHistory();
      this.emitChange();
      this.updateSelectionPanel();
      this.setFeedback('Wort gelöscht');
    }

    duplicateActive() {
      const active = this.canvas.getActiveObject();
      if (!active) return;
      const design = this.serializeObject(active);
      design.id = this.nextId();
      design.x += 48;
      design.y += 48;
      const copy = this.makeObject(design);
      this.keepInside(copy);
      this.canvas.add(copy);
      this.canvas.setActiveObject(copy);
      this.canvas.requestRenderAll();
      this.recordHistory();
      this.emitChange();
      this.updateSelectionPanel();
      this.setFeedback('Wort dupliziert');
    }

    serializeObject(object) {
      return {
        id: object.editorId,
        text: object.text,
        x: object.left / EDITOR_SCALE,
        y: object.top / EDITOR_SCALE,
        fontSize: object.fontSize * object.scaleX / EDITOR_SCALE,
        angle: object.angle || 0,
        color: String(object.fill),
      };
    }

    resizeActive(factor) {
      const active = this.canvas.getActiveObject();
      if (!active) return;
      active.scaleX *= factor;
      active.scaleY *= factor;
      this.keepInside(active);
      this.absorbScale(active);
      this.canvas.requestRenderAll();
      this.recordHistory();
      this.emitChange();
    }

    rotateActive(delta) {
      const active = this.canvas.getActiveObject();
      if (!active) return;
      active.rotate((active.angle || 0) + delta);
      this.keepInside(active);
      this.canvas.requestRenderAll();
      this.recordHistory();
      this.emitChange();
      this.updateSelectionPanel();
    }

    setActiveColor(color) {
      const active = this.canvas.getActiveObject();
      if (!active || !/^#[0-9a-f]{6}$/i.test(color)) return;
      active.set({ fill: color });
      this.canvas.requestRenderAll();
      this.recordHistory();
      this.emitChange();
      this.updateSelectionPanel();
    }

    applyPalette(colors) {
      this.palette = colors;
      this.canvas.getObjects().forEach((object, index) => object.set({ fill: colors[index % colors.length] }));
      this.canvas.requestRenderAll();
      this.renderSwatches();
      this.recordHistory();
      this.emitChange();
      this.updateSelectionPanel();
    }

    renderSwatches() {
      this.swatches.replaceChildren();
      for (const color of this.palette) {
        const button = document.createElement('button');
        button.type = 'button';
        button.className = 'editor-swatch';
        button.dataset.color = color.toLowerCase();
        button.style.backgroundColor = color;
        button.title = `Farbe ${color}`;
        button.setAttribute('aria-label', `Farbe ${color}`);
        button.addEventListener('click', () => this.setActiveColor(color));
        this.swatches.appendChild(button);
      }
    }

    updateSelectionPanel() {
      const active = this.canvas.getActiveObject();
      this.selectionPanel.hidden = !active;
      this.shell.classList.toggle('has-selection', Boolean(active));
      if (!active) return;
      this.textInput.value = active.text;
      this.colorInput.value = String(active.fill);
      this.selectionPanel.querySelectorAll('.editor-swatch').forEach((button) => {
        button.classList.toggle('is-selected', button.dataset.color === String(active.fill).toLowerCase());
      });
    }

    setZoom(nextZoom) {
      this.zoom = Math.min(2, Math.max(1, Math.round(nextZoom * 4) / 4));
      this.shell.style.width = `${this.zoom * 100}%`;
      this.zoomLabel.textContent = `${Math.round(this.zoom * 100)} %`;
    }

    setFeedback(message) {
      this.feedback.textContent = message;
      clearTimeout(this.feedbackTimer);
      this.feedbackTimer = setTimeout(() => {
        if (this.feedback.textContent === message) this.feedback.textContent = '';
      }, 1800);
    }
  }

  root.MugPrintEditor = MugPrintEditor;
})(window);
