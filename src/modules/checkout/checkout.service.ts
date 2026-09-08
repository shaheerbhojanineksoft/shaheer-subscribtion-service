/**
 * Checkout flow.
 *
 * Creates a Stripe Checkout Session (mode = subscription) for an allowed
 * Price ID. Client-supplied Price IDs are validated against configuration —
 * arbitrary Stripe prices are never trusted.
 */
import Stripe from 'stripe';
import { getAllowedPrice } from '../../config/plans';
import { isValidEmail, normalizeEmail } from '../../utils/email';
import type { Logger } from '../../utils/logger';
import { silentLogger } from '../../utils/logger';

export class CheckoutValidationError extends Error {}

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
  priceId: string;
  productId: string;
  plan: string;
}

export class CheckoutService {
  constructor(private readonly deps: CheckoutServiceDeps) {
    if (!deps.successUrl || !deps.cancelUrl) {
      throw new Error('APP_SUCCESS_URL and APP_CANCEL_URL must be configured.');
    }
  }

  async createCheckoutSession(input: {
    email: string;
    priceId: string;
  }): Promise<CheckoutSessionResult> {
    const email = normalizeEmail(input.email);
    if (!isValidEmail(email)) {
      throw new CheckoutValidationError('A valid email address is required.');
    }

    const allowed = getAllowedPrice(input.priceId);
    if (!allowed) {
      throw new CheckoutValidationError('Price ID is not one of the allowed plan prices.');
    }

    const session = await this.deps.stripe.checkout.sessions.create({
      mode: 'subscription',
      customer_email: email,
      line_items: [{ price: allowed.priceId, quantity: 1 }],
      success_url: this.deps.successUrl,
      cancel_url: this.deps.cancelUrl,
      // Carry the email on both the session and the eventual subscription so
      // webhooks can always resolve the customer without extra lookups.
      metadata: { email },
      subscription_data: { metadata: { email } },
    });

    this.deps.logger?.info(
      `Created Checkout session ${session.id} for ${email} (${allowed.priceId})`,
    );

    return {
      id: session.id,
      url: session.url ?? null,
      email,
      priceId: allowed.priceId,
      productId: allowed.productId,
      plan: allowed.plan,
    };
  }
}
