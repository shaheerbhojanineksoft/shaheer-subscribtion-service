/**
 * Subscription service.
 *
 * Turns authoritative Stripe objects into MongoDB subscription documents and
 * drives the transactional emails. All mutations flow THROUGH Stripe webhook
 * events — Stripe is the source of truth for billing state, MongoDB is only
 * the local representation synchronized here.
 *
 * Rules enforced:
 *  - Never overwrite an existing subscription doc for the same email.
 *  - Never create a second doc for an existing Stripe subscription.
 *  - Each Stripe subscription maps to exactly one MongoDB document.
 */
import Stripe from 'stripe';
import { getPlanForProduct } from '../../config/plans';
import { normalizeEmail } from '../../utils/email';
import type { Logger } from '../../utils/logger';
import { silentLogger } from '../../utils/logger';
import type { EmailService, SubscriptionEmailData } from '../email/email.service';
import type { SubscriptionRepository } from './subscription.repository';
import type {
  Subscription,
  SubscriptionSnapshot,
  SubscriptionStatus,
  SubscriptionUpdate,
  SubscriptionWriteResult,
} from './subscription.types';

export interface SubscriptionServiceDeps {
  repo: SubscriptionRepository;
  stripe: Stripe;
  emailService: EmailService;
  logger?: Logger;
}

function customerIdOf(customer: string | Stripe.Customer | Stripe.DeletedCustomer): string {
  return typeof customer === 'string' ? customer : customer.id;
}

function toDate(seconds: number | null | undefined): Date | null {
  if (!seconds) return null;
  return new Date(seconds * 1000);
}

/** Extracts the persisted snapshot from an authoritative Stripe subscription. */
function subscriptionToSnapshot(
  subscription: Stripe.Subscription,
  email: string,
): SubscriptionSnapshot {
  const item = subscription.items?.data?.[0];
  const price = item?.price;
  const productId = typeof price?.product === 'string' ? price.product : '';
  const plan = getPlanForProduct(productId);

  return {
    email,
    stripeCustomerId: customerIdOf(subscription.customer),
    stripeSubscriptionId: subscription.id,
    productId,
    priceId: price?.id ?? '',
    plan,
    billingInterval: price?.recurring?.interval ?? null,
    status: subscription.status as SubscriptionStatus,
    currentPeriodStart: toDate(subscription.current_period_start),
    currentPeriodEnd: toDate(subscription.current_period_end),
    cancelAtPeriodEnd: subscription.cancel_at_period_end ?? false,
  };
}

function snapshotToUpdate(snapshot: SubscriptionSnapshot): SubscriptionUpdate {
  return {
    stripeCustomerId: snapshot.stripeCustomerId,
    productId: snapshot.productId,
    priceId: snapshot.priceId,
    plan: snapshot.plan,
    billingInterval: snapshot.billingInterval,
    status: snapshot.status,
    currentPeriodStart: snapshot.currentPeriodStart,
    currentPeriodEnd: snapshot.currentPeriodEnd,
    cancelAtPeriodEnd: snapshot.cancelAtPeriodEnd,
  };
}

export class SubscriptionService {
  private readonly repo: SubscriptionRepository;
  private readonly stripe: Stripe;
  private readonly emailService: EmailService;
  private readonly logger: Logger;

  constructor(deps: SubscriptionServiceDeps) {
    this.repo = deps.repo;
    this.stripe = deps.stripe;
    this.emailService = deps.emailService;
    this.logger = deps.logger ?? silentLogger;
  }

  // ---------------------------------------------------------------------------
  // Webhook-driven handlers
  // ---------------------------------------------------------------------------

