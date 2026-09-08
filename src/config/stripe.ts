/**
 * Stripe SDK client factory.
 *
 * Services receive a `Stripe` instance through their constructor so they stay
 * unit-testable (mocked clients can be injected). Only the application
 * bootstrap imports this module.
 */
import Stripe from 'stripe';
import { env } from './env';

export function createStripeClient(apiKey: string): Stripe {
  return new Stripe(apiKey);
}

let cachedClient: Stripe | null = null;

/** Returns the configured singleton Stripe client for the running process. */
export function getStripeClient(): Stripe {
  if (!cachedClient) {
    if (!env.STRIPE_SECRET_KEY) {
      throw new Error('STRIPE_SECRET_KEY is not configured.');
    }
    cachedClient = createStripeClient(env.STRIPE_SECRET_KEY);
  }
  return cachedClient;
}
