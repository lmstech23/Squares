// Is this account entitled to create Game Day boards? — Daali Slice 1, S1.7
// (Auth spec, "Game Day access", Enforcement / L2).
//
// The entitlement is organizer_profiles.legacy_boards_enabled. An account with
// no organizer_profiles row is NOT entitled (the production backfill gives every
// existing account a row before this ships). Reads one column of the account's
// own row; never writes.

import { prisma } from "@/lib/prisma";

export async function isGameDayEnabled(supabaseUserId: string | null | undefined): Promise<boolean> {
  if (!supabaseUserId) return false;
  const profile = await prisma.organizerProfile.findUnique({
    where: { userId: supabaseUserId },
    select: { legacyBoardsEnabled: true },
  });
  return profile?.legacyBoardsEnabled === true;
}