  /** checkout.session.completed — a customer just completed their first purchase. */
  async handleCheckoutSessionCompleted(
    session: Stripe.Checkout.Session,
  ): Promise<SubscriptionWriteResult | null> {
    const subscriptionId = typeof session.subscription === 'string' ? session.subscription : null;
    if (!subscriptionId) {
      this.logger.warn(`checkout.session.completed ${session.id} has no subscription; ignoring.`);
      return null;
    }

    // Retrieve the authoritative subscription (expand customer for the email).
    const subscription = await this.stripe.subscriptions.retrieve(subscriptionId, {
      expand: ['customer'],
    });

    const email = await this.resolveEmail(
      subscription,
      session.customer_details?.email ?? session.customer_email ?? undefined,
    );
    const snapshot = await this.withPeriodFallback(subscription, email);
    const result = await this.repo.createSubscriptionIfNotExists(snapshot);
    this.logger.info(
      `checkout.session.completed → ${result.created ? 'CREATED' : 'ALREADY EXISTS'} ` +
        `subscription ${result.subscription.stripeSubscriptionId} for ${result.subscription.email} ` +
        `(plan=${result.subscription.plan ?? 'unknown'}, status=${result.subscription.status}, ` +
        `periodEnd=${result.subscription.currentPeriodEnd?.toISOString() ?? 'n/a'})`,
    );

    if (result.created) {
      await this.emailService.sendSubscriptionActivatedEmail(
        this.emailData(result.subscription, {
          amount: session.amount_total ?? null,
          currency: session.currency ?? null,
        }),
      );
      // New purchase succeeded → unsubscribe this user's other active subscriptions.
      await this.unsubscribeOtherActiveSubscriptions(
        result.subscription.email,
        result.subscription.stripeSubscriptionId,
      );
    }
    return result;
  }

  /** customer.subscription.created — mirror of the subscription lifecycle. */
  async handleSubscriptionCreated(
    subscription: Stripe.Subscription,
  ): Promise<SubscriptionWriteResult | null> {
    const email = await this.resolveEmail(subscription);
    const snapshot = await this.withPeriodFallback(subscription, email);
    const result = await this.repo.createSubscriptionIfNotExists(snapshot);
    this.logger.info(
      `customer.subscription.created → ${result.created ? 'CREATED' : 'ALREADY EXISTS'} ` +
        `subscription ${result.subscription.stripeSubscriptionId} for ${result.subscription.email} ` +
        `(plan=${result.subscription.plan ?? 'unknown'}, status=${result.subscription.status})`,
    );

    // Only the first event that creates the document sends the activation email,
    // so duplicate event types never double-notify the customer.
    if (result.created) {
      await this.emailService.sendSubscriptionActivatedEmail(this.emailData(result.subscription));
      // New purchase succeeded → unsubscribe this user's other active subscriptions.
      await this.unsubscribeOtherActiveSubscriptions(
        result.subscription.email,
        result.subscription.stripeSubscriptionId,
      );
    }
    return result;
  }

  /** customer.subscription.updated — reflect status/plan/period/cancel changes. */
  async handleSubscriptionUpdated(
    subscription: Stripe.Subscription,
  ): Promise<SubscriptionWriteResult | null> {
    const result = await this.sync(subscription);
    this.logger.info(
      `customer.subscription.updated → sub ${subscription.id} synced ` +
        `(status=${result.subscription.status}, plan=${result.subscription.plan ?? 'unknown'}, ` +
        `price=${result.subscription.priceId}, cancelAtPeriodEnd=${result.subscription.cancelAtPeriodEnd})`,
    );
    return result;
  }

  /** customer.subscription.deleted — keep the record, mark it canceled. */
  async handleSubscriptionDeleted(
    subscription: Stripe.Subscription,
  ): Promise<SubscriptionWriteResult | null> {
    this.logger.info(`Subscription ${subscription.id} deleted on Stripe; preserving record.`);
    const result = await this.sync(subscription);
    this.logger.info(
      `customer.subscription.deleted → sub ${subscription.id} preserved ` +
        `(status=${result.subscription.status}, cancelAtPeriodEnd=${result.subscription.cancelAtPeriodEnd})`,
    );
    return result;
  }

