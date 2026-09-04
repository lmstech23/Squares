#!/usr/bin/env node
import { readFileSync, existsSync } from "node:fs";

// scripts/guard-env.mjs
// ============================================================================
// ENVIRONMENT GUARD — enforces invariants E1, E2 and E3 mechanically.
//
// FAILS CLOSED. An earlier version recognised only the production ref and
// treated everything else as non-production, so an unknown Supabase project —
// someone else's production, a mistyped ref, any host at all — passed as safe
// and a migration was permitted. That is the wrong default for a safety check.
// A database now has to be RECOGNISED to be allowed, not merely unrecognised to
// be tolerated.
//
// A BACKSTOP, NOT THE ENVIRONMENT SPLIT. A direct `npx prisma migrate dev`
// bypasses npm scripts and never runs this file — see "Known bypasses".
//
// The production ref is hardcoded on purpose. It is a NON-SECRET identifier: it
// ships to every browser inside NEXT_PUBLIC_SUPABASE_URL. Hardcoding means the
// guard cannot be defeated by editing an env var, which is the mistake it
// exists to catch.
// ============================================================================

const PROD_PROJECT_REF = "xfmonzvdlxbeskugrjmk";

// EMPTY ON PURPOSE. A project earns entry here only after a suitability check
// establishes it holds no real data. `Squares-staging` (udbhwoktsvaixpxfepae)
// is deliberately NOT listed: it is an existing project of unknown contents,
// and adding it before that check would be assuming the answer.
const DEV_PROJECT_REFS = new Set([
  // "somedevref00000000ab",   // <- add only with a recorded suitability check
]);

// Local Postgres is a legitimate dev target, but it is allowed as a NAMED case,
// never as a fallthrough. Anything not on this list is not local.
const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "::1", "[::1]"]);

/** Supabase project refs are exactly 20 lowercase alphanumerics. */
const REF_SHAPE = /^[a-z0-9]{20}$/;

const RED = "\x1b[31m";
const YELLOW = "\x1b[33m";
const DIM = "\x1b[2m";
const OFF = "\x1b[0m";

