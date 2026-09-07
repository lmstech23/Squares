-- Direct-payment Entry Ticket reservations, and the post-close money stamp.
--
-- Two features in one migration because they ship as one unit: a reservation
-- confirmed by a host after close is exactly the money `post_close_at` exists
-- to mark, and splitting them would put half the model in production without
-- the half that makes it safe.
--
-- ADDITIVE ONLY. Two new tables, two new enums, one new nullable column.
-- Nothing existing is dropped, altered or backfilled, and no current code path
-- reads any of it.

-- ------------------------------------------------------------------ enums --
CREATE TYPE "payment_rail" AS ENUM ('zelle', 'cashapp', 'venmo', 'paypal');
CREATE TYPE "entry_reservation_status" AS ENUM ('pending', 'resolved', 'released');

-- ----------------------------------------------------- post-close money ----
--
-- RULING 5. Stripe can capture a payment after the board sealed its total.
-- Refusing it would leave the buyer charged and the platform pretending
-- otherwise, so the contribution is recorded and its passes minted normally;
-- this stamp says the money sits OUTSIDE the published figure.
--
-- `final_raised_cents` is write-once and is deliberately NOT amended. Moving a
-- number contributors have already read is worse than showing the host a
-- separate one.
ALTER TABLE "contributions"
  ADD COLUMN "post_close_at" TIMESTAMPTZ;

-- ------------------------------------------------------------ the header ---
CREATE TABLE "entry_reservations" (
  "id"                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  "board_id"          UUID NOT NULL REFERENCES "boards"("board_id") ON DELETE RESTRICT,
  "event_id"          UUID NOT NULL REFERENCES "events"("id")       ON DELETE RESTRICT,
  "reference_code"    TEXT NOT NULL,
  "contributor_name"  TEXT NOT NULL,
  "contributor_email" TEXT NOT NULL,
  "contributor_phone" TEXT NOT NULL,
  "payment_rail"      "payment_rail" NOT NULL,
  "status"            "entry_reservation_status" NOT NULL DEFAULT 'pending',
  "created_at"        TIMESTAMPTZ NOT NULL DEFAULT now(),
  "resolved_at"       TIMESTAMPTZ,
  "released_at"       TIMESTAMPTZ,
  "release_reason"    TEXT
);

-- UNIQUE PER BOARD, which is the scope a host searches in and what keeps the
-- code short enough to type into a memo field.
CREATE UNIQUE INDEX "entry_reservations_board_code_key"
  ON "entry_reservations" ("board_id", "reference_code");

-- The close guard's query: pending reservations on one board.
CREATE INDEX "idx_entry_reservations_board_status"
  ON "entry_reservations" ("board_id", "status");

-- Five characters, Crockford base32 - the alphabet excludes I, L, O and U so a
-- handwritten code cannot be misread as 1, 0 or a word.
ALTER TABLE "entry_reservations" ADD CONSTRAINT "entry_reservations_code_shape"
  CHECK ("reference_code" ~ '^[0-9A-HJKMNP-TV-Z]{5}$');

-- Both identity keys are mandatory on every entry purchase path; a reservation
-- the host cannot contact is one they cannot reconcile.
ALTER TABLE "entry_reservations" ADD CONSTRAINT "entry_reservations_identity_present"
  CHECK (length(btrim("contributor_email")) > 0 AND length(btrim("contributor_phone")) > 0);

-- A released reservation records WHEN. A pending one has neither timestamp.
-- `resolved` may carry either or both: it means every line was dispositioned,
-- not that every line was paid.
ALTER TABLE "entry_reservations" ADD CONSTRAINT "entry_reservations_released_has_time"
  CHECK (("status" <> 'released') OR "released_at" IS NOT NULL);
ALTER TABLE "entry_reservations" ADD CONSTRAINT "entry_reservations_pending_is_open"
  CHECK (("status" <> 'pending') OR ("released_at" IS NULL AND "resolved_at" IS NULL));

