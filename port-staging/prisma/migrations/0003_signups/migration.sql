-- Phase 0C — Volunteer shifts and item sign-ups.
-- Also closes the 0B audit gap with RegistrationLog.

-- ── 0B follow-up: who changed an RSVP from 2 to 6? ──────────────────────
CREATE TYPE "RegistrationAction" AS ENUM
  ('CREATED', 'PARTY_SIZE_CHANGED', 'CANCELLED', 'ORGANIZER_REMOVED');

CREATE TABLE "RegistrationLog" (
    "id"             TEXT NOT NULL,
    "registrationId" TEXT NOT NULL,
    "eventId"        TEXT NOT NULL,
    "eventPersonId"  TEXT NOT NULL,
    "action"         "RegistrationAction" NOT NULL,
    "fromPartySize"  INTEGER,
    "toPartySize"    INTEGER,
    "actorKind"          "ActorKind" NOT NULL,
    "actorUserId"        TEXT,
    "actorEventPersonId" TEXT,
    "planExecutionId"    TEXT,
    "createdAt"      TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "RegistrationLog_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "RegistrationLog_registrationId_idx" ON "RegistrationLog"("registrationId");
CREATE INDEX "RegistrationLog_eventId_idx"        ON "RegistrationLog"("eventId");
ALTER TABLE "RegistrationLog" ADD CONSTRAINT "RegistrationLog_registrationId_fkey"
    FOREIGN KEY ("registrationId") REFERENCES "Registration"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- ── 0C ──────────────────────────────────────────────────────────────────
CREATE TYPE "SlotType"     AS ENUM ('SHIFT', 'ITEM');
CREATE TYPE "SignupAction" AS ENUM ('CLAIMED', 'CANCELLED', 'ORGANIZER_REMOVED');

CREATE TABLE "SignupSheet" (
    "id"           TEXT NOT NULL,
    "eventId"      TEXT NOT NULL,
    "title"        TEXT,
    "instructions" TEXT,
    "isOpen"       BOOLEAN NOT NULL DEFAULT true,
    "createdAt"    TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt"    TIMESTAMP(3) NOT NULL,
    CONSTRAINT "SignupSheet_pkey" PRIMARY KEY ("id")
);
-- One sheet per event.
CREATE UNIQUE INDEX "SignupSheet_eventId_key" ON "SignupSheet"("eventId");
ALTER TABLE "SignupSheet" ADD CONSTRAINT "SignupSheet_eventId_fkey"
    FOREIGN KEY ("eventId") REFERENCES "Event"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- One table for both kinds. A shift and an item are the same shape: a named
-- thing with N openings. Six people on the gate and six cases of water are both
-- capacity = 6. A second table would duplicate every claim, cancel and
-- concurrency path for no gain.
CREATE TABLE "SignupSlot" (
    "id"        TEXT NOT NULL,
    "sheetId"   TEXT NOT NULL,
    "slotType"  "SlotType" NOT NULL,
    "name"      TEXT NOT NULL,
    "startsAt"  TIMESTAMP(3),        -- SHIFT only
    "endsAt"    TIMESTAMP(3),        -- SHIFT only
    "capacity"  INTEGER NOT NULL,
    "unitLabel" TEXT,                -- ITEM only: "case of water"
    "notes"     TEXT,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "SignupSlot_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "SignupSlot_capacity_positive" CHECK ("capacity" >= 1)
);
CREATE INDEX "SignupSlot_sheetId_sortOrder_idx" ON "SignupSlot"("sheetId", "sortOrder");
ALTER TABLE "SignupSlot" ADD CONSTRAINT "SignupSlot_sheetId_fkey"
    FOREIGN KEY ("sheetId") REFERENCES "SignupSheet"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- The row a human thinks about: "Daaliyah is bringing water."
-- There is NO quantity column. Quantity is count(HelperSignupPosition).
CREATE TABLE "HelperSignup" (
    "id"            TEXT NOT NULL,
    "slotId"        TEXT NOT NULL,
    "eventPersonId" TEXT NOT NULL,
    "note"          TEXT,
    "createdAt"     TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "actorKind"          "ActorKind" NOT NULL,
    "actorUserId"        TEXT,
    "actorEventPersonId" TEXT,
    "planExecutionId"    TEXT,
    CONSTRAINT "HelperSignup_pkey" PRIMARY KEY ("id")
);
-- One commitment per person per slot.
CREATE UNIQUE INDEX "HelperSignup_slotId_eventPersonId_key" ON "HelperSignup"("slotId", "eventPersonId");
-- Exists ONLY to be the target of the composite FK below. Costs nothing, and is
-- what makes the denormalized slotId structurally trustworthy rather than
-- trustworthy by convention.
CREATE UNIQUE INDEX "HelperSignup_id_slotId_key" ON "HelperSignup"("id", "slotId");
CREATE INDEX "HelperSignup_eventPersonId_idx" ON "HelperSignup"("eventPersonId");

ALTER TABLE "HelperSignup" ADD CONSTRAINT "HelperSignup_slotId_fkey"
    FOREIGN KEY ("slotId") REFERENCES "SignupSlot"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "HelperSignup" ADD CONSTRAINT "HelperSignup_eventPersonId_fkey"
    FOREIGN KEY ("eventPersonId") REFERENCES "EventPerson"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- The row the database thinks about. One per claimed capacity position.
CREATE TABLE "HelperSignupPosition" (
    "id"             TEXT NOT NULL,
    "helperSignupId" TEXT NOT NULL,
    "slotId"         TEXT NOT NULL,   -- denormalized ON PURPOSE
    "position"       INTEGER NOT NULL,
    CONSTRAINT "HelperSignupPosition_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "HelperSignupPosition_position_positive" CHECK ("position" >= 1)
);
-- THIS is what makes capacity safe under concurrency. Not a counter.
CREATE UNIQUE INDEX "HelperSignupPosition_slotId_position_key"
    ON "HelperSignupPosition"("slotId", "position");
CREATE INDEX "HelperSignupPosition_helperSignupId_idx" ON "HelperSignupPosition"("helperSignupId");

-- COMPOSITE foreign key, not two independent ones. Two plain FKs would let a
-- coding error attach setup-crew positions to a water commitment — the capacity
-- index would still be satisfied and the roster would be quietly wrong.
ALTER TABLE "HelperSignupPosition" ADD CONSTRAINT "HelperSignupPosition_signup_fkey"
    FOREIGN KEY ("helperSignupId", "slotId") REFERENCES "HelperSignup"("id", "slotId")
    ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "SignupLog" (
    "id"            TEXT NOT NULL,
    "slotId"        TEXT NOT NULL,
    "eventPersonId" TEXT NOT NULL,
    "action"        "SignupAction" NOT NULL,
    "positions"     INTEGER,
    "actorKind"          "ActorKind" NOT NULL,
    "actorUserId"        TEXT,
    "actorEventPersonId" TEXT,
    "planExecutionId"    TEXT,
    "createdAt"     TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "SignupLog_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "SignupLog_slotId_idx" ON "SignupLog"("slotId");

-- A position's denormalized slotId must also reference a real slot. This is a
-- SECOND fk on the same column, alongside the composite one above, and both earn
-- their place: the composite guarantees the position belongs to a commitment on
-- THAT slot; this one guarantees the slot exists at all.
ALTER TABLE "HelperSignupPosition" ADD CONSTRAINT "HelperSignupPosition_slotId_fkey"
    FOREIGN KEY ("slotId") REFERENCES "SignupSlot"("id") ON DELETE CASCADE ON UPDATE CASCADE;
