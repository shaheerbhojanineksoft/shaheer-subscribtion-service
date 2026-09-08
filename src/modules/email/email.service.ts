/**
 * Transactional email service.
 *
 * Wraps the selected provider and exposes high-level subscription emails:
 *  - activation (successful initial subscription)
 *  - renewal (successful recurring payment)
 *  - payment failure
 *
 * Email delivery must never break webhook processing: failures are caught and
 * logged, and with no provider configured the emails are logged instead.
 */
import type { PlanKey } from '../../config/plans';
import type { Logger } from '../../utils/logger';
import { silentLogger } from '../../utils/logger';
import type { EmailMessage, EmailProvider } from './providers/email-provider';

export interface SubscriptionEmailData {
  email: string;
  plan: PlanKey | null;
  productId?: string;
  /** Amount in minor units (cents). */
  amount?: number | null;
  currency?: string | null;
  billingInterval?: string | null;
  currentPeriodEnd?: Date | null;
  nextPaymentAttempt?: Date | null;
  status?: string | null;
}

type EmailKind = 'activated' | 'renewed' | 'payment_failed';

export class EmailService {
  constructor(
    private readonly provider: EmailProvider | null,
    private readonly logger: Logger = silentLogger,
  ) {}

  sendSubscriptionActivatedEmail(data: SubscriptionEmailData): Promise<void> {
    return this.dispatch('activated', data);
  }

  sendSubscriptionRenewedEmail(data: SubscriptionEmailData): Promise<void> {
    return this.dispatch('renewed', data);
  }

  sendPaymentFailedEmail(data: SubscriptionEmailData): Promise<void> {
    return this.dispatch('payment_failed', data);
  }

  private async dispatch(kind: EmailKind, data: SubscriptionEmailData): Promise<void> {
    const message = buildMessage(kind, data);

    if (!this.provider) {
      // No provider configured (EMAIL_PROVIDER=none) — say so clearly instead
      // of failing silently, but never block the surrounding flow.
      this.logger.warn(
        `[email:${kind}] SKIPPED for ${data.email} — no email provider configured ` +
          `(set EMAIL_PROVIDER + API keys in .env). Would send: "${message.subject}"`,
      );
      return;
    }

    try {
      await this.provider.send(message);
      this.logger.info(`[email:${kind}] sent to ${data.email} via ${this.provider.name}`);
    } catch (error) {
      // Non-critical: never let an email failure propagate into webhook handling.
      this.logger.error(
        `[email:${kind}] delivery failed for ${data.email} via ${this.provider.name}`,
        error,
      );
    }
  }
}

function buildMessage(kind: EmailKind, data: SubscriptionEmailData): EmailMessage {
  const planLabel = data.plan ?? data.productId ?? 'Subscription';
  const subject = subjectFor(kind, planLabel);
  const html = htmlFor(kind, data);

  return {
    to: data.email,
    subject,
    html,
  };
}

function subjectFor(kind: EmailKind, planLabel: string): string {
  switch (kind) {
    case 'activated':
      return `Your ${planLabel} subscription is active`;
    case 'renewed':
      return `Payment received — your ${planLabel} subscription has renewed`;
    case 'payment_failed':
      return `Payment failed — action needed for your ${planLabel} subscription`;
  }
}

function formatAmount(amount: number | null | undefined, currency: string | null | undefined): string {
  if (amount == null) return '—';
  const value = (amount / 100).toFixed(2);
  return `${value} ${(currency ?? '').toUpperCase()}`.trim();
}

function formatDate(date: Date | null | undefined): string {
  if (!date) return '—';
  return date.toISOString();
}

function row(label: string, value: string): string {
  return `<tr><td style="padding:6px 12px;color:#555;white-space:nowrap;">${label}</td><td style="padding:6px 12px;color:#111;font-weight:600;">${escapeHtml(value)}</td></tr>`;
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function htmlFor(kind: EmailKind, data: SubscriptionEmailData): string {
  const planLabel = data.plan ?? data.productId ?? 'Subscription';

  let heading: string;
  let body: string;
  switch (kind) {
    case 'activated':
      heading = `Your ${planLabel} subscription is active 🎉`;
      body = 'Thanks for subscribing! Your account now has access to this plan.';
      break;
    case 'renewed':
      heading = `Payment received for ${planLabel}`;
      body = 'Your recurring payment succeeded and your subscription has been renewed.';
      break;
    case 'payment_failed':
      heading = `We could not process your payment`;
      body = 'Your recurring payment failed. Please update your payment method so your subscription continues without interruption.';
      break;
  }

  const rows: string[] = [
    row('Plan', planLabel),
    row('Amount', formatAmount(data.amount, data.currency)),
    row('Billing interval', data.billingInterval ?? '—'),
    row('Current period end', formatDate(data.currentPeriodEnd)),
    row('Status', data.status ?? '—'),
  ];
  if (kind === 'payment_failed' && data.nextPaymentAttempt) {
    rows.push(row('Next payment attempt', formatDate(data.nextPaymentAttempt)));
  }

  return `
<!doctype html>
<html>
  <body style="margin:0;padding:0;background:#f4f4f5;font-family:Arial,Helvetica,sans-serif;">
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f4f4f5;padding:24px;">
      <tr><td align="center">
        <table role="presentation" width="560" cellpadding="0" cellspacing="0" style="background:#ffffff;border-radius:12px;overflow:hidden;">
          <tr><td style="padding:24px 28px;background:#0a0a2e;color:#ffffff;font-size:20px;font-weight:700;">${escapeHtml(heading)}</td></tr>
          <tr><td style="padding:24px 28px;color:#333;font-size:15px;line-height:1.5;">${escapeHtml(body)}</td></tr>
          <tr><td style="padding:8px 28px 24px;">
            <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border-collapse:collapse;">
              ${rows.join('')}
            </table>
          </td></tr>
        </table>
      </td></tr>
    </table>
  </body>
</html>`;
}
