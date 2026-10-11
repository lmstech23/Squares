// Finalize: becoming a Daali account — Daali Slice 1, S1.4.
//
// Auth spec, "Finalize": on the first authenticated request from a
// non-anonymous user with a confirmed email and no organizer_profiles row, the
// server inserts that row with created_via = SIGNUP, prefilling display_name
// and avatar_url from Google when available. It runs in /auth/callback and
// /auth/confirm (and the /setup loader, S1.5).
//
// INSERT … ON CONFLICT DO NOTHING. `createMany({ skipDuplicates: true })` is
// exactly that statement, so running finalize twice — or twice at once, from
// two devices — leaves one row, and an existing row (a BACKFILL one included)
// is never rewritten.
//
// It reads only the Supabase user and writes only organizer_profiles. Never
// hosts, boards or credits (D8).

import type { User } from "@supabase/supabase-js";
import { prisma } from "@/lib/prisma";

export type FinalizeUser = Pick<
  User,
  "id" | "is_anonymous" | "email" | "email_confirmed_at" | "app_metadata" | "user_metadata" | "identities"
>;

export type ProfileSeed = {
  userId: string;
  displayName: string | null;
  avatarUrl: string | null;
  createdVia: "SIGNUP";
};

const text = (v: unknown): string | null => {
  if (typeof v !== "string") return null;
  const t = v.trim();
  return t ? t : null;
};

function signedInWithGoogle(user: FinalizeUser): boolean {
  const providers = user.app_metadata?.providers;
  if (Array.isArray(providers) && providers.includes("google")) return true;
  return (user.identities ?? []).some((i) => i.provider === "google");
}

/**
 * The row finalize would insert for this user, or null when finalize does not
 * apply: no user, an anonymous user, or no confirmed email. PURE.
 */
export function profileSeedFor(user: FinalizeUser | null | undefined): ProfileSeed | null {
  if (!user || user.is_anonymous === true) return null;
  if (!user.email || !user.email_confirmed_at) return null;

  const google = signedInWithGoogle(user);
  const meta = user.user_metadata ?? {};
  return {
    userId: user.id,
    displayName: google ? text(meta.full_name) ?? text(meta.name) : null,
    avatarUrl: google ? text(meta.avatar_url) ?? text(meta.picture) : null,
    createdVia: "SIGNUP",
  };
}

export type FinalizeResult = "created" | "existed" | "not-applicable";

/** Create this user's organizer_profiles row if it does not exist. */
export async function finalizeOrganizerProfile(user: FinalizeUser | null | undefined): Promise<FinalizeResult> {
  const seed = profileSeedFor(user);
  if (!seed) return "not-applicable";
  const { count } = await prisma.organizerProfile.createMany({ data: [seed], skipDuplicates: true });
  return count === 1 ? "created" : "existed";
}
