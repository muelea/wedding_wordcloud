'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { io: ioClient } = require('socket.io-client');
const { startTestServer, createEvent, productDesignPayload } = require('./helpers');
const MugIcons = require('../public/js/mug-icons.js');
const DesignLayout = require('../public/js/design-layout.js');
const DesignFonts = require('../public/js/design-fonts.js');

function connectSocket(baseUrl, slug) {
  return new Promise((resolve, reject) => {
    const socket = ioClient(baseUrl, { query: { slug }, transports: ['websocket'], forceNew: true });
    const timer = setTimeout(() => reject(new Error('socket connection timed out')), 2000);
    socket.once('word-update', () => {
      clearTimeout(timer);
      resolve(socket);
    });
    socket.once('connect_error', reject);
  });
}

function submitWord(socket, word) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`submission timed out: ${word}`)), 2000);
    socket.once('word-accepted', (accepted) => {
      clearTimeout(timer);
      resolve(accepted);
    });
    socket.emit('submit-word', word);
  });
}

function oneSurfaceDesign(design) {
  return { designs: { default: design } };
}

test('every placement action can be applied repeatedly to the complete current design', () => {
  const measurementContext = {
    font: '',
    measureText(text) {
      const fontSize = Number.parseFloat(this.font) || 12;
      return { width: String(text).length * fontSize * .55 };
    },
  };
  const currentDesign = [
    { id: 'wort-ausgang', text: 'Liebe', x: 25, y: 40, fontSize: 18, angle: 0, color: '#a40e4c' },
    { id: 'wort-ergaenzt', text: 'Zusammenhalt', x: 75, y: 60, fontSize: 14, angle: -8, color: '#168f83' },
    { id: 'motiv-ergaenzt', type: 'icon', icon: 'heart', x: 50, y: 75, size: 20, angle: 5, color: '#d90368' },
  ];
  const actions = {
    single: [{ x: 10, y: 20, width: 200, height: 120 }],
    'both-sides': [
      { x: 0, y: 0, width: 80, height: 80 },
      { x: 120, y: 0, width: 80, height: 80 },
    ],
    'full-wrap': [{ x: 5, y: 10, width: 240, height: 90 }],
    centered: [{ x: 50, y: 30, width: 120, height: 120 }],
    'fit-area': [{ x: 10, y: 20, width: 800, height: 500, optimize: true }],
  };

  for (const [key, slots] of Object.entries(actions)) {
    const applied = DesignLayout.applyLayoutAction(currentDesign, slots, measurementContext);
    const expectedLength = key === 'both-sides' ? currentDesign.length * 2 : currentDesign.length;
    assert.equal(applied.length, expectedLength, `${key} must preserve the complete design`);
    assert.equal(new Set(applied.map((item) => item.id)).size, applied.length);

    const edited = applied.map((item, index) => index === 0
      ? { ...item, x: item.x + 19, y: item.y + 11, fontSize: 12 }
      : { ...item });
    const appliedAgain = DesignLayout.applyLayoutAction(edited, slots, measurementContext);
    assert.equal(appliedAgain.length, expectedLength, `${key} must be safe to execute again`);
    assert.deepEqual(
      [...appliedAgain.map((item) => item.id)].sort(),
      [...applied.map((item) => item.id)].sort(),
      `${key} must not add or remove elements when repeated`
    );
    assert.notDeepEqual(appliedAgain, edited, `${key} must process the edited canvas again`);
  }
});

test('area optimization fills the target with the complete current design', () => {
  const measurementContext = {
    font: '',
    measureText(text) {
      const fontSize = Number.parseFloat(this.font) || 12;
      return { width: String(text).length * fontSize * .55 };
    },
  };
  const currentDesign = [
    { id: 'wort-a', text: 'Liebe', x: 40, y: 40, fontSize: 18, angle: 0, color: '#a40e4c' },
    { id: 'wort-b', text: 'Wir', x: 55, y: 55, fontSize: 14, angle: -8, color: '#168f83' },
    { id: 'motiv-a', type: 'icon', icon: 'heart', x: 45, y: 60, size: 48, angle: 5, color: '#d90368' },
  ];
  const target = [{ x: 100, y: 200, width: 800, height: 500, optimize: true }];
  const optimized = DesignLayout.optimizeDesign(currentDesign, target, measurementContext, {
    fontFamily: 'Georgia',
  });

  assert.deepEqual(optimized.map((item) => item.id), currentDesign.map((item) => item.id));
  assert.deepEqual(optimized.map((item) => item.color), currentDesign.map((item) => item.color));
  assert.deepEqual(optimized.map((item) => item.angle), currentDesign.map((item) => item.angle));
  assert.ok(optimized[0].fontSize > currentDesign[0].fontSize * 2);
  assert.ok(optimized.every((item) => item.x >= 100 && item.x <= 900));
  assert.ok(optimized.every((item) => item.y >= 200 && item.y <= 700));

  const oneWord = DesignLayout.optimizeDesign(
    [{ id: 'solo', text: 'Ja', x: 10, y: 10, fontSize: 12, angle: 0, color: '#400f26' }],
    target,
    measurementContext,
    { fontFamily: 'Georgia' }
  );
  assert.ok(oneWord[0].fontSize > 400, 'a single word should grow to use the available height');
  assert.equal(oneWord[0].x, 500);
  assert.equal(oneWord[0].y, 450);

  const editedAfterOptimization = [{
    ...oneWord[0],
    x: 150,
    y: 240,
    fontSize: 24,
    color: '#168f83',
  }];
  const optimizedAgain = DesignLayout.optimizeDesign(
    editedAfterOptimization,
    target,
    measurementContext,
    { fontFamily: 'Georgia' }
  );
  assert.ok(optimizedAgain[0].fontSize > 400, 'the active option must be safe to execute again');
  assert.equal(optimizedAgain[0].x, 500);
  assert.equal(optimizedAgain[0].y, 450);
  assert.equal(optimizedAgain[0].color, '#168f83', 'manual edits remain the optimization input');
});

