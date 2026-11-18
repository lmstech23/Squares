// Where the retired /login sends a request — Daali Slice 1, S1.4.
//
// /sign-in, with the whole query string carried over, so `next` (and anything
// else an existing link holds) survives. PURE.

export function loginRedirectTarget(params: Record<string, string | string[] | undefined>): string {
  const qs = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    for (const v of Array.isArray(value) ? value : value === undefined ? [] : [value]) qs.append(key, v);
  }
  const s = qs.toString();
  return s ? `/sign-in?${s}` : "/sign-in";
}
