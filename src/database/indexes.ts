/**
 * MongoDB index definitions.
 *
 * Query patterns:
 *  - locate/update a subscription by its unique Stripe subscription id
 *  - list a customer's subscriptions newest-first (email + createdAt)
 *  - check statuses when reconciling entitlement
 *  - deduplicate Stripe webhook events by stripeEventId
 */
import type { Db } from 'mongodb';

export const SUBSCRIPTIONS_COLLECTION = 'subscriptions';
export const STRIPE_EVENTS_COLLECTION = 'stripe_events';

export async function ensureIndexes(db: Db): Promise<void> {
  const subscriptions = db.collection(SUBSCRIPTIONS_COLLECTION);
  const stripeEvents = db.collection(STRIPE_EVENTS_COLLECTION);

  // A Stripe subscription maps to exactly one Mongo document.
  await subscriptions.createIndex({ stripeSubscriptionId: 1 }, { unique: true, name: 'uniq_stripeSubscriptionId' });
  // Find all subscriptions for an email.
  await subscriptions.createIndex({ email: 1 }, { name: 'idx_email' });
  // Newest-subscription entitlement lookup (email + createdAt desc).
  await subscriptions.createIndex({ email: 1, createdAt: -1 }, { name: 'idx_email_createdAt' });
  // Status-based scans.
  await subscriptions.createIndex({ status: 1 }, { name: 'idx_status' });

  // Webhook idempotency: each Stripe event may be processed once.
  await stripeEvents.createIndex({ stripeEventId: 1 }, { unique: true, name: 'uniq_stripeEventId' });
}