-- ------------------------------------------------------------- the lines ---
CREATE TABLE "entry_reservation_lines" (
  "id"                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  "reservation_id"     UUID NOT NULL REFERENCES "entry_reservations"("id") ON DELETE RESTRICT,
  "tier"               "pass_tier" NOT NULL,
  "price_basis"        "pass_price_basis" NOT NULL,
  "unit_price_cents"   INTEGER NOT NULL,
  "quantity"           INTEGER NOT NULL,
  "quantity_confirmed" INTEGER NOT NULL DEFAULT 0,
  "contribution_id"    UUID REFERENCES "contributions"("id") ON DELETE RESTRICT
);

-- One line per tier and basis. Two lines for the same adult early price on one
-- reservation is a bug, not a quantity.
CREATE UNIQUE INDEX "entry_reservation_lines_unique_tier"
  ON "entry_reservation_lines" ("reservation_id", "tier", "price_basis");

-- No separate index on reservation_id: the composite unique above leads with
-- it, and Postgres uses a leading column on its own. A second index would be
-- write cost for a read the first one already serves.

ALTER TABLE "entry_reservation_lines" ADD CONSTRAINT "entry_reservation_lines_quantity_positive"
  CHECK ("quantity" > 0);

-- PARTIAL PAYMENT IS EXPRESSIBLE, OVERPAYMENT IS NOT. The whole point of the
-- line as the resolution unit is that some of it can be paid; none of it may
-- be paid twice.
ALTER TABLE "entry_reservation_lines" ADD CONSTRAINT "entry_reservation_lines_confirmed_in_range"
  CHECK ("quantity_confirmed" >= 0 AND "quantity_confirmed" <= "quantity");

-- The $1 floor the edit surface applies; the price is locked at reservation.
ALTER TABLE "entry_reservation_lines" ADD CONSTRAINT "entry_reservation_lines_price_positive"
  CHECK ("unit_price_cents" >= 100);

-- MONEY WITHOUT A LEDGER ROW IS THE FAILURE THIS PREVENTS. A confirmed
-- quantity means a Contribution was created for it; a line claiming payment
-- with no contribution_id is money nothing can account for.
ALTER TABLE "entry_reservation_lines" ADD CONSTRAINT "entry_reservation_lines_paid_has_contribution"
  CHECK ("quantity_confirmed" = 0 OR "contribution_id" IS NOT NULL);

-- ------------------------------------------------------------------ gate ---
--
-- Same transaction as everything above. These tables are new and therefore
-- empty, so the assertions below are about the ENVIRONMENT rather than the
-- data: they prove the types and columns this model depends on actually exist,
-- rather than discovering it at the first insert.
DO $$
DECLARE
  missing_enum  INTEGER;
  missing_col   INTEGER;
  stray_rows    INTEGER;
BEGIN
  -- pass_tier and pass_price_basis came with the standalone Entry Ticket
  -- migration. The lines table reuses them rather than declaring a parallel
  -- set that could drift.
  SELECT count(*) INTO missing_enum
    FROM (VALUES ('pass_tier'), ('pass_price_basis'), ('payment_rail'),
                 ('entry_reservation_status')) AS want(t)
   WHERE NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = want.t);
  IF missing_enum > 0 THEN
    RAISE EXCEPTION 'entry reservations aborted: % required enum type(s) absent', missing_enum;
  END IF;

  SELECT count(*) INTO missing_col
    FROM (VALUES ('contributions', 'post_close_at'),
                 ('contributions', 'entry_amount_cents')) AS want(t, c)
   WHERE NOT EXISTS (
     SELECT 1 FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = want.t AND column_name = want.c
   );
  IF missing_col > 0 THEN
    RAISE EXCEPTION 'entry reservations aborted: % required column(s) absent', missing_col;
  END IF;

  -- Both tables are created in this transaction, so anything in them is a
  -- name collision with something that was already there.
  SELECT (SELECT count(*) FROM entry_reservations)
       + (SELECT count(*) FROM entry_reservation_lines) INTO stray_rows;
  IF stray_rows > 0 THEN
    RAISE EXCEPTION 'entry reservations aborted: % row(s) in tables this migration just created', stray_rows;
  END IF;
END $$;
