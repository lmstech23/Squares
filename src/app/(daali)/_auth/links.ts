// URL helpers for the account screens — Daali Slice 1, S1.4. Browser-side.

/** `path` with `next` carried along, when there is one. */
export function withNext(path: string, next: string | null): string {
  return next ? `${path}?next=${encodeURIComponent(next)}` : path;
}

/**
 * The emailRedirectTo for an email link. The templates put it in the link as
 * `redirect_to`, and /auth/confirm reads `next` back out of it, so a `next`
 * survives the trip through the inbox. It is validated only where it is used.
 */
export function confirmRedirect(next: string | null): string {
  const url = new URL("/auth/confirm", window.location.origin);
  if (next) url.searchParams.set("next", next);
  return url.toString();
}
