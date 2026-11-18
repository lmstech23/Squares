-- Daali Slice 1 (Auth + Onboarding), S1.1 - organizer_profiles.
--
-- One profile per Supabase auth user. user_id is the auth user id held as TEXT
-- with no foreign key into auth.users, matching hosts.supabase_user_id and
-- public_themes.organizer_user_id (ruling 2026-10-08). Additive only: creates
-- one table and touches no existing table.
--
-- The DDL below is `prisma migrate diff` output against a database replayed
-- from the full migration chain, unedited. The CHECK Prisma cannot express is
-- added after it.

-- CreateTable
CREATE TABLE "organizer_profiles" (
    "user_id" TEXT NOT NULL,
    "display_name" TEXT,
    "avatar_url" TEXT,
    "legacy_boards_visible" BOOLEAN NOT NULL DEFAULT false,
    "created_via" TEXT NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "organizer_profiles_pkey" PRIMARY KEY ("user_id")
);

-- ---------------------------------------------------------------------------
-- Hand-added. Prisma cannot express a CHECK.
-- ---------------------------------------------------------------------------

-- How the row came to exist: a new organizer signing up, or the one-off
-- backfill of users who existed before Slice 1.
ALTER TABLE "organizer_profiles"
    ADD CONSTRAINT "organizer_profiles_created_via_check"
    CHECK ("created_via" IN ('SIGNUP', 'BACKFILL'));

-- ---------------------------------------------------------------------------
-- Containment. LAST, and in this same transaction. The form the Daali Event
-- port settled on (feat/daali-event-port, 6a04152).
--
-- TABLE-SCOPED, NOT SCHEMA-WIDE. Every statement names organizer_profiles.
-- There is no ON ALL TABLES / ON ALL SEQUENCES statement, so this migration
-- touches no other table, including its grants. The table owns no sequence.
-- ---------------------------------------------------------------------------

ALTER TABLE public."organizer_profiles" ENABLE ROW LEVEL SECURITY;

-- Zero client policies, deliberately. Nothing authenticates as anon or
-- authenticated against this table; every read is server-side through Prisma.
REVOKE ALL ON TABLE public."organizer_profiles" FROM PUBLIC, anon, authenticated;

GRANT ALL ON TABLE public."organizer_profiles" TO service_role;

-- FAIL CLOSED. Reads the catalog directly rather than
-- information_schema.role_table_grants, which lists only grants whose grantor or
-- grantee is a role the CURRENT user holds, and so can miss a grant made by some
-- other role. Any finding rolls the whole migration back:
--   1. RLS off;
--   2. anon or authenticated holds any table privilege, by any route
--      (direct grant, PUBLIC, or role membership) - has_table_privilege;
--   3. any ACL entry granted to PUBLIC (grantee 0) - aclexplode(relacl).
DO $$
DECLARE
  unprotected TEXT;
  exposed     TEXT;
  to_public   TEXT;
BEGIN
  SELECT string_agg(c.relname, ', ' ORDER BY c.relname) INTO unprotected
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
   WHERE n.nspname = 'public'
     AND c.relkind = 'r'
     AND c.relname = 'organizer_profiles'
     AND c.relrowsecurity IS NOT TRUE;
  IF unprotected IS NOT NULL THEN
    RAISE EXCEPTION 'organizer_profiles containment aborted: RLS disabled on %', unprotected;
  END IF;

  SELECT string_agg(format('%s/%s/%s', c.relname, r.role, p.priv), ', '
                    ORDER BY c.relname, r.role, p.priv) INTO exposed
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
   CROSS JOIN (VALUES ('anon'), ('authenticated')) AS r(role)
   CROSS JOIN (VALUES ('SELECT'), ('INSERT'), ('UPDATE'), ('DELETE'),
                      ('TRUNCATE'), ('REFERENCES'), ('TRIGGER')) AS p(priv)
   WHERE n.nspname = 'public'
     AND c.relkind = 'r'
     AND c.relname = 'organizer_profiles'
     AND has_table_privilege(r.role, c.oid, p.priv);
  IF exposed IS NOT NULL THEN
    RAISE EXCEPTION 'organizer_profiles containment aborted: client privileges on %', exposed;
  END IF;

  SELECT string_agg(DISTINCT c.relname, ', ') INTO to_public
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
   CROSS JOIN LATERAL aclexplode(c.relacl) AS a
   WHERE n.nspname = 'public'
     AND c.relkind = 'r'
     AND c.relname = 'organizer_profiles'
     AND a.grantee = 0;
  IF to_public IS NOT NULL THEN
    RAISE EXCEPTION 'organizer_profiles containment aborted: PUBLIC grant on %', to_public;
  END IF;
END $$;
