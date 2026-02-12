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
      // Upsert Host record keyed by Supabase auth user ID
      await prisma.host.upsert({
        where: { supabaseUserId: data.user.id },
        update: {
          email: data.user.email!,
        },
        create: {
          supabaseUserId: data.user.id,
          email: data.user.email!,
          name: data.user.user_metadata?.full_name ?? null,
        },
      });

      return NextResponse.redirect(`${origin}${next}`);
    }
  }

  // Auth failed — redirect to login with error hint
  return NextResponse.redirect(`${origin}/login?error=auth`);
}
