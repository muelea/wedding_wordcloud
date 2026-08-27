'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const sharp = require('sharp');
const { startTestServer, createEvent } = require('./helpers');

const OWNER = '1'.repeat(32);

function fakeStorage() {
  const objects = new Map();
  return {
    objects,
    uploads: 0,
    removals: 0,
    failUpload: false,
    failRemove: false,
    adapter: null,
    initialize() {
      this.adapter = {
        upload: async (key, bytes) => {
          this.uploads += 1;
          if (this.failUpload) throw new Error('simulated upload failure');
          this.objects.set(key, Buffer.from(bytes));
        },
        createSignedUrl: async (key) => {
          if (!this.objects.has(key)) throw new Error('missing object');
          return `https://storage.test/${key}?token=short-lived`;
        },
        download: async (key) => {
          if (!this.objects.has(key)) throw new Error('missing object');
          return Buffer.from(this.objects.get(key));
        },
        remove: async (key) => {
          this.removals += 1;
          if (this.failRemove) throw new Error('simulated delete failure');
          this.objects.delete(key);
        },
      };
      return this;
    },
  }.initialize();
}

async function imageDataUrl({ width = 96, height = 72, color = '#c64e78', format = 'jpeg' } = {}) {
  const image = sharp({ create: { width, height, channels: 4, background: color } });
  const bytes = format === 'png' ? await image.png().toBuffer() : await image.jpeg({ quality: 92 }).toBuffer();
  return `data:image/${format};base64,${bytes.toString('base64')}`;
}

async function uploadAsset(baseUrl, slug, dataUrl, owner = OWNER) {
  const response = await fetch(`${baseUrl}/api/events/${slug}/assets`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Wolkenworte-Guest-Id': owner,
    },
    body: JSON.stringify({ dataUrl }),
  });
  return { response, body: await response.json() };
}

function photoPayload(assetId, previewUrl = 'https://storage.test/preview') {
  return {
    configurationType: 'personal_memory',
    productKey: 'white-glossy-mug-duo-11oz',
    quantity: 1,
    theme: 'pastel',
    designs: {
      default: [{
        id: 'foto-private',
        type: 'image',
        assetId,
        // The server deliberately ignores this transient URL when storing.
        src: previewUrl,
        x: 1350,
        y: 525,
        width: 640,
        height: 480,
        angle: 0,
      }],
    },
  };
}

async function savePhotoConfiguration(baseUrl, slug, assetId, previewUrl) {
  return fetch(`${baseUrl}/api/events/${slug}/configurations`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(photoPayload(assetId, previewUrl)),
  });
}

async function setupStorageTest(t) {
  const server = await startTestServer();
  t.after(server.close);
  const storage = fakeStorage();
  const privateStorage = require('../src/privateStorage');
  privateStorage.setAdapterForTests(storage.adapter);
  t.after(() => privateStorage.resetAdapterForTests());
  return { ...server, storage };
}

