-- 0_init - baseline of the Daali production schema.
--
-- BUILT FROM THE PHYSICAL CATALOG, NOT FROM schema.prisma.
-- Generated with `prisma migrate diff --from-empty --to-schema-datasource`,
-- then hand-extended. The generator alone is NOT sufficient: against Prisma
-- 6.19.2 it emitted 36 of production's 40 indexes and none of the security
-- configuration. What it silently omitted:
--
--   * all four PARTIAL indexes (verified: 0 occurrences of WHERE in its output)
--   * ENABLE ROW LEVEL SECURITY on every table
--   * REVOKE of PUBLIC / anon / authenticated
--   * corrected `postgres` default privileges
--   * the service_role grants the application needs
--
-- A baseline built from the generator alone replays into a database that is
-- MISSING FOUR INDEXES AND FULLY EXPOSED over the Data API. That is the reason
-- for every hand-written section below.
--
-- VERSION-SCOPED CLAIM. Prisma 6.19.2 cannot represent partial indexes: it
-- neither introspects nor emits an index predicate, so a partial index is
-- invisible to `migrate diff` - never created, never dropped. This is a
-- property of THIS PINNED VERSION, not of Prisma generally. Partial-index
-- support arrived behind the `partialIndexes` preview flag in 7.4 and expanded
-- in 8.x. On any upgrade, re-evaluate section 4 and the residue note in
-- PHASE-2-BACKLOG.md. No upgrade is part of this work.
--
-- ORDERING IS A SECURITY PROPERTY, NOT A STYLE CHOICE.
-- Section 2 revokes the default privileges BEFORE section 3 creates any table.
-- Reversing them would leave every table anonymously writable for the width of
-- the transaction. See SECURITY-INCIDENT-2026-08-30.md for why that matters.
--
-- PROVENANCE. The ten hand-applied files live at repo-root `migrations/`,
-- OUTSIDE this directory, and are historical record - not a replay chain.
-- Prisma reads only `prisma/migrations/`, so their LOCATION is what keeps them
-- out of the chain. A header comment would not; only the directory does.
--
-- NOT INCLUDED, DELIBERATELY: the supabase_admin default-privilege repair. It
-- cannot execute as `postgres` and is preserved as
-- `migrations/secure_data_api_supabase_admin_defaults.sql.pending`.

-- ===========================================================================
-- 1. Roles. Supabase provides these; a bare Postgres does not. Guarded so the
--    file is identical in both environments.
-- ===========================================================================
DO $do$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
    CREATE ROLE anon NOLOGIN NOINHERIT;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
    CREATE ROLE authenticated NOLOGIN NOINHERIT;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN
    CREATE ROLE service_role NOLOGIN NOINHERIT BYPASSRLS;
  END IF;
END
$do$;

-- ===========================================================================
-- 2. Default privileges - BEFORE any CREATE TABLE.
--    On Supabase these grant anon/authenticated full DML on every new table
--    automatically. Revoking first means no table is ever created exposed.
-- ===========================================================================
ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public
  REVOKE ALL ON TABLES FROM anon, authenticated;
ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public
  REVOKE ALL ON SEQUENCES FROM anon, authenticated;
-- Unqualified: the global PUBLIC EXECUTE default is not schema-scoped and a
-- revoke naming a schema cannot cancel it.
ALTER DEFAULT PRIVILEGES FOR ROLE postgres
  REVOKE EXECUTE ON FUNCTIONS FROM PUBLIC;
ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public
  REVOKE EXECUTE ON FUNCTIONS FROM anon, authenticated;

-- ===========================================================================
-- 3. Enums, tables, columns, constraints, FK actions, physical names.
--    Verbatim from the catalog generator.
-- ===========================================================================
-- CreateSchema
CREATE SCHEMA IF NOT EXISTS "public";

-- CreateEnum
CREATE TYPE "public"."BoardStatus" AS ENUM ('open', 'closed', 'pending_payment', 'expired', 'closing');

-- CreateEnum
CREATE TYPE "public"."GridType" AS ENUM ('standard', 'double');

-- CreateEnum
CREATE TYPE "public"."PaymentMethod" AS ENUM ('stripe', 'cash');

-- CreateEnum
CREATE TYPE "public"."PaymentStatus" AS ENUM ('open', 'pending', 'reserved_cash', 'paid', 'failed', 'expired');

