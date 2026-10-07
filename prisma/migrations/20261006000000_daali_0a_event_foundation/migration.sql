-- Daali Event port, Phase 0A - Event foundation.
--
-- Ported from the recovered Phase 0 package (archive/phase0-historical,
-- phase0/daali-0d/prisma/migrations/0001_event_foundation) under the Daali persistence
-- namespace (Port Plan, Naming map). Additive only: creates daali_* objects
-- and touches no legacy table.
--
-- The DDL below is `prisma migrate diff` output against a database replayed
-- from the full migration chain, unedited. Objects Prisma cannot express are
-- hand-ported after it, from the archived SQL with Daali names.

-- CreateEnum
CREATE TYPE "daali_event_status" AS ENUM ('DRAFT', 'PUBLISHED', 'CLOSED');

-- CreateTable
CREATE TABLE "daali_events" (
    "id" TEXT NOT NULL,
    "organizerUserId" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "slug" TEXT,
    "description" TEXT,
    "startsAt" TIMESTAMP(3) NOT NULL,
    "endsAt" TIMESTAMP(3),
    "timezone" TEXT NOT NULL,
    "venueName" TEXT,
    "venueAddress" TEXT,
    "status" "daali_event_status" NOT NULL DEFAULT 'DRAFT',
    "capacity" INTEGER,
    "publishedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "daali_events_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "daali_event_people" (
    "id" TEXT NOT NULL,
    "eventId" TEXT NOT NULL,
    "identityKey" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "phone" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "daali_event_people_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "daali_command_executions" (
    "id" TEXT NOT NULL,
    "commandName" TEXT NOT NULL,
    "idempotencyKey" TEXT NOT NULL,
    "eventId" TEXT,
    "inputHash" TEXT NOT NULL,
    "result" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "daali_command_executions_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "daali_events_slug_key" ON "daali_events"("slug");

-- CreateIndex
CREATE INDEX "daali_events_organizerUserId_status_idx" ON "daali_events"("organizerUserId", "status");

-- CreateIndex
CREATE INDEX "daali_event_people_eventId_idx" ON "daali_event_people"("eventId");

-- CreateIndex
CREATE UNIQUE INDEX "daali_event_people_eventId_identityKey_key" ON "daali_event_people"("eventId", "identityKey");

-- CreateIndex
CREATE INDEX "daali_command_executions_eventId_idx" ON "daali_command_executions"("eventId");

-- CreateIndex
CREATE UNIQUE INDEX "daali_command_executions_commandName_idempotencyKey_key" ON "daali_command_executions"("commandName", "idempotencyKey");

-- AddForeignKey
ALTER TABLE "daali_event_people" ADD CONSTRAINT "daali_event_people_eventId_fkey" FOREIGN KEY ("eventId") REFERENCES "daali_events"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "daali_command_executions" ADD CONSTRAINT "daali_command_executions_eventId_fkey" FOREIGN KEY ("eventId") REFERENCES "daali_events"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- ---------------------------------------------------------------------------
-- Containment. LAST, and in this same transaction (Port Plan R1).
--
-- TABLE-SCOPED, NOT SCHEMA-WIDE. Every statement below names one daali_*
-- table this migration creates. There is no ON ALL TABLES / ON ALL SEQUENCES
-- statement, so this migration touches no legacy table, including its grants.
-- The daali_* tables use cuid() TEXT ids and own no sequences.
-- ---------------------------------------------------------------------------

ALTER TABLE public."daali_events"              ENABLE ROW LEVEL SECURITY;
ALTER TABLE public."daali_event_people"        ENABLE ROW LEVEL SECURITY;
ALTER TABLE public."daali_command_executions"  ENABLE ROW LEVEL SECURITY;

-- Zero client policies, deliberately. Nothing authenticates as anon or
-- authenticated against these tables; every read is server-side through Prisma.
REVOKE ALL ON TABLE public."daali_events"              FROM PUBLIC, anon, authenticated;
REVOKE ALL ON TABLE public."daali_event_people"        FROM PUBLIC, anon, authenticated;
REVOKE ALL ON TABLE public."daali_command_executions"  FROM PUBLIC, anon, authenticated;

GRANT ALL ON TABLE public."daali_events"              TO service_role;
GRANT ALL ON TABLE public."daali_event_people"        TO service_role;
GRANT ALL ON TABLE public."daali_command_executions"  TO service_role;

-- FAIL CLOSED. Modeled on 20260908210000_entry_reservations_rls. Covers every
-- daali_* table that exists when this runs (this migration's and every earlier
-- daali migration's), so a later phase also re-proves the earlier ones. If any
-- has RLS off, or grants anything to PUBLIC, anon or authenticated, the whole
-- migration rolls back.
DO $$
DECLARE
  unprotected TEXT;
  leaked      TEXT;
BEGIN
  SELECT string_agg(c.relname, ', ' ORDER BY c.relname) INTO unprotected
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
   WHERE n.nspname = 'public'
     AND c.relkind = 'r'
     AND c.relname LIKE 'daali\_%'
     AND c.relrowsecurity IS NOT TRUE;
  IF unprotected IS NOT NULL THEN
    RAISE EXCEPTION 'daali 0A containment aborted: RLS disabled on %', unprotected;
  END IF;

  SELECT string_agg(DISTINCT format('%s/%s', table_name, grantee), ', ') INTO leaked
    FROM information_schema.role_table_grants
   WHERE table_schema = 'public'
     AND table_name LIKE 'daali\_%'
     AND grantee IN ('anon', 'authenticated', 'PUBLIC');
  IF leaked IS NOT NULL THEN
    RAISE EXCEPTION 'daali 0A containment aborted: client grants remain on %', leaked;
  END IF;
END $$;
