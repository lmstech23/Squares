import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { finalizeOrganizerProfile } from "@/lib/finalize-organizer";
import { resolveOrganizerState } from "@/lib/organizer-state";
import { postAuthDestination } from "@/lib/post-auth-destination";

// CREATES NOTHING IN `hosts`. It exchanges the code, runs finalize (the
// organizer_profiles row, insert-or-nothing) and redirects through the
// post-auth gate (post-auth-destination.ts): an allowlisted /host or /invite
// `next`, else /setup while setup is incomplete, else today's default. A Host
// is still created lazily by getHostOrNull the first time a legacy page needs
// one (Auth + Onboarding spec, "Host creation guard").
export async function GET(request: Request) {
  const { searchParams, origin } = new URL(request.url);
  const code = searchParams.get("code");

  if (code) {
    const supabase = await createClient();
    const { data, error } = await supabase.auth.exchangeCodeForSession(code);

    if (!error && data.user) {
      await finalizeOrganizerProfile(data.user);
      const destination = postAuthDestination(await resolveOrganizerState(data.user), searchParams.get("next"));
      return NextResponse.redirect(`${origin}${destination}`);
    }
  }

  // Auth failed — redirect to sign-in with error hint
  return NextResponse.redirect(`${origin}/sign-in?error=auth`);
}
