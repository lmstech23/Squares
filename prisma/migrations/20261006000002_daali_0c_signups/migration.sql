-- Daali Event port, Phase 0C - Volunteer shifts and item sign-ups (plus RegistrationLog).
--
-- Ported from the recovered Phase 0 package (archive/phase0-historical,
-- phase0/daali-0d/prisma/migrations/0003_signups) under the Daali persistence
-- namespace (Port Plan, Naming map). Additive only: creates daali_* objects
-- and touches no legacy table.
--
-- The DDL below is `prisma migrate diff` output against a database replayed
-- from the full migration chain, unedited. Objects Prisma cannot express are
-- hand-ported after it, from the archived SQL with Daali names.

-- CreateEnum
CREATE TYPE "daali_registration_action" AS ENUM ('CREATED', 'PARTY_SIZE_CHANGED', 'CANCELLED', 'ORGANIZER_REMOVED');

-- CreateEnum
CREATE TYPE "daali_slot_type" AS ENUM ('SHIFT', 'ITEM');

-- CreateEnum
CREATE TYPE "daali_signup_action" AS ENUM ('CLAIMED', 'CANCELLED', 'ORGANIZER_REMOVED');

-- CreateTable
CREATE TABLE "daali_registration_logs" (
    "id" TEXT NOT NULL,
    "registrationId" TEXT NOT NULL,
    "eventId" TEXT NOT NULL,
    "eventPersonId" TEXT NOT NULL,
    "action" "daali_registration_action" NOT NULL,
    "fromPartySize" INTEGER,
    "toPartySize" INTEGER,
    "actorKind" "daali_actor_kind" NOT NULL,
    "actorUserId" TEXT,
    "actorEventPersonId" TEXT,
    "planExecutionId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "daali_registration_logs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "daali_signup_sheets" (
    "id" TEXT NOT NULL,
    "eventId" TEXT NOT NULL,
    "title" TEXT,
    "instructions" TEXT,
    "isOpen" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "daali_signup_sheets_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "daali_signup_slots" (
    "id" TEXT NOT NULL,
    "sheetId" TEXT NOT NULL,
    "slotType" "daali_slot_type" NOT NULL,
    "name" TEXT NOT NULL,
    "startsAt" TIMESTAMP(3),
    "endsAt" TIMESTAMP(3),
    "capacity" INTEGER NOT NULL,
    "unitLabel" TEXT,
    "notes" TEXT,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "daali_signup_slots_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "daali_helper_signups" (
    "id" TEXT NOT NULL,
    "slotId" TEXT NOT NULL,
    "eventPersonId" TEXT NOT NULL,
    "note" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "actorKind" "daali_actor_kind" NOT NULL,
    "actorUserId" TEXT,
    "actorEventPersonId" TEXT,
    "planExecutionId" TEXT,

    CONSTRAINT "daali_helper_signups_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "daali_helper_signup_positions" (
    "id" TEXT NOT NULL,
    "helperSignupId" TEXT NOT NULL,
    "slotId" TEXT NOT NULL,
    "position" INTEGER NOT NULL,

    CONSTRAINT "daali_helper_signup_positions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "daali_signup_logs" (
    "id" TEXT NOT NULL,
    "slotId" TEXT NOT NULL,
    "eventPersonId" TEXT NOT NULL,
    "action" "daali_signup_action" NOT NULL,
    "positions" INTEGER,
    "actorKind" "daali_actor_kind" NOT NULL,
    "actorUserId" TEXT,
    "actorEventPersonId" TEXT,
    "planExecutionId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "daali_signup_logs_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "daali_registration_logs_registrationId_idx" ON "daali_registration_logs"("registrationId");

-- CreateIndex
CREATE INDEX "daali_registration_logs_eventId_idx" ON "daali_registration_logs"("eventId");

-- CreateIndex
CREATE UNIQUE INDEX "daali_signup_sheets_eventId_key" ON "daali_signup_sheets"("eventId");

-- CreateIndex
CREATE INDEX "daali_signup_slots_sheetId_sortOrder_idx" ON "daali_signup_slots"("sheetId", "sortOrder");

-- CreateIndex
CREATE INDEX "daali_helper_signups_eventPersonId_idx" ON "daali_helper_signups"("eventPersonId");

-- CreateIndex
CREATE UNIQUE INDEX "daali_helper_signups_slotId_eventPersonId_key" ON "daali_helper_signups"("slotId", "eventPersonId");

-- CreateIndex
CREATE UNIQUE INDEX "daali_helper_signups_id_slotId_key" ON "daali_helper_signups"("id", "slotId");

-- CreateIndex
CREATE INDEX "daali_helper_signup_positions_helperSignupId_idx" ON "daali_helper_signup_positions"("helperSignupId");

-- CreateIndex
CREATE UNIQUE INDEX "daali_helper_signup_positions_slotId_position_key" ON "daali_helper_signup_positions"("slotId", "position");

-- CreateIndex
CREATE INDEX "daali_signup_logs_slotId_idx" ON "daali_signup_logs"("slotId");

-- AddForeignKey
ALTER TABLE "daali_registration_logs" ADD CONSTRAINT "daali_registration_logs_registrationId_fkey" FOREIGN KEY ("registrationId") REFERENCES "daali_registrations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "daali_signup_sheets" ADD CONSTRAINT "daali_signup_sheets_eventId_fkey" FOREIGN KEY ("eventId") REFERENCES "daali_events"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "daali_signup_slots" ADD CONSTRAINT "daali_signup_slots_sheetId_fkey" FOREIGN KEY ("sheetId") REFERENCES "daali_signup_sheets"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "daali_helper_signups" ADD CONSTRAINT "daali_helper_signups_slotId_fkey" FOREIGN KEY ("slotId") REFERENCES "daali_signup_slots"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "daali_helper_signups" ADD CONSTRAINT "daali_helper_signups_eventPersonId_fkey" FOREIGN KEY ("eventPersonId") REFERENCES "daali_event_people"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "daali_helper_signup_positions" ADD CONSTRAINT "daali_helper_signup_positions_signup_fkey" FOREIGN KEY ("helperSignupId", "slotId") REFERENCES "daali_helper_signups"("id", "slotId") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "daali_helper_signup_positions" ADD CONSTRAINT "daali_helper_signup_positions_slotId_fkey" FOREIGN KEY ("slotId") REFERENCES "daali_signup_slots"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- ---------------------------------------------------------------------------
-- Hand-ported from archived 0003_signups. Prisma cannot express CHECKs.
-- Both were inline in the archived CREATE TABLEs; added here as ALTER TABLE so
-- the generated DDL above stays verbatim. The constraints are the same.
-- ---------------------------------------------------------------------------

-- Archived: CONSTRAINT "SignupSlot_capacity_positive" CHECK ("capacity" >= 1)
ALTER TABLE "daali_signup_slots"
    ADD CONSTRAINT "daali_signup_slots_capacity_positive" CHECK ("capacity" >= 1);

-- Archived: CONSTRAINT "HelperSignupPosition_position_positive" CHECK ("position" >= 1)
ALTER TABLE "daali_helper_signup_positions"
    ADD CONSTRAINT "daali_helper_signup_positions_position_positive" CHECK ("position" >= 1);

-- ---------------------------------------------------------------------------
-- Containment. LAST, and in this same transaction (Port Plan R1). Same
-- pattern as 20260831150000_s1_signup_sheets: REVOKE ... ON ALL TABLES
-- resolves at execution time, so it must run after the CREATE TABLEs above.
-- ---------------------------------------------------------------------------

ALTER TABLE public."daali_registration_logs" ENABLE ROW LEVEL SECURITY;
ALTER TABLE public."daali_signup_sheets" ENABLE ROW LEVEL SECURITY;
ALTER TABLE public."daali_signup_slots" ENABLE ROW LEVEL SECURITY;
ALTER TABLE public."daali_helper_signups" ENABLE ROW LEVEL SECURITY;
ALTER TABLE public."daali_helper_signup_positions" ENABLE ROW LEVEL SECURITY;
ALTER TABLE public."daali_signup_logs" ENABLE ROW LEVEL SECURITY;

-- Zero client policies, deliberately. Nothing authenticates as anon or
-- authenticated against these tables; every read is server-side through Prisma.
REVOKE ALL ON ALL TABLES    IN SCHEMA public FROM PUBLIC, anon, authenticated;
REVOKE ALL ON ALL SEQUENCES IN SCHEMA public FROM PUBLIC, anon, authenticated;

GRANT ALL ON ALL TABLES    IN SCHEMA public TO service_role;
GRANT ALL ON ALL SEQUENCES IN SCHEMA public TO service_role;
