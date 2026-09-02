(function (root) {
  'use strict';

  const MAX_EDITOR_SCALE = .5;
  const MAX_EDITOR_DIMENSION = 1536;
  const DEFAULT_PRINT_MARGIN = 24;
  const MIN_PRINT_FONT_SIZE = 12;
  const MIN_PRINT_ICON_SIZE = 48;
  const MIN_PRINT_IMAGE_SIZE = 24;
  const MAX_UPLOAD_FILE_BYTES = 15 * 1024 * 1024;
  const MAX_EMBEDDED_IMAGE_BYTES = 1_000_000;
  const MAX_UPLOAD_PIXELS = 40_000_000;
  const MAX_UPLOAD_DIMENSION = 2700;
  const MAX_HISTORY = 60;

  function translate(source, params = {}) {
    if (root.WolkenworteI18n) return root.WolkenworteI18n.t(source, params);
    return String(source).replace(/\{\{\s*([\w.-]+)\s*\}\}/g, (_, key) => (
      Object.prototype.hasOwnProperty.call(params, key) ? String(params[key]) : ''
    ));
  }

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
      if (!root.DesignFonts) throw new Error('DesignFonts is required for the mug editor');
      if (!root.ImagePrintQuality) throw new Error('ImagePrintQuality is required for the mug editor');
      if (!root.WordCloudCore || !root.WolkenworteEmoji) {
        throw new Error('The shared emoji renderer is required for the mug editor');
      }
      this.width = options.printWidth;
      this.height = options.printHeight;
      this.printFileDpi = Number(options.printFileDpi) || 300;
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
      this.onSelectionChange = options.onSelectionChange;
      this.openTextEditor = options.openTextEditor;
      this.shell = options.shell;
      this.scroll = options.scroll;
      this.updatePrintAreaPresentation();
      this.selectionPanel = options.selectionPanel;
      this.textInput = options.textInput;
      this.textLabel = options.textLabel;
      this.fontSelect = options.fontSelect;
      this.fontButton = options.fontButton;
      this.fontCurrent = options.fontCurrent;
      this.fontMenu = options.fontMenu;
      this.swatches = options.swatches;
      this.zoomLabel = options.zoomLabel;
      this.feedback = options.feedback;
      this.selectionStatus = options.selectionStatus;
      this.selectionHint = options.selectionHint;
      this.imageQualityBadge = options.imageQualityBadge;
      this.imageQualityDetail = options.imageQualityDetail;
      this.imageQualityLabel = options.imageQualityLabel;
      this.iconButton = options.iconButton;
      this.iconMenu = options.iconMenu;
      this.iconGrid = options.iconGrid;
      this.selectionActions = [
        options.smallerButton,
        options.largerButton,
        options.rotateLeftButton,
        options.rotateRightButton,
        options.duplicateButton,
        options.bringFrontButton,
        options.deleteButton,
      ];
      this.history = [];
      this.historyIndex = -1;
      this.suspended = false;
      this.changeFrame = null;
      this.zoom = 1;
      this.idCounter = 0;
      this.clipboard = null;
      this.imageElements = new Map();
      this.imageLoadPromises = new Map();
      this.imageRefsBySource = new Map();
      this.imageSourcesByRef = new Map();
      this.imageRefCounter = 0;
      this.measureContext = document.createElement('canvas').getContext('2d');
      this.textChangeRevision = 0;

      this.canvas = new root.fabric.Canvas(options.canvas, {
        width: this.canvasWidth,
        height: this.canvasHeight,
        selection: true,
        selectionColor: 'rgba(156, 28, 76, .06)',
        selectionBorderColor: 'rgba(156, 28, 76, .5)',
        selectionLineWidth: 1,
        selectionKey: ['shiftKey', 'ctrlKey', 'metaKey'],
        enableRetinaScaling: false,
        preserveObjectStacking: true,
        stopContextMenu: true,
        fireRightClick: false,
      });
      this.canvas.backgroundColor = '#ffffff';
      this.canvas.renderAll();
      this.bindCanvasEvents();
      this.renderFontOptions();
      this.bindControls(options);
      this.renderSwatches();
      this.renderIconPicker();
      this.setZoom(1);
      if (root.ResizeObserver && this.shell) {
        this.shellResizeObserver = new root.ResizeObserver(() => {
          this.updateImageQualityBadge(this.canvas.getActiveObject());
        });
        this.shellResizeObserver.observe(this.shell);
      }
    }

    makeObject(item) {
      if (item.type === 'icon') return this.makeIconObject(item);
      if (item.type === 'image') return this.makeImageObject(item);
      if (root.WolkenworteEmoji.hasEmoji(item.text)) return this.makeRichTextObject(item);
      const fontKey = root.DesignFonts.normalizeKey(item.fontFamily);
      const text = new root.fabric.IText(item.text, {
        left: item.x * this.editorScale,
        top: item.y * this.editorScale,
        originX: 'center',
        originY: 'center',
        fontFamily: root.DesignFonts.get(fontKey).family,
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
      text.editorFontKey = fontKey;
      text.setControlsVisibility({ mt: false, mb: false, ml: false, mr: false });
      text.setCoords();
      return text;
    }

    makeRichTextObject(item) {
      const fontKey = root.DesignFonts.normalizeKey(item.fontFamily);
      const font = root.DesignFonts.get(fontKey);
      const fontSize = Math.max(
        MIN_PRINT_FONT_SIZE * this.editorScale,
        item.fontSize * this.editorScale
      );
      const box = root.WordCloudCore.measureTextBox(
        item.text,
        fontSize,
        this.measureContext,
        font.cssFamily
      );
      const frame = new root.fabric.Rect({
        left: 0,
        top: 0,
        originX: 'center',
        originY: 'center',
        width: box.width,
        height: box.height,
        fill: 'rgba(0,0,0,0)',
        strokeWidth: 0,
        evented: false,
      });
      const children = [frame];
      const textChildren = [];
      for (const run of box.runs) {
        const centerX = -box.width / 2 + run.x + run.width / 2;
        if (run.type === 'emoji') {
          const element = root.WolkenworteEmoji.getLoadedImage(run);
          if (!element) throw new Error('Emoji artwork must be loaded before restoring the design');
          const image = new root.fabric.FabricImage(element, {
            left: centerX,
            top: 0,
            originX: 'center',
            originY: 'center',
            evented: false,
            selectable: false,
          });
          const sourceWidth = image.width || 1;
          const sourceHeight = image.height || 1;
          const scale = Math.min(run.width / sourceWidth, fontSize / sourceHeight);
          image.set({ scaleX: scale, scaleY: scale });
          children.push(image);
          continue;
        }
        const text = new root.fabric.FabricText(run.text, {
          left: centerX,
          top: 0,
          originX: 'center',
          originY: 'center',
          fontFamily: font.family,
          fontSize,
          fill: item.color,
          evented: false,
          selectable: false,
        });
        textChildren.push(text);
        children.push(text);
      }
      const group = new root.fabric.Group(children, {
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
      group.editorKind = 'text';
      group.editorId = item.id || this.nextId();
      group.editorFontKey = fontKey;
      group.editorFontSize = fontSize;
      group.editorText = item.text;
      group.editorColor = item.color;
      group.editorTextChildren = textChildren;
      group.text = item.text;
      group.setControlsVisibility({ mt: false, mb: false, ml: false, mr: false });
      group.setCoords();
      return group;
    }

    objectText(object) {
      return object?.editorText ?? object?.text ?? '';
    }

    replaceTextObject(object, updates = {}) {
      const objects = this.canvas.getObjects();
      const index = objects.indexOf(object);
      if (index < 0) return object;
      const wasActive = this.canvas.getActiveObject() === object;
      const item = { ...this.serializeObject(object), ...updates };
      if (wasActive) this.canvas.discardActiveObject();
      this.canvas.remove(object);
      const replacement = this.makeObject(item);
      this.canvas.insertAt(index, replacement);
      this.keepInside(replacement);
      if (wasActive) this.canvas.setActiveObject(replacement);
      return replacement;
    }

    async applyTextChange(object, rawText, { finalize = false, record = false } = {}) {
      const previous = this.objectText(object);
      const text = this.normalizeText(rawText, finalize) || previous || 'wort';
      const revision = ++this.textChangeRevision;
      await root.WolkenworteEmoji.preloadTexts([text]);
      if (revision !== this.textChangeRevision || !this.canvas.getObjects().includes(object)) return object;
      let next = object;
      const needsReplacement = root.WolkenworteEmoji.hasEmoji(text) || object.editorText !== undefined;
      if (needsReplacement) next = this.replaceTextObject(object, { text });
      else next.set({ text });
      this.textInput.value = text;
      this.keepInside(next);
      next.setCoords();
      this.canvas.requestRenderAll();
      if (record) this.recordHistory();
      this.emitChange();
      this.updateSelectionPanel();
      return next;
    }

    makeImageObject(item) {
      const element = this.imageElements.get(item.src);
      if (!element) throw new Error('Uploaded image must be loaded before restoring the design');
      const image = new root.fabric.FabricImage(element, {
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
      image.editorKind = 'image';
      image.editorSrc = item.src;
      image.editorId = item.id || this.nextId('bild');
      image.set({
        scaleX: item.width * this.editorScale / Math.max(1, image.width),
        scaleY: item.height * this.editorScale / Math.max(1, image.height),
      });
      image.setControlsVisibility({ mt: false, mb: false, ml: false, mr: false });
      image.setCoords();
      return image;
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

    historySnapshot() {
      return JSON.stringify(this.getDesign().map((item) => {
        if (item.type !== 'image') return item;
        const imageRef = this.imageReference(item.src);
        const compact = { ...item, imageRef };
        delete compact.src;
        return compact;
      }));
    }

    designFromHistory(snapshot) {
      return JSON.parse(snapshot).map((item) => {
        if (item.type !== 'image') return item;
        const src = this.imageSourcesByRef.get(item.imageRef);
        if (!src) throw new Error('Uploaded image history is unavailable');
        const restored = { ...item, src };
        delete restored.imageRef;
        return restored;
      });
    }

    imageReference(src) {
      if (this.imageRefsBySource.has(src)) return this.imageRefsBySource.get(src);
      this.imageRefCounter += 1;
      const reference = `bildquelle-${this.imageRefCounter}`;
      this.imageRefsBySource.set(src, reference);
      this.imageSourcesByRef.set(reference, src);
      return reference;
    }

    bindCanvasEvents() {
      this.canvas.on('selection:created', () => {
        this.configureActiveSelection();
        this.updateSelectionPanel();
      });
      this.canvas.on('selection:updated', () => {
        this.configureActiveSelection();
        this.updateSelectionPanel();
      });
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
        event.target.editorTextBeforeEditing = this.objectText(event.target);
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
        this.applyTextChange(
          object,
          object.text || object.editorTextBeforeEditing || 'wort',
          { finalize: true, record: true }
        ).catch(() => this.setFeedback('Das Emoji konnte nicht geladen werden.'));
      });

      this.canvas.on('mouse:dblclick', (event) => {
        this.beginTextEditing(event.target);
      });
    }

    beginTextEditing(object) {
      if (!object || object.editorKind !== 'text') return false;
      const usesToolbarField = object.editorText !== undefined;
      if (!usesToolbarField && typeof object.enterEditing !== 'function') return false;

      this.canvas.setActiveObject(object);
      if (this.openTextEditor) {
        this.updateSelectionPanel();
        if (this.openTextEditor()) {
          if (object.isEditing) object.exitEditing();
          this.canvas.requestRenderAll();
          return true;
        }
      }
      if (usesToolbarField) {
        this.updateSelectionPanel();
        this.textInput.focus();
        this.textInput.select();
      } else {
        object.enterEditing();
        object.selectAll();
        if (object.hiddenTextarea) object.hiddenTextarea.focus();
        this.updateSelectionPanel();
      }
      this.canvas.requestRenderAll();
      return true;
    }

    normalizeText(rawText, finalize = false) {
      let text = String(rawText || '').normalize('NFC')
        .replace(/[\x00-\x1f\x7f]/g, '');
      if (finalize) text = text.replace(/ {2,}/g, ' ').trim();
      if (root.WolkenworteEmoji.containsUnsupportedEmoji(text)) {
        this.setFeedback('Dieses Emoji wird noch nicht unterstützt. Bitte wählt ein anderes.');
        return '';
      }
      return root.WolkenworteEmoji.truncateGraphemes(
        root.WolkenworteEmoji.canonicalizeText(text),
        30
      );
    }

    loadImageElement(src) {
      return new Promise((resolve, reject) => {
        const image = new root.Image();
        image.onload = () => resolve(image);
        image.onerror = () => reject(new Error('image_decode_failed'));
        image.src = src;
      });
    }

    loadImageSource(src) {
      if (this.imageElements.has(src)) return Promise.resolve(this.imageElements.get(src));
      if (this.imageLoadPromises.has(src)) return this.imageLoadPromises.get(src);
      const promise = this.loadImageElement(src).then((image) => {
        this.imageElements.set(src, image);
        this.imageLoadPromises.delete(src);
        return image;
      }).catch((error) => {
        this.imageLoadPromises.delete(src);
        throw error;
      });
      this.imageLoadPromises.set(src, promise);
      return promise;
    }

    preloadImages(design) {
      const items = Array.isArray(design) ? design : [];
      const sources = [...new Set(items
        .filter((item) => item?.type === 'image' && typeof item.src === 'string')
        .map((item) => item.src))];
      return Promise.all([
        ...sources.map((src) => this.loadImageSource(src)),
        root.WolkenworteEmoji.preloadTexts(
          items.filter((item) => item && item.type !== 'image' && item.type !== 'icon')
            .map((item) => item.text)
        ),
      ]);
    }

    getImageElement(src) {
      return this.imageElements.get(src) || null;
    }

    dataUrlByteSize(dataUrl) {
      const encoded = String(dataUrl).slice(String(dataUrl).indexOf(',') + 1);
      const padding = encoded.endsWith('==') ? 2 : encoded.endsWith('=') ? 1 : 0;
      return Math.floor(encoded.length * 3 / 4) - padding;
    }

    async normalizedImageUpload(file) {
      if (!file || !['image/png', 'image/jpeg'].includes(file.type) ||
          file.size < 1 || file.size > MAX_UPLOAD_FILE_BYTES) {
        throw new Error('invalid_image_file');
      }
      const objectUrl = root.URL.createObjectURL(file);
      let source;
      try {
        source = await this.loadImageElement(objectUrl);
      } finally {
        root.URL.revokeObjectURL(objectUrl);
      }
      const sourceWidth = source.naturalWidth || source.width;
      const sourceHeight = source.naturalHeight || source.height;
      if (!sourceWidth || !sourceHeight || sourceWidth * sourceHeight > MAX_UPLOAD_PIXELS) {
        throw new Error('invalid_image_dimensions');
      }

      const outputType = file.type;
      let scale = Math.min(1, MAX_UPLOAD_DIMENSION / Math.max(sourceWidth, sourceHeight));
      for (let attempt = 0; attempt < 9; attempt += 1) {
        const outputWidth = Math.max(1, Math.round(sourceWidth * scale));
        const outputHeight = Math.max(1, Math.round(sourceHeight * scale));
        const canvas = document.createElement('canvas');
        canvas.width = outputWidth;
        canvas.height = outputHeight;
        const context = canvas.getContext('2d');
        if (outputType === 'image/jpeg') {
          context.fillStyle = '#ffffff';
          context.fillRect(0, 0, outputWidth, outputHeight);
        }
        context.drawImage(source, 0, 0, outputWidth, outputHeight);
        const dataUrl = canvas.toDataURL(outputType, .9);
        if (this.dataUrlByteSize(dataUrl) <= MAX_EMBEDDED_IMAGE_BYTES) {
          return { dataUrl, width: outputWidth, height: outputHeight };
        }
        scale *= .78;
      }
      throw new Error('image_too_complex');
    }

    bindControls(options) {
      options.addButton.addEventListener('click', () => this.addWord());
      options.imageButton.addEventListener('click', () => options.imageInput.click());
      options.imageInput.addEventListener('change', async () => {
        const [file] = options.imageInput.files || [];
        options.imageInput.value = '';
        if (!file) return;
        options.imageButton.disabled = true;
        try {
          await this.addImageFile(file);
        } catch {
          this.setFeedback('Das Bild konnte nicht verarbeitet werden. Bitte wählt eine PNG- oder JPG-Datei bis 15 MB.');
        } finally {
          options.imageButton.disabled = false;
        }
      });
      options.iconButton.addEventListener('click', (event) => {
        event.stopPropagation();
        this.toggleIconPicker();
      });
      options.undoButton.addEventListener('click', () => this.undo());
      options.redoButton.addEventListener('click', () => this.redo());
      options.resetButton.addEventListener('click', () => this.onReset());
      options.selectAllButton.addEventListener('click', () => this.selectAll());
      options.zoomOutButton.addEventListener('click', () => this.setZoom(this.zoom - .25));
      options.zoomInButton.addEventListener('click', () => this.setZoom(this.zoom + .25));
      options.smallerButton.addEventListener('click', () => this.resizeActive(.9));
      options.largerButton.addEventListener('click', () => this.resizeActive(1.1));
      options.rotateLeftButton.addEventListener('click', () => this.rotateActive(-15));
      options.rotateRightButton.addEventListener('click', () => this.rotateActive(15));
      options.duplicateButton.addEventListener('click', () => this.duplicateActive());
      options.bringFrontButton.addEventListener('click', () => this.bringActiveToFront());
      options.deleteButton.addEventListener('click', () => this.deleteActive());

      this.textInput.addEventListener('input', () => {
        const active = this.canvas.getActiveObject();
        const text = this.normalizeText(this.textInput.value);
        if (!active || active.editorKind !== 'text' || !text.trim()) return;
        this.applyTextChange(active, text).catch(() => {
          this.setFeedback('Das Emoji konnte nicht geladen werden.');
        });
      });
      this.textInput.addEventListener('change', () => {
        this.commitTextInput();
      });
      this.textInput.addEventListener('blur', () => {
        const active = this.canvas.getActiveObject();
        if (active?.editorKind === 'text' && !this.textInput.value.trim()) {
          this.textInput.value = this.objectText(active);
        }
      });
      options.colorInput.addEventListener('input', () => this.setActiveColor(options.colorInput.value));
      this.fontSelect.addEventListener('change', () => {
        this.setActiveFont(this.fontSelect.value).catch(() => {
          this.setFeedback('Schrift konnte nicht geladen werden');
        });
      });
      this.fontButton.addEventListener('click', (event) => {
        event.stopPropagation();
        this.toggleFontPicker();
      });
      this.fontButton.addEventListener('keydown', (event) => {
        if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return;
        event.preventDefault();
        this.openFontPicker(event.key === 'ArrowUp' ? -1 : 1);
      });
      this.fontMenu.addEventListener('keydown', (event) => {
        if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
          event.preventDefault();
          this.moveFontOptionFocus(event.key === 'ArrowDown' ? 1 : -1);
          return;
        }
        if (event.key === 'Home' || event.key === 'End') {
          event.preventDefault();
          this.fontOptionButtons[event.key === 'Home' ? 0 : this.fontOptionButtons.length - 1]?.focus();
          return;
        }
        if (event.key === 'Escape') {
          event.preventDefault();
          event.stopPropagation();
          this.closeFontPicker(true);
          return;
        }
        if (event.key === 'Enter' || event.key === ' ') {
          const activeOption = this.fontOptionButtons.find((button) => button === document.activeElement);
          if (!activeOption) return;
          event.preventDefault();
          activeOption.click();
          return;
        }
        if (event.key === 'Tab') this.closeFontPicker();
      });
      this.colorInput = options.colorInput;

      document.addEventListener('keydown', (event) => {
        if (document.querySelector('dialog[open], [data-panel-trigger][aria-expanded="true"]')) return;
        const activeElement = document.activeElement;
        const editingField = /^(INPUT|TEXTAREA|SELECT)$/.test(activeElement?.tagName || '') ||
          Boolean(activeElement?.isContentEditable);
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
        if (!editingField && command && event.key.toLowerCase() === 'a' && this.selectAll()) {
          event.preventDefault();
          return;
        }
        if (!editingField && command && event.key.toLowerCase() === 'c' && this.copyActive()) {
          event.preventDefault();
          return;
        }
        if (!editingField && command && event.key.toLowerCase() === 'v' && this.pasteClipboard()) {
          event.preventDefault();
          return;
        }
        if (!editingField && (event.key === 'Delete' || event.key === 'Backspace')) {
          this.deleteActive();
          event.preventDefault();
        }
        if (event.key === 'Escape' && !this.fontMenu.hidden) {
          this.closeFontPicker(true);
          event.preventDefault();
          return;
        }
        if (event.key === 'Escape') {
          this.closeIconPicker();
          this.canvas.discardActiveObject();
          this.canvas.requestRenderAll();
          this.updateSelectionPanel();
        }
      });
      document.addEventListener('click', (event) => {
        if (!this.iconMenu.hidden && !event.target.closest('.editor-motif-picker')) this.closeIconPicker();
        if (!this.fontMenu.hidden && !event.target.closest('.editor-font-picker')) this.closeFontPicker();
      });

      this.undoButton = options.undoButton;
      this.redoButton = options.redoButton;
      this.zoomOutButton = options.zoomOutButton;
      this.zoomInButton = options.zoomInButton;
      this.selectAllButton = options.selectAllButton;
    }

    isActiveSelection(object) {
      return Boolean(object && (
        object instanceof root.fabric.ActiveSelection ||
        object.type === 'ActiveSelection' ||
        object.type === 'activeSelection'
      ));
    }

    commitTextInput() {
      const active = this.canvas.getActiveObject();
      if (!active || active.editorKind !== 'text') return;
      return this.applyTextChange(active, this.textInput.value, {
        finalize: true,
        record: true,
      }).catch(() => this.setFeedback('Das Emoji konnte nicht geladen werden.'));
    }

    selectedObjects(active = this.canvas.getActiveObject()) {
      if (!active) return [];
      return this.isActiveSelection(active) ? active.getObjects() : [active];
    }

    configureActiveSelection() {
      const active = this.canvas.getActiveObject();
      if (!this.isActiveSelection(active)) return;
      active.set({
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
        padding: 4,
      });
      active.setControlsVisibility({ mt: false, mb: false, ml: false, mr: false });
      active.setCoords();
    }

    setActiveObjects(objects) {
      const selectable = objects.filter(Boolean);
      this.canvas.discardActiveObject();
      if (!selectable.length) return null;
      if (selectable.length === 1) {
        this.canvas.setActiveObject(selectable[0]);
        return selectable[0];
      }
      const selection = new root.fabric.ActiveSelection(selectable, { canvas: this.canvas });
      this.canvas.setActiveObject(selection);
      this.configureActiveSelection();
      return selection;
    }

    selectAll() {
      const objects = this.canvas.getObjects().filter((object) => object.selectable !== false);
      if (!objects.length) return false;
      this.setActiveObjects(objects);
      this.canvas.requestRenderAll();
      this.updateSelectionPanel();
      this.setFeedback(objects.length === 1 ? 'Element ausgewählt' : '{{count}} Elemente ausgewählt', {
        count: objects.length,
      });
      return true;
    }

    renderIconPicker() {
      this.iconGrid.replaceChildren();
      const svgNamespace = 'http://www.w3.org/2000/svg';
      for (const icon of root.MugIcons.ICONS) {
        const iconLabel = translate(icon.label);
        const button = document.createElement('button');
        button.type = 'button';
        button.className = 'editor-motif-option';
        button.setAttribute('aria-label', translate('{{item}} hinzufügen', { item: iconLabel }));
        button.title = iconLabel;

        const svg = document.createElementNS(svgNamespace, 'svg');
        svg.setAttribute('viewBox', `0 0 ${root.MugIcons.VIEWBOX_SIZE} ${root.MugIcons.VIEWBOX_SIZE}`);
        svg.setAttribute('aria-hidden', 'true');
        const path = document.createElementNS(svgNamespace, 'path');
        path.setAttribute('d', icon.path);
        path.setAttribute('stroke-width', root.MugIcons.STROKE_WIDTH);
        svg.appendChild(path);

        const label = document.createElement('span');
        label.textContent = iconLabel;
        button.append(svg, label);
        button.addEventListener('click', () => this.addIcon(icon.id));
        this.iconGrid.appendChild(button);
      }
    }

    renderFontOptions() {
      this.fontSelect.replaceChildren();
      this.fontMenu.replaceChildren();
      const placeholder = document.createElement('option');
      placeholder.value = '';
      placeholder.textContent = translate('Schrift wählen');
      placeholder.disabled = true;
      this.fontSelect.appendChild(placeholder);
      this.fontPlaceholder = placeholder;
      for (const font of root.DesignFonts.FONTS) {
        const fontLabel = translate(font.label);
        const fontDescription = translate(font.description);
        const option = document.createElement('option');
        option.value = font.key;
        option.textContent = `${fontLabel} – ${fontDescription}`;
        option.style.fontFamily = font.cssFamily;
        this.fontSelect.appendChild(option);

        const button = document.createElement('button');
        button.type = 'button';
        button.className = 'editor-font-option';
        button.dataset.fontKey = font.key;
        button.setAttribute('role', 'option');
        button.setAttribute('aria-selected', 'false');

        const name = document.createElement('span');
        name.className = 'editor-font-option-name';
        name.style.fontFamily = font.cssFamily;
        name.textContent = fontLabel;

        const description = document.createElement('span');
        description.className = 'editor-font-option-description';
        description.textContent = fontDescription;

        button.append(name, description);
        button.addEventListener('click', () => {
          this.fontSelect.value = font.key;
          this.fontSelect.dispatchEvent(new Event('change', { bubbles: true }));
          this.closeFontPicker(true);
        });
        this.fontMenu.appendChild(button);
      }
      this.fontOptionButtons = [...this.fontMenu.querySelectorAll('.editor-font-option')];
      this.fontSelect.value = '';
      this.syncFontPicker('', translate('Schrift wählen'), true);
    }

    syncFontPicker(fontKey, placeholder, disabled) {
      const font = fontKey ? root.DesignFonts.get(fontKey) : null;
      const fontLabel = font ? translate(font.label) : '';
      const fontDescription = font ? translate(font.description) : '';
      this.fontButton.disabled = disabled;
      this.fontCurrent.textContent = font ? fontLabel : placeholder;
      this.fontCurrent.style.fontFamily = font ? font.cssFamily : '';
      this.fontButton.title = font ? `${fontLabel} – ${fontDescription}` : placeholder;
      this.fontOptionButtons.forEach((button) => {
        button.setAttribute('aria-selected', String(button.dataset.fontKey === fontKey));
      });
      if (disabled) this.closeFontPicker();
    }

    toggleFontPicker() {
      if (this.fontButton.disabled) return;
      this.fontMenu.hidden ? this.openFontPicker() : this.closeFontPicker(true);
    }

    openFontPicker(focusDirection = 0) {
      if (this.fontButton.disabled) return;
      this.closeIconPicker();
      this.fontMenu.hidden = false;
      this.fontButton.setAttribute('aria-expanded', 'true');
      const selectedIndex = this.fontOptionButtons.findIndex((button) =>
        button.dataset.fontKey === this.fontSelect.value
      );
      const index = focusDirection < 0
        ? this.fontOptionButtons.length - 1
        : selectedIndex >= 0 ? selectedIndex : 0;
      this.fontOptionButtons[index]?.focus();
    }

    closeFontPicker(restoreFocus = false) {
      this.fontMenu.hidden = true;
      this.fontButton.setAttribute('aria-expanded', 'false');
      if (restoreFocus) this.fontButton.focus();
    }

    moveFontOptionFocus(direction) {
      const current = this.fontOptionButtons.indexOf(document.activeElement);
      const start = current >= 0 ? current : 0;
      const next = (start + direction + this.fontOptionButtons.length) % this.fontOptionButtons.length;
      this.fontOptionButtons[next]?.focus();
    }

    toggleIconPicker() {
      const shouldOpen = this.iconMenu.hidden;
      if (shouldOpen) this.closeFontPicker();
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
      for (const item of design) {
        const object = this.makeObject(item);
        this.keepInside(object);
        this.canvas.add(object);
      }
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

    refreshViewport() {
      if (!this.shell || !this.scroll) return;
      const styles = getComputedStyle(this.scroll);
      const horizontalPadding = parseFloat(styles.paddingLeft) + parseFloat(styles.paddingRight);
      const verticalPadding = parseFloat(styles.paddingTop) + parseFloat(styles.paddingBottom);
      const viewportWidth = Math.max(1, this.scroll.clientWidth - horizontalPadding);
      const viewportHeight = Math.max(1, this.scroll.clientHeight - verticalPadding);
      const aspect = this.width / this.height;
      const fitWidth = Math.min(viewportWidth, viewportHeight * aspect);
      const fitHeight = fitWidth / aspect;
      this.shell.style.width = `${fitWidth * this.zoom}px`;
      this.shell.style.height = `${fitHeight * this.zoom}px`;
      this.canvas?.calcOffset();
    }

    resizePrintArea({ printWidth, printHeight, printFileDpi, defaultX, defaultY, safeMargin }) {
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
          ? { width: item.width * sizeScale, height: item.height * sizeScale }
          : item.type === 'icon'
          ? { size: Math.max(MIN_PRINT_ICON_SIZE, item.size * sizeScale) }
          : { fontSize: Math.max(MIN_PRINT_FONT_SIZE, item.fontSize * sizeScale) }),
      }));

      this.width = nextWidth;
      this.height = nextHeight;
      this.printFileDpi = Number(printFileDpi) || this.printFileDpi;
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
      this.updateImageQualityBadge(object);
      this.emitChange();
    }

    absorbScale(object) {
      if (!object) return;
      if (this.isActiveSelection(object)) return;
      if (object.editorKind === 'image') return;
      if (object.editorKind === 'icon') {
        const size = Math.max(object.width * object.scaleX, object.height * object.scaleY) / this.editorScale;
        this.setIconSize(object, Math.max(MIN_PRINT_ICON_SIZE, size));
        object.setCoords();
        return;
      }
      if (object.editorText !== undefined) return;
      const nextSize = Math.max(MIN_PRINT_FONT_SIZE * this.editorScale, object.fontSize * object.scaleX);
      object.set({ fontSize: nextSize, scaleX: 1, scaleY: 1 });
      object.setCoords();
    }

    setIconSize(object, printSize) {
      const baseSize = Math.max(object.width, object.height) || root.MugIcons.VIEWBOX_SIZE;
      const scale = printSize * this.editorScale / baseSize;
      object.set({ scaleX: scale, scaleY: scale });
    }

    getObjectColor(object) {
      if (object.editorKind === 'image') return null;
      return String(object.editorKind === 'icon'
        ? object.editorDrawing.stroke
        : object.editorText !== undefined
          ? object.editorColor
          : object.fill);
    }

    selectionColor(objects) {
      const colors = objects
        .map((object) => this.getObjectColor(object))
        .filter(Boolean)
        .map((color) => color.toLowerCase());
      return colors.length && colors.every((color) => color === colors[0]) ? colors[0] : null;
    }

    applyObjectColor(object, color) {
      if (object.editorKind === 'image') return;
      if (object.editorKind === 'icon') {
        object.editorDrawing.set({ stroke: color });
        object.dirty = true;
      } else if (object.editorText !== undefined) {
        object.editorColor = color;
        object.editorTextChildren.forEach((child) => child.set({ fill: color }));
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
        text: translate('neues wort'),
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

    async addEmoji(value) {
      const canonical = root.WolkenworteEmoji.canonicalizeText(String(value || ''));
      const runs = root.WolkenworteEmoji.parse(canonical);
      if (runs.length !== 1 || runs[0].type !== 'emoji') {
        throw new TypeError('A single supported emoji is required');
      }
      const emoji = runs[0].text;
      await root.WolkenworteEmoji.preloadTexts([emoji]);
      this.closeIconPicker();
      this.closeFontPicker();
      const color = this.palette[this.canvas.getObjects().length % this.palette.length];
      const object = this.makeObject({
        id: this.nextId('emoji'),
        type: 'text',
        text: emoji,
        x: this.defaultX,
        y: this.defaultY,
        fontSize: 170,
        fontFamily: root.DesignFonts.DEFAULT_FONT_KEY,
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
      this.setFeedback('Emoji hinzugefügt');
      return object;
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
      this.setFeedback('{{item}} hinzugefügt', { item: translate(definition.label) });
    }

    async addImageFile(file) {
      this.closeIconPicker();
      const upload = await this.normalizedImageUpload(file);
      await this.loadImageSource(upload.dataUrl);
      const availableWidth = this.width - this.printMargin * 2;
      const availableHeight = this.height - this.printMargin * 2;
      const maximumScale = Math.min(
        availableWidth / upload.width,
        availableHeight / upload.height
      );
      const minimumScale = MIN_PRINT_IMAGE_SIZE / Math.min(upload.width, upload.height);
      if (minimumScale > maximumScale) throw new Error('unsupported_image_aspect');
      const displayScale = Math.max(minimumScale, Math.min(
        availableWidth * .48 / upload.width,
        availableHeight * .55 / upload.height
      ));
      const object = this.makeObject({
        id: this.nextId('bild'),
        type: 'image',
        src: upload.dataUrl,
        x: this.defaultX,
        y: this.defaultY,
        width: upload.width * displayScale,
        height: upload.height * displayScale,
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
      this.setFeedback('Bild hinzugefügt');
    }

    objectKindLabel(object) {
      if (object?.editorKind === 'icon') return 'Motiv';
      if (object?.editorKind === 'image') return 'Bild';
      return 'Wort';
    }

    deleteActive() {
      const active = this.canvas.getActiveObject();
      if (!active) return;
      const selected = this.selectedObjects(active);
      const deletedLabel = selected.length > 1
        ? translate('{{count}} Elemente', { count: selected.length })
        : translate(this.objectKindLabel(active));
      this.canvas.discardActiveObject();
      this.canvas.remove(...selected);
      this.canvas.requestRenderAll();
      this.recordHistory();
      this.emitChange();
      this.updateSelectionPanel();
      this.setFeedback('{{item}} gelöscht', { item: deletedLabel });
    }

    duplicateDesignItems(designs) {
      const copies = designs.map((design) => {
        const nextDesign = { ...design };
        nextDesign.id = this.nextId(
          nextDesign.type === 'icon' ? 'motiv' : nextDesign.type === 'image' ? 'bild' : 'wort'
        );
        nextDesign.x += 48;
        nextDesign.y += 48;
        return this.makeObject(nextDesign);
      });
      this.canvas.discardActiveObject();
      this.canvas.add(...copies);
      const selection = this.setActiveObjects(copies);
      this.keepInside(selection);
      this.canvas.requestRenderAll();
      this.recordHistory();
      this.emitChange();
      this.updateSelectionPanel();
      return copies;
    }

    duplicateActive() {
      const active = this.canvas.getActiveObject();
      if (!active) return;
      const selected = this.selectedObjects(active);
      const designs = selected.map((object) => this.serializeObject(object));
      this.duplicateDesignItems(designs);
      this.setFeedback(selected.length > 1
        ? '{{count}} Elemente dupliziert'
        : '{{item}} dupliziert', { count: selected.length, item: translate(this.objectKindLabel(active)) });
    }

    copyActive() {
      const active = this.canvas.getActiveObject();
      if (!active) return false;
      const selected = this.selectedObjects(active);
      this.clipboard = selected.map((object) => ({ ...this.serializeObject(object) }));
      this.setFeedback(selected.length > 1
        ? '{{count}} Elemente kopiert'
        : '{{item}} kopiert', { count: selected.length, item: translate(this.objectKindLabel(active)) });
      return true;
    }

    pasteClipboard() {
      if (!Array.isArray(this.clipboard) || !this.clipboard.length) return false;
      const copies = this.duplicateDesignItems(this.clipboard.map((item) => ({ ...item })));
      this.clipboard = copies.map((copy) => ({ ...this.serializeObject(copy) }));
      this.setFeedback(copies.length > 1
        ? '{{count}} Elemente eingefügt'
        : '{{item}} eingefügt', { count: copies.length, item: translate(this.objectKindLabel(copies[0])) });
      return true;
    }

    bringActiveToFront() {
      const active = this.canvas.getActiveObject();
      if (!active) return;
      const objects = this.canvas.getObjects();
      const selected = this.selectedObjects(active);
      const ordered = objects.filter((object) => selected.includes(object));
      const top = objects.slice(-ordered.length);
      if (ordered.every((object, index) => top[index] === object)) {
        this.setFeedback(selected.length > 1 ? 'Auswahl ist bereits ganz vorn.' : 'Element ist bereits ganz vorn.');
        return;
      }
      this.canvas.discardActiveObject();
      ordered.forEach((object) => this.canvas.bringObjectToFront(object));
      this.setActiveObjects(ordered);
      this.canvas.requestRenderAll();
      this.recordHistory();
      this.emitChange();
      this.updateSelectionPanel();
      this.setFeedback(selected.length > 1 ? 'Auswahl ganz nach vorn gebracht' : 'Element ganz nach vorn gebracht');
    }

    serializeObject(object) {
      const transform = root.fabric.util.qrDecompose(object.calcTransformMatrix());
      const common = {
        id: object.editorId,
        x: transform.translateX / this.editorScale,
        y: transform.translateY / this.editorScale,
        angle: transform.angle || 0,
      };
      if (object.editorKind === 'image') {
        return {
          ...common,
          type: 'image',
          src: object.editorSrc,
          width: object.width * Math.abs(transform.scaleX) / this.editorScale,
          height: object.height * Math.abs(transform.scaleY) / this.editorScale,
        };
      }
      common.color = this.getObjectColor(object);
      if (object.editorKind === 'icon') {
        return {
          ...common,
          type: 'icon',
          icon: object.editorIcon,
          size: Math.max(
            object.width * Math.abs(transform.scaleX),
            object.height * Math.abs(transform.scaleY)
          ) / this.editorScale,
        };
      }
      return {
        ...common,
        text: this.objectText(object),
        fontSize: (object.editorFontSize || object.fontSize) * Math.abs(transform.scaleX) / this.editorScale,
        fontFamily: root.DesignFonts.normalizeKey(object.editorFontKey),
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
      this.updateSelectionPanel();
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
      this.selectedObjects(active).forEach((object) => this.applyObjectColor(object, color));
      this.canvas.requestRenderAll();
      this.recordHistory();
      this.emitChange();
      this.updateSelectionPanel();
    }

    async setActiveFont(fontKey) {
      if (!root.DesignFonts.has(fontKey)) return;
      const active = this.canvas.getActiveObject();
      if (!active) return;
      const selected = this.selectedObjects(active);
      const textObjects = selected.filter((object) => object.editorKind === 'text');
      if (!textObjects.length) return;
      const font = root.DesignFonts.get(fontKey);
      if (document.fonts && font.file) {
        await document.fonts.load(`16px "${font.family}"`);
      }

      const replacements = new Map();
      const replacementItems = textObjects.map((object) => ({
        object,
        index: this.canvas.getObjects().indexOf(object),
        item: { ...this.serializeObject(object), fontFamily: font.key },
      }));
      this.canvas.discardActiveObject();
      for (const entry of replacementItems) {
        this.canvas.remove(entry.object);
        const replacement = this.makeObject(entry.item);
        this.canvas.insertAt(entry.index, replacement);
        replacements.set(entry.object, replacement);
      }
      const nextSelected = selected.map((object) => replacements.get(object) || object);
      const selection = this.setActiveObjects(nextSelected);
      this.keepInside(selection);
      this.canvas.requestRenderAll();
      this.recordHistory();
      this.emitChange();
      this.updateSelectionPanel();
      this.setFeedback(textObjects.length === 1
        ? 'Schrift auf {{font}} geändert'
        : '{{font}} auf {{count}} Texte angewendet', {
        font: translate(font.label),
        count: textObjects.length,
      });
    }

    applyPalette(colors) {
      this.palette = colors;
      let colorIndex = 0;
      this.canvas.getObjects().forEach((object) => {
        if (object.editorKind === 'image') return;
        this.applyObjectColor(object, colors[colorIndex % colors.length]);
        colorIndex += 1;
      });
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
        const colorLabel = translate('Farbe {{color}}', { color });
        button.title = colorLabel;
        button.setAttribute('aria-label', colorLabel);
        button.disabled = !hasSelection;
        button.addEventListener('click', () => this.setActiveColor(color));
        this.swatches.appendChild(button);
      }
    }

    updateSelectionPanel() {
      const active = this.canvas.getActiveObject();
      const hasSelection = Boolean(active);
      const selected = this.selectedObjects(active);
      const isMultiple = selected.length > 1;
      const isIcon = !isMultiple && active?.editorKind === 'icon';
      const isImage = !isMultiple && active?.editorKind === 'image';
      const canColor = selected.some((object) => object.editorKind !== 'image');
      const selectedTexts = selected.filter((object) => object.editorKind === 'text');
      const canChangeFont = selectedTexts.length > 0;
      this.selectionPanel.classList.toggle('is-active', hasSelection);
      this.selectionPanel.classList.toggle('is-multiple', isMultiple);
      this.selectionPanel.setAttribute('aria-disabled', String(!hasSelection));
      this.shell.classList.toggle('has-selection', hasSelection);
      this.updateImageQualityBadge(isImage ? active : null);
      this.textInput.disabled = !hasSelection || isMultiple || isIcon || isImage;
      this.colorInput.disabled = !hasSelection || !canColor;
      this.fontSelect.disabled = !hasSelection || !canChangeFont;
      this.selectionActions.forEach((button) => { button.disabled = !hasSelection; });
      this.swatches.querySelectorAll('.editor-swatch').forEach((button) => {
        button.disabled = !hasSelection || !canColor;
      });
      this.selectAllButton.disabled = this.canvas.getObjects().length === 0;
      this.onSelectionChange?.({
        text: hasSelection && !isMultiple && !isIcon && !isImage,
        font: hasSelection && canChangeFont,
        color: hasSelection && canColor,
        transform: hasSelection,
      });
      if (!active) {
        this.selectionStatus.textContent = translate('Element auswählen');
        this.selectionHint.textContent = translate('Element anklicken oder Auswahlrahmen ziehen · ⌘/Strg-Klick wählt mehrere');
        this.textLabel.textContent = translate('Ausgewähltes Element');
        this.textInput.value = '';
        this.fontPlaceholder.textContent = translate('Schrift wählen');
        this.fontSelect.value = '';
        this.syncFontPicker('', translate('Schrift wählen'), true);
        this.swatches.querySelectorAll('.editor-swatch').forEach((button) => {
          button.classList.remove('is-selected');
        });
        return;
      }
      const fontKeys = selectedTexts.map((object) => root.DesignFonts.normalizeKey(object.editorFontKey));
      const commonFontKey = fontKeys.length && fontKeys.every((key) => key === fontKeys[0])
        ? fontKeys[0]
        : '';
      this.fontPlaceholder.textContent = !canChangeFont
        ? translate('Nur für Text')
        : commonFontKey ? translate('Schrift wählen') : translate('Mehrere Schriften');
      this.fontSelect.value = commonFontKey;
      this.syncFontPicker(
        commonFontKey,
        translate(!canChangeFont ? 'Nur für Text' : 'Mehrere Schriften'),
        !canChangeFont
      );
      if (isMultiple) {
        this.selectionStatus.textContent = translate('{{count}} Elemente ausgewählt', { count: selected.length });
        this.selectionHint.textContent = translate('Gemeinsam ziehen, drehen oder skalieren · Escape hebt die Auswahl auf');
        this.textLabel.textContent = translate('Mehrfachauswahl');
        this.textInput.value = translate('{{count}} Elemente', { count: selected.length });
      } else if (isIcon) {
        const iconLabel = translate(active.editorIconLabel);
        this.selectionStatus.textContent = translate('{{item}} bearbeiten', { item: iconLabel });
        this.selectionHint.textContent = translate('Motiv ziehen, drehen, färben oder skalieren');
        this.textLabel.textContent = translate('Ausgewähltes Motiv');
        this.textInput.value = iconLabel;
      } else if (isImage) {
        this.selectionStatus.textContent = translate('Bild bearbeiten');
        this.selectionHint.textContent = translate('Bild ziehen, drehen oder skalieren');
        this.textLabel.textContent = translate('Ausgewähltes Bild');
        this.textInput.value = translate('Bild');
      } else {
        const activeText = this.objectText(active);
        this.selectionStatus.textContent = translate('„{{text}}“ bearbeiten', { text: activeText });
        this.selectionHint.textContent = active.editorText !== undefined
          ? translate('Text und Emoji im Feld bearbeiten')
          : translate('Doppelklick: Wort direkt bearbeiten');
        this.textLabel.textContent = translate('Ausgewähltes Wort');
        this.textInput.value = activeText;
      }
      const activeColor = isMultiple ? this.selectionColor(selected) : this.getObjectColor(active);
      if (activeColor) this.colorInput.value = activeColor;
      this.swatches.querySelectorAll('.editor-swatch').forEach((button) => {
        button.classList.toggle('is-selected', Boolean(activeColor) && button.dataset.color === activeColor.toLowerCase());
      });
    }

    updateImageQualityBadge(object) {
      if (!this.imageQualityBadge) return;
      if (!object || object.editorKind !== 'image' || this.isActiveSelection(object)) {
        this.imageQualityBadge.hidden = true;
        return;
      }

      const design = this.serializeObject(object);
      const element = object.getElement?.() || this.getImageElement(object.editorSrc);
      const quality = root.ImagePrintQuality.evaluate({
        sourceWidth: element?.naturalWidth || element?.width || object.width,
        sourceHeight: element?.naturalHeight || element?.height || object.height,
        printWidth: design.width,
        printHeight: design.height,
        printFileDpi: this.printFileDpi,
      });
      if (!quality) {
        this.imageQualityBadge.hidden = true;
        return;
      }

      const number = (value, digits = 0) => root.WolkenworteI18n?.formatNumber
        ? root.WolkenworteI18n.formatNumber(value, {
            minimumFractionDigits: digits,
            maximumFractionDigits: digits,
          })
        : Number(value).toFixed(digits).replace('.', ',');
      const labelSources = {
        optimal: 'Optimale Qualität',
        good: 'Gute Qualität',
        low: 'Zu niedrige Qualität',
      };
      const descriptionSources = {
        optimal: 'Erreicht das empfohlene Produktziel von {{target}} DPI.',
        good: 'Druckfähig; für maximale Schärfe das Bild auf {{target}} DPI verkleinern.',
        low: 'Für einen scharfen Druck das Bild kleiner skalieren oder höher aufgelöst hochladen (mindestens {{minimum}} DPI).',
      };
      const detail = translate('ca. {{width}} × {{height}} cm · {{dpi}} DPI', {
        width: number(quality.widthCm, 1),
        height: number(quality.heightCm, 1),
        dpi: number(quality.effectiveDpi),
      });
      const label = translate(labelSources[quality.level]);
      const description = translate(descriptionSources[quality.level], {
        target: number(quality.targetDpi),
        minimum: number(quality.minimumDpi),
      });
      this.imageQualityDetail.textContent = detail;
      this.imageQualityLabel.textContent = label;
      this.imageQualityBadge.dataset.quality = quality.level;
      this.imageQualityBadge.title = description;
      this.imageQualityBadge.setAttribute('aria-label', `${detail}. ${label}. ${description}`);

      object.setCoords();
      const bounds = object.getBoundingRect();
      this.imageQualityBadge.hidden = false;
      const shellWidth = this.shell.clientWidth;
      const shellHeight = this.shell.clientHeight;
      const badgeWidth = this.imageQualityBadge.offsetWidth;
      const badgeHeight = this.imageQualityBadge.offsetHeight;
      const anchorX = (bounds.left + bounds.width) / this.canvasWidth * shellWidth;
      const anchorY = (bounds.top + bounds.height) / this.canvasHeight * shellHeight;
      const left = Math.min(shellWidth - 6, Math.max(badgeWidth + 6, anchorX));
      const showAbove = anchorY + badgeHeight + 7 > shellHeight;
      const top = showAbove
        ? Math.min(shellHeight - 2, Math.max(badgeHeight + 7, anchorY))
        : Math.min(shellHeight - badgeHeight - 7, Math.max(2, anchorY));
      this.imageQualityBadge.style.left = `${left}px`;
      this.imageQualityBadge.style.top = `${top}px`;
      this.imageQualityBadge.classList.toggle('is-above', showAbove);
    }

    setZoom(nextZoom) {
      this.zoom = Math.min(2, Math.max(1, Math.round(nextZoom * 4) / 4));
      this.scroll.classList.toggle('is-fit', this.zoom === 1);
      this.refreshViewport();
      if (this.zoom === 1) {
        this.scroll.scrollLeft = 0;
        this.scroll.scrollTop = 0;
      }
      this.zoomOutButton.disabled = this.zoom === 1;
      this.zoomInButton.disabled = this.zoom === 2;
      this.zoomLabel.textContent = `${Math.round(this.zoom * 100)} %`;
    }

    setFeedback(message, params) {
      const translatedMessage = translate(message, params);
      this.feedback.textContent = translatedMessage;
      clearTimeout(this.feedbackTimer);
      this.feedbackTimer = setTimeout(() => {
        if (this.feedback.textContent === translatedMessage) this.feedback.textContent = '';
      }, 1800);
    }
  }

  root.MugPrintEditor = MugPrintEditor;
})(window);
