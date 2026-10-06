-- Phase 0A — Event foundation. Additive only.

CREATE TYPE "EventStatus" AS ENUM ('DRAFT', 'PUBLISHED', 'CLOSED');

CREATE TABLE "Event" (
    "id"              TEXT NOT NULL,
    "organizerUserId" TEXT NOT NULL,
    "title"           TEXT NOT NULL,
    "slug"            TEXT,
    "description"     TEXT,
    "startsAt"        TIMESTAMP(3) NOT NULL,
    "endsAt"          TIMESTAMP(3),
    "timezone"        TEXT NOT NULL,
    "venueName"       TEXT,
    "venueAddress"    TEXT,
    "status"          "EventStatus" NOT NULL DEFAULT 'DRAFT',
    "capacity"        INTEGER,
    "publishedAt"     TIMESTAMP(3),
    "createdAt"       TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt"       TIMESTAMP(3) NOT NULL,
    CONSTRAINT "Event_pkey" PRIMARY KEY ("id")
);

-- Postgres permits many NULLs in a UNIQUE index, so drafts coexist without slugs.
CREATE UNIQUE INDEX "Event_slug_key" ON "Event"("slug");
CREATE INDEX "Event_organizerUserId_status_idx" ON "Event"("organizerUserId", "status");

CREATE TABLE "EventPerson" (
    "id"          TEXT NOT NULL,
    "eventId"     TEXT NOT NULL,
    "identityKey" TEXT NOT NULL,
    "name"        TEXT NOT NULL,
    "email"       TEXT NOT NULL,
    "phone"       TEXT,
    "createdAt"   TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt"   TIMESTAMP(3) NOT NULL,
    CONSTRAINT "EventPerson_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "EventPerson_eventId_identityKey_key" ON "EventPerson"("eventId", "identityKey");
CREATE INDEX "EventPerson_eventId_idx" ON "EventPerson"("eventId");

CREATE TABLE "CommandExecution" (
    "id"             TEXT NOT NULL,
    "commandName"    TEXT NOT NULL,
    "idempotencyKey" TEXT NOT NULL,
    "eventId"        TEXT,
    "inputHash"      TEXT NOT NULL,
    "result"         JSONB NOT NULL,
    "createdAt"      TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "CommandExecution_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "CommandExecution_commandName_idempotencyKey_key"
    ON "CommandExecution"("commandName", "idempotencyKey");
CREATE INDEX "CommandExecution_eventId_idx" ON "CommandExecution"("eventId");

ALTER TABLE "EventPerson" ADD CONSTRAINT "EventPerson_eventId_fkey"
    FOREIGN KEY ("eventId") REFERENCES "Event"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "CommandExecution" ADD CONSTRAINT "CommandExecution_eventId_fkey"
    FOREIGN KEY ("eventId") REFERENCES "Event"("id") ON DELETE CASCADE ON UPDATE CASCADE;
