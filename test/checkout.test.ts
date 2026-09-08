/**
 * Phase 9 tests — checkout flow and price validation.
 */
import { describe, expect, test } from 'bun:test';
import {
  BASIC_MONTHLY_PRICE_ID as PRICE_BASIC_MONTHLY,
  PRO_PRODUCT_ID as PROD_PRO,
  PRO_YEARLY_PRICE_ID as PRICE_PRO_YEARLY,
} from '../src/config/plans';
import { CheckoutValidationError } from '../src/modules/checkout/checkout.service';
import { createHarness, type Harness } from './helpers';

describe('CheckoutService', () => {
  test('creates a subscription Checkout session for an allowed price', async () => {
    const harness: Harness = createHarness();

    const result = await harness.checkout.createCheckoutSession({
      email: 'User@Example.com',
      priceId: PRICE_PRO_YEARLY,
    });

    expect(result.id).toBe('cs_test_1');
    expect(result.url).toContain('https://checkout.stripe.com');
    expect(result.email).toBe('user@example.com'); // normalized
    expect(result.productId).toBe(PROD_PRO);
    expect(result.plan).toBe('pro');
  });

  test('rejects an invalid / disallowed Price ID', async () => {
    const harness: Harness = createHarness();

    await expect(
      harness.checkout.createCheckoutSession({ email: 'user@example.com', priceId: 'price_fake_999' }),
    ).rejects.toBeInstanceOf(CheckoutValidationError);
  });

  test('rejects an invalid email', async () => {
    const harness: Harness = createHarness();

    await expect(
      harness.checkout.createCheckoutSession({ email: 'not-an-email', priceId: PRICE_BASIC_MONTHLY }),
    ).rejects.toBeInstanceOf(CheckoutValidationError);
  });
});
