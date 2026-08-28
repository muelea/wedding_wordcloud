'use strict';

const APP_ENVIRONMENTS = Object.freeze(['local', 'hosted-test', 'production']);
const PAYMENT_MODES = Object.freeze(['test', 'live']);
const LEGACY_VARIABLES = Object.freeze([
  'STRIPE_SECRET_KEY',
  'STRIPE_WEBHOOK_SECRET',
  'STRIPE_ALLOW_LIVE_PAYMENTS',
]);

function value(env, name, fallback = '') {
  return String(env[name] || fallback).trim();
}

function appEnvironment(env = process.env) {
  const selected = value(env, 'APP_ENVIRONMENT', 'local').toLowerCase();
  if (!APP_ENVIRONMENTS.includes(selected)) {
    throw new Error(`APP_ENVIRONMENT muss ${APP_ENVIRONMENTS.join(', ')} sein.`);
  }
  return selected;
}

function paymentMode(env = process.env) {
  const selected = value(env, 'STRIPE_PAYMENT_MODE', 'test').toLowerCase();
  if (!PAYMENT_MODES.includes(selected)) {
    throw new Error('STRIPE_PAYMENT_MODE muss test oder live sein.');
  }
  return selected;
}

function livePaymentsEnabled(env = process.env) {
  return value(env, 'STRIPE_LIVE_PAYMENTS_ENABLED', 'false').toLowerCase() === 'true';
}

function configuredSecretKey(env = process.env) {
  return value(env, paymentMode(env) === 'live' ? 'STRIPE_LIVE_SECRET_KEY' : 'STRIPE_TEST_SECRET_KEY');
}

function configuredWebhookSecret(env = process.env) {
  const mode = paymentMode(env);
  if (mode === 'live') return value(env, 'STRIPE_LIVE_WEBHOOK_SECRET');
  return value(env, appEnvironment(env) === 'hosted-test'
    ? 'STRIPE_TEST_HOSTED_WEBHOOK_SECRET'
    : 'STRIPE_TEST_LOCAL_WEBHOOK_SECRET');
}

function legacyVariablesPresent(env = process.env) {
  return LEGACY_VARIABLES.filter((name) => Object.hasOwn(env, name));
}

function validationErrors(env = process.env) {
  const errors = [];
  const legacy = legacyVariablesPresent(env);
  if (legacy.length) {
    errors.push(
      `${legacy.join(', ')} sind mehrdeutig und nicht mehr unterstützt; ` +
      'verwende die expliziten STRIPE_TEST_*/STRIPE_LIVE_*-Variablen.'
    );
  }

  let environment;
  let mode;
  try { environment = appEnvironment(env); } catch (error) { errors.push(error.message); }
  try { mode = paymentMode(env); } catch (error) { errors.push(error.message); }

  const liveFlag = value(env, 'STRIPE_LIVE_PAYMENTS_ENABLED', 'false').toLowerCase();
  if (!['true', 'false'].includes(liveFlag)) {
    errors.push('STRIPE_LIVE_PAYMENTS_ENABLED muss true oder false sein.');
  }
  if (environment === 'hosted-test' && mode !== 'test') {
    errors.push('APP_ENVIRONMENT=hosted-test erlaubt nur STRIPE_PAYMENT_MODE=test.');
  }
  if (environment === 'production' && mode !== 'live') {
    errors.push('APP_ENVIRONMENT=production verlangt STRIPE_PAYMENT_MODE=live.');
  }
  if (mode === 'live' && liveFlag !== 'true') {
    errors.push('STRIPE_PAYMENT_MODE=live verlangt STRIPE_LIVE_PAYMENTS_ENABLED=true.');
  }
  if (mode === 'test' && liveFlag === 'true') {
    errors.push('STRIPE_LIVE_PAYMENTS_ENABLED muss im Stripe-Testmodus false bleiben.');
  }

  const key = mode === 'live'
    ? value(env, 'STRIPE_LIVE_SECRET_KEY')
    : value(env, 'STRIPE_TEST_SECRET_KEY');
  if (key && mode === 'live' && !key.startsWith('sk_live_')) {
    errors.push('STRIPE_LIVE_SECRET_KEY muss ein sk_live_-Key sein.');
  }
  if (key && mode === 'test' && !key.startsWith('sk_test_')) {
    errors.push('STRIPE_TEST_SECRET_KEY muss ein sk_test_-Key sein.');
  }
  if (environment === 'local' && value(env, 'STRIPE_TEST_HOSTED_WEBHOOK_SECRET')) {
    errors.push('STRIPE_TEST_HOSTED_WEBHOOK_SECRET gehört nur in Fly Secrets, nicht in die lokale Laufzeit.');
  }
  if (environment === 'hosted-test') {
    if (value(env, 'STRIPE_TEST_LOCAL_WEBHOOK_SECRET')) {
      errors.push('STRIPE_TEST_LOCAL_WEBHOOK_SECRET gehört nur in die lokale Laufzeit, nicht nach Fly.');
    }
    if (value(env, 'STRIPE_LIVE_SECRET_KEY') || value(env, 'STRIPE_LIVE_WEBHOOK_SECRET')) {
      errors.push('Stripe-Live-Secrets dürfen in der Hosted-Testumgebung nicht vorhanden sein.');
    }
  }
  if (environment === 'production' && (
    value(env, 'STRIPE_TEST_SECRET_KEY') ||
    value(env, 'STRIPE_TEST_LOCAL_WEBHOOK_SECRET') ||
    value(env, 'STRIPE_TEST_HOSTED_WEBHOOK_SECRET')
  )) {
    errors.push('Stripe-Test-Secrets dürfen in der Produktionsumgebung nicht vorhanden sein.');
  }
  return errors;
}

module.exports = {
  APP_ENVIRONMENTS,
  LEGACY_VARIABLES,
  PAYMENT_MODES,
  appEnvironment,
  configuredSecretKey,
  configuredWebhookSecret,
  legacyVariablesPresent,
  livePaymentsEnabled,
  paymentMode,
  validationErrors,
};
