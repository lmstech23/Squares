// Where a signed-in person stands as a Daali organizer — Daali Slice 1, S1.2.
//
// ONE RESOLVER. The Auth + Onboarding spec, "Post-auth gate and routing": every
// page and route that needs to know uses this; nothing re-derives the answer.
//
//   SIGNED_OUT        no user, or an anonymous user
//   NO_PROFILE        signed in, no organizer_profiles row
//   SETUP_INCOMPLETE  profile exists, but display_name is empty or the user's
//                     phone_confirmed_at is null
//   COMPLETE          profile with a name, and a confirmed phone
//
// IT READS ONLY THE SUPABASE USER AND organizer_profiles. Never `hosts`, never
// getHost / getHostOrNull, credits, paymentPreference, Stripe fields or boards
// (spec D8). Phone confirmation comes from the Supabase user, which is its
// source of truth; organizer_profiles holds no phone.
//
// Nothing routes on this yet. /sign-in, /setup and /home arrive in S1.4–S1.6
// and are where the states turn into redirects. Legacy /host/* pages are
// deliberately NOT gated on it in this release.

import type { User } from "@supabase/supabase-js";
import { prisma } from "@/lib/prisma";

export type OrganizerState = "SIGNED_OUT" | "NO_PROFILE" | "SETUP_INCOMPLETE" | "COMPLETE";

/** The fields of the Supabase user the resolver reads, and nothing more. */
export type OrganizerStateUser = Pick<User, "id" | "is_anonymous" | "phone_confirmed_at">;

/** The fields of an organizer_profiles row the resolver reads. */
export type OrganizerStateProfile = { displayName: string | null };

/**
 * The state for a user and their profile row (null when there is none).
 * PURE: the decision table, with no database.
 */
export function organizerStateFor(
  user: OrganizerStateUser | null | undefined,
  profile: OrganizerStateProfile | null
): OrganizerState {
  if (!user || user.is_anonymous === true) return "SIGNED_OUT";
  if (!profile) return "NO_PROFILE";
  const hasName = (profile.displayName?.trim() ?? "") !== "";
  const hasPhone = Boolean(user.phone_confirmed_at);
  return hasName && hasPhone ? "COMPLETE" : "SETUP_INCOMPLETE";
}

/** The organizer state for this Supabase user, reading organizer_profiles. */
export async function resolveOrganizerState(
  user: OrganizerStateUser | null | undefined
): Promise<OrganizerState> {
  // Signed out is decided from the user alone, without a query.
  if (!user || user.is_anonymous === true) return "SIGNED_OUT";
  const profile = await prisma.organizerProfile.findUnique({
    where: { userId: user.id },
    select: { displayName: true },
  });
  return organizerStateFor(user, profile);
}
