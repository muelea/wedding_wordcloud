'use strict';

const crypto = require('crypto');
const storage = require('./privateStorage');
const printful = require('./printful');
const { renderProviderPng } = require('./printRaster');
const { getProduct, resolveProductOrientation } = require('./products');

const SOURCE_PREFIX = 'operator-mockup-sources';
const SOURCE_TTL_SECONDS = 60 * 60;
const JOB_CACHE_MS = 12 * 60 * 60 * 1000;
const MAX_DOWNLOAD_BYTES = 20 * 1024 * 1024;
const CREATE_LIMIT = 2;
const CREATE_WINDOW_MS = 60 * 1000;
const PREFERRED_MOCKUP_WIDTH_PX = 2000;
const FALLBACK_MOCKUP_WIDTH_PX = 1000;

class PrintfulMockupError extends Error {
  constructor(code, message, status = 500, details = {}) {
    super(message);
    this.name = 'PrintfulMockupError';
    this.code = code;
    this.status = status;
    Object.assign(this, details);
  }
}

function enabledFlag(value) {
  return String(value || '').trim().toLowerCase() === 'true';
}

function isOperatorEnabled(env = process.env) {
  return env.NODE_ENV !== 'production' && env.APP_ENVIRONMENT === 'local' &&
    enabledFlag(env.PRINTFUL_MOCKUP_TOOLS_ENABLED);
}

function isLoopbackAddress(address) {
  const normalized = String(address || '').toLowerCase();
  return normalized === '::1' || normalized === '127.0.0.1' ||
    normalized === '::ffff:127.0.0.1';
}

function isLocalHost(value) {
  try {
    const hostname = new URL(`http://${String(value || '')}`).hostname.toLowerCase();
    return hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '[::1]';
  } catch {
    return false;
  }
}

function isOperatorRequest(req, env = process.env) {
  const host = typeof req?.get === 'function' ? req.get('host') : req?.headers?.host;
  return isOperatorEnabled(env) && isLoopbackAddress(req?.socket?.remoteAddress) && isLocalHost(host);
}

function isOperatorCreateRequest(req, env = process.env) {
  const marker = typeof req?.get === 'function'
    ? req.get('x-wolkenworte-operator')
    : req?.headers?.['x-wolkenworte-operator'];
  return isOperatorRequest(req, env) && marker === 'printful-mockup';
}

function parseConfiguration(configuration) {
  const product = resolveProductOrientation(
    getProduct(configuration?.product_key),
    configuration?.orientation
  );
  if (!product || Number(configuration?.printful_variant_id) !== product.printful.variantId ||
      Number(configuration?.print_width) !== product.printFile.width ||
      Number(configuration?.print_height) !== product.printFile.height) {
    throw new PrintfulMockupError(
      'mockup_configuration_invalid',
      'Die gespeicherte Produktkonfiguration ist ungültig.',
      422
    );
  }
  let design;
  try {
    design = JSON.parse(configuration.design_json);
  } catch {
    design = null;
  }
  if (!design || design.version !== 2 || !design.surfaces) {
    throw new PrintfulMockupError(
      'mockup_configuration_invalid',
      'Das gespeicherte Design ist ungültig.',
      422
    );
  }
  const surfaces = product.printSurfaces.map((surface, index) => {
    const surfaceDesign = design.surfaces[surface.key];
    if (!Array.isArray(surfaceDesign) || !surfaceDesign.length) {
      throw new PrintfulMockupError(
        'mockup_configuration_invalid',
        'Eine Druckseite des gespeicherten Designs fehlt.',
        422
      );
    }
    return {
      surface,
      placement: product.printful.placements[index],
      design: surfaceDesign,
    };
  });
  return { product, design, surfaces };
}

function compatibleStyle(rows, product, placement) {
  const technique = String(product.printful.technique).toLowerCase();
  const candidates = (rows || []).flatMap((row) => {
    if (String(row?.placement) !== placement ||
        String(row?.technique || '').toLowerCase() !== technique) return [];
    return (row.mockup_styles || []).filter((style) => {
      const restricted = style.restricted_to_variants;
      return restricted == null || (Array.isArray(restricted) &&
        restricted.map(Number).includes(product.printful.variantId));
    }).map((style) => ({ row, style }));
  });
  const selected = candidates.find(({ style }) =>
    String(style.category_name || '').toLowerCase() !== 'placeholder') || candidates[0];
  if (!selected || !Number.isSafeInteger(Number(selected.style.id))) {
    throw new PrintfulMockupError(
      'mockup_style_unavailable',
      `Printful bietet keinen passenden Mockup-Stil für ${placement}.`,
      422
    );
  }
  return {
    id: Number(selected.style.id),
    printAreaType: String(selected.row.print_area_type || 'simple'),
  };
}

