/**
 * Phase 9 tests — strict newest-subscription entitlement rule.
 */
import { describe, expect, test } from 'bun:test';
import {
  createHarness,
  makeSubscription,
  type Harness,
} from './helpers';
import type { Subscription } from '../src/modules/subscriptions/subscription.types';

function seed(
  repo: Harness['repo'],
  email: string,
  stripeSubscriptionId: string,
  options: { productId: string; priceId: string; plan: 'basic' | 'pro' | 'enterprise' | null; status: string },
): Promise<unknown> {
  const subscription = makeSubscription({
    id: stripeSubscriptionId,
    customer: 'cus_seed',
    status: options.status,
    productId: options.productId,
    priceId: options.priceId,
  }) as {
    status: string;
    current_period_start: number;
    current_period_end: number;
    cancel_at_period_end: boolean;
  };

  return repo.createSubscriptionIfNotExists({
    email,
    stripeCustomerId: 'cus_seed',
    stripeSubscriptionId,
    productId: options.productId,
    priceId: options.priceId,
    plan: options.plan,
    billingInterval: 'month',
    status: subscription.status as Subscription['status'],
    currentPeriodStart: new Date(subscription.current_period_start * 1000),
    currentPeriodEnd: new Date(subscription.current_period_end * 1000),
    cancelAtPeriodEnd: subscription.cancel_at_period_end,
  });
}

