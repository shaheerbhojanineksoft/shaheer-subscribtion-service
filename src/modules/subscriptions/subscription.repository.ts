/**
 * Subscription repository: persistence + webhook idempotency.
 *
 * The MongoDB implementation is used in production. Tests may provide an
 * in-memory implementation of the same interface.
 */
import { ObjectId, type Db } from 'mongodb';
import {
  STRIPE_EVENTS_COLLECTION,
  SUBSCRIPTIONS_COLLECTION,
} from '../../database/indexes';
import type {
  Subscription,
  SubscriptionSnapshot,
  SubscriptionUpdate,
  SubscriptionWriteResult,
} from './subscription.types';

export interface SubscriptionRepository {
  /**
   * Insert a brand-new subscription document unless one already exists for the
   * same stripeSubscriptionId (unique). Never overwrites other documents.
   */
  createSubscriptionIfNotExists(snapshot: SubscriptionSnapshot): Promise<SubscriptionWriteResult>;

  /** Update an existing document identified by its Stripe subscription id. */
  updateSubscriptionByStripeId(
    stripeSubscriptionId: string,
    fields: SubscriptionUpdate,
  ): Promise<Subscription | null>;

  findByStripeSubscriptionId(stripeSubscriptionId: string): Promise<Subscription | null>;

  /** All subscriptions for an email, ordered newest-first by createdAt. */
  findByEmail(email: string): Promise<Subscription[]>;

  /**
   * Atomically claim a Stripe event for idempotent processing.
   * Returns true when this call is the first to see the event, false when it
   * was already claimed/processed.
   */
  claimStripeEvent(stripeEventId: string, type: string): Promise<boolean>;

  /** Record the outcome of processing a claimed event. */
  finalizeStripeEvent(stripeEventId: string, processed: boolean, error?: string): Promise<void>;
}

interface StripeEventRecord {
  _id: string;
  stripeEventId: string;
  type: string;
  status: 'processing' | 'processed' | 'failed';
  error?: string;
  createdAt: Date;
  processedAt?: Date;
}

export function isDuplicateKeyError(error: unknown): boolean {
  if (error && typeof error === 'object' && 'code' in error) {
    const code = (error as { code?: number }).code;
    return code === 11000;
  }
  return false;
}

export function createMongoSubscriptionRepository(db: Db): SubscriptionRepository {
  const subscriptions = db.collection<Subscription>(SUBSCRIPTIONS_COLLECTION);
  const stripeEvents = db.collection<StripeEventRecord>(STRIPE_EVENTS_COLLECTION);

  function toFields(snapshot: SubscriptionSnapshot): SubscriptionUpdate {
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

  return {
    async createSubscriptionIfNotExists(snapshot: SubscriptionSnapshot): Promise<SubscriptionWriteResult> {
      const now = new Date();
      const doc: Subscription = {
        _id: new ObjectId().toHexString(),
        email: snapshot.email,
        stripeSubscriptionId: snapshot.stripeSubscriptionId,
        stripeCustomerId: snapshot.stripeCustomerId,
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

      // Belt-and-suspenders: even if the unique index is temporarily missing
      // (e.g. right after a DB drop), never create a second document for the
      // same Stripe subscription.
      const existingCheck = await subscriptions.findOne({
        stripeSubscriptionId: snapshot.stripeSubscriptionId,
      });
      if (existingCheck) return { subscription: existingCheck, created: false };

      try {
        await subscriptions.insertOne(doc);
        return { subscription: doc, created: true };
      } catch (error) {
        // Another delivery/event created this subscription in the same instant.
        // Return the existing document instead of overwriting anything.
        if (isDuplicateKeyError(error)) {
          const existing = await subscriptions.findOne({
            stripeSubscriptionId: snapshot.stripeSubscriptionId,
          });
          if (!existing) throw error;
          return { subscription: existing, created: false };
        }
        throw error;
      }
    },

    async updateSubscriptionByStripeId(
      stripeSubscriptionId: string,
      fields: SubscriptionUpdate,
    ): Promise<Subscription | null> {
      const updated = await subscriptions.findOneAndUpdate(
        { stripeSubscriptionId },
        { $set: { ...fields, updatedAt: new Date() } },
        { returnDocument: 'after' },
      );
      return updated;
    },

    async findByStripeSubscriptionId(stripeSubscriptionId: string): Promise<Subscription | null> {
      return subscriptions.findOne({ stripeSubscriptionId });
    },

    async findByEmail(email: string): Promise<Subscription[]> {
      return subscriptions.find({ email }).sort({ createdAt: -1, _id: -1 }).toArray();
    },

    async claimStripeEvent(stripeEventId: string, type: string): Promise<boolean> {
      try {
        await stripeEvents.insertOne({
          _id: new ObjectId().toHexString(),
          stripeEventId,
          type,
          status: 'processing',
          createdAt: new Date(),
        });
        return true;
      } catch (error) {
        if (isDuplicateKeyError(error)) return false;
        throw error;
      }
    },

    async finalizeStripeEvent(
      stripeEventId: string,
      processed: boolean,
      error?: string,
    ): Promise<void> {
      await stripeEvents.updateOne(
        { stripeEventId },
        {
          $set: {
            status: processed ? 'processed' : 'failed',
            processedAt: new Date(),
            ...(error ? { error } : {}),
          },
        },
      );
    },
  };
}
