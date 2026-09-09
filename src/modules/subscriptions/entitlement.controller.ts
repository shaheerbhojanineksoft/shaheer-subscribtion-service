/**
 * HTTP controller for entitlement lookups (PROTECTED route).
 * Mounted at: GET /subscriptions/entitlement
 *
 * The email comes from the authenticated Keycloak token (like the cancel
 * route), so a user can only look up their own entitlement — the client never
 * sends an email.
 */
import { Hono } from 'hono';
import { getAuthenticatedUser } from '../auth/keycloak';
import { isValidEmail, normalizeEmail } from '../../utils/email';
import type { EntitlementService } from './entitlement.service';

export function createEntitlementController(entitlementService: EntitlementService): Hono {
  const app = new Hono();

  app.get('/entitlement', async (c) => {
    // Email comes from the verified Keycloak token, not from the client.
    const user = getAuthenticatedUser(c);
    const email = user?.email ?? user?.preferred_username ?? null;
    if (!email || !isValidEmail(email)) {
      return c.json(
        { error: 'Unauthorized — the token does not carry a valid email claim.' },
        401,
      );
    }

    const result = await entitlementService.getEffectiveEntitlement(normalizeEmail(email));
    return c.json(result, 200);
  });

  return app;
}
