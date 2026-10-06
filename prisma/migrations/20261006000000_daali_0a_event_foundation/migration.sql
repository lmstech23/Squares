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
-- Containment. LAST, and in this same transaction (Port Plan R1). Same
-- pattern as 20260831150000_s1_signup_sheets: REVOKE ... ON ALL TABLES
-- resolves at execution time, so it must run after the CREATE TABLEs above.
-- ---------------------------------------------------------------------------

ALTER TABLE public."daali_events" ENABLE ROW LEVEL SECURITY;
ALTER TABLE public."daali_event_people" ENABLE ROW LEVEL SECURITY;
ALTER TABLE public."daali_command_executions" ENABLE ROW LEVEL SECURITY;

-- Zero client policies, deliberately. Nothing authenticates as anon or
-- authenticated against these tables; every read is server-side through Prisma.
REVOKE ALL ON ALL TABLES    IN SCHEMA public FROM PUBLIC, anon, authenticated;
REVOKE ALL ON ALL SEQUENCES IN SCHEMA public FROM PUBLIC, anon, authenticated;

GRANT ALL ON ALL TABLES    IN SCHEMA public TO service_role;
GRANT ALL ON ALL SEQUENCES IN SCHEMA public TO service_role;
