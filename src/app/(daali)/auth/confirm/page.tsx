import type { Metadata } from "next";
import { AuthFrame } from "@/components/daali/AuthFrame";
import { ConfirmButton } from "./confirm-button";

export const metadata: Metadata = {
  title: "Continue to Daali",
  // A token-bearing URL. Keep it out of search and out of referrers.
  robots: { index: false, follow: false },
  referrer: "no-referrer",
};

type Params = {
  token_hash?: string | string[];
  type?: string | string[];
  redirect_to?: string | string[];
  next?: string | string[];
};
const one = (v: string | string[] | undefined) => (typeof v === "string" && v ? v : null);

/**
 * `next` arrives inside `redirect_to` (the emailRedirectTo the screen asked
 * for, which the templates pass through). Read it out; it is validated against
 * the allowlist only when it is used, in completeSignIn.
 */
function nextFrom(params: Params): string | null {
  const redirect = one(params.redirect_to);
  if (redirect) {
    try {
      return new URL(redirect).searchParams.get("next");
    } catch {
      return null;
    }
  }
  return one(params.next);
}

/**
 * The link's type, from an allowlist of two: "email" (sign-in and sign-up) and
 * "email_change" (adding an email at /setup). Anything else is treated as
 * "email", which a mismatched token simply fails.
 */
function typeFrom(params: Params): "email" | "email_change" {
  return one(params.type) === "email_change" ? "email_change" : "email";
}

export default async function ConfirmPage({ searchParams }: { searchParams: Promise<Params> }) {
  const params = await searchParams;
  return (
    <AuthFrame title="Continue to Daali">
      <ConfirmButton tokenHash={one(params.token_hash)} type={typeFrom(params)} next={nextFrom(params)} />
    </AuthFrame>
  );
}
