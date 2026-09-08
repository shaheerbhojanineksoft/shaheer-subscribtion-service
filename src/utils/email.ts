/**
 * Email validation helpers.
 */

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export function isValidEmail(email: string): boolean {
  if (typeof email !== 'string') return false;
  const trimmed = email.trim();
  if (trimmed.length < 3 || trimmed.length > 254) return false;
  return EMAIL_PATTERN.test(trimmed);
}

export function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}
