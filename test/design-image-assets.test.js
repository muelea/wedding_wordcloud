'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { createCanvas } = require('canvas');
const { startTestServer, createEvent } = require('./helpers');
const ImageData = require('../public/js/design-image-data');
const { getProduct, resolveProductOrientation } = require('../src/products');

function sources(count, seed = 0) {
  return Array.from({ length: count }, (_, i) => {
    const c = createCanvas(32, 32), ctx = c.getContext('2d');
    ctx.fillStyle = `rgb(${(i * 11 + seed) % 256},${(i * 31 + seed) % 256},${(i * 59 + seed) % 256})`;
    ctx.fillRect(0, 0, 32, 32);
    return c.toDataURL();
  });
}
function artwork(images, key = 'white-glossy-mug-duo-11oz') {
  const product = resolveProductOrientation(getProduct(key), 'default');
  return { productKey: key, orientation: 'default', theme: 'pastel', words: [['Liebe', 1]],
    designs: Object.fromEntries(product.printSurfaces.map(surface => {
      const area = product.designSafeAreas[surface.key];
      return [surface.key, images.map((src, i) => ({ id: `photo-${i}`, type: 'image', src,
        x: area.x + area.width / 2, y: area.y + area.height / 2, width: 96, height: 96, angle: 0 }))];
    })) };
}
function memoryStorage() {
  const objects = new Map();
  return { objects, uploads: 0, failUpload: false, failRemove: false,
    async upload(key, bytes) { this.uploads++; if (this.failUpload) throw new Error('unavailable');
      if (objects.has(key)) throw new Error('already exists'); objects.set(key, Buffer.from(bytes)); },
    async download(key) { if (!objects.has(key)) throw new Error('missing'); return objects.get(key); },
    async remove(key) { if (this.failRemove) throw new Error('unavailable'); objects.delete(key); },
  };
}

test('image packets deduplicate both sides and retained layouts without changing artwork', () => {
  const payload = artwork(sources(20), 'all-over-basic-pillow-18in');
  payload.snapshot = { productDesignState: { surfaces: [{ design: payload.designs.front }] } };
  const packet = ImageData.pack(payload);
  assert.equal(packet.imagePacket.images.length, 20);
  assert.ok(JSON.stringify(packet).length < JSON.stringify(payload).length, 'repeated sources occur once in the packet');
  assert.deepEqual(ImageData.unpack(packet), payload);
  assert.throws(() => ImageData.unpack({ imagePacket: { ...packet.imagePacket,
    data: { src: 'image:20' } } }), /invalid_image_packet/);
  assert.equal(ImageData.problem(payload), null);
  assert.equal(ImageData.problem(artwork(sources(21))), ImageData.MESSAGES.images);
  const oversized = structuredClone(payload);
  oversized.designs.front[0].src = `data:image/png;base64,${'A'.repeat(15 * 1024 * 1024)}`;
  assert.throws(() => ImageData.unpack(ImageData.pack(oversized)), /invalid_image_packet/);
});

test('the editor checks every print side before adding a new photo and permits source reuse', async () => {
  const fs = require('node:fs'), vm = require('node:vm');
  const root = { DesignImageData: ImageData };
  vm.runInNewContext(fs.readFileSync(require.resolve('../public/js/mug-editor'), 'utf8'), { window: root });
  const existing = artwork(sources(20), 'all-over-basic-pillow-18in');
  let feedback = null, loads = 0, src = sources(1, 219)[0];
  const editor = { closeIconPicker() {},
    async normalizedImageUpload() { return { dataUrl: src, width: 32, height: 32 }; },
    getImageDesigns: () => existing.designs, setFeedback: message => { feedback = message; },
    async loadImageSource() { loads++; }, canAddElements: () => false };
  await root.MugPrintEditor.prototype.addImageFile.call(editor, {});
  assert.equal(feedback, ImageData.MESSAGES.images);
  assert.equal(loads, 0, 'a rejected upload never mutates the canvas or loads a new source');
  feedback = null; src = existing.designs.front[0].src;
  await root.MugPrintEditor.prototype.addImageFile.call(editor, {});
  assert.equal(feedback, null);
  assert.equal(loads, 1, 'reusing an existing source is valid across front and back');
});