-- CreateEnum
CREATE TYPE "public"."PayoutVisibility" AS ENUM ('public', 'pin_gated');

-- CreateEnum
CREATE TYPE "public"."PeriodType" AS ENUM ('halves', 'quarters');

-- CreateEnum
CREATE TYPE "public"."PlayerPayoutMethod" AS ENUM ('venmo', 'zelle', 'cashapp', 'paypal', 'cash');

-- CreateEnum
CREATE TYPE "public"."ReleaseReason" AS ENUM ('expired', 'failed', 'manual');

-- CreateEnum
CREATE TYPE "public"."SportType" AS ENUM ('cbb', 'nba', 'nfl');

-- CreateEnum
CREATE TYPE "public"."admission_grant_source" AS ENUM ('FUNDRAISER', 'STANDALONE', 'GATE_ALLOWANCE', 'HOST_APPROVED');

-- CreateEnum
CREATE TYPE "public"."admission_pass_status" AS ENUM ('active', 'used', 'void');

-- CreateEnum
CREATE TYPE "public"."board_type" AS ENUM ('game', 'fundraiser');

-- CreateEnum
CREATE TYPE "public"."check_in_action" AS ENUM ('check_in', 'undo');

-- CreateEnum
CREATE TYPE "public"."credit_tx_type" AS ENUM ('signup_grant', 'purchase', 'admin_grant', 'board_created');

-- CreateEnum
CREATE TYPE "public"."draw_trigger" AS ENUM ('date', 'when_full');

-- CreateEnum
CREATE TYPE "public"."supporter_status" AS ENUM ('pending', 'active');

-- CreateTable
CREATE TABLE "public"."admission_grants" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "event_id" UUID NOT NULL,
    "event_supporter_id" UUID NOT NULL,
    "square_batch_id" TEXT,
    "source" "public"."admission_grant_source" NOT NULL DEFAULT 'FUNDRAISER',
    "declared_at_purchase" INTEGER,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "donate_admissions" BOOLEAN NOT NULL DEFAULT false,

    CONSTRAINT "admission_grants_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."admission_passes" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "event_supporter_id" UUID NOT NULL,
    "sequence_number" INTEGER NOT NULL,
    "token" TEXT NOT NULL,
    "label" TEXT,
    "status" "public"."admission_pass_status" NOT NULL DEFAULT 'active',
    "checked_in_at" TIMESTAMPTZ(6),
    "checked_in_by_volunteer_access_id" UUID,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "square_id" UUID,

    CONSTRAINT "admission_passes_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."attendance_access_tokens" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "event_supporter_id" UUID NOT NULL,
    "token_hash" TEXT NOT NULL,
    "expires_at" TIMESTAMPTZ(6) NOT NULL,
    "used_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "attendance_access_tokens_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."boards" (
    "board_id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "host_id" UUID NOT NULL,
    "game_name" TEXT NOT NULL,
    "square_price" INTEGER NOT NULL,
    "total_squares" INTEGER NOT NULL DEFAULT 100,
    "status" "public"."BoardStatus" NOT NULL DEFAULT 'open',
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "slug" TEXT NOT NULL,
    "row_numbers" INTEGER[] DEFAULT ARRAY[]::INTEGER[],
    "col_numbers" INTEGER[] DEFAULT ARRAY[]::INTEGER[],
    "payout_structure" JSONB,
    "max_squares_per_player" INTEGER NOT NULL DEFAULT 10,
    "board_close_time" TIMESTAMPTZ(6),
    "host_payout_responsible" BOOLEAN NOT NULL DEFAULT true,
    "currency" TEXT NOT NULL DEFAULT 'USD',
    "team_row" TEXT,
    "team_col" TEXT,
    "period_type" "public"."PeriodType" NOT NULL DEFAULT 'halves',
    "period_labels" TEXT[] DEFAULT ARRAY['H1', 'Final']::TEXT[],
    "scores_team_a" INTEGER[],
    "scores_team_b" INTEGER[],
    "host_cut_percent" INTEGER NOT NULL DEFAULT 0,
    "cash_mode_enabled" BOOLEAN NOT NULL DEFAULT false,
    "cash_pin" TEXT,
    "cash_reservation_ttl_mins" INTEGER NOT NULL DEFAULT 20,
    "cash_liability_accepted" BOOLEAN NOT NULL DEFAULT false,
    "scores" JSONB,
    "pending_expires_at" TIMESTAMPTZ(6),
    "expired_at" TIMESTAMPTZ(6),
    "activated_at" TIMESTAMPTZ(6),
    "hidden_from_host" BOOLEAN NOT NULL DEFAULT false,
    "host_venmo" TEXT,
    "host_zelle" TEXT,
    "host_cashapp" TEXT,
    "payout_visibility" "public"."PayoutVisibility" NOT NULL DEFAULT 'public',
    "require_player_payout" BOOLEAN NOT NULL DEFAULT false,
    "winner_notified_by_period" JSONB NOT NULL DEFAULT '{}',
    "host_paypal" TEXT,
    "sport_type" "public"."SportType" NOT NULL DEFAULT 'cbb',
    "grid_type" "public"."GridType" NOT NULL DEFAULT 'standard',
    "row_pairs" JSONB,
    "col_pairs" JSONB,
    "board_type" "public"."board_type" NOT NULL DEFAULT 'game',
    "cause_description" TEXT,
    "prize_pool_percent" INTEGER NOT NULL DEFAULT 0,
    "prize_tier_count" INTEGER NOT NULL DEFAULT 4,
    "draw_trigger" "public"."draw_trigger",
    "draw_date" TIMESTAMPTZ(6),
    "timezone" TEXT,
    "cash_hold_days" INTEGER NOT NULL DEFAULT 7,
    "final_raised_cents" INTEGER,
    "final_prize_pool_cents" INTEGER,
    "drawn_at" TIMESTAMPTZ(6),
    "draw_results" JSONB,
    "title_history" JSONB,
    "campaign_ends_at" TIMESTAMPTZ(6),
    "early_bird_price_cents" INTEGER,
    "early_bird_ends_at" TIMESTAMPTZ(6),
    "fundraising_goal_cents" INTEGER,

    CONSTRAINT "boards_pkey" PRIMARY KEY ("board_id")
);

