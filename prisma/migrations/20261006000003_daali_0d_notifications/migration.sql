-- Daali Event port, Phase 0D.0 - Notification delivery (minimal).
--
-- Ported from the recovered Phase 0 package (archive/phase0-historical,
-- phase0/daali-0d/prisma/migrations/0004_notifications) under the Daali persistence
-- namespace (Port Plan, Naming map). Additive only: creates daali_* objects
-- and touches no legacy table.
--
-- The DDL below is `prisma migrate diff` output against a database replayed
-- from the full migration chain, unedited. Objects Prisma cannot express are
-- hand-ported after it, from the archived SQL with Daali names.

-- CreateEnum
CREATE TYPE "daali_notification_type" AS ENUM ('RSVP_CONFIRMED');

-- CreateEnum
CREATE TYPE "daali_notification_status" AS ENUM ('pending', 'sent', 'failed');

-- CreateTable
CREATE TABLE "daali_notification_deliveries" (
    "id" TEXT NOT NULL,
    "notificationType" "daali_notification_type" NOT NULL,
    "dedupeKey" TEXT NOT NULL,
    "eventPersonId" TEXT NOT NULL,
    "registrationId" TEXT,
    "status" "daali_notification_status" NOT NULL DEFAULT 'pending',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "providerMessageId" TEXT,
    "lastError" TEXT,
    "sentAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "daali_notification_deliveries_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "daali_notification_deliveries_eventPersonId_idx" ON "daali_notification_deliveries"("eventPersonId");

-- CreateIndex
CREATE INDEX "daali_notification_deliveries_status_idx" ON "daali_notification_deliveries"("status");

-- CreateIndex
CREATE UNIQUE INDEX "daali_notification_deliveries_type_dedupeKey_key" ON "daali_notification_deliveries"("notificationType", "dedupeKey");

-- AddForeignKey
ALTER TABLE "daali_notification_deliveries" ADD CONSTRAINT "daali_notification_deliveries_eventPersonId_fkey" FOREIGN KEY ("eventPersonId") REFERENCES "daali_event_people"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "daali_notification_deliveries" ADD CONSTRAINT "daali_notification_deliveries_registrationId_fkey" FOREIGN KEY ("registrationId") REFERENCES "daali_registrations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- ---------------------------------------------------------------------------
-- Containment. LAST, and in this same transaction (Port Plan R1).
--
-- TABLE-SCOPED, NOT SCHEMA-WIDE. Every statement below names one daali_*
-- table this migration creates. There is no ON ALL TABLES / ON ALL SEQUENCES
-- statement, so this migration touches no legacy table, including its grants.
-- The daali_* tables use cuid() TEXT ids and own no sequences.
-- ---------------------------------------------------------------------------

ALTER TABLE public."daali_notification_deliveries"  ENABLE ROW LEVEL SECURITY;

-- Zero client policies, deliberately. Nothing authenticates as anon or
-- authenticated against these tables; every read is server-side through Prisma.
REVOKE ALL ON TABLE public."daali_notification_deliveries"  FROM PUBLIC, anon, authenticated;

GRANT ALL ON TABLE public."daali_notification_deliveries"  TO service_role;

-- FAIL CLOSED. Modeled on 20260908210000_entry_reservations_rls, but reads the
-- catalog directly rather than information_schema.role_table_grants, which
-- only lists grants whose grantor or grantee is a role the CURRENT user holds,
-- and so can miss a grant made by some other role. Covers every daali_* table
-- that exists when this runs (this migration's and every earlier daali
-- migration's), so a later phase also re-proves the earlier ones. Any finding
-- rolls the whole migration back:
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
     AND c.relname LIKE 'daali\_%'
     AND c.relrowsecurity IS NOT TRUE;
  IF unprotected IS NOT NULL THEN
    RAISE EXCEPTION 'daali 0D.0 containment aborted: RLS disabled on %', unprotected;
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
     AND c.relname LIKE 'daali\_%'
     AND has_table_privilege(r.role, c.oid, p.priv);
  IF exposed IS NOT NULL THEN
    RAISE EXCEPTION 'daali 0D.0 containment aborted: client privileges on %', exposed;
  END IF;

  SELECT string_agg(DISTINCT c.relname, ', ') INTO to_public
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
   CROSS JOIN LATERAL aclexplode(c.relacl) AS a
   WHERE n.nspname = 'public'
     AND c.relkind = 'r'
     AND c.relname LIKE 'daali\_%'
     AND a.grantee = 0;
  IF to_public IS NOT NULL THEN
    RAISE EXCEPTION 'daali 0D.0 containment aborted: PUBLIC grant on %', to_public;
  END IF;
END $$;
