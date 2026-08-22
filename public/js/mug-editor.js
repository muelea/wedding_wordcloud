(function (root) {
  'use strict';

  const MAX_EDITOR_SCALE = .5;
  const MAX_EDITOR_DIMENSION = 1536;
  const DEFAULT_PRINT_MARGIN = 24;
  const MIN_PRINT_FONT_SIZE = 12;
  const MIN_PRINT_ICON_SIZE = 48;
  const MAX_HISTORY = 60;

  function round(value) {
    return Math.round(value * 10) / 10;
  }

  function cloneDesign(design) {
    return design.map((item) => ({ ...item }));
  }

  function editorScaleFor(width, height) {
    return Math.min(MAX_EDITOR_SCALE, MAX_EDITOR_DIMENSION / Math.max(width, height));
  }

  class MugPrintEditor {
    constructor(options) {
      if (!root.fabric) throw new Error('Fabric.js is required for the mug editor');
      if (!root.MugIcons) throw new Error('MugIcons is required for the mug editor');
      this.width = options.printWidth;
      this.height = options.printHeight;
      this.printMargin = Number.isFinite(options.safeMargin) ? options.safeMargin : DEFAULT_PRINT_MARGIN;
      this.editorScale = editorScaleFor(this.width, this.height);
      this.canvasWidth = this.width * this.editorScale;
      this.canvasHeight = this.height * this.editorScale;
      this.margin = this.printMargin * this.editorScale;
      this.defaultX = Number.isFinite(options.defaultX) ? options.defaultX : this.width / 2;
      this.defaultY = Number.isFinite(options.defaultY) ? options.defaultY : this.height / 2;
      this.palette = options.palette || ['#8f3a58'];
      this.onChange = options.onChange || (() => {});
      this.onReset = options.onReset || (() => {});
      this.shell = options.shell;
      this.scroll = options.scroll;
      this.updatePrintAreaPresentation();
      this.selectionPanel = options.selectionPanel;
      this.textInput = options.textInput;
      this.textLabel = options.textLabel;
      this.swatches = options.swatches;
      this.zoomLabel = options.zoomLabel;
      this.feedback = options.feedback;
      this.selectionStatus = options.selectionStatus;
      this.selectionHint = options.selectionHint;
      this.iconButton = options.iconButton;
      this.iconMenu = options.iconMenu;
      this.iconGrid = options.iconGrid;
      this.selectionActions = [
        options.smallerButton,
        options.largerButton,
        options.rotateLeftButton,
        options.rotateRightButton,
        options.duplicateButton,
        options.deleteButton,
      ];
      this.history = [];
      this.historyIndex = -1;
      this.suspended = false;
      this.changeFrame = null;
      this.zoom = 1;
      this.idCounter = 0;
      this.photoElements = new Map();
      this.photoSourceIds = new Map();
      this.photoSources = new Map();

      this.canvas = new root.fabric.Canvas(options.canvas, {
        width: this.canvasWidth,
        height: this.canvasHeight,
        selection: false,
        enableRetinaScaling: false,
        preserveObjectStacking: true,
        stopContextMenu: true,
        fireRightClick: false,
      });
      this.canvas.backgroundColor = '#ffffff';
      this.canvas.renderAll();
      this.bindCanvasEvents();
      this.bindControls(options);
      this.renderSwatches();
      this.renderIconPicker();
      this.setZoom(1);
    }

    makeObject(item) {
      if (item.type === 'image') return this.makeImageObject(item);
      if (item.type === 'icon') return this.makeIconObject(item);
      const text = new root.fabric.IText(item.text, {
        left: item.x * this.editorScale,
        top: item.y * this.editorScale,
        originX: 'center',
        originY: 'center',
        fontFamily: 'Georgia',
        fontSize: Math.max(MIN_PRINT_FONT_SIZE * this.editorScale, item.fontSize * this.editorScale),
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
        cursorColor: '#9c1c4c',
        cursorWidth: 2,
        selectionColor: 'rgba(156, 28, 76, .14)',
        hoverCursor: 'move',
        moveCursor: 'grabbing',
      });
      text.editorKind = 'text';
      text.editorId = item.id || this.nextId();
      text.setControlsVisibility({ mt: false, mb: false, ml: false, mr: false });
      text.setCoords();
      return text;
    }

    makeImageObject(item) {
      const element = this.photoElements.get(item.src);
      if (!element) throw new Error('Photo must be loaded before it can be placed');
      const photo = new root.fabric.Image(element, {
        left: item.x * this.editorScale,
        top: item.y * this.editorScale,
        originX: 'center',
        originY: 'center',
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
        hoverCursor: 'move',
        moveCursor: 'grabbing',
      });
      photo.editorKind = 'image';
      photo.editorSrc = item.src;
      photo.editorId = item.id || this.nextId('foto');
      this.setImageSize(photo, item.width, item.height);
      photo.setControlsVisibility({ mt: false, mb: false, ml: false, mr: false });
      photo.setCoords();
      return photo;
    }

    makeIconObject(item) {
      const definition = root.MugIcons.get(item.icon);
      if (!definition) throw new Error(`Unknown mug icon: ${item.icon}`);
      const viewBox = root.MugIcons.VIEWBOX_SIZE;
      const color = item.color || this.palette[0];
      const frame = new root.fabric.Rect({
        left: 0,
        top: 0,
        originX: 'center',
        originY: 'center',
        width: viewBox,
        height: viewBox,
        fill: 'rgba(0,0,0,0)',
        strokeWidth: 0,
        evented: false,
      });
      const drawing = new root.fabric.Path(definition.path, {
        left: 0,
        top: 0,
        originX: 'center',
        originY: 'center',
        fill: null,
        stroke: color,
        strokeWidth: root.MugIcons.STROKE_WIDTH,
        strokeLineCap: 'round',
        strokeLineJoin: 'round',
        evented: false,
      });
      const icon = new root.fabric.Group([frame, drawing], {
        left: item.x * this.editorScale,
        top: item.y * this.editorScale,
        originX: 'center',
        originY: 'center',
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
        hoverCursor: 'move',
        moveCursor: 'grabbing',
      });
      icon.editorKind = 'icon';
      icon.editorIcon = definition.id;
      icon.editorIconLabel = definition.label;
      icon.editorDrawing = drawing;
      icon.editorId = item.id || this.nextId('motiv');
      this.setIconSize(icon, Math.max(MIN_PRINT_ICON_SIZE, item.size || 160));
      icon.setControlsVisibility({ mt: false, mb: false, ml: false, mr: false });
      icon.setCoords();
      return icon;
    }

    nextId(prefix = 'wort') {
      this.idCounter += 1;
      return `${prefix}-${Date.now().toString(36)}-${this.idCounter}`;
    }

    rememberPhotoSource(src) {
      let id = this.photoSourceIds.get(src);
      if (id) return id;
      id = this.nextId('fotoquelle');
      this.photoSourceIds.set(src, id);
      this.photoSources.set(id, src);
      return id;
    }

    historySnapshot() {
      const compact = this.getDesign().map((item) => {
        if (item.type !== 'image') return item;
        const { src, ...rest } = item;
        return { ...rest, photoSourceId: this.rememberPhotoSource(src) };
      });
      return JSON.stringify(compact);
    }

    designFromHistory(snapshot) {
      return JSON.parse(snapshot).map((item) => {
        if (item.type !== 'image') return item;
        const { photoSourceId, ...rest } = item;
        return { ...rest, src: this.photoSources.get(photoSourceId) };
      });
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

      this.canvas.on('text:editing:entered', (event) => {
        if (!event.target || event.target.editorKind !== 'text') return;
        event.target.editorTextBeforeEditing = event.target.text;
        this.updateSelectionPanel();
      });
      this.canvas.on('text:changed', (event) => {
        const object = event.target;
        if (!object || object.editorKind !== 'text') return;
        const text = this.normalizeText(object.text);
        if (text !== object.text) object.set({ text });
        this.keepInside(object);
        object.setCoords();
        this.textInput.value = text;
        this.canvas.requestRenderAll();
        this.emitChange();
      });
      this.canvas.on('text:editing:exited', (event) => {
        const object = event.target;
        if (!object || object.editorKind !== 'text') return;
        const text = this.normalizeText(object.text, true) || object.editorTextBeforeEditing || 'wort';
        object.set({ text });
        this.keepInside(object);
        object.setCoords();
        this.canvas.requestRenderAll();
        this.recordHistory();
        this.emitChange();
        this.updateSelectionPanel();
      });

      this.canvas.on('mouse:dblclick', (event) => {
        const object = event.target;
        if (!object || typeof object.enterEditing !== 'function') return;
        this.canvas.setActiveObject(object);
        object.enterEditing();
        object.selectAll();
        if (object.hiddenTextarea) object.hiddenTextarea.focus();
        this.updateSelectionPanel();
        this.canvas.requestRenderAll();
      });
    }

    normalizeText(rawText, finalize = false) {
      let text = String(rawText || '').normalize('NFC')
        .replace(/[\x00-\x1f\x7f]/g, '')
        .slice(0, 30);
      if (finalize) text = text.replace(/ {2,}/g, ' ').trim();
      return text;
    }

    bindControls(options) {
      options.addButton.addEventListener('click', () => this.addWord());
      options.iconButton.addEventListener('click', (event) => {
        event.stopPropagation();
        this.toggleIconPicker();
      });
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
        const text = this.normalizeText(this.textInput.value);
        if (!active || active.editorKind !== 'text' || !text.trim()) return;
        active.set({ text });
        this.keepInside(active);
        active.setCoords();
        this.canvas.requestRenderAll();
        this.emitChange();
      });
      this.textInput.addEventListener('change', () => {
        const active = this.canvas.getActiveObject();
        if (!active || active.editorKind !== 'text') return;
        const text = this.normalizeText(this.textInput.value, true) || active.text;
        active.set({ text });
        this.textInput.value = text;
        this.keepInside(active);
        active.setCoords();
        this.canvas.requestRenderAll();
        this.recordHistory();
        this.emitChange();
      });
      this.textInput.addEventListener('blur', () => {
        const active = this.canvas.getActiveObject();
        if (active?.editorKind === 'text' && !this.textInput.value.trim()) this.textInput.value = active.text;
      });
      options.colorInput.addEventListener('input', () => this.setActiveColor(options.colorInput.value));
      this.colorInput = options.colorInput;

      document.addEventListener('keydown', (event) => {
        const editingField = /^(INPUT|TEXTAREA|SELECT)$/.test(document.activeElement?.tagName || '');
        const command = event.metaKey || event.ctrlKey;
        if (!editingField && command && event.key.toLowerCase() === 'z') {
          event.shiftKey ? this.redo() : this.undo();
          event.preventDefault();
          return;
        }
        if (!editingField && command && event.key.toLowerCase() === 'y') {
          this.redo();
          event.preventDefault();
          return;
        }
        if (!editingField && (event.key === 'Delete' || event.key === 'Backspace')) {
          this.deleteActive();
          event.preventDefault();
        }
        if (event.key === 'Escape') this.closeIconPicker();
      });
      document.addEventListener('click', (event) => {
        if (!this.iconMenu.hidden && !event.target.closest('.editor-motif-picker')) this.closeIconPicker();
      });

      this.undoButton = options.undoButton;
      this.redoButton = options.redoButton;
      this.zoomOutButton = options.zoomOutButton;
      this.zoomInButton = options.zoomInButton;
    }

    renderIconPicker() {
      this.iconGrid.replaceChildren();
      const svgNamespace = 'http://www.w3.org/2000/svg';
      for (const icon of root.MugIcons.ICONS) {
        const button = document.createElement('button');
        button.type = 'button';
        button.className = 'editor-motif-option';
        button.setAttribute('aria-label', `${icon.label} hinzufügen`);
        button.title = icon.label;

        const svg = document.createElementNS(svgNamespace, 'svg');
        svg.setAttribute('viewBox', `0 0 ${root.MugIcons.VIEWBOX_SIZE} ${root.MugIcons.VIEWBOX_SIZE}`);
        svg.setAttribute('aria-hidden', 'true');
        const path = document.createElementNS(svgNamespace, 'path');
        path.setAttribute('d', icon.path);
        svg.appendChild(path);

        const label = document.createElement('span');
        label.textContent = icon.label;
        button.append(svg, label);
        button.addEventListener('click', () => this.addIcon(icon.id));
        this.iconGrid.appendChild(button);
      }
    }

    toggleIconPicker() {
      const shouldOpen = this.iconMenu.hidden;
      this.iconMenu.hidden = !shouldOpen;
      this.iconButton.setAttribute('aria-expanded', String(shouldOpen));
      if (shouldOpen) this.iconGrid.querySelector('button')?.focus();
    }

    closeIconPicker() {
      this.iconMenu.hidden = true;
      this.iconButton.setAttribute('aria-expanded', 'false');
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
        this.history = [this.historySnapshot()];
        this.historyIndex = 0;
        this.updateHistoryButtons();
      } else if (record) {
        this.recordHistory();
      }
      this.emitChange();
    }

    getState() {
      return {
        design: cloneDesign(this.getDesign()),
        history: [...this.history],
        historyIndex: this.historyIndex,
      };
    }

    setState(state) {
      const design = Array.isArray(state?.design) ? cloneDesign(state.design) : [];
      this.setDesign(design);
      if (Array.isArray(state?.history) && state.history.length &&
          Number.isSafeInteger(state.historyIndex) &&
          state.historyIndex >= 0 && state.historyIndex < state.history.length) {
        this.history = [...state.history];
        this.historyIndex = state.historyIndex;
      } else {
        this.history = [this.historySnapshot()];
        this.historyIndex = 0;
      }
      this.updateHistoryButtons();
    }

    updatePrintAreaPresentation() {
      if (!this.shell) return;
      for (const element of [this.shell, this.scroll]) {
        element?.style.setProperty('--print-aspect', `${this.width} / ${this.height}`);
      }
      this.shell.style.setProperty('--print-safe-x', `${this.printMargin / this.width * 100}%`);
      this.shell.style.setProperty('--print-safe-y', `${this.printMargin / this.height * 100}%`);
    }

    resizePrintArea({ printWidth, printHeight, defaultX, defaultY, safeMargin }) {
      const nextWidth = Number(printWidth);
      const nextHeight = Number(printHeight);
      if (!Number.isFinite(nextWidth) || !Number.isFinite(nextHeight) || nextWidth < 1 || nextHeight < 1) {
        throw new Error('Invalid print area dimensions');
      }

      const design = this.getDesign();
      const nextPrintMargin = Number.isFinite(safeMargin) ? safeMargin : DEFAULT_PRINT_MARGIN;
      const oldUsableWidth = Math.max(1, this.width - this.printMargin * 2);
      const oldUsableHeight = Math.max(1, this.height - this.printMargin * 2);
      const nextUsableWidth = Math.max(1, nextWidth - nextPrintMargin * 2);
      const nextUsableHeight = Math.max(1, nextHeight - nextPrintMargin * 2);
      const xScale = nextUsableWidth / oldUsableWidth;
      const yScale = nextUsableHeight / oldUsableHeight;
      const sizeScale = Math.min(xScale, yScale);
      const scaledDesign = design.map((item) => ({
        ...item,
        x: nextPrintMargin + (item.x - this.printMargin) * xScale,
        y: nextPrintMargin + (item.y - this.printMargin) * yScale,
        ...(item.type === 'image'
          ? {
              width: Math.max(48, item.width * sizeScale),
              height: Math.max(48, item.height * sizeScale),
            }
          : item.type === 'icon'
            ? { size: Math.max(MIN_PRINT_ICON_SIZE, item.size * sizeScale) }
            : { fontSize: Math.max(MIN_PRINT_FONT_SIZE, item.fontSize * sizeScale) }),
      }));

      this.width = nextWidth;
      this.height = nextHeight;
      this.printMargin = nextPrintMargin;
      this.editorScale = editorScaleFor(nextWidth, nextHeight);
      this.canvasWidth = nextWidth * this.editorScale;
      this.canvasHeight = nextHeight * this.editorScale;
      this.margin = this.printMargin * this.editorScale;
      this.defaultX = Number.isFinite(defaultX) ? defaultX : nextWidth / 2;
      this.defaultY = Number.isFinite(defaultY) ? defaultY : nextHeight / 2;
      this.canvas.setDimensions({ width: this.canvasWidth, height: this.canvasHeight });
      this.canvas.calcOffset();
      this.updatePrintAreaPresentation();
      this.setZoom(1);
      this.setDesign(scaledDesign, { resetHistory: true });
    }

    getDesign() {
      return this.canvas.getObjects().map((object) => {
        const item = this.serializeObject(object);
        return {
          ...item,
          x: round(item.x),
          y: round(item.y),
          ...(item.type === 'image'
            ? { width: round(item.width), height: round(item.height) }
            : item.type === 'icon'
              ? { size: round(item.size) }
              : { fontSize: round(item.fontSize) }),
          angle: round(item.angle),
          ...(item.color ? { color: item.color.toLowerCase() } : {}),
        };
      });
    }

    handleTransform(object) {
      if (!object) return;
      this.keepInside(object);
      this.emitChange();
    }

    absorbScale(object) {
      if (!object) return;
      if (object.editorKind === 'image') {
        const width = object.width * object.scaleX / this.editorScale;
        const height = object.height * object.scaleY / this.editorScale;
        this.setImageSize(object, width, height);
        object.setCoords();
        return;
      }
      if (object.editorKind === 'icon') {
        const size = Math.max(object.width * object.scaleX, object.height * object.scaleY) / this.editorScale;
        this.setIconSize(object, Math.max(MIN_PRINT_ICON_SIZE, size));
        object.setCoords();
        return;
      }
      const nextSize = Math.max(MIN_PRINT_FONT_SIZE * this.editorScale, object.fontSize * object.scaleX);
      object.set({ fontSize: nextSize, scaleX: 1, scaleY: 1 });
      object.setCoords();
    }

    setIconSize(object, printSize) {
      const baseSize = Math.max(object.width, object.height) || root.MugIcons.VIEWBOX_SIZE;
      const scale = printSize * this.editorScale / baseSize;
      object.set({ scaleX: scale, scaleY: scale });
    }

    setImageSize(object, printWidth, printHeight) {
      const sourceWidth = Math.max(1, object.width || 1);
      const sourceHeight = Math.max(1, object.height || 1);
      object.set({
        scaleX: Math.max(48, printWidth) * this.editorScale / sourceWidth,
        scaleY: Math.max(48, printHeight) * this.editorScale / sourceHeight,
      });
    }

    getObjectColor(object) {
      if (object.editorKind === 'image') return null;
      return String(object.editorKind === 'icon' ? object.editorDrawing.stroke : object.fill);
    }

    applyObjectColor(object, color) {
      if (object.editorKind === 'image') return;
      if (object.editorKind === 'icon') {
        object.editorDrawing.set({ stroke: color });
        object.dirty = true;
      } else {
        object.set({ fill: color });
      }
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
      const snapshot = this.historySnapshot();
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
      this.setDesign(this.designFromHistory(this.history[index]));
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
      this.closeIconPicker();
      const color = this.palette[this.canvas.getObjects().length % this.palette.length];
      const object = this.makeObject({
        id: this.nextId(),
        text: 'neues wort',
        x: this.defaultX,
        y: this.defaultY,
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

    addIcon(iconId) {
      const definition = root.MugIcons.get(iconId);
      if (!definition) return;
      const color = this.palette[this.canvas.getObjects().length % this.palette.length];
      const object = this.makeObject({
        id: this.nextId('motiv'),
        type: 'icon',
        icon: definition.id,
        x: this.defaultX,
        y: this.defaultY,
        size: 170,
        angle: 0,
        color,
      });
      const offset = (this.canvas.getObjects().length % 5) * 18;
      object.set({ left: object.left + offset, top: object.top + offset });
      this.keepInside(object);
      this.canvas.add(object);
      this.canvas.setActiveObject(object);
      this.canvas.requestRenderAll();
      this.closeIconPicker();
      this.recordHistory();
      this.emitChange();
      this.updateSelectionPanel();
      this.setFeedback(`${definition.label} hinzugefügt`);
    }

    async addImage(src) {
      if (typeof src !== 'string' || !src.startsWith('data:image/')) {
        throw new Error('invalid_photo');
      }
      let element = this.photoElements.get(src);
      if (!element) {
        element = await new Promise((resolve, reject) => {
          const image = new Image();
          image.onload = () => resolve(image);
          image.onerror = () => reject(new Error('photo_decode_failed'));
          image.src = src;
        });
        this.photoElements.set(src, element);
      }
      this.rememberPhotoSource(src);
      const availableWidth = this.width - this.printMargin * 2;
      const availableHeight = this.height - this.printMargin * 2;
      const initialScale = Math.min(900 / element.naturalWidth, 760 / element.naturalHeight, 1);
      const width = Math.min(availableWidth, element.naturalWidth * initialScale);
      const height = Math.min(availableHeight, element.naturalHeight * initialScale);
      const object = this.makeObject({
        id: this.nextId('foto'),
        type: 'image',
        src,
        x: this.defaultX,
        y: this.defaultY,
        width,
        height,
        angle: 0,
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
      this.setFeedback('Foto hinzugefügt');
    }

    getImageElement(src) {
      return this.photoElements.get(src) || null;
    }

    deleteActive() {
      const active = this.canvas.getActiveObject();
      if (!active) return;
      if (this.canvas.getObjects().length <= 1) {
        this.setFeedback('Mindestens ein Element muss bleiben.');
        return;
      }
      const deletedLabel = active.editorKind === 'image'
        ? 'Foto'
        : active.editorKind === 'icon' ? 'Motiv' : 'Wort';
      this.canvas.remove(active);
      this.canvas.discardActiveObject();
      this.canvas.requestRenderAll();
      this.recordHistory();
      this.emitChange();
      this.updateSelectionPanel();
      this.setFeedback(`${deletedLabel} gelöscht`);
    }

    duplicateActive() {
      const active = this.canvas.getActiveObject();
      if (!active) return;
      const design = this.serializeObject(active);
      design.id = this.nextId(active.editorKind === 'image' ? 'foto' : active.editorKind === 'icon' ? 'motiv' : 'wort');
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
      this.setFeedback(active.editorKind === 'image'
        ? 'Foto dupliziert'
        : active.editorKind === 'icon' ? 'Motiv dupliziert' : 'Wort dupliziert');
    }

    serializeObject(object) {
      const common = {
        id: object.editorId,
        x: object.left / this.editorScale,
        y: object.top / this.editorScale,
        angle: object.angle || 0,
      };
      if (object.editorKind === 'image') {
        return {
          ...common,
          type: 'image',
          src: object.editorSrc,
          width: object.width * object.scaleX / this.editorScale,
          height: object.height * object.scaleY / this.editorScale,
        };
      }
      common.color = this.getObjectColor(object);
      if (object.editorKind === 'icon') {
        return {
          ...common,
          type: 'icon',
          icon: object.editorIcon,
          size: Math.max(object.width * object.scaleX, object.height * object.scaleY) / this.editorScale,
        };
      }
      return {
        ...common,
        text: object.text,
        fontSize: object.fontSize * object.scaleX / this.editorScale,
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
      this.applyObjectColor(active, color);
      this.canvas.requestRenderAll();
      this.recordHistory();
      this.emitChange();
      this.updateSelectionPanel();
    }

    applyPalette(colors) {
      this.palette = colors;
      this.canvas.getObjects().forEach((object, index) => this.applyObjectColor(object, colors[index % colors.length]));
      this.canvas.requestRenderAll();
      this.renderSwatches();
      this.recordHistory();
      this.emitChange();
      this.updateSelectionPanel();
    }

    renderSwatches() {
      this.swatches.replaceChildren();
      const hasSelection = Boolean(this.canvas.getActiveObject());
      for (const color of this.palette) {
        const button = document.createElement('button');
        button.type = 'button';
        button.className = 'editor-swatch';
        button.dataset.color = color.toLowerCase();
        button.style.backgroundColor = color;
        button.title = `Farbe ${color}`;
        button.setAttribute('aria-label', `Farbe ${color}`);
        button.disabled = !hasSelection;
        button.addEventListener('click', () => this.setActiveColor(color));
        this.swatches.appendChild(button);
      }
    }

    updateSelectionPanel() {
      const active = this.canvas.getActiveObject();
      const hasSelection = Boolean(active);
      const isIcon = active?.editorKind === 'icon';
      const isImage = active?.editorKind === 'image';
      this.selectionPanel.classList.toggle('is-active', hasSelection);
      this.selectionPanel.classList.toggle('is-photo', Boolean(isImage));
      this.selectionPanel.setAttribute('aria-disabled', String(!hasSelection));
      this.shell.classList.toggle('has-selection', hasSelection);
      this.textInput.disabled = !hasSelection || isIcon || isImage;
      this.colorInput.disabled = !hasSelection || isImage;
      this.selectionActions.forEach((button) => { button.disabled = !hasSelection; });
      this.selectionPanel.querySelectorAll('.editor-swatch').forEach((button) => {
        button.disabled = !hasSelection || isImage;
      });
      if (!active) {
        this.selectionStatus.textContent = 'Element auswählen';
        this.selectionHint.textContent = 'Wort, Foto oder Motiv anklicken, um die Werkzeuge zu aktivieren';
        this.textLabel.textContent = 'Ausgewähltes Element';
        this.textInput.value = '';
        this.selectionPanel.querySelectorAll('.editor-swatch').forEach((button) => {
          button.classList.remove('is-selected');
        });
        return;
      }
      if (isImage) {
        this.selectionStatus.textContent = 'Foto bearbeiten';
        this.selectionHint.textContent = 'Foto ziehen, drehen oder skalieren';
        this.textLabel.textContent = 'Ausgewähltes Foto';
        this.textInput.value = 'Eigenes Foto';
      } else if (isIcon) {
        this.selectionStatus.textContent = `${active.editorIconLabel} bearbeiten`;
        this.selectionHint.textContent = 'Motiv ziehen, drehen, färben oder skalieren';
        this.textLabel.textContent = 'Ausgewähltes Motiv';
        this.textInput.value = active.editorIconLabel;
      } else {
        this.selectionStatus.textContent = `„${active.text}“ bearbeiten`;
        this.selectionHint.textContent = 'Doppelklick: Wort direkt bearbeiten';
        this.textLabel.textContent = 'Ausgewähltes Wort';
        this.textInput.value = active.text;
      }
      const activeColor = this.getObjectColor(active);
      if (!activeColor) return;
      this.colorInput.value = activeColor;
      this.selectionPanel.querySelectorAll('.editor-swatch').forEach((button) => {
        button.classList.toggle('is-selected', button.dataset.color === activeColor.toLowerCase());
      });
    }

    setZoom(nextZoom) {
      this.zoom = Math.min(2, Math.max(1, Math.round(nextZoom * 4) / 4));
      this.shell.style.width = `${this.zoom * 100}%`;
      this.scroll.classList.toggle('is-fit', this.zoom === 1);
      if (this.zoom === 1) {
        this.scroll.scrollLeft = 0;
        this.scroll.scrollTop = 0;
      }
      this.zoomOutButton.disabled = this.zoom === 1;
      this.zoomInButton.disabled = this.zoom === 2;
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
