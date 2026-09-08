/**
 * HTTP controller for the checkout flow.
 * Mounted at: POST /subscriptions/checkout
 */
import { Hono } from 'hono';
import { logger } from '../../utils/logger';
import { CheckoutService, CheckoutValidationError } from './checkout.service';

export function createCheckoutController(checkoutService: CheckoutService): Hono {
  const app = new Hono();

  app.post('/', async (c) => {
    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      body = null;
    }

    const { email, priceId } = (body ?? {}) as { email?: unknown; priceId?: unknown };
    if (typeof email !== 'string' || typeof priceId !== 'string') {
      return c.json({ error: 'Request body must include "email" and "priceId".' }, 400);
    }

    try {
      const result = await checkoutService.createCheckoutSession({ email, priceId });
      return c.json(result, 201);
    } catch (error) {
      if (error instanceof CheckoutValidationError) {
        return c.json({ error: error.message }, 400);
      }
      logger.error('Failed to create Checkout session', error);
      return c.json({ error: 'Internal server error.' }, 500);
    }
  });

  return app;
}
