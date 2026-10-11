// Reading Supabase auth errors for the account screens — Daali Slice 1, S1.4.
// PURE; safe in the browser.

type AuthErrorLike = { code?: string | null; message?: string | null; status?: number | null } | null | undefined;

/**
 * True when signInWithOtp({ shouldCreateUser: false }) refused because no user
 * has this email or phone. Supabase answers that with error code
 * `otp_disabled` ("Signups not allowed for otp"). The Auth spec's
 * create-an-account states key off this, and nothing else.
 */
export function isUnknownIdentifier(error: AuthErrorLike): boolean {
  if (!error) return false;
  if (error.code === "otp_disabled") return true;
  return /signups not allowed for otp/i.test(error.message ?? "");
}
