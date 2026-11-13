// Deploy-environment guard — preview-environment-isolation.md §5.
// Fixture credentials are fake; the point of several tests is that no value,
// fake or real, ever appears in a message.

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { join } from "node:path";
import {
  assertDeployEnv,
  checkDeployEnv,
  guardContext,
  projectRefFromDbUrl,
  projectRefFromSupabaseUrl,
  ProductionResourceError,
  DATABASE_URL_VARS,
  DEFAULT_PRODUCTION_DB_REF,
} from "./deploy-env-guard.mjs";
import { deriveProjectRef, DEFAULT_PRODUCTION_DB_REF as DB_TARGET_REF } from "./db-target.ts";

const PROD = "xfmonzvdlxbeskugrjmk";
const DEV = "iujjlgfrwavfhqatpqdy";
const SECRET = "Sup3rSecretPassw0rd";
const pooler = (ref: string) => `postgresql://postgres.${ref}:${SECRET}@aws-0-us-east-1.pooler.supabase.com:6543/postgres`;
const direct = (ref: string) => `postgresql://postgres:${SECRET}@db.${ref}.supabase.co:5432/postgres`;
const LIVE = "sk_live_51FAKEFAKEFAKEFAKEFAKE";
const RK_LIVE = "rk_live_51FAKEFAKEFAKEFAKEFAKE";
const TEST = "sk_test_51FAKEFAKEFAKEFAKEFAKE";

/** Production exactly as the live site is configured on record. */
const productionEnv = {
  VERCEL: "1", VERCEL_ENV: "production", VERCEL_GIT_COMMIT_REF: "main",
  DATABASE_URL: pooler(PROD), DIRECT_URL: direct(PROD),
  NEXT_PUBLIC_SUPABASE_URL: `https://${PROD}.supabase.co`, STRIPE_SECRET_KEY: LIVE,
};
/** An isolated Preview: daali-dev and Stripe test mode. */
const isolatedPreview = {
  VERCEL: "1", VERCEL_ENV: "preview", VERCEL_GIT_COMMIT_REF: "merch-standalone",
  DATABASE_URL: pooler(DEV), DIRECT_URL: direct(DEV),
  NEXT_PUBLIC_SUPABASE_URL: `https://${DEV}.supabase.co`, STRIPE_SECRET_KEY: TEST,
};

describe("production and local are never checked", () => {
  test("production with the production DB and live Stripe: not enforced, no violations, no throw", () => {
    const r = checkDeployEnv(productionEnv);
    assert.deepEqual(r, { enforced: false, context: "production", violations: [] });
    assert.doesNotThrow(() => assertDeployEnv(productionEnv));
  });
  test("production is exempt even from a non-main ref (nothing here can stop the live site)", () => {
    assert.equal(guardContext({ ...productionEnv, VERCEL_GIT_COMMIT_REF: "hotfix" }).enforced, false);
  });
  test("local (no VERCEL) is not enforced", () => {
    assert.equal(guardContext({ DATABASE_URL: pooler(PROD), STRIPE_SECRET_KEY: LIVE }).enforced, false);
  });
  test("a Vercel build of main without VERCEL_ENV is not enforced", () => {
    assert.equal(guardContext({ VERCEL: "1", VERCEL_GIT_COMMIT_REF: "main" }).enforced, false);
  });
});

describe("a Preview configured like production is refused", () => {
  test("every database variable, pooler and direct shapes", () => {
    for (const name of DATABASE_URL_VARS) {
      for (const url of [pooler(PROD), direct(PROD)]) {
        const r = checkDeployEnv({ ...isolatedPreview, [name]: url });
        assert.equal(r.enforced, true);
        assert.ok(r.violations.some((v) => v.startsWith(`${name} points at the production database`)), `${name}`);
      }
    }
  });
  test("production Supabase API URL", () => {
    const r = checkDeployEnv({ ...isolatedPreview, NEXT_PUBLIC_SUPABASE_URL: `https://${PROD}.supabase.co` });
    assert.deepEqual(r.violations, [`NEXT_PUBLIC_SUPABASE_URL points at the production Supabase project (${PROD})`]);
  });
  test("live Stripe secret and restricted keys", () => {
    for (const key of [LIVE, RK_LIVE, `  ${LIVE}  `]) {
      assert.deepEqual(checkDeployEnv({ ...isolatedPreview, STRIPE_SECRET_KEY: key }).violations, ["STRIPE_SECRET_KEY is a live-mode Stripe key"]);
    }
  });
  test("the Preview as recorded today (everything shared with production) fails on all three counts", () => {
    const shared = { ...productionEnv, VERCEL_ENV: "preview", VERCEL_GIT_COMMIT_REF: "merch-standalone" };
    assert.throws(() => assertDeployEnv(shared), (e: unknown) => e instanceof ProductionResourceError && e.violations.length === 4);
  });
  test("development scope is enforced too", () => {
    assert.equal(guardContext({ VERCEL_ENV: "development" }).enforced, true);
  });
  test("VERCEL_ENV hidden but a non-main branch on Vercel → still enforced", () => {
    const r = checkDeployEnv({ VERCEL: "1", VERCEL_GIT_COMMIT_REF: "feat/x", DATABASE_URL: pooler(PROD) });
    assert.equal(r.enforced, true);
    assert.equal(r.violations.length, 1);
  });
  test("DAALI_PRODUCTION_DB_REF overrides the default production ref", () => {
    const moved = "abcdefghijklmnopqrst";
    const r = checkDeployEnv({ ...isolatedPreview, DAALI_PRODUCTION_DB_REF: moved, DATABASE_URL: pooler(moved) });
    assert.equal(r.violations.length, 1);
  });
});

