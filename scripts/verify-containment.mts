// scripts/verify-containment.mts
//
// Standing check that the Supabase Data API stays closed.
//
//   node --experimental-strip-types scripts/verify-containment.mts
//
// Run it after ANY migration that creates something in the `public` schema.
// RLS and role grants are invisible to prisma/schema.prisma — `migrate diff`
// reports zero drift whether or not this containment is intact. This script is
// the only thing that observes it.
//
// CATALOG-DRIVEN BY DESIGN. Nothing here enumerates a fixed list of tables.
// The exposure it guards against arrived through AUTOMATIC default privileges
// at CREATE TABLE, so the check has to be automatic too: a table added by S1,
// or by anyone, is tested the moment it exists, with nobody remembering to add
// it here.
//
// FAILS CLOSED. Any of these is a failure, not a warning:
//   * a public base table without RLS
//   * any PUBLIC / anon / authenticated privilege on any public relation
//   * a view or matview reachable by those roles
//   * a public function executable by those roles or by PUBLIC
//   * unsafe default privileges for objects `postgres` creates
//   * service_role missing access the application needs
//   * a catalog column missing from a result, or an HTTP probe that never
//     completed — absence of evidence is not evidence
//   * a relation kind this script does not know how to reason about
//
// READ ONLY. No writes. Every HTTP call is GET or HEAD. Never prints a key, a
// URL containing a key, a token, a row, a name, or an email.

import { PrismaClient } from "@prisma/client";
import { readFileSync } from "node:fs";

// ---------------------------------------------------------------------------
// Deliberate exceptions.
//
// A table that is genuinely meant to be client-readable goes here, with the
// reason and the review that approved it. It is NOT a silent pass: an entry
// still has to have RLS enabled AND at least one policy, and the policies are
// printed on every run so they stay visible. An empty object is the correct
// state today — no table in `public` is client-accessible.
// ---------------------------------------------------------------------------
const CLIENT_ACCESSIBLE: Record<string, string> = {
  // "example_table": "why, and the decision that approved it",
};

// Functions in `public` that are deliberately callable by anon/authenticated.
// Empty today: `public` contains no functions at all.
const CALLABLE_FUNCTIONS: Record<string, string> = {};

const PRIVS = ["SELECT", "INSERT", "UPDATE", "DELETE", "TRUNCATE", "REFERENCES", "TRIGGER"] as const;
const BASE_KINDS = new Set(["r", "p"]);          // ordinary + partitioned tables
const VIEW_KINDS = new Set(["v", "m"]);          // views + materialized views
const KNOWN_KINDS = new Set([...BASE_KINDS, ...VIEW_KINDS]);

