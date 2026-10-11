"use server";

// The server half of every sign-in that completes in the browser — Daali
// Slice 1, S1.4.
//
// The Auth spec has the client call Supabase (signInWithOtp, verifyOtp), so
// rate limits and, later, CAPTCHA tokens stay per browser. What must happen on
// the server afterwards is the same for each of them: read the session the
// browser just stored, run finalize, and say where to go next.
//
// WHERE TO GO, in S1.4: an allowlisted `next`, else today's default. The gate's
// own destinations, /setup (S1.5) and /home (S1.6), do not exist yet, so the
// organizer state does not change the destination in this step.

import { createClient } from "@/lib/supabase/server";
import { finalizeOrganizerProfile } from "@/lib/finalize-organizer";
import { safeReturnPath } from "@/lib/login-return";

export async function completeSignIn(next: string | null): Promise<string> {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user || user.is_anonymous) return "/sign-in";

  await finalizeOrganizerProfile(user);
  return safeReturnPath(next);
}
