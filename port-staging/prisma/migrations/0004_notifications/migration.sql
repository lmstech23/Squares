-- Phase 0D.0 — Minimal, working notification delivery.
--
-- DELIBERATELY ABSENT (0D.1): lockedAt, lockToken, nextAttemptAt.
-- Those are nullable additive columns, so 0D.1 is a migration that touches no
-- existing row and no 0D.0 code path other than the claim.

CREATE TYPE "NotificationType"   AS ENUM ('RSVP_CONFIRMED');
CREATE TYPE "NotificationStatus" AS ENUM ('pending', 'sent', 'failed');

CREATE TABLE "NotificationDelivery" (
    "id"               TEXT NOT NULL,
    "notificationType" "NotificationType" NOT NULL,
    -- The key names the THING BEING COMMUNICATED. A receipt belongs to a
    -- registration, not to a person: someone who RSVPs, cancels, and RSVPs again
    -- deserves the second confirmation. A person-scoped key would silently
    -- suppress it, because the row would already read 'sent'.
    "dedupeKey"        TEXT NOT NULL,
    "eventPersonId"    TEXT NOT NULL,   -- for querying. NOT part of any uniqueness rule
    "registrationId"   TEXT,
    "status"           "NotificationStatus" NOT NULL DEFAULT 'pending',
    "attempts"         INTEGER NOT NULL DEFAULT 0,
    "providerMessageId" TEXT,
    "lastError"        TEXT,
    "sentAt"           TIMESTAMP(3),
    "createdAt"        TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt"        TIMESTAMP(3) NOT NULL,
    CONSTRAINT "NotificationDelivery_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "NotificationDelivery_type_dedupeKey_key"
    ON "NotificationDelivery"("notificationType", "dedupeKey");
CREATE INDEX "NotificationDelivery_eventPersonId_idx" ON "NotificationDelivery"("eventPersonId");
CREATE INDEX "NotificationDelivery_status_idx"        ON "NotificationDelivery"("status");

ALTER TABLE "NotificationDelivery" ADD CONSTRAINT "NotificationDelivery_eventPersonId_fkey"
    FOREIGN KEY ("eventPersonId") REFERENCES "EventPerson"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "NotificationDelivery" ADD CONSTRAINT "NotificationDelivery_registrationId_fkey"
    FOREIGN KEY ("registrationId") REFERENCES "Registration"("id") ON DELETE CASCADE ON UPDATE CASCADE;
