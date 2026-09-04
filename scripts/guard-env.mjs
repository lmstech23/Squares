#!/usr/bin/env node
import { readFileSync, existsSync } from "node:fs";

// scripts/guard-env.mjs
// ============================================================================
// ENVIRONMENT GUARD — enforces invariants E1, E2 and E3 mechanically.
//
// A BACKSTOP, NOT THE ENVIRONMENT SPLIT. This refuses obviously-wrong pairings
// of database and Stripe mode. It does not create a safe environment and it is
// not a substitute for one. A direct `npx prisma migrate dev` bypasses npm
// scripts entirely and never runs this file — see "Known bypasses" below.
//
// The production project ref is hardcoded on purpose. It is a NON-SECRET
// identifier: it appears in NEXT_PUBLIC_SUPABASE_URL, which ships to every
// browser. Hardcoding it means the guard cannot be defeated by editing an env
// var, which is exactly the mistake it exists to catch.
// ============================================================================

const PROD_PROJECT_REF = "xfmonzvdlxbeskugrjmk";

// npm does NOT load .env — Prisma and Next each load their own. So the guard
// reads them itself, or it would run with an empty environment and pass
// everything. Both files are inspected: Prisma reads .env, Next prefers
// .env.local, and a DIRECT_URL left pointing at production in either one is the
// exact mistake E3 exists to catch.
function loadEnvFiles() {
  const merged = {};
  for (const f of [".env", ".env.local"]) {
    if (!existsSync(f)) continue;
    for (const line of readFileSync(f, "utf8").split(/\r?\n/)) {
      const m = /^([A-Z_][A-Z0-9_]*)=(.*)$/.exec(line.trim());
      if (!m) continue;
      const val = m[2].trim().replace(/^["']|["']$/g, "");
      // Every distinct value seen is kept, so a prod ref hiding in either file
      // is still visible to the checks below.
      (merged[m[1]] ??= []).push(val);
    }
  }
  return merged;
}

const FILE_ENV = loadEnvFiles();

/** Process env wins; otherwise every value seen across the env files. */
function allValues(name) {
  if (process.env[name]) return [process.env[name]];
  return FILE_ENV[name] ?? [];
}

const RED = "\x1b[31m";
const YELLOW = "\x1b[33m";
const DIM = "\x1b[2m";
const OFF = "\x1b[0m";

/** Everything the guard needs to know about the current environment. */
function readEnvironment() {
  const dbUrls = allValues("DATABASE_URL");
  const directUrls = allValues("DIRECT_URL");
  const dbUrl = dbUrls[0] ?? "";
  const stripeKey = allValues("STRIPE_SECRET_KEY")[0] ?? "";

  // The ref appears in the pooler username (postgres.<ref>) and in direct
  // hostnames (db.<ref>.supabase.co). Check both connection strings: a guard
  // that only inspected DATABASE_URL would miss a DIRECT_URL still pointed at
  // production, which is the one migrations actually use.
  const touchesProd = [...dbUrls, ...directUrls].some((u) => u.includes(PROD_PROJECT_REF));

  const stripeMode = stripeKey.startsWith("sk_live_") || stripeKey.startsWith("rk_live_")
    ? "live"
    : stripeKey.startsWith("sk_test_") || stripeKey.startsWith("rk_test_")
      ? "test"
      : stripeKey === ""
        ? "absent"
        : "unrecognized";

  return { touchesProd, stripeMode, hasDb: dbUrl !== "" };
}

function fail(lines) {
  console.error(`\n${RED}  ENVIRONMENT GUARD — REFUSED${OFF}\n`);
  for (const l of lines) console.error(`  ${l}`);
  console.error("");
  process.exit(1);
}

const { touchesProd, stripeMode, hasDb } = readEnvironment();
const mode = process.argv[2] ?? "run";           // "run" | "migrate"
const override = process.env.ALLOW_PROD_DB === "i-understand";

if (!hasDb) {
  fail([
    "DATABASE_URL is not set.",
    "",
    `${DIM}Nothing to check, and nothing will work. Populate .env before running.${OFF}`,
  ]);
}

// --- E3: migrations never run against production from a local command --------
if (mode === "migrate" && touchesProd && !override) {
  fail([
    `A migration command is targeting the ${RED}PRODUCTION${OFF} database.`,
    "",
    `  project ref : ${PROD_PROJECT_REF}`,
    "",
    "Invariant E3: migration development happens against a non-production",
    "database. Production migrations are applied deliberately, from a reviewed",
    "migration file, never as a side effect of a local command.",
    "",
    `${DIM}This is the guard that exists because 0_init had to be reconstructed${OFF}`,
    `${DIM}from the physical catalog after eleven hand-applied files left no${OFF}`,
    `${DIM}replayable history.${OFF}`,
    "",
    `${DIM}If you genuinely mean it: ALLOW_PROD_DB=i-understand${OFF}`,
  ]);
}

// --- E2: Stripe mode and database must agree ---------------------------------
if (touchesProd && stripeMode === "test") {
  fail([
    `The ${RED}PRODUCTION${OFF} database is paired with a ${YELLOW}TEST${OFF} Stripe key.`,
    "",
    "Invariant E2: Stripe mode and database must agree.",
    "",
    "A test-mode payment against the production database writes real rows —",
    "real squares, a real EventSupporter — with no real money behind them.",
    "The database cannot tell the difference afterwards.",
  ]);
}

if (!touchesProd && stripeMode === "live") {
  fail([
    `A ${YELLOW}NON-PRODUCTION${OFF} database is paired with a ${RED}LIVE${OFF} Stripe key.`,
    "",
    "Invariant E2: Stripe mode and database must agree.",
    "",
    "This is the more dangerous direction. Real charges would land against a",
    "throwaway database, and the record of who paid what would be discarded",
    "with it.",
  ]);
}

if (stripeMode === "unrecognized") {
  fail([
    "STRIPE_SECRET_KEY is set but its prefix is not recognised.",
    "",
    `${DIM}Expected sk_test_, sk_live_, rk_test_ or rk_live_.${OFF}`,
    `${DIM}The guard will not assume a mode it cannot identify.${OFF}`,
  ]);
}

// --- E1: local development never points at production ------------------------
// A warning, not a refusal: reading production locally is legitimate for the
// read-only verification this project does often. Writing is what E1 forbids,
// and the guard cannot tell a SELECT from an UPDATE.
if (touchesProd && mode === "run") {
  console.error(
    `\n${YELLOW}  WARNING — local commands are pointed at PRODUCTION (${PROD_PROJECT_REF}).${OFF}`
  );
  console.error(`  ${DIM}E1: reads are fine. Any write is a production write.${OFF}\n`);
}

const target = touchesProd ? `production (${PROD_PROJECT_REF})` : "non-production";
console.error(`${DIM}  env guard ok — db: ${target}, stripe: ${stripeMode}${OFF}`);

// ============================================================================
// KNOWN BYPASSES — read before trusting this file
//
//   1. `npx prisma migrate dev` invoked directly never runs npm scripts, so it
//      never runs this guard. Only the wired npm scripts are protected.
//   2. Prisma reads .env itself. A command run with a different --schema or an
//      inline DATABASE_URL= prefix is checked against what THIS process sees,
//      which may not be what Prisma resolves.
//   3. The guard trusts the ref appearing in the connection string. A pooler
//      hostname that omits it would read as non-production.
//
// The environment split — a separate Supabase project with its own credentials
// — is the actual control. This file only makes the common mistake loud.
// ============================================================================
