'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { startTestServer, createEvent, productDesignPayload } = require('./helpers');

async function storedEvent(db, baseUrl, name) {
  const created = await createEvent(baseUrl, { title: name });
  return { created, row: await db.getEventBySlug(created.slug) };
}

async function configurationFor(db, eventId, productKey = 'white-glossy-mug-duo-11oz') {
  const dimensions = productKey === 'cork-back-coaster'
    ? { variantId: 15662, width: 1181, height: 1181 }
    : { variantId: 1320, width: 2700, height: 1050 };
  return db.createConfiguration({
    eventId,
    productKey,
    printfulVariantId: dimensions.variantId,
    quantity: 2,
    unitPriceCents: 0,
    theme: 'pastel',
    words: [['liebe', 1]],
    design: { version: 2, surfaces: productDesignPayload(productKey).designs },
    printWidth: dimensions.width,
    printHeight: dimensions.height,
  });
}

async function quoteFor(db, eventId, configurations) {
  const items = configurations.map((configuration) => ({
    configurationId: configuration.id,
    quantity: 1,
  }));
  return db.createCheckoutQuote({
    eventId,
    configurationId: configurations[0].id,
    configurationIds: configurations.map((configuration) => configuration.id),
    shipments: [{
      quantity: items.length,
      items,
      recipient: {
        name: 'Postgres Test',
        address1: 'Teststraße 1',
        city: 'Berlin',
        zip: '10115',
        country_code: 'DE',
      },
      printfulCosts: { currency: 'EUR', subtotal: 10, shipping: 5, vat: 2.85, total: 17.85 },
      customerCosts: { shippingCents: 500, taxCents: 380 },
    }],
    quote: {
      currency: 'EUR',
      quantity: items.length,
      itemsCents: 2000,
      paymentReserveCents: 100,
      shippingCents: 500,
      taxCents: 380,
      totalCents: 2980,
    },
  });
}