  /** invoice.paid — a recurring payment succeeded; refresh the period, don't duplicate. */
  async handleInvoicePaid(invoice: Stripe.Invoice): Promise<SubscriptionWriteResult | null> {
    const subscriptionId = typeof invoice.subscription === 'string' ? invoice.subscription : null;
    if (!subscriptionId) return null;

    const subscription = await this.stripe.subscriptions.retrieve(subscriptionId, {
      expand: ['customer'],
    });
    const result = await this.sync(subscription, invoice);
    this.logger.info(
      `invoice.paid ${invoice.id} → sub ${subscriptionId} synced ` +
        `(status=${result.subscription.status}, ` +
        `periodEnd=${result.subscription.currentPeriodEnd?.toISOString() ?? 'n/a'})`,
    );

    // The very first subscription invoice is the initial payment — activation is
    // already handled by checkout.session.completed / customer.subscription.created.
    if (invoice.billing_reason !== 'subscription_create') {
      await this.emailService.sendSubscriptionRenewedEmail(
        this.emailData(result.subscription, {
          amount: invoice.amount_paid ?? invoice.amount_due ?? null,
          currency: invoice.currency ?? null,
        }),
      );
    } else {
      this.logger.info(`invoice.paid ${invoice.id} → initial payment; no renewal email.`);
    }
    return result;
  }

  /** invoice.payment_failed — surface the failure, keep the record. */
  async handleInvoicePaymentFailed(invoice: Stripe.Invoice): Promise<SubscriptionWriteResult | null> {
    const subscriptionId = typeof invoice.subscription === 'string' ? invoice.subscription : null;
    if (!subscriptionId) return null;

    const subscription = await this.stripe.subscriptions.retrieve(subscriptionId, {
      expand: ['customer'],
    });
    const result = await this.sync(subscription, invoice);
    this.logger.warn(
      `invoice.payment_failed ${invoice.id} → sub ${subscriptionId} now ${result.subscription.status} ` +
        `(amountDue=${invoice.amount_due ?? 0} ${invoice.currency ?? ''})`,
    );

    await this.emailService.sendPaymentFailedEmail(
      this.emailData(result.subscription, {
        amount: invoice.amount_due ?? null,
        currency: invoice.currency ?? null,
        nextPaymentAttempt: invoice.next_payment_attempt
          ? new Date(invoice.next_payment_attempt * 1000)
          : null,
      }),
    );
    return result;
  }

  /**
   * Enforce ONE active subscription per customer: when a new subscription is
   * successfully purchased, immediately unsubscribe every OTHER active
   * subscription belonging to the same email on Stripe.
   *
   * The older MongoDB documents are preserved for history — their status is
   * finalized by Stripe's own `customer.subscription.deleted/updated` events
   * (Stripe stays the source of truth). Failures are logged but never thrown,
   * so they can never block the new purchase.
   */
  private async unsubscribeOtherActiveSubscriptions(
    email: string,
    keepStripeSubscriptionId: string,
  ): Promise<void> {
    const docs = await this.repo.findByEmail(email);
    const older = docs.filter(
      (doc) =>
        doc.stripeSubscriptionId !== keepStripeSubscriptionId &&
        (doc.status === 'active' || doc.status === 'trialing'),
    );

    if (older.length === 0) {
      this.logger.info(`No older active subscriptions to unsubscribe for ${email}.`);
      return;
    }

    for (const doc of older) {
      try {
        await this.stripe.subscriptions.cancel(doc.stripeSubscriptionId);
        this.logger.info(
          `Unsubscribed older subscription ${doc.stripeSubscriptionId} ` +
            `(${doc.plan ?? 'unknown'}) for ${email} — newer subscription ` +
            `${keepStripeSubscriptionId} is now the only active one.`,
        );
      } catch (error) {
        // Never block the new purchase on a failed old-subscription cancel.
        this.logger.error(
          `Failed to unsubscribe older subscription ${doc.stripeSubscriptionId} for ${email}`,
          error,
        );
      }
    }
  }

  // ---------------------------------------------------------------------------
  // Helpers
  // ---------------------------------------------------------------------------

