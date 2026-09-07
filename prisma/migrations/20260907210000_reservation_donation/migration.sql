-- A donation carried on a direct-payment Entry Ticket reservation.
--
-- WHY IT LIVES HERE AND NOT ON A CONTRIBUTION. A reservation has no
-- Contribution until the host confirms it, so the intent to donate has nowhere
-- else to sit. Without this column a card buyer could add $25 to their tickets
-- and a Zelle buyer could not - and Zelle is the rail the pilot host actually
-- uses. That split is worse than either uniform answer.
--
-- NOT A TIER LINE. It has no tier, no price basis and no quantity, so
-- quantity_confirmed does not apply and there is nothing about it to partially
-- confirm. It travels atomically with the reservation: one reference code, one
-- transfer, one host action.
--
-- NON-NULL WITH A DEFAULT, mirroring contributions.donation_amount_cents. The
-- two are summed into a single Contribution at confirmation, and a NULL on one
-- side would be a distinction with no meaning on the other. Zero means no
-- donation.
--
-- ADDITIVE. One column with a constant default; existing rows fill from the
-- default in the same statement and no code path reads it yet.

ALTER TABLE "entry_reservations"
  ADD COLUMN "donation_amount_cents" INTEGER NOT NULL DEFAULT 0;

-- No upper bound and no floor. A direct payment has no processor, so the $5
-- card minimum that exists to stop Stripe fees eating a small gift does not
-- apply here - donations SS6, the same reasoning the cash donation path uses.
ALTER TABLE "entry_reservations" ADD CONSTRAINT "entry_reservations_donation_non_negative"
  CHECK ("donation_amount_cents" >= 0);

-- ------------------------------------------------------------------ gate ---
DO $$
DECLARE
  bad_default INTEGER;
  bad_sum     INTEGER;
BEGIN
  SELECT count(*) INTO bad_default FROM entry_reservations WHERE donation_amount_cents <> 0;
  IF bad_default > 0 THEN
    RAISE EXCEPTION
      'reservation donation aborted: % existing reservation(s) did not default to 0', bad_default;
  END IF;

  -- The column this one will be summed with at confirmation. If the three-term
  -- sum were not already live, a confirmed reservation carrying a donation
  -- would violate it on the first insert rather than here.
  SELECT count(*) INTO bad_sum FROM pg_constraint
   WHERE conname = 'contributions_total_is_sum' AND contype = 'c';
  IF bad_sum <> 1 THEN
    RAISE EXCEPTION
      'reservation donation aborted: contributions_total_is_sum is not present';
  END IF;
END $$;
