import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { AppShell } from "@/components/daali/AppShell";
import { EmptyState } from "@/components/daali/EmptyState";
import { OrganizerFooter, PageHeading, SectionHeading, Stack } from "@/components/daali/Layout";
import { OrganizerItemCard } from "@/components/daali/OrganizerItemCard";
import { createClient } from "@/lib/supabase/server";
import { prisma } from "@/lib/prisma";
import { listOrganizerItems } from "@/lib/organizer-items";
import { organizerStateFor } from "@/lib/organizer-state";
import { postAuthDestination } from "@/lib/post-auth-destination";

// Your Daali (/home) — Daali Slice 1, S1.6.
//
// Product Flow Spec, "Your Daali (/home)", as narrowed by D-S1-4: the greeting
// and Your organizing only. No AI card and no type cards, because no organizer
// type has a live creation flow yet. Avatar menu per D-S1-5: Legacy Boards
// (only with legacy_boards_visible) and Sign out.
//
// RENDERING WRITES NOTHING. It reads the Supabase user, the organizer's own
// organizer_profiles row and the read model (listOrganizerItems), all selects.
// It never calls getHost / getHostOrNull, so it never creates a Host (T23).
// The items come only from the read model; nothing here touches a Board.

export const metadata: Metadata = { title: "Your Daali" };
export const dynamic = "force-dynamic";

/** "Hi, {first name}." — the first word of the display name. */
function firstName(displayName: string): string {
  return displayName.trim().split(/\s+/)[0] ?? displayName;
}

export default async function HomePage() {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user || user.is_anonymous) redirect("/sign-in?next=%2Fhome");

  const profile = await prisma.organizerProfile.findUnique({
    where: { userId: user.id },
    select: { displayName: true, avatarUrl: true, legacyBoardsVisible: true },
  });

  // /home requires COMPLETE. Anyone else goes where the gate sends them (/setup).
  const state = organizerStateFor(user, profile);
  if (state !== "COMPLETE" || !profile?.displayName) redirect(postAuthDestination(state, null));

  const items = await listOrganizerItems(user.id);
  const displayName = profile.displayName.trim();

  return (
    <AppShell
      displayName={displayName}
      avatarUrl={profile.avatarUrl}
      legacyBoardsHref={profile.legacyBoardsVisible ? "/host/boards" : null}
      signedOutHref="/sign-in"
      homeHref="/home"
    >
      <PageHeading eyebrow={`Hi, ${firstName(displayName)}.`} title="What are you organizing?" />

      <section aria-labelledby="your-organizing">
        <SectionHeading title={<span id="your-organizing">Your organizing</span>} subtitle="Everything you're organizing, all in one place." />
        {items.length ? (
          <Stack gap={16}>
            {items.map((item) => (
              <OrganizerItemCard key={item.id} item={item} />
            ))}
          </Stack>
        ) : (
          <EmptyState
            title="Nothing here yet. Your first Daali starts above."
            body="Describe your plan or choose a starting point — you'll always review the details first."
            titleAs="h3"
          />
        )}
      </section>

      <OrganizerFooter />
    </AppShell>
  );
}
