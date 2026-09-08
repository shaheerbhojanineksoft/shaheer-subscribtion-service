/**
 * Phase 9 tests — plan/product/price configuration.
 *
 * Monthly and annual prices of the same product MUST map to the same plan,
 * and arbitrary Price IDs must be rejected at checkout.
 */
import { describe, expect, test } from 'bun:test';
import {
  ALLOWED_PRICES,
  BASIC_MONTHLY_PRICE_ID,
  BASIC_PRODUCT_ID,
  BASIC_YEARLY_PRICE_ID,
  ENTERPRISE_MONTHLY_PRICE_ID,
  ENTERPRISE_PRODUCT_ID,
  ENTERPRISE_YEARLY_PRICE_ID,
  getAllowedPrice,
  getPlanConfig,
  getPlanForProduct,
  isAllowedPrice,
  PLAN_CONFIG,
  PRODUCT_TO_PLAN,
  PRO_MONTHLY_PRICE_ID,
  PRO_PRODUCT_ID,
  PRO_YEARLY_PRICE_ID,
} from '../src/config/plans';

describe('plan configuration', () => {
  test('products map to plans', () => {
    expect(PRODUCT_TO_PLAN).toEqual({
      [BASIC_PRODUCT_ID]: 'basic',
      [PRO_PRODUCT_ID]: 'pro',
      [ENTERPRISE_PRODUCT_ID]: 'enterprise',
    });
    expect(getPlanForProduct(BASIC_PRODUCT_ID)).toBe('basic');
    expect(getPlanForProduct(ENTERPRISE_PRODUCT_ID)).toBe('enterprise');
    expect(getPlanForProduct('prod_missing')).toBeNull();
  });

  test('monthly and annual prices of the same product share the same plan', () => {
    expect(getAllowedPrice(BASIC_MONTHLY_PRICE_ID)?.plan).toBe('basic');
    expect(getAllowedPrice(BASIC_YEARLY_PRICE_ID)?.plan).toBe('basic');
    expect(getAllowedPrice(PRO_MONTHLY_PRICE_ID)?.plan).toBe('pro');
    expect(getAllowedPrice(PRO_YEARLY_PRICE_ID)?.plan).toBe('pro');
    expect(getAllowedPrice(ENTERPRISE_MONTHLY_PRICE_ID)?.plan).toBe('enterprise');
    expect(getAllowedPrice(ENTERPRISE_YEARLY_PRICE_ID)?.plan).toBe('enterprise');

    // Monthly/annual entries reference the same underlying product.
    expect(getAllowedPrice(BASIC_MONTHLY_PRICE_ID)?.productId).toBe(BASIC_PRODUCT_ID);
    expect(getAllowedPrice(BASIC_YEARLY_PRICE_ID)?.productId).toBe(BASIC_PRODUCT_ID);
    expect(getAllowedPrice(PRO_MONTHLY_PRICE_ID)?.productId).toBe(PRO_PRODUCT_ID);
    expect(getAllowedPrice(PRO_YEARLY_PRICE_ID)?.productId).toBe(PRO_PRODUCT_ID);
    expect(getAllowedPrice(ENTERPRISE_MONTHLY_PRICE_ID)?.productId).toBe(ENTERPRISE_PRODUCT_ID);
    expect(getAllowedPrice(ENTERPRISE_YEARLY_PRICE_ID)?.productId).toBe(ENTERPRISE_PRODUCT_ID);
  });

  test('permissions are configured at the plan level', () => {
    expect(PLAN_CONFIG.basic).toEqual({ canCreatePost: false, maxPosts: 0 });
    expect(PLAN_CONFIG.pro).toEqual({ canCreatePost: true, maxPosts: 100 });
    expect(PLAN_CONFIG.enterprise).toEqual({ canCreatePost: true, maxPosts: -1 });
  });

  test('all allowed prices are recognized, unknown prices are not', () => {
    for (const priceId of Object.keys(ALLOWED_PRICES)) {
      expect(isAllowedPrice(priceId)).toBe(true);
    }
    // Exactly the 6 configured test-mode prices are allowed.
    expect(Object.keys(ALLOWED_PRICES)).toHaveLength(6);
    expect(isAllowedPrice('price_random_monthly')).toBe(false);
    expect(isAllowedPrice('price_basic_weekly')).toBe(false);
  });

  test('entitlement config lookup for each plan is defined', () => {
    expect(getPlanConfig('basic')).not.toBeNull();
    expect(getPlanConfig('pro')).not.toBeNull();
    expect(getPlanConfig('enterprise')).not.toBeNull();
    expect(getPlanConfig(null)).toBeNull();
    expect(getPlanConfig('nonexistent' as never)).toBeNull();
  });
});