-- CreateTable
CREATE TABLE "public"."check_in_logs" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "pass_id" UUID NOT NULL,
    "event_id" UUID NOT NULL,
    "action" "public"."check_in_action" NOT NULL,
    "at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "by_volunteer_access_id" UUID NOT NULL,

    CONSTRAINT "check_in_logs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."credit_transactions" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "host_id" UUID NOT NULL,
    "type" "public"."credit_tx_type" NOT NULL,
    "amount" INTEGER NOT NULL,
    "balance_after" INTEGER NOT NULL,
    "stripe_session_id" TEXT,
    "note" TEXT,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "board_id" UUID,

    CONSTRAINT "credit_transactions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."event_supporters" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "event_id" UUID NOT NULL,
    "identity_key" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "phone" TEXT,
    "declared_count" INTEGER NOT NULL DEFAULT 0,
    "pass_sequence_cursor" INTEGER NOT NULL DEFAULT 0,
    "status" "public"."supporter_status" NOT NULL DEFAULT 'pending',
    "activated_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "event_supporters_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."events" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "board_id" UUID NOT NULL,
    "name" TEXT,
    "starts_at" TIMESTAMPTZ(6) NOT NULL,
    "ends_at" TIMESTAMPTZ(6),
    "timezone" TEXT NOT NULL,
    "venue" TEXT,
    "max_attendees_per_supporter" INTEGER,
    "gate_allowance_total" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "events_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."free_entries" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "board_id" UUID NOT NULL,
    "sequence_number" INTEGER NOT NULL,
    "name" TEXT NOT NULL,
    "phone" TEXT NOT NULL,
    "verified_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "free_entries_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."hbcu_orgs" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "org_name" TEXT NOT NULL,
    "school" TEXT NOT NULL,
    "city" TEXT NOT NULL,
    "fund_purpose" TEXT,
    "contact_name" TEXT NOT NULL,
    "contact_email" TEXT NOT NULL,
    "logo_url" TEXT,
    "status" TEXT DEFAULT 'pending',
    "created_at" TIMESTAMPTZ(6) DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "hbcu_orgs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."hosts" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "name" TEXT,
    "email" TEXT,
    "stripe_account_id" TEXT,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "supabase_user_id" TEXT,
    "stripe_charges_enabled" BOOLEAN DEFAULT false,
    "stripe_payouts_enabled" BOOLEAN DEFAULT false,
    "board_credits" INTEGER NOT NULL DEFAULT 2,
    "payment_preference" TEXT,

    CONSTRAINT "hosts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."invite_codes" (
    "code" TEXT NOT NULL,
    "email" TEXT,
    "claimed_by" UUID,
    "claimed_at" TIMESTAMPTZ(6),
    "expires_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "invite_codes_pkey" PRIMARY KEY ("code")
);

