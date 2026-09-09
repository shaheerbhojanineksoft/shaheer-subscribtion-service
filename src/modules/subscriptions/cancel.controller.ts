/**
 * HTTP controller to cancel a subscription (PROTECTED route).
 * Mounted at: POST /subscriptions/cancel/:stripeSubscriptionId
 *
 * The stripe subscription id is a URL path parameter (no request body).
 * The email is taken from the authenticated Keycloak token (not the body),
 * so a caller can only cancel subscriptions that belong to themselves.
 */
import { Hono } from 'hono';
import { getAuthenticatedUser } from '../auth/keycloak';
import { logger } from '../../utils/logger';
import {
  SubscriptionNotFoundError,
  SubscriptionService,
} from './subscription.service';

export function createCancelSubscriptionController(subscriptionService: SubscriptionService): Hono {
  const app = new Hono();

  app.post('/:stripeSubscriptionId', async (c) => {
    const stripeSubscriptionId = c.req.param('stripeSubscriptionId');
    if (!stripeSubscriptionId) {
      return c.json(
        { error: 'URL path must include "stripeSubscriptionId".' },
        400,
      );
    }

    // Email comes from the verified Keycloak token, not from the client.
    const user = getAuthenticatedUser(c);
    const email = user?.email ?? user?.preferred_username ?? null;
    if (!email) {
      return c.json(
        { error: 'Unauthorized — the token does not carry an email claim.' },
        401,
      );
    }

    try {
      const result = await subscriptionService.cancelSubscription({ email, stripeSubscriptionId });
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
