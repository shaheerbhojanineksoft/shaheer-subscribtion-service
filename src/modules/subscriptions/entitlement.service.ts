/**
 * Entitlement resolution — STRICT NEWEST subscription rule.
 *
 * A customer's current authority is determined ONLY by their newest
 * subscription (by creation/purchase order). Older subscriptions never
 * contribute permissions, and when the newest subscription becomes inactive
 * the customer has NO ACTIVE AUTHORITY — the system never falls back to an
 * older active subscription.
 */
import { getPlanConfig, type PlanConfig, type PlanKey } from '../../config/plans';
import type { SubscriptionRepository } from './subscription.repository';
import type { Subscription } from './subscription.types';

export type EntitlementReason =
  | 'no_subscriptions'
  | 'newest_inactive'
  | 'unknown_plan'
  | 'active';

export interface EntitlementResult {
  email: string;
  active: boolean;
  reason: EntitlementReason;
  plan: PlanKey | null;
  productId: string | null;
  config: PlanConfig | null;
  /** stripeSubscriptionId of the newest subscription (when one exists). */
  subscriptionId: string | null;
  /** The newest subscription document (when one exists). */
  subscription: Subscription | null;
}

/**
 * A subscription is "currently valid" when Stripe considers it active/trialing
 * and its current period has not yet ended. This intentionally reflects the
 * stored Stripe state — we never invent a status on our own.
 */
export function isSubscriptionCurrentlyValid(subscription: Subscription): boolean {
  if (subscription.status !== 'active' && subscription.status !== 'trialing') {
    return false;
  }
  // No period information available: trust the Stripe status alone.
  if (!subscription.currentPeriodEnd) return true;
  return subscription.currentPeriodEnd.getTime() > Date.now();
}

export class EntitlementService {
  constructor(private readonly repo: SubscriptionRepository) {}

  /**
   * Resolve effective authority for an email.
   *
   * email
   *   → all subscription docs for the email (newest-first)
   *   → newest subscription only
   *   → newest valid? NO  → no authority
   *                YES    → productId → PLAN_CONFIG → effective authority
   */
  async getEffectiveEntitlement(email: string): Promise<EntitlementResult> {
    const all = await this.repo.findByEmail(email);
    const newest = all[0] ?? null;

    if (!newest) {
      return {
        email,
        active: false,
        reason: 'no_subscriptions',
        plan: null,
        productId: null,
        config: null,
        subscriptionId: null,
        subscription: null,
      };
    }

    const base = {
      email,
      plan: newest.plan,
      productId: newest.productId,
      subscriptionId: newest.stripeSubscriptionId,
      subscription: newest,
    };

    // The newest subscription is inactive → NO ACTIVE AUTHORITY. Older
    // subscriptions (even if still active) are deliberately not consulted.
    if (!isSubscriptionCurrentlyValid(newest)) {
      return { ...base, active: false, reason: 'newest_inactive', config: null };
    }

    const config = getPlanConfig(newest.plan);
    if (!config) {
      // The newest subscription is valid but maps to an unknown plan.
      return { ...base, active: false, reason: 'unknown_plan', config: null };
    }

    return { ...base, active: true, reason: 'active', config };
  }
}
