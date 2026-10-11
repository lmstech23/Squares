// The ONE allowlist for a post-auth `next` — Daali Slice 1, S1.2.
//
// Used by the post-auth gate (post-auth-destination.ts), which /auth/callback
// and every browser sign-in go through. Before this, the callback honoured any
// `next` at all; the old login page had its own invite-only pattern. One
// validator means one place to add a destination and one place to get it
// wrong.
//
// AN OPEN REDIRECT IS THE CLASSIC BUG HERE, and the classic cause is a
// validator that asks "does it start with a slash". `//evil.com` starts with a
// slash and is a protocol-relative URL that browsers follow off-site;
// `/\evil.com` is treated the same way by some; `%2f%2fevil.com` becomes one
// after decoding. So this does not sanitise — it MATCHES A FEW SHAPES and
// refuses everything else.
//
// THE ALLOWLIST is the Auth + Onboarding spec's, "Allowlisted `next`":
//   - /host/boards/<board id> and paths beneath it — the existing fundraiser
//     management surface. A board id is a UUID, so /host/boards/new and the
//     board list itself are NOT matched. Segments beneath it are plain word
//     characters, so `.` and `..` can never appear.
//   - /invite/<token> — the existing board-manager invite, base64url tokens.
//   - /home — Your Daali (S1.6). Its rule that /home requires a COMPLETE
//     organizer state is the caller's (post-auth-destination.ts).
//
// No query string and no fragment: none of the allowed destinations takes one.
//
// This answers only "is this path allowed". What to do when it is not — the
// fallback — belongs to the caller.

const ALLOWED: readonly RegExp[] = [
  /^\/host\/boards\/[0-9A-Fa-f]{8}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{12}(?:\/[A-Za-z0-9_-]+)*$/,
  /^\/invite\/[A-Za-z0-9_-]{16,128}$/,
  /^\/home$/,
];

/**
 * The allowed internal path for this `next` value, or null.
 *
 * DECODED ONCE, THEN MATCHED. A value that is still encoded after one decode —
 * `%252f%252fevil.com` — fails every pattern, which is the intended outcome:
 * repeated decoding until it "looks clean" is how encoded-payload bypasses are
 * built. The returned value is the decoded one, and it has matched a pattern
 * that admits only slashes, word characters and hyphens.
 */
export function allowedNext(next: string | null | undefined): string | null {
  if (!next) return null;

  let candidate: string;
  try {
    candidate = decodeURIComponent(next);
  } catch {
    // Malformed percent-encoding. Not a path we will ever navigate to.
    return null;
  }

  // A URL with a scheme or an authority is out, before the patterns even run.
  // The patterns would reject them anyway; this is the statement of intent.
  if (
    candidate.includes("://") ||
    candidate.startsWith("//") ||
    candidate.includes("\\") ||
    candidate.includes("@")
  ) {
    return null;
  }

  return ALLOWED.some((p) => p.test(candidate)) ? candidate : null;
}
