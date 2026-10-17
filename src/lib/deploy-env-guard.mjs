// Deploy-environment guard — preview-environment-isolation.md §2.
//
// A Vercel Preview (or Development) deployment must never reach production
// resources: the production Supabase project, or live-mode Stripe. This module
// decides whether the guard applies to the current environment and, when it
// does, refuses on any production resource it can see.
//
// PRODUCTION IS NEVER CHECKED. On VERCEL_ENV=production from `main` (or no
// Vercel at all, i.e. a local run) `checkDeployEnv` returns enforced:false and
// nothing else happens — the live site's build and start-up are unchanged.
//
// Plain JavaScript on purpose: the build-time check (scripts/check-deploy-env.mjs)
// runs under bare `node` before `next build`, and the run-time check
// (src/instrumentation.ts) imports the same file, so there is one rule, not two.
//
// Messages name the VARIABLE and the reason. They never include a value.

/** Supabase project ref of production. Same default as src/lib/db-target.ts. */
export const DEFAULT_PRODUCTION_DB_REF = "xfmonzvdlxbeskugrjmk";
export const PRODUCTION_DB_REF_VAR = "DAALI_PRODUCTION_DB_REF";

/** Every variable a database connection string may be read from. */
export const DATABASE_URL_VARS = ["DATABASE_URL", "DIRECT_URL", "POSTGRES_URL", "POSTGRES_PRISMA_URL", "POSTGRES_URL_NON_POOLING"];

/**
 * Supabase project ref inside a Postgres connection string, or null.
 * Same two shapes as deriveProjectRef in src/lib/db-target.ts (a test keeps them in step).
 * @param {string | undefined | null} url
 * @returns {string | null}
 */
export function projectRefFromDbUrl(url) {
  if (!url) return null;
  const pooler = url.match(/[/:]postgres\.([a-z0-9]{16,})[:@]/);
  if (pooler) return pooler[1];
  const direct = url.match(/@db\.([a-z0-9]{16,})\.supabase\.co/);
  if (direct) return direct[1];
  return null;
}

/**
 * Supabase project ref from an API URL such as https://<ref>.supabase.co, or null.
 * @param {string | undefined | null} url
 * @returns {string | null}
 */
export function projectRefFromSupabaseUrl(url) {
  if (!url) return null;
  try {
    const host = new URL(url).hostname;
    const m = host.match(/^([a-z0-9]{16,})\.supabase\.(co|in)$/);
    return m ? m[1] : null;
  } catch {
    return null;
  }
}

/**
 * Does the guard apply here?
 * @param {Record<string, string | undefined>} env
 * @returns {{ enforced: boolean, context: string }}
 */
export function guardContext(env) {
  const vercelEnv = (env.VERCEL_ENV ?? "").trim();
  // Production first, unconditionally: nothing in this guard can ever stop the live site.
  if (vercelEnv === "production") return { enforced: false, context: "production" };
  if (vercelEnv === "preview" || vercelEnv === "development") return { enforced: true, context: `VERCEL_ENV=${vercelEnv}` };
  const onVercel = env.VERCEL === "1";
  const ref = (env.VERCEL_GIT_COMMIT_REF ?? "").trim();
  // Belt and braces: VERCEL_ENV missing or hidden, but a Vercel build from a
  // branch other than main is not production.
  if (onVercel && ref && ref !== "main") return { enforced: true, context: `Vercel build of branch ${ref}` };
  return { enforced: false, context: onVercel ? "vercel (unclassified)" : "local" };
}

/**
 * @param {Record<string, string | undefined>} env
 * @returns {{ enforced: boolean, context: string, violations: string[] }}
 */
export function checkDeployEnv(env) {
  const { enforced, context } = guardContext(env);
  if (!enforced) return { enforced, context, violations: [] };

  const prodRef = (env[PRODUCTION_DB_REF_VAR] ?? "").trim() || DEFAULT_PRODUCTION_DB_REF;
  const violations = [];

  for (const name of DATABASE_URL_VARS) {
    if (projectRefFromDbUrl(env[name]) === prodRef) violations.push(`${name} points at the production database (${prodRef})`);
  }
  if (projectRefFromSupabaseUrl(env.NEXT_PUBLIC_SUPABASE_URL) === prodRef) {
    violations.push(`NEXT_PUBLIC_SUPABASE_URL points at the production Supabase project (${prodRef})`);
  }
  const stripeKey = (env.STRIPE_SECRET_KEY ?? "").trim();
  if (stripeKey.startsWith("sk_live_") || stripeKey.startsWith("rk_live_")) {
    violations.push("STRIPE_SECRET_KEY is a live-mode Stripe key");
  }
  return { enforced, context, violations };
}

export class ProductionResourceError extends Error {
  /** @param {string} context @param {string[]} violations */
  constructor(context, violations) {
    super(
      `Refusing to run: this is a non-production deployment (${context}) but it is configured with production resources:\n` +
        violations.map((v) => `  - ${v}`).join("\n") +
        "\nGive the Preview environment its own database and Stripe test keys " +
        "(preview-environment-isolation.md). Production is not affected by this check."
    );
    this.name = "ProductionResourceError";
    this.violations = violations;
  }
}

/**
 * Throws ProductionResourceError when enforced and any production resource is configured.
 * @param {Record<string, string | undefined>} env
 */
export function assertDeployEnv(env) {
  const r = checkDeployEnv(env);
  if (r.violations.length > 0) throw new ProductionResourceError(r.context, r.violations);
  return r;
}
