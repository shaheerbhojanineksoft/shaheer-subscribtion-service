/**
 * Domain types for subscriptions and entitlement.
 *
 * IMPORTANT: subscription documents do NOT carry a `userId` at this stage.
 * `email` is the application-level reference to a customer and a single email
 * may own multiple subscription documents.
 */
import type { PlanKey } from '../../config/plans';

export type SubscriptionStatus =
  | 'trialing'
  | 'active'
  | 'past_due'
  | 'canceled'
  | 'unpaid'
  | 'incomplete'
  | 'incomplete_expired'
  | 'paused';

/** The MongoDB subscription document (application representation of billing state). */
export interface Subscription {
  /** Mongo document id. */
  _id: string;
  /** Application-level customer reference (no userId at this stage). */
  email: string;

  stripeCustomerId: string;
  /** Stripe's subscription id — identifies the Stripe subscription. */
  stripeSubscriptionId: string;

  /** Stripe Product id (the plan). */
  productId: string;
  /** Stripe Price id (the billing variant). */
  priceId: string;

  /** Internal plan key derived from the Stripe Product. */
  plan: PlanKey | null;
  /** Stripe recurring interval, e.g. "month" | "year". */
  billingInterval: string | null;

  /** Mirrors the Stripe subscription status. */
  status: SubscriptionStatus;

  currentPeriodStart: Date | null;
  currentPeriodEnd: Date | null;

  /** True when the customer scheduled cancellation at the end of the period. */
  cancelAtPeriodEnd: boolean;

  createdAt: Date;
  updatedAt: Date;
}

/** The set of fields that can be synchronized from an authoritative Stripe subscription. */
export interface SubscriptionSnapshot {
  email: string;
  stripeCustomerId: string;
  stripeSubscriptionId: string;
  productId: string;
  priceId: string;
  plan: PlanKey | null;
  billingInterval: string | null;
  status: SubscriptionStatus;
  currentPeriodStart: Date | null;
  currentPeriodEnd: Date | null;
  cancelAtPeriodEnd: boolean;
}

/** Updatable fields (everything except identity/email). */
export type SubscriptionUpdate = Omit<
  Partial<SubscriptionSnapshot>,
  'email' | 'stripeSubscriptionId'
>;

export interface SubscriptionWriteResult {
  subscription: Subscription;
  /** True when a brand-new document was created (not an update of an existing one). */
  created: boolean;
}
