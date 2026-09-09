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
import { authGuard, createJwtVerifier, type JwtVerifier } from './modules/auth/keycloak';
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

  // Keycloak auth — protects GET /subscriptions/entitlement with a Bearer JWT.
  const keycloakEnabled =
    !env.AUTH_DISABLED && Boolean(env.KEYCLOAK_URL && env.KEYCLOAK_REALM);
  const verifier: JwtVerifier | null = keycloakEnabled
    ? createJwtVerifier({
        url: env.KEYCLOAK_URL as string,
        realm: env.KEYCLOAK_REALM as string,
        clientId: env.KEYCLOAK_CLIENT_ID,
      })
    : null;
  if (keycloakEnabled) {
    logger.info(
      `Keycloak auth ENABLED for /subscriptions/entitlement (realm=${env.KEYCLOAK_REALM}).`,
    );
  } else if (env.AUTH_DISABLED) {
    logger.warn('Auth DISABLED (AUTH_DISABLED=true) — entitlement endpoint is OPEN.');
  } else {
    logger.warn(
      'Keycloak not configured (KEYCLOAK_URL / KEYCLOAK_REALM) — entitlement auth is OFF.',
    );
  }

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
  // Protected routes — Keycloak token required (when enabled).
  app.use('/subscriptions/entitlement', authGuard(verifier));
  // Cancel takes the subscription id in the URL: /subscriptions/cancel/:stripeSubscriptionId
  app.use('/subscriptions/cancel/*', authGuard(verifier));
  app.route('/subscriptions', createEntitlementController(entitlementService));
  app.route('/subscriptions/cancel', createCancelSubscriptionController(subscriptionService));
  app.route('/webhooks/stripe', createStripeWebhookController(webhookService));

  // API documentation (OpenAPI spec + Swagger UI).
  registerSwagger(app);
  logger.info('Swagger UI available at GET /docs  (spec at GET /openapi.json)');

  return app;
}