  /**
   * Update an existing document or create one when the Stripe subscription is
   * unknown locally (e.g. events arriving out of order). Never duplicates.
   *
   * @param invoice optional — when present (invoice.paid / invoice.payment_failed)
   *   its line-item period is the preferred fallback for a null current period.
   */
  private async sync(
    subscription: Stripe.Subscription,
    invoice?: Stripe.Invoice,
  ): Promise<SubscriptionWriteResult> {
    const email = await this.resolveEmail(subscription);
    const snapshot = await this.withPeriodFallback(subscription, email, invoice);
    return this.syncSnapshot(snapshot);
  }

  /** Insert-or-update a fully prepared snapshot (never creates duplicates). */
  private async syncSnapshot(snapshot: SubscriptionSnapshot): Promise<SubscriptionWriteResult> {
    const existing = await this.repo.findByStripeSubscriptionId(snapshot.stripeSubscriptionId);
    if (!existing) {
      return this.repo.createSubscriptionIfNotExists(snapshot);
    }
    const updated = await this.repo.updateSubscriptionByStripeId(
      snapshot.stripeSubscriptionId,
      snapshotToUpdate(snapshot),
    );
    return { subscription: updated ?? existing, created: false };
  }

  /**
   * Stripe normally sets current_period_start/end on the subscription, but for
   * a brand-new Checkout subscription they can still be null even though the
   * first invoice is already paid. We only ever fill them from OTHER Stripe
   * data (the invoice line period / the latest invoice) — never invented
   * locally, so Stripe stays the source of truth.
   */
  private async withPeriodFallback(
    subscription: Stripe.Subscription,
    email: string,
    invoice?: Stripe.Invoice | null,
  ): Promise<SubscriptionSnapshot> {
    const snapshot = subscriptionToSnapshot(subscription, email);
    if (snapshot.currentPeriodStart && snapshot.currentPeriodEnd) return snapshot;

    const candidates: { start: number; end: number }[] = [];
    const linePeriod = invoice?.lines?.data?.[0]?.period;
    if (linePeriod?.start && linePeriod?.end) {
      candidates.push({ start: linePeriod.start, end: linePeriod.end });
    }
    const latest = await this.latestInvoicePeriod(subscription.id);
    if (latest) candidates.push(latest);

    for (const candidate of candidates) {
      if (!snapshot.currentPeriodStart) snapshot.currentPeriodStart = new Date(candidate.start * 1000);
      if (!snapshot.currentPeriodEnd) snapshot.currentPeriodEnd = new Date(candidate.end * 1000);
      if (snapshot.currentPeriodStart && snapshot.currentPeriodEnd) break;
    }
    return snapshot;
  }

  private async latestInvoicePeriod(
    subscriptionId: string,
  ): Promise<{ start: number; end: number } | null> {
    try {
      const invoices = await this.stripe.invoices.list({ subscription: subscriptionId, limit: 1 });
      const period = invoices.data[0]?.lines?.data?.[0]?.period;
      if (period?.start && period?.end) return { start: period.start, end: period.end };
    } catch (error) {
      this.logger.warn(`Could not read latest invoice period for ${subscriptionId}`, error);
    }
    return null;
  }

  private async resolveEmail(
    subscription: Stripe.Subscription,
    preferred?: string | null,
  ): Promise<string> {
    if (preferred) return normalizeEmail(preferred);

    const existing = await this.repo.findByStripeSubscriptionId(subscription.id);
    if (existing?.email) return existing.email;

    const metadataEmail = subscription.metadata?.email;
    if (metadataEmail) return normalizeEmail(metadataEmail);

    // Last resort: ask Stripe for the authoritative customer email.
    const customer = await this.stripe.customers.retrieve(customerIdOf(subscription.customer));
    if (!('deleted' in customer) && customer.email) {
      return normalizeEmail(customer.email);
    }

    throw new Error(`Unable to resolve customer email for subscription ${subscription.id}`);
  }

  private emailData(subscription: Subscription, extra: Partial<SubscriptionEmailData> = {}): SubscriptionEmailData {
    return {
      email: subscription.email,
      plan: subscription.plan,
      productId: subscription.productId,
      billingInterval: subscription.billingInterval,
      currentPeriodEnd: subscription.currentPeriodEnd,
      status: subscription.status,
      ...extra,
    };
  }
}
