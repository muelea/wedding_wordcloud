'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { productDesignPayload } = require('./helpers');
const { getProduct, resolveProductOrientation } = require('../src/products');
const {
  PrintfulMockupError,
  MAX_SOURCE_DIMENSION_PX,
  SOURCE_PREFIX,
  createService,
  isOperatorCreateRequest,
  isOperatorEnabled,
  isOperatorRequest,
} = require('../src/printfulMockups');

function configurationFor(productKey, orientation = 'default', word = 'Liebe') {
  const product = resolveProductOrientation(getProduct(productKey), orientation);
  const surfaces = productDesignPayload(productKey, orientation).designs;
  for (const design of Object.values(surfaces)) design[0].text = word;
  return {
    id: `configuration-${word}`,
    product_key: product.key,
    printful_variant_id: product.printful.variantId,
    orientation: product.orientation,
    print_width: product.printFile.width,
    print_height: product.printFile.height,
    design_json: JSON.stringify({ version: 2, surfaces }),
  };
}

function mockupStyleRows(product) {
  return product.printful.placements.map((placement, index) => ({
    placement,
    technique: product.printful.technique,
    print_area_type: 'simple',
    mockup_styles: [{
      id: 700 + index,
      category_name: 'Default',
      restricted_to_variants: [product.printful.variantId],
    }],
  }));
}

test('operator mockup access needs the explicit local flag, loopback socket and localhost host', () => {
  const enabled = {
    NODE_ENV: 'development',
    APP_ENVIRONMENT: 'local',
    PRINTFUL_MOCKUP_TOOLS_ENABLED: 'true',
  };
  const request = {
    socket: { remoteAddress: '127.0.0.1' },
    headers: { host: 'localhost:3000', 'x-wolkenworte-operator': 'printful-mockup' },
  };
  assert.equal(isOperatorEnabled(enabled), true);
  assert.equal(isOperatorRequest(request, enabled), true);
  assert.equal(isOperatorCreateRequest(request, enabled), true);
  assert.equal(isOperatorRequest({ ...request, socket: { remoteAddress: '192.0.2.10' } }, enabled), false);
  assert.equal(isOperatorRequest({ ...request, headers: { host: 'preview.example' } }, enabled), false);
  assert.equal(isOperatorCreateRequest({ ...request, headers: { host: 'localhost:3000' } }, enabled), false);
  assert.equal(isOperatorEnabled({ ...enabled, NODE_ENV: 'production' }), false);
  assert.equal(isOperatorEnabled({ ...enabled, PRINTFUL_MOCKUP_TOOLS_ENABLED: 'false' }), false);
});

