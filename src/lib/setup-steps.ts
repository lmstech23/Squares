// What /setup asks for — Daali Slice 1, S1.5.
//
// Auth spec, "/setup shows only what's missing": a name, a confirmed phone,
// and — for existing accounts created without one — a confirmed email. A step
// already under way (a code sent to a new number or address) resumes where it
// stopped: Supabase holds the pending value as new_phone / new_email until it
// is verified, and nothing is attached before then.
//
// ORDER: the details form (name and/or number) first, then the number's code,
// then the email. One exception: an account with no organizer_profiles row has
// no confirmed email (finalize would otherwise have created the row), so there
// is nowhere to save a name yet; the email comes first, and finalize creates
// the row when it is verified.
//
// PURE.

import type { User } from "@supabase/supabase-js";

export type SetupUser = Pick<User, "phone_confirmed_at" | "email_confirmed_at" | "new_phone" | "new_email">;
export type SetupProfile = { displayName: string | null } | null;

export type SetupStep =
  | { step: "details"; askName: boolean; askPhone: boolean }
  | { step: "phone-code"; phone: string; askName: false }
  | { step: "email"; pendingEmail: string | null };

/** "+15555550105" or "15555550105" -> "+15555550105". Supabase stores phones without the plus. */
export function e164(phone: string): string {
  return phone.startsWith("+") ? phone : `+${phone}`;
}

export function setupSteps(user: SetupUser, profile: SetupProfile): SetupStep[] {
  const nameMissing = !profile?.displayName?.trim();
  const phoneMissing = !user.phone_confirmed_at;
  const emailMissing = !user.email_confirmed_at;
  const pendingPhone = phoneMissing && user.new_phone ? e164(user.new_phone) : null;
  const pendingEmail = emailMissing && user.new_email ? user.new_email : null;

  const steps: SetupStep[] = [];
  const askName = nameMissing && profile !== null;
  const askPhone = phoneMissing && !pendingPhone;
  if (askName || askPhone) steps.push({ step: "details", askName, askPhone });
  if (pendingPhone) steps.push({ step: "phone-code", phone: pendingPhone, askName: false });
  if (emailMissing) steps.push({ step: "email", pendingEmail });

  // No profile row yet: the email unlocks it, so it goes first. The name is
  // asked on the next visit, once finalize has created the row.
  if (profile === null && emailMissing) {
    return [steps.find((s) => s.step === "email")!, ...steps.filter((s) => s.step !== "email")];
  }
  return steps;
}

export type NameCheck = { ok: true; name: string } | { ok: false };

/** Required, 1 to 60 characters, trimmed (Auth spec, Screen 3). */
export function checkDisplayName(raw: string): NameCheck {
  const name = raw.trim();
  return name.length >= 1 && name.length <= 60 ? { ok: true, name } : { ok: false };
}
