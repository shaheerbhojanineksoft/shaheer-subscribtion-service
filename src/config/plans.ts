/**
 * Central plan / product / price configuration.
 *
 * Rules:
 *  - The Stripe Product represents the plan.
 *  - The Stripe Price represents a billing variant (monthly / annual).
 *  - Permissions live at the PLAN level. Monthly and annual prices of the same
 *    product share the same plan configuration.
 *  - Product IDs map to plan keys; Price IDs are only allowed/denied at
 *    checkout time.
 *
 * To change anything, edit this one file — subscription/webhook/entitlement
 * logic never needs to change.
 *
 * Configured with the real Stripe TEST-mode Product / Price IDs for the
 * Traderverse account.
 */

export const PLAN_KEYS = ['basic', 'pro', 'enterprise'] as const;
export type PlanKey = (typeof PLAN_KEYS)[number];

export interface PlanConfig {
  /** Whether the plan allows creating posts. */
  canCreatePost: boolean;
  /** Maximum number of posts. -1 means unlimited. */
  maxPosts: number;
}

export const PLAN_CONFIG: Record<PlanKey, PlanConfig> = {
  basic: {
    canCreatePost: false,
    maxPosts: 0,
  },
  pro: {
    canCreatePost: true,
    maxPosts: 100,
  },
  enterprise: {
    canCreatePost: true,
    maxPosts: -1,
  },
};

// ---------------------------------------------------------------------------
// Stripe TEST-mode Product / Price IDs
// ---------------------------------------------------------------------------

export const BASIC_PRODUCT_ID = 'prod_VDsaXGc7h7ka9A';
export const BASIC_MONTHLY_PRICE_ID = 'price_1UDQpGGuLSLkQ7qaSW0qhym7';
export const BASIC_YEARLY_PRICE_ID = 'price_1UDQvCGuLSLkQ7qaYIX4lsUF';

export const PRO_PRODUCT_ID = 'prod_VDskx9YEWVcWlm';
export const PRO_MONTHLY_PRICE_ID = 'price_1UDQylGuLSLkQ7qaRtHzfICm';
export const PRO_YEARLY_PRICE_ID = 'price_1UDQz2GuLSLkQ7qaBfXs3xhW';

export const ENTERPRISE_PRODUCT_ID = 'prod_VDsnTwLOYA9hxX';
export const ENTERPRISE_MONTHLY_PRICE_ID = 'price_1UDR2YGuLSLkQ7qalowHrQm6';
export const ENTERPRISE_YEARLY_PRICE_ID = 'price_1UDR2IGuLSLkQ7qanCt1NI24';

/** Maps a Stripe Product ID to an internal plan key. */
export const PRODUCT_TO_PLAN: Record<string, PlanKey> = {
  [BASIC_PRODUCT_ID]: 'basic',
  [PRO_PRODUCT_ID]: 'pro',
  [ENTERPRISE_PRODUCT_ID]: 'enterprise',
};

export interface AllowedPriceConfig {
  priceId: string;
  productId: string;
  plan: PlanKey;
  /** The billing interval that this specific price represents. */
  billingInterval: 'month' | 'year';
}

/** Stripe Price IDs the checkout endpoint is allowed to sell. */
export const ALLOWED_PRICES: Record<string, AllowedPriceConfig> = {
  [BASIC_MONTHLY_PRICE_ID]: {
    priceId: BASIC_MONTHLY_PRICE_ID,
    productId: BASIC_PRODUCT_ID,
    plan: 'basic',
    billingInterval: 'month',
  },
  [BASIC_YEARLY_PRICE_ID]: {
    priceId: BASIC_YEARLY_PRICE_ID,
    productId: BASIC_PRODUCT_ID,
    plan: 'basic',
    billingInterval: 'year',
  },
  [PRO_MONTHLY_PRICE_ID]: {
    priceId: PRO_MONTHLY_PRICE_ID,
    productId: PRO_PRODUCT_ID,
    plan: 'pro',
    billingInterval: 'month',
  },
  [PRO_YEARLY_PRICE_ID]: {
    priceId: PRO_YEARLY_PRICE_ID,
    productId: PRO_PRODUCT_ID,
    plan: 'pro',
    billingInterval: 'year',
  },
  [ENTERPRISE_MONTHLY_PRICE_ID]: {
    priceId: ENTERPRISE_MONTHLY_PRICE_ID,
    productId: ENTERPRISE_PRODUCT_ID,
    plan: 'enterprise',
    billingInterval: 'month',
  },
  [ENTERPRISE_YEARLY_PRICE_ID]: {
    priceId: ENTERPRISE_YEARLY_PRICE_ID,
    productId: ENTERPRISE_PRODUCT_ID,
    plan: 'enterprise',
    billingInterval: 'year',
  },
};

export function getPlanForProduct(productId: string): PlanKey | null {
  return PRODUCT_TO_PLAN[productId] ?? null;
}

export function getPlanConfig(plan: PlanKey | null | undefined): PlanConfig | null {
  if (!plan) return null;
  return PLAN_CONFIG[plan] ?? null;
}

export function isAllowedPrice(priceId: string): boolean {
  return priceId in ALLOWED_PRICES;
}

export function getAllowedPrice(priceId: string): AllowedPriceConfig | null {
  return ALLOWED_PRICES[priceId] ?? null;
}
