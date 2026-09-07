-- Which direct-payment rail a declared donation is coming through.
--
-- DONATIONS HAVE NO REFERENCE CODE. A ticket reservation hands the host five
-- characters to match against a bank memo. A declared donation hands them a
-- name and an amount, and the host is left looking through up to four payment
-- apps for it. Recording the rail the contributor actually chose is the only
-- narrowing signal available on that path.
--
-- NULLABLE, AND NOT BACKFILLED. Card contributions have no rail at all, and
-- every donation declared before this column existed never captured one.
-- Inferring a rail from whichever handles the board happens to have would
-- manufacture a fact about somebody's payment. NULL means "not recorded", and
-- must never be read as "none".
--
-- Reuses payment_rail, the enum EntryReservation already uses: this describes
-- the same four external rails, unlike board_payment_method which also carries
-- `card` and describes what a board offers rather than how one payment moved.
--
-- ADDITIVE. One nullable column, no default, no backfill, nothing rewritten.

ALTER TABLE "contributions"
  ADD COLUMN "payment_rail" "payment_rail";

-- A rail only makes sense on a direct payment. A card contribution moves
-- through Stripe and has no rail, so recording one would be a contradiction.
ALTER TABLE "contributions" ADD CONSTRAINT "contributions_rail_is_cash_only"
  CHECK ("payment_rail" IS NULL OR "payment_method" = 'cash');

-- ------------------------------------------------------------------ gate ---
DO $$
DECLARE
  populated INTEGER;
BEGIN
  -- Nothing may arrive populated: there is no backfill, and a non-NULL value
  -- here would mean something inferred a rail for a historical row.
  SELECT count(*) INTO populated FROM contributions WHERE payment_rail IS NOT NULL;
  IF populated > 0 THEN
    RAISE EXCEPTION
      'contribution payment rail aborted: % historical row(s) already carry a rail', populated;
  END IF;
END $$;
