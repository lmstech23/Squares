-- How many standalone Entry Tickets a purchase bought.
--
-- PURCHASE HISTORY, NOT ADMISSION STATE. `AdmissionPass` answers "how many
-- passes does this person hold now" and changes as passes are used or voided.
-- This answers "how many tickets did they buy", and never changes again.
-- The contributor roster needs the second question, and was reading the first:
-- voiding a pass silently reduced a purchase that had already happened.
--
-- WHY IT WAS MISSING. The direct-payment path has had a durable quantity all
-- along - `entry_reservation_lines.quantity` - but the CARD path never did.
-- Its quantity lived only in Stripe session metadata, decoded once by the
-- webhook and turned straight into pass rows. Nothing in this database ever
-- recorded it.
--
-- NULLABLE, AND NO DEFAULT. Null means NOT KNOWN. A default of 0 would be a
-- false claim that nothing was bought, and it would read as a known quantity
-- and bypass the "$80 in tickets" fallback the roster shows when the number is
-- genuinely unavailable. Existing card-entry rows stay null: their quantity
-- cannot be proven from anything in this database, and inventing one is worse
-- than admitting it is unknown.
--
-- NO BACKFILL, deliberately, and this runs against production with real
-- confirmed purchases on it. One ALTER, no row is rewritten.
--
-- NOT A PER-TIER LINE MODEL. A total is all the roster needs. Per-tier detail
-- already exists on `entry_reservation_lines` and on the passes themselves, and
-- both remain authoritative where they exist.

ALTER TABLE "contributions" ADD COLUMN "entry_ticket_count" INTEGER;

-- A COUNT, IF PRESENT, IS AT LEAST ONE. Zero is not a smaller purchase, it is
-- a contradiction: the row would claim entry money bought no tickets.
ALTER TABLE "contributions" ADD CONSTRAINT "contributions_entry_ticket_count_positive"
  CHECK ("entry_ticket_count" IS NULL OR "entry_ticket_count" > 0);

-- AND ONLY WHERE THERE IS ENTRY MONEY. A donation or a square purchase has no
-- ticket count; a value there would be a second, contradictory answer to what
-- the amount columns already say.
ALTER TABLE "contributions" ADD CONSTRAINT "contributions_entry_ticket_count_needs_entry"
  CHECK ("entry_ticket_count" IS NULL OR "entry_amount_cents" > 0);

-- ------------------------------------------------------------------ gate ---
DO $$
DECLARE
  rewritten INTEGER;
  has_default TEXT;
BEGIN
  -- ADDITIVE MEANS ADDITIVE. Every pre-existing row must read NULL; anything
  -- else means something backfilled, which is exactly what was ruled out.
  SELECT count(*) INTO rewritten FROM contributions WHERE entry_ticket_count IS NOT NULL;
  IF rewritten > 0 THEN
    RAISE EXCEPTION
      'entry_ticket_count aborted: % existing row(s) are not NULL - no backfill was authorised', rewritten;
  END IF;

  -- A DEFAULT WOULD DEFEAT THE NULL. Asserted from the catalog rather than
  -- trusted from the ALTER above, because a later edit could add one and every
  -- unknown quantity would silently become a confident zero.
  SELECT column_default INTO has_default FROM information_schema.columns
   WHERE table_schema = 'public' AND table_name = 'contributions'
     AND column_name = 'entry_ticket_count';
  IF has_default IS NOT NULL THEN
    RAISE EXCEPTION 'entry_ticket_count aborted: column has a default (%)', has_default;
  END IF;
END $$;
