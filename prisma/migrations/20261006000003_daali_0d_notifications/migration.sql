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
-- Containment. LAST, and in this same transaction (Port Plan R1). Same
-- pattern as 20260831150000_s1_signup_sheets: REVOKE ... ON ALL TABLES
-- resolves at execution time, so it must run after the CREATE TABLEs above.
-- ---------------------------------------------------------------------------

ALTER TABLE public."daali_notification_deliveries" ENABLE ROW LEVEL SECURITY;

-- Zero client policies, deliberately. Nothing authenticates as anon or
-- authenticated against these tables; every read is server-side through Prisma.
REVOKE ALL ON ALL TABLES    IN SCHEMA public FROM PUBLIC, anon, authenticated;
REVOKE ALL ON ALL SEQUENCES IN SCHEMA public FROM PUBLIC, anon, authenticated;

GRANT ALL ON ALL TABLES    IN SCHEMA public TO service_role;
GRANT ALL ON ALL SEQUENCES IN SCHEMA public TO service_role;
