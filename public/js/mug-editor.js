(function (root) {
  'use strict';

  const MAX_EDITOR_SCALE = .5;
  const MAX_EDITOR_DIMENSION = 1536;
  const DEFAULT_PRINT_MARGIN = 24;
  const MIN_PRINT_FONT_SIZE = root.CloudLimits?.MIN_PRINT_FONT_SIZE || 1;
  const MAX_DESIGN_ELEMENTS = root.CloudLimits?.MAX_DESIGN_ELEMENTS || 1200;
  const MIN_PRINT_ICON_SIZE = 48;
  const MIN_PRINT_IMAGE_SIZE = 24;
  const MAX_UPLOAD_FILE_BYTES = 15 * 1024 * 1024;
  const MAX_EMBEDDED_IMAGE_BYTES = 1_000_000;
  const MAX_UPLOAD_PIXELS = 40_000_000;
  const MAX_UPLOAD_DIMENSION = 2700;
  const MAX_HISTORY = 60;
  const NUDGE_STEP = 8;
  const NUDGE_LARGE_STEP = 40;
  const QUIET_MOBILE_FEEDBACK = new Set(['Änderung übernommen', 'Element ausgewählt', '{{count}} Elemente ausgewählt',
    'Neues Wort hinzugefügt', 'Emoji hinzugefügt', '{{item}} hinzugefügt', 'Bild hinzugefügt', '{{item}} gelöscht',
    '{{count}} Elemente dupliziert', '{{item}} dupliziert', '{{count}} Elemente kopiert', '{{item}} kopiert',
    '{{count}} Elemente eingefügt', '{{item}} eingefügt', 'Auswahl ganz nach vorn gebracht', 'Element ganz nach vorn gebracht',
    'Schriftgröße auf {{size}} pt gesetzt', 'Schrift auf {{font}} geändert', '{{font}} auf {{count}} Texte angewendet']);
  const SELECTION_PRESERVING_TARGETS = [
    'button', 'a', 'input', 'textarea', 'select', 'option', 'label', 'summary', 'details',
    'dialog', '[popover]', '[contenteditable="true"]', '[role="button"]', '[role="link"]',
    '[role="dialog"]', '[role="option"]', '[role="menuitem"]', '[role="slider"]',
    '#product-stage',
  ].join(',');

  function translate(source, params = {}) {
    if (root.WolkenworteI18n) return root.WolkenworteI18n.t(source, params);
    return String(source).replace(/\{\{\s*([\w.-]+)\s*\}\}/g, (_, key) => (
      Object.prototype.hasOwnProperty.call(params, key) ? String(params[key]) : ''
    ));
  }

  function round(value) {
    return Math.round(value * 10) / 10;
  }

  function normalizedAngle(value) {
    const angle = value % 360;
    return angle > 180 ? angle - 360 : angle <= -180 ? angle + 360 : angle || 0;
  }

  function cloneDesign(design) {
    return design.map((item) => ({ ...item }));
  }

  function editorScaleFor(width, height) {
    return Math.min(MAX_EDITOR_SCALE, MAX_EDITOR_DIMENSION / Math.max(width, height));
  }

  // Fabric keeps its advance widths/line box for typing and caret placement.
  // Only the outer object uses ink dimensions. Its saved anchor stays at the
  // original baseline position, including when the ink is asymmetric.
  function tightTextClass(editor) {
    return class ContentText extends root.fabric.IText {
      initDimensions() {
        if (this.isEditing && this.editorFrameCenter) this.clearContextTop();
        const previous = this.editorFrameCenter || { x: 0, y: 0 };
        super.initDimensions();
        this.editorLineWidth = this.width;
        this.editorLineHeight = this.height;
        const baseline = this._fontSizeMult * (.5 - this._fontSizeFraction);
        const thickness = this.fontSize * this.textDecorationThickness / 1000;
        const decorations = [
          ...(this.underline ? [[(baseline + this.offsets.underline) * this.fontSize + thickness / 2, thickness]] : []),
          ...(this.linethrough ? [[(baseline + this.offsets.linethrough) * this.fontSize, thickness]] : []),
        ];
        const bounds = root.DesignContentBounds.text({ text: this.text, fontSize: this.fontSize,
          fontFamily: root.DesignFonts.FONTS.find(font => font.family === this.fontFamily)?.key,
          fontWeight: this.fontWeight }, editor.measureContext, {
          baseline, decorations, skew: false,
          box: { width: this.editorLineWidth, runs: [{ type: 'text', text: this.text, x: 0, width: this.editorLineWidth }] },
        });
        const center = { x: bounds.left + bounds.width / 2, y: bounds.top + bounds.height / 2 };
        this.width = Math.max(1, bounds.width);
        this.height = Math.max(1, bounds.height);
        this.editorFrameCenter = center;
        const matrix = this.calcOwnMatrix();
        const dx = center.x - previous.x, dy = center.y - previous.y;
        this.left += matrix[0] * dx + matrix[2] * dy;
        this.top += matrix[1] * dx + matrix[3] * dy;
      }
      _getLeftOffset() { return -(this.editorLineWidth ?? this.width) / 2 - (this.editorFrameCenter?.x || 0); }
      _getTopOffset() { return -(this.editorLineHeight ?? this.height) / 2 - (this.editorFrameCenter?.y || 0); }
      _getLineLeftOffset(index) {
        const width = this.width;
        this.width = this.editorLineWidth ?? width;
        try { return super._getLineLeftOffset(index); } finally { this.width = width; }
      }
      _renderSelection(...args) {
        const width = this.width;
        this.width = this.editorLineWidth ?? width;
        try { return super._renderSelection(...args); } finally { this.width = width; }
      }
      clearContextTop(restoreManually) {
        const ctx = this.canvas?.contextTop;
        if (!ctx) return;
        ctx.save();
        ctx.transform(...this.canvas.viewportTransform);
        this.transform(ctx);
        // The blinking caret and typing highlight still occupy the line box.
        const left = Math.min(this._getLeftOffset(), -this.width / 2) - 4;
        const top = Math.min(this._getTopOffset(), -this.height / 2) - 4;
        const right = Math.max(this._getLeftOffset() + this.editorLineWidth, this.width / 2) + 4;
        const bottom = Math.max(this._getTopOffset() + this.editorLineHeight, this.height / 2) + 4;
        ctx.clearRect(left, top, right - left, bottom - top);
        if (!restoreManually) ctx.restore();
        return ctx;
      }
    };
  }

  class MugPrintEditor {
    constructor(options) {
      if (!root.fabric) throw new Error('Fabric.js is required for the mug editor');
      if (!root.MugIcons) throw new Error('MugIcons is required for the mug editor');
      if (!root.DesignFonts) throw new Error('DesignFonts is required for the mug editor');
      if (!root.ImagePrintQuality) throw new Error('ImagePrintQuality is required for the mug editor');
      if (!root.DesignContentBounds) throw new Error('Shared content bounds are required for the mug editor');
      if (!root.WordCloudCore || !root.WolkenworteEmoji) {
        throw new Error('The shared emoji renderer is required for the mug editor');
      }
      this.width = options.printWidth;
      this.height = options.printHeight;
      this.printFileDpi = Number(options.printFileDpi) || 300;
      this.printMargin = Number.isFinite(options.safeMargin) ? options.safeMargin : DEFAULT_PRINT_MARGIN;
      this.safeArea = options.safeArea;
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
      this.getImageDesigns = options.getImageDesigns;
      this.openTextEditor = options.openTextEditor;
      this.shell = options.shell;
      this.scroll = options.scroll;
      this.updatePrintAreaPresentation();
      this.selectionPanel = options.selectionPanel;
      this.textInput = options.textInput;
      this.textLabel = options.textLabel;
      this.selectedFontKey = '';
      this.fontButton = options.fontButton;
      this.fontCurrent = options.fontCurrent;
      this.fontMenu = options.fontMenu;
      this.fontSizeInput = options.fontSizeInput;
      this.angleInput = options.angleInput;
      this.angleBadge = options.angleBadge;
      this.styleButtons = {
        fontWeight: options.boldButton,
        fontStyle: options.italicButton,
        underline: options.underlineButton,
        linethrough: options.linethroughButton,
      };
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
        options.moveUpButton,
        options.moveDownButton,
        options.moveLeftButton,
        options.moveRightButton,
        options.smallerButton,
        options.largerButton,
        options.rotateLeftButton,
        options.rotateRightButton,
        options.angleResetButton,
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
      this.imageUsage = root.DesignImageUsage?.create({
        element: options.imageButton.closest('.editor-add-controls'),
        getDesigns: () => this.getImageDesigns ? this.getImageDesigns() : this.getDesign(),
      });
      this.bindControls(options);
      this.renderSwatches();
      this.renderIconPicker();
      this.setZoom(1);
      this.bindTouchEvents();
      if (root.ResizeObserver && this.shell) {
        this.shellResizeObserver = new root.ResizeObserver(() => {
          this.updateImageQualityBadge(this.canvas.getActiveObject());
        });
        this.shellResizeObserver.observe(this.shell);
      }
    }

    normalizedTextStyle(item) {
      if (!root.WordCloudCore.hasTextRun(item?.text)) {
        return { fontWeight: 400, fontStyle: 'normal', underline: false, linethrough: false };
      }
      return root.WordCloudCore.textStyle(item);
    }

    makeObject(item) {
      const object = this.makeDesignObject(item);
      object.editorLayoutFingerprint = typeof item.layoutFingerprint === 'string' ? item.layoutFingerprint : undefined;
      return object;
    }

    makeDesignObject(item) {
      if (item.type === 'icon') return this.makeIconObject(item);
      if (item.type === 'image') return this.makeImageObject(item);
      if (root.WolkenworteEmoji.hasEmoji(item.text)) return this.makeRichTextObject(item);
      const fontKey = root.DesignFonts.normalizeKey(item.fontFamily);
      const style = this.normalizedTextStyle(item);
      this.contentTextClass ||= tightTextClass(this);
      const text = new this.contentTextClass(item.text, {
        left: item.x * this.editorScale,
        top: item.y * this.editorScale,
        originX: 'center',
        originY: 'center',
        fontFamily: root.DesignFonts.get(fontKey).family,
        fontSize: Math.max(MIN_PRINT_FONT_SIZE * this.editorScale, item.fontSize * this.editorScale),
        fontWeight: style.fontWeight,
        fontStyle: 'normal',
        underline: style.underline,
        linethrough: style.linethrough,
        skewX: style.fontStyle === 'italic' ? root.WordCloudCore.ITALIC_SKEW_DEGREES : 0,
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
        strokeWidth: 0,
        cursorColor: '#9c1c4c',
        cursorWidth: 2,
        selectionColor: 'rgba(156, 28, 76, .14)',
        hoverCursor: 'move',
        moveCursor: 'grabbing',
      });
      text.editorKind = 'text';
      text.editorId = item.id || this.nextId();
      text.editorFontKey = fontKey;
      text.editorFontWeight = style.fontWeight;
      text.editorFontStyle = style.fontStyle;
      text.editorUnderline = style.underline;
      text.editorLinethrough = style.linethrough;
      text.editorColorLocked = item.colorLocked === true;
      text.editorLayoutFontSize = Number.isFinite(item.layoutFontSize) ? item.layoutFontSize : undefined;
      text.setControlsVisibility({ mt: false, mb: false, ml: false, mr: false });
      text.setCoords();
      return text;
    }

    contentObjectOptions(item) {
      return {
        left: item.x * this.editorScale, top: item.y * this.editorScale,
        originX: 'center', originY: 'center', angle: item.angle || 0,
        lockScalingFlip: true, centeredScaling: true, centeredRotation: true,
        transparentCorners: false, cornerColor: '#ffffff', cornerStrokeColor: '#9c1c4c',
        borderColor: '#9c1c4c', cornerStyle: 'circle', cornerSize: 14, touchCornerSize: 28,
        padding: 3, strokeWidth: 0, hoverCursor: 'move', moveCursor: 'grabbing',
      };
    }

    placeContentFrame(object, center) {
      object.editorFrameCenter = center;
      const matrix = object.calcOwnMatrix();
      object.left += matrix[0] * center.x + matrix[2] * center.y;
      object.top += matrix[1] * center.x + matrix[3] * center.y;
      object.setControlsVisibility({ mt: false, mb: false, ml: false, mr: false });
      object.setCoords();
      return object;
    }

    makeRichTextObject(item) {
      const fontKey = root.DesignFonts.normalizeKey(item.fontFamily);
      const style = this.normalizedTextStyle(item);
      const fontSize = Math.max(MIN_PRINT_FONT_SIZE * this.editorScale, item.fontSize * this.editorScale);
      const box = root.WordCloudCore.measureTextBox(item.text, fontSize, this.measureContext,
        root.DesignFonts.cssFamily(fontKey), style);
      const children = [], textChildren = [];
      for (const run of box.runs) {
        const centerX = -box.width / 2 + run.x + run.width / 2;
        if (run.type === 'emoji') {
          const element = root.WolkenworteEmoji.getLoadedImage(run);
          if (!element) throw new Error('Emoji artwork must be loaded before restoring the design');
          const width = element.naturalWidth || element.width, height = element.naturalHeight || element.height;
          const scale = Math.min(run.width / width, fontSize / height);
          const ink = root.DesignContentBounds.emoji(run.asset, fontSize);
          const left = Math.max(0, (ink.left + width * scale / 2) / scale);
          const top = Math.max(0, (ink.top + height * scale / 2) / scale);
          const right = Math.min(width, (ink.left + ink.width + width * scale / 2) / scale);
          const bottom = Math.min(height, (ink.top + ink.height + height * scale / 2) / scale);
          children.push(new root.fabric.FabricImage(element, { left: centerX + (left + right - width) * scale / 2,
            top: (top + bottom - height) * scale / 2, originX: 'center', originY: 'center',
            cropX: left, cropY: top, width: right - left, height: bottom - top,
            scaleX: scale, scaleY: scale, strokeWidth: 0, evented: false, selectable: false }));
        } else {
          this.contentTextClass ||= tightTextClass(this);
          const text = new this.contentTextClass(run.text, { left: centerX, top: 0,
            originX: 'center', originY: 'center', fontFamily: root.DesignFonts.get(fontKey).family,
            fontSize, fontWeight: style.fontWeight, underline: style.underline, linethrough: style.linethrough,
            fill: item.color, strokeWidth: 0, evented: false, selectable: false });
          textChildren.push(text); children.push(text);
        }
      }
      const ink = root.DesignContentBounds.union(children.map(child => child.getBoundingRect()));
      const center = { x: ink.left + ink.width / 2, y: ink.top + ink.height / 2 };
      const object = new root.fabric.Group(children, { ...this.contentObjectOptions(item),
        skewX: style.fontStyle === 'italic' ? root.WordCloudCore.ITALIC_SKEW_DEGREES : 0 });
      object.editorKind = 'text';
      object.editorId = item.id || this.nextId();
      object.editorFontKey = fontKey;
      object.editorFontWeight = style.fontWeight;
      object.editorFontStyle = style.fontStyle;
      object.editorUnderline = style.underline;
      object.editorLinethrough = style.linethrough;
      object.editorColorLocked = item.colorLocked === true;
      object.editorLayoutFontSize = Number.isFinite(item.layoutFontSize) ? item.layoutFontSize : undefined;
      object.editorFontSize = fontSize;
      object.editorText = item.text;
      object.editorColor = item.color;
      object.editorTextChildren = textChildren;
      object.text = item.text;
      return this.placeContentFrame(object, center);
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
      const sourceWidth = element.naturalWidth || element.width;
      const sourceHeight = element.naturalHeight || element.height;
      const ink = root.DesignContentBounds.image(element, (width, height) => {
        // Fabric's environment works in browsers and in the Node geometry tests.
        const surface = root.fabric.util.createCanvasElement();
        surface.width = width; surface.height = height;
        return surface;
      });
      const cropX = (ink.left + .5) * sourceWidth;
      const cropY = (ink.top + .5) * sourceHeight;
      const width = ink.width * sourceWidth, height = ink.height * sourceHeight;
      const image = new root.fabric.FabricImage(element, { ...this.contentObjectOptions(item),
        cropX, cropY, width, height,
        scaleX: item.width * this.editorScale / sourceWidth,
        scaleY: item.height * this.editorScale / sourceHeight,
      });
      image.editorKind = 'image';
      image.editorSrc = item.src;
      image.editorId = item.id || this.nextId('bild');
      image.editorSourceWidth = sourceWidth;
      image.editorSourceHeight = sourceHeight;
      // Draw the full source at its original placement so transparent margins
      // retain identical interpolation in the editor and immutable print file.
      image._renderFill = function (ctx) {
        ctx.drawImage(this.getElement(), -this.width / 2 - this.cropX,
          -this.height / 2 - this.cropY, this.editorSourceWidth, this.editorSourceHeight);
      };
      return this.placeContentFrame(image, {
        x: cropX + width / 2 - sourceWidth / 2, y: cropY + height / 2 - sourceHeight / 2,
      });
    }

    makeIconObject(item) {
      const definition = root.MugIcons.get(item.icon);
      if (!definition) throw new Error(`Unknown mug icon: ${item.icon}`);
      const icon = new root.fabric.Path(definition.path, { ...this.contentObjectOptions(item),
        fill: null, stroke: item.color || this.palette[0], strokeWidth: root.MugIcons.STROKE_WIDTH,
        strokeLineCap: 'round', strokeLineJoin: 'round',
      });
      icon.editorKind = 'icon';
      icon.editorIcon = definition.id;
      icon.editorIconLabel = definition.label;
      icon.editorId = item.id || this.nextId('motiv');
      icon.editorColorLocked = item.colorLocked === true;
      this.setIconSize(icon, Math.max(MIN_PRINT_ICON_SIZE, item.size || 160));
      return this.placeContentFrame(icon, {
        x: icon.pathOffset.x - root.MugIcons.VIEWBOX_SIZE / 2,
        y: icon.pathOffset.y - root.MugIcons.VIEWBOX_SIZE / 2,
      });
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
        this.hideAngleBadge();
        this.configureActiveSelection();
        this.updateSelectionPanel();
      });
      this.canvas.on('selection:updated', () => {
        this.hideAngleBadge();
        this.configureActiveSelection();
        this.updateSelectionPanel();
      });
      this.canvas.on('selection:cleared', () => {
        this.hideAngleBadge();
        this.updateSelectionPanel();
      });
      this.canvas.on('object:moving', (event) => this.handleTransform(event.target));
      this.canvas.on('object:scaling', (event) => this.handleTransform(event.target));
      this.canvas.on('object:rotating', (event) => {
        this.handleTransform(event.target);
        this.syncAngleInput();
        this.showAngleBadge(event.target);
      });
      this.canvas.on('mouse:up', () => this.finishAngleBadge());
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

    bindTouchEvents() {
      if (!root.WolkenworteDevice?.isMobileDevice(root.navigator)) return;
      if (!root.CanvasTouch || !root.PointerEvent || !this.scroll) return;
      this.touchMedia = root.matchMedia('(max-width: 940px), (pointer: coarse)');
      this.touchController = new root.CanvasTouch({
        selecting: () => this.mobileMultiSelect === true,
        toggle: object => this.toggleMobileSelection(object),
        navigation: () => this.mobileNavigation === true,
        selected: () => this.canvas.getActiveObject(),
        hit: point => this.touchTarget(point),
        contains: (object, point) => object.containsPoint(this.touchScenePoint(point)),
        canDoubleTap: object => this.mobileViewport && object.editorKind === 'text',
        doubleTap: object => this.beginTextEditing(object),
        deselect: () => this.clearSelection(),
        select: object => {
          this.canvas.getActiveObject()?.exitEditing?.();
          this.canvas.setActiveObject(object);
          this.updateSelectionPanel();
          this.canvas.requestRenderAll();
        },
        toScene: point => this.touchScenePoint(point),
        readObject: object => {
          const center = object.getCenterPoint();
          const minimumScale = Math.max(...this.selectedObjects(object).map(child => {
            const item = this.serializeObject(child);
            return item.type === 'image' ? MIN_PRINT_IMAGE_SIZE / Math.min(item.width, item.height)
              : item.type === 'icon' ? MIN_PRINT_ICON_SIZE / item.size : MIN_PRINT_FONT_SIZE / item.fontSize;
          }));
          return { x: center.x, y: center.y, angle: object.angle || 0,
            scaleX: object.scaleX, scaleY: object.scaleY, minimumScale };
        },
        writeObject: (object, state) => {
          if (!this.canvas.getObjects().includes(object) && this.canvas.getActiveObject() !== object) return;
          const rotated = Math.abs(normalizedAngle(state.angle - (object.angle || 0))) > .001;
          object.set({ angle: state.angle, scaleX: state.scaleX, scaleY: state.scaleY });
          object.setPositionByOrigin(new root.fabric.Point(state.x, state.y), 'center', 'center');
          this.keepInside(object);
          if (rotated) {
            this.syncAngleInput();
            this.showAngleBadge(object);
          }
          this.canvas.requestRenderAll();
          this.emitChange();
        },
        readView: () => {
          const rect = this.scroll.getBoundingClientRect();
          return { zoom: this.zoom, panX: this.mobilePanX || 0, panY: this.mobilePanY || 0,
            center: { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 } };
        },
        writeView: (view, pair) => {
          if (!this.mobileViewport) { this.setZoom(view.zoom * pair.scale); return; }
          const zoom = Math.max(1, Math.min(6, view.zoom * pair.scale)), ratio = zoom / view.zoom;
          this.mobilePanX = pair.end.x - view.center.x - (pair.start.x - view.center.x - view.panX) * ratio;
          this.mobilePanY = pair.end.y - view.center.y - (pair.start.y - view.center.y - view.panY) * ratio;
          this.setZoom(zoom);
        },
        commit: object => {
          if (!this.canvas.getObjects().includes(object) && this.canvas.getActiveObject() !== object) return;
          this.finishAngleBadge();
          this.absorbScale(object);
          this.keepInside(object);
          this.recordHistory();
          this.emitChange();
          this.updateSelectionPanel();
          this.canvas.requestRenderAll();
        },
      });
      const handles = () => {
        this.touchController.finish();
        this.updateTouchControls();
      };
      this.touchMedia.addEventListener('change', handles);
      root.addEventListener?.('blur', () => this.touchController.finish());
      root.addEventListener?.('pagehide', () => this.touchController.finish());
      root.document?.addEventListener('visibilitychange', () => {
        if (root.document.hidden) this.touchController.finish();
      });
      this.canvas.on('object:added', () => this.updateTouchControls());
      this.canvas.on('selection:created', () => this.updateTouchControls());
      this.canvas.on('selection:updated', () => this.updateTouchControls());
      const enabled = event => this.mobileViewport || (this.touchMedia.matches && event.pointerType === 'touch');
      this.scroll.addEventListener('pointerdown', event => {
        if (!enabled(event) || event.button > 0) return;
        event.preventDefault();
        event.stopImmediatePropagation();
        try { this.scroll.setPointerCapture(event.pointerId); } catch { /* Synthetic fixture events have no capture. */ }
        this.touchController.down(event.pointerId, { x: event.clientX, y: event.clientY });
      }, true);
      this.scroll.addEventListener('pointermove', event => {
        if (!this.touchController.points.has(event.pointerId)) return;
        event.preventDefault();
        event.stopImmediatePropagation();
        this.touchController.move(event.pointerId, { x: event.clientX, y: event.clientY });
      }, true);
      for (const name of ['pointerup', 'pointercancel', 'lostpointercapture']) {
        this.scroll.addEventListener(name, event => {
          if (!this.touchController.points.has(event.pointerId)) return;
          event.preventDefault();
          event.stopImmediatePropagation();
          this.touchController.up(event.pointerId, { cancelled: name !== 'pointerup' });
        }, true);
      }
      // Fabric's default touch listener must not run alongside our Pointer Events
      // controller. Prevent compatibility mouse events as well as native scrolling.
      for (const name of ['touchstart', 'touchmove', 'touchend', 'touchcancel']) {
        this.scroll.addEventListener(name, event => {
          if (!this.touchMedia.matches && !this.mobileViewport) return;
          event.preventDefault();
          event.stopImmediatePropagation();
        }, { capture: true, passive: false });
      }
      this.updateTouchControls();
    }

    updateTouchControls() {
      const controls = !root.WolkenworteDevice?.isMobileDevice(root.navigator) ||
        !(this.mobileViewport || this.touchMedia?.matches);
      for (const object of [...this.canvas.getObjects(), this.canvas.getActiveObject()].filter(Boolean)) {
        object.set({ hasControls: controls });
      }
      this.canvas.requestRenderAll();
    }

    touchScenePoint(point) {
      const rect = this.shell.getBoundingClientRect();
      return new root.fabric.Point((point.x - rect.left) / rect.width * this.canvasWidth,
        (point.y - rect.top) / rect.height * this.canvasHeight);
    }

    touchTarget(point) {
      const scene = this.touchScenePoint(point);
      if (scene.x < 0 || scene.y < 0 || scene.x > this.canvasWidth || scene.y > this.canvasHeight) return null;
      const active = this.canvas.getActiveObject();
      if (!this.mobileMultiSelect && this.isActiveSelection(active) && active.containsPoint(scene)) return active;
      const objects = this.canvas.getObjects().filter(object => object.selectable !== false);
      const exact = this.canvas.searchPossibleTargets(objects, scene).target;
      if (exact) return exact;
      // A small CSS-pixel tolerance makes tiny words selectable without inflating
      // every object's handles or letting an already selected word grab the page.
      const tolerance = 10 * this.canvasWidth / this.shell.getBoundingClientRect().width;
      let nearest = null, best = tolerance;
      for (const object of [...objects].reverse()) {
        const box = object.getBoundingRect();
        const d = Math.hypot(Math.max(box.left - scene.x, 0, scene.x - box.left - box.width),
          Math.max(box.top - scene.y, 0, scene.y - box.top - box.height));
        if (d < best) { best = d; nearest = object; }
      }
      return nearest;
    }

    setMobileViewport(enabled) {
      if (enabled && !root.WolkenworteDevice?.isMobileDevice(root.navigator)) return false;
      this.touchController?.finish();
      if (enabled === Boolean(this.mobileViewport)) return;
      if (enabled) {
        this.inlineZoom = this.zoom;
        this.mobileRendering = { retina: this.canvas.enableRetinaScaling,
          retinaMethod: this.canvas.getRetinaScaling, ownRetina: Object.hasOwn(this.canvas, 'getRetinaScaling') };
        this.canvas.enableRetinaScaling = true;
        this.canvas.getRetinaScaling = () => this.mobilePixelRatio || 1;
        this.mobileViewport = true;
        this.mobilePanX = this.mobilePanY = 0;
        this.setZoom(1);
      } else {
        this.mobileViewport = false;
        this.canvas.enableRetinaScaling = this.mobileRendering.retina;
        if (this.mobileRendering.ownRetina) this.canvas.getRetinaScaling = this.mobileRendering.retinaMethod;
        else delete this.canvas.getRetinaScaling;
        this.canvas.setViewportTransform([1, 0, 0, 1, 0, 0]);
        this.canvas.setDimensions({ width: this.canvasWidth, height: this.canvasHeight });
        for (const name of ['left', 'top', 'width', 'height']) this.shell.style.removeProperty(`--mobile-paint-${name}`);
        this.shell.style.removeProperty('transform');
        this.setZoom(this.inlineZoom || 1);
      }
      this.updateTouchControls();
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
      return root.WolkenworteEmoji.canonicalizeText(text);
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
        } catch (error) {
          const message = error.message === 'invalid_image_dimensions'
            ? 'Diese Bildauflösung wird nicht unterstützt. Wählt ein Bild mit höchstens 40 Megapixeln.'
            : 'Das Bild konnte nicht verarbeitet werden. Bitte wählt eine PNG- oder JPG-Datei bis 15 MB.';
          this.imageUsage?.showError(message);
          this.setFeedback(message);
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
      options.moveUpButton.addEventListener('click', () => this.nudgeActive(0, -NUDGE_STEP));
      options.moveDownButton.addEventListener('click', () => this.nudgeActive(0, NUDGE_STEP));
      options.moveLeftButton.addEventListener('click', () => this.nudgeActive(-NUDGE_STEP, 0));
      options.moveRightButton.addEventListener('click', () => this.nudgeActive(NUDGE_STEP, 0));
      options.smallerButton.addEventListener('click', () => this.resizeActive(.9));
      options.largerButton.addEventListener('click', () => this.resizeActive(1.1));
      options.rotateLeftButton.addEventListener('click', () => this.rotateActive(-15));
      options.rotateRightButton.addEventListener('click', () => this.rotateActive(15));
      options.angleResetButton?.addEventListener('click', () => this.setActiveAngle(0));
      this.angleInput?.addEventListener('focus', () => this.angleInput.select());
      this.angleInput?.addEventListener('change', () => this.commitAngleInput());
      this.angleInput?.addEventListener('blur', () => this.syncAngleInput());
      this.angleInput?.addEventListener('keydown', (event) => {
        if (event.key === 'Enter') {
          event.preventDefault();
          this.commitAngleInput();
          this.angleInput.select();
        } else if (event.key === 'Escape') {
          event.preventDefault();
          event.stopPropagation();
          this.syncAngleInput();
          this.angleInput.blur();
        }
      });
      options.duplicateButton.addEventListener('click', () => this.duplicateActive());
      options.bringFrontButton.addEventListener('click', () => this.bringActiveToFront());
      options.deleteButton.addEventListener('click', () => this.deleteActive());
      Object.entries(this.styleButtons).filter(([, button]) => button).forEach(([property, button]) => {
        button.addEventListener('click', () => this.toggleActiveTextStyle(property));
      });

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
      this.fontButton.addEventListener('click', (event) => {
        event.stopPropagation();
        this.toggleFontPicker();
      });
      this.fontButton.addEventListener('keydown', (event) => {
        if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return;
        event.preventDefault();
        this.openFontPicker(event.key === 'ArrowUp' ? -1 : 1);
      });
      this.fontMenu.addEventListener('keydown', (event) => this.onFontPickerKeyDown(event));
      this.fontSizeInput?.addEventListener('focus', () => this.fontSizeInput.select());
      this.fontSizeInput?.addEventListener('change', () => this.commitFontSizeInput());
      this.fontSizeInput?.addEventListener('keydown', (event) => {
        if (event.key === 'Enter') {
          event.preventDefault();
          this.commitFontSizeInput();
          this.fontSizeInput.select();
        } else if (event.key === 'Escape') {
          event.preventDefault();
          event.stopPropagation();
          this.syncFontSizeInput(this.selectedObjects().filter((object) => object.editorKind === 'text'));
          this.fontSizeInput.blur();
        }
      });
      this.colorInput = options.colorInput;

      document.addEventListener('keydown', (event) => {
        if (this.scroll.inert) return;
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
        const nudgeDirections = {
          ArrowUp: [0, -1],
          ArrowDown: [0, 1],
          ArrowLeft: [-1, 0],
          ArrowRight: [1, 0],
        };
        const nudgeDirection = nudgeDirections[event.key];
        const editingCanvasText = Boolean(this.canvas.getActiveObject()?.isEditing);
        if (!editingField && !editingCanvasText && !command && !event.altKey && nudgeDirection) {
          const step = event.shiftKey ? NUDGE_LARGE_STEP : NUDGE_STEP;
          if (this.nudgeActive(nudgeDirection[0] * step, nudgeDirection[1] * step)) {
            event.preventDefault();
            return;
          }
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
          this.clearSelection();
        }
      });
      document.addEventListener('click', (event) => {
        if (!this.iconMenu.hidden && !event.target.closest('.editor-motif-picker')) this.closeIconPicker();
        if (!this.fontMenu.hidden && !event.target.closest('.editor-font-picker')) this.closeFontPicker();
        if (this.shouldDismissSelection(event.target)) this.clearSelection();
      });

      this.undoButton = options.undoButton;
      this.canUndoBoundary = options.canUndoBoundary;
      this.canRedoBoundary = options.canRedoBoundary;
      this.onUndoBoundary = options.onUndoBoundary;
      this.onRedoBoundary = options.onRedoBoundary;
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

    clearSelection() {
      this.touchController?.finish();
      if (!this.canvas.getActiveObject()) return false;
      this.canvas.discardActiveObject();
      this.canvas.requestRenderAll();
      this.updateSelectionPanel();
      return true;
    }

    shouldDismissSelection(target) {
      if (this.mobileViewport) return false;
      if (!target || typeof target.closest !== 'function') return false;
      if (this.shell?.contains(target)) return false;
      if (!target.closest('body')) return false;
      return !target.closest(SELECTION_PRESERVING_TARGETS);
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

    toggleMobileSelection(object) {
      if (!this.mobileMultiSelect || !this.canvas.getObjects().includes(object)) return;
      const selected = this.selectedObjects();
      this.setActiveObjects(selected.includes(object) ? selected.filter(item => item !== object) : [...selected, object]);
      this.updateTouchControls();
      this.updateSelectionPanel();
      this.canvas.requestRenderAll();
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
      this.fontMenu.replaceChildren();
      for (const font of root.DesignFonts.FONTS) {
        const fontLabel = translate(font.label);
        const fontDescription = translate(font.description);
        const button = document.createElement('button');
        button.type = 'button';
        button.tabIndex = -1;
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
          if (this.fontButton.disabled) return;
          this.setActiveFont(font.key).catch(() => {
            this.setFeedback('Schrift konnte nicht geladen werden');
          });
          this.closeFontPicker(true);
        });
        this.fontMenu.appendChild(button);
      }
      this.fontOptionButtons = [...this.fontMenu.querySelectorAll('.editor-font-option')];
      this.syncFontPicker('', translate('Schrift wählen'), true);
    }

    syncFontPicker(fontKey, placeholder, disabled) {
      this.selectedFontKey = fontKey;
      const font = fontKey ? root.DesignFonts.get(fontKey) : null;
      const fontLabel = font ? translate(font.label) : '';
      const fontDescription = font ? translate(font.description) : '';
      this.fontButton.disabled = disabled;
      this.fontCurrent.textContent = font ? fontLabel : placeholder;
      this.fontCurrent.style.fontFamily = font ? font.cssFamily : '';
      this.fontButton.title = font ? `${fontLabel} – ${fontDescription}` : placeholder;
      const focused = this.fontOptionButtons.includes(document.activeElement) ? document.activeElement : null;
      const tabStop = focused || this.fontOptionButtons.find(button => button.dataset.fontKey === fontKey) || this.fontOptionButtons[0];
      this.fontOptionButtons.forEach((button) => {
        button.setAttribute('aria-selected', String(button.dataset.fontKey === fontKey));
        button.tabIndex = button === tabStop ? 0 : -1;
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
        button.dataset.fontKey === this.selectedFontKey
      );
      const index = selectedIndex >= 0 ? selectedIndex
        : focusDirection < 0 ? this.fontOptionButtons.length - 1 : 0;
      this.focusFontOption(index);
    }

    closeFontPicker(restoreFocus = false) {
      this.fontMenu.hidden = true;
      this.fontButton.setAttribute('aria-expanded', 'false');
      if (restoreFocus) this.fontButton.focus({ preventScroll: true });
    }

    focusFontOption(index) {
      this.fontOptionButtons.forEach((button, position) => { button.tabIndex = position === index ? 0 : -1; });
      this.fontOptionButtons[index]?.focus();
    }

    moveFontOptionFocus(direction) {
      const current = this.fontOptionButtons.indexOf(document.activeElement);
      const start = current >= 0 ? current : 0;
      const next = (start + direction + this.fontOptionButtons.length) % this.fontOptionButtons.length;
      this.focusFontOption(next);
    }

    onFontPickerKeyDown(event) {
      if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
        event.preventDefault();
        this.moveFontOptionFocus(event.key === 'ArrowDown' ? 1 : -1);
      } else if (event.key === 'Home' || event.key === 'End') {
        event.preventDefault();
        this.focusFontOption(event.key === 'Home' ? 0 : this.fontOptionButtons.length - 1);
      } else if (event.key === 'Escape') {
        event.preventDefault();
        event.stopPropagation();
        this.closeFontPicker(true);
      } else if (event.key === 'Enter' || event.key === ' ') {
        const activeOption = this.fontOptionButtons.find(button => button === document.activeElement);
        if (!activeOption) return;
        event.preventDefault();
        activeOption.click();
      } else if (event.key === 'Tab') {
        // Resume the document's tab order from the trigger before hiding the
        // focused option.
        this.closeFontPicker(true);
      }
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
      this.touchController?.finish();
      this.fontChangeRevision = (this.fontChangeRevision || 0) + 1;
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

    getSafeArea() {
      return this.safeArea || {
        x: this.printMargin, y: this.printMargin,
        width: this.width - this.printMargin * 2,
        height: this.height - this.printMargin * 2,
      };
    }

    setSafeArea(area) {
      this.touchController?.finish();
      this.safeArea = area;
      const bounds = this.getSafeArea();
      this.defaultX = bounds.x + bounds.width / 2;
      this.defaultY = bounds.y + bounds.height / 2;
      this.updatePrintAreaPresentation();
    }

    updatePrintAreaPresentation() {
      if (!this.shell) return;
      for (const element of [this.shell, this.scroll]) {
        element?.style.setProperty('--print-aspect', `${this.width} / ${this.height}`);
      }
      const area = this.getSafeArea();
      this.shell.style.setProperty('--print-safe-left', `${area.x / this.width * 100}%`);
      this.shell.style.setProperty('--print-safe-top', `${area.y / this.height * 100}%`);
      this.shell.style.setProperty('--print-safe-right', `${(this.width - area.x - area.width) / this.width * 100}%`);
      this.shell.style.setProperty('--print-safe-bottom', `${(this.height - area.y - area.height) / this.height * 100}%`);
    }

    refreshViewport() {
      if (!this.shell || !this.scroll || !this.scroll.clientWidth || !this.scroll.clientHeight) return;
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
      if (this.mobileViewport) {
        const limitX = Math.max(0, (fitWidth * this.zoom - viewportWidth) / 2);
        const limitY = Math.max(0, (fitHeight * this.zoom - viewportHeight) / 2);
        this.mobilePanX = Math.max(-limitX, Math.min(limitX, this.mobilePanX || 0));
        this.mobilePanY = Math.max(-limitY, Math.min(limitY, this.mobilePanY || 0));
        this.shell.style.transform = `translate(-50%, -50%) translate(${this.mobilePanX}px, ${this.mobilePanY}px)`;
        this.renderMobileViewport({ fitWidth, viewportWidth, viewportHeight });
      }
      this.canvas?.calcOffset();
    }

    renderMobileViewport({ fitWidth, viewportWidth, viewportHeight }) {
      if (!root.CanvasViewport || !this.canvas) return;
      const view = root.CanvasViewport.plan({ width: this.canvasWidth, height: this.canvasHeight,
        fitWidth, viewportWidth, viewportHeight, zoom: this.zoom, panX: this.mobilePanX, panY: this.mobilePanY,
        pixelRatio: root.devicePixelRatio || 1 });
      for (const [name, value] of Object.entries({ left: view.offsetX, top: view.offsetY, width: view.paintWidth, height: view.paintHeight })) {
        this.shell.style.setProperty(`--mobile-paint-${name}`, `${value}px`);
      }
      const resize = this.canvas.width !== view.paintWidth || this.canvas.height !== view.paintHeight || this.mobilePixelRatio !== view.retina;
      this.mobilePixelRatio = view.retina;
      if (resize) this.canvas.setDimensions({ width: view.paintWidth, height: view.paintHeight });
      this.canvas.setViewportTransform(view.transform);
      this.canvas.requestRenderAll();
    }

    resizePrintArea({ printWidth, printHeight, printFileDpi, defaultX, defaultY, safeMargin, safeArea }) {
      this.touchController?.finish();
      const nextWidth = Number(printWidth);
      const nextHeight = Number(printHeight);
      if (!Number.isFinite(nextWidth) || !Number.isFinite(nextHeight) || nextWidth < 1 || nextHeight < 1) {
        throw new Error('Invalid print area dimensions');
      }

      const design = this.getDesign();
      const nextPrintMargin = Number.isFinite(safeMargin) ? safeMargin : DEFAULT_PRINT_MARGIN;
      const oldArea = this.getSafeArea();
      const nextArea = safeArea || { x: nextPrintMargin, y: nextPrintMargin,
        width: nextWidth - nextPrintMargin * 2, height: nextHeight - nextPrintMargin * 2 };
      const xScale = nextArea.width / Math.max(1, oldArea.width);
      const yScale = nextArea.height / Math.max(1, oldArea.height);
      const sizeScale = Math.min(xScale, yScale);
      const scaledDesign = design.map((item) => ({
        ...item,
        x: nextArea.x + (item.x - oldArea.x) * xScale,
        y: nextArea.y + (item.y - oldArea.y) * yScale,
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
      this.safeArea = nextArea;
      this.editorScale = editorScaleFor(nextWidth, nextHeight);
      this.canvasWidth = nextWidth * this.editorScale;
      this.canvasHeight = nextHeight * this.editorScale;
      this.margin = this.printMargin * this.editorScale;
      this.defaultX = Number.isFinite(defaultX) ? defaultX : nextWidth / 2;
      this.defaultY = Number.isFinite(defaultY) ? defaultY : nextHeight / 2;
      if (!this.mobileViewport) this.canvas.setDimensions({ width: this.canvasWidth, height: this.canvasHeight });
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
      this.clearArtworkHighlight?.();
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
        const size = root.MugIcons.VIEWBOX_SIZE * object.scaleX / this.editorScale;
        this.setIconSize(object, Math.max(MIN_PRINT_ICON_SIZE, size));
        object.setCoords();
        return;
      }
      if (object.editorText !== undefined) return;
      const before = object.calcOwnMatrix();
      const center = object.editorFrameCenter || { x: 0, y: 0 };
      const anchor = { x: before[4] - before[0] * center.x - before[2] * center.y,
        y: before[5] - before[1] * center.x - before[3] * center.y };
      // Reconstructing a save uses tenth-of-a-print-pixel font sizes. Measure
      // that same size now: tiny differences can cross a font-hinting boundary.
      const nextSize = Math.max(MIN_PRINT_FONT_SIZE,
        round(object.fontSize * object.scaleX / this.editorScale)) * this.editorScale;
      if (Number.isFinite(object.editorLayoutFontSize)) object.editorLayoutFontSize *= Math.abs(object.scaleX);
      object.set({ fontSize: nextSize, scaleX: 1, scaleY: 1 });
      const after = object.calcOwnMatrix();
      const next = object.editorFrameCenter || { x: 0, y: 0 };
      object.set({ left: object.left + anchor.x - (after[4] - after[0] * next.x - after[2] * next.y),
        top: object.top + anchor.y - (after[5] - after[1] * next.x - after[3] * next.y) });
      object.setCoords();
    }

    setIconSize(object, printSize) {
      const baseSize = root.MugIcons.VIEWBOX_SIZE;
      const scale = printSize * this.editorScale / baseSize;
      object.set({ scaleX: scale, scaleY: scale });
    }

    getObjectColor(object) {
      if (object.editorKind === 'image') return null;
      return String(object.editorKind === 'icon'
        ? object.stroke
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

    getConstrainedBounds(object) {
      const boxes = this.selectedObjects(object).flatMap(child => {
        const item = this.serializeObject(child);
        const assets = item.type === 'image' ? { image: root.DesignContentBounds.image(
          this.imageElements.get(item.src), (width, height) => {
            const canvas = root.fabric.util.createCanvasElement();
            canvas.width = width; canvas.height = height; return canvas;
          }) } : undefined;
        const print = root.DesignContentBounds.bounds(item, this.measureContext, assets);
        return [child.getBoundingRect(), { left: print.left * this.editorScale,
          top: print.top * this.editorScale, width: print.width * this.editorScale, height: print.height * this.editorScale }];
      });
      return root.DesignContentBounds.union(boxes);
    }

    keepInside(object) {
      if (!object) return;
      object.setCoords();
      let bounds = this.getConstrainedBounds(object);
      // Two print pixels cover decimal serialization and cross-engine metric
      // rounding without relaxing the server's strict printable-area check.
      const area = this.getSafeArea();
      const left = (area.x + 2) * this.editorScale;
      const top = (area.y + 2) * this.editorScale;
      const right = (area.x + area.width - 2) * this.editorScale;
      const bottom = (area.y + area.height - 2) * this.editorScale;
      const availableWidth = right - left;
      const availableHeight = bottom - top;
      if (bounds.width > availableWidth || bounds.height > availableHeight) {
        const factor = Math.min(availableWidth / bounds.width, availableHeight / bounds.height);
        object.scaleX *= factor;
        object.scaleY *= factor;
        object.setCoords();
        bounds = this.getConstrainedBounds(object);
        this.flashBoundary();
      }

      let deltaX = 0;
      let deltaY = 0;
      if (bounds.left < left) deltaX = left - bounds.left;
      if (bounds.left + bounds.width > right) {
        deltaX = right - bounds.left - bounds.width;
      }
      if (bounds.top < top) deltaY = top - bounds.top;
      if (bounds.top + bounds.height > bottom) {
        deltaY = bottom - bounds.top - bounds.height;
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
        this.imageUsage?.update();
      });
    }

    flushPendingChange() {
      if (!this.changeFrame) return;
      cancelAnimationFrame(this.changeFrame);
      this.changeFrame = null;
      this.onChange(cloneDesign(this.getDesign()));
      this.imageUsage?.update();
    }

    hasPendingTextChange() {
      if (this.pendingFontChange || this.hasPendingFontSizeChange() || this.hasPendingAngleChange()) return true;
      const active = this.canvas.getActiveObject();
      return active?.editorKind === 'text' && Boolean(this.textInput.value.trim()) &&
        this.normalizeText(this.textInput.value) !== this.normalizeText(this.objectText(active));
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
      const selectedIds = this.mobileViewport ? this.selectedObjects().map(object => object.editorId) : [];
      this.historyIndex = index;
      this.setDesign(this.designFromHistory(this.history[index]));
      const selected = this.canvas.getObjects().filter(object => selectedIds.includes(object.editorId));
      if (selected.length) {
        this.canvas.setActiveObject(selected.length === 1 ? selected[0]
          : new root.fabric.ActiveSelection(selected, { canvas: this.canvas }));
        this.configureActiveSelection();
        this.updateTouchControls();
        this.updateSelectionPanel();
        this.canvas.requestRenderAll();
      }
      this.updateHistoryButtons();
      this.setFeedback('Änderung übernommen');
    }

    undo() {
      this.touchController?.finish();
      if (this.historyIndex <= 0 && this.canUndoBoundary?.()) { this.onUndoBoundary?.(); return; }
      this.restoreHistory(this.historyIndex - 1);
    }

    redo() {
      this.touchController?.finish();
      if (this.historyIndex >= this.history.length - 1 && this.canRedoBoundary?.()) { this.onRedoBoundary?.(); return; }
      this.restoreHistory(this.historyIndex + 1);
    }

    updateHistoryButtons() {
      if (!this.undoButton) return;
      this.undoButton.disabled = this.historyIndex <= 0 && !this.canUndoBoundary?.();
      this.redoButton.disabled = this.historyIndex >= this.history.length - 1 && !this.canRedoBoundary?.();
    }

    canAddElements(count = 1) {
      if (this.canvas.getObjects().length + count <= MAX_DESIGN_ELEMENTS) return true;
      this.setFeedback('Pro Druckfläche sind höchstens {{count}} Elemente möglich. Entfernt zuerst einige Elemente.',
        { count: MAX_DESIGN_ELEMENTS });
      return false;
    }

    addWord() {
      if (!this.canAddElements()) return;
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
      if (!this.openTextEditor?.()) {
        this.textInput.focus();
        this.textInput.select();
      }
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
      if (!this.canAddElements()) return;
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
      if (!this.canAddElements()) return;
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
      this.imageUsage?.clearError();
      this.closeIconPicker();
      const upload = await this.normalizedImageUpload(file);
      const existing = this.getImageDesigns ? this.getImageDesigns() : this.getDesign();
      const problem = root.DesignImageData?.problem([existing, { type: 'image', src: upload.dataUrl }]);
      if (problem) { this.imageUsage?.showError(problem); this.setFeedback(problem); return; }
      await this.loadImageSource(upload.dataUrl);
      if (!this.canAddElements()) return;
      const { width: availableWidth, height: availableHeight } = this.getSafeArea();
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
      if (!this.canAddElements(designs.length)) return [];
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
      if (!this.duplicateDesignItems(designs).length) return;
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
      if (!copies.length) return false;
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
      const matrix = object.calcTransformMatrix();
      const transform = root.fabric.util.qrDecompose(matrix);
      const center = object.editorFrameCenter || { x: 0, y: 0 };
      const common = {
        id: object.editorId,
        x: (transform.translateX - matrix[0] * center.x - matrix[2] * center.y) / this.editorScale,
        y: (transform.translateY - matrix[1] * center.x - matrix[3] * center.y) / this.editorScale,
        angle: transform.angle || 0,
        ...(object.editorLayoutFingerprint ? { layoutFingerprint: object.editorLayoutFingerprint } : {}),
      };
      if (object.editorKind === 'image') {
        return {
          ...common,
          type: 'image',
          src: object.editorSrc,
          width: (object.editorSourceWidth || object.width) * Math.abs(transform.scaleX) / this.editorScale,
          height: (object.editorSourceHeight || object.height) * Math.abs(transform.scaleY) / this.editorScale,
        };
      }
      common.color = this.getObjectColor(object);
      if (object.editorColorLocked === true) common.colorLocked = true;
      if (object.editorKind === 'icon') {
        return {
          ...common,
          type: 'icon',
          icon: object.editorIcon,
          size: root.MugIcons.VIEWBOX_SIZE * Math.abs(transform.scaleX) / this.editorScale,
        };
      }
      return {
        ...common,
        text: this.objectText(object),
        fontSize: (object.editorFontSize || object.fontSize) * Math.abs(transform.scaleX) / this.editorScale,
        ...(Number.isFinite(object.editorLayoutFontSize)
          ? { layoutFontSize: round(object.editorLayoutFontSize * Math.abs(transform.scaleX)) } : {}),
        fontFamily: root.DesignFonts.normalizeKey(object.editorFontKey),
        fontWeight: object.editorFontWeight === 700 ? 700 : 400,
        fontStyle: object.editorFontStyle === 'italic' ? 'italic' : 'normal',
        underline: object.editorUnderline === true,
        linethrough: object.editorLinethrough === true,
      };
    }

    resizeActive(factor) {
      const active = this.canvas.getActiveObject();
      if (!active) return;
      active.scaleX *= factor;
      active.scaleY *= factor;
      this.keepInside(active);
      // Font hinting can change the ink bounds after scale becomes font size.
      // Settle boundary-sized text before saving its final measured geometry.
      for (let attempt = 0; attempt < 4; attempt++) {
        this.absorbScale(active);
        this.keepInside(active);
        if (active.editorKind !== 'text' || active.editorText !== undefined || this.isActiveSelection(active) ||
            (active.scaleX === 1 && active.scaleY === 1)) break;
      }
      this.canvas.requestRenderAll();
      this.recordHistory();
      this.emitChange();
      this.updateSelectionPanel();
    }

    nudgeActive(deltaX, deltaY) {
      const active = this.canvas.getActiveObject();
      if (!active || active.isEditing || !Number.isFinite(deltaX) || !Number.isFinite(deltaY)) return false;
      const beforeLeft = active.left;
      const beforeTop = active.top;
      active.set({
        left: active.left + deltaX * this.editorScale,
        top: active.top + deltaY * this.editorScale,
      });
      active.setCoords();
      this.keepInside(active);
      active.setCoords();
      this.canvas.requestRenderAll();
      if (active.left !== beforeLeft || active.top !== beforeTop) {
        this.recordHistory();
        this.emitChange();
        this.updateSelectionPanel();
      }
      return true;
    }

    rotateActive(delta) {
      const active = this.canvas.getActiveObject();
      if (!active) return;
      this.rotateAroundAnchor(active, (active.angle || 0) + delta);
      this.keepInside(active);
      this.canvas.requestRenderAll();
      this.recordHistory();
      this.emitChange();
      this.updateSelectionPanel();
      this.showAngleBadge(active);
      this.finishAngleBadge();
    }

    rotateAroundAnchor(object, angle) {
      const before = object.calcOwnMatrix();
      object.rotate(angle);
      const center = object.editorFrameCenter;
      if (!center) return;
      const after = object.calcOwnMatrix();
      object.set({ left: object.left + (after[0] - before[0]) * center.x + (after[2] - before[2]) * center.y,
        top: object.top + (after[1] - before[1]) * center.x + (after[3] - before[3]) * center.y });
    }

    selectionAngle() {
      const angles = this.selectedObjects().map(object =>
        normalizedAngle(round(root.fabric.util.qrDecompose(object.calcTransformMatrix()).angle)));
      return angles.length && angles.every(angle => angle === angles[0]) ? angles[0] : null;
    }

    syncAngleInput() {
      if (!this.angleInput) return;
      this.angleInput.disabled = !this.canvas.getActiveObject();
      const angle = this.selectionAngle();
      this.angleInput.value = angle === null ? '' : String(angle);
    }

    angleInputValue() {
      const value = String(this.angleInput?.value ?? '').trim();
      return value ? Number(value.replace(',', '.')) : NaN;
    }

    hasPendingAngleChange() {
      if (!this.angleInput || this.angleInput.disabled) return false;
      const value = this.angleInputValue();
      return Number.isFinite(value) && normalizedAngle(round(value)) !== this.selectionAngle();
    }

    commitAngleInput() {
      const changed = this.setActiveAngle(this.angleInputValue());
      this.syncAngleInput();
      return changed;
    }

    setActiveAngle(value) {
      if (!Number.isFinite(value)) return false;
      const active = this.canvas.getActiveObject();
      if (!active) return false;
      const angle = normalizedAngle(value);
      const current = this.selectionAngle();
      if (current !== null && Math.abs(normalizedAngle(angle - current)) < .001) {
        return false;
      }
      // A temporary multi-selection has its own zero. Apply absolute angles to
      // its ungrouped children so 0° always restores each element's orientation.
      const selected = this.selectedObjects(active);
      const multiple = this.isActiveSelection(active);
      if (multiple) this.canvas.discardActiveObject();
      selected.forEach(object => {
        this.rotateAroundAnchor(object, angle);
        this.keepInside(object);
      });
      const selection = multiple ? this.setActiveObjects(selected) : active;
      this.canvas.requestRenderAll();
      this.recordHistory();
      this.emitChange();
      this.updateSelectionPanel();
      this.showAngleBadge(selection);
      this.finishAngleBadge();
      return true;
    }

    showAngleBadge(active = this.canvas.getActiveObject()) {
      if (!this.angleBadge || !active) return;
      clearTimeout(this.angleBadgeTimer);
      const angle = this.selectionAngle();
      // Mixed selections have no single absolute angle. Label their group turn
      // explicitly; the input continues to show mixed rather than a new zero.
      const source = angle === null ? 'Auswahl {{angle}}°' : 'Drehung {{angle}}°';
      const degrees = normalizedAngle(Math.round(angle === null ? active.angle || 0 : angle));
      const params = { angle: angle === null && degrees > 0 ? `+${degrees}` : degrees };
      if (root.WolkenworteI18n) root.WolkenworteI18n.setText(this.angleBadge, source, params);
      else this.angleBadge.textContent = translate(source, params);
      this.angleBadge.classList.remove('is-settled');
      this.angleBadge.hidden = false;
    }

    finishAngleBadge() {
      if (!this.angleBadge || this.angleBadge.hidden) return;
      clearTimeout(this.angleBadgeTimer);
      this.angleBadge.classList.add('is-settled');
      this.angleBadgeTimer = setTimeout(() => this.hideAngleBadge(), 900);
    }

    hideAngleBadge() {
      if (!this.angleBadge) return;
      clearTimeout(this.angleBadgeTimer);
      this.angleBadge.hidden = true;
      this.angleBadge.classList.remove('is-settled');
    }

    setActiveColor(color) {
      const active = this.canvas.getActiveObject();
      if (!active || !/^#[0-9a-f]{6}$/i.test(color)) return;
      this.selectedObjects(active).forEach((object) => {
        this.applyObjectColor(object, color);
        if (object.editorKind !== 'image') object.editorColorLocked = true;
      });
      this.canvas.requestRenderAll();
      this.recordHistory();
      this.emitChange();
      this.updateSelectionPanel();
    }

    setActiveFont(fontKey) {
      if (!root.DesignFonts.has(fontKey)) return Promise.resolve();
      const active = this.canvas.getActiveObject();
      if (!active) return Promise.resolve();
      const selected = this.selectedObjects(active);
      const textObjects = selected.filter((object) => object.editorKind === 'text');
      if (!textObjects.length) return Promise.resolve();
      const revision = this.fontChangeRevision = (this.fontChangeRevision || 0) + 1;
      const operation = this.applyFontToSelection(fontKey, selected, textObjects, revision);
      this.pendingFontChange = operation;
      const finished = () => {
        if (this.pendingFontChange === operation) this.pendingFontChange = null;
      };
      operation.then(finished, finished);
      return operation;
    }

    textStyleActive(object, property) {
      if (property === 'fontWeight') return object.editorFontWeight === 700;
      if (property === 'fontStyle') return object.editorFontStyle === 'italic';
      if (property === 'underline') return object.editorUnderline === true;
      return object.editorLinethrough === true;
    }

    pointSizeValue(value = this.fontSizeInput?.value) {
      const valueAsNumber = Number(this.fontSizeInput?.valueAsNumber);
      if (value === this.fontSizeInput?.value && Number.isFinite(valueAsNumber)) return valueAsNumber;
      return Number(String(value ?? '').trim().replace(',', '.'));
    }

    objectPointSize(object) {
      const item = this.serializeObject(object);
      return item.fontSize * 72 / this.printFileDpi;
    }

    displayPointSize(value) {
      return String(Math.round(value * 10) / 10);
    }

    syncFontSizeInput(textObjects) {
      if (!this.fontSizeInput) return;
      const objects = Array.isArray(textObjects) ? textObjects : [];
      this.fontSizeInput.disabled = objects.length === 0;
      if (!objects.length) {
        this.fontSizeInput.value = '';
        return;
      }
      const sizes = objects.map((object) => this.displayPointSize(this.objectPointSize(object)));
      this.fontSizeInput.value = sizes.every((size) => size === sizes[0]) ? sizes[0] : '';
    }

    hasPendingFontSizeChange() {
      if (!this.fontSizeInput || this.fontSizeInput.disabled || !String(this.fontSizeInput.value).trim()) {
        return false;
      }
      const pointSize = this.pointSizeValue();
      if (!Number.isFinite(pointSize) || pointSize < 1) return false;
      const textObjects = this.selectedObjects().filter((object) => object.editorKind === 'text');
      return textObjects.some((object) => (
        this.displayPointSize(this.objectPointSize(object)) !== this.displayPointSize(pointSize)
      ));
    }

    textItemFitsPrintArea(item) {
      const box = root.DesignContentBounds.bounds(item, this.measureContext);
      const area = this.getSafeArea();
      return box.width <= area.width - 4 && box.height <= area.height - 4;
    }

    setActiveFontSize(value) {
      const pointSize = this.pointSizeValue(value);
      const active = this.canvas.getActiveObject();
      if (!active || !Number.isFinite(pointSize) || pointSize < 1) {
        this.setFeedback('Bitte gebt eine gültige Schriftgröße ein.');
        this.syncFontSizeInput(this.selectedObjects(active)
          .filter((object) => object.editorKind === 'text'));
        return false;
      }
      const selected = this.selectedObjects(active);
      const textObjects = selected.filter((object) => object.editorKind === 'text');
      if (!textObjects.length) return false;
      let printSize = round(pointSize * this.printFileDpi / 72);
      const recommendedPt = root.TextPrintQuality?.MIN_PT;
      // At 150 DPI, rounding a requested 10 pt to 20.8 px would immediately
      // flag it as 9.984 pt. Keep an explicit recommended size above the floor.
      if (Number.isFinite(recommendedPt) && pointSize >= recommendedPt &&
          printSize * 72 / this.printFileDpi < recommendedPt) {
        printSize = Math.ceil(recommendedPt * this.printFileDpi / 72 * 10) / 10;
      }
      const entries = textObjects.map((object) => ({
        object,
        index: this.canvas.getObjects().indexOf(object),
        item: { ...this.serializeObject(object), fontSize: printSize, layoutFontSize: undefined },
      }));
      if (entries.some((entry) => !this.textItemFitsPrintArea(entry.item))) {
        this.setFeedback('Diese Schriftgröße passt nicht auf die aktuelle Druckfläche.');
        this.syncFontSizeInput(textObjects);
        return false;
      }
      const changed = entries.filter((entry) => (
        round(this.serializeObject(entry.object).fontSize) !== printSize
      ));
      if (!changed.length) {
        this.syncFontSizeInput(textObjects);
        return false;
      }
      const replacements = new Map();
      this.canvas.discardActiveObject();
      for (const entry of changed) {
        this.canvas.remove(entry.object);
        const replacement = this.makeObject(entry.item);
        this.canvas.insertAt(entry.index, replacement);
        this.keepInside(replacement);
        replacements.set(entry.object, replacement);
      }
      this.setActiveObjects(selected.map((object) => replacements.get(object) || object));
      this.canvas.requestRenderAll();
      this.recordHistory();
      this.emitChange();
      this.updateSelectionPanel();
      const messageSize = root.WolkenworteI18n?.formatNumber
        ? root.WolkenworteI18n.formatNumber(pointSize, { maximumFractionDigits: 1 })
        : this.displayPointSize(pointSize);
      this.setFeedback('Schriftgröße auf {{size}} pt gesetzt', { size: messageSize });
      return true;
    }

    commitFontSizeInput() {
      if (!this.fontSizeInput || !String(this.fontSizeInput.value).trim()) return false;
      return this.setActiveFontSize(this.fontSizeInput.value);
    }

    toggleActiveTextStyle(property) {
      if (!Object.prototype.hasOwnProperty.call(this.styleButtons, property)) return;
      const active = this.canvas.getActiveObject();
      if (!active) return;
      const selected = this.selectedObjects(active);
      const textObjects = selected.filter((object) => object.editorKind === 'text' &&
        root.WordCloudCore.hasTextRun(this.objectText(object)));
      if (!textObjects.length) return;
      const enable = !textObjects.every((object) => this.textStyleActive(object, property));
      const value = property === 'fontWeight' ? (enable ? 700 : 400)
        : property === 'fontStyle' ? (enable ? 'italic' : 'normal')
        : enable;
      const replacements = new Map();
      const replacementItems = textObjects.map((object) => ({
        object,
        index: this.canvas.getObjects().indexOf(object),
        item: { ...this.serializeObject(object), [property]: value },
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
    }

    async applyFontToSelection(fontKey, selected, textObjects, revision) {
      const font = root.DesignFonts.get(fontKey);
      await root.DesignFonts.loadFont(fontKey, document.fonts);
      // A slow download may finish after another font choice, undo/reset or
      // deleting/replacing a selected object. Never resurrect stale objects.
      if (revision !== this.fontChangeRevision ||
          selected.some(object => !this.canvas.getObjects().includes(object))) return;

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
      const unlocked = this.getDesign().map(({ colorLocked, ...item }) => ({ ...item }));
      const colored = root.DesignLayout.spreadDesignColors(
        unlocked,
        colors,
        this.measureContext,
        { fontFamily: (item) => root.DesignFonts.cssFamily(item.fontFamily) }
      );
      this.canvas.getObjects().forEach((object, index) => {
        if (object.editorKind === 'image') return;
        this.applyObjectColor(object, colored[index].color);
        object.editorColorLocked = false;
      });
      this.canvas.requestRenderAll();
      this.renderSwatches();
      this.recordHistory();
      this.emitChange();
      this.updateSelectionPanel();
    }

    availableSwatchColors() {
      const colors = [];
      const seen = new Set();
      const addColor = (color) => {
        const normalized = String(color || '').trim().toLowerCase();
        if (!/^#[0-9a-f]{6}$/.test(normalized) || seen.has(normalized)) return;
        seen.add(normalized);
        colors.push(normalized);
      };

      (Array.isArray(this.palette) ? this.palette : []).forEach(addColor);
      return colors;
    }

    renderSwatches() {
      const colors = this.availableSwatchColors();
      const signature = colors.join('|');
      if (this.swatchSignature === signature) return;
      this.swatchSignature = signature;
      this.swatches.replaceChildren();
      const hasSelection = Boolean(this.canvas.getActiveObject());
      for (const color of colors) {
        const button = document.createElement('button');
        button.type = 'button';
        button.className = 'editor-swatch';
        button.dataset.color = color;
        button.style.backgroundColor = color;
        const colorLabel = translate('Farbe {{color}}', { color });
        button.title = colorLabel;
        button.setAttribute('aria-label', colorLabel);
        button.disabled = !hasSelection;
        button.addEventListener('click', () => this.setActiveColor(color));
        this.swatches.appendChild(button);
      }
      this.swatches.appendChild(this.colorInput);
    }

    updateSelectionPanel() {
      this.renderSwatches();
      const active = this.canvas.getActiveObject();
      const hasSelection = Boolean(active);
      const selected = this.selectedObjects(active);
      const isMultiple = selected.length > 1;
      const isIcon = !isMultiple && active?.editorKind === 'icon';
      const isImage = !isMultiple && active?.editorKind === 'image';
      const canColor = selected.some((object) => object.editorKind !== 'image');
      const selectedTexts = selected.filter((object) => object.editorKind === 'text');
      const canChangeFont = selectedTexts.length > 0;
      const styleableTexts = selectedTexts.filter((object) =>
        root.WordCloudCore.hasTextRun(this.objectText(object)));
      this.selectionPanel.classList.toggle('is-active', hasSelection);
      this.selectionPanel.classList.toggle('is-multiple', isMultiple);
      this.selectionPanel.setAttribute('aria-disabled', String(!hasSelection));
      this.shell.classList.toggle('has-selection', hasSelection);
      this.updateImageQualityBadge(isImage ? active : null);
      this.textInput.disabled = !hasSelection || isMultiple || isIcon || isImage;
      this.colorInput.disabled = !hasSelection || !canColor;
      this.syncFontSizeInput(selectedTexts);
      this.syncAngleInput();
      this.selectionActions.filter(Boolean).forEach((button) => { button.disabled = !hasSelection; });
      Object.entries(this.styleButtons).filter(([, button]) => button).forEach(([property, button]) => {
        button.disabled = styleableTexts.length === 0;
        const selectedCount = styleableTexts.filter((object) =>
          this.textStyleActive(object, property)).length;
        const pressed = selectedCount === 0 ? 'false'
          : selectedCount === styleableTexts.length ? 'true' : 'mixed';
        button.setAttribute('aria-pressed', pressed);
        button.classList.toggle('is-active', pressed === 'true');
        button.classList.toggle('is-mixed', pressed === 'mixed');
      });
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
      const maximum = this.mobileViewport ? 6 : 2;
      this.zoom = Math.min(maximum, Math.max(1, this.mobileViewport ? nextZoom : Math.round(nextZoom * 4) / 4));
      this.scroll.classList.toggle('is-fit', this.zoom === 1);
      this.refreshViewport();
      if (this.zoom === 1) {
        this.scroll.scrollLeft = 0;
        this.scroll.scrollTop = 0;
      }
      this.zoomOutButton.disabled = this.zoom === 1;
      this.zoomInButton.disabled = this.zoom === maximum;
      this.zoomLabel.textContent = `${Math.round(this.zoom * 100)} %`;
      this.onViewChange?.(this.zoom);
    }

    focusArtworkElement(id, relatedIds = [id]) {
      this.touchController?.finish();
      const objects = this.canvas.getObjects();
      const target = objects.find(object => object.editorId === id);
      if (!target) return false;
      // A deliberate warning-list action may replace the mobile selection lock.
      // Keep just the requested element selected, so dragging never moves a pair.
      this.canvas.discardActiveObject();
      this.canvas.setActiveObject(target);
      this.updateSelectionPanel();
      const related = objects.filter(object => object === target || relatedIds.includes(object.editorId));
      const bounds = related.map(object => object.getBoundingRect());
      const left = Math.min(...bounds.map(box => box.left));
      const top = Math.min(...bounds.map(box => box.top));
      const right = Math.max(...bounds.map(box => box.left + box.width));
      const bottom = Math.max(...bounds.map(box => box.top + box.height));
      const viewportWidth = this.scroll.clientWidth;
      const viewportHeight = this.scroll.clientHeight;
      const fitWidth = Math.min(viewportWidth, viewportHeight * this.canvasWidth / this.canvasHeight);
      const scale = fitWidth / this.canvasWidth;
      this.setZoom(Math.min(this.mobileViewport ? 4 : 2,
        viewportWidth * .8 / Math.max(1, (right - left) * scale),
        viewportHeight * .8 / Math.max(1, (bottom - top) * scale)));
      const x = (left + right) / 2 / this.canvasWidth;
      const y = (top + bottom) / 2 / this.canvasHeight;
      if (this.mobileViewport) {
        this.mobilePanX = (.5 - x) * this.shell.clientWidth;
        this.mobilePanY = (.5 - y) * this.shell.clientHeight;
        this.refreshViewport();
      } else {
        this.scroll.scrollLeft = x * this.shell.clientWidth - viewportWidth / 2;
        this.scroll.scrollTop = y * this.shell.clientHeight - viewportHeight / 2;
      }
      this.clearArtworkHighlight?.();
      const highlight = () => {
        const ctx = this.canvas.contextTop;
        if (!ctx) return;
        ctx.save();
        ctx.transform(...this.canvas.viewportTransform);
        ctx.strokeStyle = '#b27612';
        ctx.lineWidth = 2;
        ctx.setLineDash([5, 4]);
        for (const object of related) {
          if (!this.canvas.getObjects().includes(object)) continue;
          const points = object.getCoords();
          ctx.beginPath();
          ctx.moveTo(points[0].x, points[0].y);
          points.slice(1).forEach(point => ctx.lineTo(point.x, point.y));
          ctx.closePath(); ctx.stroke();
        }
        ctx.restore();
        this.canvas.contextTopDirty = true;
      };
      const unsubscribe = this.canvas.on('after:render', highlight);
      const timer = setTimeout(() => this.clearArtworkHighlight?.(), 1500);
      this.clearArtworkHighlight = () => {
        clearTimeout(timer);
        unsubscribe();
        this.clearArtworkHighlight = null;
        this.canvas.clearContext(this.canvas.contextTop);
        this.canvas.requestRenderAll();
      };
      this.canvas.requestRenderAll();
      return true;
    }

    setFeedback(message, params) {
      if (this.mobileViewport && QUIET_MOBILE_FEEDBACK.has(message)) return;
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
