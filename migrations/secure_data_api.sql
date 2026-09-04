-- secure_data_api.sql
--
-- Closes anonymous PostgREST access to every table in the public schema.
--
-- WHY THIS FILE EXISTS OUTSIDE PRISMA
-- Row-level security and role grants are INVISIBLE to prisma/schema.prisma.
-- `prisma migrate diff` will never report them, `prisma db pull` will never
-- introspect them, and a future `prisma migrate` will never restore them.
-- Nothing here can be inferred from the schema file, and nothing here will show
-- up as drift if it is ever undone. It is enforced by the verification script,
-- not by Prisma.
--
-- DISCOVERED 2026-08-30. Applied by hand, per the migrations/ convention.
--
-- WHAT WAS WRONG
-- All 15 tables in `public` granted anon and authenticated full
-- SELECT/INSERT/UPDATE/DELETE. Seven had RLS off, so those grants were live
-- over the Data API: boards (17 rows), squares (1300 rows, carrying
-- player_name / player_email / player_phone), hosts (5), payment_references
-- (16), credit_transactions (16), invite_codes (10), hbcu_orgs (2).
-- The other eight had RLS on with zero policies, so they denied by default --
-- but carried identical grants underneath, one RLS toggle from exposure.
--
-- ROOT CAUSE, AND WHY IT WOULD RECUR
-- pg_default_acl grants arwdDxtm on every FUTURE table in `public` to anon and
-- authenticated, for both `postgres` and `supabase_admin`. No statement in any
-- prior migration granted anything -- the grants were automatic at CREATE
-- TABLE, and the pgrst_ddl_watch event trigger published them to the Data API
-- immediately. Without section 3 below, the six S1 sign-up tables would arrive
-- exposed on the day they are created.
--
-- WHY REVOKING IS SAFE
-- A read-only trace of every Supabase client in the app found the anon key is
-- used for auth.* only: getUser x10, verifyOtp x4, signInWithOtp x2, signOut,
-- exchangeCodeForSession. Zero .from() and zero .rpc() outside one route.
-- The only PostgREST data path in the codebase is
-- src/app/api/hbcu/onboard/route.ts, which uses SUPABASE_SERVICE_ROLE_KEY.
-- service_role is untouched here. Public boards, checkout, the host dashboard
-- and the check-in gate are Next.js server code reading Postgres through
-- Prisma over the pooler, which connects as `postgres` and is unaffected by
-- role grants on anon.
--
-- NO ROLLBACK SCRIPT IS PROVIDED, DELIBERATELY.
-- The pre-change ACLs are recorded below as evidence, not as a restore path.
-- Re-granting anonymous full DML on 1300 contributor rows is never the correct
-- response to an unexpected break. If something breaks, diagnose it and add
-- the minimum policy or single grant that fixes it.
--
-- PRE-CHANGE STATE, captured 2026-08-30 (evidence):
--   All 15 relations, identical ACL:
--     postgres=arwdDxtm/postgres | anon=arwdDxtm/postgres
--     | authenticated=arwdDxtm/postgres | service_role=arwdDxtm/postgres
--   RLS off  (7): boards, credit_transactions, hbcu_orgs, hosts,
--                 invite_codes, payment_references, squares
--   RLS on   (8): admission_grants, admission_passes,
--                 attendance_access_tokens, check_in_logs, event_supporters,
--                 events, free_entries, volunteer_access
--   Policies on any of the 15: 0
--   Views, matviews, sequences, functions in public: 0
--   pg_default_acl on public, TABLES:
--     postgres       -> anon=arwdDxtm | authenticated=arwdDxtm
--                       | service_role=arwdDxtm
--     supabase_admin -> anon=arwdDxtm | authenticated=arwdDxtm
--                       | service_role=arwdDxtm
--
-- The supabase_admin half of that last entry is NOT corrected here. It needs
-- membership in supabase_admin, which `postgres` does not have
-- (pg_has_role = false). It is split into
-- migrations/secure_data_api_supabase_admin_defaults.sql so an ownership
-- failure there cannot leave this file half applied.

BEGIN;