// --- env loading -------------------------------------------------------------
// npm does NOT load .env — Prisma and Next each load their own. A guard relying
// on process.env alone would run blind and pass everything.
function loadEnvFiles() {
  const merged = {};
  for (const f of [".env", ".env.local"]) {
    if (!existsSync(f)) continue;
    for (const line of readFileSync(f, "utf8").split(/\r?\n/)) {
      const m = /^([A-Z_][A-Z0-9_]*)=(.*)$/.exec(line.trim());
      if (!m) continue;
      (merged[m[1]] ??= []).push(m[2].trim().replace(/^["']|["']$/g, ""));
    }
  }
  return merged;
}
const FILE_ENV = loadEnvFiles();
const value = (name) => process.env[name] ?? FILE_ENV[name]?.[0] ?? "";

// --- classification ----------------------------------------------------------
/**
 * Resolve one connection string to a classified target.
 *
 * EXACT EQUALITY ONLY. No substring matching anywhere in the safety decision:
 * `includes()` made a trailing-garbage ref like <prodref>TYPO read as
 * production while a genuinely different project read as safe — wrong in both
 * directions at once.
 *
 * Returns { kind, target, detail }. `target` is a canonical identity used to
 * confirm DATABASE_URL and DIRECT_URL point at the SAME database.
 */
function classify(raw) {
  if (!raw) return { kind: "EMPTY", target: null, detail: "not set" };

  let url;
  try {
    url = new URL(raw);
  } catch {
    return { kind: "UNPARSEABLE", target: null, detail: "not a valid URL" };
  }
  if (!/^postgres(ql)?:$/.test(url.protocol)) {
    return { kind: "UNPARSEABLE", target: null, detail: `protocol ${url.protocol}` };
  }

  const host = url.hostname.toLowerCase();

  // Local Postgres — a named case, never a fallthrough.
  if (LOCAL_HOSTS.has(host)) {
    const port = url.port || "5432";
    const db = url.pathname.replace(/^\//, "") || "postgres";
    return { kind: "LOCAL", target: `local:${host}:${port}/${db}`, detail: `${host}:${port}/${db}` };
  }

  // Supabase refs appear either as the pooler username (postgres.<ref>) or as
  // the direct hostname (db.<ref>.supabase.co). Extract, then shape-check.
  let ref = null;
  const user = decodeURIComponent(url.username || "");
  const fromUser = /^postgres\.(.+)$/.exec(user);
  if (fromUser) ref = fromUser[1];
  const fromHost = /^db\.(.+)\.supabase\.(co|com|net)$/.exec(host);
  if (ref === null && fromHost) ref = fromHost[1];

  if (ref === null) {
    return { kind: "UNRECOGNISED_HOST", target: null, detail: host };
  }
  if (!REF_SHAPE.test(ref)) {
    // Trailing garbage, wrong length, uppercase — malformed, so refused. Never
    // "close enough".
    return { kind: "MALFORMED_REF", target: null, detail: ref };
  }
  if (ref === PROD_PROJECT_REF) {
    return { kind: "PRODUCTION", target: `supabase:${ref}`, detail: ref };
  }
  if (DEV_PROJECT_REFS.has(ref)) {
    return { kind: "DEV", target: `supabase:${ref}`, detail: ref };
  }
  return { kind: "UNKNOWN_SUPABASE", target: `supabase:${ref}`, detail: ref };
}

function fail(lines) {
  console.error(`\n${RED}  ENVIRONMENT GUARD — REFUSED${OFF}\n`);
  for (const l of lines) console.error(`  ${l}`);
  console.error("");
  process.exit(1);
}

// --- the decision ------------------------------------------------------------
const mode = process.argv[2] ?? "run"; // "run" | "migrate"
const override = process.env.ALLOW_PROD_DB === "i-understand";

const db = classify(value("DATABASE_URL"));
const direct = classify(value("DIRECT_URL"));
const pair = [["DATABASE_URL", db], ["DIRECT_URL", direct]];

const REFUSALS = {
  EMPTY: "is not set",
  UNPARSEABLE: "is not a usable Postgres URL",
  UNRECOGNISED_HOST: "points at a host this guard does not recognise",
  MALFORMED_REF: "carries a project ref that is not 20 lowercase alphanumerics",
  UNKNOWN_SUPABASE: "points at a Supabase project that is not on the dev allowlist",
};

// 1. Production, named first so its message is the specific one.
for (const [name, c] of pair) {
  if (c.kind !== "PRODUCTION") continue;
  if (mode === "migrate" && !override) {
    fail([
      `${name} targets the ${RED}PRODUCTION${OFF} database.`,
      "",
      `  project ref : ${PROD_PROJECT_REF}`,
      "",
      "Invariant E3: migration development happens against a non-production",
      "database. Production migrations are applied deliberately, from a",
      "reviewed file, never as a side effect of a local command.",
      "",
      `${DIM}This guard exists because 0_init had to be reconstructed from the${OFF}`,
      `${DIM}physical catalog after eleven hand-applied files left no replayable${OFF}`,
      `${DIM}history.${OFF}`,
      "",
      `${DIM}If you genuinely mean it: ALLOW_PROD_DB=i-understand${OFF}`,
    ]);
  }
}

// 2. Everything unrecognised refuses. This is the fail-closed default.
for (const [name, c] of pair) {
  if (!(c.kind in REFUSALS)) continue;
  fail([
    `${name} ${REFUSALS[c.kind]}.`,
    "",
    `  saw : ${c.detail}`,
    "",
    "The guard fails CLOSED. A database must be RECOGNISED to be allowed —",
    "production, an allowlisted dev project, or a named local host. Anything",
    "else is refused, including a project that may well be fine.",
    "",
    `${DIM}To allow a Supabase project, add its ref to DEV_PROJECT_REFS in${OFF}`,
    `${DIM}scripts/guard-env.mjs — and only after a suitability check has${OFF}`,
    `${DIM}established it holds no real data.${OFF}`,
  ]);
}

// 3. Both must point at the SAME database. Developing against one while
//    migrating another is how a schema and its data quietly diverge.
if (db.target !== direct.target) {
  fail([
    "DATABASE_URL and DIRECT_URL resolve to DIFFERENT databases.",
    "",
    `  DATABASE_URL : ${db.detail}`,
    `  DIRECT_URL   : ${direct.detail}`,
    "",
    "Prisma migrations use DIRECT_URL; the application uses DATABASE_URL.",
    "Split across two databases, migrations land somewhere the app never",
    "reads, and the app runs against a schema no migration produced.",
  ]);
}

// 4. E2 — Stripe mode and database must agree.
const stripeKey = value("STRIPE_SECRET_KEY");
const stripeMode = /^(sk|rk)_live_/.test(stripeKey)
  ? "live"
  : /^(sk|rk)_test_/.test(stripeKey)
    ? "test"
    : stripeKey === ""
      ? "absent"
      : "unrecognized";

const isProd = db.kind === "PRODUCTION";

if (stripeMode === "unrecognized") {
  fail([
    "STRIPE_SECRET_KEY is set but its prefix is not recognised.",
    "",
    `${DIM}Expected sk_test_, sk_live_, rk_test_ or rk_live_.${OFF}`,
    `${DIM}The guard will not assume a mode it cannot identify.${OFF}`,
  ]);
}
if (isProd && stripeMode === "test") {
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
if (!isProd && stripeMode === "live") {
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

// 5. E1 — a warning, not a refusal. Reading production locally is legitimate
//    and this project does it often; the guard cannot tell a SELECT from an
//    UPDATE. Migrations are already blocked above.
if (isProd && mode === "run") {
  console.error(`\n${YELLOW}  WARNING — local commands are pointed at PRODUCTION (${PROD_PROJECT_REF}).${OFF}`);
  console.error(`  ${DIM}E1: reads are fine. Any write is a production write.${OFF}\n`);
}

console.error(`${DIM}  env guard ok — db: ${db.kind.toLowerCase()} (${db.detail}), stripe: ${stripeMode}${OFF}`);

// ============================================================================
// KNOWN BYPASSES — read before trusting this file
//
//   1. `npx prisma migrate dev` invoked directly never runs npm scripts, so it
//      never runs this guard. Only the wired npm scripts are protected.
//   2. Prisma resolves its own env. A command with a different --schema or an
//      inline DATABASE_URL= prefix is checked against what THIS process sees.
//   3. The guard reads the FIRST value found for each variable. A second
//      definition later in the same file is not what it judged.
//
// The environment split — a separate Supabase project with its own credentials
// — is the actual control. This file only makes the common mistake loud.
// ============================================================================