describe('EntitlementService — strict newest-subscription rule', () => {
  test('no subscriptions → no active authority', async () => {
    const harness: Harness = createHarness();
    const result = await harness.entitlement.getEffectiveEntitlement('nobody@example.com');
    expect(result.active).toBe(false);
    expect(result.reason).toBe('no_subscriptions');
    expect(result.config).toBeNull();
  });

  test('single active Basic subscription → Basic authority', async () => {
    const harness: Harness = createHarness();
    await seed(harness.repo, 'user@example.com', 'sub_basic', {
      productId: 'prod_basic',
      priceId: 'price_basic_monthly',
      plan: 'basic',
      status: 'active',
    });

    const result = await harness.entitlement.getEffectiveEntitlement('user@example.com');
    expect(result.active).toBe(true);
    expect(result.plan).toBe('basic');
    expect(result.reason).toBe('active');
    expect(result.config).toEqual({ canCreatePost: false, maxPosts: 0 });
  });

  test('multiple subscriptions → authority from the newest only', async () => {
    const harness: Harness = createHarness();
    await seed(harness.repo, 'user@example.com', 'sub_basic', {
      productId: 'prod_basic',
      priceId: 'price_basic_monthly',
      plan: 'basic',
      status: 'active',
    });
    await seed(harness.repo, 'user@example.com', 'sub_pro', {
      productId: 'prod_pro',
      priceId: 'price_pro_monthly',
      plan: 'pro',
      status: 'active',
    });
    await seed(harness.repo, 'user@example.com', 'sub_enterprise', {
      productId: 'prod_enterprise',
      priceId: 'price_enterprise_annual',
      plan: 'enterprise',
      status: 'active',
    });

    const result = await harness.entitlement.getEffectiveEntitlement('user@example.com');
    expect(result.active).toBe(true);
    expect(result.plan).toBe('enterprise');
    expect(result.config).toEqual({ canCreatePost: true, maxPosts: -1 });

    // All three documents exist independently.
    const all = await harness.repo.findByEmail('user@example.com');
    expect(all).toHaveLength(3);
  });

  test('newest inactive + older active → NO ACTIVE AUTHORITY (no fallback)', async () => {
    const harness: Harness = createHarness();
    await seed(harness.repo, 'user@example.com', 'sub_basic', {
      productId: 'prod_basic',
      priceId: 'price_basic_monthly',
      plan: 'basic',
      status: 'active',
    });
    // Newest subscription is created then cancelled.
    await seed(harness.repo, 'user@example.com', 'sub_pro', {
      productId: 'prod_pro',
      priceId: 'price_pro_monthly',
      plan: 'pro',
      status: 'active',
    });
    await harness.repo.updateSubscriptionByStripeId('sub_pro', { status: 'canceled' });

    const result = await harness.entitlement.getEffectiveEntitlement('user@example.com');
    expect(result.active).toBe(false);
    expect(result.reason).toBe('newest_inactive');
    // Even though the older Basic subscription is still active, the customer
    // must NOT fall back to it.
    expect(result.config).toBeNull();
    expect(result.subscription?.status).toBe('canceled');
  });

  test('newest subscription past its current period → not valid', async () => {
    const harness: Harness = createHarness();
    const past = new Date();
    past.setDate(past.getDate() - 10); // period already ended

    await harness.repo.createSubscriptionIfNotExists({
      email: 'user@example.com',
      stripeCustomerId: 'cus_seed',
      stripeSubscriptionId: 'sub_expired',
      productId: 'prod_pro',
      priceId: 'price_pro_monthly',
      plan: 'pro',
      billingInterval: 'month',
      status: 'active',
      currentPeriodStart: new Date(past.getTime() - 30 * 24 * 60 * 60 * 1000),
      currentPeriodEnd: past,
      cancelAtPeriodEnd: false,
    });

    const result = await harness.entitlement.getEffectiveEntitlement('user@example.com');
    expect(result.active).toBe(false);
    expect(result.reason).toBe('newest_inactive');
  });

  test('newest subscription maps to an unknown plan → no authority', async () => {
    const harness: Harness = createHarness();
    const subscription = makeSubscription({
      id: 'sub_unknown',
      productId: 'prod_not_configured',
      priceId: 'price_unknown_monthly',
    }) as {
      status: string;
      current_period_start: number;
      current_period_end: number;
      cancel_at_period_end: boolean;
    };

    await harness.repo.createSubscriptionIfNotExists({
      email: 'user@example.com',
      stripeCustomerId: 'cus_seed',
      stripeSubscriptionId: 'sub_unknown',
      productId: 'prod_not_configured',
      priceId: 'price_unknown_monthly',
      plan: null,
      billingInterval: 'month',
      status: subscription.status as Subscription['status'],
      currentPeriodStart: new Date(subscription.current_period_start * 1000),
      currentPeriodEnd: new Date(subscription.current_period_end * 1000),
      cancelAtPeriodEnd: subscription.cancel_at_period_end,
    });

    const result = await harness.entitlement.getEffectiveEntitlement('user@example.com');
    expect(result.active).toBe(false);
    expect(result.reason).toBe('unknown_plan');
  });

  test('trialing subscription is currently valid (Stripe status trusted)', async () => {
    const harness: Harness = createHarness();
    await seed(harness.repo, 'user@example.com', 'sub_trialing', {
      productId: 'prod_enterprise',
      priceId: 'price_enterprise_monthly',
      plan: 'enterprise',
      status: 'trialing',
    });

    const result = await harness.entitlement.getEffectiveEntitlement('user@example.com');
    expect(result.active).toBe(true);
    expect(result.plan).toBe('enterprise');
  });

  test('newest selection orders subscriptions newest-first', async () => {
    const harness: Harness = createHarness();
    await seed(harness.repo, 'a@example.com', 'sub_first', {
      productId: 'prod_basic',
      priceId: 'price_basic_monthly',
      plan: 'basic',
      status: 'active',
    });
    await seed(harness.repo, 'a@example.com', 'sub_second', {
      productId: 'prod_pro',
      priceId: 'price_pro_monthly',
      plan: 'pro',
      status: 'active',
    });

    const list = await harness.repo.findByEmail('a@example.com');
    expect(list[0]?.stripeSubscriptionId).toBe('sub_second');

    const result = await harness.entitlement.getEffectiveEntitlement('a@example.com');
    expect(result.subscriptionId).toBe('sub_second');
    expect(result.plan).toBe('pro');
  });
});