// --- .env, parsed without echoing values -----------------------------------
const env = new Map<string, string>();
for (const line of readFileSync(".env", "utf8").split(/\r?\n/)) {
  const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*)$/.exec(line);
  if (m) env.set(m[1], m[2].trim().replace(/^["']|["']$/g, ""));
}
const SUPABASE_URL = env.get("NEXT_PUBLIC_SUPABASE_URL") ?? "";
const ANON = env.get("NEXT_PUBLIC_SUPABASE_ANON_KEY") ?? "";
const SERVICE = env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
// NEXT_PUBLIC_URL is a local dev value in this project. VERIFY_SITE_URL wins,
// so the page checks can be aimed at the deployed app. Without it the site
// conclusion is UNVERIFIED — never a pass.
const SITE_FROM_ENV = Boolean(process.env.VERIFY_SITE_URL);
const SITE = (process.env.VERIFY_SITE_URL ?? env.get("NEXT_PUBLIC_URL") ?? "").replace(/\/$/, "");
const SITE_IS_LOCAL = SITE
  ? ["localhost", "127.0.0.1", "::1"].includes(new URL(SITE).hostname)
  : true;

// --catalog-only is OPT-IN and must never weaken the default. Normal mode runs
// catalog + HTTP probes + page checks. --catalog-only runs the catalog checks
// and prints the others as SKIPPED, so a replayed container can be validated
// without HTTP sections silently reporting on PRODUCTION instead. Container
// catalog + production HTTP is the false-pass shape this guards against.
const CATALOG_ONLY = process.argv.includes("--catalog-only");

// Resolved target, printed prominently in BOTH modes. Credentials are never
// shown — host, port and database name only.
function describeTarget(): string {
  const raw = process.env.DATABASE_URL ?? env.get("DATABASE_URL") ?? "";
  try {
    const u = new URL(raw);
    return `${u.hostname}:${u.port || "5432"}${u.pathname}`;
  } catch { return "<unparseable DATABASE_URL>"; }
}

const p = new PrismaClient();
// Two INDEPENDENT conclusions. Database containment and the deployed site are
// different questions with different evidence, and a pass on one must never
// be allowed to read as a pass on the other.
const tally = {
  containment: { failures: 0, inconclusives: 0 },
  site: { failures: 0, inconclusives: 0 },
};
let scope: "containment" | "site" = "containment";
const notes: string[] = [];

const H = (s: string) => console.log(`\n${"=".repeat(78)}\n${s}\n${"=".repeat(78)}`);
const ok = (label: string, detail = "") => console.log(`  [ ok ] ${label.padEnd(56)} ${detail}`);
const fail = (label: string, detail = "") => { tally[scope].failures++; console.log(`  [FAIL] ${label.padEnd(56)} ${detail}`); };
const check = (cond: boolean, label: string, detail = "") => (cond ? ok(label, detail) : fail(label, detail));
const unknown = (label: string, detail = "") => { tally[scope].inconclusives++; console.log(`  [ ?? ] ${label.padEnd(56)} INCONCLUSIVE: ${detail}`); };
const note = (s: string) => { notes.push(s); console.log(`  ...  ${s}`); };

// Requires every named column to be present and boolean. A renamed or dropped
// catalog column must fail, never read as `undefined` and score as safe.
function requireBooleans(row: Record<string, unknown> | undefined, keys: string[], label: string): boolean {
  if (!row) { fail(label, "no row returned from catalog query"); return false; }
  const missing = keys.filter((k) => typeof row[k] !== "boolean");
  if (missing.length) { fail(label, `catalog columns missing/non-boolean: ${missing.slice(0, 6).join(", ")}`); return false; }
  return true;
}

// Transient edge failures are common; retry before declaring nothing known.
async function probe(url: string, headers: Record<string, string>, attempts = 3) {
  let last = "";
  for (let i = 1; i <= attempts; i++) {
    try { return { res: await fetch(url, { method: "HEAD", headers }), error: null as string | null }; }
    catch (e) { last = (e as Error).message.slice(0, 60); if (i < attempts) await new Promise((r) => setTimeout(r, 400 * i)); }
  }
  return { res: null, error: `${last} (after ${attempts} attempts)` };
}

console.log("=".repeat(78));
console.log(`  MODE:            ${CATALOG_ONLY ? "--catalog-only (HTTP + page checks SKIPPED)" : "full (catalog + HTTP + page checks)"}`);
console.log(`  DATABASE TARGET: ${describeTarget()}`);
console.log(`  SITE TARGET:     ${CATALOG_ONLY ? "n/a - skipped" : (SITE || "<unset>")}`);
console.log(`  SUPABASE HTTP:   ${CATALOG_ONLY ? "n/a - skipped" : (SUPABASE_URL ? new URL(SUPABASE_URL).hostname : "<unset>")}`);
console.log("=".repeat(78));

// ------------------------------------------------------- 0. discovery ---
H("0. DISCOVERY — every relation in `public`, from the catalog");
type Rel = { name: string; kind: string; rls: boolean; owner: string; acl: string; policies: number };
const rels = await p.$queryRawUnsafe<Rel[]>(`
  SELECT c.relname AS name,
         c.relkind::text AS kind,
         c.relrowsecurity AS rls,
         pg_get_userbyid(c.relowner) AS owner,
         coalesce(array_to_string(c.relacl,' | '),'') AS acl,
         (SELECT count(*) FROM pg_policies pp
           WHERE pp.schemaname='public' AND pp.tablename=c.relname)::int AS policies
  FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
  WHERE n.nspname='public' AND c.relkind NOT IN ('i','I','S','t','c')
  ORDER BY c.relkind, c.relname`);

if (rels.length === 0) fail("discovery returned no relations", "expected at least one table in public");
else ok(`discovered ${rels.length} relation(s) in public`, "no names are hardcoded in this script");

const baseTables = rels.filter((r) => BASE_KINDS.has(r.kind));
const views = rels.filter((r) => VIEW_KINDS.has(r.kind));
const strange = rels.filter((r) => !KNOWN_KINDS.has(r.kind));
for (const s of strange)
  fail(`unknown relation kind: ${s.name}`, `relkind='${s.kind}' — this script cannot reason about it`);
note(`${baseTables.length} base table(s), ${views.length} view(s)/matview(s)`);
for (const r of rels) console.log(`       ${r.name.padEnd(30)} kind=${r.kind} rls=${String(r.rls).padEnd(5)} owner=${r.owner} policies=${r.policies}`);

// ------------------------------------------------------------ 1. RLS ---
H("1. ROW LEVEL SECURITY ON EVERY PUBLIC BASE TABLE");
for (const t of baseTables) check(t.rls === true, `  ${t.name}`, t.rls ? "enabled" : "RLS DISABLED");

// --------------------------------------------------------- 2. relacl ---
H("2. NO PUBLIC / anon / authenticated PRIVILEGE IN relacl (tables AND views)");
const grantsRole = (acl: string) => /(^|\|\s*)(anon|authenticated)=/.test(acl);
const grantsPublic = (acl: string) => /(^|\|\s*)=[a-zA-Z]/.test(acl);
for (const r of rels) {
  const bad = grantsRole(r.acl) || grantsPublic(r.acl);
  check(!bad, `  ${r.name} (kind ${r.kind})`,
    bad ? `${grantsRole(r.acl) ? "anon/authenticated " : ""}${grantsPublic(r.acl) ? "PUBLIC " : ""}grant present`
        : (r.acl === "" ? "no acl — owner only" : "clean"));
}

// ------------------------------------ 3. effective privilege, 7 verbs ---
H("3. EFFECTIVE PRIVILEGE — anon AND authenticated, all seven, every relation");
console.log(`   order: ${PRIVS.join(" ")}`);
// Aliases must be distinct per role: deriving them from role[0] collided
// ('anon' and 'authenticated' both start with 'a'), Postgres accepted the
// duplicate output names, and the authenticated columns were silently lost.
const PREFIX: Record<string, string> = { anon: "anon_", authenticated: "auth_" };
for (const r of rels) {
  const sel = (["anon", "authenticated"] as const)
    .flatMap((role) => PRIVS.map((pv, i) => `has_table_privilege('${role}','public."${r.name}"','${pv}') AS ${PREFIX[role]}${i}`))
    .join(", ");
  let row: Record<string, unknown> | undefined;
  try { row = (await p.$queryRawUnsafe<Record<string, unknown>[]>(`SELECT ${sel}`))[0]; }
  catch (e) { fail(`  ${r.name}`, `privilege query failed: ${(e as Error).message.replace(/\s+/g, " ").slice(0, 90)}`); continue; }
  const keys = (["anon", "authenticated"] as const).flatMap((role) => PRIVS.map((_, i) => `${PREFIX[role]}${i}`));
  if (!requireBooleans(row, keys, `  ${r.name}`)) continue;
  const a = PRIVS.map((_, i) => (row![`anon_${i}`] ? "Y" : "-")).join("");
  const u = PRIVS.map((_, i) => (row![`auth_${i}`] ? "Y" : "-")).join("");
  const any = keys.some((k) => row![k]);
  const exception = Object.hasOwn(CLIENT_ACCESSIBLE, r.name);
  if (any && exception) {
    const pol = rels.find((x) => x.name === r.name)!.policies;
    check(r.rls && pol > 0, `  ${r.name} REVIEWED EXCEPTION`,
      `anon ${a} authenticated ${u} | rls=${r.rls} policies=${pol} | ${CLIENT_ACCESSIBLE[r.name]}`);
    if (r.rls && pol > 0) {
      const ps = await p.$queryRawUnsafe<{ policyname: string; cmd: string; roles: string }[]>(
        `SELECT policyname, cmd, roles::text FROM pg_policies WHERE schemaname='public' AND tablename=$1`, r.name);
      for (const x of ps) console.log(`         policy ${x.policyname} cmd=${x.cmd} roles=${x.roles}`);
    }
  } else {
    check(!any, `  ${r.name}`, `anon ${a}  authenticated ${u}`);
  }
}
for (const name of Object.keys(CLIENT_ACCESSIBLE))
  if (!rels.some((r) => r.name === name))
    fail(`  stale exception: ${name}`, "listed in CLIENT_ACCESSIBLE but no such relation — remove it");

// ------------------------------------------- 4. service_role retained ---
H("4. service_role RETAINS THE ACCESS THE APPLICATION NEEDS");
for (const r of rels) {
  const needed = BASE_KINDS.has(r.kind) ? PRIVS : (["SELECT"] as readonly string[]);
  const sel = needed.map((pv, i) => `has_table_privilege('service_role','public."${r.name}"','${pv}') AS s${i}`).join(", ");
  let row: Record<string, unknown> | undefined;
  try { row = (await p.$queryRawUnsafe<Record<string, unknown>[]>(`SELECT ${sel}`))[0]; }
  catch (e) { fail(`  ${r.name}`, `privilege query failed: ${(e as Error).message.replace(/\s+/g, " ").slice(0, 90)}`); continue; }
  const keys = needed.map((_, i) => `s${i}`);
  if (!requireBooleans(row, keys, `  ${r.name}`)) continue;
  check(keys.every((k) => row![k]), `  ${r.name}`,
    `${needed.map((_, i) => (row![`s${i}`] ? "Y" : "-")).join("")}  (needs ${needed.join("/")})`);
}

// ------------------------------------------------------- 5. functions ---
H("5. NO PUBLIC FUNCTION EXECUTABLE BY PUBLIC / anon / authenticated");
const fns = await p.$queryRawUnsafe<Record<string, unknown>[]>(`
  SELECT pr.proname AS fn,
         pg_get_function_identity_arguments(pr.oid) AS args,
         pr.prosecdef AS secdef,
         pg_get_userbyid(pr.proowner) AS owner,
         has_function_privilege('anon', pr.oid, 'EXECUTE')          AS anon_exec,
         has_function_privilege('authenticated', pr.oid, 'EXECUTE') AS auth_exec,
         coalesce(array_to_string(pr.proacl,' | '),'') AS acl
  FROM pg_proc pr JOIN pg_namespace n ON n.oid = pr.pronamespace
  WHERE n.nspname='public' ORDER BY pr.proname`);
if (!fns.length) ok("no functions in public", "nothing to expose");
for (const f of fns) {
  const name = String(f.fn);
  if (!requireBooleans(f, ["anon_exec", "auth_exec", "secdef"], `  ${name}`)) continue;
  const reachable = Boolean(f.anon_exec) || Boolean(f.auth_exec) || grantsPublic(String(f.acl));
  const allowed = Object.hasOwn(CALLABLE_FUNCTIONS, name);
  const detail = `anonExec=${f.anon_exec} authExec=${f.auth_exec} secdef=${f.secdef} owner=${f.owner}`;
  if (reachable && allowed) ok(`  ${name} REVIEWED EXCEPTION`, `${detail} | ${CALLABLE_FUNCTIONS[name]}`);
  else check(!reachable, `  ${name}(${f.args})`, detail);
  if (reachable && Boolean(f.secdef)) fail(`  ${name} is SECURITY DEFINER and reachable`, "runs as its owner");
}

// ------------------------------------------- 6. default privileges ---
H("6. SAFE DEFAULTS FOR OBJECTS `postgres` CREATES");
const dacl = await p.$queryRawUnsafe<Record<string, string>[]>(`
  SELECT pg_get_userbyid(d.defaclrole) AS creating_role,
         coalesce(n.nspname,'<global>') AS schema,
         CASE d.defaclobjtype WHEN 'r' THEN 'table' WHEN 'S' THEN 'sequence'
              WHEN 'f' THEN 'function' WHEN 'T' THEN 'type' END AS objtype,
         coalesce(array_to_string(d.defaclacl,' | '),'') AS acl
  FROM pg_default_acl d LEFT JOIN pg_namespace n ON n.oid = d.defaclnamespace
  ORDER BY 1,2,3`);
for (const d of dacl) console.log(`       ${d.creating_role.padEnd(20)} ${d.schema.padEnd(14)} ${d.objtype.padEnd(9)} ${d.acl}`);

const pgPublic = dacl.filter((d) => d.creating_role === "postgres" && d.schema === "public");
const pgPublicBad = pgPublic.filter((d) => grantsRole(d.acl));
check(pgPublicBad.length === 0, "postgres defaults in public free of anon/authenticated",
  pgPublicBad.length ? pgPublicBad.map((b) => b.objtype).join(", ") : `${pgPublic.length} entr(ies), all clean`);

// A missing global function entry means Postgres's built-in PUBLIC EXECUTE
// default applies, so absence here is unsafe and must fail.
const pgGlobalFn = dacl.find((d) => d.creating_role === "postgres" && d.schema === "<global>" && d.objtype === "function");
check(Boolean(pgGlobalFn) && !grantsPublic(pgGlobalFn!.acl) && !grantsRole(pgGlobalFn!.acl),
  "postgres global function default revokes PUBLIC EXECUTE",
  pgGlobalFn ? pgGlobalFn.acl : "ENTRY ABSENT — built-in PUBLIC EXECUTE default applies");

// supabase_admin: documented residual, reported not asserted. Correcting it
// needs membership postgres does not hold. See PHASE-2-BACKLOG.md.
const saPublicBad = dacl.filter((d) => d.creating_role === "supabase_admin" && d.schema === "public" && grantsRole(d.acl));
if (saPublicBad.length)
  note(`RESIDUAL (not a failure): supabase_admin defaults in public still grant anon/authenticated ` +
       `[${saPublicBad.map((b) => b.objtype).join(", ")}] — needs role membership postgres lacks. PHASE-2-BACKLOG.md.`);
const outside = dacl.filter((d) => d.schema !== "public" && d.schema !== "<global>" && grantsRole(d.acl));
if (outside.length)
  note(`INFORMATIONAL: ${outside.length} default ACL(s) grant anon/authenticated outside public ` +
       `(${[...new Set(outside.map((o) => o.schema))].join(", ")}) — Supabase-managed schemas with their own policy model.`);

// ------------------------------------------ 7. live anonymous probes ---
H("7. LIVE ANONYMOUS Data API PROBES (HEAD, metadata only — no row contents)");
if (CATALOG_ONLY) {
  console.log("  [SKIP] anonymous Data API probes - --catalog-only");
  console.log("         RLS (section 1) and catalog privilege (section 3) are the");
  console.log("         authoritative evidence. This section observes a live PostgREST");
  console.log("         endpoint that a replayed container does not have - running it");
  console.log("         here would report on production instead.");
}
else if (!SUPABASE_URL || !ANON) fail("anonymous probes", "NEXT_PUBLIC_SUPABASE_URL / ANON_KEY missing from .env");
else for (const r of rels) {
  const { res, error } = await probe(`${SUPABASE_URL}/rest/v1/${r.name}?select=*&limit=1`,
    { apikey: ANON, Authorization: `Bearer ${ANON}`, Prefer: "count=exact" });
  if (!res) { unknown(`  anon ${r.name}`, `probe never completed: ${error}`); continue; }
  const cr = res.headers.get("content-range") ?? "-";
  // PostgREST answers a counted range with 206, not 200 — asserting `!== 200`
  // would score a table returning rows as blocked. Blocked means refused.
  const blocked = res.status >= 400;
  if (!blocked && Object.hasOwn(CLIENT_ACCESSIBLE, r.name))
    ok(`  anon ${r.name} REVIEWED EXCEPTION`, `HTTP ${res.status} content-range=${cr}`);
  else check(blocked, `  anon ${r.name}`, `HTTP ${res.status}  content-range=${cr}`);
}

// -------------------------------------------- 8. application still up ---
H("8. APPLICATION PATHS STILL WORK (read-only)");
try {
  const who = await p.$queryRawUnsafe<{ cu: string; su: string }[]>(`SELECT current_user AS cu, session_user AS su`);
  // The safety of postgres's default privileges only protects future tables if
  // migrations actually run as postgres. Asserted, not assumed.
  check(who[0]?.cu === "postgres", "migration connection is postgres", `current_user=${who[0]?.cu} session_user=${who[0]?.su}`);
  const counts = {
    boards: await p.board.count(), squares: await p.square.count(), hosts: await p.host.count(),
    events: await p.event.count(), admissionPasses: await p.admissionPass.count(),
    checkinStaffAccess: await p.checkinStaffAccess.count(),
  };
  ok("Prisma reads across 6 models", JSON.stringify(counts));
  // The assertion is that a relational read EXECUTES, not that rows exist. A
  // freshly replayed database legitimately has zero boards, and an empty
  // product state is not a containment failure. A throw is caught below.
  const open = await p.board.findMany({ where: { status: "open" }, select: { slug: true }, take: 1 });
  ok("Prisma relational read executes", `${open.length} open board(s) — row count is informational`);
  if (open.length === 0) note("no open boards: page checks below have no board to exercise");

  // Everything below is the SITE conclusion, tallied separately from
  // containment. Name the host always: NEXT_PUBLIC_URL is a local dev value
  // here (http://localhost:3000), and a bare "page renders — HTTP 200" once
  // reported the dev server as if it were the deployed app.
  scope = "site";
  if (CATALOG_ONLY) console.log("  [SKIP] public page checks - --catalog-only");
  else if (!SITE) fail("public pages", "no site URL — set VERIFY_SITE_URL or NEXT_PUBLIC_URL");
  else {
    const host = new URL(SITE).hostname;
    const where = SITE_IS_LOCAL ? "LOCAL DEV SERVER — not production" : "remote";
    if (SITE_IS_LOCAL)
      note(`page checks hit ${host} (${where}). They exercise the same Prisma code ` +
           `against the production database, but say NOTHING about the deployed app. ` +
           `Set VERIFY_SITE_URL to the production domain to check that.`);
    for (const [label, path, follow] of [["home", "/", true], ["board", open[0] ? `/board/${open[0].slug}` : "", false]] as const) {
      if (!path) { fail(`  ${label} page`, "no open board to test"); continue; }
      try {
        const res = await fetch(`${SITE}${path}`, { redirect: follow ? "follow" : "manual" });
        check(res.status === 200, `  ${label} page @ ${host}`, `HTTP ${res.status}  ${path}  [${where}]`);
      } catch (e) { unknown(`  ${label} page @ ${host}`, (e as Error).message.slice(0, 70)); }
    }
  }
  scope = "containment";
} catch (e) {
  fail("pooler / Prisma reads", (e as Error).message.replace(/\s+/g, " ").slice(0, 140));
}

if (CATALOG_ONLY) {
  console.log("  [SKIP] service_role HTTP reachability - --catalog-only");
} else if (SUPABASE_URL && SERVICE) {
  const { res, error } = await probe(`${SUPABASE_URL}/rest/v1/hbcu_orgs?select=*&limit=1`,
    { apikey: SERVICE, Authorization: `Bearer ${SERVICE}`, Prefer: "count=exact" });
  if (!res) unknown("service_role reaches hbcu_orgs", `probe never completed: ${error}`);
  else check(res.status === 200 || res.status === 206, "service_role reaches hbcu_orgs (api/hbcu/onboard)",
    `HTTP ${res.status}  count=${(res.headers.get("content-range") ?? "").split("/")[1] ?? "?"}`);
}

// ------------------------------------------------------------ verdict ---
H("VERDICT");
for (const n of notes) console.log(`  note: ${n}`);

// --- conclusion 1: the database -------------------------------------------
const c = tally.containment;
const containmentVerdict =
  c.failures > 0 ? "FAIL" : c.inconclusives > 0 ? "UNPROVEN" : "PASS";
console.log(`\n  DATABASE CONTAINMENT: ${containmentVerdict}`);
console.log(`      ${rels.length} relation(s) checked, ${c.failures} failure(s), ${c.inconclusives} inconclusive`);
if (containmentVerdict === "PASS") console.log(`      The Data API is closed to anon and authenticated.`);
if (containmentVerdict === "UNPROVEN") console.log(`      A probe never completed. Re-run; do NOT treat this as contained.`);
if (containmentVerdict === "FAIL") console.log(`      See failures above.`);

// --- conclusion 2: the deployed site --------------------------------------
// Independent of containment. Without VERIFY_SITE_URL pointing at a remote
// host this can never be a pass, however healthy the database looks — a green
// database says nothing about whether the deployed app still serves.
const s = tally.site;
const siteTested = SITE_FROM_ENV && !SITE_IS_LOCAL;
const siteVerdict = CATALOG_ONLY ? "SKIPPED (--catalog-only)" : !siteTested
  ? "LOCAL ONLY / PRODUCTION UNVERIFIED"
  : s.failures > 0 ? "FAIL" : s.inconclusives > 0 ? "UNPROVEN" : "PASS";
console.log(`\n  PRODUCTION SITE SMOKE (${siteTested ? SITE : "not set"}): ${siteVerdict}`);
if (!siteTested && !CATALOG_ONLY)
  console.log(`      VERIFY_SITE_URL is ${SITE_FROM_ENV ? "a loopback address" : "unset"}, so nothing here\n` +
              `      observed the deployed application. Re-run with\n` +
              `      VERIFY_SITE_URL=https://<production-domain> to reach a verdict.`);
else console.log(`      ${s.failures} failure(s), ${s.inconclusives} inconclusive`);

console.log(`\n  Not covered by either conclusion: the authenticated host dashboard behind`);
console.log(`  a real login. This script holds no credentials and will not mint a session.`);
console.log(`  The 'authenticated' role is verified from the catalog (section 3); a live`);
console.log(`  probe as that role would need the project JWT secret.`);

// 0 = both conclusions pass. 2 = database contained, production unverified.
// 1 = something actually failed or could not be established.
await p.$disconnect();
if (containmentVerdict !== "PASS") process.exit(1);
if (CATALOG_ONLY) process.exit(0);   // catalog passed; site deliberately not assessed
if (siteVerdict === "PASS") process.exit(0);
if (siteVerdict === "LOCAL ONLY / PRODUCTION UNVERIFIED") process.exit(2);
process.exit(1);
