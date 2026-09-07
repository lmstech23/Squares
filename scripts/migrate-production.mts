#!/usr/bin/env node
// THE ONLY SANCTIONED WAY TO RUN A MIGRATION AGAINST PRODUCTION.
//
//   DIRECT_URL=… node --experimental-strip-types scripts/migrate-production.mts
//   DIRECT_URL=… node --experimental-strip-types scripts/migrate-production.mts --dry-run
//
// `npx prisma migrate deploy` run by hand takes whatever `DIRECT_URL` happens
// to hold and never says which database that is. On 2026-09-06 that is exactly
// how a set of gates came back PASS against a database that was not
// production: `.env.local` names beta.daali.app and points somewhere else, so
// the run looked correct in every respect.
//
// This wrapper asks the question first. THE GUARD RUNS BEFORE ANY CLIENT
// EXISTS — before Prisma is spawned, before a connection is opened — because a
// check performed after connecting has already touched the thing it was
// supposed to protect.
//
// It is a wrapper, not a reimplementation: the migration itself is still
// `prisma migrate deploy`, with its own transactional DO $$ gate inside the
// SQL. This adds one question in front of it, and refuses on any answer other
// than yes.

import { execFileSync } from "child_process";
import {
  assertProductionTarget,
  expectedProductionRef,
  WrongDatabaseError,
  PRODUCTION_DB_REF_VAR,
} from "../src/lib/db-target.ts";

const dryRun = process.argv.includes("--dry-run");

// READ FROM THE PROCESS ENVIRONMENT, never from a file this script chooses.
// Picking a file is how a script quietly acquires an opinion about which
// database is production; the operator supplies it, and the guard checks it.
const url = process.env.DIRECT_URL;

// DIRECT_URL, not DATABASE_URL. Migrations must not run over the pooler, and
// CLAUDE.md's S1 precondition is about the role on THIS connection: the
// `ALTER DEFAULT PRIVILEGES … FOR ROLE postgres` lines in 0_init govern only
// objects that role creates, so the role that runs the migration is the one
// that has to be right.
let ref: string;
try {
  ({ ref } = assertProductionTarget(url));
} catch (err) {
  if (err instanceof WrongDatabaseError) {
    console.error(`\nREFUSING TO MIGRATE — ${err.reason}\n`);
    console.error(err.message);
    console.error(
      `\nNothing was connected to and nothing was changed.\n` +
        `Expected production project: ${expectedProductionRef()}\n` +
        `Override for this invocation with ${PRODUCTION_DB_REF_VAR} if, and ` +
        `only if, production has genuinely moved.\n`
    );
    process.exit(2);
  }
  throw err;
}

console.log(`Target project: ${ref} — matches the expected production project.`);

// Prisma prints "Environment variables loaded from .env" whichever string it
// ends up using, and that line is exactly what a reader would take as
// reassurance. It is not: dotenv does not overwrite a variable that is already
// set, and both are set explicitly on the child below, so the guarded string
// wins. Verified 2026-09-07 by host - `.env` targets the aws-0 pooler, the
// guarded string targets aws-1, and Prisma reported aws-1.
const childEnv = { ...process.env, DIRECT_URL: url, DATABASE_URL: url };

if (dryRun) {
  // Prisma's own read-only report. Lists what WOULD be applied and connects
  // only to read `_prisma_migrations`.
  console.log("\nDry run — listing pending migrations, applying nothing.\n");
  try {
    execFileSync("npx", ["prisma", "migrate", "status"], {
      stdio: "inherit",
      shell: true,
      env: childEnv,
    });
  } catch {
    // `migrate status` EXITS NON-ZERO WHENEVER ANYTHING IS PENDING. That is
    // the normal answer to the question a dry run asks, not a failure -
    // treating it as one made this wrapper print a node stack trace over a
    // perfectly good report. The status output above IS the result.
    console.log(
      "\n(migrate status exited non-zero, which it does whenever migrations " +
        "are pending or a previous one failed. Read the report above - nothing " +
        "was applied either way.)"
    );
  }
  process.exit(0);
}

console.log("\nApplying pending migrations.\n");
// Both variables point at the guarded string for the duration of this child
// process only. Prisma reads the datasource `url` and its `directUrl`;
// pointing both at it is what stops a migration reaching another database
// because a datasource block resolved a certain way.
// NOTHING IS WRITTEN TO ANY .env FILE.
execFileSync("npx", ["prisma", "migrate", "deploy"], {
  stdio: "inherit",
  shell: true,
  env: childEnv,
});

console.log(
  "\nMigration complete. Now run the containment verification, which is " +
    "separate and still required:\n" +
    "  VERIFY_SITE_URL=https://beta.daali.app node --experimental-strip-types scripts/verify-containment.mts\n"
);
