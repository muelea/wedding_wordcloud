(function (root) {
  'use strict';

  const id = root.document?.currentScript?.dataset?.ga4Id || '';
  if (!/^G-[A-Z0-9]+$/.test(id)) return;

  const CHOICE_COOKIE = 'wolkenworte-analytics';
  const CHOICE_VERSION = '1';
  const CHOICE_AGE_SECONDS = 180 * 24 * 60 * 60;
  const NAVIGATION_MARKER = 'wolkenworte-analytics-next';
  const SAFE_ITEM_ID = /^[a-z0-9][a-z0-9-]{0,79}$/;
  let choice = readChoice();
  let started = false;

  function readChoice() {
    try {
      const pair = String(root.document.cookie || '').split(';')
        .map((value) => value.trim())
        .find((value) => value.startsWith(`${CHOICE_COOKIE}=`));
      const value = pair?.slice(CHOICE_COOKIE.length + 1);
      return value === `${CHOICE_VERSION}-yes` ? 'yes' :
        value === `${CHOICE_VERSION}-no` ? 'no' : '';
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
    if (/^\/e\/[A-Za-z0-9_-]{22}\/order-confirmation$/.test(path)) return 'confirmation';
    if (/^\/e\/[A-Za-z0-9_-]{22}\/shipping$/.test(path)) return 'shipping';
    if (/^\/e\/[A-Za-z0-9_-]{22}\/configure$/.test(path)) return 'configure';
    if (/^\/e\/[A-Za-z0-9_-]{22}$/.test(path)) return 'event';
    return 'other';
  }

  function safeLocation(pathname = root.location.pathname, search = root.location.search) {
    const kind = pageKind(pathname);
    const paths = {
      home: '/', event: '/analytics/event', configure: '/analytics/configure',
      shipping: '/analytics/shipping', confirmation: '/analytics/confirmation',
      privacy: '/datenschutz', legal_notice: '/impressum',
      ordering_information: '/bestellinformationen', other: '/analytics/other',
    };
    let campaign = '';
    if (kind === 'home') {
      const source = new URLSearchParams(search);
      const allowed = new URLSearchParams();
      for (const key of ['utm_source', 'utm_medium', 'utm_campaign']) {
        const value = source.get(key);
        if (value && /^[A-Za-z0-9_.-]{1,80}$/.test(value)) allowed.set(key, value);
      }
      campaign = allowed.size ? `?${allowed}` : '';
    }
    return `${root.location.origin}${paths[kind]}${campaign}`;
  }

  function safeReferrer() {
    try {
      const referrer = new URL(root.document.referrer);
      if (!['https:', 'http:'].includes(referrer.protocol)) return '';
      if (referrer.origin === root.location.origin) return safeLocation(referrer.pathname, referrer.search);
      return `${referrer.origin}/`;
    } catch { return ''; }
  }

  function context() {
    return {
      page_location: safeLocation(),
      page_referrer: safeReferrer(),
      page_title: `Wolkenworte ${pageKind(root.location.pathname)}`,
    };
  }

  function emit(name, parameters = {}) {
    if (choice !== 'yes' || !started) return false;
    root.gtag('event', name, { ...context(), ...parameters, send_to: id, transport_type: 'beacon' });
    return true;
  }

  function start() {
    if (choice !== 'yes' || started) return;
    started = true;
    root.dataLayer = root.dataLayer || [];
    root.gtag = root.gtag || function () { root.dataLayer.push(arguments); };
    root.gtag('consent', 'default', {
      analytics_storage: 'denied', ad_storage: 'denied',
      ad_user_data: 'denied', ad_personalization: 'denied',
    });
    root.gtag('consent', 'update', { analytics_storage: 'granted' });
    root.gtag('js', new Date());
    root.gtag('set', context());
    root.gtag('config', id, {
      send_page_view: false,
      allow_google_signals: false,
      allow_ad_personalization_signals: false,
      cookie_expires: CHOICE_AGE_SECONDS,
      ...context(),
    });
    const tag = root.document.createElement('script');
    tag.async = true;
    tag.src = `https://www.googletagmanager.com/gtag/js?id=${id}`;
    root.document.head.appendChild(tag);
    emit('page_view');
    consumeNavigationMarker();
    root.dispatchEvent(new root.Event('wolkenworte:analytics-granted'));
  }

  function clearAnalyticsCookies() {
    const secure = root.location.protocol === 'https:' ? '; Secure' : '';
    const host = root.location.hostname;
    for (const pair of String(root.document.cookie || '').split(';')) {
      const name = pair.split('=')[0].trim();
      if (!/^_ga(?:_|$)/.test(name)) continue;
      for (const domain of ['', host === 'wolkenworte.io' || host.endsWith('.wolkenworte.io')
        ? '; Domain=.wolkenworte.io' : '']) {
        root.document.cookie = `${name}=; Path=/; Max-Age=0; SameSite=Lax${secure}${domain}`;
      }
    }
  }

  function markNextPageEvent(name) {
    if (choice !== 'yes' || !['cloud_created', 'begin_checkout'].includes(name)) return;
    try { root.sessionStorage.setItem(NAVIGATION_MARKER, `${name}:${Date.now()}`); } catch {}
  }

  function consumeNavigationMarker() {
    let marker = '';
    try {
      marker = root.sessionStorage.getItem(NAVIGATION_MARKER) || '';
      root.sessionStorage.removeItem(NAVIGATION_MARKER);
    } catch { return; }
    const [name, timestamp] = marker.split(':');
    const destination = name === 'cloud_created' ? 'event' : 'shipping';
    if (pageKind(root.location.pathname) === destination &&
        Date.now() - Number(timestamp) < 120000 && Date.now() >= Number(timestamp)) emit(name);
  }

  function track(name, details = {}) {
    if (['start_dialog_open', 'word_submitted', 'shipping_quote', 'payment_redirect',
      'checkout_cancelled'].includes(name)) return emit(name);
    if (['select_item', 'add_to_cart', 'remove_from_cart'].includes(name)) {
      const itemId = String(details.itemId || '');
      if (!SAFE_ITEM_ID.test(itemId)) return false;
      return emit(name, { items: [{ item_id: itemId, item_name: itemId }] });
    }
    return false;
  }

  function trackPurchase(order) {
    if (order?.paymentConfirmed !== true || !/^WW-\d{8,}$/.test(String(order.orderNumber || ''))) return false;
    const total = Number(order.totalCents);
    const shipping = Number(order.shippingCents);
    const tax = Number(order.taxCents);
    if (![total, shipping, tax].every((amount) => Number.isSafeInteger(amount) && amount >= 0) ||
        total < shipping + tax || order.currency !== 'EUR') return false;
    const key = `wolkenworte-analytics-purchase:${order.orderNumber}`;
    try { if (root.sessionStorage.getItem(key)) return false; } catch {}
    const value = (total - shipping - tax) / 100;
    if (!emit('purchase', {
      transaction_id: order.orderNumber,
      currency: order.currency,
      value,
      shipping: shipping / 100,
      tax: tax / 100,
      items: [{ item_id: 'wolkenworte-order', item_name: 'Wolkenworte Bestellung', price: value, quantity: 1 }],
    })) return false;
    try { root.sessionStorage.setItem(key, '1'); } catch {}
    return true;
  }

  function renderChoice() {
    const banner = root.document.getElementById('ww-analytics-banner');
    const settings = root.document.getElementById('ww-analytics-settings');
    if (!banner || !settings) return;
    banner.hidden = Boolean(choice);
    settings.hidden = !choice;
    settings.addEventListener('click', () => {
      settings.closest?.('details')?.removeAttribute('open');
      banner.hidden = false;
    });
    root.document.getElementById('ww-analytics-accept').addEventListener('click', () => {
      saveChoice('yes');
      banner.hidden = true;
      settings.hidden = false;
      start();
    });
    root.document.getElementById('ww-analytics-reject').addEventListener('click', () => {
      const wasTracking = started;
      saveChoice('no');
      banner.hidden = true;
      settings.hidden = false;
      if (wasTracking) {
        root.gtag('consent', 'update', { analytics_storage: 'denied' });
        clearAnalyticsCookies();
        root.location.reload();
      }
    });
  }

  root.WolkenworteAnalytics = { track, trackPurchase, markNextPageEvent };
  if (choice === 'yes') start();
  if (root.document.readyState === 'loading') root.document.addEventListener('DOMContentLoaded', renderChoice);
  else renderChoice();
})(window);
