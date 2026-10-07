-- Daali Event port, Phase 0B - Registration / RSVP.
--
-- Ported from the recovered Phase 0 package (archive/phase0-historical,
-- phase0/daali-0d/prisma/migrations/0002_registration) under the Daali persistence
-- namespace (Port Plan, Naming map). Additive only: creates daali_* objects
-- and touches no legacy table.
--
-- The DDL below is `prisma migrate diff` output against a database replayed
-- from the full migration chain, unedited. Objects Prisma cannot express are
-- hand-ported after it, from the archived SQL with Daali names.

-- CreateEnum
CREATE TYPE "daali_actor_kind" AS ENUM ('HUMAN', 'AGENT');

-- CreateEnum
CREATE TYPE "daali_registration_status" AS ENUM ('CONFIRMED', 'CANCELLED');

-- CreateTable
CREATE TABLE "daali_registrations" (
    "id" TEXT NOT NULL,
    "eventId" TEXT NOT NULL,
    "eventPersonId" TEXT NOT NULL,
    "partySize" INTEGER NOT NULL DEFAULT 1,
    "status" "daali_registration_status" NOT NULL DEFAULT 'CONFIRMED',
    "note" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "cancelledAt" TIMESTAMP(3),
    "actorKind" "daali_actor_kind" NOT NULL,
    "actorUserId" TEXT,
    "actorEventPersonId" TEXT,
    "planExecutionId" TEXT,
    "cancelledByKind" "daali_actor_kind",
    "cancelledByUserId" TEXT,
    "cancelledByEventPersonId" TEXT,
    "cancelledByPlanId" TEXT,

    CONSTRAINT "daali_registrations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "daali_event_person_access_tokens" (
    "id" TEXT NOT NULL,
    "eventPersonId" TEXT NOT NULL,
    "version" INTEGER NOT NULL DEFAULT 1,
    "tokenHash" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "revokedAt" TIMESTAMP(3),

    CONSTRAINT "daali_event_person_access_tokens_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "daali_registrations_eventId_status_idx" ON "daali_registrations"("eventId", "status");

-- CreateIndex
CREATE INDEX "daali_registrations_eventPersonId_idx" ON "daali_registrations"("eventPersonId");

-- CreateIndex
CREATE UNIQUE INDEX "daali_event_person_access_tokens_eventPersonId_key" ON "daali_event_person_access_tokens"("eventPersonId");

-- CreateIndex
CREATE UNIQUE INDEX "daali_event_person_access_tokens_tokenHash_key" ON "daali_event_person_access_tokens"("tokenHash");

-- AddForeignKey
ALTER TABLE "daali_registrations" ADD CONSTRAINT "daali_registrations_eventId_fkey" FOREIGN KEY ("eventId") REFERENCES "daali_events"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "daali_registrations" ADD CONSTRAINT "daali_registrations_eventPersonId_fkey" FOREIGN KEY ("eventPersonId") REFERENCES "daali_event_people"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "daali_event_person_access_tokens" ADD CONSTRAINT "daali_event_person_access_tokens_eventPersonId_fkey" FOREIGN KEY ("eventPersonId") REFERENCES "daali_event_people"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- ---------------------------------------------------------------------------
-- Hand-ported from archived 0002_registration. Prisma cannot express either.
-- ---------------------------------------------------------------------------

-- Archived: CONSTRAINT "Registration_partySize_positive" CHECK ("partySize" >= 1),
-- inline in CREATE TABLE. Added here as ALTER TABLE so the generated DDL above
-- stays verbatim; the constraint is the same.
ALTER TABLE "daali_registrations"
    ADD CONSTRAINT "daali_registrations_partySize_positive" CHECK ("partySize" >= 1);

-- One LIVE registration per person per event. Cancelled rows stay for history,
-- and a re-RSVP is permitted. Legal as a partial index because the predicate
-- reads a column on this table. (Archived: "Registration_live_key".)
CREATE UNIQUE INDEX "daali_registrations_live_key"
    ON "daali_registrations"("eventId", "eventPersonId")
    WHERE "status" = 'CONFIRMED';

-- ---------------------------------------------------------------------------
-- Containment. LAST, and in this same transaction (Port Plan R1).
--
-- TABLE-SCOPED, NOT SCHEMA-WIDE. Every statement below names one daali_*
-- table this migration creates. There is no ON ALL TABLES / ON ALL SEQUENCES
-- statement, so this migration touches no legacy table, including its grants.
-- The daali_* tables use cuid() TEXT ids and own no sequences.
-- ---------------------------------------------------------------------------

ALTER TABLE public."daali_registrations"               ENABLE ROW LEVEL SECURITY;
ALTER TABLE public."daali_event_person_access_tokens"  ENABLE ROW LEVEL SECURITY;

-- Zero client policies, deliberately. Nothing authenticates as anon or
-- authenticated against these tables; every read is server-side through Prisma.
REVOKE ALL ON TABLE public."daali_registrations"               FROM PUBLIC, anon, authenticated;
REVOKE ALL ON TABLE public."daali_event_person_access_tokens"  FROM PUBLIC, anon, authenticated;

GRANT ALL ON TABLE public."daali_registrations"               TO service_role;
GRANT ALL ON TABLE public."daali_event_person_access_tokens"  TO service_role;

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
    RAISE EXCEPTION 'daali 0B containment aborted: RLS disabled on %', unprotected;
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
    RAISE EXCEPTION 'daali 0B containment aborted: client privileges on %', exposed;
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
    RAISE EXCEPTION 'daali 0B containment aborted: PUBLIC grant on %', to_public;
  END IF;
END $$;
