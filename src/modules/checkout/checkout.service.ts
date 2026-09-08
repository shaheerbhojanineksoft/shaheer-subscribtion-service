/**
 * Checkout flow.
 *
 * The client NEVER sends Stripe price ids. It sends a PLAN NAME from the
 * allowed enum (basic | pro | enterprise) plus a billing interval — the
 * backend resolves which Stripe Product/Price to use from the central plan
 * configuration. Arbitrary prices are never trusted.
 */
import Stripe from 'stripe';
import { getConfiguredPrice, PLAN_KEYS, type PlanKey } from '../../config/plans';
import { isValidEmail, normalizeEmail } from '../../utils/email';
import type { Logger } from '../../utils/logger';
import { silentLogger } from '../../utils/logger';

export class CheckoutValidationError extends Error {}

export type BillingInterval = 'month' | 'year';
const BILLING_INTERVALS: BillingInterval[] = ['month', 'year'];

export interface CheckoutServiceDeps {
  stripe: Stripe;
  /** Application URL Stripe redirects the customer to after a successful checkout. */
  successUrl: string;
  /** Application URL Stripe redirects the customer to when checkout is cancelled. */
  cancelUrl: string;
  logger?: Logger;
}

export interface CheckoutSessionResult {
  id: string;
  url: string | null;
  email: string;
  /** Plan chosen by the client (from the allowed enum). */
  plan: PlanKey;
  billingInterval: BillingInterval;
  /** Resolved by the backend from the plan configuration. */
  productId: string;
  /** Resolved by the backend from the plan configuration. */
  priceId: string;
}

export class CheckoutService {
  constructor(private readonly deps: CheckoutServiceDeps) {
    if (!deps.successUrl || !deps.cancelUrl) {
      throw new Error('APP_SUCCESS_URL and APP_CANCEL_URL must be configured.');
    }
  }

  async createCheckoutSession(input: {
    email: string;
    plan: string;
    billingInterval?: string;
  }): Promise<CheckoutSessionResult> {
    const email = normalizeEmail(input.email);
    if (!isValidEmail(email)) {
      throw new CheckoutValidationError('A valid email address is required.');
    }

    const plan = input.plan as PlanKey;
    if (!PLAN_KEYS.includes(plan)) {
      throw new CheckoutValidationError(`Invalid plan. Allowed plans: ${PLAN_KEYS.join(', ')}.`);
    }

    const billingInterval = (input.billingInterval ?? 'month') as BillingInterval;
    if (!BILLING_INTERVALS.includes(billingInterval)) {
      throw new CheckoutValidationError('Invalid billing interval. Use "month" or "year".');
    }

    const configured = getConfiguredPrice(plan, billingInterval);
    if (!configured) {
      throw new CheckoutValidationError(
        `No Stripe price is configured for plan "${plan}" (${billingInterval}).`,
      );
    }

    const session = await this.deps.stripe.checkout.sessions.create({
      mode: 'subscription',
      customer_email: email,
      line_items: [{ price: configured.priceId, quantity: 1 }],
      success_url: this.deps.successUrl,
      cancel_url: this.deps.cancelUrl,
      // Carry the email on both the session and the eventual subscription so
      // webhooks can always resolve the customer without extra lookups.
      metadata: { email },
      subscription_data: { metadata: { email } },
    });

    this.deps.logger?.info(
      `Created Checkout session ${session.id} for ${email} ` +
        `(plan=${plan}, ${billingInterval}, price=${configured.priceId})`,
    );

    return {
      id: session.id,
      url: session.url ?? null,
      email,
      plan,
      billingInterval,
      productId: configured.productId,
      priceId: configured.priceId,
    };
  }
}