function printfulOrientation(product) {
  if (product.orientation === 'portrait') return 'vertical';
  if (product.orientation === 'landscape') return 'horizontal';
  return null;
}

function shouldFallbackToStandardResolution(error) {
  return error?.providerStatus === 429 &&
    Number(error.rateLimitRemaining) >= 1 &&
    /would exceed available attempts/i.test(String(error.message || ''));
}

function providerMockupError(error) {
  if (error?.providerStatus !== 429) return error;
  const retryAfter = Number(error.retryAfter) > 0
    ? Math.ceil(Number(error.retryAfter))
    : Number(error.rateLimitReset) > 0
      ? Math.ceil(Number(error.rateLimitReset))
      : 60;
  return new PrintfulMockupError(
    'mockup_rate_limited',
    `Printful hat sein Erzeugungslimit erreicht. Bitte wartet ${retryAfter} Sekunden.`,
    429,
    { retryAfter }
  );
}

function trustedMockupUrl(value) {
  try {
    const url = new URL(value);
    if (url.protocol !== 'https:') return null;
    const host = url.hostname.toLowerCase();
    if (host === 'printful-upload.s3-accelerate.amazonaws.com' ||
        host === 'printful-upload.s3.amazonaws.com' ||
        host.endsWith('.printful.com')) return url;
  } catch { /* invalid provider URL */ }
  return null;
}

function normalizedMockups(tasks) {
  return (tasks || []).flatMap((task) =>
    (task.catalog_variant_mockups || []).flatMap((variant) =>
      (variant.mockups || []).map((mockup) => ({
        variantId: Number(variant.catalog_variant_id),
        placement: String(mockup.placement || ''),
        displayName: String(mockup.display_name || mockup.placement || 'Mockup'),
        technique: String(mockup.technique || ''),
        styleId: Number(mockup.style_id),
        url: trustedMockupUrl(mockup.mockup_url)?.toString() || '',
      })).filter((mockup) => mockup.url)
    )
  );
}

