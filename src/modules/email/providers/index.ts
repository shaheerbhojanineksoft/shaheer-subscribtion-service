/**
 * Provider factory driven by environment configuration.
 */
import type { Env } from '../../../config/env';
import type { EmailProvider } from './email-provider';
import { createMailgunEmailProvider } from './mailgun.provider';
import { createSendGridEmailProvider } from './sendgrid.provider';

export * from './email-provider';

export function createEmailProviderFromEnv(env: Env): EmailProvider | null {
  const provider = env.EMAIL_PROVIDER?.trim().toLowerCase();

  switch (provider) {
    case 'sendgrid': {
      const from = env.EMAIL_FROM ?? '';
      if (!env.SENDGRID_API_KEY || !from) {
        throw new Error('EMAIL_PROVIDER=sendgrid requires SENDGRID_API_KEY and EMAIL_FROM.');
      }
      return createSendGridEmailProvider(env.SENDGRID_API_KEY, from);
    }
    case 'mailgun': {
      // MAILGUN_FROM overrides EMAIL_FROM for Mailgun sends.
      const from = env.MAILGUN_FROM ?? env.EMAIL_FROM ?? '';
      if (!env.MAILGUN_API_KEY || !env.MAILGUN_DOMAIN || !from) {
        throw new Error(
          'EMAIL_PROVIDER=mailgun requires MAILGUN_API_KEY, MAILGUN_DOMAIN and EMAIL_FROM/MAILGUN_FROM.',
        );
      }
      return createMailgunEmailProvider(env.MAILGUN_API_KEY, env.MAILGUN_DOMAIN, from);
    }
    default:
      // "none" or unset: emails are logged instead of sent.
      return null;
  }
}
