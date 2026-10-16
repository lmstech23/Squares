// Proves the daali_merch migration changes no permission on anything that is
// not a daali_merch object. Rehearsal-only: run against the DISPOSABLE database.
//
//   node --experimental-strip-types scripts/verify-merch-migration-scope.mts snapshot before.json <url>
//   (apply 20261017000000_daali_merch)
//   node --experimental-strip-types scripts/verify-merch-migration-scope.mts compare before.json <url>
//
// What is captured, for every object in `public` NOT named daali_merch_*:
//   - pg_class: relacl, relrowsecurity, relforcerowsecurity, relkind, owner
//   - pg_policy rows (name, command, roles, USING, WITH CHECK)
//   - information_schema.role_table_grants and role_column_grants
//   - information_schema.role_usage_grants (sequences, types)
//   - pg_type ACLs for non-merch types
//   - pg_default_acl (schema- and database-wide defaults)
// Any difference between before and after fails the run.
//
// Uses psql rather than Prisma so it runs with nothing but a connection string,
// and refuses any URL that is not localhost — it must never point at production.

import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";

const [mode, file, url] = process.argv.slice(2);
if (!mode || !file || !url || !["snapshot", "compare"].includes(mode)) {
  console.error("usage: verify-merch-migration-scope.mts snapshot|compare <file> <postgres-url>");
  process.exit(2);
}
const host = new URL(url).hostname;
if (host !== "localhost" && host !== "127.0.0.1") {
  console.error(`Refusing: ${host} is not localhost. This script is for the disposable database only.`);
  process.exit(2);
}

const NOT_MERCH = `NOT LIKE 'daali\\_merch\\_%'`;
const queries: Record<string, string> = {
  relations: `
    SELECT c.relname, c.relkind, pg_get_userbyid(c.relowner) AS owner,
           c.relacl::text AS acl, c.relrowsecurity AS rls, c.relforcerowsecurity AS force_rls
      FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname = 'public' AND c.relname NOT LIKE '%daali\\_merch\\_%'
       AND c.relkind IN ('r','p','v','m','S','f','i')
     ORDER BY c.relname`,
  policies: `
    SELECT tablename, policyname, cmd, roles::text, qual, with_check
      FROM pg_policies
     WHERE schemaname = 'public' AND tablename ${NOT_MERCH}
     ORDER BY tablename, policyname`,
  table_grants: `
    SELECT grantee, table_name, privilege_type, is_grantable
      FROM information_schema.role_table_grants
     WHERE table_schema = 'public' AND table_name ${NOT_MERCH}
     ORDER BY table_name, grantee, privilege_type`,
  column_grants: `
    SELECT grantee, table_name, column_name, privilege_type
      FROM information_schema.role_column_grants
     WHERE table_schema = 'public' AND table_name ${NOT_MERCH}
     ORDER BY table_name, column_name, grantee, privilege_type`,
  usage_grants: `
    SELECT grantee, object_name, object_type, privilege_type
      FROM information_schema.role_usage_grants
     WHERE object_schema = 'public' AND object_name ${NOT_MERCH}
     ORDER BY object_name, grantee, privilege_type`,
  type_acls: `
    SELECT t.typname, t.typacl::text AS acl
      FROM pg_type t JOIN pg_namespace n ON n.oid = t.typnamespace
     WHERE n.nspname = 'public' AND t.typname ${NOT_MERCH} AND t.typname NOT LIKE '\\_daali\\_merch\\_%'
     ORDER BY t.typname`,
  default_acls: `
    SELECT pg_get_userbyid(d.defaclrole) AS role, COALESCE(n.nspname, '*') AS schema,
           d.defaclobjtype AS objtype, d.defaclacl::text AS acl
      FROM pg_default_acl d LEFT JOIN pg_namespace n ON n.oid = d.defaclnamespace
     ORDER BY 1, 2, 3`,
};

function run(sql: string): unknown[] {
  const wrapped = `SELECT COALESCE(json_agg(row_to_json(q)), '[]'::json) FROM (${sql}) q`;
  const out = execFileSync("psql", [url, "-tA", "-v", "ON_ERROR_STOP=1", "-c", wrapped], { encoding: "utf8" });
  return JSON.parse(out.trim());
}

const snapshot: Record<string, unknown[]> = {};
for (const [name, sql] of Object.entries(queries)) snapshot[name] = run(sql);

if (mode === "snapshot") {
  writeFileSync(file, JSON.stringify(snapshot, null, 1));
  const counts = Object.entries(snapshot).map(([k, v]) => `${k}=${v.length}`).join(" ");
  console.log(`snapshot written: ${counts}`);
  process.exit(0);
}

const before = JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown[]>;
let failures = 0;
for (const name of Object.keys(queries)) {
  const a = (before[name] ?? []).map((r) => JSON.stringify(r));
  const b = snapshot[name].map((r) => JSON.stringify(r));
  const removed = a.filter((x) => !b.includes(x));
  const added = b.filter((x) => !a.includes(x));
  if (removed.length || added.length) {
    failures++;
    console.log(`DIFF ${name}:`);
    removed.forEach((x) => console.log(`  - ${x}`));
    added.forEach((x) => console.log(`  + ${x}`));
  } else {
    console.log(`same ${name} (${b.length} rows)`);
  }
}
if (failures) {
  console.log(`\nFAIL: permissions on non-merch objects changed in ${failures} categor${failures === 1 ? "y" : "ies"}.`);
  process.exit(1);
}
console.log("\nPASS: no permission, policy, RLS flag or default ACL on any non-merch object changed.");
