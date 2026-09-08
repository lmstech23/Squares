-- The second containment layer on the two reservation tables.
--
-- WHAT WENT WRONG. `20260907180000_entry_reservations` created
-- `entry_reservations` and `entry_reservation_lines` and never enabled RLS.
-- Every other table-creating migration since the August incident ends with the
-- containment block below — s1_signup_sheets does it for six tables,
-- a1_contribution_ledger for one. That migration simply did not.
--
-- WHY NOTHING CAUGHT IT FOR A DAY. RLS is invisible to `prisma/schema.prisma`:
-- `migrate diff` reports zero drift whether or not a table has it, `db pull`
-- never introspects it, and `migrate` never restores it. It is per-table — there
-- is no schema-wide ENABLE — so coverage drifts one table at a time and only a
-- catalog check finds it. `verify-containment.mts` did find it, on the run after
-- the next migration.
--
-- WHAT WAS AND WAS NOT EXPOSED. Both tables held ZERO privileges for `anon` and
-- `authenticated` throughout, and the live Data API probe returned HTTP 404 —
-- PostgREST cannot see a table it holds no grant on. The revoke half of the
-- pattern was in force; the RLS half was not. So what was missing is the layer
-- that would hold if a grant ever appeared, which is exactly what
-- `pg_default_acl` did to every table in `public` on 2026-08-30.
--
-- ZERO POLICIES, DELIBERATELY, matching both prior migrations. Nothing
-- authenticates as anon or authenticated against these tables; every read is
-- server-side through Prisma as `postgres`, which owns them and is not subject
-- to RLS. An RLS-enabled table with no policy denies every non-owner role, which
-- is the intended shape — a policy here would be a permission nobody needs.

ALTER TABLE public."entry_reservations"      ENABLE ROW LEVEL SECURITY;
ALTER TABLE public."entry_reservation_lines" ENABLE ROW LEVEL SECURITY;

-- The revoke/grant half, restated verbatim from s1_signup_sheets and
-- a1_contribution_ledger. Already true for these two, and re-running it is
-- idempotent; it is repeated so the containment block stays one recognisable
-- unit rather than a half a reader has to reconstruct.
REVOKE ALL ON ALL TABLES    IN SCHEMA public FROM PUBLIC, anon, authenticated;
REVOKE ALL ON ALL SEQUENCES IN SCHEMA public FROM PUBLIC, anon, authenticated;

GRANT ALL ON ALL TABLES    IN SCHEMA public TO service_role;
GRANT ALL ON ALL SEQUENCES IN SCHEMA public TO service_role;

-- ------------------------------------------------------------------ gate ---
-- READ THE CATALOG, not the statements above. `ALTER TABLE ... ENABLE ROW LEVEL
-- SECURITY` succeeds silently on a table that already had it and would succeed
-- just as silently if a future edit dropped one of the two names, so the
-- assertion asks pg_class what is actually true.
DO $$
DECLARE
  unprotected TEXT;
  leaked      TEXT;
BEGIN
  SELECT string_agg(c.relname, ', ' ORDER BY c.relname) INTO unprotected
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
   WHERE n.nspname = 'public'
     AND c.relname IN ('entry_reservations', 'entry_reservation_lines')
     AND c.relrowsecurity IS NOT TRUE;
  IF unprotected IS NOT NULL THEN
    RAISE EXCEPTION 'entry reservations RLS aborted: still disabled on %', unprotected;
  END IF;

  -- The other half of the pattern, asserted on the same two tables. Either one
  -- missing is the gap this migration exists to close.
  SELECT string_agg(DISTINCT format('%s/%s', table_name, grantee), ', ') INTO leaked
    FROM information_schema.role_table_grants
   WHERE table_schema = 'public'
     AND table_name IN ('entry_reservations', 'entry_reservation_lines')
     AND grantee IN ('anon', 'authenticated', 'PUBLIC');
  IF leaked IS NOT NULL THEN
    RAISE EXCEPTION 'entry reservations RLS aborted: client grants remain on %', leaked;
  END IF;
END $$;