test('area optimization measures every text with its selected design font', () => {
  const measuredFonts = [];
  const measurementContext = {
    _font: '',
    set font(value) {
      this._font = value;
      measuredFonts.push(value);
    },
    get font() { return this._font; },
    measureText(text) {
      const fontSize = Number.parseFloat(this._font) || 12;
      return { width: String(text).length * fontSize * .5 };
    },
  };
  const design = [
    { id: 'klassisch', text: 'Liebe', x: 50, y: 50, fontSize: 24, angle: 0, color: '#a40e4c', fontFamily: 'classic' },
    { id: 'handschrift', text: 'Glück', x: 80, y: 70, fontSize: 22, angle: 0, color: '#168f83', fontFamily: 'caveat' },
  ];
  const optimized = DesignLayout.optimizeDesign(
    design,
    [{ x: 0, y: 0, width: 500, height: 300, optimize: true }],
    measurementContext,
    { fontFamily: (item) => DesignFonts.cssFamily(item.fontFamily) }
  );

  assert.equal(optimized.length, design.length);
  assert.ok(measuredFonts.some((font) => font.includes('Georgia')));
  assert.ok(measuredFonts.some((font) => font.includes('Wolkenworte Caveat')));
  assert.deepEqual(optimized.map((item) => item.fontFamily), ['classic', 'caveat']);
});

