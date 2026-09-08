/**
 * Phase 9 tests — checkout flow and plan/interval validation.
 */
import { describe, expect, test } from 'bun:test';
import {
  PRO_PRODUCT_ID as PROD_PRO,
  PRO_MONTHLY_PRICE_ID as PRICE_PRO_MONTHLY,
  PRO_YEARLY_PRICE_ID as PRICE_PRO_YEARLY,
} from '../src/config/plans';
import { CheckoutValidationError } from '../src/modules/checkout/checkout.service';
import { createHarness, type Harness } from './helpers';

describe('CheckoutService', () => {
  test('creates a subscription Checkout session from a plan name + interval', async () => {
    const harness: Harness = createHarness();

    const result = await harness.checkout.createCheckoutSession({
      email: 'User@Example.com',
      plan: 'pro',
      billingInterval: 'year',
    });

    expect(result.id).toBe('cs_test_1');
    expect(result.url).toContain('https://checkout.stripe.com');
    expect(result.email).toBe('user@example.com'); // normalized
    expect(result.plan).toBe('pro');
    expect(result.billingInterval).toBe('year');
    expect(result.productId).toBe(PROD_PRO);
    // The backend resolved the Stripe price — the client never sends it.
    expect(result.priceId).toBe(PRICE_PRO_YEARLY);
  });

  test('defaults to the monthly price when interval is omitted', async () => {
    const harness: Harness = createHarness();
    const result = await harness.checkout.createCheckoutSession({
      email: 'user@example.com',
      plan: 'pro',
    });
    expect(result.billingInterval).toBe('month');
    expect(result.priceId).toBe(PRICE_PRO_MONTHLY);
  });

  test('rejects an unknown plan name', async () => {
    const harness: Harness = createHarness();

    await expect(
      harness.checkout.createCheckoutSession({ email: 'user@example.com', plan: 'hacker' }),
    ).rejects.toBeInstanceOf(CheckoutValidationError);
  });

  test('rejects an invalid billing interval', async () => {
    const harness: Harness = createHarness();

    await expect(
      harness.checkout.createCheckoutSession({
        email: 'user@example.com',
        plan: 'pro',
        billingInterval: 'weekly',
      }),
    ).rejects.toBeInstanceOf(CheckoutValidationError);
  });

  test('rejects an invalid email', async () => {
    const harness: Harness = createHarness();

    await expect(
      harness.checkout.createCheckoutSession({ email: 'not-an-email', plan: 'basic' }),
    ).rejects.toBeInstanceOf(CheckoutValidationError);
  });
});