-- ---------------------------------------------------------------------------
-- 1. Row-level security on every table in public.
--    With zero policies this denies anon and authenticated outright, while
--    leaving service_role (BYPASSRLS) and the pooler's `postgres` unaffected.
--    Issued for all 15, not just the 7: ENABLE on an already-enabled table is
--    a no-op, and this makes the file idempotent and the verification uniform.
-- ---------------------------------------------------------------------------
ALTER TABLE public.boards                   ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.credit_transactions      ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.hbcu_orgs                ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.hosts                    ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.invite_codes             ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.payment_references       ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.squares                  ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.admission_grants         ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.admission_passes         ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.attendance_access_tokens ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.check_in_logs            ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.event_supporters         ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.events                   ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.free_entries             ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.volunteer_access         ENABLE ROW LEVEL SECURITY;

-- ---------------------------------------------------------------------------
-- 2. Remove the grants underneath, so RLS is not the only barrier.
--    ON ALL TABLES covers views and materialized views too; there are none
--    today, so this is exact-scope now and correct if one is added later.
--    There are no sequences in public today either -- the sequence revoke is
--    future-proofing, not a fix for anything currently present.
--    service_role and postgres are deliberately not named.
-- ---------------------------------------------------------------------------
REVOKE ALL ON ALL TABLES    IN SCHEMA public FROM PUBLIC, anon, authenticated;
REVOKE ALL ON ALL SEQUENCES IN SCHEMA public FROM PUBLIC, anon, authenticated;

-- ---------------------------------------------------------------------------
-- 3. Stop it recurring for anything `postgres` creates from here on.
--    This is the half that matters for S1: the six sign-up tables will be
--    created by postgres, so postgres's default ACL is what governs them.
--
--    DUPLICATED, DELIBERATELY. The same four statements appear in
--    prisma/migrations/0_init/migration.sql section 2, positioned before any
--    CREATE TABLE. This file remediates a database whose tables already exist;
--    0_init prevents the exposure on a database built from nothing. Neither
--    replaces the other.
--
--    KEEP THE TWO COPIES IN SYNC. A change to the default-privilege policy in
--    either file must be made in both, or a replayed database and a remediated
--    one end up with different postures - and only the replayed one is ever
--    tested from scratch.
--
--    THE POINTER LIVES ONLY HERE, NOT IN 0_init. 0_init is an APPLIED migration:
--    Prisma records its checksum in _prisma_migrations and refuses to proceed if
--    the file changes. Adding even a comment to it changed the checksum from
--    ffc4fc57... to ee243ec3... and would have made the next `prisma migrate
--    deploy` against production fail on a modified-migration error. Reverted
--    2026-09-04. Never edit an applied migration, comments included.
-- ---------------------------------------------------------------------------
ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public
  REVOKE ALL ON TABLES FROM anon, authenticated;

ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public
  REVOKE ALL ON SEQUENCES FROM anon, authenticated;

-- Functions: Postgres grants EXECUTE to PUBLIC on every new function through a
-- global default that is NOT scoped to a schema. A revoke written
-- `IN SCHEMA public` cannot cancel it -- the unqualified form is required.
ALTER DEFAULT PRIVILEGES FOR ROLE postgres
  REVOKE EXECUTE ON FUNCTIONS FROM PUBLIC;

-- Belt and braces for future functions reached by role rather than by PUBLIC.
-- There are zero functions in public today, so this changes nothing now.
ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public
  REVOKE EXECUTE ON FUNCTIONS FROM anon, authenticated;

COMMIT;

-- ---------------------------------------------------------------------------
-- NOT DONE HERE, deliberately:
--   * USAGE on schema public is left in place for anon and authenticated.
--     Without table privileges it grants nothing readable, and removing it
--     would complicate any future policy-based public read path.
--   * No policies are created. Nothing legitimate authenticates as anon or
--     authenticated against these tables today; a policy would invent a
--     permission the application never asks for.
--   * service_role is untouched. api/hbcu/onboard/route.ts depends on it.
--   * The anon key is NOT rotated. It is public by design; this was an
--     authorization defect, not a key disclosure.
--   * There were zero functions in public to strip explicit grants from.
-- ---------------------------------------------------------------------------
