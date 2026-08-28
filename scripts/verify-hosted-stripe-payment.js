'use strict';

const path = require('node:path');
const Stripe = require('stripe');

require('dotenv').config({ path: path.join(__dirname, '..', '.env') });
const db = require('../src/db');
const {
  STRIPE_WEBHOOK_EVENTS,
  assertHostedStripeSafety,
  hasExactEvents,
} = require('./configure-stripe-webhook');

function option(argv, name) {
  const index = argv.indexOf(name);
  return index === -1 ? '' : String(argv[index + 1] || '');
}

function validateSessionId(value) {
  if (!/^cs_test_[A-Za-z0-9_]+$/.test(String(value || ''))) {
    throw new Error('--session muss eine vollständige cs_test_... Checkout-Session enthalten.');
  }
  return String(value);
}

function validateDestination(endpoints, webhookUrl) {
  const matching = endpoints.filter((endpoint) => endpoint.url === webhookUrl);
  if (matching.length !== 1 || matching[0].status !== 'enabled' || !hasExactEvents(matching[0])) {
    throw new Error('Der Stripe-Hosted-Webhook fehlt, ist doppelt, deaktiviert oder zu breit konfiguriert.');
  }
  return matching[0];
}

function validateStripeSession(session) {
  if (session.livemode || session.mode !== 'payment' || session.status !== 'complete' ||
      session.payment_status !== 'paid' || session.metadata?.checkoutMode !== 'test' ||
      !/^\d+$/.test(String(session.metadata?.orderId || '')) || !session.metadata?.eventSlug) {
    throw new Error('Die Stripe-Session ist keine vollständig bezahlte Wolkenworte-Testzahlung.');
  }
  return session;
}

function acceptedState({ session, order, confirmation, emailJobs, stripeEvent }) {
  const paymentIntentId = typeof session.payment_intent === 'string'
    ? session.payment_intent : session.payment_intent?.id;
  const confirmationJob = emailJobs.find((job) => job.kind === 'order_confirmation');
  return Boolean(
    order?.status === 'paid_test' &&
    order.mode === 'test' &&
    order.stripe_payment_intent_id === paymentIntentId &&
    order.fulfillment_status === 'mocked' &&
    order.fulfillment_mode === 'mock' &&
    confirmation?.paymentConfirmed === true &&
    confirmation.status === 'paid_test' &&
    confirmation.fulfillmentStatus === 'mocked' &&
    confirmation.mode === 'test' &&
    confirmation.totalCents === session.amount_total &&
    confirmationJob?.status === 'delivered' &&
    String(confirmationJob.provider_message_id || '').startsWith('mock-') &&
    stripeEvent?.pending_webhooks === 0
  );
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function run({ argv = process.argv, env = process.env, output = console.log } = {}) {
  const sessionId = validateSessionId(option(argv, '--session'));
  const { key, webhookUrl } = assertHostedStripeSafety(env);
  const publicOrigin = new URL(webhookUrl).origin;
  const stripe = new Stripe(key);
  const endpoints = await stripe.webhookEndpoints.list({ limit: 100 });
  validateDestination(endpoints.data, webhookUrl);
  const session = validateStripeSession(await stripe.checkout.sessions.retrieve(sessionId));
  const createdAfter = Math.max(0, Number(session.created || 0) - 300);
  const events = await stripe.events.list({
    limit: 100,
    created: { gte: createdAfter },
    types: STRIPE_WEBHOOK_EVENTS.filter((event) => event.startsWith('checkout.session.')),
  });
  const stripeEvent = events.data.find((event) => event.data?.object?.id === session.id);
  if (!stripeEvent) throw new Error('Für die Checkout-Session wurde kein Stripe-Zahlungsevent gefunden.');

  const eventSlug = session.metadata.eventSlug;
  const confirmationUrl = `${publicOrigin}/api/events/${encodeURIComponent(eventSlug)}` +
    `/orders/status?session_id=${encodeURIComponent(session.id)}`;
  const deadline = Date.now() + 120_000;
  let order;
  let confirmation;
  let emailJobs = [];
  let responseStatus = 0;
  while (Date.now() < deadline) {
    order = await db.getOrderBySessionId(session.id);
    if (order) emailJobs = await db.getEmailJobsForOrder(order.id);
    try {
      const response = await fetch(confirmationUrl, { cache: 'no-store' });
      responseStatus = response.status;
      if (response.ok) confirmation = await response.json();
    } catch { /* Fly may still be waking; retry within the fixed bound. */ }
    if (acceptedState({ session, order, confirmation, emailJobs, stripeEvent })) break;
    await delay(1_000);
  }
  if (!acceptedState({ session, order, confirmation, emailJobs, stripeEvent })) {
    throw new Error('Die echte Stripe-Testzahlung wurde nicht vollständig in Wolkenworte abgeschlossen.');
  }
  const result = {
    destination: 'enabled',
    stripeSession: 'paid',
    stripeDelivery: 'complete',
    wolkenworteOrder: order.status,
    fulfillment: order.fulfillment_status,
    transactionalEmail: 'mocked',
    confirmationApi: responseStatus,
  };
  output(JSON.stringify(result, null, 2));
  return result;
}

if (require.main === module) {
  run()
    .catch((error) => {
      console.error('[stripe-hosted] Prüfung fehlgeschlagen:', error.message);
      process.exitCode = 1;
    })
    .finally(() => db.closePool().catch(() => {}));
}

module.exports = {
  acceptedState,
  option,
  run,
  validateDestination,
  validateSessionId,
  validateStripeSession,
};
