-- Standalone Entry Tickets — an OPTIONAL platform capability.
--
-- A fundraiser may be donation-only, square-based, event-ticketed, or any
-- combination. Every column added here is nullable or defaulted, and NULL means
-- "this board does not offer that". A donation-only or square-only fundraiser
-- is unaffected by all of it.
--
-- NO PLATFORM DEFAULTS. The Hampton prices are Hampton board data and appear
-- nowhere in this file.
--
-- ENTRY REVENUE IS AUTHORITATIVE AT THE CONTRIBUTION - see
-- invariant-registry.md. NOTE what this migration deliberately does NOT add:
-- no trigger enforcing immutability after confirmation. That rule is an
-- application convention held by code paths and tests, and the invariant says
-- so rather than implying a guard the database does not have.
--
-- THE MONEY SEPARATION IS STRUCTURAL. entry_amount_cents reaches `raised`
-- through total_paid_cents and can never reach prize_basis_cents, which is
-- derived from square_amount_cents — a different column.

-- ---------------------------------------------------------------- enums ----
CREATE TYPE "pass_tier"        AS ENUM ('CHILD', 'ADULT');
CREATE TYPE "pass_price_basis" AS ENUM ('FLAT', 'EARLY', 'REGULAR');

-- -------------------------------------------------------------- columns ----
ALTER TABLE "contributions"
  ADD COLUMN "entry_amount_cents" INTEGER NOT NULL DEFAULT 0;

ALTER TABLE "admission_passes"
  ADD COLUMN "tier"             "pass_tier",
  ADD COLUMN "price_basis"      "pass_price_basis",
  ADD COLUMN "price_paid_cents" INTEGER;

ALTER TABLE "boards"
  ADD COLUMN "entry_child_price_cents"         INTEGER,
  ADD COLUMN "entry_adult_early_price_cents"   INTEGER,
  ADD COLUMN "entry_adult_regular_price_cents" INTEGER;

-- -------------------------------------- the three contribution CHECKs ------
--
-- ALL THREE, not just the sum. An entry-only contribution has square = 0 and
-- donation = 0, so the existing `amount_positive` constraint would REJECT IT
-- OUTRIGHT. Replacing only the sum would ship a feature whose every purchase
-- fails at the database.
--
-- Validating, never NOT VALID, in this transaction with the gate below.

ALTER TABLE "contributions" DROP CONSTRAINT "contributions_total_is_sum";
ALTER TABLE "contributions" ADD  CONSTRAINT "contributions_total_is_sum"
  CHECK (total_paid_cents = square_amount_cents + donation_amount_cents + entry_amount_cents);

ALTER TABLE "contributions" DROP CONSTRAINT "contributions_amounts_non_negative";
ALTER TABLE "contributions" ADD  CONSTRAINT "contributions_amounts_non_negative"
  CHECK (square_amount_cents >= 0 AND donation_amount_cents >= 0 AND entry_amount_cents >= 0);

ALTER TABLE "contributions" DROP CONSTRAINT "contributions_amount_positive";
ALTER TABLE "contributions" ADD  CONSTRAINT "contributions_amount_positive"
  CHECK (square_amount_cents > 0 OR donation_amount_cents > 0 OR entry_amount_cents > 0);

-- ------------------------------------------------ pass pricing coherence ---
--
-- All three or none. NOT keyed to square_id: the model must keep allowing a
-- future priceless pass that also has no square, and a square_id-based rule
-- would close that door by accident.
ALTER TABLE "admission_passes" ADD CONSTRAINT "admission_passes_pricing_all_or_nothing"
  CHECK (num_nonnulls(tier, price_basis, price_paid_cents) IN (0, 3));

ALTER TABLE "admission_passes" ADD CONSTRAINT "admission_passes_price_positive"
  CHECK (price_paid_cents IS NULL OR price_paid_cents > 0);

-- ------------------------------------------- standalone never donates ------
--
-- STANDALONE ENTRY NEVER DONATES ADMISSION - see invariant-registry.md.
--
-- A stale or malformed donate_admissions = true must never cause a PAID
-- standalone purchase to mint zero passes. Application logic refuses it and
-- mints unconditionally; this makes the state unrepresentable as well.
ALTER TABLE "admission_grants" ADD CONSTRAINT "admission_grants_standalone_never_donates"
  CHECK (source <> 'STANDALONE' OR donate_admissions = false);

