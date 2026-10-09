import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { DEFAULT_AFTER_LOGIN } from "@/lib/login-return";
import { allowedNext } from "@/lib/next-path";

// CREATES NOTHING IN `hosts`. It exchanges the code and redirects. A Host is
// still created lazily by getHostOrNull the first time a legacy page needs one
// (Auth + Onboarding spec, "Host creation guard").
//
// `next` goes through the shared allowlist; anything else lands on the same
// default the login page uses.
export async function GET(request: Request) {
  const { searchParams, origin } = new URL(request.url);
  const code = searchParams.get("code");
  const next = allowedNext(searchParams.get("next")) ?? DEFAULT_AFTER_LOGIN;

  if (code) {
    const supabase = await createClient();
    const { data, error } = await supabase.auth.exchangeCodeForSession(code);

    if (!error && data.user) {
      return NextResponse.redirect(`${origin}${next}`);
    }
  }

  // Auth failed — redirect to login with error hint
  return NextResponse.redirect(`${origin}/login?error=auth`);
}
