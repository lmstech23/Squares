import { headers } from "next/headers";

// Where "this deployment" actually lives.
//
// NEXT_PUBLIC_URL is a single configured value, so on any deployment that is
// not production it is a lie. A preview that builds links from it sends people
// to production: share links and QR codes point at a host without the code
// being tested, and a Stripe success_url redirects the contributor out of the
// deployment they were using and into a different one.
//
// That last case is how a fundraiser checkout appeared to land on a Game Day
// board — not a missing branch, but a redirect to a deployment that has no
// fundraiser code.
//
// Order: the origin the request actually arrived on, then the deployment's own
// URL, then the configured base. The configured value is the last resort
// rather than the first choice.

function normalize(value: string): string {
  const trimmed = value.replace(/\/+$/, "");
  return /^https?:\/\//.test(trimmed) ? trimmed : `https://${trimmed}`;
}

/** For route handlers, which have the request. */
export function baseUrlFromRequest(request: Request): string {
  const origin = request.headers.get("origin");
  if (origin) return normalize(origin);

  // Same-origin form posts and some clients omit Origin; Host is still right.
  const host = request.headers.get("host");
  if (host) {
    const proto =
      request.headers.get("x-forwarded-proto") ??
      (host.startsWith("localhost") ? "http" : "https");
    return `${proto}://${host}`;
  }

  if (process.env.VERCEL_URL) return normalize(process.env.VERCEL_URL);
  return process.env.NEXT_PUBLIC_URL ?? "http://localhost:3000";
}

/** For server components, which do not. */
export async function baseUrlFromHeaders(): Promise<string> {
  try {
    const h = await headers();
    const host = h.get("host");
    if (host) {
      const proto =
        h.get("x-forwarded-proto") ??
        (host.startsWith("localhost") ? "http" : "https");
      return `${proto}://${host}`;
    }
  } catch {
    // Rendered outside a request context — fall through.
  }

  if (process.env.VERCEL_URL) return normalize(process.env.VERCEL_URL);
  return process.env.NEXT_PUBLIC_URL ?? "http://localhost:3000";
}
