'use strict';

// Operator-only calibration evidence. This script never creates orders or
// writes configurations. Signed source URLs and storage keys stay in /tmp.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { createCanvas } = require('canvas');
const { PRODUCTS, getPublicProduct } = require('../src/products');
const { renderProviderPng } = require('../src/printRaster');

const ROOT = path.join(__dirname, '..');
const OUTPUT = path.join(ROOT, 'reports/print-area-audit-2026-10-24/full');
const PRIVATE = '/private/tmp/printful-area-audit/full';
const STATE = path.join(PRIVATE, 'generation-state.json');
const PLAN = path.join(OUTPUT, 'coverage.json');
const sha = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const write = (file, value) => fs.writeFileSync(file, JSON.stringify(value, null, 2) + '\n');
const read = file => JSON.parse(fs.readFileSync(file));
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));

function calibration(product) {
  return Object.fromEntries(product.printSurfaces.map((surface, index) => {
    const area = product.designSafeAreas[surface.key] || product.designSafeAreas.default;
    const width = Math.floor(area.width - 40), height = Math.floor(area.height - 40);
    const scale = Math.min(1, 2048 / Math.max(width, height));
    const canvas = createCanvas(Math.round(width * scale), Math.round(height * scale));
    const ctx = canvas.getContext('2d');
    ctx.scale(canvas.width / width, canvas.height / height);
    const stroke = Math.max(12, Math.round(Math.min(width, height) / 65));
    ctx.lineWidth = stroke;
    ctx.strokeStyle = index ? '#a000c0' : '#0072d9';
    ctx.strokeRect(stroke, stroke, width - stroke * 2, height - stroke * 2);
    for (let column = 1; column < 4; column++) {
      ctx.strokeStyle = '#00aeae'; ctx.beginPath();
      ctx.moveTo(width * column / 4, stroke); ctx.lineTo(width * column / 4, height - stroke); ctx.stroke();
    }
    ctx.font = `bold ${Math.round(height / 9)}px sans-serif`;
    ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    for (const [row, color] of ['#e31c38', '#ec9700', '#23a047', '#0039c9'].entries()) {
      ctx.fillStyle = color;
      ctx.fillRect(stroke, height * (row + .15) / 4, width - stroke * 2, height * .12);
      ctx.fillStyle = '#000000';
      ctx.fillText(`${index ? 'BACK' : 'FRONT'} ${row + 1}`, width / 2, height * (row + .41) / 4);
    }
    const src = canvas.toDataURL('image/png'); canvas.width = 1;
    return [surface.key, [{ id: `calibration-${surface.key}`, type: 'image', src,
      x: area.x + area.width / 2, y: area.y + area.height / 2, width, height, angle: 0 }]];
  }));
}

function stylesFor(product, rows) {
  const selections = [];
  for (const placement of product.printful.placements) {
    let candidates = rows.filter(row => row.placement === placement &&
      row.technique === product.printful.technique).flatMap(row => row.mockup_styles
      .filter(style => style.restricted_to_variants == null ||
        style.restricted_to_variants.map(Number).includes(product.printful.variantId))
      .map(style => ({ row, style })));
    const explicit = candidates.filter(c => Array.isArray(c.style.restricted_to_variants));
    if (explicit.length) candidates = explicit;
    const exact = candidates.filter(({ row }) => {
      const width = product.printFile.width / product.printFile.dpi;
      const height = product.printFile.height / product.printFile.dpi;
      const close = (a, b) => Math.abs(a - b) < .04;
      return close(row.print_area_width, width) && close(row.print_area_height, height);
    });
    if (exact.length) candidates = exact;
    const rank = ({ style }) => {
      const category = style.category_name.toLowerCase();
      const view = style.view_name.toLowerCase();
      return (category === 'flat' ? 0 : category === 'flat 2' ? 10 : category.startsWith('flat') ? 20 :
        category === 'placeholder' ? 1000 : 100) + (view === (placement === 'back' ? 'back' : 'front') ? 0 : 2);
    };
    candidates.sort((a, b) => rank(a) - rank(b));
    const selected = candidates[0];
    if (!selected) throw new Error(`No mockup style for ${product.key}/${placement}`);
    const chosen = [selected];
    if (['colored-mug', 'travel'].includes(product.previewModel?.kind) && !product.previewMesh) {
      for (const view of ['left', 'right']) {
        const side = candidates.find(c => c.style.category_name === selected.style.category_name &&
          c.style.view_name.toLowerCase() === view);
        if (side) chosen.push(side);
      }
    }
    for (const { row, style } of chosen) selections.push({ placement, id: style.id,
      view: style.view_name, category: style.category_name, printAreaType: row.print_area_type,
      explicitVariant: Array.isArray(style.restricted_to_variants) });
  }
  return selections;
}