test('private source images stay immutable, scoped, referenced and recoverable', async t => {
  const h = await startTestServer(); t.after(h.close);
  const db = require('../src/db'), assets = require('../src/designImageAssets'), saved = require('../src/savedDesigns');
  const imageStorage = memoryStorage(), accountStorage = memoryStorage();
  assets.setStorageForTests(imageStorage); saved.setStorageForTests(accountStorage);
  const event = await createEvent(h.baseUrl), other = await createEvent(h.baseUrl);
  Object.assign(event, await db.getEventBySlug(event.slug));
  const input = artwork(sources(20));
  const save = async (payload, slug = event.slug) => {
    const response = await fetch(`${h.baseUrl}/api/events/${slug}/configurations`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(ImageData.pack(payload)),
    });
    return { response, data: await response.json() };
  };
  let configuration;
  await t.test('twenty photos round-trip exactly while Postgres contains only file references', async () => {
    const result = await save(input); assert.equal(result.response.status, 201, JSON.stringify(result.data));
    configuration = result.data;
    const row = (await h.query('SELECT design_json FROM configurations WHERE id=$1', [configuration.id])).rows[0];
    assert.ok(JSON.stringify(row.design_json).length < 6000);
    assert.doesNotMatch(JSON.stringify(row), /data:image/);
    assert.equal(assets.ids(row.design_json).length, 20);
    assert.equal((await h.query('SELECT * FROM configuration_image_assets WHERE configuration_id=$1', [configuration.id])).rowCount, 20);
    const restored = await fetch(`${h.baseUrl}/api/events/${event.slug}/configurations/${configuration.id}/edit`).then(r => r.json());
    assert.deepEqual(restored.designs, input.designs);
    assert.equal((await fetch(`${h.baseUrl}/api/events/${other.slug}/configurations/${configuration.id}/edit`)).status, 404);
    const again = await save(input); assert.equal(again.response.status, 201);
    assert.equal(imageStorage.uploads, 20, 'new versions reuse immutable sources within the workspace');
    const foreign = await save(input, other.slug); assert.equal(foreign.response.status, 201);
    assert.equal(imageStorage.uploads, 40, 'independent workspaces never share access or hash-existence results');
  });
  await t.test('the count and pixel budgets cover every side, including forged references', async () => {
    assert.equal((await save(artwork(sources(21)))).response.status, 400);
    const forged = structuredClone(input);
    delete forged.designs.default[0].src;
    forged.designs.default[0].assetId = crypto.randomUUID();
    assert.equal((await save(forged)).response.status, 400);
    const pillow = artwork(sources(20), 'all-over-basic-pillow-18in');
    assert.equal((await save(pillow)).response.status, 201, 'duplicates on both sides are counted once');
    pillow.designs.back.push({ ...pillow.designs.back[0], id: 'extra', src: sources(1, 231)[0] });
    assert.equal((await save(pillow)).response.status, 400);
    const oversized = artwork(sources(5, 13));
    oversized.designs.default.forEach(item => {
      const bytes = Buffer.from(item.src.split(',')[1], 'base64');
      bytes.writeUInt32BE(4000, 16); bytes.writeUInt32BE(4000, 20);
      item.src = `data:image/png;base64,${bytes.toString('base64')}`;
    });
    assert.equal((await save(oversized)).response.status, 400, 'oversized decoded pixels are rejected before decoding');
  });
  await t.test('a large two-sided collage crosses the old request ceiling and saves once per source', async () => {
    const photos = Array.from({ length: 9 }, () => {
      const canvas = createCanvas(512, 512), context = canvas.getContext('2d');
      const pixels = context.createImageData(512, 512);
      pixels.data.set(crypto.randomBytes(pixels.data.length));
      context.putImageData(pixels, 0, 0);
      return canvas.toDataURL();
    });
    const collage = artwork(photos, 'all-over-basic-pillow-18in');
    assert.ok(Buffer.byteLength(JSON.stringify(collage)) > 16 * 1024 * 1024);
    assert.ok(Buffer.byteLength(JSON.stringify(ImageData.pack(collage))) < 16 * 1024 * 1024);
    const result = await save(collage);
    assert.equal(result.response.status, 201, JSON.stringify(result.data));
    const restored = await fetch(`${h.baseUrl}/api/events/${event.slug}/configurations/${result.data.id}/edit`).then(r => r.json());
    assert.deepEqual(restored.designs, collage.designs);
    assert.equal((await h.query('SELECT * FROM configuration_image_assets WHERE configuration_id=$1', [result.data.id])).rowCount, 9);
  });
  await t.test('failed uploads publish no configuration and retry the same reserved immutable object', async () => {
    const before = (await h.query('SELECT count(*)::int AS n FROM configurations')).rows[0].n;
    const fresh = artwork(sources(1, 219));
    imageStorage.failUpload = true;
    assert.equal((await save(fresh)).response.status, 503);
    assert.equal((await h.query('SELECT count(*)::int AS n FROM configurations')).rows[0].n, before);
    const pending = (await h.query("SELECT id,object_key FROM design_image_assets WHERE status='uploading'")).rows;
    assert.ok(pending.length);
    imageStorage.failUpload = false;
    assert.equal((await save(fresh)).response.status, 201);
    assert.equal((await h.query('SELECT status FROM design_image_assets WHERE id=$1', [pending[0].id])).rows[0].status, 'active');
  });
  await t.test('account snapshots remain compact, charge image bytes and survive exact idempotent retries', async () => {
    const accountId = crypto.randomUUID(); await db.ensureDesignAccount({ id: accountId, verified: true });
    const snapshot = structuredClone(input);
    snapshot.productDesignState = { version: 1, surfaces: [], layouts: [{ productKey: input.productKey, orientation: 'default',
      surfaces: [input.designs.default.map(({ src, ...item }) => item)] }] };
    const body = { name: 'Fotocollage', requestId: crypto.randomUUID(), designId: crypto.randomUUID(), version: 0, snapshot };
    const result = await saved.save(accountId, body, 'de');
    const row = await db.getSavedDesign(accountId, result.id), packet = JSON.parse(accountStorage.objects.get(row.snapshot_key));
    assert.equal(packet.version, 2); assert.doesNotMatch(JSON.stringify(packet), /data:image/);
    assert.equal(row.image_asset_ids.length, 20);
    const sourceBytes = sources(20).reduce((n, src) => n + Buffer.from(src.split(',')[1], 'base64').length, 0);
    assert.ok(result.byteSize >= sourceBytes + accountStorage.objects.get(row.snapshot_key).length);
    const restored = (await saved.load(accountId, result.id)).snapshot;
    assert.deepEqual(restored.designs, input.designs);
    assert.deepEqual(restored.productDesignState, saved.normalizeSnapshot(snapshot).productDesignState);
    assert.equal((await saved.save(accountId, body, 'de')).version, 1);
    const uploads = imageStorage.uploads;
    await h.query('UPDATE saved_designs SET byte_size=20971520 WHERE id=$1', [result.id]);
    for (let i = 0; i < 4; i++) await h.query(`INSERT INTO saved_designs
      (id,account_id,name,product_key,orientation,snapshot_key,preview_key,snapshot_sha256,byte_size)
      VALUES ($1,$2,'Quota','white-glossy-mug-duo-11oz','default',$3,$4,$5,20971520)`,
    [crypto.randomUUID(), accountId, `quota-${i}`, `quota-${i}.png`, 'a'.repeat(64)]);
    await assert.rejects(saved.save(accountId, { ...body, requestId: crypto.randomUUID(), designId: crypto.randomUUID(),
      snapshot: artwork(sources(1, 229)) }, 'de'), { code: 'design_quota' });
    assert.equal(imageStorage.uploads, uploads, 'quota is reserved before uploading source files');
    await db.beginDesignAccountDeletion(accountId);
    assert.equal((await h.query('SELECT * FROM saved_design_image_assets WHERE design_id=$1', [result.id])).rowCount, 0);
    assert.deepEqual((await fetch(`${h.baseUrl}/api/events/${event.slug}/configurations/${configuration.id}/edit`).then(r => r.json())).designs, input.designs);
  });
  await t.test('legacy inline rows and saved packets retain their exact image bytes', async () => {
    const original = artwork(sources(1, 24));
    const legacyId = crypto.randomBytes(12).toString('base64url');
    await h.query(`INSERT INTO configurations(id,event_id,product_key,printful_variant_id,quantity,theme,words_json,design_json,print_width,print_height,expires_at)
      SELECT $1,id,'white-glossy-mug-duo-11oz',$4,2,'pastel','[["Liebe",1]]',$3,2700,1050,expires_at FROM events WHERE id=$2`,
    [legacyId,event.id,{ version: 2, surfaces: original.designs },getProduct(original.productKey).printful.variantId]);
    const restored = await fetch(`${h.baseUrl}/api/events/${event.slug}/configurations/${legacyId}/edit`).then(r => r.json());
    assert.deepEqual(restored.designs, original.designs);
    const packet = saved.encodeSnapshot(saved.normalizeSnapshot(original));
    assert.equal(JSON.parse(packet).version, 1);
    assert.deepEqual(saved.decodeSnapshot(packet).designs, original.designs);
  });
  await t.test('order copies and reorder copies pin the original sources independently and retain their print hash', async () => {
    const print = require('../src/printPreparation');
    const compact = await db.getConfiguration(configuration.id);
    assert.doesNotMatch(compact.design_json, /data:image/);
    const design = JSON.parse(compact.design_json), hydrated = await assets.hydrate(design);
    const product = resolveProductOrientation(getProduct(compact.product_key), compact.orientation);
    assert.equal(print.specification(product, hydrated), print.specification(product, design));
    const quote = await db.createCheckoutQuote({ eventId: event.id, configurationId: compact.id,
      recipient: { name: 'Collage Test', address1: 'Testweg 1', city: 'Berlin', zip: '10115', country_code: 'DE' },
      printfulCosts: { currency: 'EUR', subtotal: 10, shipping: 5, vat: 3, total: 18 },
      quote: { currency: 'EUR', quantity: 2, itemsCents: 2000, shippingCents: 500, taxCents: 0, totalCents: 2500 } });
    const { order } = await db.createCheckoutOrder({ eventId: event.id, configurationId: compact.id, quote, mode: 'test' });
    const [item] = await db.getOrderItems(order.id);
    assert.doesNotMatch(item.configuration_snapshot_json, /data:image/);
    assert.equal((await h.query('SELECT * FROM order_item_image_assets WHERE order_item_id=$1', [item.id])).rowCount, 20);
    const artifact = { id: crypto.randomBytes(18).toString('base64url'), orderId: order.id, orderItemId: item.id,
      configurationId: compact.id, surfaceKey: 'size-check', objectKey: `test-size/${crypto.randomUUID()}.png`,
      mimeType: 'image/png', byteSize: 40 * 1024 * 1024, sha256: 'a'.repeat(64),
      accessNonce: crypto.randomBytes(24).toString('base64url'), expiresAt: new Date(Date.now() + 60_000) };
    assert.equal((await db.getOrCreatePrintArtifact(artifact)).byte_size, 40 * 1024 * 1024);
    await assert.rejects(db.getOrCreatePrintArtifact({ ...artifact, id: crypto.randomBytes(18).toString('base64url'),
      surfaceKey: 'oversize', objectKey: `test-size/${crypto.randomUUID()}.png`, byteSize: 40 * 1024 * 1024 + 1 }),
    { constraint: 'print_artifacts_size_valid' });

    await h.query("UPDATE orders SET status='paid_test',stripe_session_id='cs_test_collage_reorder',paid_at=now() WHERE id=$1", [order.id]);
    const copies = await db.createReorderConfigurations(event.slug, 'cs_test_collage_reorder', crypto.randomUUID());
    assert.equal(copies.length, 1);
    assert.doesNotMatch(copies[0].design_json, /data:image/);
    assert.deepEqual(await assets.hydrate(JSON.parse(copies[0].design_json)), hydrated);
    assert.equal((await h.query('SELECT * FROM configuration_image_assets WHERE configuration_id=$1', [copies[0].id])).rowCount, 20);
    await h.query('DELETE FROM configuration_image_assets WHERE asset_id=ANY($1::uuid[])', [assets.ids(design)]);
    const pinned = assets.ids(design)[0];
    await h.query("UPDATE design_image_assets SET protected_until=now()-interval '2 hours',upload_deadline=now()-interval '2 hours' WHERE id=ANY($1::uuid[])", [assets.ids(design)]);
    assert.equal(await db.claimUnusedDesignImageAsset(pinned), null, 'the order alone pins source files');
    assert.deepEqual(await assets.hydrate(JSON.parse(item.configuration_snapshot_json).design), hydrated);
    await h.query("UPDATE order_items SET configuration_snapshot_json=configuration_snapshot_json-'design' WHERE id=$1", [item.id]);
    assert.equal((await h.query('SELECT * FROM order_item_image_assets WHERE order_item_id=$1', [item.id])).rowCount, 0);
    // Restore the real parent references after probing independent order retention.
    await h.query('UPDATE configurations SET design_json=design_json WHERE id=$1', [compact.id]);
  });
  await t.test('a reference published after the cleanup snapshot prevents object deletion', async st => {
    const prepared = await assets.prepare('test:publication-race', { type: 'image', src: sources(1, 227)[0] });
    const id = prepared.assetIds[0], pool = db.getPool();
    await h.query("UPDATE design_image_assets SET protected_until=now()-interval '2 hours',upload_deadline=now()-interval '2 hours' WHERE id=$1", [id]);
    const control = await pool.connect(), publisher = await pool.connect();
    const key = crypto.randomBytes(4).readUInt32BE(0) >>> 1;
    const originalConnect = pool.connect.bind(pool);
    await control.query('SELECT pg_advisory_lock($1)', [key]);
    // Pause projection before LockRows. Another transaction can publish its
    // reference after this statement's snapshot but before its asset row lock.
    const mocked = st.mock.method(pool, 'connect', async () => {
      const client = await originalConnect();
      return new Proxy(client, { get(target, property) {
        if (property === 'query') return (sql, values) => target.query(
          typeof sql === 'string' && sql.startsWith('SELECT a.* FROM design_image_assets a')
            ? sql.replace('SELECT a.*', `SELECT a.*,pg_advisory_xact_lock(${key})`) : sql, values);
        const value = Reflect.get(target, property);
        return typeof value === 'function' ? value.bind(target) : value;
      } });
    });
    const pending = db.claimUnusedDesignImageAsset(id);
    try {
      let blocked = false;
      for (let attempt = 0; attempt < 200; attempt++) {
        blocked = (await control.query("SELECT 1 FROM pg_locks WHERE locktype='advisory' AND objid=$1 AND NOT granted", [key])).rowCount > 0;
        if (blocked) break;
        await new Promise(resolve => setTimeout(resolve, 5));
      }
      assert.ok(blocked, 'cleanup holds an older statement snapshot');
      const configurationId = crypto.randomBytes(12).toString('base64url');
      await publisher.query(`INSERT INTO configurations
        (id,event_id,product_key,printful_variant_id,quantity,theme,words_json,design_json,print_width,print_height,expires_at)
        SELECT $1,event_id,product_key,printful_variant_id,quantity,theme,words_json,$3,print_width,print_height,expires_at
        FROM configurations WHERE id=$2`, [configurationId, configuration.id, { version: 2, surfaces: { default: [prepared.value] } }]);
      await control.query('SELECT pg_advisory_unlock($1)', [key]);
      assert.equal(await pending, null);
      const row = (await publisher.query('SELECT * FROM design_image_assets WHERE id=$1', [id])).rows[0];
      assert.equal(row.status, 'active');
      assert.ok(imageStorage.objects.has(row.object_key));
    } finally {
      mocked.mock.restore();
      await control.query('SELECT pg_advisory_unlock($1)', [key]);
      await pending.catch(() => {});
      control.release(); publisher.release();
    }
  });
  await t.test('lost upload responses reuse the same object and corrupted stored bytes fail closed', async () => {
    const adapter = memoryStorage(), upload = adapter.upload;
    adapter.upload = async function (...args) { await upload.apply(this, args); throw new Error('response lost'); };
    assets.setStorageForTests(adapter);
    try {
      const prepared = await assets.prepare('test:lost-response', { type: 'image', src: sources(1, 223)[0] });
      assert.equal(adapter.objects.size, 1);
      assert.equal((await assets.hydrate(prepared.value)).src, sources(1, 223)[0]);
      const row = (await db.getDesignImageAssets(prepared.assetIds))[0];
      adapter.objects.set(row.object_key, Buffer.from('corrupt'));
      await assert.rejects(assets.hydrate(prepared.value), { code: 'design_image_unavailable' });
    } finally { assets.setStorageForTests(imageStorage); }
  });
  await t.test('unreferenced files retain retry metadata, reject stale owners and cannot be resurrected during deletion', async () => {
    const prepared = await assets.prepare('test:orphan', { type: 'image', src: sources(1, 211)[0] });
    const id = prepared.assetIds[0];
    await h.query("UPDATE design_image_assets SET protected_until=now()-interval '2 hours',upload_deadline=now()-interval '2 hours' WHERE id=$1", [id]);
    imageStorage.failRemove = true;
    assert.equal((await assets.cleanupOne(id)).failed, 1);
    assert.equal((await h.query('SELECT last_error FROM design_image_assets WHERE id=$1', [id])).rows[0].last_error, 'delete_failed');
    imageStorage.failRemove = false;
    await h.query('UPDATE design_image_assets SET next_attempt_at=now() WHERE id=$1', [id]);
    const claim = await db.claimUnusedDesignImageAsset(id);
    assert.ok(claim);
    assert.equal(await db.finishDesignImageDeletion(id, crypto.randomUUID(), true), false);
    await assert.rejects(assets.prepare('test:orphan', { type: 'image', src: sources(1, 211)[0] }), { code: 'design_image_unavailable' });
    assert.equal(await db.activateDesignImageAsset(id, claim.sha256, Number(claim.byte_size)), null);
    await imageStorage.remove(claim.object_key);
    assert.equal(await db.finishDesignImageDeletion(id, claim.lease, true), true);
    assert.equal((await h.query('SELECT * FROM design_image_assets WHERE id=$1', [id])).rowCount, 0);
    const pinned = (await h.query('SELECT asset_id FROM configuration_image_assets WHERE configuration_id=$1 LIMIT 1', [configuration.id])).rows[0].asset_id;
    await h.query("UPDATE design_image_assets SET protected_until=now()-interval '2 hours',upload_deadline=now()-interval '2 hours' WHERE id=$1", [pinned]);
    assert.equal(await db.claimUnusedDesignImageAsset(pinned), null);
  });
});
