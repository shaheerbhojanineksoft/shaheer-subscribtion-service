/**
 * SendGrid email provider.
 *
 * Uses SendGrid's REST v3 Mail Send endpoint directly (no extra runtime
 * dependencies) and is only instantiated when EMAIL_PROVIDER=sendgrid.
 */
import type { EmailMessage, EmailProvider } from './email-provider';

const SENDGRID_API_URL = 'https://api.sendgrid.com/v3/mail/send';

export function createSendGridEmailProvider(apiKey: string, fromEmail: string): EmailProvider {
  return {
    name: 'sendgrid',
    async send(message: EmailMessage): Promise<void> {
      const body = {
        personalizations: [{ to: [{ email: message.to }] }],
        from: { email: fromEmail },
        subject: message.subject,
        content: [{ type: message.html ? 'text/html' : 'text/plain', value: message.html ?? message.text ?? '' }],
      };

      const response = await fetch(SENDGRID_API_URL, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${apiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(body),
      });

      if (!response.ok) {
        throw new Error(`SendGrid request failed (${response.status}): ${await response.text()}`);
      }
    },
  };
}
