// One-off backfill: an organizer_profiles row for every existing, non-anonymous
// Supabase auth user — Daali Slice 1, S1.1.
//
//   DIRECT_URL=… node --experimental-strip-types scripts/backfill-organizer-profiles.mts
//   DIRECT_URL=… node --experimental-strip-types scripts/backfill-organizer-profiles.mts --legacy-tester=<email>
//   DIRECT_URL=… node --experimental-strip-types scripts/backfill-organizer-profiles.mts --apply [--legacy-tester=<email>]
//
// DRY RUN BY DEFAULT. Without --apply it reads auth.users, hosts and (if it
// exists) organizer_profiles, prints what it WOULD create, and writes nothing.
//
// WHICH DATABASE IS ASKED FIRST, before any client exists (src/lib/db-target.ts):
//   - a dry run REFUSES the production project. It is for dev rehearsal only.
//   - --apply goes through assertProductionTarget, the same guard
//     scripts/migrate-production.mts uses: it refuses anything that is not the
//     expected production project.
//   - a connection string whose project ref cannot be derived is refused.
//
// The connection string is read from the process environment, never from a
// file this script chooses, and is never printed. Reads: auth.users, hosts,
// organizer_profiles. Writes (only with --apply): organizer_profiles.
// The rules for who gets a row and what it says are in
// src/lib/organizer-profile-backfill.ts, which is unit-tested.

import { PrismaClient } from "@prisma/client";
import {
  assertProductionTarget,
  deriveProjectRef,
  expectedProductionRef,
} from "../src/lib/db-target.ts";
import {
  maskEmail,
  planOrganizerProfiles,
  type AuthUserRow,
} from "../src/lib/organizer-profile-backfill.ts";

const args = process.argv.slice(2);
const apply = args.includes("--apply");
const testerArg = args.find((a) => a.startsWith("--legacy-tester="));
const legacyTesterEmail = testerArg ? testerArg.slice("--legacy-tester=".length) : null;
const unknown = args.filter((a) => a !== "--apply" && !a.startsWith("--legacy-tester="));
if (unknown.length) {
  console.error(`Unknown argument(s): ${unknown.join(" ")}`);
  process.exit(2);
}

const url = process.env.DIRECT_URL;
if (!url) {
  console.error("DIRECT_URL is not set. Supply it for this invocation only.");
  process.exit(2);
}

// ── the target, before any client exists ────────────────────────────────────
const ref = deriveProjectRef(url);
if (apply) {
  assertProductionTarget(url); // throws WrongDatabaseError on anything else
} else {
  if (!ref) {
    console.error("Refusing: the Supabase project ref cannot be derived from DIRECT_URL.");
    process.exit(2);
  }
  if (ref === expectedProductionRef()) {
    console.error("Refusing: a dry run never connects to the production project. It is for dev rehearsal.");
    process.exit(2);
  }
}
console.log(`mode: ${apply ? "APPLY" : "dry run (writes nothing)"}`);
console.log(`target project ref: ${ref}`);
console.log(`legacy tester: ${legacyTesterEmail ? maskEmail(legacyTesterEmail) : "(unset)"}`);

const db = new PrismaClient({ datasources: { db: { url } } });
try {
  const rawUsers = await db.$queryRaw<{ id: string; email: string | null; is_anonymous: boolean | null }[]>`
    SELECT id::text AS id, email, is_anonymous FROM auth.users`;
  const users: AuthUserRow[] = rawUsers.map((u) => ({ id: u.id, email: u.email, isAnonymous: u.is_anonymous === true }));
  const hosts = await db.host.findMany({ select: { supabaseUserId: true, name: true } });

  const [{ present }] = await db.$queryRaw<{ present: boolean }[]>`
    SELECT to_regclass('public.organizer_profiles') IS NOT NULL AS present`;
  const existing = present
    ? (await db.$queryRaw<{ user_id: string }[]>`SELECT user_id FROM public.organizer_profiles`).map((r) => r.user_id)
    : [];

  const plan = planOrganizerProfiles(users, hosts, { legacyTesterEmail, existingUserIds: existing });
  const emailById = new Map(users.map((u) => [u.id, u.email]));
  const hostsWithUser = hosts.filter((h) => h.supabaseUserId).length;

  console.log("");
  console.log(`auth users:                 ${users.length}`);
  console.log(`  anonymous (excluded):     ${users.filter((u) => u.isAnonymous).length}`);
  console.log(`  already have a profile:   ${existing.length}${present ? "" : " (organizer_profiles does not exist here)"}`);
  console.log(`hosts:                      ${hosts.length} (${hostsWithUser} linked to an auth user)`);
  console.log(`profiles to create:         ${plan.length}`);
  console.log(`  with a display_name:      ${plan.filter((p) => p.displayName).length}`);
  console.log(`  legacy_boards_visible:    ${plan.filter((p) => p.legacyBoardsVisible).length}`);
  console.log("");
  console.log(plan.length ? "sample (up to 5, emails masked):" : "sample: (none: nothing to create)");
  for (const p of plan.slice(0, 5)) {
    console.log(
      `  ${maskEmail(emailById.get(p.userId))}  display_name=${p.displayName ? `"${p.displayName[0]}…" (${p.displayName.length} chars)` : "null"}` +
        `  legacy_boards_visible=${p.legacyBoardsVisible}  created_via=${p.createdVia}`
    );
  }

  if (apply) {
    if (!present) throw new Error("organizer_profiles does not exist on the target. Apply the migration first.");
    const result = await db.organizerProfile.createMany({ data: plan, skipDuplicates: true });
    console.log(`\nAPPLIED: ${result.count} row(s) inserted into organizer_profiles.`);
  } else {
    console.log("\nDry run: nothing was written.");
  }
} finally {
  await db.$disconnect();
}
