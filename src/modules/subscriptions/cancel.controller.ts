/**
 * HTTP controller to cancel a subscription.
 * Mounted at: POST /subscriptions/cancel
 *
 * Body: { "email": "...", "stripeSubscriptionId": "sub_..." }
 * Behaviour: verifies the record belongs to the email, cancels it on Stripe
 * (if still active there) and marks the MongoDB document canceled.
 */
import { Hono } from 'hono';
import { isValidEmail, normalizeEmail } from '../../utils/email';
import { logger } from '../../utils/logger';
import {
  SubscriptionNotFoundError,
  SubscriptionService,
} from './subscription.service';

export function createCancelSubscriptionController(subscriptionService: SubscriptionService): Hono {
  const app = new Hono();

  app.post('/', async (c) => {
    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      body = null;
    }

    const { email, stripeSubscriptionId } = (body ?? {}) as {
      email?: unknown;
      stripeSubscriptionId?: unknown;
    };
    if (
      typeof email !== 'string' ||
      typeof stripeSubscriptionId !== 'string' ||
      !isValidEmail(email)
    ) {
      return c.json(
        { error: 'Request body must include a valid "email" and "stripeSubscriptionId".' },
        400,
      );
    }

    try {
      const result = await subscriptionService.cancelSubscription({
        email: normalizeEmail(email),
        stripeSubscriptionId,
      });
      return c.json(result, 200);
    } catch (error) {
      if (error instanceof SubscriptionNotFoundError) {
        return c.json({ error: error.message }, 404);
      }
      logger.error('Failed to cancel subscription', error);
      return c.json({ error: 'Internal server error.' }, 500);
    }
  });

  return app;
}
