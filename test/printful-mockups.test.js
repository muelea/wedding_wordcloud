'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { createCanvas, loadImage } = require('canvas');
const { productDesignPayload } = require('./helpers');
const DesignFonts = require('../src/designFonts');
const WordCloudCore = require('../public/js/wordcloud-core');
const { getProduct, resolveProductOrientation } = require('../src/products');
const { renderProviderPng } = require('../src/printRaster');
const { harness } = require('./support/mockup-queue-harness');
const {
  PrintfulMockupError,
  SOURCE_PREFIX,
  compatibleStyle,
  isOperatorCreateRequest,
  isOperatorEnabled,
  isOperatorRequest,
} = require('../src/printfulMockups');

test('new phone variants prefer their explicit mockup styles over legacy generic styles', () => {
  const product = getProduct('tough-case-21474');
  const row = styles => ({ placement: 'default', technique: product.printful.technique,
    print_area_width: product.printFile.width / product.printFile.dpi,
    print_area_height: product.printFile.height / product.printFile.dpi,
    print_area_type: 'simple', mockup_styles: styles });
  const generic = { id: 8112, category_name: 'Flat 2', restricted_to_variants: null };
  const unrelated = { id: 111, category_name: 'Flat', restricted_to_variants: [21473] };
  const exact = { id: 25024, category_name: 'Flat 2', restricted_to_variants: [21473, 21474] };
  assert.equal(compatibleStyle([row([generic, unrelated]), row([exact])], product, 'default').id, 25024);
  assert.equal(compatibleStyle([row([generic, unrelated])], product, 'default').id, 8112,
    'catalogs with only a generic style retain their fallback');
  assert.throws(() => compatibleStyle([row([unrelated])], product, 'default'), /passenden Mockup-Stil/);
});

test('rotatable mockups select the style for the exact print-file orientation', () => {
  const product = getProduct('framed-matte-poster-black-30x40cm');
  const row = (id, width, height) => ({ placement: 'default', technique: product.printful.technique,
    print_area_width: width, print_area_height: height, print_area_type: 'simple',
    mockup_styles: [{ id, category_name: 'Flat', restricted_to_variants: [product.printful.variantId] }] });
  const rows = [row(24671, 16, 12), row(24662, 12, 16)];
  assert.equal(compatibleStyle(rows, resolveProductOrientation(product, 'portrait'), 'default').id, 24662);
  assert.equal(compatibleStyle(rows, resolveProductOrientation(product, 'landscape'), 'default').id, 24671);
});

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
    print_area_width: product.printFile.width / product.printFile.dpi,
    print_area_height: product.printFile.height / product.printFile.dpi,
    print_area_type: 'simple',
    mockup_styles: [{
      id: 700 + index,
      category_name: 'Default',
      restricted_to_variants: [product.printful.variantId],
    }],
  }));
}