async function prepare() {
  if (fs.existsSync(PLAN)) throw Error('Coverage already exists. Resume with generate/poll; preserve the reviewed evidence.');
  fs.mkdirSync(path.join(OUTPUT, 'inputs'), { recursive: true });
  fs.mkdirSync(path.join(OUTPUT, 'provider'), { recursive: true });
  fs.mkdirSync(path.join(OUTPUT, 'local'), { recursive: true });
  const legacyRoot = path.dirname(OUTPUT), legacy = read(path.join(legacyRoot, 'audit.json'));
  const cases = [], inputCache = new Map();
  for (const source of PRODUCTS) {
    const rows = read(path.join(PRIVATE, `styles-${source.printful.productId}.json`)).data;
    for (const orientation of source.orientationOptions.length ? ['portrait', 'landscape'] : ['default']) {
      const product = { ...getPublicProduct(source, orientation), printful: source.printful };
      const id = `${source.key}--${orientation}`;
      const old = legacy.proofs.find(p => p.productKey === source.key);
      const reuse = old && orientation !== 'landscape';
      const designs = reuse ? read(path.join(legacyRoot, `${source.key}-design.json`)).designs : calibration(product);
      const inputs = {};
      for (const surface of product.printSurfaces) {
        const key = sha(Buffer.from(JSON.stringify([product.printFile, designs[surface.key]])));
        if (!inputCache.has(key)) {
          const bytes = await renderProviderPng(product, designs[surface.key]);
          const hash = sha(bytes), file = `inputs/${hash.slice(0, 20)}.png`;
          if (!fs.existsSync(path.join(OUTPUT, file))) fs.writeFileSync(path.join(OUTPUT, file), bytes);
          inputCache.set(key, { file, sha256: hash });
          global.gc?.();
        }
        inputs[surface.key] = inputCache.get(key);
      }
      const designFile = `inputs/${id}.json`; write(path.join(OUTPUT, designFile), designs);
      const provider = reuse ? old.views.map(view => ({ ...view, file: '../' + view.file })) : [];
      cases.push({ id, productKey: source.key, orientation, variantId: source.printful.variantId,
        productId: source.printful.productId, product, designsFile: designFile, inputs,
        styles: stylesFor(product, rows), providerStatus: reuse ? 'completed' : 'not-started', provider,
        comparisonStatus: 'not-reviewed' });
    }
    console.log(`Prepared ${source.key}`);
  }
  write(PLAN, { version: 1, preparedAt: new Date().toISOString(), physicalSamples: false, cases });
  console.log(`Coverage: ${PRODUCTS.length} variants, ${cases.length} orientations, ${cases.reduce((n, c) => n + Object.keys(c.inputs).length, 0)} surfaces.`);
}

