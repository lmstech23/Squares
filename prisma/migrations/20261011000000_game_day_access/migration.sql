-- Daali Slice 1 (Auth + Onboarding), S1.7 - Game Day access (L2).
--
-- Auth spec, "Game Day access (amended Oct 11)": "The flag rename and this
-- table are one migration."
--
--   1. organizer_profiles.legacy_boards_visible is renamed legacy_boards_enabled.
--      It is now the Game Day entitlement, not just navigation visibility.
--   2. daali_game_day_links holds single-use Game Day access links.
--
-- Additive apart from the rename. It touches no other table, and no data
-- moves: RENAME COLUMN keeps every value, default and grant.

-- ---------------------------------------------------------------------------
-- 1. The rename. HAND-WRITTEN: `prisma migrate diff` proposes DROP COLUMN plus
--    ADD COLUMN for a renamed field, which would reset every flag to false.
-- ---------------------------------------------------------------------------
ALTER TABLE "organizer_profiles" RENAME COLUMN "legacy_boards_visible" TO "legacy_boards_enabled";

-- ---------------------------------------------------------------------------
-- 2. The table and its index: `prisma migrate diff` output, unedited.
-- ---------------------------------------------------------------------------

-- CreateTable
CREATE TABLE "daali_game_day_links" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "token_hash" TEXT NOT NULL,
    "created_by_user_id" TEXT NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expires_at" TIMESTAMPTZ(6) NOT NULL,
    "used_by_user_id" TEXT,
    "used_at" TIMESTAMPTZ(6),
    "revoked_at" TIMESTAMPTZ(6),

    CONSTRAINT "daali_game_day_links_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "daali_game_day_links_token_hash_key" ON "daali_game_day_links"("token_hash");

-- ---------------------------------------------------------------------------
-- Hand-added. Prisma cannot express a CHECK.
-- ---------------------------------------------------------------------------

-- A redemption records who and when together; never one without the other.
ALTER TABLE "daali_game_day_links"
    ADD CONSTRAINT "daali_game_day_links_used_pair_check"
    CHECK (("used_at" IS NULL) = ("used_by_user_id" IS NULL));

-- Redeem and revoke are mutually exclusive (Auth spec, "whichever lands first
-- wins"). The application enforces it with conditional updates; this makes a
-- link that is both used and revoked impossible to store, whatever the code.
ALTER TABLE "daali_game_day_links"
    ADD CONSTRAINT "daali_game_day_links_used_or_revoked_check"
    CHECK ("used_at" IS NULL OR "revoked_at" IS NULL);

-- ---------------------------------------------------------------------------
-- Containment. LAST, and in this same transaction. The form the Daali Event
-- port settled on (feat/daali-event-port, 6a04152), as for organizer_profiles.
--
-- TABLE-SCOPED, NOT SCHEMA-WIDE. Every statement names daali_game_day_links.
-- There is no ON ALL TABLES / ON ALL SEQUENCES statement, so this migration
-- touches no other table, including its grants. The table owns no sequence.
-- organizer_profiles keeps its own containment through the rename.
-- ---------------------------------------------------------------------------

ALTER TABLE public."daali_game_day_links" ENABLE ROW LEVEL SECURITY;

-- Zero client policies, deliberately. Every read and write is server-side
-- through Prisma; nothing authenticates as anon or authenticated against it.
REVOKE ALL ON TABLE public."daali_game_day_links" FROM PUBLIC, anon, authenticated;

GRANT ALL ON TABLE public."daali_game_day_links" TO service_role;

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
     AND c.relname = 'daali_game_day_links'
     AND c.relrowsecurity IS NOT TRUE;
  IF unprotected IS NOT NULL THEN
    RAISE EXCEPTION 'daali_game_day_links containment aborted: RLS disabled on %', unprotected;
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
     AND c.relname = 'daali_game_day_links'
     AND has_table_privilege(r.role, c.oid, p.priv);
  IF exposed IS NOT NULL THEN
    RAISE EXCEPTION 'daali_game_day_links containment aborted: client privileges on %', exposed;
  END IF;

  SELECT string_agg(DISTINCT c.relname, ', ') INTO to_public
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
   CROSS JOIN LATERAL aclexplode(c.relacl) AS a
   WHERE n.nspname = 'public'
     AND c.relkind = 'r'
     AND c.relname = 'daali_game_day_links'
     AND a.grantee = 0;
  IF to_public IS NOT NULL THEN
    RAISE EXCEPTION 'daali_game_day_links containment aborted: PUBLIC grant on %', to_public;
  END IF;
END $$;