-- CreateTable
CREATE TABLE "public"."payment_references" (
    "payment_id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "square_id" UUID NOT NULL,
    "stripe_session_id" TEXT,
    "amount" INTEGER NOT NULL,
    "timestamp" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "method" "public"."PaymentMethod" NOT NULL DEFAULT 'stripe',

    CONSTRAINT "payment_references_pkey" PRIMARY KEY ("payment_id")
);

-- CreateTable
CREATE TABLE "public"."squares" (
    "square_id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "board_id" UUID NOT NULL,
    "position" INTEGER NOT NULL,
    "player_name" TEXT,
    "player_email" TEXT,
    "payment_status" "public"."PaymentStatus" NOT NULL DEFAULT 'open',
    "stripe_payment_id" TEXT,
    "checkout_expires_at" TIMESTAMPTZ(6),
    "release_reason" "public"."ReleaseReason",
    "reserved_by_host" BOOLEAN DEFAULT false,
    "payment_method" "public"."PaymentMethod" NOT NULL DEFAULT 'stripe',
    "player_phone" TEXT,
    "player_payout_method" "public"."PlayerPayoutMethod",
    "player_payout_handle" TEXT,
    "sms_opt_in" BOOLEAN NOT NULL DEFAULT false,
    "hold_expires_at" TIMESTAMPTZ(6),
    "checkout_session_id" TEXT,
    "batch_id" TEXT,
    "is_host_entry" BOOLEAN NOT NULL DEFAULT false,
    "price_paid_cents" INTEGER,
    "claimed_at" TIMESTAMPTZ(6),
    "confirmation_emailed_at" TIMESTAMPTZ(6),

    CONSTRAINT "squares_pkey" PRIMARY KEY ("square_id")
);

-- CreateTable
CREATE TABLE "public"."volunteer_access" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "event_id" UUID NOT NULL,
    "label" TEXT NOT NULL,
    "token_hash" TEXT NOT NULL,
    "revoked_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "volunteer_access_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "admission_grants_square_batch_key" ON "public"."admission_grants"("square_batch_id" ASC);

-- CreateIndex
CREATE INDEX "idx_admission_grants_supporter" ON "public"."admission_grants"("event_supporter_id" ASC);

-- CreateIndex
CREATE UNIQUE INDEX "admission_passes_supporter_sequence_key" ON "public"."admission_passes"("event_supporter_id" ASC, "sequence_number" ASC);

-- CreateIndex
CREATE UNIQUE INDEX "admission_passes_token_key" ON "public"."admission_passes"("token" ASC);

-- CreateIndex
CREATE INDEX "idx_admission_passes_square" ON "public"."admission_passes"("square_id" ASC);

-- CreateIndex
CREATE INDEX "idx_attendance_tokens_supporter" ON "public"."attendance_access_tokens"("event_supporter_id" ASC);

-- CreateIndex
CREATE UNIQUE INDEX "boards_slug_key" ON "public"."boards"("slug" ASC);

-- CreateIndex
CREATE INDEX "idx_check_in_logs_event_at" ON "public"."check_in_logs"("event_id" ASC, "at" ASC);

-- CreateIndex
CREATE INDEX "idx_check_in_logs_pass" ON "public"."check_in_logs"("pass_id" ASC);

-- CreateIndex
CREATE INDEX "idx_credit_tx_host_created" ON "public"."credit_transactions"("host_id" ASC, "created_at" ASC);

-- CreateIndex
CREATE UNIQUE INDEX "event_supporters_event_identity_key" ON "public"."event_supporters"("event_id" ASC, "identity_key" ASC);

-- CreateIndex
CREATE UNIQUE INDEX "events_board_id_key" ON "public"."events"("board_id" ASC);

