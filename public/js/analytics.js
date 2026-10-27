(function (root) {
  'use strict';

  const settings = root.document?.currentScript?.dataset || {};
  const id = settings.ga4Id || '';
  if (!/^G-[A-Z0-9]+$/.test(id)) return;

  const CHOICE_COOKIE = 'wolkenworte-analytics';
  const CHOICE_VERSION = '1';
  const CHOICE_AGE_SECONDS = 180 * 24 * 60 * 60;
  const NAVIGATION_MARKER = 'wolkenworte-analytics-next';
  const REMOVAL_MARKER = 'wolkenworte-analytics-removal';
  const FLOW_MARKER = 'wolkenworte-analytics-flow';
  const SAFE_ITEM_ID = /^[a-z0-9][a-z0-9-]{0,79}$/;
  const COMMERCE_EVENTS = ['view_item_list', 'select_item', 'view_item', 'view_cart',
    'add_to_cart', 'remove_from_cart', 'cart_updated', 'begin_checkout', 'add_shipping_info',
    'shipping_quote', 'payment_redirect'];
  const FLOWS = ['cloud', 'direct', 'library', 'reorder'];
  const environment = ['local', 'hosted-test', 'production'].includes(settings.appEnvironment)
    ? settings.appEnvironment : 'local';
  let choice = readChoice();
  let started = false;
  let surface = initialSurface(root.location.pathname, root.location.search);
  let entryFlow = new URLSearchParams(root.location.search).has('accountDesign') ? 'library'
    : FLOWS.includes(settings.entryFlow) ? settings.entryFlow
    : ['event', 'configure', 'shipping', 'confirmation'].includes(pageKind(root.location.pathname)) ? 'cloud' : '';
  let virtualReferrer = '';
  if (['shipping', 'confirmation'].includes(pageKind(root.location.pathname))) {
    try {
      const saved = JSON.parse(root.sessionStorage.getItem(FLOW_MARKER) || 'null');
      if (FLOWS.includes(saved?.flow) && saved.scope === flowScope() && Date.now() >= saved.time && Date.now() - saved.time < 7200000) entryFlow = saved.flow;
    } catch {}
  }

  function flowScope() {
    // Keep separate carts' entry paths distinct locally; never send this scope.
    return root.location.pathname.match(/^\/e\/[A-Za-z0-9_-]{22}(?=\/|$)/)?.[0] || '';
  }

  function rememberFlow() {
    if (readChoice() !== 'yes' || !FLOWS.includes(entryFlow)) return;
    try { root.sessionStorage.setItem(FLOW_MARKER, JSON.stringify({ flow: entryFlow, scope: flowScope(), time: Date.now() })); } catch {}
  }

  function readChoice() {
    try {
      const pair = String(root.document.cookie || '').split(';')
        .map(value => value.trim()).find(value => value.startsWith(`${CHOICE_COOKIE}=`));
      const value = pair?.slice(CHOICE_COOKIE.length + 1);
      return value === `${CHOICE_VERSION}-yes` ? 'yes' : value === `${CHOICE_VERSION}-no` ? 'no' : '';
    } catch { return ''; }
  }

  function saveChoice(value) {
    const secure = root.location.protocol === 'https:' ? '; Secure' : '';
    root.document.cookie = `${CHOICE_COOKIE}=${CHOICE_VERSION}-${value}; Path=/; Max-Age=${CHOICE_AGE_SECONDS}; SameSite=Lax${secure}`;
    choice = value;
  }

  function pageKind(pathname) {
    const path = String(pathname || '');
    if (path === '/') return 'home';
    if (path === '/datenschutz') return 'privacy';
    if (path === '/impressum') return 'legal_notice';
    if (path === '/bestellinformationen') return 'ordering_information';
    if (/^\/konto(?:\/|$)/.test(path)) return 'account';
    if (/^\/e\/[A-Za-z0-9_-]{22}\/order-confirmation$/.test(path)) return 'confirmation';
    if (/^\/e\/[A-Za-z0-9_-]{22}\/shipping$/.test(path)) return 'shipping';
    if (/^\/e\/[A-Za-z0-9_-]{22}\/configure$/.test(path)) return 'configure';
    if (/^\/e\/[A-Za-z0-9_-]{22}$/.test(path)) return 'event';
    return 'other';
  }

  function initialSurface(path, search) {
    if (pageKind(path) !== 'configure') return pageKind(path);
    const query = new URLSearchParams(search);
    return query.has('edit') || query.has('accountDesign') || (query.has('draft') && query.get('view') !== 'products')
      ? 'editor' : 'gallery';
  }

  function safeLocation(pathname = root.location.pathname, search = root.location.search, current = false) {
    const kind = pageKind(pathname);
    const paths = {
      home: '/', event: '/analytics/event', configure: `/analytics/${current ? surface : initialSurface(pathname, search)}`,
      account: '/analytics/account', shipping: '/analytics/shipping', confirmation: '/analytics/confirmation',
      privacy: '/datenschutz', legal_notice: '/impressum', ordering_information: '/bestellinformationen', other: '/analytics/other',
    };
    // Campaign labels are the only accepted URL values, on every landing page.
    const source = new URLSearchParams(search);
    const allowed = new URLSearchParams();
    for (const key of ['utm_source', 'utm_medium', 'utm_campaign', 'utm_content', 'utm_term']) {
      const value = source.get(key);
      if (value && /^[A-Za-z0-9_.-]{1,80}$/.test(value)) allowed.set(key, value);
    }
    return `${root.location.origin}${paths[kind]}${allowed.size ? `?${allowed}` : ''}`;
  }

  function safeReferrer() {
    try {
      const referrer = new URL(root.document.referrer);
      if (!['https:', 'http:'].includes(referrer.protocol)) return '';
      return referrer.origin === root.location.origin ? safeLocation(referrer.pathname, referrer.search) : `${referrer.origin}/`;
    } catch { return ''; }
  }

  function context() {
    const language = root.document.documentElement?.lang;
    return {
      page_location: safeLocation(root.location.pathname, root.location.search, true),
      page_referrer: virtualReferrer || safeReferrer(), page_title: `Wolkenworte ${surface}`,
      page_type: pageKind(root.location.pathname), page_surface: surface, app_environment: environment,
      ...(FLOWS.includes(entryFlow) ? { entry_flow: entryFlow } : {}),
      ...(['de', 'en', 'fr', 'it', 'es', 'tr'].includes(language) ? { ui_language: language } : {}),
    };
  }

  function emit(name, parameters = {}) {
    // Re-read the cookie so a withdrawal in another tab stops the next event.
    if (readChoice() !== 'yes' || choice !== 'yes' || !started) return false;
    root.gtag('event', name, { ...context(), ...parameters, send_to: id, transport_type: 'beacon' });
    return true;
  }

  function page(nextSurface, flow) {
    if (FLOWS.includes(flow) && !['shipping', 'confirmation'].includes(pageKind(root.location.pathname))) entryFlow = flow;
    rememberFlow();
    const allowed = pageKind(root.location.pathname) === 'configure' ? ['gallery', 'editor', 'cart'] : [pageKind(root.location.pathname)];
    if (!allowed.includes(nextSurface)) return false;
    const changed = surface !== nextSurface;
    if (changed) virtualReferrer = safeLocation(root.location.pathname, root.location.search, true);
    surface = nextSurface;
    if (started && readChoice() === 'yes') root.gtag('set', context());
    return changed ? emit('page_view') : false;
  }

  function start() {
    if (choice !== 'yes' || started) return;
    started = true;
    const navigationEvent = consumeNavigationMarker();
    rememberFlow();
    root.dataLayer = root.dataLayer || [];
    root.gtag = root.gtag || function () { root.dataLayer.push(arguments); };
    root.gtag('consent', 'default', {
      analytics_storage: 'denied', ad_storage: 'denied', ad_user_data: 'denied', ad_personalization: 'denied',
    });
    root.gtag('consent', 'update', { analytics_storage: 'granted' });
    root.gtag('js', new Date());
    root.gtag('set', context());
    root.gtag('config', id, {
      send_page_view: false, allow_google_signals: false, allow_ad_personalization_signals: false,
      cookie_expires: CHOICE_AGE_SECONDS, ...context(),
    });
    const tag = root.document.createElement('script');
    tag.async = true;
    tag.src = `https://www.googletagmanager.com/gtag/js?id=${id}`;
    root.document.head.appendChild(tag);
    emit('page_view');
    if (navigationEvent) emit(navigationEvent);
    root.dispatchEvent(new root.Event('wolkenworte:analytics-granted'));
  }

  function clearAnalyticsCookies() {
    const secure = root.location.protocol === 'https:' ? '; Secure' : '';
    const host = root.location.hostname;
    for (const pair of String(root.document.cookie || '').split(';')) {
      const name = pair.split('=')[0].trim();
      if (!/^_ga(?:_|$)/.test(name)) continue;
      for (const domain of ['', `; Domain=${host}`, host.endsWith('.wolkenworte.io') ? '; Domain=.wolkenworte.io' : '']) {
        root.document.cookie = `${name}=; Path=/; Max-Age=0; SameSite=Lax${secure}${domain}`;
      }
    }
  }

  function markNextPageEvent(name) {
    if (readChoice() !== 'yes' || !['cloud_created', 'design_started', 'reorder_started'].includes(name)) return;
    try { root.sessionStorage.setItem(NAVIGATION_MARKER, `${name}:${Date.now()}`); } catch {}
  }

  function consumeNavigationMarker() {
    let marker = '';
    try {
      marker = root.sessionStorage.getItem(NAVIGATION_MARKER) || '';
      root.sessionStorage.removeItem(NAVIGATION_MARKER);
    } catch { return; }
    const [name, timestamp] = marker.split(':');
    const destination = { cloud_created: 'event', design_started: 'configure', reorder_started: 'shipping' }[name];
    if (!destination || pageKind(root.location.pathname) !== destination ||
        Date.now() - Number(timestamp) >= 120000 || Date.now() < Number(timestamp)) return;
    entryFlow = name === 'cloud_created' ? 'cloud' : name === 'design_started' ? 'direct' : 'reorder';
    return name;
  }

  // Callers pass catalog/pricing fields only. Never accept display titles,
  // user text, configuration IDs, or arbitrary event parameters.
  function item(product, quantity = product?.defaultQuantity || 1) {
    return { productKey: product?.key, category: product?.familyKey,
      unitPriceCents: product?.price?.unitNetCents, quantity };
  }

  function normalizeItems(items) {
    if (!Array.isArray(items) || !items.length || items.length > 200) return null;
    const normalized = [];
    for (const row of items) {
      if (!row || !SAFE_ITEM_ID.test(String(row.productKey || '')) ||
          !Number.isSafeInteger(row.quantity) || row.quantity < 1 || row.quantity > 99 ||
          !Number.isSafeInteger(row.unitPriceCents) || row.unitPriceCents < 0) return null;
      normalized.push({ item_id: row.productKey, item_name: row.productKey,
        ...(SAFE_ITEM_ID.test(String(row.category || '')) ? { item_category: row.category } : {}),
        price: row.unitPriceCents / 100, quantity: row.quantity });
    }
    return normalized;
  }

  function commerce(name, details = {}) {
    if (!COMMERCE_EVENTS.includes(name) || details.currency !== 'EUR') return false;
    const items = name === 'view_cart' && Array.isArray(details.items) && !details.items.length ? [] : normalizeItems(details.items);
    if (!items) return false;
    const cents = details.items.reduce((sum, row) => sum + row.unitPriceCents * row.quantity, 0);
    if (!Number.isSafeInteger(cents)) return false;
    return emit(name, { currency: 'EUR', value: cents / 100, items,
      ...(['view_item_list', 'select_item'].includes(name) ? { item_list_id: 'product-gallery', item_list_name: 'Produktübersicht' } : {}) });
  }

  function cartChange(previous, next) {
    const valid = row => row && normalizeItems([row]);
    // A retained cart design with quantity zero is excluded from this order.
    if (previous?.quantity === 0 && valid({ ...previous, quantity: 1 })) previous = null;
    if (next?.quantity === 0 && valid({ ...next, quantity: 1 })) next = null;
    if ((previous && !valid(previous)) || (next && !valid(next))) return false;
    if (previous && next && previous.productKey === next.productKey && previous.unitPriceCents === next.unitPriceCents) {
      const difference = next.quantity - previous.quantity;
      if (difference) return commerce(difference > 0 ? 'add_to_cart' : 'remove_from_cart', {
        currency: 'EUR', items: [{ ...next, quantity: Math.abs(difference) }],
      });
      return commerce('cart_updated', { currency: 'EUR', items: [next] });
    }
    const removed = previous ? commerce('remove_from_cart', { currency: 'EUR', items: [previous] }) : false;
    if (removed && !next) {
      try { root.sessionStorage.setItem(REMOVAL_MARKER, JSON.stringify({ time: Date.now(),
        item: { productKey: previous.productKey, category: previous.category,
          unitPriceCents: previous.unitPriceCents, quantity: previous.quantity } })); } catch {}
    }
    return next ? commerce('add_to_cart', { currency: 'EUR', items: [next] }) : removed;
  }

  function restoreCartItem(productKey, quantity) {
    try {
      const record = JSON.parse(root.sessionStorage.getItem(REMOVAL_MARKER) || 'null');
      root.sessionStorage.removeItem(REMOVAL_MARKER);
      if (record && Date.now() >= record.time && Date.now() - record.time < 600000 &&
          record.item.productKey === productKey && record.item.quantity === quantity) return cartChange(null, record.item);
    } catch {}
    return false;
  }

  function track(name, details = {}) {
    if (['start_dialog_open', 'direct_design_start', 'word_submitted', 'share_open', 'keepsake_open',
      'checkout_cancelled', 'design_saved'].includes(name)) return emit(name);
    if (name === 'share' && ['native', 'copy_link', 'whatsapp', 'email'].includes(details.method)) {
      return emit(name, { method: details.method, content_type: 'word_cloud' });
    }
    if (name === 'checkout_error' && ['shipping', 'payment'].includes(details.stage)) {
      const reasons = ['quote_changed', 'quote_shipping_changed', 'quote_expired', 'quote_not_found',
        'invalid_address', 'shipping_unavailable', 'selection_not_available', 'product_shipping_restricted',
        'pricing_unavailable', 'pricing_currency_mismatch', 'pricing_not_configured', 'checkout_not_configured',
        'checkout_failed', 'tax_calculation_failed', 'mockup_approval_required', 'rate_limited', 'network'];
      return emit(name, { checkout_stage: details.stage,
        failure_reason: reasons.includes(details.reason) ? details.reason : 'unknown' });
    }
    return false;
  }

  function trackPurchase(order) {
    if (order?.paymentConfirmed !== true || !/^WW-\d{8,}$/.test(String(order.orderNumber || ''))) return false;
    const total = Number(order.totalCents), shipping = Number(order.netShippingCents ?? order.shippingCents), tax = Number(order.taxCents);
    const items = normalizeItems(order.analyticsItems);
    if (!items || ![total, shipping, tax].every(amount => Number.isSafeInteger(amount) && amount >= 0) ||
        total < shipping + tax || order.currency !== 'EUR' ||
        order.analyticsItems.reduce((sum, row) => sum + row.unitPriceCents * row.quantity, 0) !== total - shipping - tax) return false;
    const key = `wolkenworte-analytics-purchase:${order.orderNumber}`;
    try { if (root.sessionStorage.getItem(key)) return false; } catch {}
    if (!emit('purchase', { transaction_id: order.orderNumber, currency: 'EUR',
      value: (total - shipping - tax) / 100, shipping: shipping / 100, tax: tax / 100, items,
      ...(order.mode === 'test' || order.mode === 'live' ? { payment_mode: order.mode } : {}) })) return false;
    try { root.sessionStorage.setItem(key, '1'); } catch {}
    return true;
  }

  function renderChoice() {
    const banner = root.document.getElementById('ww-analytics-banner');
    const controls = [...root.document.querySelectorAll('[data-analytics-settings]')];
    if (!banner || !controls.length) return;
    const showControls = () => controls.forEach(control => { control.hidden = !choice; });
    banner.hidden = Boolean(choice);
    showControls();
    for (const form of root.document.querySelectorAll('form[action="/design/start"]')) form.addEventListener('submit', () => {
      track('direct_design_start');
      markNextPageEvent('design_started');
    });
    for (const control of controls) control.addEventListener('click', () => {
      control.closest?.('details')?.removeAttribute('open');
      banner.hidden = false;
    });
    root.document.getElementById('ww-analytics-accept').addEventListener('click', () => {
      saveChoice('yes'); banner.hidden = true; showControls(); start();
    });
    root.document.getElementById('ww-analytics-reject').addEventListener('click', () => {
      const wasTracking = started;
      saveChoice('no'); banner.hidden = true; showControls();
      try { root.sessionStorage.removeItem(NAVIGATION_MARKER); } catch {}
      try { root.sessionStorage.removeItem(REMOVAL_MARKER); } catch {}
      try { root.sessionStorage.removeItem(FLOW_MARKER); } catch {}
      if (wasTracking) {
        root.gtag('consent', 'update', { analytics_storage: 'denied' });
        clearAnalyticsCookies(); root.location.reload();
      }
    });
  }

  root.WolkenworteAnalytics = { track, commerce, cartChange, restoreCartItem, item, page, trackPurchase, markNextPageEvent };
  function synchronizeWithdrawal() {
    if (started && choice === 'yes' && readChoice() !== 'yes') {
      choice = 'no';
      root.gtag('consent', 'update', { analytics_storage: 'denied' });
      clearAnalyticsCookies();
      root.location.reload();
    }
  }
  root.addEventListener('focus', synchronizeWithdrawal);
  root.addEventListener('pageshow', synchronizeWithdrawal);
  root.document.addEventListener('visibilitychange', () => {
    if (root.document.visibilityState === 'visible') synchronizeWithdrawal();
  });
  if (choice === 'yes') start();
  if (root.document.readyState === 'loading') root.document.addEventListener('DOMContentLoaded', renderChoice);
  else renderChoice();
})(window);
