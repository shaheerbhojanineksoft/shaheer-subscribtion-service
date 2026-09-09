/**
 * Central environment configuration.
 *
 * All secrets / connection settings are read from the environment (Bun loads
 * `.env` automatically). Nothing sensitive is hard-coded here.
 */

export interface Env {
  PORT: number;

  STRIPE_SECRET_KEY?: string;
  STRIPE_WEBHOOK_SECRET?: string;

  MONGODB_URI: string;
  MONGODB_DATABASE: string;

  APP_SUCCESS_URL?: string;
  APP_CANCEL_URL?: string;

  // Keycloak auth (protects entitlement/management endpoints).
  KEYCLOAK_URL?: string;
  KEYCLOAK_REALM?: string;
  KEYCLOAK_CLIENT_ID?: string;
  /** Set true to bypass the auth guard (local dev without Keycloak). */
  AUTH_DISABLED: boolean;

  /** Shared secret that must be sent as the `x-api-key` header on open APIs (e.g. checkout). */
  API_KEY?: string;

  EMAIL_PROVIDER?: string;
  EMAIL_FROM?: string;
  SENDGRID_API_KEY?: string;
  MAILGUN_API_KEY?: string;
  MAILGUN_DOMAIN?: string;
  /** Optional provider-specific from-address; falls back to EMAIL_FROM. */
  MAILGUN_FROM?: string;
}

function toNumber(value: string | undefined, fallback: number): number {
  if (value === undefined || value === '') return fallback;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

export function loadEnv(source: Record<string, string | undefined>): Env {
  return {
    PORT: toNumber(source.PORT, 3000),

    STRIPE_SECRET_KEY: source.STRIPE_SECRET_KEY || undefined,
    STRIPE_WEBHOOK_SECRET: source.STRIPE_WEBHOOK_SECRET || undefined,

    MONGODB_URI: source.MONGODB_URI ?? 'mongodb://127.0.0.1:27017',
    MONGODB_DATABASE: source.MONGODB_DATABASE ?? 'subscription_service',

    APP_SUCCESS_URL: source.APP_SUCCESS_URL || undefined,
    APP_CANCEL_URL: source.APP_CANCEL_URL || undefined,

    KEYCLOAK_URL: source.KEYCLOAK_URL || undefined,
    KEYCLOAK_REALM: source.KEYCLOAK_REALM || undefined,
    KEYCLOAK_CLIENT_ID: source.KEYCLOAK_CLIENT_ID || undefined,
    AUTH_DISABLED: ['true', '1'].includes((source.AUTH_DISABLED ?? '').toLowerCase()),

    API_KEY: source.API_KEY || undefined,

    EMAIL_PROVIDER: source.EMAIL_PROVIDER || undefined,
    EMAIL_FROM: source.EMAIL_FROM || undefined,
    SENDGRID_API_KEY: source.SENDGRID_API_KEY || undefined,
    MAILGUN_API_KEY: source.MAILGUN_API_KEY || undefined,
    MAILGUN_DOMAIN: source.MAILGUN_DOMAIN || undefined,
    MAILGUN_FROM: source.MAILGUN_FROM || undefined,
  };
}

export const env: Env = loadEnv(process.env as Record<string, string | undefined>);
