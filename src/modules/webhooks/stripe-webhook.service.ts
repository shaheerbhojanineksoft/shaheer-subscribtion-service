/**
 * Stripe webhook service.
 *
 * Responsibilities:
 *  1. Verify the Stripe-Signature against the raw payload.
 *  2. Enforce idempotency per Stripe event id (atomic claim → process → finalize).
 *  3. Dispatch supported events to the subscription service.
 *
 * The raw request body is required because signature verification depends on
 * the exact bytes Stripe sent.
 */
import Stripe from 'stripe';
import type { Logger } from '../../utils/logger';
import { silentLogger } from '../../utils/logger';
import type { SubscriptionRepository } from '../subscriptions/subscription.repository';
import type { SubscriptionService } from '../subscriptions/subscription.service';

export class StripeWebhookError extends Error {}

export interface StripeWebhookServiceDeps {
  stripe: Stripe;
  webhookSecret: string;
  repo: SubscriptionRepository;
  subscriptionService: SubscriptionService;
  logger?: Logger;
}

export interface WebhookResult {
  received: boolean;
  /** True when this event id was already processed (duplicate delivery). */
  duplicate: boolean;
}

export class StripeWebhookService {
  private readonly stripe: Stripe;
  private readonly webhookSecret: string;
  private readonly repo: SubscriptionRepository;
  private readonly subscriptionService: SubscriptionService;
  private readonly logger: Logger;

  constructor(deps: StripeWebhookServiceDeps) {
    this.stripe = deps.stripe;
    this.webhookSecret = deps.webhookSecret;
    this.repo = deps.repo;
    this.subscriptionService = deps.subscriptionService;
    this.logger = deps.logger ?? silentLogger;
  }

  /** @throws StripeWebhookError when the signature cannot be verified. */
  async handle(payload: string, signature: string): Promise<WebhookResult> {
    let event: Stripe.Event;
    try {
      event = await this.stripe.webhooks.constructEventAsync(payload, signature, this.webhookSecret);
    } catch (error) {
      throw new StripeWebhookError(`Webhook signature verification failed: ${(error as Error).message}`);
    }

    // Idempotency: claim this event atomically. Duplicate deliveries return
    // immediately without touching subscription state.
    const claimed = await this.repo.claimStripeEvent(event.id, event.type);
    if (!claimed) {
      this.logger.info(`Duplicate webhook event ${event.id} (${event.type}) ignored.`);
      return { received: true, duplicate: true };
    }

    this.logger.info(`Stripe event ${event.id} (${event.type}) claimed; processing...`);
    try {
      await this.dispatch(event);
      await this.repo.finalizeStripeEvent(event.id, true);
      this.logger.info(`Stripe event ${event.id} (${event.type}) processed OK.`);
      return { received: true, duplicate: false };
    } catch (error) {
      // Mark the event as failed so it can be retried/reconciled later.
      await this.repo.finalizeStripeEvent(event.id, false, (error as Error).message);
      this.logger.error(`Stripe event ${event.id} (${event.type}) FAILED`, error);
      throw error;
    }
  }

  private async dispatch(event: Stripe.Event): Promise<void> {
    const object = event.data.object as never;

    switch (event.type) {
      case 'checkout.session.completed':
        await this.subscriptionService.handleCheckoutSessionCompleted(
          object as Stripe.Checkout.Session,
        );
        return;
      case 'customer.subscription.created':
        await this.subscriptionService.handleSubscriptionCreated(object as Stripe.Subscription);
        return;
      case 'customer.subscription.updated':
        await this.subscriptionService.handleSubscriptionUpdated(object as Stripe.Subscription);
        return;
      case 'customer.subscription.deleted':
        await this.subscriptionService.handleSubscriptionDeleted(object as Stripe.Subscription);
        return;
      case 'invoice.paid':
        await this.subscriptionService.handleInvoicePaid(object as Stripe.Invoice);
        return;
      case 'invoice.payment_failed':
        await this.subscriptionService.handleInvoicePaymentFailed(object as Stripe.Invoice);
        return;
      default:
        this.logger.info(`Ignoring unhandled Stripe event type "${event.type}".`);
        return;
    }
  }
}
