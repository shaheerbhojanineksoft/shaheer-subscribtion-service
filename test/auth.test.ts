/**
 * Tests — Keycloak JWT verifier + auth guard.
 *
 * Serves a fake realm JWKS from a local Bun HTTP server so jose can verify
 * tokens signed with a locally generated RSA key.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { Hono } from 'hono';
import { exportJWK, generateKeyPair, SignJWT } from 'jose';
import { authGuard, createJwtVerifier, type JwtVerifier } from '../src/modules/auth/keycloak';

const CLIENT_ID = 'traderverse-backend';
const REALM = 'traderverse';

let server: ReturnType<typeof Bun.serve> | null = null;
let baseUrl = '';
let privateKey: CryptoKey;

beforeAll(async () => {
  const { publicKey, privateKey: pk } = await generateKeyPair('RS256', { extractable: true });
  privateKey = pk;
  const pubJwk = { ...(await exportJWK(publicKey)), kid: 'test-kid', alg: 'RS256' };

  server = Bun.serve({
    port: 0,
    fetch(req) {
      const url = new URL(req.url);
      if (url.pathname.endsWith('/protocol/openid-connect/certs')) {
        return new Response(JSON.stringify({ keys: [pubJwk] }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      }
      return new Response('not found', { status: 404 });
    },
  });
  baseUrl = `http://127.0.0.1:${server.port}`;
});

afterAll(() => {
  server?.stop(true);
});

function verifier(): JwtVerifier {
  return createJwtVerifier({ url: baseUrl, realm: REALM, clientId: CLIENT_ID });
}

function issuer(): string {
  return `${baseUrl}/realms/${REALM}`;
}

function sign(
  claims: Record<string, unknown>,
  overrides: { audience?: string; azp?: string } = {},
): Promise<string> {
  // SignJWT has no .setAzp(); azp is encoded via the claims payload.
  const payload = overrides.azp !== undefined ? { ...claims, azp: overrides.azp } : claims;
  return new SignJWT(payload)
    .setProtectedHeader({ alg: 'RS256', kid: 'test-kid' })
    .setIssuer(issuer())
    .setAudience(overrides.audience ?? CLIENT_ID)
    .setIssuedAt()
    .setExpirationTime('1h')
    .sign(privateKey);
}

describe('Keycloak JWT verifier', () => {
  test('accepts a valid token with correct issuer + audience', async () => {
    const token = await sign({ sub: 'user-123', email: 'user@example.com' });

    const claims = await verifier().verify(token);
    expect(claims.sub).toBe('user-123');
    expect(claims.email).toBe('user@example.com');
  });

  test('rejects a token with the wrong audience', async () => {
    const token = await sign({}, { audience: 'wrong-aud' });
    await expect(verifier().verify(token)).rejects.toThrow();
  });

  test('accepts a Keycloak-style token whose azp matches the client (aud=account)', async () => {
    // Keycloak often sets aud="account" and puts the authenticating client in azp.
    const token = await sign({ sub: 'user-123', email: 'user@example.com' }, { audience: 'account', azp: CLIENT_ID });

    const claims = await verifier().verify(token);
    expect(claims.email).toBe('user@example.com');
  });

  test('rejects a token with aud=account but a different azp', async () => {
    const token = await sign({}, { audience: 'account', azp: 'some-other-client' });
    await expect(verifier().verify(token)).rejects.toThrow();
  });

  test('rejects a garbage token', async () => {
    await expect(verifier().verify('not.a.jwt')).rejects.toThrow();
  });
});

describe('authGuard middleware', () => {
  function appWith(guardVerifier: JwtVerifier | null): Hono {
    const app = new Hono();
    app.use('/entitlement', authGuard(guardVerifier));
    app.get('/entitlement', (c) => c.json({ ok: true }));
    return app;
  }

  test('allows a valid Bearer token', async () => {
    const token = await sign({ sub: 'user-123' });
    const res = await appWith(verifier()).request('http://x/entitlement', {
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
  });

  test('returns 401 without a token', async () => {
    const res = await appWith(verifier()).request('http://x/entitlement');
    expect(res.status).toBe(401);
  });

  test('returns 401 for an invalid token', async () => {
    const res = await appWith(verifier()).request('http://x/entitlement', {
      headers: { authorization: 'Bearer bogus.token.here' },
    });
    expect(res.status).toBe(401);
  });

  test('is a no-op when auth is disabled (verifier null)', async () => {
    const res = await appWith(null).request('http://x/entitlement');
    expect(res.status).toBe(200);
  });
});
