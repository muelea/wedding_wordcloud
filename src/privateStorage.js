'use strict';

const { createClient } = require('@supabase/supabase-js');

const DEFAULT_BUCKET = 'wolkenworte-private';
const STORAGE_TIMEOUT_MS = 3_500;
const STORAGE_LIST_PAGE_SIZE = 100;
const STORAGE_DELETE_BATCH_SIZE = 100;

let client = null;
let clientSignature = '';
let testAdapter = null;

function bucketName() {
  return String(process.env.SUPABASE_STORAGE_BUCKET || DEFAULT_BUCKET).trim();
}

function storageClient() {
  const url = String(process.env.SUPABASE_URL || '').trim();
  const secret = String(process.env.SUPABASE_SECRET_KEY || '').trim();
  if (!url || !secret) {
    const error = new Error('Private Storage ist nicht konfiguriert.');
    error.code = 'storage_unconfigured';
    throw error;
  }
  const signature = `${url}\0${secret}`;
  if (!client || clientSignature !== signature) {
    const boundedFetch = (input, init = {}) => {
      const timeoutSignal = AbortSignal.timeout(STORAGE_TIMEOUT_MS);
      const signal = init.signal
        ? AbortSignal.any([init.signal, timeoutSignal])
        : timeoutSignal;
      return fetch(input, { ...init, signal });
    };
    client = createClient(url, secret, {
      auth: { autoRefreshToken: false, persistSession: false, detectSessionInUrl: false },
      global: {
        headers: { 'X-Client-Info': 'wolkenworte-server' },
        fetch: boundedFetch,
      },
    });
    clientSignature = signature;
  }
  return client.storage.from(bucketName());
}

function activeAdapter() {
  if (testAdapter) return testAdapter;
  return {
    async upload(objectKey, bytes, mimeType) {
      const { error } = await storageClient().upload(objectKey, bytes, {
        contentType: mimeType,
        cacheControl: '31536000',
        upsert: false,
      });
      if (error) throw error;
    },
    async download(objectKey) {
      const { data, error } = await storageClient().download(objectKey);
      if (error || !data) throw error || new Error('Storage-Objekt fehlt.');
      return Buffer.from(await data.arrayBuffer());
    },
    async remove(objectKey) {
      const { error } = await storageClient().remove([objectKey]);
      if (error) throw error;
    },
    async listPage(prefix, { limit, offset }) {
      const { data, error } = await storageClient().list(prefix, {
        limit,
        offset,
        sortBy: { column: 'name', order: 'asc' },
      });
      if (error) throw error;
      return data || [];
    },
    async removeMany(objectKeys) {
      const { error } = await storageClient().remove(objectKeys);
      if (error) throw error;
    },
  };
}

function upload(...args) {
  return activeAdapter().upload(...args);
}

function download(...args) {
  return activeAdapter().download(...args);
}

function remove(...args) {
  return activeAdapter().remove(...args);
}

async function listAllObjectKeys() {
  const adapter = activeAdapter();
  if (typeof adapter.listAllObjectKeys === 'function') {
    const keys = await adapter.listAllObjectKeys();
    return [...new Set((keys || []).map(String).filter(Boolean))].sort();
  }
  if (typeof adapter.listPage !== 'function') {
    throw new Error('Storage-Adapter unterstützt keine Objektauflistung.');
  }
  const objects = [];
  const prefixes = [''];
  const visitedPrefixes = new Set();
  while (prefixes.length) {
    const prefix = prefixes.shift();
    if (visitedPrefixes.has(prefix)) continue;
    visitedPrefixes.add(prefix);
    for (let offset = 0; ; offset += STORAGE_LIST_PAGE_SIZE) {
      const entries = await adapter.listPage(prefix, {
        limit: STORAGE_LIST_PAGE_SIZE,
        offset,
      });
      for (const entry of entries) {
        const name = String(entry?.name || '');
        if (!name) continue;
        const key = prefix ? `${prefix}/${name}` : name;
        if (entry.id == null && !entry.metadata) prefixes.push(key);
        else objects.push(key);
      }
      if (entries.length < STORAGE_LIST_PAGE_SIZE) break;
    }
  }
  return [...new Set(objects)].sort();
}

async function removeMany(objectKeys) {
  const keys = [...new Set((objectKeys || []).map(String).filter(Boolean))];
  const adapter = activeAdapter();
  for (let offset = 0; offset < keys.length; offset += STORAGE_DELETE_BATCH_SIZE) {
    const batch = keys.slice(offset, offset + STORAGE_DELETE_BATCH_SIZE);
    if (typeof adapter.removeMany === 'function') await adapter.removeMany(batch);
    else for (const objectKey of batch) await adapter.remove(objectKey);
  }
  return keys.length;
}

function setAdapterForTests(adapter) {
  if (process.env.NODE_ENV !== 'test') throw new Error('Storage adapter overrides are test-only.');
  testAdapter = adapter;
}

function resetAdapterForTests() {
  testAdapter = null;
}

module.exports = {
  DEFAULT_BUCKET,
  STORAGE_TIMEOUT_MS,
  STORAGE_LIST_PAGE_SIZE,
  STORAGE_DELETE_BATCH_SIZE,
  bucketName,
  upload,
  download,
  remove,
  listAllObjectKeys,
  removeMany,
  setAdapterForTests,
  resetAdapterForTests,
};
