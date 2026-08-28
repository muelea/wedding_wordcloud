'use strict';

const { Resend } = require('resend');
const performanceProbe = require('./performanceProbe');

let client = null;
let clientKey = null;
let testAdapter = null;

class ResendDeliveryError extends Error {
  constructor(code, { ambiguous = false, retryable = false, statusCode = null } = {}) {
    super(code);
    this.name = 'ResendDeliveryError';
    this.code = code;
    this.ambiguous = ambiguous;
    this.retryable = retryable;
    this.statusCode = statusCode;
  }
}

function isConfigured() {
  return Boolean(String(process.env.RESEND_API_KEY || '').trim() && String(process.env.RESEND_FROM_EMAIL || '').trim());
}

function getClient() {
  const key = String(process.env.RESEND_API_KEY || '').trim();
  if (!key) return null;
  if (!client || clientKey !== key) {
    client = new Resend(key);
    clientKey = key;
  }
  return client;
}

function sanitizedProviderCode(error) {
  const source = error?.name || error?.code || 'provider_rejected';
  return `resend_${String(source).toLowerCase().replace(/[^a-z0-9_:-]/g, '_').slice(0, 100)}`;
}

function classifyProviderError(error) {
  const statusCode = Number.isInteger(error?.statusCode) ? error.statusCode : null;
  const code = sanitizedProviderCode(error);
  if (statusCode == null) {
    return new ResendDeliveryError('resend_delivery_outcome_unknown', {
      ambiguous: true, retryable: true, statusCode,
    });
  }
  if (statusCode === 409 && error?.name === 'invalid_idempotent_request') {
    return new ResendDeliveryError('resend_idempotency_payload_mismatch', { statusCode });
  }
  if (statusCode === 408 || statusCode === 409 || statusCode === 429 || statusCode >= 500) {
    return new ResendDeliveryError(code, { retryable: true, statusCode });
  }
  return new ResendDeliveryError(code, { statusCode });
}

async function sendEmail(job, { timeoutMs = 10_000 } = {}) {
  const from = String(process.env.RESEND_FROM_EMAIL || '').trim();
  if (!isConfigured() || !job?.recipient_email) {
    throw new ResendDeliveryError('resend_not_configured');
  }
  const payload = {
    from,
    to: [job.recipient_email],
    subject: job.subject,
    html: job.html_body,
    text: job.text_body,
    tags: [
      { name: 'email_job_id', value: String(job.id) },
      { name: 'kind', value: String(job.kind) },
    ],
  };
  const requestOptions = {
    idempotencyKey: String(job.dedupe_key),
    signal: AbortSignal.timeout(Math.max(1_000, Math.min(15_000, Number(timeoutMs) || 10_000))),
  };
  let result;
  const startedAt = Date.now();
  try {
    result = testAdapter
      ? await testAdapter.send(payload, requestOptions)
      : await getClient().emails.send(payload, requestOptions);
  } catch (error) {
    performanceProbe.recordExternalCall('resend', {
      durationMs: Date.now() - startedAt, succeeded: false,
    });
    throw new ResendDeliveryError('resend_delivery_outcome_unknown', {
      ambiguous: true, retryable: true, statusCode: null,
    });
  }
  if (result?.error) {
    performanceProbe.recordExternalCall('resend', {
      durationMs: Date.now() - startedAt, succeeded: false,
    });
    throw classifyProviderError(result.error);
  }
  const messageId = String(result?.data?.id || result?.id || '').trim();
  if (!messageId || messageId.length > 200) {
    performanceProbe.recordExternalCall('resend', {
      durationMs: Date.now() - startedAt, succeeded: false,
    });
    throw new ResendDeliveryError('resend_invalid_response', {
      ambiguous: true, retryable: true, statusCode: null,
    });
  }
  performanceProbe.recordExternalCall('resend', {
    durationMs: Date.now() - startedAt, succeeded: true,
  });
  return { messageId };
}

function verifyWebhook(rawBody, headers) {
  const webhookSecret = String(process.env.RESEND_WEBHOOK_SECRET || '').trim();
  if (!webhookSecret) {
    const error = new Error('RESEND_WEBHOOK_SECRET ist nicht gesetzt.');
    error.code = 'RESEND_WEBHOOK_NOT_CONFIGURED';
    throw error;
  }
  const payload = Buffer.isBuffer(rawBody) ? rawBody.toString('utf8') : String(rawBody || '');
  const normalized = {
    id: String(headers?.id || ''),
    timestamp: String(headers?.timestamp || ''),
    signature: String(headers?.signature || ''),
  };
  if (!normalized.id || !normalized.timestamp || !normalized.signature) {
    const error = new Error('Resend webhook headers are incomplete.');
    error.code = 'RESEND_WEBHOOK_INVALID_SIGNATURE';
    throw error;
  }
  if (testAdapter?.verify) return testAdapter.verify({ payload, headers: normalized, webhookSecret });
  const verifier = getClient() || new Resend('re_webhook_verification_only');
  return verifier.webhooks.verify({ payload, headers: normalized, webhookSecret });
}

async function listWebhooks() {
  const active = getClient();
  if (!active) throw new ResendDeliveryError('resend_not_configured');
  const result = await active.webhooks.list();
  if (result.error) throw classifyProviderError(result.error);
  return Array.isArray(result.data?.data) ? result.data.data : Array.isArray(result.data) ? result.data : [];
}

async function createWebhook(endpoint) {
  const active = getClient();
  if (!active) throw new ResendDeliveryError('resend_not_configured');
  const result = await active.webhooks.create({
    endpoint,
    events: ['email.sent', 'email.delivered', 'email.bounced', 'email.failed', 'email.complained'],
  });
  if (result.error) throw classifyProviderError(result.error);
  return result.data;
}

async function removeWebhook(id) {
  const active = getClient();
  if (!active) throw new ResendDeliveryError('resend_not_configured');
  const result = await active.webhooks.remove(id);
  if (result.error) throw classifyProviderError(result.error);
  return result.data;
}

function setAdapterForTests(adapter) {
  testAdapter = adapter;
}

function resetAdapterForTests() {
  testAdapter = null;
  client = null;
  clientKey = null;
}

function hasTestAdapter() {
  return Boolean(testAdapter);
}

module.exports = {
  ResendDeliveryError,
  isConfigured,
  classifyProviderError,
  sendEmail,
  verifyWebhook,
  listWebhooks,
  createWebhook,
  removeWebhook,
  hasTestAdapter,
  setAdapterForTests,
  resetAdapterForTests,
};