test('mockup service sends exact saved surfaces, polls Printful, cleans sources and proxies downloads', async (t) => {
  const product = resolveProductOrientation(getProduct('all-over-basic-pillow-18in'), 'default');
  const configuration = configurationFor(product.key);
  const uploads = [];
  const removed = [];
  const requests = [];
  let statusCalls = 0;
  const storageClient = {
    async upload(objectKey, bytes, contentType) {
      uploads.push({ objectKey, bytes: Buffer.from(bytes), contentType });
    },
    async createSignedUrl(objectKey, ttl) {
      return `https://storage.example.test/${encodeURIComponent(objectKey)}?ttl=${ttl}`;
    },
    async remove(objectKey) { removed.push(objectKey); },
  };
  const completedTask = {
    id: 123,
    status: 'completed',
    catalog_variant_mockups: [{
      catalog_variant_id: product.printful.variantId,
      mockups: product.printful.placements.map((placement, index) => ({
        placement,
        display_name: `${placement} view`,
        technique: product.printful.technique,
        style_id: 700 + index,
        mockup_url: `https://printful-upload.s3-accelerate.amazonaws.com/tmp/${placement}.png`,
      })),
    }],
    failure_reasons: [],
  };
  const printfulClient = {
    async getCatalogProductMockupStyles(productId, placements) {
      assert.equal(productId, product.printful.productId);
      assert.deepEqual(placements, product.printful.placements);
      return mockupStyleRows(product);
    },
    async createMockupTasks(payload) {
      requests.push(payload);
      return [{ id: 123, status: 'pending' }];
    },
    async getMockupTasks(ids) {
      assert.deepEqual(ids, [123]);
      statusCalls += 1;
      return statusCalls === 1
        ? [{ id: 123, status: 'pending', catalog_variant_mockups: [], failure_reasons: [] }]
        : [completedTask];
    },
  };
  const imageBytes = Buffer.from([0x89, 0x50, 0x4e, 0x47]);
  const service = createService({
    storageClient,
    printfulClient,
    fetchImpl: async (url) => {
      assert.equal(url.hostname, 'printful-upload.s3-accelerate.amazonaws.com');
      return {
        ok: true,
        headers: { get: (name) => name.toLowerCase() === 'content-type' ? 'image/png' : null },
        arrayBuffer: async () => imageBytes,
      };
    },
  });
  t.after(() => service.stop());

  const created = await service.createForConfiguration(configuration);
  assert.equal(created.status, 'pending');
  assert.equal(created.mockupWidthPx, 2000);
  assert.equal(created.resolutionFallback, false);
  assert.equal(uploads.length, 2);
  assert.ok(uploads.every((upload) => upload.objectKey.startsWith(`${SOURCE_PREFIX}/`)));
  assert.ok(uploads.every((upload) => upload.objectKey.endsWith('.png')));
  assert.ok(uploads.every((upload) => upload.contentType === 'image/png'));
  assert.ok(uploads.every((upload) => upload.bytes.subarray(0, 8)
    .equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))));
  const sourceImage = await require('canvas').loadImage(uploads[0].bytes);
  assert.ok(sourceImage.width <= MAX_SOURCE_DIMENSION_PX);
  assert.ok(sourceImage.height <= MAX_SOURCE_DIMENSION_PX);
  assert.equal(sourceImage.width / sourceImage.height, product.printFile.width / product.printFile.height);

  assert.equal(requests.length, 1);
  const payload = requests[0];
  assert.equal(payload.format, 'png');
  assert.equal(payload.mockup_width_px, 2000);
  assert.deepEqual(payload.products[0].catalog_variant_ids, [product.printful.variantId]);
  assert.deepEqual(payload.products[0].mockup_style_ids, [700, 701]);
  assert.deepEqual(payload.products[0].product_options, [{ name: 'stitch_color', value: 'white' }]);
  assert.deepEqual(payload.products[0].placements.map((placement) => placement.placement), ['front', 'back']);
  assert.ok(payload.products[0].placements.every((placement) =>
    placement.layers[0].url.startsWith('https://storage.example.test/')));

  assert.equal((await service.getJob(created.jobId)).status, 'pending');
  const completed = await service.getJob(created.jobId);
  assert.equal(completed.status, 'completed');
  assert.equal(completed.mockups.length, 2);
  assert.deepEqual([...removed].sort(), uploads.map((upload) => upload.objectKey).sort());

  const cached = await service.createForConfiguration(configuration);
  assert.deepEqual(cached, {
    jobId: created.jobId,
    status: 'completed',
    mockupWidthPx: 2000,
    resolutionFallback: false,
    cached: true,
  });
  assert.equal(requests.length, 1);

  const downloaded = await service.download(created.jobId, 0);
  assert.deepEqual(downloaded.bytes, imageBytes);
  assert.equal(downloaded.contentType, 'image/png');
  assert.match(downloaded.filename, /^wolkenworte-all-over-basic-pillow-18in-front-700\.png$/);
});

test('mockup service falls back to 1000px when Printful rejects 2000px quota cost', async (t) => {
  const product = resolveProductOrientation(getProduct('white-glossy-mug-duo-11oz'), 'default');
  const widths = [];
  const service = createService({
    storageClient: {
      async upload() {},
      async createSignedUrl(objectKey) {
        return `https://storage.example.test/${encodeURIComponent(objectKey)}`;
      },
      async remove() {},
    },
    printfulClient: {
      async getCatalogProductMockupStyles() { return mockupStyleRows(product); },
      async createMockupTasks(payload) {
        widths.push(payload.mockup_width_px);
        if (payload.mockup_width_px === 2000) {
          throw Object.assign(new Error(
            'Request would exceed available attempts Please try again after 0 seconds.'
          ), { providerStatus: 429, retryAfter: 0, rateLimitRemaining: 2, rateLimitReset: 60 });
        }
        return [{ id: 321, status: 'pending' }];
      },
      async getMockupTasks() { return []; },
    },
  });
  t.after(() => service.stop());

  const created = await service.createForConfiguration(configurationFor(product.key));
  assert.deepEqual(widths, [2000, 1000]);
  assert.equal(created.status, 'pending');
  assert.equal(created.mockupWidthPx, 1000);
  assert.equal(created.resolutionFallback, true);
});

