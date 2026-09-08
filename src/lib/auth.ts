import { createClient } from "@/lib/supabase/server";
import { prisma } from "@/lib/prisma";
import { redirect } from "next/navigation";

// TWO SURFACES, TWO ANSWERS TO "you are not signed in".
//
// A browser landing on a host page should be taken to the login screen. An API
// caller should be told 401 and left to decide what that means; sending it a
// redirect to an HTML login page is an answer no client can use, and `fetch`
// follows it silently and hands back a 200 full of markup.
//
// Both resolve the SAME identity by the same route: Supabase authenticated user
// -> `Host.supabaseUserId`, the only unique column on the table. The split is
// about what happens when there is no user, and nothing else.

/**
 * The authenticated host, or null. NEVER redirects.
 *
 * For API routes and for `requireBoardAccess`, which has to be able to RETURN
 * 401 rather than throw a navigation. `getHost()` below is this function plus a
 * redirect, so there is one identity path and one lazy-upsert, not two.
 */
export async function getHostOrNull() {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) return null;

  let host = await prisma.host.findUnique({
    where: { supabaseUserId: user.id },
  });

  if (!host) {
    const identifier = user.email ?? user.phone ?? user.id;
    try {
      host = await prisma.host.upsert({
        where: { supabaseUserId: user.id },
        update: {
          email: identifier,
        },
        create: {
          supabaseUserId: user.id,
          email: identifier,
          name: user.user_metadata?.full_name ?? null,
          boardCredits: 2,
        },
      });
    } catch (e: any) {
      // P2002 = unique constraint race — another request already created it
      if (e?.code === "P2002") {
        host = await prisma.host.findUniqueOrThrow({
          where: { supabaseUserId: user.id },
        });
      } else {
        throw e;
      }
    }
  }

  return host;
}

/**
 * The authenticated host, redirecting to /login when there is none.
 *
 * FOR PAGES. Its return type is non-null because the redirect throws, which is
 * why every `if (!host)` guard in a route that calls this has always been dead
 * code — the reason API routes now use `getHostOrNull` instead.
 */
export async function getHost() {
  const host = await getHostOrNull();
  if (!host) {
    redirect("/login");
  }
  return host;
}