function online() {
  require('dotenv').config({ path: path.join(ROOT, '.env'), quiet: true });
  // V2 validation uses problem+json, while the shared client exposes the
  // legacy error message. Keep diagnostics private and redact source URLs.
  const originalFetch = global.fetch;
  global.fetch = async (...args) => {
    const response = await originalFetch(...args);
    if (!response.ok && String(args[0]).startsWith('https://api.printful.com/v2/mockup-tasks')) {
      const body = await response.clone().text();
      fs.writeFileSync(path.join(PRIVATE, 'last-provider-error.json'),
        body.replace(/https?:\/\/[^\s"<>]+/g, '[URL redacted]'));
    }
    return response;
  };
  return { api: require('../src/printful'), storage: require('../src/privateStorage') };
}
function state() { return fs.existsSync(STATE) ? read(STATE) : { sources: {}, jobs: [], lastCreateAt: 0 }; }

async function generate(only, batchSize) {
  const { api, storage } = online(), plan = read(PLAN), saved = state();
  let pending = plan.cases.filter(c => c.providerStatus === 'not-started' && (!only || c.productKey === only));
  // A batch contains each variant at most once, so results can always be
  // associated with their exact orientation even if the API combines tasks.
  const batch = [];
  for (const c of pending) if (!batch.some(b => b.variantId === c.variantId) && batch.length < batchSize) batch.push(c);
  if (!batch.length) { console.log('No unsubmitted cases in this selection.'); return; }
  const products = [];
  for (const c of batch) {
    const placements = [];
    for (const [index, surface] of c.product.printSurfaces.entries()) {
      const input = c.inputs[surface.key];
      if (!saved.sources[input.sha256]) {
        const key = `operator-mockup-sources/${Math.floor(Date.now() / 1000) + 3600}-area-${crypto.randomBytes(12).toString('hex')}.png`;
        saved.sources[input.sha256] = { key, uploaded: false, removed: false };
        write(STATE, saved);
      }
      if (!saved.sources[input.sha256].uploaded) {
        await storage.upload(saved.sources[input.sha256].key, fs.readFileSync(path.join(OUTPUT, input.file)), 'image/png');
        saved.sources[input.sha256].uploaded = true;
        write(STATE, saved);
      }
      const entry = saved.sources[input.sha256];
      if (!entry.url) { entry.url = await storage.createSignedUrl(entry.key, 3600); write(STATE, saved); }
      placements.push({ placement: c.product.printful.placements[index], technique: c.product.printful.technique,
        print_area_type: c.styles.find(s => s.placement === c.product.printful.placements[index]).printAreaType,
        layers: [{ type: 'file', url: entry.url }] });
    }
    products.push({ source: 'catalog', catalog_product_id: c.productId, catalog_variant_ids: [c.variantId],
      mockup_style_ids: [...new Set(c.styles.map(s => s.id))], placements,
      ...(['portrait', 'landscape'].includes(c.orientation) ? { orientation: c.orientation === 'portrait' ? 'vertical' : 'horizontal' } : {}),
      ...(c.product.printful.options.length ? { product_options: c.product.printful.options.map(o => ({ name: o.id, value: o.value })) } : {}) });
  }
  const wait = saved.lastCreateAt + 31000 - Date.now();
  if (wait > 0) { console.log(`Respecting provider request spacing (${Math.ceil(wait / 1000)}s).`); await pause(wait); }
  try {
    const tasks = await api.createMockupTasks({ format: 'png', mockup_width_px: 1000, products });
    saved.lastCreateAt = Date.now();
    saved.jobs.push({ ids: tasks.map(t => t.id), cases: batch.map(c => c.id), createdAt: new Date().toISOString(), status: 'pending' });
    for (const c of batch) c.providerStatus = 'pending';
    write(STATE, saved); write(PLAN, plan);
    console.log(`Submitted ${batch.length} cases; provider tasks ${tasks.map(t => t.id).join(',')}.`);
  } catch (error) {
    saved.lastCreateAt = Date.now(); write(STATE, saved);
    const available = String(error.message).match(/catalog variant:\s*(\d+).*Available `style_ids` are:\s*([\d, ]+)/s);
    console.error(JSON.stringify({ code: error.code, providerStatus: error.providerStatus,
      retryAfter: error.retryAfter, rateLimitRemaining: error.rateLimitRemaining,
      ...(available ? { variantId: Number(available[1]), availableStyles: available[2] } : {}) }));
    process.exitCode = 1;
  }
}

async function poll() {
  const { api } = online(), plan = read(PLAN), saved = state();
  for (const job of saved.jobs.filter(j => j.status === 'pending')) {
    const tasks = await api.getMockupTasks(job.ids);
    if (tasks.some(t => t.status === 'pending')) continue;
    if (tasks.some(t => t.status === 'failed')) {
      job.status = 'failed';
      for (const id of job.cases) plan.cases.find(c => c.id === id).providerStatus = 'failed';
      write(STATE, saved); write(PLAN, plan); continue;
    }
    if (!tasks.length || tasks.some(t => t.status !== 'completed')) continue;
    for (const id of job.cases) {
      const c = plan.cases.find(c => c.id === id), images = tasks.flatMap(t => t.catalog_variant_mockups || [])
        .filter(v => v.catalog_variant_id === c.variantId).flatMap(v => v.mockups || []);
      c.provider = [];
      for (const [index, image] of images.entries()) {
        const url = new URL(image.mockup_url);
        if (url.protocol !== 'https:' || !(url.hostname.endsWith('.printful.com') ||
            ['printful-upload.s3-accelerate.amazonaws.com', 'printful-upload.s3.amazonaws.com'].includes(url.hostname))) throw Error('Unexpected proof origin');
        const response = await fetch(url, { signal: AbortSignal.timeout(30000) });
        if (!response.ok) throw Error(`Proof download ${response.status}`);
        const bytes = Buffer.from(await response.arrayBuffer());
        if (bytes.length > 20 * 1024 * 1024) throw Error('Proof exceeds image budget');
        const file = `provider/${id}-${index}.png`; fs.writeFileSync(path.join(OUTPUT, file), bytes);
        c.provider.push({ file, sha256: sha(bytes), placement: image.placement, styleId: image.style_id,
          view: c.styles.find(s => s.id === image.style_id)?.view || '', sourceUrl: url.toString() });
      }
      c.providerStatus = c.provider.length ? 'completed' : 'missing-images';
    }
    job.status = 'completed'; write(STATE, saved); write(PLAN, plan);
  }
  const counts = {};
  for (const c of plan.cases) counts[c.providerStatus] = (counts[c.providerStatus] || 0) + 1;
  console.log(JSON.stringify(counts));
}

async function cleanup() {
  const { storage } = online(), saved = state();
  if (saved.jobs.some(j => j.status === 'pending')) throw Error('Keep sources until active provider tasks finish.');
  for (const entry of Object.values(saved.sources).filter(s => !s.removed)) {
    await storage.remove(entry.key); entry.removed = true; delete entry.url; write(STATE, saved);
  }
  console.log(`Removed ${Object.values(saved.sources).filter(s => s.removed).length} temporary sources.`);
}

if (require.main === module) {
  const command = process.argv[2];
  const only = process.argv.find(a => a.startsWith('--only='))?.slice(7);
  const batch = Number(process.argv.find(a => a.startsWith('--batch='))?.slice(8) || 20);
  Promise.resolve().then(() => {
    if (!Number.isSafeInteger(batch) || batch < 1 || batch > 20) throw Error('Batch size must be an integer from 1 to 20.');
    if (command === 'prepare') return prepare();
    if (command === 'generate') return generate(only, batch);
    if (command === 'poll') return poll();
    if (command === 'cleanup') return cleanup();
    throw Error('Use prepare, generate, poll, or cleanup.');
  }).catch(error => { console.error(error.code || error.name, error.message.includes('https:') ? 'Provider operation failed.' : error.message); process.exitCode = 1; });
}

module.exports = { calibration, stylesFor };