-- CreateIndex
CREATE UNIQUE INDEX "free_entries_board_sequence_key" ON "public"."free_entries"("board_id" ASC, "sequence_number" ASC);

-- CreateIndex
CREATE UNIQUE INDEX "hosts_supabase_user_id_key" ON "public"."hosts"("supabase_user_id" ASC);

-- CreateIndex
CREATE UNIQUE INDEX "payment_references_square_id_key" ON "public"."payment_references"("square_id" ASC);

-- CreateIndex
CREATE UNIQUE INDEX "payment_references_stripe_session_id_key" ON "public"."payment_references"("stripe_session_id" ASC);

-- CreateIndex
CREATE INDEX "idx_squares_batch" ON "public"."squares"("batch_id" ASC);

-- CreateIndex
CREATE INDEX "idx_squares_board_email" ON "public"."squares"("board_id" ASC, "player_email" ASC);

-- CreateIndex
CREATE INDEX "idx_squares_claimed_at" ON "public"."squares"("board_id" ASC, "claimed_at" ASC);

-- CreateIndex
CREATE UNIQUE INDEX "squares_board_id_position_key" ON "public"."squares"("board_id" ASC, "position" ASC);

-- CreateIndex
CREATE INDEX "idx_volunteer_access_event" ON "public"."volunteer_access"("event_id" ASC);