test('configurator exposes every curated product with verified Printful geometry', async (t) => {
  const { baseUrl, close } = await startTestServer();
  t.after(close);
  const event = await createEvent(baseUrl, { coupleName: 'Mara & Theo' });

  const empty = await fetch(`${baseUrl}/api/events/${event.slug}/configurator`);
  assert.equal(empty.status, 409, 'an empty cloud cannot be configured');

  const socket = await connectSocket(baseUrl, event.slug);
  t.after(() => socket.close());
  await submitWord(socket, 'Liebe');

  const res = await fetch(`${baseUrl}/api/events/${event.slug}/configurator`);
  assert.equal(res.status, 200);
  const data = await res.json();
  assert.equal(data.product.key, 'white-glossy-mug-duo-11oz');
  assert.deepEqual(data.product.printFile, { width: 2700, height: 1050, dpi: 300, placement: 'default' });
  assert.equal(data.product.size.volumeMl, 325);
  assert.equal(data.product.defaultQuantity, 1);
  assert.equal(data.product.minQuantity, 1);
  assert.equal(data.product.maxQuantity, 99);
  assert.equal(data.product.unitPriceCents, undefined, 'the configurator must not expose a stale fixed retail price');
  assert.deepEqual(
    data.products.map((product) => ({ key: product.key, label: product.size.label, printFile: product.printFile })),
    [
      {
        key: 'white-glossy-mug-duo-11oz',
        label: '11 oz',
        printFile: { width: 2700, height: 1050, dpi: 300, placement: 'default' },
      },
      {
        key: 'white-glossy-mug-15oz',
        label: '15 oz',
        printFile: { width: 2700, height: 1140, dpi: 300, placement: 'default' },
      },
      {
        key: 'white-glossy-mug-20oz',
        label: '20 oz',
        printFile: { width: 3071, height: 1205, dpi: 300, placement: 'default' },
      },
      {
        key: 'cork-back-coaster',
        label: '95 × 95 mm',
        printFile: {
          width: 1181, height: 1181, dpi: 300, fillMode: 'cover', placement: 'default',
        },
      },
      {
        key: 'matte-poster-30x40cm',
        label: '30 × 40 cm',
        printFile: {
          width: 3544, height: 4724, dpi: 300, fillMode: 'cover', canRotate: true, placement: 'default',
        },
      },
      {
        key: 'matte-poster-50x70cm',
        label: '50 × 70 cm',
        printFile: {
          width: 5906, height: 8268, dpi: 300, fillMode: 'cover', canRotate: true, placement: 'default',
        },
      },
      {
        key: 'framed-matte-poster-black-30x40cm',
        label: '30 × 40 cm',
        printFile: {
          width: 3600, height: 4800, dpi: 300, fillMode: 'cover', canRotate: true, placement: 'default',
        },
      },
      {
        key: 'framed-matte-poster-black-50x70cm',
        label: '50 × 70 cm',
        printFile: {
          width: 5906, height: 8268, dpi: 300, fillMode: 'cover', canRotate: true, placement: 'default',
        },
      },
      {
        key: 'all-over-tote-black-handles',
        label: '39 × 39 cm',
        printFile: {
          width: 2550, height: 2475, dpi: 150, fillMode: 'cover', placement: 'default',
        },
      },
      {
        key: 'throw-blanket-50x60in',
        label: '127 × 153 cm',
        printFile: {
          width: 9450, height: 7950, dpi: 150, fillMode: 'cover', canRotate: true, placement: 'default',
        },
      },
      {
        key: 'all-over-basic-pillow-18in',
        label: '46 × 46 cm',
        printFile: {
          width: 2850, height: 2850, dpi: 150, fillMode: 'cover', placement: 'front',
        },
      },
      {
        key: 'spiral-notebook-dotted',
        label: '14,5 × 21 cm',
        printFile: {
          width: 1725, height: 2625, dpi: 300, fillMode: 'cover', placement: 'front',
        },
      },
    ]
  );
  assert.deepEqual(
    data.productFamilies.map((family) => family.key),
    ['mugs', 'posters', 'home', 'bags', 'notebooks']
  );
  assert.ok(data.productFamilies.every((family) => family.thumbnail.startsWith('/assets/product-thumbnails/')));
  const pillow = data.products.find((candidate) => candidate.key === 'all-over-basic-pillow-18in');
  assert.deepEqual(pillow.printSurfaces, [
    { key: 'front', label: 'Vorderseite' },
    { key: 'back', label: 'Rückseite' },
  ]);
  const mockupAssets = Object.fromEntries(data.products
    .filter((candidate) => candidate.previewMockup)
    .map((candidate) => [candidate.key, candidate.previewMockup.assets]));
  assert.deepEqual(mockupAssets, {
    'cork-back-coaster': { default: '/assets/product-mockups/coaster-flat.png' },
    'matte-poster-30x40cm': { default: '/assets/product-mockups/matte-poster-30x40.png' },
    'matte-poster-50x70cm': { default: '/assets/product-mockups/matte-poster-50x70.png' },
    'framed-matte-poster-black-30x40cm': {
      default: '/assets/product-mockups/framed-poster-black-30x40.png',
    },
    'framed-matte-poster-black-50x70cm': {
      default: '/assets/product-mockups/framed-poster-black-50x70.png',
    },
    'all-over-tote-black-handles': { default: '/assets/product-mockups/tote-front.jpg' },
    'throw-blanket-50x60in': {
      default: '/assets/product-mockups/throw-blanket-flat-horizontal.png',
    },
    'spiral-notebook-dotted': {
      front: '/assets/product-mockups/spiral-notebook-front.png',
      back: '/assets/product-mockups/spiral-notebook-back.png',
    },
    'all-over-basic-pillow-18in': {
      front: '/assets/product-mockups/basic-pillow-flat.png',
      back: '/assets/product-mockups/basic-pillow-flat.png',
    },
  });
  const mockupCanvases = Object.fromEntries(data.products
    .filter((candidate) => candidate.previewMockup)
    .map((candidate) => [candidate.key, candidate.previewMockup.canvas]));
  assert.deepEqual(mockupCanvases, {
    'cork-back-coaster': {
      left: 17.5, top: 17.7, width: 65.3, height: 64.9, fit: 'cover', clipPath: 'none',
    },
    'matte-poster-30x40cm': {
      left: 25, top: 17.7, width: 49.2, height: 65.5, fit: 'cover', clipPath: 'none',
    },
    'matte-poster-50x70cm': {
      left: 21.4, top: 10, width: 57.2, height: 80, fit: 'cover', clipPath: 'none',
    },
    'framed-matte-poster-black-30x40cm': {
      left: 24.1, top: 15.1, width: 51.9, height: 69.7, fit: 'cover', clipPath: 'none',
    },
    'framed-matte-poster-black-50x70cm': {
      left: 22.8, top: 11.3, width: 54.5, height: 77.4, fit: 'cover', clipPath: 'none',
    },
    'all-over-tote-black-handles': {
      left: 5,
      top: 35.5,
      width: 90,
      height: 58.5,
      fit: 'cover',
      clipPath: 'polygon(0 0, 100% 0, 96% 100%, 3% 100%)',
    },
    'throw-blanket-50x60in': {
      left: 6.3, top: 13.7, width: 86.8, height: 71.9, fit: 'cover', clipPath: 'none',
    },
    'spiral-notebook-dotted': {
      left: 19.9, top: 4.7, width: 57.6, height: 90.4, fit: 'cover', clipPath: 'none',
    },
    'all-over-basic-pillow-18in': {
      left: 17.1, top: 18.7, width: 64.8, height: 63.1, fit: 'cover', clipPath: 'none',
    },
  });
  const tote = data.products.find((candidate) => candidate.key === 'all-over-tote-black-handles');
  assert.deepEqual(
    [tote.previewMockup.width, tote.previewMockup.height],
    [700, 1000]
  );
  assert.equal(tote.previewMockup.blendMode, 'multiply');
  assert.deepEqual(
    data.product.themes.map((theme) => theme.key),
    ['pastel', 'sage-gold', 'ocean', 'custom']
  );
  assert.ok(data.product.themes.every((theme) => theme.colors.length >= 6));
  assert.deepEqual(data.product.layouts.map((layout) => layout.key), ['single', 'both-sides', 'full-wrap', 'fit-area']);
  assert.ok(data.products.every((candidate) => {
    const fitArea = candidate.layouts.find((layout) => layout.key === 'fit-area');
    return !fitArea || fitArea.label === 'Fläche optimal nutzen';
  }));
  const poster = data.products.find((candidate) => candidate.key === 'matte-poster-30x40cm');
  assert.equal(poster.defaultOrientation, 'portrait');
  assert.deepEqual(poster.orientations.map((orientation) => orientation.key), ['portrait', 'landscape']);
  assert.deepEqual(
    poster.orientations.map((orientation) => [
      orientation.size.label,
      orientation.printFile.width,
      orientation.printFile.height,
    ]),
    [['30 × 40 cm', 3544, 4724], ['40 × 30 cm', 4724, 3544]]
  );
  const posterProducts = data.products.filter((candidate) => candidate.familyKey === 'posters');
  assert.equal(posterProducts.length, 4);
  assert.ok(posterProducts.every((candidate) =>
    candidate.orientations.map((orientation) => orientation.key).join(',') === 'portrait,landscape'
  ));
  assert.ok(data.products.filter((candidate) => candidate.familyKey !== 'posters')
    .every((candidate) => candidate.orientations.length === 0));
  assert.equal(data.product.defaultOrientation, 'default');
  assert.deepEqual(data.product.orientations, []);
  assert.deepEqual(data.product.layoutGeometry.single, [{ x: 127, y: 65, side: 920 }]);
  assert.deepEqual(data.product.layoutGeometry['full-wrap'], [{ x: 130, y: 65, width: 2440, height: 920 }]);
  assert.deepEqual(data.product.layoutGeometry['fit-area'], [{ x: 36, y: 36, width: 2628, height: 978, optimize: true }]);
  assert.deepEqual(data.words, [['liebe', 1]]);

  const db = require('../src/db');
  for (const expected of [
    { key: 'white-glossy-mug-15oz', variantId: 4830, width: 2700, height: 1140 },
    { key: 'white-glossy-mug-20oz', variantId: 16586, width: 3071, height: 1205 },
    { key: 'cork-back-coaster', variantId: 15662, width: 1181, height: 1181 },
    { key: 'matte-poster-30x40cm', variantId: 8948, width: 3544, height: 4724 },
    { key: 'matte-poster-50x70cm', variantId: 8952, width: 5906, height: 8268 },
    { key: 'framed-matte-poster-black-30x40cm', variantId: 9357, width: 3600, height: 4800 },
    { key: 'framed-matte-poster-black-50x70cm', variantId: 9358, width: 5906, height: 8268 },
    { key: 'all-over-tote-black-handles', variantId: 4533, width: 2550, height: 2475 },
    { key: 'throw-blanket-50x60in', variantId: 10986, width: 9450, height: 7950 },
    { key: 'all-over-basic-pillow-18in', variantId: 4532, width: 2850, height: 2850 },
    { key: 'spiral-notebook-dotted', variantId: 12141, width: 1725, height: 2625 },
  ]) {
    const saveResponse = await fetch(`${baseUrl}/api/events/${event.slug}/configurations`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        productKey: expected.key,
        quantity: 1,
        theme: 'pastel',
        words: [['liebe', 1]],
        ...productDesignPayload(expected.key),
      }),
    });
    assert.equal(saveResponse.status, 201);
    const saved = await saveResponse.json();
    const stored = db.getConfiguration(saved.id);
    assert.equal(stored.product_key, expected.key);
    assert.equal(Number(stored.printful_variant_id), expected.variantId);
    assert.equal(Number(stored.print_width), expected.width);
    assert.equal(Number(stored.print_height), expected.height);
    const svg = await fetch(baseUrl + saved.printFileUrl).then((response) => response.text());
    assert.match(svg, new RegExp(`width="${expected.width}" height="${expected.height}"`));
  }

  const landscapeSave = await fetch(`${baseUrl}/api/events/${event.slug}/configurations`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      productKey: 'matte-poster-30x40cm',
      orientation: 'landscape',
      quantity: 1,
      theme: 'pastel',
      words: [['liebe', 1]],
      ...productDesignPayload('matte-poster-30x40cm', 'landscape'),
    }),
  });
  assert.equal(landscapeSave.status, 201);
  const landscapeConfiguration = await landscapeSave.json();
  assert.equal(landscapeConfiguration.orientation, 'landscape');
  const storedLandscape = db.getConfiguration(landscapeConfiguration.id);
  assert.equal(storedLandscape.orientation, 'landscape');
  assert.equal(Number(storedLandscape.printful_variant_id), 8948,
    'orientation must not create a different priced Printful variant');
  assert.equal(Number(storedLandscape.print_width), 4724);
  assert.equal(Number(storedLandscape.print_height), 3544);
  const landscapeSvg = await fetch(baseUrl + landscapeConfiguration.printFileUrl)
    .then((response) => response.text());
  assert.match(landscapeSvg, /width="4724" height="3544"/);
  const landscapeEdit = await fetch(
    `${baseUrl}/api/events/${event.slug}/configurations/${landscapeConfiguration.id}/edit`
  ).then((response) => response.json());
  assert.equal(landscapeEdit.orientation, 'landscape');
  assert.equal(landscapeEdit.product.size.label, '40 × 30 cm');
  assert.equal(landscapeEdit.product.printFile.width, 4724);
  assert.equal(landscapeEdit.product.printFile.height, 3544);

  const invalidOrientation = await fetch(`${baseUrl}/api/events/${event.slug}/configurations`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ productKey: 'matte-poster-30x40cm', orientation: 'diagonal' }),
  });
  assert.equal(invalidOrientation.status, 400);
  assert.equal((await invalidOrientation.json()).error, 'invalid_orientation');

  const threeBrowserBuild = await fetch(`${baseUrl}/vendor/three.min.js?v=0.160.1`);
  assert.equal(threeBrowserBuild.status, 200);
  assert.match(threeBrowserBuild.headers.get('cache-control') || '', /immutable/);
  assert.ok((await threeBrowserBuild.text()).length > 600000, 'the local Three.js build should be served in full');

  const sharedMugViewer = await fetch(`${baseUrl}/js/mug-3d-viewer.js?v=20260821-1`);
  assert.equal(sharedMugViewer.status, 200);
  assert.match(sharedMugViewer.headers.get('cache-control') || '', /immutable/);
  assert.match(await sharedMugViewer.text(), /Mug3DViewer/);

  assert.deepEqual(DesignFonts.FONTS.map((font) => font.key), [
    'classic', 'lora', 'montserrat', 'caveat', 'baloo-2',
  ]);
  const bundledFont = await fetch(`${baseUrl}/assets/design-fonts/lora/Lora.ttf?v=20260826-1`);
  assert.equal(bundledFont.status, 200);
  assert.ok((await bundledFont.arrayBuffer()).byteLength > 100000);

  const [landingPage, configurePage] = await Promise.all([
    fetch(`${baseUrl}/`).then((response) => response.text()),
    fetch(`${baseUrl}/e/${event.slug}/configure`).then((response) => response.text()),
  ]);
  assert.match(landingPage, /mug-3d-viewer\.js\?v=20260821-1/);
  assert.match(configurePage, /mug-3d-viewer\.js\?v=20260821-1/);
  assert.match(configurePage, /id="product-options"/);
  assert.match(configurePage, /id="variant-options"/);
  assert.match(configurePage, /id="flat-product-preview"/);
  assert.match(configurePage, /class="flat-product-composite"/);
  assert.match(configurePage, /id="flat-product-mockup"/);
  assert.match(configurePage, /class="preview-disclaimer">Die Vorschau dient zur Orientierung – Farben, Position und Beschnitt können auf dem fertigen Produkt leicht abweichen\.<\/p>/);
  assert.match(configurePage, /id="placement-options"/);
  assert.match(configurePage, /id="orientation-step" hidden/);
  assert.match(configurePage, /id="orientation-options"/);
  assert.match(configurePage, /function activateOrientation\(orientation\)/);
  assert.match(configurePage, /orientation: selectedOrientation/);
  assert.match(configurePage, /--product-mockup-rotation/);
  assert.match(configurePage, /id="surface-tabs"/);
  assert.match(configurePage, /class="editor-tools editor-tools-primary">[\s\S]*?id="surface-editor"[\s\S]*?id="editor-add"/);
  assert.match(configurePage, /id="selected-theme-swatches"/);
  assert.doesNotMatch(configurePage, /id="selected-theme-detail"/);
  assert.match(configurePage, /class="workspace-tools"/);
  assert.match(configurePage, /\.workspace-tools \{[\s\S]*?position: relative;[\s\S]*?z-index: 20;/);
  assert.match(configurePage, /--workspace-stage-height: clamp\(440px, 58vh, 600px\)/);
  assert.match(configurePage, /grid-template-columns: repeat\(2, minmax\(0, 1fr\)\)/);
  assert.match(configurePage, /design-fonts\.js\?v=20260826-1/);
  assert.match(configurePage, /design-layout\.js\?v=20260826-4/);
  assert.match(configurePage, /mug-icons\.js\?v=20260826-1/);
  assert.match(configurePage, /mug-editor\.js\?v=20260826-9/);
  assert.match(configurePage, /id="editor-font"[^>]*aria-label="Schriftart"[^>]*hidden/);
  assert.match(configurePage, /id="editor-font-toggle"[^>]*aria-haspopup="listbox"/);
  assert.match(configurePage, /id="editor-font-menu"[^>]*role="listbox"/);
  assert.match(configurePage, /\.editor-font-toggle \{[\s\S]*?font-size: 11px;/);
  assert.match(configurePage, /fontSelect: document\.getElementById\('editor-font'\)/);
  assert.match(configurePage, /fontButton: document\.getElementById\('editor-font-toggle'\)/);
  assert.match(configurePage, /DesignFonts\.cssFamily\(item\.fontFamily\)/);
  assert.match(configurePage, /id="editor-bring-front"[^>]*aria-label="Ganz nach vorn"/);
  assert.match(configurePage, /id="editor-duplicate"[^>]*title="Duplizieren \(⌘\/Strg \+ C und V\)"/);
  assert.match(configurePage, /id="editor-select-all"[^>]*title="Alles auswählen \(⌘\/Strg \+ A\)"/);
  assert.doesNotMatch(configurePage, /Gestaltet eure persönliche Erinnerung/);
  assert.doesNotMatch(configurePage, /getElementById\('placement-step'\)\.hidden = true/);
  assert.match(configurePage, /return `wolkenworte-order:\$\{slug\}`/);
  assert.doesNotMatch(configurePage, /wrong_configuration_type/);
  assert.match(configurePage, /<strong id="placement-summary-name">Design anordnen<\/strong>/);
  assert.match(configurePage, /Wählt eine Anordnung für euer aktuelles Design\./);
  assert.match(configurePage, /DesignLayout\.applyLayoutAction\(currentDesign, slots/);
  assert.match(configurePage, /button\.className = 'option placement-action'/);
  assert.match(configurePage, /button\.addEventListener\('click', \(\) => activatePlacement\(layout\)\)/);
  assert.doesNotMatch(configurePage, /selectedPlacement/);
  assert.doesNotMatch(configurePage, /name = 'placement'/);
  assert.doesNotMatch(configurePage, /Fläche füllen/);
  assert.doesNotMatch(configurePage, /input\.addEventListener\('change',[\s\S]{0,400}mugEditor\.setDesign\(buildAutomaticDesign\(\)/);
  assert.match(configurePage, /function refreshFlatProductPreviewFit\(\)/);
  assert.match(configurePage, /function updateProductMockup\(\)/);
  assert.match(configurePage, /view\.previewMockup\.canvas\.fit === 'cover'/);
  assert.match(configurePage, /--product-mockup-canvas-clip/);
  assert.match(configurePage, /function refreshWorkspaceLayout\(\)/);
  assert.match(configurePage, /Math\.max\([\s\S]*?availableWidth \/ printAspect,[\s\S]*?availableWidth \/ previewAspect[\s\S]*?\) \+ 24/);
  assert.match(configurePage, /requestAnimationFrame\(refreshWorkspaceLayout\)/);
  assert.doesNotMatch(configurePage, /const flatPreviewHeight =/);
  assert.match(configurePage, /\.editor-scroll \{[\s\S]*?padding: 12px;[\s\S]*?border: 0;[\s\S]*?background: transparent;/);
  assert.match(configurePage, /\.editor-canvas-shell \{[\s\S]*?border: 1px solid rgba\(64, 15, 38, \.08\);[\s\S]*?box-shadow: none;/);
  assert.match(configurePage, /\.order-item \+ \.order-item::before \{[\s\S]*?rgba\(123, 70, 82, \.12\)/);
  assert.match(configurePage, /edit\.textContent = isEditing \? 'Geöffnet' : 'Öffnen'/);
  assert.match(configurePage, /edit\.disabled = isEditing/);
  assert.match(configurePage, /edit\.setAttribute\('aria-current', 'true'\)/);
  assert.doesNotMatch(configurePage, /save-button/);
  assert.doesNotMatch(configurePage, /design-save-button/);
  assert.match(configurePage, /class="secondary-button" id="design-another" type="button">/);
  assert.match(configurePage, /class="primary-button continue-button" id="continue-order" type="button">/);
  assert.match(configurePage, /async function saveCurrentDesign\(activeButton, \{ allowEmptyDraft = false \} = \{\}\)/);
  assert.match(configurePage, /if \(!currentDesignNeedsSave\) return true/);
  assert.match(configurePage, /if \(!await saveCurrentDesign\(null, \{ allowEmptyDraft: true \}\)\) return/);
  assert.match(configurePage, /await loadOrderItem\(openingCurrentItem \? editingOrderItemId : configurationId\)/);
  assert.match(configurePage, /async function saveBeforeLeaving\(event\)/);
  assert.match(configurePage, /\[brandLink, backLink\]\.forEach\(\(link\) => link\.addEventListener\('click', saveBeforeLeaving\)\)/);
  assert.match(configurePage, /location\.assign\(event\.currentTarget\.href\)/);
  assert.match(configurePage, /allowEmptyDraft && !editingOrderItemId && isCompletelyEmpty/);
  assert.match(configurePage, /href="\/datenschutz" target="_blank" rel="noopener"/);
  assert.match(configurePage, /href="\/impressum" target="_blank" rel="noopener"/);
  assert.match(configurePage, /if \(!await saveCurrentDesign\(designAnotherButton\)\) return/);
  assert.match(configurePage, /if \(await saveCurrentDesign\(continueOrderButton\)\) navigateToShipping\(\)/);
  assert.match(configurePage, /const missingSurface = productSurfaces\(\)\.find/);

  const fabricBrowserBuild = await fetch(`${baseUrl}/vendor/fabric.min.js?v=7.4.0`);
  assert.equal(fabricBrowserBuild.status, 200);
  assert.match(fabricBrowserBuild.headers.get('cache-control') || '', /immutable/);
  assert.ok((await fabricBrowserBuild.text()).length > 250000, 'the local Fabric.js build should be served in full');

  const mugEditor = await fetch(`${baseUrl}/js/mug-editor.js?v=20260826-9`);
  assert.equal(mugEditor.status, 200);
  const mugEditorSource = await mugEditor.text();
  assert.match(mugEditorSource, /resizePrintArea/);
  assert.match(mugEditorSource, /refreshViewport/);
  assert.match(mugEditorSource, /bringActiveToFront\(\)/);
  assert.match(mugEditorSource, /bringObjectToFront\(object\)/);
  assert.match(mugEditorSource, /copyActive\(\)/);
  assert.match(mugEditorSource, /pasteClipboard\(\)/);
  assert.match(mugEditorSource, /command && event\.key\.toLowerCase\(\) === 'c'/);
  assert.match(mugEditorSource, /command && event\.key\.toLowerCase\(\) === 'v'/);
  assert.match(mugEditorSource, /selection: true/);
  assert.match(mugEditorSource, /selectionKey: \['shiftKey', 'ctrlKey', 'metaKey'\]/);
  assert.match(mugEditorSource, /new root\.fabric\.ActiveSelection\(selectable/);
  assert.match(mugEditorSource, /command && event\.key\.toLowerCase\(\) === 'a'/);
  assert.match(mugEditorSource, /root\.fabric\.util\.qrDecompose\(object\.calcTransformMatrix\(\)\)/);
  assert.match(mugEditorSource, /setActiveFont\(fontKey\)/);
  assert.match(mugEditorSource, /name\.style\.fontFamily = font\.cssFamily/);
  assert.match(mugEditorSource, /syncFontPicker\(fontKey, placeholder, disabled\)/);
  assert.match(mugEditorSource, /fontFamily: root\.DesignFonts\.normalizeKey\(object\.editorFontKey\)/);
  assert.doesNotMatch(mugEditorSource, /Mindestens ein Element muss bleiben/);
  assert.match(await fetch(`${baseUrl}/assets/product-thumbnails/pillow.svg`).then((response) => response.text()), /Dekokissen/);
  for (const [asset, contentType] of [
    ['/assets/product-mockups/tote-front.jpg', 'image/jpeg'],
    ['/assets/product-mockups/coaster-flat.png', 'image/png'],
    ['/assets/product-mockups/matte-poster-30x40.png', 'image/png'],
    ['/assets/product-mockups/matte-poster-50x70.png', 'image/png'],
    ['/assets/product-mockups/framed-poster-black-30x40.png', 'image/png'],
    ['/assets/product-mockups/framed-poster-black-50x70.png', 'image/png'],
    ['/assets/product-mockups/throw-blanket-flat-horizontal.png', 'image/png'],
    ['/assets/product-mockups/spiral-notebook-front.png', 'image/png'],
    ['/assets/product-mockups/spiral-notebook-back.png', 'image/png'],
    ['/assets/product-mockups/basic-pillow-flat.png', 'image/png'],
  ]) {
    const response = await fetch(baseUrl + asset);
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('content-type'), contentType);
    assert.ok((await response.arrayBuffer()).byteLength > 2000);
  }

  const motifLibrary = await fetch(`${baseUrl}/js/mug-icons.js?v=20260826-1`);
  assert.equal(motifLibrary.status, 200);
  assert.equal(MugIcons.VIEWBOX_SIZE, 48);
  assert.equal(MugIcons.STROKE_WIDTH, 1.5);
  assert.equal(MugIcons.ICONS.length, 10);
  assert.ok(MugIcons.ICONS.every((icon) => icon.id && icon.label && icon.path));
});

test('a guest can create an isolated personal photo design without event words', async (t) => {
  const { baseUrl, close } = await startTestServer();
  t.after(close);
  const event = await createEvent(baseUrl, { coupleName: 'Persönliche Paula & Mika' });

  const sharedConfigurator = await fetch(`${baseUrl}/api/events/${event.slug}/configurator`);
  assert.equal(sharedConfigurator.status, 409, 'the empty shared cloud stays unavailable');

  const personalConfigurator = await fetch(
    `${baseUrl}/api/events/${event.slug}/configurator?mode=personal`
  );
  assert.equal(personalConfigurator.status, 200);
  const personalData = await personalConfigurator.json();
  assert.equal(personalData.configurationType, 'personal_memory');
  assert.deepEqual(personalData.words, []);

  const missingDesign = await fetch(`${baseUrl}/api/events/${event.slug}/configurations`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      configurationType: 'personal_memory',
      productKey: 'white-glossy-mug-duo-11oz',
      quantity: 1,
      theme: 'pastel',
      words: [['must-not-leak', 1]],
    }),
  });
  assert.equal(missingDesign.status, 400);
  assert.equal((await missingDesign.json()).error, 'invalid_design');

  const onePixelPng =
    'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJ' +
    'AAAADUlEQVR42mNk+M/wHwAF/gL+4N1xAAAAAElFTkSuQmCC';
  const design = [{
    id: 'foto-1',
    type: 'image',
    src: onePixelPng,
    x: 1350,
    y: 525,
    width: 800,
    height: 600,
    angle: -4,
  }];
  const save = await fetch(`${baseUrl}/api/events/${event.slug}/configurations`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      configurationType: 'personal_memory',
      productKey: 'white-glossy-mug-duo-11oz',
      quantity: 1,
      theme: 'pastel',
      words: [['must-not-leak', 1]],
      ...oneSurfaceDesign(design),
    }),
  });
  assert.equal(save.status, 201);
  const configuration = await save.json();
  assert.equal(configuration.configurationType, 'personal_memory');

  const savedInfo = await fetch(
    `${baseUrl}/api/events/${event.slug}/configurations/${configuration.id}`
  ).then((response) => response.json());
  assert.equal(savedInfo.configurationType, 'personal_memory');

  const printSvg = await fetch(baseUrl + configuration.printFileUrl).then((response) => response.text());
  assert.match(printSvg, /data-photo="true"/);
  assert.match(printSvg, /href="data:image\/png;base64,/);
  assert.match(printSvg, /width="800\.0" height="600\.0"/);
  assert.doesNotMatch(printSvg, /must-not-leak/);
  assert.doesNotMatch(printSvg, /<text /);

  const posterSave = await fetch(`${baseUrl}/api/events/${event.slug}/configurations`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      configurationType: 'personal_memory',
      productKey: 'matte-poster-30x40cm',
      quantity: 1,
      theme: 'sage-gold',
      ...oneSurfaceDesign([{
        id: 'wort-poster',
        type: 'text',
        text: 'Paula Mika',
        x: 1772,
        y: 2362,
        fontSize: 220,
        angle: 0,
        color: '#063e36',
      }]),
    }),
  });
  assert.equal(posterSave.status, 201, 'personal mode accepts the shared flat-product catalog');
  const posterConfiguration = await posterSave.json();
  const posterSvg = await fetch(baseUrl + posterConfiguration.printFileUrl).then((response) => response.text());
  assert.match(posterSvg, /width="3544" height="4724"/);
  assert.match(posterSvg, />Paula Mika<\/text>/);

  const pillowSave = await fetch(`${baseUrl}/api/events/${event.slug}/configurations`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      configurationType: 'personal_memory',
      productKey: 'all-over-basic-pillow-18in',
      quantity: 1,
      theme: 'pastel',
      designs: {
        front: [{
          id: 'wort-vorne', type: 'text', text: 'Vorne', x: 1425, y: 1425,
          fontSize: 240, angle: 0, color: '#a40e4c',
        }],
        back: [{
          id: 'wort-hinten', type: 'text', text: 'Hinten', x: 1425, y: 1425,
          fontSize: 240, angle: 0, color: '#168f83',
        }],
      },
    }),
  });
  assert.equal(pillowSave.status, 201);
  const pillowConfiguration = await pillowSave.json();
  assert.equal(pillowConfiguration.printFileUrl, pillowConfiguration.printFileUrls.front);
  assert.match(pillowConfiguration.printFileUrls.front, /print\.svg\?surface=front$/);
  assert.match(pillowConfiguration.printFileUrls.back, /print\.svg\?surface=back$/);
  const [pillowFrontSvg, pillowBackSvg] = await Promise.all([
    fetch(baseUrl + pillowConfiguration.printFileUrls.front).then((response) => response.text()),
    fetch(baseUrl + pillowConfiguration.printFileUrls.back).then((response) => response.text()),
  ]);
  assert.match(pillowFrontSvg, />Vorne<\/text>/);
  assert.doesNotMatch(pillowFrontSvg, />Hinten<\/text>/);
  assert.match(pillowBackSvg, />Hinten<\/text>/);
  assert.doesNotMatch(pillowBackSvg, />Vorne<\/text>/);

  const missingPillowBack = await fetch(`${baseUrl}/api/events/${event.slug}/configurations`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      configurationType: 'personal_memory',
      productKey: 'all-over-basic-pillow-18in',
      quantity: 1,
      theme: 'pastel',
      designs: { front: [{
        id: 'nur-vorne', type: 'text', text: 'Nur vorne', x: 1425, y: 1425,
        fontSize: 180, angle: 0, color: '#a40e4c',
      }] },
    }),
  });
  assert.equal(missingPillowBack.status, 400);
  assert.equal((await missingPillowBack.json()).error, 'invalid_design');

  const tooManySurfacePhotos = await fetch(`${baseUrl}/api/events/${event.slug}/configurations`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      configurationType: 'personal_memory',
      productKey: 'all-over-basic-pillow-18in',
      quantity: 1,
      theme: 'pastel',
      designs: {
        front: Array.from({ length: 4 }, (_, index) => ({
          id: `foto-vorne-${index}`, type: 'image', src: onePixelPng,
          x: 1425, y: 1425, width: 100, height: 100, angle: 0,
        })),
        back: Array.from({ length: 3 }, (_, index) => ({
          id: `foto-hinten-${index}`, type: 'image', src: onePixelPng,
          x: 1425, y: 1425, width: 100, height: 100, angle: 0,
        })),
      },
    }),
  });
  assert.equal(tooManySurfacePhotos.status, 400);
  assert.equal((await tooManySurfacePhotos.json()).error, 'invalid_design');

  const unsafeImage = await fetch(`${baseUrl}/api/events/${event.slug}/configurations`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      configurationType: 'personal_memory',
      quantity: 1,
      theme: 'pastel',
      ...oneSurfaceDesign([{ ...design[0], src: 'data:image/svg+xml;base64,PHN2Zy8+' }]),
    }),
  });
  assert.equal(unsafeImage.status, 400);
  assert.equal((await unsafeImage.json()).error, 'invalid_design');
});

