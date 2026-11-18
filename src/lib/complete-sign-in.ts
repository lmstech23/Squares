"use server";

// The server half of every sign-in that completes in the browser — Daali
// Slice 1, S1.4, routed by the organizer state from S1.5.
//
// The Auth spec has the client call Supabase (signInWithOtp, verifyOtp), so
// rate limits and, later, CAPTCHA tokens stay per browser. What must happen on
// the server afterwards is the same for each of them: read the session the
// browser just stored, run finalize, and say where to go next
// (post-auth-destination.ts).

import { createClient } from "@/lib/supabase/server";
import { finalizeOrganizerProfile } from "@/lib/finalize-organizer";
import { resolveOrganizerState } from "@/lib/organizer-state";
import { postAuthDestination } from "@/lib/post-auth-destination";

export async function completeSignIn(next: string | null): Promise<string> {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user || user.is_anonymous) return "/sign-in";

  await finalizeOrganizerProfile(user);
  return postAuthDestination(await resolveOrganizerState(user), next);
}
