/**
 * Mailgun email provider.
 *
 * Uses Mailgun's REST v3 messages endpoint directly with FormData, so it has no
 * extra runtime dependencies. Only instantiated when EMAIL_PROVIDER=mailgun.
 */
import type { EmailMessage, EmailProvider } from './email-provider';

export function createMailgunEmailProvider(
  apiKey: string,
  domain: string,
  fromEmail: string,
): EmailProvider {
  return {
    name: 'mailgun',
    async send(message: EmailMessage): Promise<void> {
      const form = new FormData();
      form.append('from', fromEmail);
      form.append('to', message.to);
      form.append('subject', message.subject);
      if (message.html) form.append('html', message.html);
      if (message.text) form.append('text', message.text);

      const url = `https://api.mailgun.net/v3/${domain}/messages`;
      const credentials = `Basic ${btoa(`api:${apiKey}`)}`;

      const response = await fetch(url, {
        method: 'POST',
        headers: { Authorization: credentials },
        body: form,
      });

      if (!response.ok) {
        throw new Error(`Mailgun request failed (${response.status}): ${await response.text()}`);
      }
    },
  };
}
