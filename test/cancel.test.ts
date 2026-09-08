/**
 * Tests — POST /subscriptions/cancel behaviour (service level).
 */
import { describe, expect, test } from 'bun:test';
import { SubscriptionNotFoundError } from '../src/modules/subscriptions/subscription.service';
import {
  createHarness,
  makeStripeEvent,
  makeSubscription,
  serializeEvent,
  type Harness,
} from './helpers';

const EMAIL = 'user@example.com';

/** Simulate a successful active subscription for an email via the webhook flow. */
async function createActiveSubscription(harness: Harness, stripeSubscriptionId: string): Promise<void> {
  // Make sure Stripe resolves the customer to OUR test email.
  harness.addCustomer({ id: 'cus_1', email: EMAIL });
  const subscription = makeSubscription({
    id: stripeSubscriptionId,
    customerObject: { id: 'cus_1', email: EMAIL },
    status: 'active',
  });
  harness.addSubscription(subscription);
  await harness.webhookService.handle(
    serializeEvent(makeStripeEvent('customer.subscription.created', subscription)),
    'v1,whatever',
  );
}

describe('cancelSubscription', () => {
  test('cancels an active subscription on Stripe and marks the MongoDB doc canceled', async () => {
    const harness: Harness = createHarness();
    await createActiveSubscription(harness, 'sub_1');

    const result = await harness.subscriptionService.cancelSubscription({
      email: EMAIL,
      stripeSubscriptionId: 'sub_1',
    });

    expect(result.canceled).toBe(true);
    expect(result.reason).toBe('canceled');
    expect(harness.canceledSubscriptions).toEqual(['sub_1']); // Stripe cancel called

    const doc = await harness.repo.findByStripeSubscriptionId('sub_1');
    expect(doc?.status).toBe('canceled');
    // Record is preserved (never deleted).
    expect(doc?.email).toBe(EMAIL);
  });

  test('rejects when no MongoDB record exists', async () => {
    const harness: Harness = createHarness();

    await expect(
      harness.subscriptionService.cancelSubscription({ email: EMAIL, stripeSubscriptionId: 'sub_missing' }),
    ).rejects.toBeInstanceOf(SubscriptionNotFoundError);
  });

  test('rejects when the record belongs to a different email', async () => {
    const harness: Harness = createHarness();
    await createActiveSubscription(harness, 'sub_1');

    await expect(
      harness.subscriptionService.cancelSubscription({
        email: 'someone-else@example.com',
        stripeSubscriptionId: 'sub_1',
      }),
    ).rejects.toBeInstanceOf(SubscriptionNotFoundError);
  });

  test('does nothing (already_inactive) when Stripe no longer considers it active', async () => {
    const harness: Harness = createHarness();
    await createActiveSubscription(harness, 'sub_1');

    // Stripe now reports the subscription canceled.
    harness.addSubscription(
      makeSubscription({ id: 'sub_1', customerObject: { id: 'cus_1', email: EMAIL }, status: 'canceled' }),
    );

    const result = await harness.subscriptionService.cancelSubscription({
      email: EMAIL,
      stripeSubscriptionId: 'sub_1',
    });

    expect(result.canceled).toBe(false);
    expect(result.reason).toBe('already_inactive');
    expect(harness.canceledSubscriptions).toEqual([]); // no Stripe cancel call

    const doc = await harness.repo.findByStripeSubscriptionId('sub_1');
    expect(doc?.status).toBe('canceled'); // synced from Stripe
  });
});
