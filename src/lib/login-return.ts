// Where login sends you afterwards.
//
// The login page hardcoded `/host/boards`, so nothing survived the redirect and
// an invitation link was lost the moment the recipient had to sign in. This is
// the `next` parameter, and it is deliberately the narrowest thing that makes
// the invite flow work rather than a general-purpose return-to.
//
// AN OPEN REDIRECT IS THE CLASSIC BUG HERE, and the classic cause is a
// validator that asks "does it start with a slash". `//evil.com` starts with a
// slash and is a protocol-relative URL that browsers follow off-site;
// `/\evil.com` is treated the same way by some; `%2f%2fevil.com` becomes one
// after decoding. So this does not sanitise — it MATCHES ONE SHAPE and refuses
// everything else.
//
// ALLOWLIST, NOT DENYLIST. Only the invite route is accepted, because that is
// the only flow that currently needs to resume. A new destination is a
// deliberate line here, not a URL somebody discovered they could pass.

/** `/invite/<token>` and nothing else. base64url tokens only. */
const ALLOWED = /^\/invite\/[A-Za-z0-9_-]{16,128}$/;

export const DEFAULT_AFTER_LOGIN = "/host/boards";

/**
 * The safe destination for this `next` value.
 *
 * Returns `DEFAULT_AFTER_LOGIN` for anything not explicitly allowed, so a
 * rejected value logs the person in normally rather than showing them an error
 * about a parameter they never typed.
 *
 * DECODED ONCE, THEN MATCHED. A value that is still encoded after one decode —
 * `%252f%252fevil.com` — fails the pattern, which is the intended outcome:
 * repeated decoding until it "looks clean" is how encoded-payload bypasses are
 * built.
 */
export function safeReturnPath(next: string | null | undefined): string {
  if (!next) return DEFAULT_AFTER_LOGIN;

  let candidate = next;
  try {
    candidate = decodeURIComponent(next);
  } catch {
    // Malformed percent-encoding. Not a path we will ever navigate to.
    return DEFAULT_AFTER_LOGIN;
  }

  // A URL with a scheme or an authority is out, before the pattern even runs.
  // The pattern would reject them anyway; this is the statement of intent.
  if (
    candidate.includes("://") ||
    candidate.startsWith("//") ||
    candidate.startsWith("/\\") ||
    candidate.includes("\\") ||
    candidate.includes("@")
  ) {
    return DEFAULT_AFTER_LOGIN;
  }

  return ALLOWED.test(candidate) ? candidate : DEFAULT_AFTER_LOGIN;
}
