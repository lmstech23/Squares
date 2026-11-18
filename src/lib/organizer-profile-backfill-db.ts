// The organizer_profiles backfill's database reads and its one write — Daali
// Slice 1, S1.7. Shared by scripts/backfill-organizer-profiles.mts and the
// rerun test, so the test exercises exactly the statement the script runs.
//
// INSERT-ONLY, enforced twice:
//   1. the plan never contains a user who already has a row
//      (planOrganizerProfiles skips them), and
//   2. the write is `createMany({ skipDuplicates: true })`, which Prisma issues
//      as INSERT … ON CONFLICT DO NOTHING against the organizer_profiles
//      primary key (user_id). There is no UPDATE and no upsert anywhere in the
//      backfill, so a row that exists — or appears between the read and the
//      write — is left exactly as it is.

import type { PrismaClient } from "@prisma/client";
import { planOrganizerProfiles, type AuthUserRow, type BackfillPlan } from "./organizer-profile-backfill.ts";

export type BackfillInputs = {
  users: AuthUserRow[];
  hostsWithUser: number;
  hostCount: number;
  profilesPresent: boolean;
  existingCount: number;
  plan: BackfillPlan;
};

/** Read everything the plan needs and build it. Reads only. */
export async function loadBackfillPlan(db: PrismaClient): Promise<BackfillInputs> {
  const rawUsers = await db.$queryRaw<{ id: string; email: string | null; is_anonymous: boolean | null }[]>`
    SELECT id::text AS id, email, is_anonymous FROM auth.users`;
  const users: AuthUserRow[] = rawUsers.map((u) => ({ id: u.id, email: u.email, isAnonymous: u.is_anonymous === true }));
  const hosts = await db.host.findMany({ select: { supabaseUserId: true, name: true } });

  const owners = await db.$queryRaw<{ user_id: string }[]>`
    SELECT DISTINCT h.supabase_user_id AS user_id
      FROM hosts h
      JOIN boards b ON b.host_id = h.id
     WHERE b.board_type = 'game' AND h.supabase_user_id IS NOT NULL`;

  const [{ present }] = await db.$queryRaw<{ present: boolean }[]>`
    SELECT to_regclass('public.organizer_profiles') IS NOT NULL AS present`;
  const existing = present
    ? await db.$queryRaw<{ user_id: string; legacy_boards_enabled: boolean }[]>`
        SELECT user_id, legacy_boards_enabled FROM public.organizer_profiles`
    : [];

  return {
    users,
    hostsWithUser: hosts.filter((h) => h.supabaseUserId).length,
    hostCount: hosts.length,
    profilesPresent: present,
    existingCount: existing.length,
    plan: planOrganizerProfiles({
      users,
      hosts,
      gameDayOwnerUserIds: owners.map((o) => o.user_id),
      existingProfiles: existing.map((e) => ({ userId: e.user_id, legacyBoardsEnabled: e.legacy_boards_enabled })),
    }),
  };
}

/** The backfill's only write: insert the planned rows, never touching an existing one. */
export async function insertPlannedProfiles(db: PrismaClient, plan: BackfillPlan): Promise<number> {
  const { count } = await db.organizerProfile.createMany({ data: plan.create, skipDuplicates: true });
  return count;
}
