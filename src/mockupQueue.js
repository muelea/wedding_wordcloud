'use strict';

const crypto = require('node:crypto');
const db = require('./db');
const storage = require('./privateStorage');
const printful = require('./printful');
const log = require('./structuredLog');

const CACHE_MS = 12 * 60 * 60 * 1000;
const SOURCE_MS = 60 * 60 * 1000;
const STALE_MS = 10 * 60 * 1000;
const DEADLINE_MS = 30 * 60 * 1000;
const LEASE_MS = 180_000;
const MAX_ATTEMPTS = 2;
const ACTIVE = new Set(['queued', 'preparing', 'submitting', 'pending', 'retrying']);

function providerScope() {
  return crypto.createHash('sha256').update(JSON.stringify([
    process.env.PRINTFUL_API_KEY || '', process.env.PRINTFUL_STORE_ID || '',
  ])).digest('hex');
}

function create({ parseConfiguration, compatibleStyle, normalizedMockups, trustedMockupUrl,
  shouldFallbackToStandardResolution, PrintfulMockupError, isOperatorEnabled,
  repository = db, storageClient = storage, printfulClient = printful,
  renderPng = (...args) => require('./printArtifacts').renderPreviewSurface(...args),
  fetchImpl = (...args) => fetch(...args), now = () => Date.now(), customer = false,
  scope = providerScope, autoStart = process.env.NODE_ENV !== 'test',
  operatorEnabled = isOperatorEnabled,
} = {}) {
  let timer = null, running = null, stopping = false, lastPrune = -Infinity;
  const scopeKey = () => typeof scope === 'function' ? scope() : scope;
  const error = (code, status = 503) => new PrintfulMockupError(code,
    'Die Produktvorschau ist gerade nicht verfügbar. Bitte versucht es erneut.', status);
  const configured = () => printfulClient !== printful || printful.isConfigured();

  function summary(job) {
    return { jobId: job.id, status: job.status, mockupWidthPx: job.mockupWidthPx,
      resolutionFallback: job.resolutionFallback, expiresAt: job.expiresAt,
      nextAttemptAt: job.nextAt, retryAfter: Math.max(0, Math.ceil((job.nextAt - now()) / 1000)),
      attempt: job.attempt, errorCode: job.errorCode || null,
      mockups: job.mockups || [], failureReasons: job.failureReasons || [],
      ...(job.mode === 'operator' ? { diagnostics: { taskIds: job.taskIds,
        taskStatuses: job.lastTaskStatuses || [], lastProviderStatus: job.lastProviderStatus || null,
        sourceExpiresAt: job.sourceExpiresAt, history: job.history || [] } } : {}),
    };
  }

  async function createForConfiguration(configuration, options = {}) {
    if (!configured()) throw error('mockup_unavailable', 501);
    const { product, design } = parseConfiguration(configuration);
    const mode = (options.customer ?? customer) ? 'customer' : 'operator';
    const key = crypto.createHash('sha256').update(JSON.stringify([
      'png-v2', configuration.event_id, configuration.id, mode, product.key,
      product.printful, product.orientation, design,
    ])).digest('hex');
    const createdAt = now();
    const candidate = { id: crypto.randomBytes(18).toString('base64url'),
      scope: scopeKey(), mode, cacheKey: key, configurationId: configuration.id,
      eventId: configuration.event_id, productKey: product.key, status: 'queued',
      createdAt, expiresAt: createdAt + CACHE_MS, deadlineAt: createdAt + DEADLINE_MS,
      nextAt: createdAt, attempt: 0, failures: 0, missingReads: 0, taskIds: [],
      history: [],
      sourceObjectKeys: [], abandonedSourceKeys: [], sourceExpiresAt: 0, mockups: [],
      mockupWidthPx: mode === 'customer' ? 1000 : 2000, resolutionFallback: false,
    };
    candidate.requestId = /^[A-Za-z0-9_-]{24}$/.test(options.requestId || '') ? options.requestId : candidate.id;
    const job = await repository.enqueueMockupJob(candidate, options);
    if (!job) throw Object.assign(error('mockup_queue_full', 429), { retryAfter: 60 });
    kick();
    return { ...summary(job), cached: job.id !== candidate.id };
  }

  async function getJob(id, configuration = null) {
    const job = /^[A-Za-z0-9_-]{24}$/.test(String(id)) ? await repository.getMockupJob(id) : null;
    if (!job || job.scope !== scopeKey() || job.expiresAt <= now() ||
      (configuration && (job.mode !== 'customer' || job.configurationId !== configuration.id || String(job.eventId) !== String(configuration.event_id))) ||
      (customer && !configuration)) throw error('mockup_job_not_found', 404);
    kick();
    return summary(job);
  }

  async function execute(job, lease) {
    function record(phase, statusCode = null) {
      job.history = [...(job.history || []), { at: now(), phase, statusCode,
        attempt: job.attempt, taskIds: [...job.taskIds] }].slice(-16);
    }
    let leaseLost = false;
    const heartbeat = setInterval(() => {
      void repository.renewMockupLease(job.scope, job.id, lease, now(), LEASE_MS)
        .then(ok => { if (!ok) leaseLost = true; }).catch(() => { leaseLost = true; });
    }, 30_000);
    heartbeat.unref?.();
    async function save() {
      if (leaseLost || !await repository.saveMockupJob(job, lease, now())) {
        throw Object.assign(new Error('Mockup lease lost'), { code: 'MOCKUP_LEASE_LOST' });
      }
    }
    async function cleanup() {
      const remaining = [];
      for (const key of job.sourceObjectKeys) {
        const expiry = Number(key.split('/')[1]?.split('-')[0]) * 1000;
        if ((job.abandonedSourceKeys || []).includes(key) && expiry > now()) { remaining.push(key); continue; }
        // Check ownership before destructive Storage operations as well.
        await save();
        try { await storageClient.remove(key); } catch { remaining.push(key); }
      }
      job.sourceObjectKeys = remaining;
      job.nextAt = remaining.length ? now() + 60_000 : job.expiresAt;
      await save();
    }
    async function finish(code, reasons = []) {
      job.status = code ? 'failed' : 'completed';
      job.errorCode = code;
      job.failureReasons = reasons;
      record(job.status, job.lastProviderStatus);
      job.nextAt = now();
      await save();
      log.info('mockup_job_finished', { jobId: job.id, outcome: job.status,
        errorCode: code, attempt: job.attempt });
      await cleanup();
    }
    async function replace(code) {
      record(code, job.lastProviderStatus);
      job.abandonedSourceKeys = [...job.sourceObjectKeys];
      if (job.attempt >= MAX_ATTEMPTS) return finish(code);
      // Old sources remain valid until their own expiry in case Printful is
      // still using them. The timestamped sweep also handles process crashes.
      job.taskIds = [];
      job.status = 'retrying';
      job.errorCode = code;
      job.nextAt = Math.min(job.deadlineAt, now() + 30_500);
      job.failures = 0;
      job.missingReads = 0;
      await save();
    }
    async function responseLimits(info, kind) {
      job.lastProviderStatus = info.status;
      if (info.remaining != null && info.remaining < 1 && info.reset > 0) {
        // Quota bookkeeping must not discard a received provider task ID.
        try { await repository.deferMockupRequests(job.scope, lease, now() + info.reset * 1000, kind); }
        catch { log.warn('mockup_quota_update_failed', { jobId: job.id }); }
      }
    }
    let stage = 'prepare';
    try {
      if (!ACTIVE.has(job.status)) return await cleanup();
      if (job.deadlineAt <= now()) {
        job.abandonedSourceKeys = [...job.sourceObjectKeys];
        return await finish('mockup_timeout');
      }
      const configuration = await repository.getMockupConfiguration(job.configurationId, now());
      if (!configuration || String(configuration.event_id) !== String(job.eventId)) return await finish('mockup_configuration_invalid');
      const { product, surfaces } = parseConfiguration(configuration);
      if (job.taskIds.length) {
        stage = 'poll';
        const due = await repository.reserveMockupRequest(job.scope, lease, now(), 'read');
        if (due > now()) { job.nextAt = Math.min(due, job.deadlineAt); return await save(); }
        const tasks = await printfulClient.getMockupTasks(job.taskIds,
          { onRateLimit: info => responseLimits(info, 'read') });
        const matching = tasks.filter(task => job.taskIds.includes(Number(task.id)));
        job.lastTaskStatuses = matching.map(task => ({ id: Number(task.id), status: String(task.status).toLowerCase() }));
        const exact = matching.length === job.taskIds.length && new Set(matching.map(task => Number(task.id))).size === job.taskIds.length &&
          matching.every(task => ['pending','completed','failed'].includes(String(task.status).toLowerCase()));
        const failureReasons = matching.flatMap(task => task.failure_reasons || [])
          .map(reason => String(reason.detail || reason.title || '').replace(/https?:\/\/\S+/g, '[URL]').slice(0, 240)).slice(0, 4);
        const statuses = matching.map(task => String(task.status).toLowerCase());
        job.failures = 0;
        job.missingReads = exact ? 0 : job.missingReads + 1;
        if (exact && statuses.every(status => status === 'completed')) {
          const mockups = normalizedMockups(matching).filter(item => item.variantId === product.printful.variantId);
          if (!mockups.length || surfaces.some(surface => !mockups.some(item => item.placement === surface.placement))) {
            return await finish('mockup_empty_result', failureReasons);
          }
          job.mockups = mockups;
          return await finish(null);
        }
        if (statuses.includes('failed')) return await finish('mockup_provider_failed', failureReasons);
        if (job.missingReads >= 3 || now() - job.submittedAt >= STALE_MS || now() >= job.sourceExpiresAt - 60_000) {
          return await replace('mockup_stalled');
        }
        job.status = 'pending';
        job.errorCode = null;
        job.nextAt = now() + 4_000;
        await save();
        return;
      }
      if (job.status === 'submitting') {
        // A process died after dispatch. Printful has no documented create
        // idempotency key or lookup by our ID: never pretend this was rejected.
        return await replace('mockup_submission_unknown');
      }
      const due = await repository.reserveMockupRequest(job.scope, lease, now(), 'create');
      if (due > now()) {
        if (due >= job.deadlineAt) return await finish(due - now() > 3600_000 ? 'mockup_daily_limit' : 'mockup_timeout');
        job.status = 'queued'; job.nextAt = due; return await save();
      }
      job.status = 'preparing';
      job.errorCode = null;
      await save();
      const placements = surfaces.map(item => item.placement);
      const rows = await printfulClient.getCatalogProductMockupStyles(product.printful.productId, placements,
        { onRateLimit: info => responseLimits(info, 'read') });
      const styles = new Map(placements.map(placement => [placement, compatibleStyle(rows, product, placement)]));
      const uploaded = [];
      // URLs are minted at dispatch, never while waiting in the queue. Object
      // keys are journaled before upload, including ambiguous Storage writes.
      job.sourceExpiresAt = now() + SOURCE_MS;
      for (const entry of surfaces) {
        const key = `${job.mode === 'customer' ? 'customer' : 'operator'}-mockup-sources/` +
          `${Math.floor(job.sourceExpiresAt / 1000)}-${crypto.randomBytes(18).toString('base64url')}.png`;
        job.sourceObjectKeys.push(key);
        await save();
        const bytes = await renderPng(product, entry.design);
        await storageClient.upload(key, bytes, 'image/png');
        const url = new URL(await storageClient.createSignedUrl(key, SOURCE_MS / 1000));
        if (url.protocol !== 'https:') throw error('mockup_source_unavailable');
        uploaded.push({ ...entry, url: url.toString() });
      }
      const payload = { format: 'png', mockup_width_px: job.mockupWidthPx, products: [{
        source: 'catalog', catalog_product_id: product.printful.productId,
        catalog_variant_ids: [product.printful.variantId], mockup_style_ids: [...new Set([...styles.values()].map(item => item.id))],
        ...(product.orientation === 'portrait' ? { orientation: 'vertical' } :
          product.orientation === 'landscape' ? { orientation: 'horizontal' } : {}),
        placements: uploaded.map(entry => ({ placement: entry.placement, technique: product.printful.technique,
          print_area_type: styles.get(entry.placement).printAreaType, layers: [{ type: 'file', url: entry.url }] })),
        ...(product.printful.options.length ? { product_options: product.printful.options.map(item => ({ name: item.id, value: item.value })) } : {}),
      }] };
      if (now() >= job.deadlineAt) return await finish('mockup_timeout');
      // Reserve from the actual dispatch time; rendering itself can be slow.
      await repository.deferMockupRequests(job.scope, lease, now() + 30_500, 'create');
      job.status = 'submitting';
      job.attempt++;
      job.submittedAt = now();
      await save();
      stage = 'submit';
      const tasks = await printfulClient.createMockupTasks(payload,
        { onRateLimit: info => responseLimits(info, 'create') });
      if (!Array.isArray(tasks) || !tasks.length || tasks.some(item => !Number.isSafeInteger(Number(item.id)) || Number(item.id) <= 0)) {
        throw error('mockup_submission_unknown');
      }
      job.taskIds = tasks.map(task => Number(task.id));
      job.status = 'pending';
      record('accepted', job.lastProviderStatus || 200);
      job.failures = 0;
      job.nextAt = now();
      await save();
      for (const id of job.taskIds) log.info('mockup_provider_accepted', {
        jobId: job.id, providerTaskId: String(id), attempt: job.attempt, statusCode: job.lastProviderStatus || 200,
      });
    } catch (caught) {
      if (caught.code === 'MOCKUP_LEASE_LOST') return;
      if (stage === 'submit' && job.taskIds.length) {
        job.status = 'pending'; job.nextAt = now() + 1000;
        await save();
        return;
      }
      job.failures++;
      const status = caught.providerStatus || caught.status;
      job.lastProviderStatus = status || null;
      record(stage, status);
      const message = String(caught.message || '');
      const daily = status === 429 && (/daily|24.hour|20[,.]?000|per day/i.test(message) || Number(caught.retryAfter) > 3600);
      const waitSeconds = Math.max(1, Number(caught.retryAfter) || Number(caught.rateLimitReset) || (status === 429 ? 60 : 2 ** job.failures));
      if (status === 429) {
        await repository.deferMockupRequests(job.scope, lease, now() + (daily ? Math.max(waitSeconds, 86400) : waitSeconds) * 1000,
          stage === 'poll' ? 'read' : 'create');
        if (stage === 'submit') job.attempt--; // The provider explicitly rejected this dispatch.
        if (job.mockupWidthPx === 2000 && shouldFallbackToStandardResolution(caught)) {
          job.mockupWidthPx = 1000;
          job.resolutionFallback = true;
        }
      }
      const permanent = daily || [400, 401, 403, 404, 422, 501].includes(status) ||
        caught.code === 'PRINT_FILE_TOO_LARGE' || caught.code === 'mockup_configuration_invalid' || caught.code === 'mockup_style_unavailable';
      if (stage === 'submit' && status !== 429 && !permanent) return await replace('mockup_submission_unknown');
      // A status outage does not reject an already accepted generation. Keep
      // that exact task until the overall deadline instead of submitting again.
      if (permanent || (stage !== 'poll' && job.failures >= 6)) {
        return await finish(daily ? 'mockup_daily_limit' : stage === 'submit' && !caught.providerStatus
          ? 'mockup_submission_unknown' : 'mockup_provider_unavailable');
      }
      job.status = job.taskIds.length ? 'pending' : 'retrying';
      job.errorCode = status === 429 ? 'mockup_rate_limited' : 'mockup_retrying';
      const delay = status === 429 ? Math.min(3600, waitSeconds) : Math.min(60, waitSeconds);
      job.nextAt = Math.min(job.deadlineAt, now() + delay * 1000 + 250);
      await save();
      log.warn('mockup_job_retrying', { jobId: job.id, attempt: job.attempt,
        statusCode: status, errorCode: job.errorCode });
    } finally { clearInterval(heartbeat); }
  }

  async function drain({ maxJobs = 1, deadline = Infinity } = {}) {
    if (stopping || !configured()) return;
    if (now() - lastPrune >= 60_000) { await repository.pruneMockupJobs(now()); lastPrune = now(); }
    let claimed = 0;
    for (let index = 0; index < maxJobs && now() + 1000 < deadline && !stopping; index++) {
      const lease = crypto.randomUUID(), scope = scopeKey();
      const job = await repository.claimMockupJob({ scope, lease, now: now(), leaseMs: LEASE_MS, operator: operatorEnabled() });
      if (!job) break;
      claimed++;
      try { await execute(job, lease); }
      finally { await repository.releaseMockupLease(scope, job.id, lease); }
    }
    return claimed;
  }
  function runDue(options) {
    if (running) return running;
    running = drain(options).finally(() => { running = null; });
    return running;
  }
  function kick() {
    if (!autoStart || stopping || timer || !configured()) return;
    timer = setTimeout(() => {
      timer = null;
      void runDue().catch(caught => { log.error('mockup_worker_failed', { errorCode: log.errorCode(caught) }); return 0; })
        .then(count => { if (!stopping) timer = setTimeout(() => { timer = null; kick(); }, count ? 1000 : 5000); timer?.unref?.(); });
    }, 0);
    timer.unref?.();
  }
  function start() { stopping = false; kick(); }
  async function stop() { stopping = true; clearTimeout(timer); timer = null; await running; }

  async function download(id, index) {
    const job = await repository.getMockupJob(id);
    const result = await getJob(id);
    const item = result.mockups[Number(index)];
    if (result.status !== 'completed' || !Number.isSafeInteger(Number(index)) || Number(index) < 0 || !item || !trustedMockupUrl(item.url)) {
      throw error('mockup_file_not_found', 404);
    }
    const response = await fetchImpl(item.url, { signal: AbortSignal.timeout(20000) });
    const contentType = String(response.headers?.get?.('content-type') || '').split(';')[0].toLowerCase();
    if (!response.ok || !['image/png', 'image/jpeg'].includes(contentType)) throw error('mockup_download_failed', 502);
    const bytes = Buffer.from(await response.arrayBuffer());
    if (!bytes.length || bytes.length > 20 * 1024 * 1024) throw error('mockup_download_failed', 502);
    const safe = value => String(value || 'view').replace(/[^a-z0-9_-]+/gi, '-');
    return { bytes, contentType, filename: `wolkenworte-${safe(job.productKey)}-${safe(item.placement)}-${item.styleId}.${contentType === 'image/png' ? 'png' : 'jpg'}` };
  }
  return { createForConfiguration, getJob, download, runDue, start, stop };
}

module.exports = { create, CACHE_MS, SOURCE_MS, STALE_MS, DEADLINE_MS, LEASE_MS, MAX_ATTEMPTS };
