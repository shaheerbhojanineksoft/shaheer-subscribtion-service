/**
 * Email provider abstraction.
 *
 * The rest of the application only depends on this interface. Providers are
 * selected at runtime through environment configuration so the service is not
 * coupled to a single vendor.
 */

export interface EmailMessage {
  to: string;
  subject: string;
  text?: string;
  html?: string;
}

export interface EmailProvider {
  readonly name: 'sendgrid' | 'mailgun';
  send(message: EmailMessage): Promise<void>;
}