function createService({
  storageClient = storage,
  printfulClient = printful,
  fetchImpl = (...args) => fetch(...args),
  now = () => Date.now(),
} = {}) {
  const jobs = new Map();
  const cache = new Map();
  const creating = new Map();
  const creationTimes = [];

  async function cleanupSources(job) {
    if (!job?.sourceObjectKeys?.length) return;
    const remaining = [];
    for (const objectKey of job.sourceObjectKeys) {
      try { await storageClient.remove(objectKey); }
      catch { remaining.push(objectKey); }
    }
    job.sourceObjectKeys = remaining;
    if (!remaining.length && job.cleanupTimer) {
      clearTimeout(job.cleanupTimer);
      job.cleanupTimer = null;
    }
  }

  function scheduleCleanup(job) {
    const timer = setTimeout(() => void cleanupSources(job), SOURCE_TTL_SECONDS * 1000);
    timer.unref?.();
    job.cleanupTimer = timer;
  }

  function prune() {
    for (const [cacheKey, jobId] of cache) {
      const job = jobs.get(jobId);
      if (!job || now() - job.createdAt > JOB_CACHE_MS) cache.delete(cacheKey);
    }
    for (const [jobId, job] of jobs) {
      if (now() - job.createdAt <= JOB_CACHE_MS) continue;
      void cleanupSources(job);
      jobs.delete(jobId);
    }
  }

  function consumeCreation() {
    const cutoff = now() - CREATE_WINDOW_MS;
    while (creationTimes.length && creationTimes[0] <= cutoff) creationTimes.shift();
    if (creationTimes.length >= CREATE_LIMIT) {
      const retryAfter = Math.max(1, Math.ceil((creationTimes[0] + CREATE_WINDOW_MS - now()) / 1000));
      throw new PrintfulMockupError(
        'mockup_rate_limited',
        `Bitte wartet ${retryAfter} Sekunden, bevor ihr ein weiteres Printful-Mockup erzeugt.`,
        429,
        { retryAfter }
      );
    }
    creationTimes.push(now());
  }

  async function createUncached(configuration, cacheKey, product, surfaces) {
    const placements = surfaces.map((entry) => entry.placement);
    const styleRows = await printfulClient.getCatalogProductMockupStyles(
      product.printful.productId,
      placements
    );
    const styles = new Map(placements.map((placement) => [
      placement,
      compatibleStyle(styleRows, product, placement),
    ]));
    const sourceObjectKeys = [];
    const uploaded = [];
    const expiresAt = Math.floor(now() / 1000) + SOURCE_TTL_SECONDS;
    try {
      for (const entry of surfaces) {
        const randomId = crypto.randomBytes(18).toString('base64url');
        const objectKey = `${SOURCE_PREFIX}/${expiresAt}-${randomId}.png`;
        const sourcePng = await renderProviderPng(product, entry.design);
        await storageClient.upload(objectKey, sourcePng, 'image/png');
        sourceObjectKeys.push(objectKey);
        const signedUrl = await storageClient.createSignedUrl(objectKey, SOURCE_TTL_SECONDS);
        const parsedUrl = new URL(signedUrl);
        if (parsedUrl.protocol !== 'https:') {
          throw new PrintfulMockupError(
            'mockup_source_unavailable',
            'Private Storage hat keine sichere HTTPS-Datei bereitgestellt.',
            503
          );
        }
        uploaded.push({ ...entry, signedUrl: parsedUrl.toString() });
      }

      consumeCreation();
      const orientation = printfulOrientation(product);
      const payloadForWidth = (mockupWidthPx) => ({
        format: 'png',
        mockup_width_px: mockupWidthPx,
        products: [{
          source: 'catalog',
          catalog_product_id: product.printful.productId,
          catalog_variant_ids: [product.printful.variantId],
          mockup_style_ids: [...new Set([...styles.values()].map((style) => style.id))],
          ...(orientation ? { orientation } : {}),
          placements: uploaded.map((entry) => ({
            placement: entry.placement,
            technique: product.printful.technique,
            print_area_type: styles.get(entry.placement).printAreaType,
            layers: [{ type: 'file', url: entry.signedUrl }],
          })),
          ...(product.printful.options.length ? {
            product_options: product.printful.options.map((option) => ({
              name: option.id,
              value: option.value,
            })),
          } : {}),
        }],
      });
      let mockupWidthPx = PREFERRED_MOCKUP_WIDTH_PX;
      let resolutionFallback = false;
      let tasks;
      try {
        tasks = await printfulClient.createMockupTasks(payloadForWidth(mockupWidthPx));
      } catch (error) {
        if (!shouldFallbackToStandardResolution(error)) {
          throw providerMockupError(error);
        }
        mockupWidthPx = FALLBACK_MOCKUP_WIDTH_PX;
        resolutionFallback = true;
        try {
          tasks = await printfulClient.createMockupTasks(payloadForWidth(mockupWidthPx));
        } catch (fallbackError) {
          throw providerMockupError(fallbackError);
        }
      }
      const job = {
        id: crypto.randomBytes(18).toString('base64url'),
        taskIds: tasks.map((task) => Number(task.id)),
        sourceObjectKeys,
        createdAt: now(),
        productKey: product.key,
        mockupWidthPx,
        resolutionFallback,
        status: tasks.every((task) => task.status === 'completed') ? 'completed' : 'pending',
        result: null,
        cleanupTimer: null,
      };
      jobs.set(job.id, job);
      cache.set(cacheKey, job.id);
      scheduleCleanup(job);
      if (job.status === 'completed') await refreshJob(job, tasks);
      return {
        jobId: job.id,
        status: job.status,
        mockupWidthPx: job.mockupWidthPx,
        resolutionFallback: job.resolutionFallback,
      };
    } catch (error) {
      await Promise.allSettled(sourceObjectKeys.map((objectKey) => storageClient.remove(objectKey)));
      throw error;
    }
  }

  async function createForConfiguration(configuration) {
    prune();
    const { product, design, surfaces } = parseConfiguration(configuration);
    const digest = crypto.createHash('sha256');
    digest.update(JSON.stringify({
      productId: product.printful.productId,
      variantId: product.printful.variantId,
      placements: product.printful.placements,
      options: product.printful.options,
      orientation: product.orientation,
    }));
    digest.update(JSON.stringify(design));
    const cacheKey = digest.digest('hex');
    const cachedJob = jobs.get(cache.get(cacheKey));
    if (cachedJob && now() - cachedJob.createdAt <= JOB_CACHE_MS) {
      if (cachedJob.status !== 'failed') {
        return {
          jobId: cachedJob.id,
          status: cachedJob.status,
          mockupWidthPx: cachedJob.mockupWidthPx,
          resolutionFallback: cachedJob.resolutionFallback,
          cached: true,
        };
      }
      cache.delete(cacheKey);
    }
    if (!creating.has(cacheKey)) {
      creating.set(cacheKey, createUncached(configuration, cacheKey, product, surfaces)
        .finally(() => creating.delete(cacheKey)));
    }
    return creating.get(cacheKey);
  }

  async function refreshJob(job, suppliedTasks = null) {
    if (job.result) return job.result;
    const tasks = suppliedTasks || await printfulClient.getMockupTasks(job.taskIds);
    const statuses = tasks.map((task) => String(task.status || '').toLowerCase());
    const failureReasons = tasks.flatMap((task) => task.failure_reasons || [])
      .map((reason) => String(reason.detail || reason.title || '')).filter(Boolean);
    if (statuses.some((status) => status === 'failed')) {
      job.status = 'failed';
      job.result = {
        jobId: job.id,
        status: 'failed',
        mockupWidthPx: job.mockupWidthPx,
        resolutionFallback: job.resolutionFallback,
        mockups: [],
        failureReasons,
      };
      await cleanupSources(job);
      return job.result;
    }
    if (!statuses.length || statuses.some((status) => status !== 'completed')) {
      job.status = 'pending';
      return {
        jobId: job.id,
        status: 'pending',
        mockupWidthPx: job.mockupWidthPx,
        resolutionFallback: job.resolutionFallback,
        mockups: [],
        failureReasons,
      };
    }
    const mockups = normalizedMockups(tasks);
    job.status = mockups.length ? 'completed' : 'failed';
    job.result = {
      jobId: job.id,
      status: job.status,
      mockupWidthPx: job.mockupWidthPx,
      resolutionFallback: job.resolutionFallback,
      mockups,
      failureReasons: mockups.length ? failureReasons : [
        ...failureReasons,
        'Printful hat für diese Auswahl kein Mockup geliefert.',
      ],
    };
    await cleanupSources(job);
    return job.result;
  }

  async function getJob(jobId) {
    const id = String(jobId || '');
    const job = /^[A-Za-z0-9_-]{24}$/.test(id) ? jobs.get(id) : null;
    if (!job || now() - job.createdAt > JOB_CACHE_MS) {
      throw new PrintfulMockupError('mockup_job_not_found', 'Das Mockup wurde nicht gefunden.', 404);
    }
    return refreshJob(job);
  }

  async function download(jobId, index) {
    const result = await getJob(jobId);
    const fileIndex = Number(index);
    if (result.status !== 'completed' || !Number.isSafeInteger(fileIndex) ||
        fileIndex < 0 || fileIndex >= result.mockups.length) {
      throw new PrintfulMockupError('mockup_file_not_found', 'Die Mockup-Datei wurde nicht gefunden.', 404);
    }
    const mockup = result.mockups[fileIndex];
    const url = trustedMockupUrl(mockup.url);
    if (!url) throw new PrintfulMockupError('mockup_file_not_found', 'Die Mockup-Datei wurde nicht gefunden.', 404);
    const response = await fetchImpl(url, { signal: AbortSignal.timeout(20_000) });
    const contentType = String(response.headers?.get?.('content-type') || '').split(';')[0].toLowerCase();
    if (!response.ok || !['image/png', 'image/jpeg'].includes(contentType)) {
      throw new PrintfulMockupError('mockup_download_failed', 'Das Mockup konnte nicht geladen werden.', 502);
    }
    const bytes = Buffer.from(await response.arrayBuffer());
    if (!bytes.length || bytes.length > MAX_DOWNLOAD_BYTES) {
      throw new PrintfulMockupError('mockup_download_failed', 'Die Mockup-Datei ist ungültig.', 502);
    }
    const job = jobs.get(String(jobId));
    const safeProduct = String(job.productKey).replace(/[^a-z0-9_-]+/gi, '-');
    const safePlacement = String(mockup.placement || 'view').replace(/[^a-z0-9_-]+/gi, '-');
    const extension = contentType === 'image/png' ? 'png' : 'jpg';
    return {
      bytes,
      contentType,
      filename: `wolkenworte-${safeProduct}-${safePlacement}-${mockup.styleId}.${extension}`,
    };
  }

  async function stop() {
    const pending = [];
    for (const job of jobs.values()) {
      if (job.cleanupTimer) clearTimeout(job.cleanupTimer);
      pending.push(cleanupSources(job));
    }
    await Promise.allSettled(pending);
  }

  return { createForConfiguration, getJob, download, stop };
}

const defaultService = createService();
let testAdapter = null;

function activeService() {
  return testAdapter || defaultService;
}

function setAdapterForTests(adapter) {
  if (process.env.NODE_ENV !== 'test') throw new Error('Mockup adapter overrides are test-only.');
  testAdapter = adapter;
}

function resetAdapterForTests() {
  testAdapter = null;
}

module.exports = {
  PrintfulMockupError,
  SOURCE_PREFIX,
  SOURCE_TTL_SECONDS,
  createService,
  isOperatorEnabled,
  isLoopbackAddress,
  isLocalHost,
  isOperatorRequest,
  isOperatorCreateRequest,
  createForConfiguration: (...args) => activeService().createForConfiguration(...args),
  getJob: (...args) => activeService().getJob(...args),
  download: (...args) => activeService().download(...args),
  stop: (...args) => activeService().stop(...args),
  setAdapterForTests,
  resetAdapterForTests,
};
