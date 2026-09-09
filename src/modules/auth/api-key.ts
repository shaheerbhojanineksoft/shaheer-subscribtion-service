/**
 * API-key guard for open (non-Keycloak) business endpoints such as checkout.
 *
 * The caller must send the configured shared key in the `x-api-key` header.
 * - header missing or not matching `API_KEY` → HTTP 401
 * - `API_KEY` not configured on the server → HTTP 500 (fail closed)
 */
import type { MiddlewareHandler } from 'hono';

export function apiKeyGuard(expectedKey: string | undefined): MiddlewareHandler {
  return async (c, next) => {
    if (!expectedKey) {
      return c.json(
        { error: 'API key is not configured on the server (set API_KEY in .env).' },
        500,
      );
    }

    const provided = c.req.header('x-api-key');
    if (!provided || provided !== expectedKey) {
      return c.json({ error: 'Unauthorized — a valid x-api-key header is required.' }, 401);
    }

    await next();
  };
}
