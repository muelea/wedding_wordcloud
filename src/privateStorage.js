'use strict';

const { createClient } = require('@supabase/supabase-js');

const DEFAULT_BUCKET = 'wolkenworte-private';
const SIGNED_PREVIEW_TTL_SECONDS = 15 * 60;

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
    client = createClient(url, secret, {
      auth: { autoRefreshToken: false, persistSession: false, detectSessionInUrl: false },
      global: { headers: { 'X-Client-Info': 'wolkenworte-server' } },
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
    async createSignedUrl(objectKey, expiresIn = SIGNED_PREVIEW_TTL_SECONDS) {
      const { data, error } = await storageClient().createSignedUrl(objectKey, expiresIn);
      if (error || !data?.signedUrl) throw error || new Error('Signed URL fehlt.');
      return data.signedUrl;
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
  };
}

function upload(...args) {
  return activeAdapter().upload(...args);
}

function createSignedUrl(...args) {
  return activeAdapter().createSignedUrl(...args);
}

function download(...args) {
  return activeAdapter().download(...args);
}

function remove(...args) {
  return activeAdapter().remove(...args);
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
  SIGNED_PREVIEW_TTL_SECONDS,
  bucketName,
  upload,
  createSignedUrl,
  download,
  remove,
  setAdapterForTests,
  resetAdapterForTests,
};
