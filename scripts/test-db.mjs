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
// The schema is built with `prisma db push` from a COPY of schema.prisma with
// the URL hardcoded, never from an env override. If a variable ever failed to
// override .env, db push would run against production, and `db push` is the
// one command that reconciles by generating its own DDL. The copy makes that
// impossible rather than unlikely. It is generated fresh each run, so it
// cannot drift from the real schema.

import { execFileSync } from "child_process";
import { readFileSync, writeFileSync, mkdtempSync } from "fs";
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

  const path = join(mkdtempSync(join(tmpdir(), "daali-schema-")), "schema.prisma");
  writeFileSync(path, replaced);
  run("npx", ["prisma", "db", "push", "--schema", path, "--skip-generate"]);

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
