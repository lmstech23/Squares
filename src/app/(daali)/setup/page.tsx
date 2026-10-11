import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { prisma } from "@/lib/prisma";
import { finalizeOrganizerProfile } from "@/lib/finalize-organizer";
import { organizerStateFor } from "@/lib/organizer-state";
import { postAuthDestination } from "@/lib/post-auth-destination";
import { setupSteps } from "@/lib/setup-steps";
import { SetupFlow } from "./setup-flow";

// Screen 3: Finish setting up your Daali (/setup) — Daali Slice 1, S1.5.
//
// The loader runs finalize (Auth spec, "Finalize"), reads the organizer state,
// and shows only what is missing. A COMPLETE organizer is sent on: to today's
// default until /home exists (S1.6).
//
// Legacy /host/* pages are NOT gated on any of this; an organizer can leave
// setup at any point and still manage their Boards.

export const metadata: Metadata = { title: "Finish setting up your Daali" };
export const dynamic = "force-dynamic";

export default async function SetupPage() {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user || user.is_anonymous) redirect("/sign-in");

  await finalizeOrganizerProfile(user);
  const profile = await prisma.organizerProfile.findUnique({
    where: { userId: user.id },
    select: { displayName: true },
  });

  const state = organizerStateFor(user, profile);
  if (state === "COMPLETE") redirect(postAuthDestination(state, null));

  const [step] = setupSteps(user, profile);

  // Resend after 60 seconds, counted from when the pending email was sent.
  const sentAt = user.email_change_sent_at ? Date.parse(user.email_change_sent_at) : NaN;
  const emailCooldownLeft = Number.isNaN(sentAt) ? 0 : Math.max(0, 60 - Math.floor((Date.now() - sentAt) / 1000));

  return <SetupFlow step={step} emailCooldownLeft={emailCooldownLeft} />;
}
