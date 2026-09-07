#!/usr/bin/env node
// Disposable Postgres for the integration tests.
//
//   npm run test:db:up      start the container and build the schema
//   npm run test:integration run the real-database tests against it
//   npm run test:db:down    throw it away
//
// Why a container rather than a Supabase project: it costs nothing, starts in
// seconds, never auto-pauses, and is disposable — a failed test run is fixed by
// deleting it. Nothing here can reach production.
//
// The schema is built by REPLAYING prisma/migrations, from a COPY of
// schema.prisma with the URL hardcoded, never from an env override. If a
// variable ever failed to override .env, the command would run against
// production; the copy makes that impossible rather than unlikely, and it is
// generated fresh each run.
//
// Why replay and not `db push`: db push generates DDL from the Prisma models,
// and a CHECK constraint is invisible to them. Every CHECK this project relies
// on exists only in migration SQL, so a db push database silently ACCEPTS the
// rows those constraints exist to reject — a test asserting the rejection then
// fails for a reason that has nothing to do with the code under test. Replay
// gives the tests the same database production has.
//
// db push had one property replay does not: the test database could not drift
// from schema.prisma. That property is now stated rather than free — the
// `migrate diff` below asserts the replayed database matches the models, and
// fails the build if a migration and the schema have parted ways.

import { execFileSync } from "child_process";
import { readFileSync, writeFileSync, mkdtempSync, cpSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

const NAME = "daali-test-db";
const PORT = 55432;
export const TEST_URL = `postgresql://postgres:daali@localhost:${PORT}/daali_test`;

const run = (cmd, args, opts = {}) =>
  execFileSync(cmd, args, { stdio: "inherit", shell: true, ...opts });

const quiet = (cmd, args) => {
  try {
    return execFileSync(cmd, args, { stdio: "pipe", shell: true }).toString();
  } catch {
    return null;
  }
};

function up() {
  if (!quiet("docker", ["info"])) {
    console.error(
      "Docker is not running. Start Docker Desktop and try again."
    );
    process.exit(1);
  }

  quiet("docker", ["rm", "-f", NAME]);
  run("docker", [
    "run", "-d",
    "--name", NAME,
    "-e", "POSTGRES_PASSWORD=daali",
    "-e", "POSTGRES_DB=daali_test",
    "-p", `${PORT}:5432`,
    "postgres:16-alpine",
  ]);

  process.stdout.write("waiting for postgres");
  for (let i = 0; i < 30; i++) {
    if (quiet("docker", ["exec", NAME, "pg_isready", "-U", "postgres"])) {
      console.log(" ready");
      break;
    }
    process.stdout.write(".");
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 1000);
  }

  // Hardcode the URL into a throwaway copy of the schema. See the note above.
  const schema = readFileSync("prisma/schema.prisma", "utf8");
  const replaced = schema.replace(
    /datasource db \{[^}]*\}/,
    `datasource db {\n  provider = "postgresql"\n  url      = "${TEST_URL}"\n}`
  );
  if (replaced === schema) {
    console.error("Could not rewrite the datasource block — aborting.");
    process.exit(1);
  }

  const dir = mkdtempSync(join(tmpdir(), "daali-schema-"));
  const path = join(dir, "schema.prisma");
  writeFileSync(path, replaced);
  // migrate deploy resolves prisma/migrations relative to the schema it is given.
  cpSync("prisma/migrations", join(dir, "migrations"), { recursive: true });
  run("npx", ["prisma", "migrate", "deploy", "--schema", path]);

  // The property db push gave for free, now asserted. A null result is a
  // non-zero exit from --exit-code: the replay and the models disagree.
  const drift = quiet("npx", [
    "prisma", "migrate", "diff",
    "--from-url", JSON.stringify(TEST_URL),
    "--to-schema-datamodel", JSON.stringify(path),
    "--exit-code",
  ]);
  if (drift === null) {
    console.error(
      "\nThe replayed database does not match prisma/schema.prisma.\n" +
        "A migration and the models have drifted. To see the difference:\n" +
        "  npx prisma migrate diff --from-url " + JSON.stringify(TEST_URL) +
        " --to-schema-datamodel prisma/schema.prisma --script"
    );
    process.exit(1);
  }

  console.log(`\nReady. TEST_DATABASE_URL=${TEST_URL}`);
}

function down() {
  quiet("docker", ["rm", "-f", NAME]);
  console.log("test database removed");
}

const cmd = process.argv[2];
if (cmd === "up") up();
else if (cmd === "down") down();
else {
  console.error("usage: node scripts/test-db.mjs up|down");
  process.exit(1);
}
