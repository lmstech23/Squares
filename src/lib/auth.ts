import { createClient } from "@/lib/supabase/server";
import { prisma } from "@/lib/prisma";
import { redirect } from "next/navigation";

export async function getHost() {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    redirect("/login");
  }

  let host = await prisma.host.findUnique({
    where: { supabaseUserId: user.id },
  });

  if (!host) {
    const identifier = user.email ?? user.phone ?? user.id;
    host = await prisma.host.create({
      data: {
        supabaseUserId: user.id,
        email: identifier,
        name: user.user_metadata?.full_name ?? null,
      },
    });
  }

  return host;
}