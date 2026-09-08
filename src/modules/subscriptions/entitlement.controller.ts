/**
 * HTTP controller for entitlement lookups.
 * Mounted at: GET /subscriptions/entitlement?email=user@example.com
 *
 * Intended for other services/middleware to resolve a customer's current
 * authority using the strict newest-subscription rule.
 */
import { Hono } from 'hono';
import { isValidEmail, normalizeEmail } from '../../utils/email';
import type { EntitlementService } from './entitlement.service';

export function createEntitlementController(entitlementService: EntitlementService): Hono {
  const app = new Hono();

  app.get('/entitlement', async (c) => {
    const rawEmail = c.req.query('email');
    if (!rawEmail || !isValidEmail(rawEmail)) {
      return c.json({ error: 'A valid "email" query parameter is required.' }, 400);
    }

    const result = await entitlementService.getEffectiveEntitlement(normalizeEmail(rawEmail));
    return c.json(result, 200);
  });

  return app;
}