test('confirmed configuration freezes the approved words in a permanent Printful-sized SVG', async (t) => {
  const { baseUrl, close } = await startTestServer();
  t.after(close);
  const event = await createEvent(baseUrl, { coupleName: 'Freeze Frieda & Emil' });
  const socket = await connectSocket(baseUrl, event.slug);
  t.after(() => socket.close());

  await submitWord(socket, 'Liebe');
  await submitWord(socket, 'Liebe');
  await submitWord(socket, 'Glück');

  const snapshot = [['liebe', 2], ['glück', 1]];
  const design = [
    { id: 'liebe', text: 'liebe', x: 900, y: 500, fontSize: 120, angle: 0, color: '#a40e4c' },
    { id: 'glueck', text: 'glück', x: 1750, y: 560, fontSize: 90, angle: 0, color: '#d90368' },
  ];
  const save = await fetch(`${baseUrl}/api/events/${event.slug}/configurations`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      productKey: 'white-glossy-mug-duo-11oz',
      quantity: 7,
      theme: 'pastel',
      words: snapshot,
      ...oneSurfaceDesign(design),
    }),
  });
  assert.equal(save.status, 201);
  const configuration = await save.json();
  assert.match(configuration.id, /^[A-Za-z0-9_-]{16}$/);
  assert.equal(configuration.quantity, 7);
  assert.equal(configuration.unitPriceCents, undefined);
  assert.equal(configuration.totalPriceCents, undefined);

  // The live event keeps changing after approval.
  await submitWord(socket, 'Später');

  const printRes = await fetch(baseUrl + configuration.printFileUrl);
  assert.equal(printRes.status, 200);
  assert.match(printRes.headers.get('content-type') || '', /image\/svg\+xml/);
  assert.match(printRes.headers.get('cache-control') || '', /immutable/);
  const svg = await printRes.text();
  assert.match(svg, /width="2700" height="1050"/);
  assert.match(svg, /data-background="transparent"/);
  assert.doesNotMatch(svg, /<rect\b/, 'the Printful file must not print a background');
  assert.ok(svg.includes('>liebe</text>'));
  assert.ok(svg.includes('>glück</text>'));
  assert.ok(!svg.includes('später'), 'words submitted after approval must never enter the saved print file');
  assert.equal((svg.match(/<text /g) || []).length, snapshot.length);
});

