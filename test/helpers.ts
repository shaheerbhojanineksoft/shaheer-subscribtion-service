/**
 * Shared test infrastructure:
 *  - in-memory SubscriptionRepository implementing the same interface as the
 *    MongoDB repository
 *  - a fake Stripe client (no network, no keys required)
 *  - an email provider that captures outgoing messages
 *  - factories for Stripe-like objects and events
 */
import type Stripe from 'stripe';
import {
  BASIC_MONTHLY_PRICE_ID as PRICE_BASIC_MONTHLY,
  BASIC_PRODUCT_ID as PROD_BASIC,
} from '../src/config/plans';
import { CheckoutService } from '../src/modules/checkout/checkout.service';
import { EmailService, type SubscriptionEmailData } from '../src/modules/email/email.service';
import type { EmailMessage, EmailProvider } from '../src/modules/email/providers/email-provider';
import { EntitlementService } from '../src/modules/subscriptions/entitlement.service';
import type { SubscriptionRepository } from '../src/modules/subscriptions/subscription.repository';
import { SubscriptionService } from '../src/modules/subscriptions/subscription.service';
import type {
  Subscription,
  SubscriptionSnapshot,
  SubscriptionUpdate,
  SubscriptionWriteResult,
} from '../src/modules/subscriptions/subscription.types';
import { StripeWebhookService } from '../src/modules/webhooks/stripe-webhook.service';
import { silentLogger } from '../src/utils/logger';

// ---------------------------------------------------------------------------
// Clock
// ---------------------------------------------------------------------------

/** A controllable clock so webhook/creation ordering is deterministic. */
export function makeClock(
  startMs: number = Date.parse('2026-09-01T00:00:00.000Z'),
  stepMs = 60_000,
): () => Date {
  let current = startMs;
  return () => {
    const value = new Date(current);
    current += stepMs;
    return value;
  };
}

// ---------------------------------------------------------------------------
// In-memory repository
// ---------------------------------------------------------------------------

export class InMemorySubscriptionRepository implements SubscriptionRepository {
  subscriptions: Subscription[] = [];
  /** stripeEventId -> record */
  events = new Map<string, { type: string; status: string }>();
  private idSeq = 0;

  constructor(private readonly clock: () => Date = () => new Date()) {}

  async createSubscriptionIfNotExists(
    snapshot: SubscriptionSnapshot,
  ): Promise<SubscriptionWriteResult> {
    const existing = this.subscriptions.find(
      (s) => s.stripeSubscriptionId === snapshot.stripeSubscriptionId,
    );
    if (existing) return { subscription: existing, created: false };

    const now = this.clock();
    const doc: Subscription = {
      _id: `doc_${++this.idSeq}`,
      email: snapshot.email,
      stripeCustomerId: snapshot.stripeCustomerId,
      stripeSubscriptionId: snapshot.stripeSubscriptionId,
      productId: snapshot.productId,
      priceId: snapshot.priceId,
      plan: snapshot.plan,
      billingInterval: snapshot.billingInterval,
      status: snapshot.status,
      currentPeriodStart: snapshot.currentPeriodStart,
      currentPeriodEnd: snapshot.currentPeriodEnd,
      cancelAtPeriodEnd: snapshot.cancelAtPeriodEnd,
      createdAt: now,
      updatedAt: now,
    };
    this.subscriptions.push(doc);
    return { subscription: doc, created: true };
  }

  async updateSubscriptionByStripeId(
    stripeSubscriptionId: string,
    fields: SubscriptionUpdate,
  ): Promise<Subscription | null> {
    const existing = this.subscriptions.find((s) => s.stripeSubscriptionId === stripeSubscriptionId);
    if (!existing) return null;
    Object.assign(existing, fields, { updatedAt: this.clock() });
    return existing;
  }

  async findByStripeSubscriptionId(stripeSubscriptionId: string): Promise<Subscription | null> {
    return this.subscriptions.find((s) => s.stripeSubscriptionId === stripeSubscriptionId) ?? null;
  }

