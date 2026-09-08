/**
 * Application composition root.
 *
 * Wires the real infrastructure (Stripe, MongoDB, email) into the services and
 * builds the HTTP routes. Only the bootstrap (src/index.ts) imports this.
 */
import { Hono } from 'hono';
import type { Db } from 'mongodb';
import { env } from './config/env';
import { getStripeClient } from './config/stripe';
import { CheckoutService } from './modules/checkout/checkout.service';
import { createCheckoutController } from './modules/checkout/checkout.controller';
import { EmailService } from './modules/email/email.service';
import { createEmailProviderFromEnv } from './modules/email/providers';
import { EntitlementService } from './modules/subscriptions/entitlement.service';
import { createCancelSubscriptionController } from './modules/subscriptions/cancel.controller';
import { createEntitlementController } from './modules/subscriptions/entitlement.controller';
import { createMongoSubscriptionRepository } from './modules/subscriptions/subscription.repository';
import { SubscriptionService } from './modules/subscriptions/subscription.service';
import { createStripeWebhookController } from './modules/webhooks/stripe-webhook.controller';
import { StripeWebhookService } from './modules/webhooks/stripe-webhook.service';
import { registerSwagger } from './swagger';
import { logger } from './utils/logger';

export function createApp(db: Db): Hono {
  if (!env.STRIPE_WEBHOOK_SECRET) {
    throw new Error('STRIPE_WEBHOOK_SECRET must be configured to accept Stripe webhooks.');
  }

  const stripe = getStripeClient();
  const repo = createMongoSubscriptionRepository(db);

  const emailProvider = createEmailProviderFromEnv(env);
  const emailService = new EmailService(emailProvider, logger);
  logger.info(
    `Email delivery: ${emailProvider ? `provider=${emailProvider.name}` : 'DISABLED (no EMAIL_PROVIDER set) — emails will be logged only'}`,
  );

  const checkoutService = new CheckoutService({
    stripe,
    successUrl: env.APP_SUCCESS_URL ?? '',
    cancelUrl: env.APP_CANCEL_URL ?? '',
    logger,
  });

  const subscriptionService = new SubscriptionService({
    repo,
    stripe,
    emailService,
    logger,
  });

  const webhookService = new StripeWebhookService({
    stripe,
    webhookSecret: env.STRIPE_WEBHOOK_SECRET,
    repo,
    subscriptionService,
    logger,
  });

  const entitlementService = new EntitlementService(repo);

  const app = new Hono();

  // Log every incoming request and its outcome — the visible "flow trail".
  app.use('*', async (c, next) => {
    const started = Date.now();
    await next();
    logger.info(`${c.req.method} ${c.req.path} → ${c.res.status} (${Date.now() - started}ms)`);
  });

  // Safety net: any error that escapes a handler is logged and returns 500.
  app.onError((error, c) => {
    logger.error(`Unhandled error on ${c.req.method} ${c.req.path}`, error);
    return c.json({ error: 'Internal server error.' }, 500);
  });

  app.get('/health', (c) => c.json({ status: 'ok' }));

  app.route('/subscriptions/checkout', createCheckoutController(checkoutService));
  app.route('/subscriptions', createEntitlementController(entitlementService));
  app.route('/subscriptions/cancel', createCancelSubscriptionController(subscriptionService));
  app.route('/webhooks/stripe', createStripeWebhookController(webhookService));

  // API documentation (OpenAPI spec + Swagger UI).
  registerSwagger(app);
  logger.info('Swagger UI available at GET /docs  (spec at GET /openapi.json)');

  return app;
}
