-- Capability flag: does this fundraiser sell squares?
--
-- The first of three independent capability flags. The other two -
-- entryTicketsEnabled and donationsEnabled - are deliberately NOT added here.
-- They are inferable from data today (entry prices exist or they do not;
-- donations are always available), and the "at least one must be true"
-- validation that gives all three meaning belongs with the creation flow.
-- Adding two unused, unvalidated booleans now would put a rule in the schema
-- that nothing enforces and nothing reads.
--
-- DEFAULT TRUE IS THE BACKFILL. Every board that existed before this column
-- sold squares, so the default IS the correct historical value for all of
-- them. Postgres fills existing rows from the default in the same statement,
-- so there is no separate UPDATE, no window in which the column is NULL, and
-- nothing to reconcile afterwards.
--
-- ADDITIVE AND NON-BLOCKING. One column with a constant default; on PG 11+
-- this rewrites no rows and takes only a brief ACCESS EXCLUSIVE lock to update
-- the catalog. It changes no existing behaviour: nothing reads this column
-- yet. The surfaces that will read it land in later commits, which is
-- deliberate - the column exists first so those changes are pure logic.
--
-- NOT NULL. A three-state capability flag has no meaning: a board either sells
-- squares or it does not, and a NULL would force every read site to invent an
-- answer.

ALTER TABLE "boards"
  ADD COLUMN "raffle_enabled" BOOLEAN NOT NULL DEFAULT true;

-- ------------------------------------------------------------------ gate ---
--
-- Same transaction as the statement above, so a failure rolls it back rather
-- than leaving a half-applied capability model. Proves the backfill rather
-- than assuming it, and RAISEs rather than repairing anything.
DO $$
DECLARE
  unset_rows INTEGER;
BEGIN
  -- The column is NOT NULL, so this can only be non-zero if the default failed
  -- to apply - which would mean every existing board silently lost its
  -- squares the moment a read site shipped.
  SELECT count(*) INTO unset_rows FROM boards WHERE raffle_enabled IS NOT TRUE;
  IF unset_rows > 0 THEN
    RAISE EXCEPTION
      'raffle_enabled aborted: % existing board(s) did not backfill to true', unset_rows;
  END IF;
END $$;