test('private uploads validate, normalize and track one non-public Storage object', async (t) => {
  const { baseUrl, query, storage } = await setupStorageTest(t);
  const event = await createEvent(baseUrl);
  const source = await imageDataUrl({ format: 'png' });
  const uploaded = await uploadAsset(baseUrl, event.slug, source);

  assert.equal(uploaded.response.status, 201);
  assert.match(uploaded.body.assetId, /^[A-Za-z0-9_-]{24}$/);
  assert.match(uploaded.body.previewUrl, /^https:\/\/storage\.test\/photos\//);
  assert.equal(uploaded.body.expiresInSeconds, 900);
  assert.equal(storage.uploads, 1);
  assert.equal(storage.objects.size, 1);

  const row = (await query('SELECT * FROM design_assets WHERE id = $1', [uploaded.body.assetId])).rows[0];
  assert.equal(row.storage_status, 'active');
  assert.equal(row.event_id != null, true);
  assert.equal(row.uploader_owner_id, OWNER);
  assert.equal(row.mime_type, 'image/png');
  assert.equal(row.byte_size, storage.objects.get(row.object_key).length);
  assert.equal(row.sha256, crypto.createHash('sha256').update(storage.objects.get(row.object_key)).digest('hex'));
  assert.equal(row.last_delete_error, null);
  assert.ok(Date.parse(row.expires_at) > Date.now() + 29 * 24 * 60 * 60 * 1000);

  const normalizedMetadata = await sharp(storage.objects.get(row.object_key)).metadata();
  assert.equal(normalizedMetadata.width, 96);
  assert.equal(normalizedMetadata.height, 72);
  assert.equal(normalizedMetadata.exif, undefined, 'normalization strips source metadata');
});

test('malformed and oversized-dimension images are rejected before Storage', async (t) => {
  const { baseUrl, storage } = await setupStorageTest(t);
  const event = await createEvent(baseUrl);

  const malformed = await uploadAsset(
    baseUrl,
    event.slug,
    `data:image/jpeg;base64,${Buffer.from('not a jpeg').toString('base64')}`
  );
  assert.equal(malformed.response.status, 400);
  assert.equal(malformed.body.error, 'invalid_image');

  const tooWide = await uploadAsset(
    baseUrl,
    event.slug,
    await imageDataUrl({ width: 1601, height: 10 })
  );
  assert.equal(tooWide.response.status, 400);
  assert.equal(tooWide.body.error, 'invalid_image_dimensions');

  const wrongOwner = await uploadAsset(baseUrl, event.slug, await imageDataUrl(), 'browser');
  assert.equal(wrongOwner.response.status, 400);
  assert.equal(wrongOwner.body.error, 'invalid_owner');
  assert.equal(storage.uploads, 0);
  assert.equal(storage.objects.size, 0);
});

test('five immutable revisions reuse one asset and store no image bytes or signed URLs in Postgres', async (t) => {
  const { baseUrl, query, storage } = await setupStorageTest(t);
  const event = await createEvent(baseUrl);
  const uploaded = await uploadAsset(baseUrl, event.slug, await imageDataUrl());
  assert.equal(uploaded.response.status, 201);

  const configurations = [];
  for (let revision = 0; revision < 5; revision += 1) {
    const saved = await savePhotoConfiguration(
      baseUrl,
      event.slug,
      uploaded.body.assetId,
      `${uploaded.body.previewUrl}&revision=${revision}`
    );
    assert.equal(saved.status, 201);
    configurations.push(await saved.json());
  }

  assert.equal(storage.uploads, 1);
  assert.equal((await query('SELECT count(*)::integer AS count FROM design_assets')).rows[0].count, 1);
  assert.equal((await query('SELECT count(*)::integer AS count FROM configuration_assets')).rows[0].count, 5);
  const stored = await query('SELECT design_json::text AS design FROM configurations ORDER BY created_at');
  assert.equal(stored.rowCount, 5);
  for (const row of stored.rows) {
    assert.match(row.design, new RegExp(uploaded.body.assetId));
    assert.doesNotMatch(row.design, /data:image\//);
    assert.doesNotMatch(row.design, /storage\.test|token=/);
  }

  const latest = configurations.at(-1);
  const editableResponse = await fetch(
    `${baseUrl}/api/events/${event.slug}/configurations/${latest.id}/edit`
  );
  assert.equal(editableResponse.status, 200);
  assert.equal(editableResponse.headers.get('cache-control'), 'no-store');
  const editable = await editableResponse.json();
  assert.equal(editable.designs.default[0].assetId, uploaded.body.assetId);
  assert.match(editable.designs.default[0].src, /^https:\/\/storage\.test\//);

  const printResponse = await fetch(baseUrl + latest.printFileUrl);
  assert.equal(printResponse.status, 200);
  assert.equal(printResponse.headers.get('cache-control'), 'private, no-store');
  const svg = await printResponse.text();
  assert.match(svg, /data-photo="true"/);
  assert.match(svg, /href="data:image\/jpeg;base64,/);
  assert.doesNotMatch(svg, /storage\.test|token=/);
});

test('foreign, non-active and event-wordcloud asset references are rejected', async (t) => {
  const { baseUrl, query } = await setupStorageTest(t);
  const eventA = await createEvent(baseUrl, { coupleName: 'Asset A' });
  const eventB = await createEvent(baseUrl, { coupleName: 'Asset B' });
  const uploaded = await uploadAsset(baseUrl, eventA.slug, await imageDataUrl());
  assert.equal(uploaded.response.status, 201);

  const foreign = await savePhotoConfiguration(baseUrl, eventB.slug, uploaded.body.assetId);
  assert.equal(foreign.status, 400);
  assert.equal((await foreign.json()).error, 'invalid_design');

  const eventWordcloud = await fetch(`${baseUrl}/api/events/${eventA.slug}/configurations`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      ...photoPayload(uploaded.body.assetId),
      configurationType: 'event_wordcloud',
      words: [['liebe', 1]],
    }),
  });
  assert.equal(eventWordcloud.status, 400);
  assert.equal((await eventWordcloud.json()).error, 'invalid_design');

  for (const status of ['uploading', 'deleting', 'delete_failed']) {
    await query('UPDATE design_assets SET storage_status = $1 WHERE id = $2', [status, uploaded.body.assetId]);
    const unavailable = await savePhotoConfiguration(baseUrl, eventA.slug, uploaded.body.assetId);
    assert.equal(unavailable.status, 400, `${status} assets must not be referenceable`);
    assert.equal((await unavailable.json()).error, 'invalid_design');
  }
});

test('configuration limits count unique assets and enforce the combined six-MiB budget', async (t) => {
  const { baseUrl, query } = await setupStorageTest(t);
  const event = await createEvent(baseUrl);
  const eventRow = (await query('SELECT id FROM events WHERE slug = $1', [event.slug])).rows[0];
  const assetIds = [];
  for (let index = 0; index < 7; index += 1) {
    const id = `${'a'.repeat(22)}${String(index).padStart(2, '0')}`;
    assetIds.push(id);
    await query(`
      INSERT INTO design_assets (
        id, event_id, uploader_owner_id, object_key, mime_type, byte_size,
        sha256, storage_status, expires_at
      ) VALUES ($1, $2, $3, $4, 'image/jpeg', $5, $6, 'active', now() + interval '30 days')
    `, [
      id,
      eventRow.id,
      OWNER,
      `photos/${eventRow.id}/limit-${index}.jpg`,
      1100000,
      crypto.createHash('sha256').update(`asset-${index}`).digest('hex'),
    ]);
  }

  const designFor = (ids) => ({
    configurationType: 'personal_memory',
    productKey: 'white-glossy-mug-duo-11oz',
    quantity: 1,
    theme: 'pastel',
    designs: {
      default: ids.map((assetId, index) => ({
        id: `foto-${index}`,
        type: 'image',
        assetId,
        x: 1350,
        y: 525,
        width: 100,
        height: 100,
        angle: 0,
      })),
    },
  });

  const seven = await fetch(`${baseUrl}/api/events/${event.slug}/configurations`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(designFor(assetIds)),
  });
  assert.equal(seven.status, 400, 'seven unique photos exceed the count boundary');

  const sixOverBudget = await fetch(`${baseUrl}/api/events/${event.slug}/configurations`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(designFor(assetIds.slice(0, 6))),
  });
  assert.equal(sixOverBudget.status, 400, 'six assets totaling more than six MiB exceed the byte boundary');

  await query('UPDATE design_assets SET byte_size = 1000 WHERE id = ANY($1::text[])', [assetIds.slice(0, 6)]);
  const sixValid = await fetch(`${baseUrl}/api/events/${event.slug}/configurations`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(designFor(assetIds.slice(0, 6))),
  });
  assert.equal(sixValid.status, 201);
});

