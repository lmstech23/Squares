// WHICH DATABASE AM I ABOUT TO TOUCH?
//
// On 2026-09-06 a set of migration gates was reported PASS against a database
// that was not production. `.env.local` names `NEXT_PUBLIC_URL=beta.daali.app`
// and points its `DATABASE_URL` at a different Supabase project, so everything
// about the run looked right: it connected, every gate returned zero, and the
// counts were plausible. Nothing in the process could tell the difference,
// because nothing in the process ever asked which database it was.
//
// This module is the thing that asks. It derives the Supabase PROJECT REF from
// a connection string and compares it to an expected value. It is pure and
// synchronous so it can run BEFORE any client is constructed — a check that
// runs after the connection is open has already lost the argument.
//
// A PROJECT REF IS NOT A CREDENTIAL. It ships in the client bundle of every
// deployed page, which is how production's ref was established in the first
// place. Nothing here reads, stores, logs or returns a password, and the
// functions below never echo the connection string they were handed.
//
// FAIL CLOSED, ALWAYS. A ref that cannot be derived is a REFUSAL, not a pass.
// The alternative — treating "I could not tell" as "it is fine" — is precisely
// the failure this exists to prevent.

/**
 * The configuration key that names the expected production project.
 *
 * A FUTURE PROJECT MOVE MUST BE A DELIBERATE ACT, not a source edit made under
 * pressure at 2am. Setting this variable is a decision someone takes
 * consciously, in the environment they are operating; editing the default
 * below is a code change that goes through review. The default is what makes
 * the guard work with no setup at all, so nobody is tempted to skip it.
 */
export const PRODUCTION_DB_REF_VAR = "DAALI_PRODUCTION_DB_REF";

/**
 * Established 2026-09-06 from the live bundle at beta.daali.app, which carries
 * the production `NEXT_PUBLIC_SUPABASE_URL` baked in at build time, and
 * corroborated by Vercel holding a single shared database record across
 * Production, Preview and Development.
 */
export const DEFAULT_PRODUCTION_DB_REF = "xfmonzvdlxbeskugrjmk";

/**
 * The Supabase project ref inside a Postgres connection string, or null.
 *
 * Two shapes, because Supabase exposes two and this project uses both:
 *
 *   pooler   postgresql://postgres.<ref>:…@aws-0-<region>.pooler.supabase.com
 *   direct   postgresql://postgres:…@db.<ref>.supabase.co
 *
 * Anything else — localhost, a Docker container, a non-Supabase host — returns
 * null, which callers treat as a refusal rather than as "not production".
 */
export function deriveProjectRef(url: string | undefined | null): string | null {
  if (!url) return null;
  const pooler = url.match(/[/:]postgres\.([a-z0-9]{16,})[:@]/);
  if (pooler) return pooler[1];
  const direct = url.match(/@db\.([a-z0-9]{16,})\.supabase\.co/);
  if (direct) return direct[1];
  return null;
}

/** What the caller was configured to expect. */
export function expectedProductionRef(
  env: Record<string, string | undefined> = process.env
): string {
  return env[PRODUCTION_DB_REF_VAR]?.trim() || DEFAULT_PRODUCTION_DB_REF;
}

export class WrongDatabaseError extends Error {
  reason: "missing" | "underivable" | "mismatch";

  constructor(reason: "missing" | "underivable" | "mismatch", message: string) {
    super(message);
    this.name = "WrongDatabaseError";
    this.reason = reason;
  }
}

/**
 * Refuse unless `url` points at the expected production project.
 *
 * Throws — never returns a boolean. A caller that forgets to check a returned
 * value would connect anyway, and the whole point is that forgetting must not
 * be possible.
 *
 * The message names both refs. Both are public identifiers, and a mismatch you
 * cannot identify is a mismatch you cannot act on. The connection string is
 * never included.
 */
export function assertProductionTarget(
  url: string | undefined | null,
  env: Record<string, string | undefined> = process.env
): { ref: string } {
  const expected = expectedProductionRef(env);

  if (!url) {
    throw new WrongDatabaseError(
      "missing",
      "No connection string was supplied. Refusing to run against an " +
        "unspecified database."
    );
  }

  const ref = deriveProjectRef(url);
  if (!ref) {
    throw new WrongDatabaseError(
      "underivable",
      "Could not derive a Supabase project ref from the target connection " +
        `string, so it cannot be shown to be production (${expected}). ` +
        "Refusing. This is what a local, containerised or non-Supabase host " +
        "looks like, and it is also what a malformed production string looks " +
        "like — the two are indistinguishable from here, which is why this is " +
        "a refusal and not a warning."
    );
  }

  if (ref !== expected) {
    throw new WrongDatabaseError(
      "mismatch",
      `Target project is ${ref}; expected production is ${expected}. ` +
        "Refusing. If production has genuinely moved, set " +
        `${PRODUCTION_DB_REF_VAR} to the new ref for this invocation rather ` +
        "than editing the default in source."
    );
  }

  return { ref };
}
