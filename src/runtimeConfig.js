'use strict';

const stripeConfig = require('./stripeConfig');

function flag(name) {
  return String(process.env[name] || 'false').trim().toLowerCase();
}

function validateRuntimeConfig() {
  const errors = [];
  const production = process.env.NODE_ENV === 'production';
  const port = Number(process.env.PORT || 3000);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    errors.push('PORT muss eine gültige TCP-Portnummer sein.');
  }
  const emailMode = String(process.env.EMAIL_DELIVERY_MODE || 'mock').trim().toLowerCase();
  if (!['mock', 'live'].includes(emailMode)) {
    errors.push('EMAIL_DELIVERY_MODE muss mock oder live sein.');
  }
  const resendConfigured = Boolean(
    String(process.env.RESEND_API_KEY || '').trim() &&
    String(process.env.RESEND_FROM_EMAIL || '').trim() &&
    String(process.env.RESEND_WEBHOOK_SECRET || '').trim()
  );
  for (const name of [
    'ALLOW_TEST_DATA_RESET',
    'MAINTENANCE_MODE',
    'STRIPE_LIVE_PAYMENTS_ENABLED',
    'PRINTFUL_ALLOW_ORDER_WRITES',
    'PRINTFUL_CONFIRM_LIVE_ORDERS',
  ]) {
    if (!['true', 'false'].includes(flag(name))) errors.push(`${name} muss true oder false sein.`);
  }
  errors.push(...stripeConfig.validationErrors());
  try {
    const appEnvironment = stripeConfig.appEnvironment();
    if (production && appEnvironment === 'local') {
      errors.push('NODE_ENV=production darf nicht mit APP_ENVIRONMENT=local laufen.');
    }
    if (!production && appEnvironment !== 'local') {
      errors.push('APP_ENVIRONMENT=hosted-test/production verlangt NODE_ENV=production.');
    }
  } catch { /* The precise APP_ENVIRONMENT error is already included above. */ }

  if (production) {
    if (process.env.MIGRATION_DATABASE_URL) {
      errors.push('MIGRATION_DATABASE_URL darf im Webprozess nicht vorhanden sein.');
    }
    try {
      const publicUrl = new URL(process.env.PUBLIC_URL || '');
      if (publicUrl.protocol !== 'https:') throw new Error('not https');
    } catch {
      errors.push('PUBLIC_URL muss in Produktion eine öffentliche HTTPS-URL sein.');
    }
    try {
      const supabaseUrl = new URL(process.env.SUPABASE_URL || '');
      if (supabaseUrl.protocol !== 'https:') throw new Error('not https');
    } catch {
      errors.push('SUPABASE_URL muss in Produktion eine HTTPS-URL sein.');
    }
    if (!String(process.env.SUPABASE_SECRET_KEY || '').startsWith('sb_secret_')) {
      errors.push('SUPABASE_SECRET_KEY muss ein aktueller backend-only sb_secret_-Key sein.');
    }
    if (!/^[a-z0-9][a-z0-9._-]{2,62}$/.test(
      String(process.env.SUPABASE_STORAGE_BUCKET || 'wolkenworte-private').trim()
    )) {
      errors.push('SUPABASE_STORAGE_BUCKET muss ein gültiger privater Bucket-Name sein.');
    }
    const rateSecret = String(process.env.RATE_LIMIT_HMAC_SECRET || '');
    const maintenanceSecret = String(process.env.MAINTENANCE_SECRET || '');
    if (rateSecret.length < 32 || maintenanceSecret.length < 32) {
      errors.push('RATE_LIMIT_HMAC_SECRET und MAINTENANCE_SECRET müssen mindestens 32 Zeichen lang sein.');
    } else if (rateSecret === maintenanceSecret) {
      errors.push('RATE_LIMIT_HMAC_SECRET und MAINTENANCE_SECRET müssen unabhängig sein.');
    }
    if (flag('ALLOW_TEST_DATA_RESET') === 'true') {
      errors.push('ALLOW_TEST_DATA_RESET darf im Webprozess nicht aktiviert sein.');
    }
    if (emailMode === 'live' && !resendConfigured) {
      errors.push('Resend-Liveversand benötigt API-Key, Absender und Webhook-Signatursecret.');
    }
  }

  if (flag('STRIPE_LIVE_PAYMENTS_ENABLED') === 'true') {
    if (emailMode !== 'live' || !resendConfigured) {
      errors.push('Live-Zahlungen benötigen gültig konfigurierten Resend-Liveversand.');
    }
  }
  const printfulMode = String(process.env.PRINTFUL_FULFILLMENT_MODE || 'mock').trim().toLowerCase();
  const printfulWebhookSecret = String(process.env.PRINTFUL_WEBHOOK_SECRET || '');
  const printfulWebhookPublicKey = String(process.env.PRINTFUL_WEBHOOK_PUBLIC_KEY || '');
  if ((printfulWebhookSecret && !printfulWebhookPublicKey) ||
      (!printfulWebhookSecret && printfulWebhookPublicKey)) {
    errors.push('PRINTFUL_WEBHOOK_SECRET und PRINTFUL_WEBHOOK_PUBLIC_KEY müssen gemeinsam gesetzt werden.');
  }
  if (production && printfulMode !== 'mock' && (!printfulWebhookSecret || !printfulWebhookPublicKey)) {
    errors.push('Printful draft/live benötigt den signierten v2-Webhook.');
  }
  if (errors.length) throw new Error(`Ungültige Laufzeitkonfiguration: ${errors.join(' ')}`);
  return true;
}

module.exports = { validateRuntimeConfig };