test('configurations require the exact canvas and store no placement state', async (t) => {
  const { baseUrl, close } = await startTestServer();
  t.after(close);
  const event = await createEvent(baseUrl, { coupleName: 'Canvas Carla' });

  const missingDesign = await fetch(`${baseUrl}/api/events/${event.slug}/configurations`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ theme: 'pastel', words: [['liebe', 1]] }),
  });
  assert.equal(missingDesign.status, 400);
  assert.equal((await missingDesign.json()).error, 'invalid_design');

  const invalidQuantity = await fetch(`${baseUrl}/api/events/${event.slug}/configurations`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      quantity: 100,
      theme: 'pastel',
      words: [['liebe', 1]],
      ...productDesignPayload(),
    }),
  });
  assert.equal(invalidQuantity.status, 400);
  assert.equal((await invalidQuantity.json()).error, 'invalid_quantity');

  const save = await fetch(`${baseUrl}/api/events/${event.slug}/configurations`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      quantity: 1,
      theme: 'sage-gold',
      words: [['liebe', 1]],
      ...productDesignPayload(),
    }),
  });
  assert.equal(save.status, 201);
  const configuration = await save.json();
  assert.equal(Object.hasOwn(configuration, 'placement'), false);

  const db = require('../src/db');
  const columns = db.db.prepare('PRAGMA table_info(configurations)').all().map((column) => column.name);
  assert.equal(columns.includes('placement'), false);
  const svg = await fetch(baseUrl + configuration.printFileUrl).then((res) => res.text());
  assert.doesNotMatch(svg, /data-cloud=/);
});

