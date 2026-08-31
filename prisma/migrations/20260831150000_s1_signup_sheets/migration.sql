-- S1 — Sign-up sheets. fundraiser-signup-addendum.md v1.6 §3, §5b.
--
-- ORDERING IS LOAD-BEARING, NOT STYLE. Tables are created first; the RLS and
-- grant statements come last, in THIS SAME MIGRATION.
--
-- `REVOKE ALL ON ALL TABLES IN SCHEMA public` resolves AT EXECUTION TIME. It
-- covers the tables that exist when it runs and never tables created after.
-- Running it before the CREATE TABLEs would apply it to the pre-S1 set and
-- leave all six new tables ungoverned. Splitting RLS into a follow-up migration
-- would leave a window where six tables holding supporter identity exist with
-- RLS off. In one transaction there is no window.
--
-- This mirrors rather than contradicts 0_init. There, DEFAULT PRIVILEGES are
-- revoked before any table is created so nothing is ever briefly exposed, and
-- the ALL TABLES statements come after. S1 inherits those corrected defaults --
-- verified in the preflight -- so a new table is already born without anon
-- grants, and the explicit statements still have to run last to reach it.
--
-- Preconditions verified before this file was written:
--   current_user over DIRECT_URL = postgres   (the ALTER DEFAULT PRIVILEGES
--     lines in 0_init are scoped FOR ROLE postgres and govern only what that
--     role creates)
--   pre-state catalog captured: 16 relations, all RLS on
--   no model uses @default(autoincrement()); zero sequences in public, so the
--     ALL SEQUENCES statements below still act on an empty set and are not
--     coverage
--
-- Expected after: 22 relations. 16 + 6 new. The token change is a RENAME, so
-- it does not move the count.

-- CreateEnum
CREATE TYPE "slot_type" AS ENUM ('SHIFT', 'ITEM');

-- CreateEnum
CREATE TYPE "signup_action" AS ENUM ('CLAIMED', 'CANCELLED', 'HOST_REMOVED');

-- CreateEnum
CREATE TYPE "actor_type" AS ENUM ('SUPPORTER', 'HOST');

-- CreateEnum
CREATE TYPE "notification_type" AS ENUM ('CONTRIBUTION_CONFIRMED', 'SIGNUP_LINK');

-- CreateEnum
CREATE TYPE "notification_status" AS ENUM ('pending', 'sent', 'failed');

-- AlterTable
ALTER TABLE "admission_grants" ADD COLUMN     "wants_to_help" BOOLEAN NOT NULL DEFAULT false;

-- RenameTable: attendance_access_tokens -> supporter_access_tokens
--
-- A REAL RENAME, not the DROP TABLE + CREATE TABLE that `migrate diff`
-- generates. The table is empty today, so the generated form would not have
-- lost data -- but a destructive statement that is only safe because of a
-- current row count is the wrong thing to commit. A rename preserves the
-- table identity, its primary key, and every grant already on it.
ALTER TABLE "attendance_access_tokens" RENAME TO "supporter_access_tokens";
ALTER TABLE "supporter_access_tokens" RENAME CONSTRAINT "attendance_access_tokens_pkey" TO "supporter_access_tokens_pkey";
ALTER TABLE "supporter_access_tokens" RENAME CONSTRAINT "attendance_access_tokens_event_supporter_id_fkey" TO "supporter_access_tokens_event_supporter_id_fkey";
ALTER INDEX "idx_attendance_tokens_supporter" RENAME TO "idx_supporter_access_tokens_supporter";

-- Single-use is dropped: the sign-up link is reusable, and a token burned on
-- first open contradicts both that and the supporter-scoped SIGNUP_LINK
-- dedupe key. `revoked_at` replaces it as the revocation signal.
ALTER TABLE "supporter_access_tokens" DROP COLUMN "used_at";
ALTER TABLE "supporter_access_tokens" ADD COLUMN "revoked_at" TIMESTAMPTZ(6);

