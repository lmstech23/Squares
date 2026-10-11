import { permanentRedirect } from "next/navigation";
import { loginRedirectTarget } from "@/lib/login-redirect";

// /login is retired — Daali Slice 1, S1.4. The Board-era sign-in page is
// replaced by /sign-in (Auth spec, "Removals and cleanup"). Every existing link
// to /login — invitations included — lands there permanently, with its query
// string, so `next` survives.

export default async function LoginRedirect({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  permanentRedirect(loginRedirectTarget(await searchParams));
}
