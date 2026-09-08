/**
 * Entitlement resolution — STRICT NEWEST subscription rule.
 *
 * A customer's PAID authority is determined ONLY by their newest subscription
 * (by creation/purchase order). Older subscriptions never contribute, and the
 * system never falls back to an older active subscription.
 *
 * DEFAULT FREE PLAN: every user without a valid paid subscription is granted
 * the built-in FREE plan (a config-level tier that is NOT linked to Stripe).
 */
import { FREE_PLAN, getPlanConfig, type EntitlementPlanKey, type PlanConfig } from '../../config/plans';
import type { SubscriptionRepository } from './subscription.repository';
import type { Subscription } from './subscription.types';

export type EntitlementReason = 'active' | 'free';

export interface EntitlementResult {
  email: string;
  /** True when the user has SOME entitlement (paid plan OR the default free plan). */
  active: boolean;
  reason: EntitlementReason;
  /** Human-readable summary shown to clients. */
  message: string;
  /** The effective plan — includes the built-in 'free' plan. */
  plan: EntitlementPlanKey | null;
  /** Stripe Product id — null for the free plan (not Stripe-linked). */
  productId: string | null;
  config: PlanConfig | null;
  /** True when the effective plan is the default free plan (no Stripe link). */
  isFreePlan: boolean;
  /** stripeSubscriptionId of the newest subscription (only for paid plans). */
  subscriptionId: string | null;
  /** The newest subscription document (only for paid plans). */
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
   *   → newest valid paid subscription?
   *       NO  → DEFAULT FREE PLAN (never an older subscription)
   *       YES → productId → PLAN_CONFIG → paid authority
   */
  async getEffectiveEntitlement(email: string): Promise<EntitlementResult> {
    const all = await this.repo.findByEmail(email);
    const newest = all[0] ?? null;

    // No paid subscription at all → default to the built-in free plan.
    if (!newest) {
      return this.freeTier(email, 'No subscription found — the user is on the free plan.');
    }

    // The newest (only relevant) subscription is not valid → free plan.
    // Older active subscriptions are deliberately NOT consulted.
    if (!isSubscriptionCurrentlyValid(newest)) {
      return this.freeTier(
        email,
        'No active paid plan — the user is on the free plan (never falls back to an older subscription).',
      );
    }

    const config = getPlanConfig(newest.plan);
    if (!config) {
      // Valid subscription but unknown plan → cannot grant paid permissions.
      return this.freeTier(
        email,
        'The newest subscription maps to an unknown plan — the user is on the free plan.',
      );
    }

    return {
      email,
      active: true,
      reason: 'active',
      message: `Active plan: ${newest.plan}.`,
      plan: newest.plan,
      productId: newest.productId,
      config,
      isFreePlan: false,
      subscriptionId: newest.stripeSubscriptionId,
      subscription: newest,
    };
  }

  /** Default tier: built-in free plan (not linked to Stripe). */
  private freeTier(email: string, message: string): EntitlementResult {
    return {
      email,
      active: true,
      reason: 'free',
      message,
      plan: FREE_PLAN,
      productId: null,
      config: getPlanConfig(FREE_PLAN),
      isFreePlan: true,
      subscriptionId: null,
      subscription: null,
    };
  }
}