test('custom editor design is frozen exactly and cannot leave the printable area', async (t) => {
  const { baseUrl, close } = await startTestServer();
  t.after(close);
  const event = await createEvent(baseUrl, { coupleName: 'Editor Ella & Finn' });
  const words = [['ursprünglich', 2], ['liebe', 1]];
  const design = [
    { id: 'wort-1', text: 'Unser Wort', x: 1280, y: 460, fontSize: 118, angle: 15, color: '#123456', fontFamily: 'lora' },
    { id: 'wort-2', text: 'für immer', x: 1550, y: 655, fontSize: 82, angle: -30, color: '#abcdef', fontFamily: 'caveat' },
    { id: 'motiv-1', type: 'icon', icon: 'heart', x: 1880, y: 390, size: 170, angle: -12, color: '#d90368' },
  ];

  const save = await fetch(`${baseUrl}/api/events/${event.slug}/configurations`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      productKey: 'white-glossy-mug-duo-11oz',
      quantity: 2,
      theme: 'custom',
      words,
      ...oneSurfaceDesign(design),
    }),
  });
  assert.equal(save.status, 201);
  const configuration = await save.json();
  const svg = await fetch(baseUrl + configuration.printFileUrl).then((res) => res.text());
  assert.match(svg, /x="1280\.0"/);
  assert.match(svg, /font-size="118\.0"/);
  assert.match(svg, /transform="rotate\(15\.0 1280\.0 460\.0\)"/);
  assert.match(svg, /fill="#123456"/);
  assert.match(svg, /data-font="lora"/);
  assert.match(svg, /data-font="caveat"/);
  assert.match(svg, /font-family="'Wolkenworte Lora', Georgia, serif"/);
  assert.match(svg, /font-family="'Wolkenworte Caveat', cursive"/);
  assert.match(svg, /@font-face\{font-family:'Wolkenworte Lora';src:url\(data:font\/ttf;base64,/);
  assert.match(svg, /@font-face\{font-family:'Wolkenworte Caveat';src:url\(data:font\/ttf;base64,/);
  assert.match(svg, />Unser Wort<\/text>/);
  assert.match(svg, />für immer<\/text>/);
  assert.match(svg, /data-motif="heart"/);
  assert.ok(svg.includes(`d="${MugIcons.get('heart').path}"`));
  assert.match(svg, /stroke="#d90368"/);
  assert.match(svg, /stroke-width="1\.5"/);
  assert.match(svg, /translate\(1880\.0 390\.0\) rotate\(-12\.0\)/);
  assert.doesNotMatch(svg, />ursprünglich<\/text>/, 'the edited design, not the original cloud, is printed');
  assert.equal((svg.match(/<text /g) || []).length, 2);
  assert.equal((svg.match(/<path data-motif=/g) || []).length, 1);
  assert.doesNotMatch(svg, /<rect\b/);

  const editable = await fetch(`${baseUrl}/api/events/${event.slug}/configurations/${configuration.id}/edit`);
  assert.equal(editable.status, 200);
  assert.match(editable.headers.get('cache-control'), /no-store/);
  const editableBody = await editable.json();
  assert.equal(editableBody.productKey, 'white-glossy-mug-duo-11oz');
  assert.equal(editableBody.theme, 'custom');
  assert.equal(Object.hasOwn(editableBody, 'placementKey'), false);
  assert.deepEqual(editableBody.words, words);
  assert.deepEqual(editableBody.designs.default.map((item) => ({
    id: item.id,
    type: item.type || 'text',
    text: item.text,
    icon: item.icon,
    color: item.color,
    fontFamily: item.fontFamily,
  })), [
    { id: 'wort-1', type: 'text', text: 'Unser Wort', icon: undefined, color: '#123456', fontFamily: 'lora' },
    { id: 'wort-2', type: 'text', text: 'für immer', icon: undefined, color: '#abcdef', fontFamily: 'caveat' },
    { id: 'motiv-1', type: 'icon', text: undefined, icon: 'heart', color: '#d90368', fontFamily: undefined },
  ]);

  const unknownFont = await fetch(`${baseUrl}/api/events/${event.slug}/configurations`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      quantity: 2,
      theme: 'pastel',
      words,
      ...oneSurfaceDesign([{
        id: 'wort-fremde-schrift', text: 'bleibt sicher', x: 1300, y: 500,
        fontSize: 100, angle: 0, color: '#123456', fontFamily: 'untrusted-font',
      }]),
    }),
  });
  assert.equal(unknownFont.status, 400);
  assert.equal((await unknownFont.json()).error, 'invalid_design');

  const outside = await fetch(`${baseUrl}/api/events/${event.slug}/configurations`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      quantity: 2,
      theme: 'pastel',
      words,
      ...oneSurfaceDesign([{
        id: 'outside', text: 'zu weit', x: 10, y: 500,
        fontSize: 100, angle: 0, color: '#123456',
      }]),
    }),
  });
  assert.equal(outside.status, 400);
  assert.equal((await outside.json()).error, 'invalid_design');

  const outsideMotif = await fetch(`${baseUrl}/api/events/${event.slug}/configurations`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      quantity: 2,
      theme: 'pastel',
      words,
      ...oneSurfaceDesign([
        { id: 'wort-1', text: 'bleibt', x: 1200, y: 500, fontSize: 100, angle: 0, color: '#123456' },
        { id: 'motiv-rand', type: 'icon', icon: 'heart', x: 30, y: 500, size: 160, angle: 0, color: '#d90368' },
      ]),
    }),
  });
  assert.equal(outsideMotif.status, 400);
  assert.equal((await outsideMotif.json()).error, 'invalid_design');

  const unknownMotif = await fetch(`${baseUrl}/api/events/${event.slug}/configurations`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      quantity: 2,
      theme: 'pastel',
      words,
      ...oneSurfaceDesign([
        { id: 'wort-1', text: 'bleibt', x: 1200, y: 500, fontSize: 100, angle: 0, color: '#123456' },
        { id: 'motiv-fremd', type: 'icon', icon: 'uploaded-script', x: 1500, y: 500, size: 160, angle: 0, color: '#123456' },
      ]),
    }),
  });
  assert.equal(unknownMotif.status, 400);
  assert.equal((await unknownMotif.json()).error, 'invalid_design');
});