  async findByEmail(email: string): Promise<Subscription[]> {
    const matches = this.subscriptions
      .map((subscription, index) => ({ subscription, index }))
      .filter(({ subscription }) => subscription.email === email);
    matches.sort((a, b) => {
      const timeDiff = b.subscription.createdAt.getTime() - a.subscription.createdAt.getTime();
      if (timeDiff !== 0) return timeDiff;
      return b.index - a.index;
    });
    return matches.map(({ subscription }) => subscription);
  }

  async claimStripeEvent(stripeEventId: string, type: string): Promise<boolean> {
    if (this.events.has(stripeEventId)) return false;
    this.events.set(stripeEventId, { type, status: 'processing' });
    return true;
  }

  async finalizeStripeEvent(
    stripeEventId: string,
    processed: boolean,
    _error?: string,
  ): Promise<void> {
    const record = this.events.get(stripeEventId);
    if (record) record.status = processed ? 'processed' : 'failed';
  }
}

// ---------------------------------------------------------------------------
// Fake Stripe client
// ---------------------------------------------------------------------------

export interface FakeStripeApi {
  stripe: Stripe;
  addSubscription(subscription: object): void;
  addCustomer(customer: object): void;
  /** Stripe subscription ids that were cancelled (subscriptions.cancel calls). */
  canceled: string[];
}

export function createFakeStripe(): FakeStripeApi {
  const subscriptions = new Map<string, object>();
  const customers = new Map<string, object>();
  const canceled: string[] = [];

  const stripe = {
    webhooks: {
      constructEventAsync: async (payload: string): Promise<object> => {
        const event = JSON.parse(payload) as { type?: string } | null;
        if (!event?.type) throw new Error('FakeStripe: malformed event payload');
        return event as object;
      },
    },
    subscriptions: {
      retrieve: async (id: string): Promise<object> => {
        const found = subscriptions.get(id);
        if (!found) throw new Error(`FakeStripe: subscription ${id} not found`);
        return found;
      },
      cancel: async (id: string): Promise<object> => {
        canceled.push(id);
        return { id, object: 'subscription', status: 'canceled' };
      },
    },
    customers: {
      retrieve: async (id: string): Promise<object> =>
        customers.get(id) ?? { id, object: 'customer', email: `customer.${id}@example.com` },
    },
    checkout: {
      sessions: {
        create: async (params: object): Promise<object> => ({
          id: 'cs_test_1',
          object: 'checkout.session',
          url: 'https://checkout.stripe.com/c/pay/cs_test_1',
          ...(params as object),
        }),
      },
    },
  } as unknown as Stripe;

  return {
    stripe,
    canceled,
    addSubscription: (subscription: object) =>
      subscriptions.set((subscription as { id: string }).id, subscription),
    addCustomer: (customer: object) => customers.set((customer as { id: string }).id, customer),
  };
}

// ---------------------------------------------------------------------------
// Capturing email provider
// ---------------------------------------------------------------------------

export class CapturingEmailProvider implements EmailProvider {
  readonly name = 'sendgrid' as const;
  sent: EmailMessage[] = [];

  async send(message: EmailMessage): Promise<void> {
    this.sent.push(message);
  }
}

// ---------------------------------------------------------------------------
// Stripe-like object factories
// ---------------------------------------------------------------------------

export interface SubscriptionFactoryOptions {
  id?: string;
  customer?: string;
  customerObject?: { id: string; email: string };
  status?: string;
  productId?: string;
  priceId?: string;
  interval?: string | null;
  currentPeriodStart?: number | null;
  currentPeriodEnd?: number | null;
  cancelAtPeriodEnd?: boolean;
  metadata?: Record<string, string>;
}

const MONTH_SECONDS = 30 * 24 * 60 * 60;

/** Builds a Stripe.Subscription-like object with future periods by default. */
export function makeSubscription(options: SubscriptionFactoryOptions = {}): object {
  const nowSeconds = Math.floor(Date.now() / 1000);
  const end = options.currentPeriodEnd ?? nowSeconds + MONTH_SECONDS;
  const start = options.currentPeriodStart ?? end - MONTH_SECONDS;

  return {
    id: options.id ?? 'sub_test',
    object: 'subscription',
    customer: options.customerObject ?? options.customer ?? 'cus_test',
    status: options.status ?? 'active',
    metadata: options.metadata ?? {},
    cancel_at_period_end: options.cancelAtPeriodEnd ?? false,
    current_period_start: start,
    current_period_end: end,
    items: {
      data: [
        {
          id: 'si_test',
          price: {
            id: options.priceId ?? PRICE_BASIC_MONTHLY,
            product: options.productId ?? PROD_BASIC,
            recurring: { interval: options.interval ?? 'month' },
          },
        },
      ],
    },
  };
}

