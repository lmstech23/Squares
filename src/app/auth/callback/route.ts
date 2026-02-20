import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { prisma } from "@/lib/prisma";

export async function GET(request: Request) {
  const { searchParams, origin } = new URL(request.url);
  const code = searchParams.get("code");
  const next = searchParams.get("next") ?? "/host/boards";

  if (code) {
    const supabase = await createClient();
    const { data, error } = await supabase.auth.exchangeCodeForSession(code);

    if (!error && data.user) {
      const identifier = data.user.email ?? data.user.phone ?? data.user.id;

      await prisma.host.upsert({
        where: { supabaseUserId: data.user.id },
        update: {
          email: identifier,
        },
        create: {
          supabaseUserId: data.user.id,
          email: identifier,
          name: data.user.user_metadata?.full_name ?? null,
        },
      });

      return NextResponse.redirect(`${origin}${next}`);
    }
  }

  return NextResponse.redirect(`${origin}/login?error=auth`);
}