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