-- AddForeignKey
ALTER TABLE "public"."admission_grants" ADD CONSTRAINT "admission_grants_event_id_fkey" FOREIGN KEY ("event_id") REFERENCES "public"."events"("id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "public"."admission_grants" ADD CONSTRAINT "admission_grants_event_supporter_id_fkey" FOREIGN KEY ("event_supporter_id") REFERENCES "public"."event_supporters"("id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "public"."admission_passes" ADD CONSTRAINT "admission_passes_checked_in_by_volunteer_access_id_fkey" FOREIGN KEY ("checked_in_by_volunteer_access_id") REFERENCES "public"."volunteer_access"("id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "public"."admission_passes" ADD CONSTRAINT "admission_passes_event_supporter_id_fkey" FOREIGN KEY ("event_supporter_id") REFERENCES "public"."event_supporters"("id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "public"."admission_passes" ADD CONSTRAINT "admission_passes_square_id_fkey" FOREIGN KEY ("square_id") REFERENCES "public"."squares"("square_id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "public"."attendance_access_tokens" ADD CONSTRAINT "attendance_access_tokens_event_supporter_id_fkey" FOREIGN KEY ("event_supporter_id") REFERENCES "public"."event_supporters"("id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "public"."boards" ADD CONSTRAINT "boards_host_id_fkey" FOREIGN KEY ("host_id") REFERENCES "public"."hosts"("id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "public"."check_in_logs" ADD CONSTRAINT "check_in_logs_by_volunteer_access_id_fkey" FOREIGN KEY ("by_volunteer_access_id") REFERENCES "public"."volunteer_access"("id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "public"."check_in_logs" ADD CONSTRAINT "check_in_logs_event_id_fkey" FOREIGN KEY ("event_id") REFERENCES "public"."events"("id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "public"."check_in_logs" ADD CONSTRAINT "check_in_logs_pass_id_fkey" FOREIGN KEY ("pass_id") REFERENCES "public"."admission_passes"("id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "public"."credit_transactions" ADD CONSTRAINT "credit_transactions_board_id_fkey" FOREIGN KEY ("board_id") REFERENCES "public"."boards"("board_id") ON DELETE SET NULL ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "public"."credit_transactions" ADD CONSTRAINT "credit_transactions_host_id_fkey" FOREIGN KEY ("host_id") REFERENCES "public"."hosts"("id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "public"."event_supporters" ADD CONSTRAINT "event_supporters_event_id_fkey" FOREIGN KEY ("event_id") REFERENCES "public"."events"("id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "public"."events" ADD CONSTRAINT "events_board_id_fkey" FOREIGN KEY ("board_id") REFERENCES "public"."boards"("board_id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "public"."free_entries" ADD CONSTRAINT "free_entries_board_id_fkey" FOREIGN KEY ("board_id") REFERENCES "public"."boards"("board_id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "public"."invite_codes" ADD CONSTRAINT "invite_codes_claimed_by_fkey" FOREIGN KEY ("claimed_by") REFERENCES "public"."hosts"("id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "public"."payment_references" ADD CONSTRAINT "payment_references_square_id_fkey" FOREIGN KEY ("square_id") REFERENCES "public"."squares"("square_id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "public"."squares" ADD CONSTRAINT "squares_board_id_fkey" FOREIGN KEY ("board_id") REFERENCES "public"."boards"("board_id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "public"."volunteer_access" ADD CONSTRAINT "volunteer_access_event_id_fkey" FOREIGN KEY ("event_id") REFERENCES "public"."events"("id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- ===========================================================================
-- 4. PARTIAL INDEXES - hand-written. Prisma 6.19.2 emitted NONE of these.
--    Predicates copied from pg_get_indexdef() in production. Never rebuild any
--    of these without its WHERE clause: doing so collides on the name and
--    silently widens the index.
-- ===========================================================================

-- Drives the confirmation-email sweep. NOT declared in schema.prisma and
-- invisible to migrate diff, so nothing but this file will ever recreate it.
CREATE INDEX "idx_squares_unmailed" ON public.squares USING btree (board_id)
  WHERE ((payment_status = 'paid'::"PaymentStatus") AND (confirmation_emailed_at IS NULL));

-- These two ARE declared in schema.prisma (as plain @@index with a map), which
-- is why migrate diff proposes creating them unqualified forever. That diff
-- output is documented residue; these are the real definitions.
CREATE INDEX "idx_boards_pending_expiry" ON public.boards USING btree (pending_expires_at)
  WHERE (status = 'pending_payment'::"BoardStatus");
CREATE INDEX "idx_boards_expired_cleanup" ON public.boards USING btree (expired_at)
  WHERE (status = 'expired'::"BoardStatus");

-- Partial UNIQUE: uniqueness applies only to non-null session ids.
CREATE UNIQUE INDEX "credit_transactions_stripe_session_id_key"
  ON public.credit_transactions USING btree (stripe_session_id)
  WHERE (stripe_session_id IS NOT NULL);

-- ===========================================================================
-- 5. Row level security. Zero policies is deliberate - nothing legitimate
--    authenticates as anon or authenticated against these tables.
-- ===========================================================================
ALTER TABLE public."boards" ENABLE ROW LEVEL SECURITY;
ALTER TABLE public."credit_transactions" ENABLE ROW LEVEL SECURITY;
ALTER TABLE public."hbcu_orgs" ENABLE ROW LEVEL SECURITY;
ALTER TABLE public."hosts" ENABLE ROW LEVEL SECURITY;
ALTER TABLE public."invite_codes" ENABLE ROW LEVEL SECURITY;
ALTER TABLE public."payment_references" ENABLE ROW LEVEL SECURITY;
ALTER TABLE public."squares" ENABLE ROW LEVEL SECURITY;
ALTER TABLE public."admission_grants" ENABLE ROW LEVEL SECURITY;
ALTER TABLE public."admission_passes" ENABLE ROW LEVEL SECURITY;
ALTER TABLE public."attendance_access_tokens" ENABLE ROW LEVEL SECURITY;
ALTER TABLE public."check_in_logs" ENABLE ROW LEVEL SECURITY;
ALTER TABLE public."event_supporters" ENABLE ROW LEVEL SECURITY;
ALTER TABLE public."events" ENABLE ROW LEVEL SECURITY;
ALTER TABLE public."free_entries" ENABLE ROW LEVEL SECURITY;
ALTER TABLE public."volunteer_access" ENABLE ROW LEVEL SECURITY;

-- ===========================================================================
-- 6. Grants. RLS must not be the only barrier.
-- ===========================================================================
REVOKE ALL ON ALL TABLES    IN SCHEMA public FROM PUBLIC, anon, authenticated;
REVOKE ALL ON ALL SEQUENCES IN SCHEMA public FROM PUBLIC, anon, authenticated;

-- service_role is the only role the application uses against PostgREST, in
-- src/app/api/hbcu/onboard/route.ts. On Supabase the platform default already
-- grants it; on a fresh database section 2 left it with nothing, so grant it
-- explicitly and let the replay prove it rather than inherit it.
GRANT USAGE ON SCHEMA public TO anon, authenticated, service_role;
GRANT ALL ON ALL TABLES    IN SCHEMA public TO service_role;
GRANT ALL ON ALL SEQUENCES IN SCHEMA public TO service_role;
