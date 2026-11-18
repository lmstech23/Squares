// One-time backfill: an organizer_profiles row for every existing, non-anonymous
// Supabase auth user — Daali Slice 1, S1.1, with Game Day access from S1.7.
//
//   DIRECT_URL=… node --experimental-strip-types scripts/backfill-organizer-profiles.mts
//   DIRECT_URL=… node --experimental-strip-types scripts/backfill-organizer-profiles.mts --apply
//
// ONE-TIME, RERUN-SAFE (Auth spec, "Backfill for existing users", amended Oct
// 11). It runs once, at the L2 release, before the release is reachable. It
// sets legacy_boards_enabled = true for every account whose Host owns a Game
// Day board and false for everyone else. It ONLY INSERTS rows that are
// missing and never updates one, so a rerun cannot restore Game Day access an
// administrator removed and cannot clear access an access link granted. A Game
// Day owner who already has a row without the flag is reported as a count and
// left alone. How that is enforced: src/lib/organizer-profile-backfill-db.ts.
//
// DRY RUN BY DEFAULT. Without --apply it reads auth.users, hosts, boards and
// (if it exists) organizer_profiles, prints what it WOULD create, and writes
// nothing.
//
// WHICH DATABASE IS ASKED FIRST, before any client exists (src/lib/db-target.ts):
//   - a dry run REFUSES the production project. It is for dev rehearsal only.
//   - --apply goes through assertProductionTarget, the same guard
//     scripts/migrate-production.mts uses: it refuses anything that is not the
//     expected production project.
//   - a connection string whose project ref cannot be derived is refused,
//     except a loopback address, which a dry run accepts (the local stack).
//
// The connection string is read from the process environment, never from a
// file this script chooses, and is never printed. Reads: auth.users, hosts,
// boards, organizer_profiles. Writes (only with --apply): organizer_profiles.

import { PrismaClient } from "@prisma/client";
import {
  assertProductionTarget,
  deriveProjectRef,
  expectedProductionRef,
} from "../src/lib/db-target.ts";
import { maskEmail } from "../src/lib/organizer-profile-backfill.ts";
import { insertPlannedProfiles, loadBackfillPlan } from "../src/lib/organizer-profile-backfill-db.ts";

const args = process.argv.slice(2);
const apply = args.includes("--apply");
const unknown = args.filter((a) => a !== "--apply");
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
const loopback = (() => {
  try {
    return ["127.0.0.1", "localhost", "[::1]"].includes(new URL(url).hostname);
  } catch {
    return false;
  }
})();
const ref = deriveProjectRef(url);
if (apply) {
  assertProductionTarget(url); // throws WrongDatabaseError on anything else
} else {
  if (!ref && !loopback) {
    console.error("Refusing: the Supabase project ref cannot be derived from DIRECT_URL.");
    process.exit(2);
  }
  if (ref === expectedProductionRef()) {
    console.error("Refusing: a dry run never connects to the production project. It is for dev rehearsal.");
    process.exit(2);
  }
}
console.log(`mode: ${apply ? "APPLY" : "dry run (writes nothing)"}`);
console.log(`target: ${ref ? `project ref ${ref}` : "local stack (loopback)"}`);

const db = new PrismaClient({ datasources: { db: { url } } });
try {
  const r = await loadBackfillPlan(db);
  const { plan } = r;
  const emailById = new Map(r.users.map((u) => [u.id, u.email]));

  console.log("");
  console.log(`auth users:                  ${r.users.length}`);
  console.log(`  anonymous (excluded):      ${r.users.filter((u) => u.isAnonymous).length}`);
  console.log(`  already have a profile:    ${r.existingCount}${r.profilesPresent ? "" : " (organizer_profiles does not exist here)"}`);
  console.log(`hosts:                       ${r.hostCount} (${r.hostsWithUser} linked to an auth user)`);
  console.log(`profiles to create:          ${plan.create.length}`);
  console.log(`  with a display_name:       ${plan.create.filter((p) => p.displayName).length}`);
  console.log(`  legacy_boards_enabled:     ${plan.create.filter((p) => p.legacyBoardsEnabled).length}  (Game Day owners without a row)`);
  console.log(`Game Day owners who already have a row WITHOUT the flag: ${plan.ownersWithRowWithoutFlag.length}`);
  console.log(`  (left unchanged; resolve each with a Game Day access link)`);
  console.log("");
  console.log(plan.create.length ? "sample (up to 5, emails masked):" : "sample: (none: nothing to create)");
  for (const p of plan.create.slice(0, 5)) {
    console.log(
      `  ${maskEmail(emailById.get(p.userId))}  display_name=${p.displayName ? `"${p.displayName[0]}…" (${p.displayName.length} chars)` : "null"}` +
        `  legacy_boards_enabled=${p.legacyBoardsEnabled}  created_via=${p.createdVia}`
    );
  }

  if (apply) {
    if (!r.profilesPresent) throw new Error("organizer_profiles does not exist on the target. Apply the migration first.");
    const inserted = await insertPlannedProfiles(db, plan);
    console.log(`\nAPPLIED: ${inserted} row(s) inserted into organizer_profiles. No existing row was changed.`);
  } else {
    console.log("\nDry run: nothing was written.");
  }
} finally {
  await db.$disconnect();
}
