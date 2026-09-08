-- Volunteer interest carried on a direct-payment Entry Ticket reservation.
--
-- WHY IT LIVES HERE AND NOT ON THE GRANT. `admission_grants.wants_to_help` is
-- where interest is READ from, and that row does not exist until the host
-- confirms the money arrived. A reservation is created days earlier, at the
-- moment the contributor is actually looking at the checkbox. Without this
-- column the answer is collected and discarded, which is worse than not asking.
--
-- THE SAME SHAPE AS donation_amount_cents, and for the same reason: both are
-- statements of intent made at reservation that only become facts at
-- confirmation. It travels with the reservation and is copied onto the grant
-- there.
--
-- IT CLAIMS NOTHING. Interest is not a signup — invariant 36. This flag never
-- reserves, claims or holds a slot; it decides whether the sign-up link is put
-- in front of the person. `HelperSignup` remains the only record of a
-- commitment, and the host volunteer list still reads that and not this.
--
-- NON-NULL WITH A DEFAULT, mirroring both admission_grants.wants_to_help and
-- contributions.wants_to_help. False means not interested OR not asked, exactly
-- as it does on those two columns — the tri-state distinction is not modelled
-- anywhere in this system and is not being introduced by a third column.
--
-- ADDITIVE. One column with a constant default; existing rows fill from the
-- default in the same statement.

ALTER TABLE "entry_reservations"
  ADD COLUMN "wants_to_help" BOOLEAN NOT NULL DEFAULT false;

-- ------------------------------------------------------------------ gate ---
DO $$
DECLARE
  bad_default INTEGER;
  grant_col   INTEGER;
BEGIN
  SELECT count(*) INTO bad_default FROM entry_reservations WHERE wants_to_help IS DISTINCT FROM false;
  IF bad_default > 0 THEN
    RAISE EXCEPTION
      'reservation wants_to_help aborted: % existing reservation(s) did not default to false', bad_default;
  END IF;

  -- The column this one is copied onto at confirmation. If it were missing,
  -- the confirm path would fail on the first opted-in reservation rather than
  -- here, after the contributor had already sent the money.
  SELECT count(*) INTO grant_col FROM information_schema.columns
   WHERE table_schema = 'public' AND table_name = 'admission_grants' AND column_name = 'wants_to_help';
  IF grant_col <> 1 THEN
    RAISE EXCEPTION
      'reservation wants_to_help aborted: admission_grants.wants_to_help is not present';
  END IF;
END $$;