export interface InvoiceFactoryOptions {
  id?: string;
  subscription?: string;
  customer?: string;
  status?: string;
  amountPaid?: number | null;
  amountDue?: number | null;
  currency?: string;
  billingReason?: string;
  nextPaymentAttempt?: number | null;
}

export function makeInvoice(options: InvoiceFactoryOptions = {}): object {
  return {
    id: options.id ?? 'in_test',
    object: 'invoice',
    subscription: options.subscription ?? null,
    customer: options.customer ?? 'cus_test',
    status: options.status ?? 'paid',
    amount_paid: options.amountPaid ?? null,
    amount_due: options.amountDue ?? null,
    amount_remaining: 0,
    currency: options.currency ?? 'usd',
    billing_reason: options.billingReason ?? 'subscription_cycle',
    next_payment_attempt: options.nextPaymentAttempt ?? null,
  };
}

export interface CheckoutSessionFactoryOptions {
  id?: string;
  subscription?: string | null;
  customer?: string;
  email?: string;
  amountTotal?: number | null;
  currency?: string;
}

export function makeCheckoutSession(options: CheckoutSessionFactoryOptions = {}): object {
  return {
    id: options.id ?? 'cs_test',
    object: 'checkout.session',
    mode: 'subscription',
    subscription: options.subscription ?? 'sub_test',
    customer: options.customer ?? 'cus_test',
    customer_email: options.email ?? null,
    customer_details: options.email ? { email: options.email } : null,
    amount_total: options.amountTotal ?? 2900,
    currency: options.currency ?? 'usd',
  };
}

let eventSeq = 0;

export function makeStripeEvent(type: string, object: object): object {
  return {
    id: `evt_${++eventSeq}`,
    object: 'event',
    type,
    data: { object },
  };
}

export function serializeEvent(event: object): string {
  return JSON.stringify(event);
}

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

export interface Harness {
  repo: InMemorySubscriptionRepository;
  entitlement: EntitlementService;
  checkout: CheckoutService;
  webhookService: StripeWebhookService;
  subscriptionService: SubscriptionService;
  stripe: Stripe;
  addSubscription(subscription: object): void;
  addCustomer(customer: object): void;
  /** Stripe subscription ids that were cancelled while running the scenario. */
  canceledSubscriptions: string[];
  sentEmails: () => EmailMessage[];
  subjects: () => string[];
}

export function createHarness(): Harness {
  const repo = new InMemorySubscriptionRepository(makeClock());
  const emailProvider = new CapturingEmailProvider();
  const emailService = new EmailService(emailProvider);
  const fake = createFakeStripe();

  const subscriptionService = new SubscriptionService({
    repo,
    stripe: fake.stripe,
    emailService,
    logger: silentLogger,
  });

  const webhookService = new StripeWebhookService({
    stripe: fake.stripe,
    webhookSecret: 'whsec_test',
    repo,
    subscriptionService,
    logger: silentLogger,
  });

  const entitlement = new EntitlementService(repo);

  const checkout = new CheckoutService({
    stripe: fake.stripe,
    successUrl: 'http://localhost:3000/success',
    cancelUrl: 'http://localhost:3000/cancel',
    logger: silentLogger,
  });

  return {
    repo,
    entitlement,
    checkout,
    webhookService,
    subscriptionService,
    stripe: fake.stripe,
    canceledSubscriptions: fake.canceled,
    addSubscription: fake.addSubscription,
    addCustomer: fake.addCustomer,
    sentEmails: () => emailProvider.sent,
    subjects: () => emailProvider.sent.map((m) => m.subject),
  };
}

/** Convenience type so tests can name email data without importing it everywhere. */
export type { SubscriptionEmailData };
