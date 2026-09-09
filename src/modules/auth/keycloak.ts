/**
 * Keycloak JWT authentication guard.
 *
 * Verifies `Authorization: Bearer <token>` JWTs issued by a Keycloak realm:
 *  - the token signature is checked against the realm's public keys (JWKS)
 *  - `iss` must match `{KEYCLOAK_URL}/realms/{KEYCLOAK_REALM}`
 *  - the token must be intended for the configured client: either `aud`
 *    contains `KEYCLOAK_CLIENT_ID`, or `azp` equals it (Keycloak often puts
 *    the authenticating client in `azp` and only "account" in `aud`)
 *
 * Invalid/missing tokens → HTTP 401. When no Keycloak is configured the guard
 * is a no-op (auth disabled), which keeps local development simple.
 */
import { createRemoteJWKSet, jwtVerify, type JWTPayload } from 'jose';
import type { Context, MiddlewareHandler } from 'hono';

export interface JwtClaims extends JWTPayload {
  email?: string;
  preferred_username?: string;
}

/** Context key where the verified token claims are stored. */
export const AUTH_CONTEXT_KEY = 'auth';

/** Reads the authenticated user (claims) that the guard stored on the context. */
export function getAuthenticatedUser(c: Context): JwtClaims | null {
  const ctx = c as unknown as { get: (key: string) => unknown };
  return (ctx.get(AUTH_CONTEXT_KEY) as JwtClaims | null) ?? null;
}

export interface JwtVerifier {
  /** @throws when the token is invalid/expired/wrong issuer/audience. */
  verify(token: string): Promise<JwtClaims>;
}

export interface KeycloakAuthOptions {
  /** e.g. http://localhost:8080 */
  url: string;
  realm: string;
  /** Optional audience (client id) the token must be intended for. */
  clientId?: string;
}

/** Builds a verifier that downloads the realm JWKS lazily (cached by jose). */
export function createJwtVerifier(options: KeycloakAuthOptions): JwtVerifier {
  const baseUrl = options.url.replace(/\/+$/, '');
  const issuer = `${baseUrl}/realms/${options.realm}`;
  const jwksUrl = new URL(`${issuer}/protocol/openid-connect/certs`);

  const jwks = createRemoteJWKSet(jwksUrl);

  return {
    async verify(token: string): Promise<JwtClaims> {
      const { payload } = await jwtVerify(token, jwks, { issuer });
      const claims = payload as JwtClaims;

      if (options.clientId) {
        const audiences = Array.isArray(claims.aud) ? claims.aud : claims.aud ? [claims.aud] : [];
        const intendedForClient = claims.azp === options.clientId || audiences.includes(options.clientId);
        if (!intendedForClient) {
          throw new Error(
            `Token is not intended for client "${options.clientId}" (aud=${JSON.stringify(claims.aud)}, azp=${claims.azp}).`,
          );
        }
      }

      return claims;
    },
  };
}

/**
 * Hono middleware. Pass `null` (or an empty verifier) when auth is disabled.
 */
export function authGuard(verifier: JwtVerifier | null): MiddlewareHandler {
  return async (c, next) => {
    // Auth disabled / not configured → allow.
    if (!verifier) {
      await next();
      return;
    }

    const header = c.req.header('authorization') ?? '';
    const [scheme, token] = header.split(' ');
    if (scheme?.toLowerCase() !== 'bearer' || !token) {
      return c.json({ error: 'Unauthorized — a valid Bearer token is required.' }, 401);
    }

    try {
      const claims = await verifier.verify(token);
      (c as unknown as { set: (key: string, value: unknown) => void }).set(
        AUTH_CONTEXT_KEY,
        claims,
      );
      await next();
    } catch {
      return c.json({ error: 'Unauthorized — invalid or expired token.' }, 401);
    }
  };
}