function alphaBounds(canvas) {
  const pixels = canvas.getContext('2d').getImageData(0, 0, canvas.width, canvas.height).data;
  let left = canvas.width;
  let top = canvas.height;
  let right = -1;
  let bottom = -1;
  for (let y = 0; y < canvas.height; y += 1) {
    for (let x = 0; x < canvas.width; x += 1) {
      if (!pixels[(y * canvas.width + x) * 4 + 3]) continue;
      left = Math.min(left, x);
      top = Math.min(top, y);
      right = Math.max(right, x);
      bottom = Math.max(bottom, y);
    }
  }
  return { left, top, right, bottom };
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

test('mockup source keeps full Printful dimensions beyond the former 3000px preview cap', async (t) => {
  const product = resolveProductOrientation(getProduct('matte-poster-30x40cm'), 'portrait');
  const configuration = configurationFor(product.key, 'portrait');
  const uploads = [];
  const h = harness({ productKey: product.key, renderPng: renderProviderPng,
    storageClient: {
      async upload(objectKey, bytes, contentType) {
        uploads.push({ objectKey, bytes: Buffer.from(bytes), contentType });
      },
      async createSignedUrl(objectKey) {
        return `https://storage.example.test/${encodeURIComponent(objectKey)}`;
      },
      async remove() {},
    },
    printfulClient: {
      async getCatalogProductMockupStyles() { return mockupStyleRows(product); },
      async createMockupTasks() { return [{ id: 333, status: 'pending' }]; },
      async getMockupTasks() { return []; },
    },
  });
  const service = h.service;
  h.repository.configurations.set(configuration.id, configuration);
  t.after(() => service.stop());

  await service.createForConfiguration(configuration);
  await h.run();
  assert.equal(uploads.length, 1);
  const source = await loadImage(uploads[0].bytes);
  assert.equal(source.width, 3544);
  assert.equal(source.height, 4724);
  assert.deepEqual(
    uploads[0].bytes,
    await renderProviderPng(product, JSON.parse(configuration.design_json).surfaces.default)
  );
});

test('mockup PNG preserves Caveat bold geometry instead of substituting a system font', async (t) => {
  const product = resolveProductOrientation(getProduct('white-glossy-mug-duo-11oz'), 'default');
  const configuration = configurationFor(product.key, 'default', 'favourite people');
  const stored = JSON.parse(configuration.design_json);
  const item = stored.surfaces.default[0];
  Object.assign(item, {
    x: product.printFile.width / 2,
    y: product.printFile.height / 2,
    fontSize: 180,
    angle: 27,
    color: '#ed2446',
    fontFamily: 'caveat',
    fontWeight: 700,
    fontStyle: 'italic',
    underline: true,
    linethrough: true,
  });
  configuration.design_json = JSON.stringify(stored);
  const uploads = [];
  const h = harness({ productKey: product.key, renderPng: renderProviderPng,
    storageClient: {
      async upload(objectKey, bytes, contentType) {
        uploads.push({ objectKey, bytes: Buffer.from(bytes), contentType });
      },
      async createSignedUrl(objectKey) {
        return `https://storage.example.test/${encodeURIComponent(objectKey)}`;
      },
      async remove() {},
    },
    printfulClient: {
      async getCatalogProductMockupStyles() { return mockupStyleRows(product); },
      async createMockupTasks() { return [{ id: 222, status: 'pending' }]; },
      async getMockupTasks() { return []; },
    },
  });
  const service = h.service;
  h.repository.configurations.set(configuration.id, configuration);
  t.after(() => service.stop());
  await service.createForConfiguration(configuration);
  await h.run();
  assert.equal(uploads.length, 1);
  assert.equal(uploads[0].contentType, 'image/png');
  const source = await loadImage(uploads[0].bytes);
  const actual = createCanvas(source.width, source.height);
  actual.getContext('2d').drawImage(source, 0, 0);
  assert.equal(actual.getContext('2d').getImageData(0, 0, 1, 1).data[3], 0,
    'the provider source must retain a transparent background');

  const expected = createCanvas(product.printFile.width, product.printFile.height);
  const context = expected.getContext('2d');
  context.save();
  context.translate(item.x, item.y);
  context.rotate(item.angle * Math.PI / 180);
  WordCloudCore.drawRichText(context, item.text, 0, 0, item.fontSize, {
    ...item,
    fontFamily: DesignFonts.cssFamily(item.fontFamily),
  });
  context.restore();
  const actualBounds = alphaBounds(actual);
  const expectedBounds = alphaBounds(expected);
  for (const key of ['left', 'top', 'right', 'bottom']) {
    assert.ok(Math.abs(actualBounds[key] - expectedBounds[key]) <= 2,
      `${key}: ${actualBounds[key]} vs ${expectedBounds[key]}`);
  }
});


test('queued dispatch uses the exact saved surfaces, placement options and private production PNGs',async()=>{
  const h=harness({productKey:'white-glossy-mug-duo-11oz',renderPng:renderProviderPng});
  const configuration=h.configuration();const job=await h.service.createForConfiguration(configuration);await h.run(2);
  assert.equal((await h.service.getJob(job.jobId)).status,'completed');
  const payload=h.payloads[0];assert.equal(payload.format,'png');assert.equal(payload.mockup_width_px,2000);
  assert.equal(payload.products[0].catalog_product_id,h.product.printful.productId);
  assert.deepEqual(payload.products[0].catalog_variant_ids,[h.product.printful.variantId]);
  assert.deepEqual(payload.products[0].placements.map(item=>item.placement),h.product.printful.placements);
  const design=JSON.parse(configuration.design_json);
  for(const [index,upload]of h.uploaded.entries()){
    assert.match(upload.key,/^operator-mockup-sources\/\d+-[A-Za-z0-9_-]{24}\.png$/);
    assert.equal(upload.mime,'image/png');
    assert.deepEqual(upload.bytes,await renderProviderPng(h.product,design.surfaces[h.product.printSurfaces[index].key]));
  }
});

test('Printful v2 details and HTTP-date cooldowns survive parsing, and success headers reach the scheduler',async t=>{
  const printful=require('../src/printful');const previous=process.env.PRINTFUL_API_KEY;
  process.env.PRINTFUL_API_KEY='test_only';t.after(()=>{if(previous===undefined)delete process.env.PRINTFUL_API_KEY;else process.env.PRINTFUL_API_KEY=previous;});
  const rawRetry=new Date(Date.now()+15000).toUTCString();
  const fetch=t.mock.method(global,'fetch',async()=>({ok:false,status:429,
    headers:{get:key=>({'retry-after':rawRetry,'x-ratelimit-remaining':'2','x-ratelimit-reset':'60'})[key]??null},
    json:async()=>({status:429,title:'Too Many Requests',detail:'Request would exceed available attempts'}),
  }));
  await assert.rejects(printful.createMockupTasks({products:[{}]}),error=>error.message.includes('available attempts')&&error.retryAfter>=14&&error.retryAfter<=15&&error.rateLimitRemaining===2);
  let received;
  fetch.mock.mockImplementation(async(url,options)=>{
    assert.equal('onRateLimit' in options,false);
    return {ok:true,status:200,headers:{get:key=>({'x-ratelimit-remaining':'0','x-ratelimit-reset':'40'})[key]??null},
      json:async()=>({data:[{id:1,status:'pending'}]})};
  });
  await printful.createMockupTasks({products:[{}]},{onRateLimit:info=>{received=info;}});
  assert.equal(received.remaining,0);assert.equal(received.reset,40);
});
