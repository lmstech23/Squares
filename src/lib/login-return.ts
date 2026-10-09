// Where login sends you afterwards.
//
// The login page hardcoded `/host/boards`, so nothing survived the redirect and
// an invitation link was lost the moment the recipient had to sign in. This is
// the `next` parameter.
//
// WHICH PATHS ARE ALLOWED is decided in ONE place, `allowedNext` in
// next-path.ts, shared with /auth/callback. The reasoning about open redirects
// lives there with the patterns. This file only supplies the fallback.

import { allowedNext } from "@/lib/next-path";

export const DEFAULT_AFTER_LOGIN = "/host/boards";

/**
 * The safe destination for this `next` value.
 *
 * Returns `DEFAULT_AFTER_LOGIN` for anything not explicitly allowed, so a
 * rejected value logs the person in normally rather than showing them an error
 * about a parameter they never typed.
 */
export function safeReturnPath(next: string | null | undefined): string {
  return allowedNext(next) ?? DEFAULT_AFTER_LOGIN;
}
