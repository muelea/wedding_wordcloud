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
  prepareFiles = (...args) => require('./printPreparation').prepare(...args),
  fetchImpl = (...args) => fetch(...args), now = () => Date.now(), customer = false,
  scope = providerScope, autoStart = process.env.NODE_ENV !== 'test',
  operatorEnabled = isOperatorEnabled,
} = {}) {
  let timer = null, timerAt = Infinity, running = null, stopping = false, lastPrune = -Infinity;
  const scopeKey = () => typeof scope === 'function' ? scope() : scope;
  const error = (code, status = 503) => new PrintfulMockupError(code,
    'Die Produktvorschau ist gerade nicht verfügbar. Bitte versucht es erneut.', status);
  const configured = () => printfulClient !== printful || printful.isConfigured();

  function productMockups(job, item, mockups) {
    return item.surfaces.flatMap(entry => {
      const candidates = mockups.filter(value => value.variantId === item.product.printful.variantId &&
        value.placement === entry.placement);
      const styleId = job.styleIds?.[item.configuration.id]?.[entry.placement];
      // A multi-side product can return every requested camera style for every
      // print placement. Keep the camera selected for this exact print side.
      const selected = candidates.find(value => value.styleId === styleId) ||
        (candidates.length === 1 && (!Number.isFinite(candidates[0].styleId) || styleId == null) ? candidates[0] : null);
      return selected ? [{ ...selected, surfaceKey: entry.surface.key }] : [];
    });
  }

  function summary(job) {
    return { jobId: job.id, status: job.status, mockupWidthPx: job.mockupWidthPx,
      resolutionFallback: job.resolutionFallback, expiresAt: job.expiresAt,
      nextAttemptAt: job.nextAt, retryAfter: Math.max(0, Math.ceil((job.nextAt - now()) / 1000)),
      attempt: job.attempt, errorCode: job.errorCode || null,
      mockups: job.mockups || [], failureReasons: job.failureReasons || [],
      ...(job.configurationIds || job.mode === 'customer' ? {
        configurationIds: job.configurationIds || [job.configurationId], items: job.items || [],
      } : {}),
      ...(job.mode === 'operator' ? { diagnostics: { taskIds: job.taskIds,
        taskStatuses: job.lastTaskStatuses || [], lastProviderStatus: job.lastProviderStatus || null,
        sourceExpiresAt: job.sourceExpiresAt, history: job.history || [] } } : {}),
    };
  }

  async function createForConfiguration(configuration, options = {}) {
    if (!configured()) throw error('mockup_unavailable', 501);
    const batch = Array.isArray(configuration);
    const configurations = batch ? configuration : [configuration];
    configuration = configurations[0];
    const parsed = configurations.map(value => ({ configuration: value, ...parseConfiguration(value) }));
    const { product, design } = parsed[0];
    const mode = (options.customer ?? customer) ? 'customer' : 'operator';
    const key = crypto.createHash('sha256').update(JSON.stringify([
      parsed.some(item => item.surfaces.length > 1) ? 'png-v3-side-styles' : 'png-v2',
      configuration.event_id, configuration.id, mode, product.key,
      ...parsed.map(item => [item.configuration.id, item.product.printful, item.product.orientation, item.design]),
    ])).digest('hex');
    const createdAt = now();
    const candidate = { id: crypto.randomBytes(18).toString('base64url'),
      scope: scopeKey(), mode, cacheKey: key, configurationId: configuration.id,
      eventId: configuration.event_id, productKey: product.key, status: 'queued',
      createdAt, expiresAt: createdAt + CACHE_MS, deadlineAt: createdAt + DEADLINE_MS,
      latestStartAt: createdAt + DEADLINE_MS - STALE_MS - 30_500,
      nextAt: createdAt, attempt: 0, failures: 0, missingReads: 0, taskIds: [],
      history: [],
      sourceObjectKeys: [], abandonedSourceKeys: [], sourceExpiresAt: 0, mockups: [],
      mockupWidthPx: mode === 'customer' ? 1000 : 2000, resolutionFallback: false,
      ...(batch ? { configurationIds: configurations.map(item => item.id), items: [] } : {}),
    };
    candidate.requestId = /^[A-Za-z0-9_-]{24}$/.test(options.requestId || '') ? options.requestId : candidate.id;
    const job = await repository.enqueueMockupJob(candidate, options);
    if (!job) {
      kick(); // Backpressure must also wake older durable work after an outage.
      throw Object.assign(error('mockup_queue_full', 429), { retryAfter: 60 });
    }
    if (ACTIVE.has(job.status) || job.sourceObjectKeys?.length) kick();
    return { ...summary(job), cached: job.id !== candidate.id };
  }

  async function createForConfigurations(configurations, options = {}) {
    const groups = [];
    for (const configuration of configurations) {
      let group = groups.find(values => !values.some(value => value.printful_variant_id === configuration.printful_variant_id));
      if (!group) groups.push(group = []);
      group.push(configuration);
    }
    const jobs = [];
    for (const group of groups) jobs.push(await createForConfiguration(group, { ...options, customer: true }));
    return jobs;
  }

  async function getJob(id, configuration = null) {
    const job = /^[A-Za-z0-9_-]{24}$/.test(String(id)) ? await repository.getMockupJob(id) : null;
    if (!job || job.scope !== scopeKey() || job.expiresAt <= now() ||
      (configuration && (job.mode !== 'customer' || (configuration.id && !(job.configurationIds || [job.configurationId]).includes(configuration.id)) || String(job.eventId) !== String(configuration.event_id))) ||
      (customer && !configuration)) throw error('mockup_job_not_found', 404);
    if (ACTIVE.has(job.status) || job.sourceObjectKeys?.length) kick(Math.max(0, job.nextAt - now()));
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
      const configurations = await Promise.all((job.configurationIds || [job.configurationId]).map(id => repository.getMockupConfiguration(id, now())));
      if (configurations.some(value => !value || String(value.event_id) !== String(job.eventId))) return await finish('mockup_configuration_invalid');
      const parsed = configurations.map(value => ({ configuration: value, ...parseConfiguration(value) }));
      const { product, surfaces } = parsed[0];
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
        // Retain completed products even if another task in the batch is pending or fails.
        if (job.mode === 'customer') {
          const completed = normalizedMockups(matching.filter(task => String(task.status).toLowerCase() === 'completed'));
          job.items = parsed.map(item => {
            const mockups = productMockups(job, item, completed);
            return { configurationId: item.configuration.id,
              fileIds: job.items?.find(value => value.configurationId === item.configuration.id)?.fileIds || [],
              mockups: item.surfaces.every(surface => mockups.some(value => value.placement === surface.placement)) ? mockups : [],
            };
          });
        }
        if (exact && statuses.every(status => status === 'completed')) {
          const allMockups = normalizedMockups(matching);
          const items = parsed.map(item => ({ configurationId: item.configuration.id,
            fileIds: job.items?.find(value => value.configurationId === item.configuration.id)?.fileIds || [],
            mockups: productMockups(job, item, allMockups),
          }));
          if (parsed.some((item,index) => !items[index].mockups.length || item.surfaces.some(surface =>
            !items[index].mockups.some(value => value.placement === surface.placement)))) return await finish('mockup_empty_result', failureReasons);
          if (job.configurationIds || job.mode === 'customer') job.items = items;
          job.mockups = items.flatMap(item => item.mockups);
          return await finish(null);
        }
        if (statuses.includes('failed')) {
          if (job.attempt < MAX_ATTEMPTS) return await replace('mockup_provider_failed');
          return await finish('mockup_provider_failed', failureReasons);
        }
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
      const products = [];
      for (const item of parsed) {
        const { product, surfaces } = item;
        const placements = surfaces.map(entry => entry.placement);
        const rows = await printfulClient.getCatalogProductMockupStyles(product.printful.productId, placements,
          { onRateLimit: info => responseLimits(info, 'read') });
        const styles = new Map(placements.map(placement => [placement, compatibleStyle(rows, product, placement)]));
        job.styleIds ||= {};
        job.styleIds[item.configuration.id] = Object.fromEntries([...styles].map(([placement, style]) => [placement, style.id]));
        const uploaded = [];
        job.sourceExpiresAt = now() + SOURCE_MS;
        if (job.mode === 'customer') {
          const files = await prepareFiles(item.configuration, product, item.design, { repository, storageClient, renderPng });
          job.items ||= [];
          const previous = job.items.findIndex(value => value.configurationId === item.configuration.id);
          const prepared = { configurationId: item.configuration.id, fileIds: files.map(file => file.id), mockups: [] };
          if (previous < 0) job.items.push(prepared); else job.items[previous] = prepared;
          await save();
          for (const entry of surfaces) {
            const file = files.find(file => file.surface_key === entry.surface.key);
            const url = await storageClient.createSignedUrl(file.object_key, SOURCE_MS / 1000);
            if (new URL(url).protocol !== 'https:') throw error('mockup_source_unavailable');
            uploaded.push({ ...entry, url });
          }
        } else {
          for (const entry of surfaces) {
            const key = `operator-mockup-sources/${Math.floor(job.sourceExpiresAt / 1000)}-${crypto.randomBytes(18).toString('base64url')}.png`;
            job.sourceObjectKeys.push(key);
            await save();
            const bytes = await renderPng(product, entry.design);
            await storageClient.upload(key, bytes, 'image/png');
            const url = await storageClient.createSignedUrl(key, SOURCE_MS / 1000);
            if (new URL(url).protocol !== 'https:') throw error('mockup_source_unavailable');
            uploaded.push({ ...entry, url });
          }
        }
        products.push({ source: 'catalog', catalog_product_id: product.printful.productId,
          catalog_variant_ids: [product.printful.variantId], mockup_style_ids: [...new Set([...styles.values()].map(value => value.id))],
          ...(product.orientation === 'portrait' ? { orientation: 'vertical' } : product.orientation === 'landscape' ? { orientation: 'horizontal' } : {}),
          placements: uploaded.map(entry => ({ placement: entry.placement, technique: product.printful.technique,
            print_area_type: styles.get(entry.placement).printAreaType, layers: [{ type: 'file', url: entry.url }] })),
          ...(product.printful.options.length ? { product_options: product.printful.options.map(value => ({ name: value.id, value: value.value })) } : {}),
        });
      }
      const payload = { format: 'png', mockup_width_px: job.mockupWidthPx, products };
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
  function kick(delay = 0) {
    if (!autoStart || stopping || !configured()) return;
    const at = now() + delay;
    if (timer && timerAt <= at) return;
    clearTimeout(timer);
    timerAt = at;
    timer = setTimeout(() => {
      timer = null;
      timerAt = Infinity;
      void runDue().catch(caught => { log.error('mockup_worker_failed', { errorCode: log.errorCode(caught) }); return 0; })
        .then(async () => {
          if (stopping || timer) return;
          const next = await repository.getNextMockupJobAt({ scope: scopeKey(), operator: operatorEnabled(), now: now() });
          if (next != null && !timer && !stopping) kick(Math.max(1000, next - now()));
        }).catch(caught => log.error('mockup_wake_failed', { errorCode: log.errorCode(caught) }));
    }, delay);
    timer.unref?.();
  }
  function start() { stopping = false; kick(); }
  async function stop() { stopping = true; clearTimeout(timer); timer = null; timerAt = Infinity; await running; }

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
  return { createForConfiguration, createForConfigurations, getJob, download, runDue, start, wake: kick, stop };
}

module.exports = { create, CACHE_MS, SOURCE_MS, STALE_MS, DEADLINE_MS, LEASE_MS, MAX_ATTEMPTS };
