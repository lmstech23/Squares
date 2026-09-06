// Who is one person, on one event or one board.
//
// THE SINGLE OWNER of identity normalization and precedence. Two consumers,
// deliberately different mechanics, one rule:
//
//   admission.ts        STORES what this returns. EventSupporter is
//                       entitlement — passes, sign-ups, gate authority — so
//                       its keys are columns, backfilled and indexed.
//   contributor-rows.ts FOLDS on what this returns, derived per render. The
//                       contributors list is presentation, and it must keep
//                       working on an event-less fundraiser board, where no
//                       EventSupporter can exist at all.
//
// What must not fork is the rule. If these two ever disagree about who one
// person is, a host sees one name in her roster and two in her list.
//
// PRECEDENCE — email first, then phone, never OR:
//
//   normalized email matches an existing identity  -> that one
//   else normalized phone matches an existing one  -> that one
//   else                                           -> a new identity
//
// `email OR phone` would chain transitively: A shares an email with B, B
// shares a phone with C, and C is silently merged into A. Ordered lookup binds
// to AT MOST ONE existing identity and never merges two that already exist.
//
// NEVER ON NAME. Two people called Chris are two people.

/**
 * Trim and lowercase. NOTHING ELSE.
 *
 * No Gmail dot-stripping, no `+tag` removal. Both are provider-specific
 * folklore: `a.b@` and `ab@` are the same inbox at Gmail and different
 * addresses at most other hosts, and `+tag` is how people deliberately keep
 * receipts apart. Guessing wrong merges two strangers into one roster row.
 *
 * Returns null when the value is absent — empty after trimming is absent.
 */
export function normalizeEmail(input: string | null | undefined): string | null {
  const v = (input ?? "").trim().toLowerCase();
  return v.length > 0 ? v : null;
}

/**
 * E.164, defaulting to the US country code.
 *
 * A bare ten-digit number and the same number with a leading 1 are the same
 * phone: `6785551234`, `(678) 555-1234` and `1-678-555-1234` all normalize to
 * `+16785551234`. A value that already carries `+` is treated as international
 * and only stripped of formatting — this is a US-default, not a US-only, rule.
 *
 * Returns null when the value cannot be a phone number. The caller rejects;
 * this never guesses a country or pads a short number.
 */
export function normalizePhone(input: string | null | undefined): string | null {
  const raw = (input ?? "").trim();
  if (raw.length === 0) return null;

  const digits = raw.replace(/\D/g, "");
  if (digits.length === 0) return null;

  // Explicitly international. Trust the caller's country code, keep the digits.
  if (raw.startsWith("+")) {
    // A "+" with fewer than 8 digits is not a phone number in any plan.
    return digits.length >= 8 ? `+${digits}` : null;
  }

  if (digits.length === 10) return `+1${digits}`;
  if (digits.length === 11 && digits.startsWith("1")) return `+1${digits.slice(1)}`;

  // 7 digits (no area code), 12+ without a "+", anything else: unusable.
  return null;
}

export interface IdentityKeys {
  emailKey: string;
  phoneKey: string;
}

/**
 * Both keys, or a reason there are not both.
 *
 * MANDATORY BOTH. Email and phone are required on every purchase and every
 * donation, contributor-initiated or host-recorded, so a contact missing
 * either is rejected rather than given a partial identity. There are no
 * synthetic keys and no empty-string fallthrough: those existed to represent
 * anonymous contributions, and anonymous contributions no longer exist.
 */
export function identityKeys(contact: {
  email: string | null | undefined;
  phone: string | null | undefined;
}): IdentityKeys | { error: "email" | "phone" } {
  const emailKey = normalizeEmail(contact.email);
  if (!emailKey) return { error: "email" };
  const phoneKey = normalizePhone(contact.phone);
  if (!phoneKey) return { error: "phone" };
  return { emailKey, phoneKey };
}

/**
 * The precedence, over identities already seen.
 *
 * Used by the presentation fold, where "already seen" is a Map built this
 * render. admission.ts applies the same order against the database instead —
 * two point lookups, email then phone — because its identities are rows.
 *
 * Returns the matched value, or null to create a new identity.
 */
export function matchIdentity<T>(
  byEmail: Map<string, T>,
  byPhone: Map<string, T>,
  keys: IdentityKeys
): T | null {
  const onEmail = byEmail.get(keys.emailKey);
  if (onEmail !== undefined) return onEmail;
  const onPhone = byPhone.get(keys.phoneKey);
  if (onPhone !== undefined) return onPhone;
  return null;
}
