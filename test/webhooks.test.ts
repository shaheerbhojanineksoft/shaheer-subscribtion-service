/**
 * Phase 9 tests — Stripe webhook processing.
 *
 * Covers: initial checkout, duplicate webhooks, multiple subscriptions,
 * recurring payments, payment failure, cancellation, and invalid signatures.
 */
import { describe, expect, test } from 'bun:test';
import {
  BASIC_PRODUCT_ID as PROD_BASIC,
  BASIC_MONTHLY_PRICE_ID as PRICE_BASIC_MONTHLY,
  PRO_PRODUCT_ID as PROD_PRO,
  PRO_MONTHLY_PRICE_ID as PRICE_PRO_MONTHLY,
  PRO_YEARLY_PRICE_ID as PRICE_PRO_YEARLY,
} from '../src/config/plans';
import { StripeWebhookError } from '../src/modules/webhooks/stripe-webhook.service';
import {
  createHarness,
  makeCheckoutSession,
  makeInvoice,
  makeStripeEvent,
  makeSubscription,
  serializeEvent,
  type Harness,
} from './helpers';

const EMAIL = 'user@example.com';

describe('Stripe webhooks', () => {
  test('checkout.session.completed creates exactly one subscription document', async () => {
    const harness: Harness = createHarness();
    const subscription = makeSubscription({ id: 'sub_1', customer: 'cus_1', status: 'active' });
    harness.addSubscription(subscription);

    const session = makeCheckoutSession({
      id: 'cs_1',
      subscription: 'sub_1',
      customer: 'cus_1',
      email: EMAIL,
      amountTotal: 2900,
      currency: 'usd',
    });

    const result = await harness.webhookService.handle(
      serializeEvent(makeStripeEvent('checkout.session.completed', session)),
      'v1,whatever',
    );

    expect(result.received).toBe(true);
    expect(result.duplicate).toBe(false);

    const docs = await harness.repo.findByEmail(EMAIL);
    expect(docs).toHaveLength(1);

    const doc = docs[0];
    expect(doc.email).toBe(EMAIL);
    expect(doc.stripeSubscriptionId).toBe('sub_1');
    expect(doc.stripeCustomerId).toBe('cus_1');
    expect(doc.productId).toBe(PROD_BASIC);
    expect(doc.priceId).toBe(PRICE_BASIC_MONTHLY);
    expect(doc.plan).toBe('basic');
    expect(doc.status).toBe('active');
    expect('userId' in doc).toBe(false); // no userId at this stage
    expect(doc.currentPeriodEnd).not.toBeNull();

    // Activation email was sent.
    const subjects = harness.subjects();
    expect(subjects.some((s) => s.includes('is active'))).toBe(true);
  });

  test('duplicate delivery of the same event is safely ignored', async () => {
    const harness: Harness = createHarness();
    harness.addSubscription(makeSubscription({ id: 'sub_1', customer: 'cus_1' }));

    const event = makeStripeEvent(
      'checkout.session.completed',
      makeCheckoutSession({ id: 'cs_1', subscription: 'sub_1', customer: 'cus_1', email: EMAIL }),
    );
    const payload = serializeEvent(event);

    const first = await harness.webhookService.handle(payload, 'v1,whatever');
    const second = await harness.webhookService.handle(payload, 'v1,whatever');

    expect(first.duplicate).toBe(false);
    expect(second.duplicate).toBe(true);

    const docs = await harness.repo.findByEmail(EMAIL);
    expect(docs).toHaveLength(1);

    // Only one activation email.
    const activations = harness.subjects().filter((s) => s.includes('is active'));
    expect(activations).toHaveLength(1);
  });

  test('checkout.session.completed + customer.subscription.created → one document, one email', async () => {
    const harness: Harness = createHarness();
    const subscription = makeSubscription({ id: 'sub_1', customer: 'cus_1', status: 'active' });
    harness.addSubscription(subscription);

    await harness.webhookService.handle(
      serializeEvent(
        makeStripeEvent(
          'checkout.session.completed',
          makeCheckoutSession({ id: 'cs_1', subscription: 'sub_1', customer: 'cus_1', email: EMAIL }),
        ),
      ),
      'v1,whatever',
    );

    await harness.webhookService.handle(
      serializeEvent(makeStripeEvent('customer.subscription.created', subscription)),
      'v1,whatever',
    );

    const docs = await harness.repo.findByEmail(EMAIL);
    expect(docs).toHaveLength(1);
    expect(harness.subjects().filter((s) => s.includes('is active'))).toHaveLength(1);
  });

  test('a second purchase for the same email creates a second document (never overwrites)', async () => {
    const harness: Harness = createHarness();
    harness.addSubscription(makeSubscription({ id: 'sub_basic', customer: 'cus_1', status: 'active' }));
    harness.addSubscription(
      makeSubscription({
        id: 'sub_pro',
        customer: 'cus_1',
        status: 'active',
        productId: PROD_PRO,
        priceId: PRICE_PRO_MONTHLY,
        interval: 'month',
      }),
    );

    await harness.webhookService.handle(
      serializeEvent(
        makeStripeEvent(
          'checkout.session.completed',
          makeCheckoutSession({ id: 'cs_basic', subscription: 'sub_basic', customer: 'cus_1', email: EMAIL }),
        ),
      ),
      'v1,whatever',
    );
    await harness.webhookService.handle(
      serializeEvent(
        makeStripeEvent(
          'checkout.session.completed',
          makeCheckoutSession({ id: 'cs_pro', subscription: 'sub_pro', customer: 'cus_1', email: EMAIL }),
        ),
      ),
      'v1,whatever',
    );

    const docs = await harness.repo.findByEmail(EMAIL);
    expect(docs).toHaveLength(2);
    expect(docs.map((d) => d.stripeSubscriptionId).sort()).toEqual(['sub_basic', 'sub_pro']);

    // Newest (Pro) grants authority; older Basic is still stored.
    const entitlement = await harness.entitlement.getEffectiveEntitlement(EMAIL);
    expect(entitlement.active).toBe(true);
    expect(entitlement.plan).toBe('pro');
  });

  test('buying a second plan immediately unsubscribes the older active subscription on Stripe', async () => {
    const harness: Harness = createHarness();
    harness.addSubscription(
      makeSubscription({
        id: 'sub_basic',
        customer: 'cus_1',
        status: 'active',
        productId: PROD_BASIC,
        priceId: PRICE_BASIC_MONTHLY,
      }),
    );
    harness.addSubscription(
      makeSubscription({
        id: 'sub_pro',
        customer: 'cus_1',
        status: 'active',
        productId: PROD_PRO,
        priceId: PRICE_PRO_MONTHLY,
        interval: 'month',
      }),
    );

    // Purchase 1: Basic.
    await harness.webhookService.handle(
      serializeEvent(
        makeStripeEvent(
          'checkout.session.completed',
          makeCheckoutSession({ id: 'cs_basic', subscription: 'sub_basic', customer: 'cus_1', email: EMAIL }),
        ),
      ),
      'v1,whatever',
    );
    expect(harness.canceledSubscriptions).toEqual([]); // nothing older to cancel yet

    // Purchase 2: Pro — the older active Basic must be unsubscribed on Stripe.
    await harness.webhookService.handle(
      serializeEvent(
        makeStripeEvent(
          'checkout.session.completed',
          makeCheckoutSession({ id: 'cs_pro', subscription: 'sub_pro', customer: 'cus_1', email: EMAIL }),
        ),
      ),
      'v1,whatever',
    );

    // Only the OLD subscription was cancelled; the new one stays untouched.
    expect(harness.canceledSubscriptions).toEqual(['sub_basic']);

    // The old document is preserved for history (never deleted).
    const docs = await harness.repo.findByEmail(EMAIL);
    expect(docs.map((d) => d.stripeSubscriptionId).sort()).toEqual(['sub_basic', 'sub_pro']);

    // Authority comes only from the newest (Pro).
    const entitlement = await harness.entitlement.getEffectiveEntitlement(EMAIL);
    expect(entitlement.active).toBe(true);
    expect(entitlement.plan).toBe('pro');
  });

  test('invoice.paid refreshes the period on the existing document (no new document)', async () => {
    const harness: Harness = createHarness();
    const now = Math.floor(Date.now() / 1000);
    const oldEnd = now + 30 * 24 * 60 * 60;

    const subscription = makeSubscription({
      id: 'sub_1',
      customer: 'cus_1',
      status: 'active',
      currentPeriodEnd: oldEnd,
    });
    harness.addSubscription(subscription);

    // Initial checkout.
    await harness.webhookService.handle(
      serializeEvent(
        makeStripeEvent(
          'checkout.session.completed',
          makeCheckoutSession({ id: 'cs_1', subscription: 'sub_1', customer: 'cus_1', email: EMAIL }),
        ),
      ),
      'v1,whatever',
    );

    // Simulate Stripe rolling the subscription period forward after renewal.
    const newStart = oldEnd;
    const newEnd = newStart + 30 * 24 * 60 * 60;
    const renewed = makeSubscription({
      id: 'sub_1',
      customer: 'cus_1',
      status: 'active',
      currentPeriodStart: newStart,
      currentPeriodEnd: newEnd,
    });
    harness.addSubscription(renewed); // same id — updated retrieval

    await harness.webhookService.handle(
      serializeEvent(
        makeStripeEvent(
          'invoice.paid',
          makeInvoice({
            id: 'in_renewal',
            subscription: 'sub_1',
            customer: 'cus_1',
            amountPaid: 2900,
            amountDue: 2900,
            currency: 'usd',
            billingReason: 'subscription_cycle',
          }),
        ),
      ),
      'v1,whatever',
    );

    const docs = await harness.repo.findByEmail(EMAIL);
    expect(docs).toHaveLength(1); // no duplicate on renewal

    const doc = docs[0];
    expect(doc.currentPeriodEnd?.getTime()).toBe(newEnd * 1000);
    expect(doc.currentPeriodStart?.getTime()).toBe(newStart * 1000);
    expect(doc.status).toBe('active');

    // A renewal (non-initial) email was sent.
    expect(harness.subjects().some((s) => s.includes('Payment received'))).toBe(true);
  });

  test('invoice.paid with billing_reason subscription_create sends no renewal email', async () => {
    const harness: Harness = createHarness();
    harness.addSubscription(makeSubscription({ id: 'sub_1', customer: 'cus_1' }));

    await harness.webhookService.handle(
      serializeEvent(
        makeStripeEvent(
          'invoice.paid',
          makeInvoice({
            id: 'in_first',
            subscription: 'sub_1',
            customer: 'cus_1',
            amountPaid: 2900,
            billingReason: 'subscription_create',
          }),
        ),
      ),
      'v1,whatever',
    );

    expect(harness.subjects().some((s) => s.includes('Payment received'))).toBe(false);
  });

  test('invoice.payment_failed updates status and notifies without deleting the document', async () => {
    const harness: Harness = createHarness();
    const subscription = makeSubscription({ id: 'sub_1', customer: 'cus_1', status: 'active' });
    harness.addSubscription(subscription);

    await harness.webhookService.handle(
      serializeEvent(
        makeStripeEvent(
          'checkout.session.completed',
          makeCheckoutSession({ id: 'cs_1', subscription: 'sub_1', customer: 'cus_1', email: EMAIL }),
        ),
      ),
      'v1,whatever',
    );

    // Stripe now considers the subscription past_due.
    harness.addSubscription(makeSubscription({ id: 'sub_1', customer: 'cus_1', status: 'past_due' }));

    await harness.webhookService.handle(
      serializeEvent(
        makeStripeEvent(
          'invoice.payment_failed',
          makeInvoice({
            id: 'in_failed',
            subscription: 'sub_1',
            customer: 'cus_1',
            amountDue: 2900,
            currency: 'usd',
            billingReason: 'subscription_cycle',
            status: 'open',
          }),
        ),
      ),
      'v1,whatever',
    );

    const docs = await harness.repo.findByEmail(EMAIL);
    expect(docs).toHaveLength(1); // preserved
    expect(docs[0]?.status).toBe('past_due');

    const failureEmails = harness.subjects().filter((s) => s.includes('Payment failed'));
    expect(failureEmails).toHaveLength(1);
  });

  test('customer.subscription.deleted preserves the document and marks it canceled', async () => {
    const harness: Harness = createHarness();
    harness.addSubscription(
      makeSubscription({
        id: 'sub_basic',
        customer: 'cus_1',
        status: 'active',
        productId: PROD_BASIC,
        priceId: PRICE_BASIC_MONTHLY,
      }),
    );
    harness.addSubscription(
      makeSubscription({
        id: 'sub_pro',
        customer: 'cus_1',
        status: 'active',
        productId: PROD_PRO,
        priceId: PRICE_PRO_MONTHLY,
      }),
    );

    // Purchase both.
    await harness.webhookService.handle(
      serializeEvent(
        makeStripeEvent(
          'checkout.session.completed',
          makeCheckoutSession({ id: 'cs_basic', subscription: 'sub_basic', customer: 'cus_1', email: EMAIL }),
        ),
      ),
      'v1,whatever',
    );
    await harness.webhookService.handle(
      serializeEvent(
        makeStripeEvent(
          'checkout.session.completed',
          makeCheckoutSession({ id: 'cs_pro', subscription: 'sub_pro', customer: 'cus_1', email: EMAIL }),
        ),
      ),
      'v1,whatever',
    );

    // The newest (Pro) subscription is deleted on Stripe.
    harness.addSubscription(
      makeSubscription({
        id: 'sub_pro',
        customer: 'cus_1',
        status: 'canceled',
        productId: PROD_PRO,
        priceId: PRICE_PRO_MONTHLY,
      }),
    );
    await harness.webhookService.handle(
      serializeEvent(makeStripeEvent('customer.subscription.deleted', makeSubscription({
        id: 'sub_pro',
        customer: 'cus_1',
        status: 'canceled',
        productId: PROD_PRO,
        priceId: PRICE_PRO_MONTHLY,
      }))),
      'v1,whatever',
    );

    // Both documents remain (historical record preserved).
    const docs = await harness.repo.findByEmail(EMAIL);
    expect(docs).toHaveLength(2);
    const pro = await harness.repo.findByStripeSubscriptionId('sub_pro');
    expect(pro?.status).toBe('canceled');

    // Newest is canceled → NO ACTIVE AUTHORITY, even though Basic is still active.
    const entitlement = await harness.entitlement.getEffectiveEntitlement(EMAIL);
    expect(entitlement.active).toBe(false);
    expect(entitlement.reason).toBe('newest_inactive');
  });

  test('customer.subscription.updated reflects a price/plan change on the existing document', async () => {
    const harness: Harness = createHarness();
    harness.addSubscription(
      makeSubscription({
        id: 'sub_1',
        customer: 'cus_1',
        status: 'active',
        productId: PROD_BASIC,
        priceId: PRICE_BASIC_MONTHLY,
      }),
    );

    await harness.webhookService.handle(
      serializeEvent(
        makeStripeEvent(
          'checkout.session.completed',
          makeCheckoutSession({ id: 'cs_1', subscription: 'sub_1', customer: 'cus_1', email: EMAIL }),
        ),
      ),
      'v1,whatever',
    );

    // Customer upgraded the same subscription to Pro.
    const upgraded = makeSubscription({
      id: 'sub_1',
      customer: 'cus_1',
      status: 'active',
      productId: PROD_PRO,
      priceId: PRICE_PRO_YEARLY,
      interval: 'year',
      cancelAtPeriodEnd: true,
    });
    await harness.webhookService.handle(
      serializeEvent(makeStripeEvent('customer.subscription.updated', upgraded)),
      'v1,whatever',
    );

    const docs = await harness.repo.findByEmail(EMAIL);
    expect(docs).toHaveLength(1); // no duplicate document
    expect(docs[0]?.productId).toBe(PROD_PRO);
    expect(docs[0]?.priceId).toBe(PRICE_PRO_YEARLY);
    expect(docs[0]?.plan).toBe('pro');
    expect(docs[0]?.billingInterval).toBe('year');
    expect(docs[0]?.cancelAtPeriodEnd).toBe(true);
  });

  test('an invalid webhook signature is rejected', async () => {
    const harness: Harness = createHarness();
    // Simulate Stripe's signature verification failing.
    (harness.stripe.webhooks as { constructEventAsync: unknown }).constructEventAsync = async () => {
      throw new Error('No signatures found matching the expected signature');
    };

    const payload = serializeEvent(
      makeStripeEvent('invoice.paid', makeInvoice({ id: 'in_1', subscription: 'sub_1' })),
    );

    await expect(harness.webhookService.handle(payload, 'v1,bad')).rejects.toBeInstanceOf(
      StripeWebhookError,
    );
  });
});
