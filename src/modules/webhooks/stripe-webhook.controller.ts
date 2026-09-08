/**
 * HTTP controller for Stripe webhooks.
 * Mounted at: POST /webhooks/stripe
 *
 * The raw request body is forwarded to signature verification unmodified —
 * we never parse/re-stringify the body first.
 */
import { Hono } from 'hono';
import { logger } from '../../utils/logger';
import {
  StripeWebhookError,
  StripeWebhookService,
} from './stripe-webhook.service';

export function createStripeWebhookController(webhookService: StripeWebhookService): Hono {
  const app = new Hono();

  app.post('/', async (c) => {
    const signature = c.req.header('stripe-signature');
    if (!signature) {
      return c.json({ error: 'Missing stripe-signature header.' }, 400);
    }

    const payload = await c.req.text();

    try {
      const result = await webhookService.handle(payload, signature);
      // Stripe expects a 2xx even for duplicate events so it stops retrying.
      return c.json(result, 200);
    } catch (error) {
      if (error instanceof StripeWebhookError) {
        logger.warn(`Webhook rejected: ${error.message}`);
        return c.json({ error: error.message }, 400);
      }
      logger.error('Webhook processing failed', error);
      return c.json({ error: 'Webhook processing failed.' }, 500);
    }
  });

  return app;
}
