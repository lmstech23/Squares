// What a person typed into "Email or mobile number" — Daali Slice 1, S1.4.
//
// Auth spec, "Screen: Welcome back": the field decides the method. Input
// containing `@` is an email. Input that normalizes to a valid phone number
// (US default, stored as E.164) is a phone. Anything else is neither, and the
// screen says so.
//
// PURE. No Supabase, no network.

export type SignInIdentifier =
  | { kind: "email"; email: string }
  | { kind: "phone"; phone: string }
  | { kind: "invalid" };

/**
 * A phone number in E.164, or null.
 *
 * US default: ten digits, or eleven starting with 1, become +1XXXXXXXXXX. A
 * leading `+` keeps the number as given, 8 to 15 digits. Spaces, dots,
 * hyphens and parentheses are formatting and are dropped; any other character
 * means this is not a phone number.
 */
export function normalizePhone(raw: string): string | null {
  const trimmed = raw.trim();
  if (!/^\+?[\d\s().-]+$/.test(trimmed)) return null;
  const digits = trimmed.replace(/\D/g, "");

  if (trimmed.startsWith("+")) {
    return digits.length >= 8 && digits.length <= 15 ? `+${digits}` : null;
  }
  if (digits.length === 10) return `+1${digits}`;
  if (digits.length === 11 && digits.startsWith("1")) return `+${digits}`;
  return null;
}

export function parseSignInIdentifier(raw: string): SignInIdentifier {
  const value = raw.trim();
  if (value.includes("@")) return { kind: "email", email: value };
  const phone = normalizePhone(value);
  return phone ? { kind: "phone", phone } : { kind: "invalid" };
}
