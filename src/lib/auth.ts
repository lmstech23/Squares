import { createClient } from "@/lib/supabase/server";
import { prisma } from "@/lib/prisma";
import { redirect } from "next/navigation";

/**
 * Get the authenticated Host record.
 * Redirects to /login if no session.
 * Returns null only if session exists but Host row doesn't (shouldn't happen).
 */
export async function getHost() {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    redirect("/login");
  }

  const host = await prisma.host.findUnique({
    where: { supabaseUserId: user.id },
  });

  return host;
}