-- --------------------------------------------- entry pricing coherence -----
--
-- CHILD IS INDEPENDENT and ADULT REGULAR IS INDEPENDENTLY OPTIONAL. Only Adult
-- EARLY has dependencies, because an early price needs a price to transition
-- to and a deadline to transition on. Requiring adult regular whenever ANY
-- entry price exists would make adult pricing mandatory for a child-only
-- ticketed fundraiser, which is a legal platform configuration.
--
-- Mirrors boards_early_bird_coherent, whose live definition is
--   early_bird_price_cents IS NULL
--   OR (early_bird_ends_at IS NOT NULL AND early_bird_price_cents < square_price)
-- i.e. price implies cutoff, never the reverse. That one-way implication is
-- what lets a board offer flat square pricing AND adult early-bird entry
-- without inventing a fake square early-bird price.
ALTER TABLE "boards" ADD CONSTRAINT "boards_entry_pricing_coherent" CHECK (
  entry_adult_early_price_cents IS NULL
  OR (
    entry_adult_regular_price_cents IS NOT NULL
    AND early_bird_ends_at IS NOT NULL
    AND entry_adult_early_price_cents < entry_adult_regular_price_cents
  )
);

ALTER TABLE "boards" ADD CONSTRAINT "boards_entry_prices_positive" CHECK (
  (entry_child_price_cents IS NULL OR entry_child_price_cents > 0)
  AND (entry_adult_early_price_cents IS NULL OR entry_adult_early_price_cents > 0)
  AND (entry_adult_regular_price_cents IS NULL OR entry_adult_regular_price_cents > 0)
);

-- ------------------------------------------------------------------ gate ---
--
-- Same transaction: a failure rolls back every statement above rather than
-- leaving a half-constrained money table. Proves the data rather than assuming
-- it, and REFUSES rather than repairing anything implicitly.
DO $$
DECLARE
  bad_sum      INTEGER;
  bad_negative INTEGER;
  bad_zero     INTEGER;
  bad_pass     INTEGER;
  bad_grant    INTEGER;
  bad_eb       INTEGER;
BEGIN
  SELECT count(*) INTO bad_sum FROM contributions
   WHERE total_paid_cents <> square_amount_cents + donation_amount_cents + entry_amount_cents;
  IF bad_sum > 0 THEN
    RAISE EXCEPTION 'entry tickets aborted: % contribution(s) fail the three-term sum', bad_sum;
  END IF;

  SELECT count(*) INTO bad_negative FROM contributions
   WHERE square_amount_cents < 0 OR donation_amount_cents < 0 OR entry_amount_cents < 0;
  IF bad_negative > 0 THEN
    RAISE EXCEPTION 'entry tickets aborted: % contribution(s) hold a negative amount', bad_negative;
  END IF;

  SELECT count(*) INTO bad_zero FROM contributions
   WHERE square_amount_cents <= 0 AND donation_amount_cents <= 0 AND entry_amount_cents <= 0;
  IF bad_zero > 0 THEN
    RAISE EXCEPTION 'entry tickets aborted: % contribution(s) hold no positive amount', bad_zero;
  END IF;

  SELECT count(*) INTO bad_pass FROM admission_passes
   WHERE num_nonnulls(tier, price_basis, price_paid_cents) NOT IN (0, 3);
  IF bad_pass > 0 THEN
    RAISE EXCEPTION 'entry tickets aborted: % pass(es) carry partial pricing', bad_pass;
  END IF;

  SELECT count(*) INTO bad_grant FROM admission_grants
   WHERE source = 'STANDALONE' AND donate_admissions = true;
  IF bad_grant > 0 THEN
    RAISE EXCEPTION 'entry tickets aborted: % standalone grant(s) donate admissions', bad_grant;
  END IF;

  -- The lock-scope change depends on early < regular being real, and
  -- boards_early_bird_coherent is absent from the Prisma migration chain, so a
  -- rebuilt environment may never have enforced it. Prove it.
  SELECT count(*) INTO bad_eb FROM boards
   WHERE early_bird_price_cents IS NOT NULL AND early_bird_price_cents = square_price;
  IF bad_eb > 0 THEN
    RAISE EXCEPTION
      'entry tickets aborted: % board(s) have equal early-bird and square price; the cutoff lock cannot be derived',
      bad_eb;
  END IF;
END $$;