test('deletion removes Storage first and retains a retryable key after failure', async (t) => {
  const { baseUrl, query, storage } = await setupStorageTest(t);
  const event = await createEvent(baseUrl);
  const uploaded = await uploadAsset(baseUrl, event.slug, await imageDataUrl());
  const assetId = uploaded.body.assetId;
  const designAssets = require('../src/designAssets');
  await query("UPDATE design_assets SET expires_at = now() - interval '1 minute' WHERE id = $1", [assetId]);

  storage.failRemove = true;
  const failed = await designAssets.deleteExpiredAsset(assetId);
  assert.deepEqual(failed, { deleted: false, retryable: true });
  let row = (await query('SELECT * FROM design_assets WHERE id = $1', [assetId])).rows[0];
  assert.equal(row.storage_status, 'delete_failed');
  assert.equal(row.deletion_attempts, 1);
  assert.equal(row.last_delete_error, 'storage_delete_failed');
  assert.ok(storage.objects.has(row.object_key), 'failed deletion preserves the private object and retry key');

  storage.failRemove = false;
  const retried = await designAssets.deleteExpiredAsset(assetId);
  assert.deepEqual(retried, { deleted: true });
  assert.equal((await query('SELECT * FROM design_assets WHERE id = $1', [assetId])).rowCount, 0);
  assert.equal(storage.objects.size, 0);

  const referenced = await uploadAsset(baseUrl, event.slug, await imageDataUrl({ color: '#21766b' }));
  const saved = await savePhotoConfiguration(baseUrl, event.slug, referenced.body.assetId);
  assert.equal(saved.status, 201);
  await query("UPDATE design_assets SET expires_at = now() - interval '1 minute' WHERE id = $1", [referenced.body.assetId]);
  assert.deepEqual(await designAssets.deleteExpiredAsset(referenced.body.assetId), { deleted: false });
  row = (await query('SELECT * FROM design_assets WHERE id = $1', [referenced.body.assetId])).rows[0];
  assert.equal(row.storage_status, 'active');
});

test('failed uploads remain discoverable for later object cleanup', async (t) => {
  const { baseUrl, query, storage } = await setupStorageTest(t);
  const event = await createEvent(baseUrl);
  storage.failUpload = true;
  const failed = await uploadAsset(baseUrl, event.slug, await imageDataUrl());
  assert.equal(failed.response.status, 503);
  assert.equal(failed.body.error, 'storage_unavailable');
  const rows = await query('SELECT * FROM design_assets');
  assert.equal(rows.rowCount, 1);
  assert.equal(rows.rows[0].storage_status, 'delete_failed');
  assert.equal(rows.rows[0].last_delete_error, 'storage_upload_failed');
  assert.match(rows.rows[0].object_key, /^photos\//);
});
