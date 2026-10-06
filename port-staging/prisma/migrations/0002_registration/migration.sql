-- Phase 0B — Registration / RSVP. Additive only.

CREATE TYPE "ActorKind" AS ENUM ('HUMAN', 'AGENT');
CREATE TYPE "RegistrationStatus" AS ENUM ('CONFIRMED', 'CANCELLED');

CREATE TABLE "Registration" (
    "id"            TEXT NOT NULL,
    "eventId"       TEXT NOT NULL,
    "eventPersonId" TEXT NOT NULL,
    "partySize"     INTEGER NOT NULL DEFAULT 1,
    "status"        "RegistrationStatus" NOT NULL DEFAULT 'CONFIRMED',
    "note"          TEXT,
    "createdAt"     TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "cancelledAt"   TIMESTAMP(3),
    "actorKind"          "ActorKind" NOT NULL,
    "actorUserId"        TEXT,
    "actorEventPersonId" TEXT,
    "planExecutionId"    TEXT,
    "cancelledByKind"          "ActorKind",
    "cancelledByUserId"        TEXT,
    "cancelledByEventPersonId" TEXT,
    "cancelledByPlanId"        TEXT,
    CONSTRAINT "Registration_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "Registration_partySize_positive" CHECK ("partySize" >= 1)
);

-- One LIVE registration per person per event. Cancelled rows stay for history,
-- and a re-RSVP is permitted. Legal as a partial index because the predicate
-- reads a column on this table.
CREATE UNIQUE INDEX "Registration_live_key"
    ON "Registration"("eventId", "eventPersonId")
    WHERE "status" = 'CONFIRMED';

CREATE INDEX "Registration_eventId_status_idx" ON "Registration"("eventId", "status");
CREATE INDEX "Registration_eventPersonId_idx"  ON "Registration"("eventPersonId");

ALTER TABLE "Registration" ADD CONSTRAINT "Registration_eventId_fkey"
    FOREIGN KEY ("eventId") REFERENCES "Event"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "Registration" ADD CONSTRAINT "Registration_eventPersonId_fkey"
    FOREIGN KEY ("eventPersonId") REFERENCES "EventPerson"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "EventPersonAccessToken" (
    "id"            TEXT NOT NULL,
    "eventPersonId" TEXT NOT NULL,
    "version"       INTEGER NOT NULL DEFAULT 1,
    "tokenHash"     TEXT NOT NULL,
    "createdAt"     TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "revokedAt"     TIMESTAMP(3),
    CONSTRAINT "EventPersonAccessToken_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "EventPersonAccessToken_eventPersonId_key" ON "EventPersonAccessToken"("eventPersonId");
CREATE UNIQUE INDEX "EventPersonAccessToken_tokenHash_key"     ON "EventPersonAccessToken"("tokenHash");

ALTER TABLE "EventPersonAccessToken" ADD CONSTRAINT "EventPersonAccessToken_eventPersonId_fkey"
    FOREIGN KEY ("eventPersonId") REFERENCES "EventPerson"("id") ON DELETE CASCADE ON UPDATE CASCADE;
