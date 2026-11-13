// The merch public origin. Pure (no Prisma, no Stripe) so it can be unit-tested.

/**
 * The ONE origin for everything merch hands out: Stripe success_url and
 * cancel_url, the receipt's order link, the return gate's redirects, and the
 * sale link the host copies. Unlike Board checkout (src/lib/base-url.ts) it is
 * never taken from the request, so a link shared once stays on the canonical
 * host whichever alias the supporter arrived on. Must be an https origin with
 * no path in production; the Stripe webhook endpoint must be on this host too.
 */
export function merchBaseUrl(): string {
  const u = (process.env.NEXT_PUBLIC_URL ?? "").trim().replace(/\/+$/, "");
  if (!u) throw new Error("NEXT_PUBLIC_URL is not set");
  const parsed = new URL(u);
  if (parsed.pathname !== "/" || parsed.search || parsed.hash) throw new Error("NEXT_PUBLIC_URL must be an origin with no path");
  if (process.env.VERCEL_ENV === "production" && (parsed.protocol !== "https:" || /^(localhost|127\.)/.test(parsed.hostname))) {
    throw new Error("NEXT_PUBLIC_URL must be the public https origin in production");
  }
  return parsed.origin;
}

/** What the host editor shows before the slug, e.g. "beta.daali.app/merch/". Same source as merchBaseUrl. */
export function merchPublicPrefix(): string {
  return `${new URL(merchBaseUrl()).host}/merch/`;
}