test('mockup service applies the conservative two-create-per-minute limit', async (t) => {
  const product = resolveProductOrientation(getProduct('cork-back-coaster'), 'default');
  let createdTasks = 0;
  const storageClient = {
    async upload() {},
    async createSignedUrl(objectKey) { return `https://storage.example.test/${encodeURIComponent(objectKey)}`; },
    async remove() {},
  };
  const printfulClient = {
    async getCatalogProductMockupStyles() { return mockupStyleRows(product); },
    async createMockupTasks() {
      createdTasks += 1;
      return [{ id: 500 + createdTasks, status: 'pending' }];
    },
    async getMockupTasks() { return []; },
  };
  const service = createService({ storageClient, printfulClient, now: () => 1_000_000 });
  t.after(() => service.stop());
  await service.createForConfiguration(configurationFor(product.key, 'default', 'Liebe'));
  await service.createForConfiguration(configurationFor(product.key, 'default', 'Glück'));
  await assert.rejects(
    service.createForConfiguration(configurationFor(product.key, 'default', 'Freude')),
    (error) => error instanceof PrintfulMockupError && error.status === 429 && error.retryAfter === 60
  );
  assert.equal(createdTasks, 2);
});

test('provider throttling is actionable and removes the temporary source immediately', async (t) => {
  const product = resolveProductOrientation(getProduct('cork-back-coaster'), 'default');
  const uploaded = [];
  const removed = [];
  const service = createService({
    storageClient: {
      async upload(objectKey) { uploaded.push(objectKey); },
      async createSignedUrl(objectKey) {
        return `https://storage.example.test/${encodeURIComponent(objectKey)}`;
      },
      async remove(objectKey) { removed.push(objectKey); },
    },
    printfulClient: {
      async getCatalogProductMockupStyles() { return mockupStyleRows(product); },
      async createMockupTasks() {
        throw Object.assign(new Error('provider limit'), { providerStatus: 429, retryAfter: 12 });
      },
    },
  });
  t.after(() => service.stop());
  await assert.rejects(
    service.createForConfiguration(configurationFor(product.key)),
    (error) => error instanceof PrintfulMockupError &&
      error.code === 'mockup_rate_limited' && error.status === 429 && error.retryAfter === 12
  );
  assert.equal(uploaded.length, 1);
  assert.deepEqual(removed, uploaded);
});

test('startup flag and configurator wiring keep the tool explicit and cart-scoped', () => {
  const root = path.join(__dirname, '..');
  const runLocal = fs.readFileSync(path.join(root, 'run_local.sh'), 'utf8');
  const configure = fs.readFileSync(path.join(root, 'views', 'configure.ejs'), 'utf8');
  const server = fs.readFileSync(path.join(root, 'server.js'), 'utf8');
  assert.match(runLocal, /--printful-mockups/);
  assert.match(runLocal, /PRINTFUL_MOCKUP_TOOLS_ENABLED="false"/);
  assert.match(
    runLocal,
    /PRINTFUL_MOCKUP_TOOLS_ENABLED="\$PRINTFUL_MOCKUP_TOOLS_ENABLED"[\s\\]*node scripts\/seed-local-cloud\.js/
  );
  assert.match(configure, /Boolean\(pageData\.printfulMockupTools\)/);
  assert.match(configure, /if \(PRINTFUL_MOCKUP_TOOLS_ENABLED\)[\s\S]*?order-mockup/);
  assert.match(configure, /X-Wolkenworte-Operator': 'printful-mockup'/);
  assert.match(server, /printfulMockupTools: printfulMockups\.isOperatorRequest\(req\)/);
});
