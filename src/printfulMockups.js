'use strict';

const { getProduct, resolveProductOrientation } = require('./products');

const SOURCE_PREFIX = 'operator-mockup-sources';
const SOURCE_TTL_SECONDS = 60 * 60;
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
  let candidates = (rows || []).flatMap((row) => {
    if (String(row?.placement) !== placement ||
        String(row?.technique || '').toLowerCase() !== technique) return [];
    return (row.mockup_styles || []).filter((style) => {
      const restricted = style.restricted_to_variants;
      return restricted == null || (Array.isArray(restricted) &&
        restricted.map(Number).includes(product.printful.variantId));
    }).map((style) => ({ row, style }));
  });
  if (product.printFile.canRotate) {
    const width = product.printFile.width / product.printFile.dpi;
    const height = product.printFile.height / product.printFile.dpi;
    const exact = candidates.filter(({ row }) =>
      Math.abs(Number(row.print_area_width) - width) < .04 &&
      Math.abs(Number(row.print_area_height) - height) < .04);
    // Rotatable products have different style IDs for each orientation. A
    // transposed match is rejected by Printful when the orientation is sent.
    if (exact.length) candidates = exact;
  }
  // Phone catalogs can retain generic styles for older devices alongside
  // explicit styles for new variants. Prefer the exact variant restriction;
  // a null restriction is not reliable evidence that an old style supports it.
  const realStyle = ({ style }) => String(style.category_name || '').toLowerCase() !== 'placeholder';
  const selected = candidates.find(candidate =>
    Array.isArray(candidate.style.restricted_to_variants) && realStyle(candidate)) ||
    candidates.find(realStyle) || candidates[0];
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

function createService(options = {}) {
  return require('./mockupQueue').create({ parseConfiguration, compatibleStyle, normalizedMockups,
    trustedMockupUrl, shouldFallbackToStandardResolution, PrintfulMockupError, isOperatorEnabled, ...options });
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
  compatibleStyle,
  isOperatorEnabled,
  isLoopbackAddress,
  isLocalHost,
  isOperatorRequest,
  isOperatorCreateRequest,
  createForConfiguration: (...args) => activeService().createForConfiguration(...args),
  createForConfigurations: (...args) => activeService().createForConfigurations(...args),
  getJob: (...args) => activeService().getJob(...args),
  download: (...args) => activeService().download(...args),
  createCustomerMockup: (...args) => activeService().createForConfiguration(args[0], { ...args[1], customer: true }),
  getCustomerMockup: (...args) => activeService().getJob(...args),
  start: () => activeService().start(),
  wake: () => activeService().wake(),
  runDue: (...args) => activeService().runDue(...args),
  stop: (...args) => activeService().stop(...args),
  setAdapterForTests,
  resetAdapterForTests,
};