-- CreateTable
CREATE TABLE "signup_sheets" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "event_id" UUID NOT NULL,
    "title" TEXT,
    "instructions" TEXT,
    "is_open" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "signup_sheets_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "signup_slots" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "sheet_id" UUID NOT NULL,
    "slot_type" "slot_type" NOT NULL,
    "name" TEXT NOT NULL,
    "starts_at" TIMESTAMPTZ(6),
    "ends_at" TIMESTAMPTZ(6),
    "capacity" INTEGER NOT NULL,
    "unit_label" TEXT,
    "notes" TEXT,
    "sort_order" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "signup_slots_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "helper_signups" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "slot_id" UUID NOT NULL,
    "event_supporter_id" UUID NOT NULL,
    "note" TEXT,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "helper_signups_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "helper_signup_positions" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "helper_signup_id" UUID NOT NULL,
    "slot_id" UUID NOT NULL,
    "position" INTEGER NOT NULL,

    CONSTRAINT "helper_signup_positions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "signup_logs" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "slot_id" UUID NOT NULL,
    "event_supporter_id" UUID NOT NULL,
    "action" "signup_action" NOT NULL,
    "actor_type" "actor_type" NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "signup_logs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "notification_deliveries" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "notification_type" "notification_type" NOT NULL,
    "dedupe_key" TEXT NOT NULL,
    "event_supporter_id" UUID NOT NULL,
    "status" "notification_status" NOT NULL DEFAULT 'pending',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "locked_at" TIMESTAMPTZ(6),
    "lock_token" TEXT,
    "next_attempt_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "provider_message_id" TEXT,
    "last_error" TEXT,
    "sent_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "notification_deliveries_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "supporter_access_tokens_token_hash_key" ON "supporter_access_tokens"("token_hash");

-- CreateIndex
CREATE UNIQUE INDEX "signup_sheets_event_id_key" ON "signup_sheets"("event_id");

-- CreateIndex
CREATE INDEX "idx_signup_slots_sheet_order" ON "signup_slots"("sheet_id", "sort_order");

-- CreateIndex
CREATE INDEX "idx_helper_signups_supporter" ON "helper_signups"("event_supporter_id");

-- CreateIndex
CREATE UNIQUE INDEX "helper_signups_slot_supporter_key" ON "helper_signups"("slot_id", "event_supporter_id");

-- CreateIndex
CREATE UNIQUE INDEX "helper_signups_id_slot_key" ON "helper_signups"("id", "slot_id");

-- CreateIndex
CREATE UNIQUE INDEX "helper_signup_positions_slot_position_key" ON "helper_signup_positions"("slot_id", "position");

-- CreateIndex
CREATE INDEX "idx_signup_logs_slot_created" ON "signup_logs"("slot_id", "created_at");

-- CreateIndex
CREATE INDEX "idx_notification_deliveries_claim" ON "notification_deliveries"("status", "next_attempt_at");

-- CreateIndex
CREATE UNIQUE INDEX "notification_deliveries_type_key_key" ON "notification_deliveries"("notification_type", "dedupe_key");