describe("an isolated Preview passes", () => {
  test("daali-dev + Stripe test mode: enforced, no violations", () => {
    assert.deepEqual(checkDeployEnv(isolatedPreview), { enforced: true, context: "VERCEL_ENV=preview", violations: [] });
  });
  test("a non-Supabase preview database is allowed", () => {
    assert.deepEqual(checkDeployEnv({ ...isolatedPreview, DATABASE_URL: `postgresql://u:${SECRET}@ep-cool-name.us-east-2.aws.neon.tech/db` }).violations, []);
  });
});

describe("no secret value ever appears in a message", () => {
  test("passwords, keys and full URLs are absent", () => {
    const shared = { ...productionEnv, VERCEL_ENV: "preview", POSTGRES_URL: pooler(PROD) };
    let msg = "";
    try { assertDeployEnv(shared); } catch (e) { msg = (e as Error).message; }
    assert.ok(msg.length > 0);
    for (const s of [SECRET, LIVE, "pooler.supabase.com", "postgresql://"]) assert.ok(!msg.includes(s), s);
  });
});

describe("parsing stays in step with src/lib/db-target.ts", () => {
  test("same production ref and same parse results", () => {
    assert.equal(DEFAULT_PRODUCTION_DB_REF, DB_TARGET_REF);
    for (const u of [pooler(PROD), direct(PROD), pooler(DEV), direct(DEV), "postgresql://postgres:daali@localhost:55432/daali_test", "", "not a url"]) {
      assert.equal(projectRefFromDbUrl(u), deriveProjectRef(u), u);
    }
  });
  test("Supabase API URL parsing", () => {
    assert.equal(projectRefFromSupabaseUrl(`https://${PROD}.supabase.co`), PROD);
    assert.equal(projectRefFromSupabaseUrl("https://example.com"), null);
    assert.equal(projectRefFromSupabaseUrl("garbage"), null);
  });
});

describe("build-time script and Ignored Build Step", () => {
  const root = join(import.meta.dirname, "..", "..");
  const run = (file: string, env: Record<string, string>, cmd = process.execPath) =>
    spawnSync(cmd, [join(root, file)], { env: { PATH: process.env.PATH ?? "", ...env } as unknown as NodeJS.ProcessEnv, encoding: "utf8" });

  test("check-deploy-env.mjs: production exits 0; misconfigured Preview exits 1 without printing values; isolated Preview exits 0", () => {
    const prod = run("scripts/check-deploy-env.mjs", productionEnv);
    assert.equal(prod.status, 0);
    assert.match(prod.stdout, /production — not enforced/);
    const bad = run("scripts/check-deploy-env.mjs", { ...productionEnv, VERCEL_ENV: "preview" });
    assert.equal(bad.status, 1);
    assert.ok(!bad.stderr.includes(SECRET) && !bad.stderr.includes(LIVE));
    assert.equal(run("scripts/check-deploy-env.mjs", isolatedPreview).status, 0);
  });

  test("vercel-ignore-build.sh: production builds (1); Preview skips (0) unless DAALI_PREVIEW_ISOLATED=true (1)", () => {
    const sh = (env: Record<string, string>) => spawnSync("sh", [join(root, "scripts/vercel-ignore-build.sh")], { env: env as unknown as NodeJS.ProcessEnv, encoding: "utf8" }).status;
    assert.equal(sh({ VERCEL_ENV: "production" }), 1);
    assert.equal(sh({ VERCEL_ENV: "production", DAALI_PREVIEW_ISOLATED: "false" }), 1);
    assert.equal(sh({ VERCEL_ENV: "preview" }), 0);
    assert.equal(sh({ VERCEL_ENV: "preview", DAALI_PREVIEW_ISOLATED: "yes" }), 0);
    assert.equal(sh({ VERCEL_ENV: "preview", DAALI_PREVIEW_ISOLATED: "true" }), 1);
    assert.equal(sh({}), 0);
  });

  test("package.json build runs the guard before next build; vercel.json uses the ignore script", () => {
    const pkg = JSON.parse(execFileSync("cat", [join(root, "package.json")], { encoding: "utf8" }));
    assert.equal(pkg.scripts.build, "node scripts/check-deploy-env.mjs && next build");
    const vj = JSON.parse(execFileSync("cat", [join(root, "vercel.json")], { encoding: "utf8" }));
    assert.equal(vj.ignoreCommand, "sh scripts/vercel-ignore-build.sh");
    assert.equal(vj.crons.length, 5); // 4 Board crons unchanged + merch-reconcile
  });
});