test('Postgres foundation preserves concurrency, ownership and checkout durability', async (t) => {
  const { baseUrl, close } = await startTestServer();
  t.after(close);
  const db = require('../src/db');

  await t.test('uses the migrated Postgres schema and opaque bigint ids', async () => {
    const schema = await db.getPool().query(`
      SELECT column_name, data_type, is_nullable
      FROM information_schema.columns
      WHERE table_schema = current_schema()
        AND table_name IN ('events', 'configurations', 'orders', 'order_items')
    `);
    const byColumn = new Map(schema.rows.map((column) => [column.column_name, column]));
    assert.equal(byColumn.get('expires_at').data_type, 'timestamp with time zone');
    assert.equal(byColumn.get('title').is_nullable, 'NO');
    assert.equal(byColumn.has('couple_name'), false);
    assert.equal(byColumn.get('subtitle').is_nullable, 'YES');
    assert.equal(byColumn.has('event_label'), false);
    assert.equal(byColumn.get('event_title_snapshot').is_nullable, 'NO');
    assert.equal(byColumn.has('event_label_snapshot'), false);
    assert.equal(byColumn.get('design_json').data_type, 'jsonb');
    assert.equal(byColumn.get('configuration_snapshot_json').data_type, 'jsonb');
    assert.equal(byColumn.get('buyer_email').is_nullable, 'YES');

    const { row } = await storedEvent(db, baseUrl, 'Opaque Ida & Postgres Paul');
    assert.equal(typeof row.id, 'string');
    assert.equal(
      Date.parse(row.expires_at) - Date.parse(row.created_at),
      365 * 24 * 60 * 60 * 1000
    );
    const productionDb = fs.readFileSync(path.join(__dirname, '..', 'src', 'db.js'), 'utf8');
    assert.doesNotMatch(productionDb, /node:sqlite|DatabaseSync|PRAGMA/);
  });

  await t.test('concurrent identical submissions produce the exact aggregate', async () => {
    const { row: event } = await storedEvent(db, baseUrl, 'Parallel Paula & Atomic Anton');
    const owner = 'a'.repeat(32);
    const receipts = await Promise.all(
      Array.from({ length: 12 }, () => db.addWordContribution(event.id, 'liebe', owner))
    );
    assert.equal(new Set(receipts).size, 12);
    assert.deepEqual(await db.getWords(event.id), [['liebe', 12]]);
    assert.equal((await db.getWordContributions(event.id, owner)).length, 12);
  });

  await t.test('concurrent owned removals reach zero without foreign removal', async () => {
    const { row: event } = await storedEvent(db, baseUrl, 'Receipt Rita & Owner Otto');
    const owner = 'b'.repeat(32);
    const receipts = await Promise.all(
      Array.from({ length: 12 }, () => db.addWordContribution(event.id, 'treue', owner))
    );
    assert.equal(await db.removeWordContribution(event.id, receipts[0], 'c'.repeat(32)), null);
    const removed = await Promise.all(
      receipts.map((receipt) => db.removeWordContribution(event.id, receipt, owner))
    );
    assert.equal(removed.filter((word) => word === 'treue').length, 12);
    assert.deepEqual(await db.getWords(event.id), []);
    assert.equal(await db.removeWordContribution(event.id, receipts[0], owner), null);
  });

  await t.test('reset and submission serialize as whole transactions', async () => {
    const { row: event } = await storedEvent(db, baseUrl, 'Reset Ria & Submit Sam');
    const owner = 'd'.repeat(32);
    await Promise.all(
      Array.from({ length: 10 }, () => db.addWordContribution(event.id, 'glück', owner))
    );
    await Promise.all([
      db.archiveAndClearWords(event.id),
      db.addWordContribution(event.id, 'glück', owner),
    ]);
    const finalWords = await db.getWords(event.id);
    const archive = await db.getPool().query(`
      SELECT words_json
      FROM archives
      WHERE event_id = $1
      ORDER BY id DESC
      LIMIT 1
    `, [event.id]);
    const archivedCount = archive.rows[0].words_json
      .find(([word]) => word === 'glück')?.[1] || 0;
    const finalCount = finalWords.find(([word]) => word === 'glück')?.[1] || 0;
    assert.equal(archivedCount + finalCount, 11);
    assert.ok(
      (archivedCount === 10 && finalCount === 1) ||
      (archivedCount === 11 && finalCount === 0)
    );
  });

  await t.test('one quote creates one order and normalized immutable order items', async () => {
    const { row: event } = await storedEvent(db, baseUrl, 'Order Olga & Item Ivan');
    const configurations = await Promise.all([
      configurationFor(db, event.id),
      configurationFor(db, event.id, 'cork-back-coaster'),
    ]);
    const quote = await quoteFor(db, event.id, configurations);
    const attempts = await Promise.all([
      db.createCheckoutOrder({ eventId: event.id, configurationId: configurations[0].id, quote }),
      db.createCheckoutOrder({ eventId: event.id, configurationId: configurations[0].id, quote }),
    ]);
    assert.equal(attempts.filter((attempt) => attempt.created).length, 1);
    assert.equal(new Set(attempts.map((attempt) => attempt.order.id)).size, 1);
    const items = await db.getOrderItems(attempts[0].order.id);
    assert.equal(items.length, 2);
    assert.deepEqual(items.map((item) => item.configuration_id), configurations.map((item) => item.id));
    for (const item of items) {
      const snapshot = JSON.parse(item.configuration_snapshot_json);
      assert.equal(snapshot.configurationId, item.configuration_id);
      assert.ok(snapshot.design);
      assert.ok(snapshot.printWidth > 0);
      assert.ok(Array.isArray(snapshot.printfulPlacements));
    }
  });

  await t.test('quote cleanup racing order creation never leaves a dangling order', async () => {
    const { row: event } = await storedEvent(db, baseUrl, 'Cleanup Clara & Checkout Chris');
    const configuration = await configurationFor(db, event.id);
    const quote = await quoteFor(db, event.id, [configuration]);
    await db.getPool().query(
      "UPDATE checkout_quotes SET expires_at = transaction_timestamp() - interval '2 days' WHERE id = $1",
      [quote.id]
    );
    const [cleanup, checkout] = await Promise.allSettled([
      db.cleanupAbandonedQuotes(),
      db.createCheckoutOrder({ eventId: event.id, configurationId: configuration.id, quote }),
    ]);
    assert.equal(cleanup.status, 'fulfilled');
    const [storedQuote, storedOrder] = await Promise.all([
      db.getCheckoutQuote(quote.id),
      db.getOrderByQuoteId(quote.id),
    ]);
    if (checkout.status === 'fulfilled') {
      assert.ok(storedQuote);
      assert.ok(storedOrder);
    } else {
      assert.equal(storedQuote, null);
      assert.equal(storedOrder, null);
    }
  });

  await t.test('route recovery reuses one provider Session after attach interruption', async () => {
    const { row: event } = await storedEvent(db, baseUrl, 'Route Recovery Rosa & Stripe Ralf');
    const configuration = await configurationFor(db, event.id);
    const printful = require('../src/printful');
    const stripe = require('../src/stripe');
    const originalCountries = printful.getShippingCountries;
    const originalEstimate = printful.estimateOrderCosts;
    const originalCheckout = stripe.createCheckoutSession;
    const originalAttach = db.attachStripeSession;
    const providerSessions = new Map();
    const attempts = [];
    let interruptAttach = true;
    printful.getShippingCountries = async () => [
      { code: 'DE', name: 'Germany', region: 'europe', states: [] },
    ];
    printful.estimateOrderCosts = async () => ({
      currency: 'EUR', subtotal: 10.98, shipping: 4.49, tax: 0, vat: 2.94, total: 18.41,
    });
    stripe.createCheckoutSession = async (options) => {
      attempts.push(options);
      const key = options.order.stripe_idempotency_key;
      if (!providerSessions.has(key)) {
        providerSessions.set(key, {
          id: 'cs_test_one_recovered_provider_session',
          url: 'https://checkout.stripe.test/recovered',
        });
      }
      return providerSessions.get(key);
    };
    db.attachStripeSession = async (...args) => {
      if (interruptAttach) {
        interruptAttach = false;
        throw new Error('forced interruption after Stripe accepted');
      }
      return originalAttach(...args);
    };

    try {
      const estimate = await fetch(
        `${baseUrl}/api/events/${event.slug}/configurations/${configuration.id}/estimate-costs`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            recipient: {
              name: 'Route Recovery',
              address1: 'Teststraße 2',
              city: 'Berlin',
              zip: '10115',
              country_code: 'DE',
            },
          }),
        }
      );
      assert.equal(estimate.status, 200);
      const { quote } = await estimate.json();
      const checkoutUrl = `${baseUrl}/api/events/${event.slug}/configurations/${configuration.id}/checkout`;
      const request = () => fetch(checkoutUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ quoteId: quote.id }),
      });
      const interrupted = await request();
      assert.equal(interrupted.status, 500);
      const recovered = await request();
      assert.equal(recovered.status, 200);
      assert.deepEqual(await recovered.json(), {
        url: 'https://checkout.stripe.test/recovered',
        recovered: true,
      });
      assert.equal(providerSessions.size, 1, 'provider idempotency produced one Stripe Session');
      assert.equal(attempts.length, 2, 'the ambiguous request was retried once');
      assert.equal(
        attempts[0].order.stripe_idempotency_key,
        attempts[1].order.stripe_idempotency_key
      );
      assert.equal(
        attempts[0].order.checkout_request_json,
        attempts[1].order.checkout_request_json
      );
      const stored = await db.getOrderBySessionId('cs_test_one_recovered_provider_session');
      assert.equal(stored.status, 'checkout_pending');
      assert.equal(stored.checkout_attempts, 2);
    } finally {
      printful.getShippingCountries = originalCountries;
      printful.estimateOrderCosts = originalEstimate;
      stripe.createCheckoutSession = originalCheckout;
      db.attachStripeSession = originalAttach;
    }
  });

  await t.test('ambiguous Stripe create reuses frozen inputs and webhook reconciliation attaches it once', async () => {
    const { row: event } = await storedEvent(db, baseUrl, 'Crash Carla & Stripe Sven');
    const configuration = await configurationFor(db, event.id);
    const quote = await quoteFor(db, event.id, [configuration]);
    const frozenRequest = {
      products: [{ key: 'white-glossy-mug-duo-11oz' }],
      slug: event.slug,
      configurationIds: [configuration.id],
      quoteId: quote.id,
      quantity: 1,
      shipmentCount: 1,
      baseUrl: 'https://wolkenworte.example',
      locale: 'de',
    };
    const { order } = await db.createCheckoutOrder({
      eventId: event.id,
      configurationId: configuration.id,
      quote,
      checkoutRequest: frozenRequest,
    });
    const firstClaim = await db.claimCheckoutAttempt(order.id);
    assert.ok(firstClaim);
    await db.markCheckoutCreationFailed(order.id, new Error('forced interruption after provider acceptance'));
    const retryClaim = await db.claimCheckoutAttempt(order.id);
    assert.equal(retryClaim.stripe_idempotency_key, firstClaim.stripe_idempotency_key);
    assert.equal(retryClaim.checkout_session_expires_at, firstClaim.checkout_session_expires_at);
    assert.deepEqual(
      JSON.parse(retryClaim.checkout_request_json),
      JSON.parse(firstClaim.checkout_request_json)
    );

    const stripeSessionId = 'cs_test_reconciled_crash_window';
    const results = await Promise.all([
      db.recordSuccessfulPayment({
        stripeEventId: 'evt_reconciled_crash_window',
        eventType: 'checkout.session.completed',
        stripeSessionId,
        paymentIntentId: 'pi_reconciled_crash_window',
        livemode: false,
        orderId: order.id,
        quoteId: quote.id,
        amountTotal: 2980,
        currency: 'eur',
        paymentStatus: 'paid',
        buyerEmail: 'buyer@example.test',
      }),
      db.recordSuccessfulPayment({
        stripeEventId: 'evt_reconciled_crash_window',
        eventType: 'checkout.session.completed',
        stripeSessionId,
        paymentIntentId: 'pi_reconciled_crash_window',
        livemode: false,
        orderId: order.id,
        quoteId: quote.id,
        amountTotal: 2980,
        currency: 'eur',
        paymentStatus: 'paid',
        buyerEmail: 'buyer@example.test',
      }),
    ]);
    assert.deepEqual(results.map((result) => result.duplicate).sort(), [false, true]);
    const paid = await db.getOrderBySessionId(stripeSessionId);
    assert.equal(paid.id, order.id);
    assert.equal(paid.status, 'paid_test');
    assert.equal(paid.buyer_email, 'buyer@example.test');
    const publicStatus = await fetch(
      `${baseUrl}/api/events/${event.slug}/orders/status?session_id=${stripeSessionId}`
    );
    assert.equal(publicStatus.status, 200);
    assert.doesNotMatch(await publicStatus.text(), /buyer@example\.test/);
  });
});