-- AddForeignKey
ALTER TABLE "signup_sheets" ADD CONSTRAINT "signup_sheets_event_id_fkey" FOREIGN KEY ("event_id") REFERENCES "events"("id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "signup_slots" ADD CONSTRAINT "signup_slots_sheet_id_fkey" FOREIGN KEY ("sheet_id") REFERENCES "signup_sheets"("id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "helper_signups" ADD CONSTRAINT "helper_signups_slot_id_fkey" FOREIGN KEY ("slot_id") REFERENCES "signup_slots"("id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "helper_signups" ADD CONSTRAINT "helper_signups_event_supporter_id_fkey" FOREIGN KEY ("event_supporter_id") REFERENCES "event_supporters"("id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "helper_signup_positions" ADD CONSTRAINT "helper_signup_positions_helper_signup_id_slot_id_fkey" FOREIGN KEY ("helper_signup_id", "slot_id") REFERENCES "helper_signups"("id", "slot_id") ON DELETE CASCADE ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "helper_signup_positions" ADD CONSTRAINT "helper_signup_positions_slot_id_fkey" FOREIGN KEY ("slot_id") REFERENCES "signup_slots"("id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "signup_logs" ADD CONSTRAINT "signup_logs_slot_id_fkey" FOREIGN KEY ("slot_id") REFERENCES "signup_slots"("id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "signup_logs" ADD CONSTRAINT "signup_logs_event_supporter_id_fkey" FOREIGN KEY ("event_supporter_id") REFERENCES "event_supporters"("id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "notification_deliveries" ADD CONSTRAINT "notification_deliveries_event_supporter_id_fkey" FOREIGN KEY ("event_supporter_id") REFERENCES "event_supporters"("id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- ---------------------------------------------------------------------------
-- CHECK constraints. Row-local only.
--
-- The cross-table rule -- a SHIFT commitment holds exactly one position --
-- CANNOT live here: it reads slot_type from another table, the same limit that
-- killed the original partial-index design. src/lib/signups.ts is its sole
-- enforcement point.
-- ---------------------------------------------------------------------------

-- Capacity is a count of real openings.
ALTER TABLE "signup_slots" ADD CONSTRAINT "signup_slots_capacity_positive"
  CHECK (capacity >= 1);

-- A SHIFT requires a start. A shift with no start time is really a role or an
-- item, and allowing it collapses the distinction the two slot types exist to
-- draw.
ALTER TABLE "signup_slots" ADD CONSTRAINT "signup_slots_shift_needs_start"
  CHECK (slot_type = 'ITEM' OR starts_at IS NOT NULL);

-- An ITEM has no times at all.
ALTER TABLE "signup_slots" ADD CONSTRAINT "signup_slots_item_has_no_times"
  CHECK (slot_type <> 'ITEM' OR (starts_at IS NULL AND ends_at IS NULL));

-- End is OPTIONAL -- "Cleanup after the game" ends when the lot is clear, and
-- forcing a host to invent a time produces a number a helper plans around that
-- was never true. But a backwards range is a typo.
ALTER TABLE "signup_slots" ADD CONSTRAINT "signup_slots_end_after_start"
  CHECK (ends_at IS NULL OR ends_at > starts_at);

-- unitLabel names the thing being brought, so it belongs only to ITEM.
ALTER TABLE "signup_slots" ADD CONSTRAINT "signup_slots_unit_label_item_only"
  CHECK (unit_label IS NULL OR slot_type = 'ITEM');

-- Positions are 1..capacity; the upper bound is cross-table and lives in code.
ALTER TABLE "helper_signup_positions" ADD CONSTRAINT "helper_signup_positions_position_positive"
  CHECK (position >= 1);

-- ---------------------------------------------------------------------------
-- Containment. LAST, and in this same transaction -- see the header.
-- ---------------------------------------------------------------------------

ALTER TABLE public."signup_sheets"            ENABLE ROW LEVEL SECURITY;
ALTER TABLE public."signup_slots"             ENABLE ROW LEVEL SECURITY;
ALTER TABLE public."helper_signups"           ENABLE ROW LEVEL SECURITY;
ALTER TABLE public."helper_signup_positions"  ENABLE ROW LEVEL SECURITY;
ALTER TABLE public."signup_logs"              ENABLE ROW LEVEL SECURITY;
ALTER TABLE public."notification_deliveries"  ENABLE ROW LEVEL SECURITY;

-- Zero client policies, deliberately. Nothing authenticates as anon or
-- authenticated against these tables; every read is server-side through Prisma.
REVOKE ALL ON ALL TABLES    IN SCHEMA public FROM PUBLIC, anon, authenticated;
REVOKE ALL ON ALL SEQUENCES IN SCHEMA public FROM PUBLIC, anon, authenticated;

GRANT ALL ON ALL TABLES    IN SCHEMA public TO service_role;
GRANT ALL ON ALL SEQUENCES IN SCHEMA public TO service_role;
