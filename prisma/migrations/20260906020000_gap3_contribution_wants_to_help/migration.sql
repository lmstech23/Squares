-- Gap 3 -- "I'd like to help" on a contribution.
--
-- A donor could already claim a volunteer slot: mayClaim() reads supporter
-- status alone, and a confirmed donation activates the supporter. What they
-- could not get was the LINK. Interest lived only on `admission_grants`, and a
-- donation creates none, so both delivery channels -- the confirmation screen
-- and the confirmation email -- had nothing to key on.
--
-- WHY HERE AND NOT ON `event_supporters`. Sign-up addendum section 4 is
-- explicit that interest is "read as EXISTS, never stored on the supporter",
-- because it is a one-way OR across purchases: someone who ticks the box on
-- their first contribution and leaves it unticked on the second is still
-- interested. A column on the supporter would be a latch that a later write
-- could clear. A column per contribution preserves the OR and simply adds a
-- second source to it.
--
-- WHY NOT A ZERO-PASS admission_grant. That table is entitlement machinery.
-- Volunteering is not admission, and inventing a grant to carry a boolean
-- would put a donation one column away from minting passes.
--
-- ADDITIVE ONLY, and NOT NULL DEFAULT false, so every existing row is
-- explicitly "did not ask to help" rather than unknown. No backfill is needed
-- or wanted: nobody was ever offered the box, so nobody ever said yes, and
-- defaulting to true would offer a volunteer link to every past donor.
--
-- ENTITLEMENT IS UNTOUCHED by this migration and by the feature it enables.
-- No grant, no pass, no change to supporter activation. The only new fact in
-- the database is whether somebody ticked a box.

ALTER TABLE "contributions"
  ADD COLUMN "wants_to_help" BOOLEAN NOT NULL DEFAULT false;

-- GATE. Same transaction, so a surprise rolls the column back with it.
DO $$
DECLARE
  ticked  INTEGER;
  grants  INTEGER;
  passes  INTEGER;
BEGIN
  SELECT count(*) INTO ticked FROM contributions WHERE wants_to_help;
  IF ticked > 0 THEN
    RAISE EXCEPTION
      'Gap 3 aborted: % contribution(s) already flagged wants_to_help; nobody has been offered the box',
      ticked;
  END IF;

  -- Recorded, not enforced: entitlement counts before the feature ships, so
  -- the report after it ships has something to be compared against.
  SELECT count(*) INTO grants FROM admission_grants;
  SELECT count(*) INTO passes FROM admission_passes;
  RAISE NOTICE 'Gap 3 baseline: % admission_grants, % admission_passes', grants, passes;
END $$;
